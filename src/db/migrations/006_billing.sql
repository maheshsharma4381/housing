-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 006: Billing & Payment Verification (the "money loop")
--   * generate_bills()   - preview / generate one billing cycle from rules
--   * verify_payment()   - treasurer approves (receipt + FIFO allocation to
--                          bills) or rejects a resident's UTR submission
--   * apply_late_fees()  - marks overdue bills and adds the late fee once
--   * payment_allocations, duplicate-UTR guard, receipt numbering
-- Safe to re-run.
-- ============================================================================

ALTER TABLE bills ADD COLUMN IF NOT EXISTS late_fee_applied_at TIMESTAMPTZ;

-- Same UTR cannot be submitted twice while pending or verified (fraud / double click)
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_utr_active
    ON payments (society_id, transaction_reference_utr)
    WHERE status IN ('pending_verification', 'verified');

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_receipt_number
    ON payments (society_id, receipt_number)
    WHERE receipt_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bills_unit_outstanding
    ON bills (unit_id, due_date) WHERE balance_due > 0;

-- ============================================================================
-- 1. PAYMENT ALLOCATIONS (which bills a verified payment settled)
-- ============================================================================
CREATE TABLE IF NOT EXISTS payment_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    bill_id UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_payment ON payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_bill ON payment_allocations(bill_id);

ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;

-- Read-only for clients; written by verify_payment()
DROP POLICY IF EXISTS payment_allocations_select ON payment_allocations;
CREATE POLICY payment_allocations_select ON payment_allocations
    FOR SELECT USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR has_professional_permission(society_id, 'view_payments')
        OR EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_allocations.payment_id AND p.user_id = auth.uid())
    );

-- ============================================================================
-- 2. GENERATE BILLS
--    Bills each flat's owner (resident_owner membership, else units.current_owner_id)
--    using active flat_per_unit / per_sqft rules. p_dry_run = true returns the
--    preview without writing anything.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.generate_bills(
    p_society_id UUID,
    p_period_start DATE,
    p_period_end DATE,
    p_due_date DATE,
    p_cycle_name TEXT DEFAULT NULL,
    p_dry_run BOOLEAN DEFAULT false
)
RETURNS JSONB AS $$
DECLARE
    v_cycle_id UUID;
    v_cycle_name TEXT;
    v_unit RECORD;
    v_rule RECORD;
    v_owner UUID;
    v_bill_id UUID;
    v_seq INT := 0;
    v_line NUMERIC;
    v_line_tax NUMERIC;
    v_subtotal NUMERIC;
    v_tax NUMERIC;
    v_total_all NUMERIC := 0;
    v_skipped JSONB := '[]'::jsonb;
    v_preview JSONB := '[]'::jsonb;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can generate bills';
    END IF;
    IF p_period_end < p_period_start THEN
        RAISE EXCEPTION 'Period end must be on or after period start';
    END IF;
    IF p_due_date < p_period_start THEN
        RAISE EXCEPTION 'Due date cannot be before the billing period starts';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM billing_rules
        WHERE society_id = p_society_id AND is_active = true
          AND calculation_type IN ('flat_per_unit', 'per_sqft')
    ) THEN
        RAISE EXCEPTION 'Add at least one active billing rule (flat per unit or per sq.ft) first';
    END IF;
    IF EXISTS (
        SELECT 1 FROM billing_cycles
        WHERE society_id = p_society_id AND period_start = p_period_start AND period_end = p_period_end
    ) THEN
        RAISE EXCEPTION 'Bills for % to % have already been generated', p_period_start, p_period_end;
    END IF;

    v_cycle_name := coalesce(nullif(trim(p_cycle_name), ''), to_char(p_period_start, 'FMMonth YYYY') || ' Maintenance');

    IF NOT p_dry_run THEN
        INSERT INTO billing_cycles (society_id, cycle_name, period_start, period_end, due_date, status)
        VALUES (p_society_id, v_cycle_name, p_period_start, p_period_end, p_due_date, 'published')
        RETURNING id INTO v_cycle_id;
    END IF;

    FOR v_unit IN
        SELECT u.*, w.name AS wing_name
        FROM units u JOIN wings w ON w.id = u.wing_id
        WHERE u.society_id = p_society_id
        ORDER BY w.name, u.unit_number
    LOOP
        SELECT m.user_id INTO v_owner
        FROM society_memberships m
        WHERE m.society_id = p_society_id AND m.unit_id = v_unit.id
          AND m.is_active = true AND m.role = 'resident_owner'
        ORDER BY m.created_at
        LIMIT 1;
        v_owner := coalesce(v_owner, v_unit.current_owner_id);

        IF v_owner IS NULL THEN
            v_skipped := v_skipped || jsonb_build_object('unit_number', v_unit.unit_number, 'reason', 'No owner linked');
            CONTINUE;
        END IF;

        -- Compute totals first so flats with no applicable rule are skipped cleanly
        SELECT
            coalesce(sum(round(CASE r.calculation_type WHEN 'per_sqft' THEN r.rate * v_unit.carpet_area_sqft ELSE r.rate END, 2)), 0),
            coalesce(sum(round(round(CASE r.calculation_type WHEN 'per_sqft' THEN r.rate * v_unit.carpet_area_sqft ELSE r.rate END, 2) * r.tax_rate_percent / 100, 2)), 0)
        INTO v_subtotal, v_tax
        FROM billing_rules r
        WHERE r.society_id = p_society_id AND r.is_active = true
          AND r.calculation_type IN ('flat_per_unit', 'per_sqft')
          AND (r.applies_to_unit_type IS NULL OR r.applies_to_unit_type = '' OR r.applies_to_unit_type = v_unit.unit_type);

        IF v_subtotal <= 0 THEN
            v_skipped := v_skipped || jsonb_build_object('unit_number', v_unit.unit_number, 'reason', 'No applicable billing rule');
            CONTINUE;
        END IF;

        v_seq := v_seq + 1;
        v_total_all := v_total_all + v_subtotal + v_tax;
        IF v_seq <= 500 THEN
            v_preview := v_preview || jsonb_build_object(
                'unit_number', v_unit.unit_number, 'wing', v_unit.wing_name,
                'subtotal', v_subtotal, 'tax', v_tax, 'total', v_subtotal + v_tax
            );
        END IF;

        IF NOT p_dry_run THEN
            INSERT INTO bills (
                society_id, cycle_id, unit_id, user_id, bill_number, bill_date, due_date,
                subtotal_amount, tax_amount, total_amount, amount_paid, balance_due, status
            ) VALUES (
                p_society_id, v_cycle_id, v_unit.id, v_owner,
                'B' || to_char(p_period_start, 'YYMM') || '-' || lpad(v_seq::text, 4, '0'),
                current_date, p_due_date,
                v_subtotal, v_tax, v_subtotal + v_tax, 0, v_subtotal + v_tax, 'issued'
            )
            RETURNING id INTO v_bill_id;

            FOR v_rule IN
                SELECT * FROM billing_rules r
                WHERE r.society_id = p_society_id AND r.is_active = true
                  AND r.calculation_type IN ('flat_per_unit', 'per_sqft')
                  AND (r.applies_to_unit_type IS NULL OR r.applies_to_unit_type = '' OR r.applies_to_unit_type = v_unit.unit_type)
                ORDER BY r.created_at
            LOOP
                v_line := round(CASE v_rule.calculation_type WHEN 'per_sqft' THEN v_rule.rate * v_unit.carpet_area_sqft ELSE v_rule.rate END, 2);
                v_line_tax := round(v_line * v_rule.tax_rate_percent / 100, 2);
                INSERT INTO bill_items (bill_id, rule_id, description, quantity, unit_rate, amount, tax_rate, tax_amount, total_item_amount)
                VALUES (
                    v_bill_id, v_rule.id, v_rule.name,
                    CASE v_rule.calculation_type WHEN 'per_sqft' THEN v_unit.carpet_area_sqft ELSE 1 END,
                    v_rule.rate, v_line, v_rule.tax_rate_percent, v_line_tax, v_line + v_line_tax
                );
            END LOOP;
        END IF;
    END LOOP;

    IF NOT p_dry_run THEN
        IF v_seq = 0 THEN
            RAISE EXCEPTION 'No bills to generate: link owners to flats and check billing rules';
        END IF;
        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (p_society_id, auth.uid(), 'billing_cycle.generated', 'billing_cycle', v_cycle_id::text,
                jsonb_build_object('bills', v_seq, 'total', v_total_all, 'period_start', p_period_start));
    END IF;

    RETURN jsonb_build_object(
        'cycle_id', v_cycle_id,
        'cycle_name', v_cycle_name,
        'dry_run', p_dry_run,
        'bills', v_seq,
        'total_amount', v_total_all,
        'skipped_units', v_skipped,
        'preview', v_preview
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. VERIFY / REJECT A PAYMENT
--    Approve: issue receipt number and allocate the amount to the flat's
--    outstanding bills (the linked bill first, then oldest due first).
--    Any excess stays unallocated (advance) and is reported back.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.verify_payment(
    p_payment_id UUID,
    p_approve BOOLEAN,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_payment payments%ROWTYPE;
    v_bill RECORD;
    v_remaining NUMERIC;
    v_alloc NUMERIC;
    v_allocated NUMERIC := 0;
    v_receipt TEXT;
    v_next INT;
BEGIN
    SELECT * INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_payment.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can verify payments';
    END IF;
    IF v_payment.status <> 'pending_verification' THEN
        RAISE EXCEPTION 'Payment is already %', v_payment.status;
    END IF;

    IF NOT p_approve THEN
        IF length(trim(coalesce(p_notes, ''))) = 0 THEN
            RAISE EXCEPTION 'A reason is required to reject a payment';
        END IF;
        UPDATE payments
        SET status = 'rejected', verification_notes = trim(p_notes),
            verified_by = auth.uid(), verified_at = timezone('utc'::text, now())
        WHERE id = p_payment_id;

        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (v_payment.society_id, auth.uid(), 'payment.rejected', 'payment', p_payment_id::text,
                jsonb_build_object('reason', trim(p_notes), 'utr', v_payment.transaction_reference_utr));

        RETURN jsonb_build_object('status', 'rejected');
    END IF;

    -- Serialize receipt numbering per society
    PERFORM 1 FROM societies WHERE id = v_payment.society_id FOR UPDATE;
    SELECT count(*) + 1 INTO v_next
    FROM payments WHERE society_id = v_payment.society_id AND receipt_number IS NOT NULL;
    v_receipt := 'RCPT-' || to_char(current_date, 'YYYY') || '-' || lpad(v_next::text, 5, '0');

    v_remaining := v_payment.amount;
    FOR v_bill IN
        SELECT * FROM bills
        WHERE society_id = v_payment.society_id
          AND unit_id = v_payment.unit_id
          AND balance_due > 0
          AND status IN ('issued', 'partially_paid', 'overdue')
        ORDER BY (id = v_payment.bill_id) DESC NULLS LAST, due_date, bill_date, bill_number
        FOR UPDATE
    LOOP
        EXIT WHEN v_remaining <= 0;
        v_alloc := least(v_remaining, v_bill.balance_due);

        UPDATE bills
        SET amount_paid = amount_paid + v_alloc,
            balance_due = balance_due - v_alloc,
            status = CASE
                WHEN balance_due - v_alloc <= 0 THEN 'paid'
                WHEN status = 'overdue' THEN 'overdue'
                ELSE 'partially_paid'
            END,
            updated_at = timezone('utc'::text, now())
        WHERE id = v_bill.id;

        INSERT INTO payment_allocations (society_id, payment_id, bill_id, amount)
        VALUES (v_payment.society_id, p_payment_id, v_bill.id, v_alloc);

        v_remaining := v_remaining - v_alloc;
        v_allocated := v_allocated + v_alloc;
    END LOOP;

    UPDATE payments
    SET status = 'verified', receipt_number = v_receipt,
        verification_notes = nullif(trim(coalesce(p_notes, '')), ''),
        verified_by = auth.uid(), verified_at = timezone('utc'::text, now())
    WHERE id = p_payment_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_payment.society_id, auth.uid(), 'payment.verified', 'payment', p_payment_id::text,
            jsonb_build_object('receipt', v_receipt, 'amount', v_payment.amount,
                               'allocated', v_allocated, 'utr', v_payment.transaction_reference_utr));

    RETURN jsonb_build_object(
        'status', 'verified',
        'receipt_number', v_receipt,
        'allocated', v_allocated,
        'unallocated', v_remaining
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 4. LATE FEES
--    Bills past due with a balance become 'overdue'; the society's late fee
--    (flat ₹ or % of balance) is added once per bill.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.apply_late_fees(p_society_id UUID, p_as_of DATE DEFAULT current_date)
RETURNS JSONB AS $$
DECLARE
    v_settings society_settings%ROWTYPE;
    v_bill RECORD;
    v_fee NUMERIC;
    v_marked INT := 0;
    v_fees INT := 0;
    v_fee_total NUMERIC := 0;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can apply late fees';
    END IF;

    SELECT * INTO v_settings FROM society_settings WHERE society_id = p_society_id;

    FOR v_bill IN
        SELECT * FROM bills
        WHERE society_id = p_society_id
          AND due_date < p_as_of
          AND balance_due > 0
          AND status IN ('issued', 'partially_paid', 'overdue')
        FOR UPDATE
    LOOP
        IF v_bill.status <> 'overdue' THEN
            v_marked := v_marked + 1;
        END IF;

        v_fee := 0;
        IF v_bill.late_fee_applied_at IS NULL AND coalesce(v_settings.late_fee_type, 'none') <> 'none' THEN
            v_fee := CASE v_settings.late_fee_type
                WHEN 'flat' THEN v_settings.late_fee_amount
                ELSE round(v_bill.balance_due * v_settings.late_fee_amount / 100, 2)
            END;
        END IF;

        IF v_fee > 0 THEN
            INSERT INTO bill_items (bill_id, description, quantity, unit_rate, amount, total_item_amount)
            VALUES (v_bill.id, 'Late payment charge', 1, v_fee, v_fee, v_fee);
            v_fees := v_fees + 1;
            v_fee_total := v_fee_total + v_fee;
        END IF;

        UPDATE bills
        SET status = 'overdue',
            interest_or_late_fee = interest_or_late_fee + v_fee,
            total_amount = total_amount + v_fee,
            balance_due = balance_due + v_fee,
            late_fee_applied_at = CASE WHEN v_fee > 0 THEN timezone('utc'::text, now()) ELSE late_fee_applied_at END,
            updated_at = timezone('utc'::text, now())
        WHERE id = v_bill.id;
    END LOOP;

    IF v_marked > 0 OR v_fees > 0 THEN
        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (p_society_id, auth.uid(), 'bills.late_fees_applied', 'society', p_society_id::text,
                jsonb_build_object('marked_overdue', v_marked, 'late_fees', v_fees, 'total', v_fee_total, 'as_of', p_as_of));
    END IF;

    RETURN jsonb_build_object('marked_overdue', v_marked, 'late_fees_applied', v_fees, 'late_fee_total', v_fee_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. FUNCTION PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.generate_bills(UUID, DATE, DATE, DATE, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.verify_payment(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_late_fees(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_bills(UUID, DATE, DATE, DATE, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_payment(UUID, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_late_fees(UUID, DATE) TO authenticated;
