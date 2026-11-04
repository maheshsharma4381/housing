-- ============================================================================
-- 033 BILLS BELONG TO FLATS (Phase 4A)
--   Bills are issued for every flat, before anyone has joined; the owner who joins
--   takes the flat's bills. Charges can apply to chosen flats only (parking).
--   A society with one committee member approves its own vendor bills.
--   bill_document feeds the printable /bill/<id> page.
-- ============================================================================

-- ₹ with Indian grouping (1,23,456.50; whole rupees without paise)
CREATE OR REPLACE FUNCTION public.inr_text(p NUMERIC)
RETURNS TEXT AS $$
DECLARE
    v_abs NUMERIC := abs(round(coalesce(p, 0), 2));
    v_int TEXT := trunc(abs(round(coalesce(p, 0), 2)))::bigint::text;
    v_dec TEXT;
    v_out TEXT;
BEGIN
    v_dec := lpad(((v_abs - trunc(v_abs)) * 100)::int::text, 2, '0');
    IF length(v_int) > 3 THEN
        v_out := right(v_int, 3);
        v_int := left(v_int, length(v_int) - 3);
        WHILE length(v_int) > 2 LOOP
            v_out := right(v_int, 2) || ',' || v_out;
            v_int := left(v_int, length(v_int) - 2);
        END LOOP;
        v_out := v_int || ',' || v_out;
    ELSE
        v_out := v_int;
    END IF;
    RETURN CASE WHEN p < 0 THEN '-' ELSE '' END || '₹' || v_out || CASE WHEN v_dec = '00' THEN '' ELSE '.' || v_dec END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================================
-- 1. A BILL MAY HAVE NO PAYER YET
-- ============================================================================
ALTER TABLE bills ALTER COLUMN user_id DROP NOT NULL;
-- The flat's bills outlive any one person's account
DO $$
DECLARE
    v_name TEXT;
BEGIN
    SELECT c.conname INTO v_name FROM pg_constraint c
    WHERE c.conrelid = 'public.bills'::regclass AND c.contype = 'f'
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.bills'::regclass AND attname = 'user_id')]::smallint[];
    IF v_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE bills DROP CONSTRAINT %I', v_name);
    END IF;
    ALTER TABLE bills ADD CONSTRAINT bills_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE SET NULL;
END;
$$;

-- ============================================================================
-- 2. CHARGES FOR CHOSEN FLATS
-- ============================================================================
ALTER TABLE billing_rules ADD COLUMN IF NOT EXISTS applies_to_selected BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS billing_rule_units (
    rule_id UUID NOT NULL REFERENCES billing_rules(id) ON DELETE CASCADE,
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    PRIMARY KEY (rule_id, unit_id)
);
CREATE INDEX IF NOT EXISTS idx_billing_rule_units_unit ON billing_rule_units (unit_id);
ALTER TABLE billing_rule_units ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_rule_units_select ON billing_rule_units;
CREATE POLICY billing_rule_units_select ON billing_rule_units FOR SELECT USING (can_view_financials(society_id));
REVOKE INSERT, UPDATE, DELETE ON billing_rule_units FROM PUBLIC, anon, authenticated;

-- The flats a chosen-flats charge applies to (replaces the list)
CREATE OR REPLACE FUNCTION public.set_rule_flats(p_rule_id UUID, p_unit_ids UUID[])
RETURNS INT AS $$
DECLARE
    v_rule billing_rules%ROWTYPE;
    v_count INT;
BEGIN
    SELECT * INTO v_rule FROM billing_rules WHERE id = p_rule_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Billing rule not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_rule.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can change billing rules';
    END IF;
    DELETE FROM billing_rule_units WHERE rule_id = p_rule_id;
    INSERT INTO billing_rule_units (rule_id, unit_id, society_id)
    SELECT p_rule_id, u.id, u.society_id FROM units u
    WHERE u.society_id = v_rule.society_id AND u.id = ANY (coalesce(p_unit_ids, '{}'::uuid[]));
    GET DIAGNOSTICS v_count = ROW_COUNT;
    UPDATE billing_rules SET applies_to_selected = true WHERE id = p_rule_id;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_rule.society_id, auth.uid(), 'billing_rule.flats', 'billing_rule', p_rule_id::text, jsonb_build_object('flats', v_count));
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 011_integrity.sql; + every flat is billed (no owner needed), chosen-flat charges, no seller fallback
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
    v_existing_cycle UUID;
    v_cycle_name TEXT;
    v_unit RECORD;
    v_rule RECORD;
    v_owner UUID;
    v_bill_id UUID;
    v_seq INT := 0;
    v_base INT;
    v_prefix TEXT;
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

    SELECT id INTO v_existing_cycle FROM billing_cycles
    WHERE society_id = p_society_id AND period_start = p_period_start AND period_end = p_period_end;
    IF v_existing_cycle IS NOT NULL AND EXISTS (
        SELECT 1 FROM bills WHERE cycle_id = v_existing_cycle AND status <> 'cancelled'
    ) THEN
        RAISE EXCEPTION 'Bills for % to % have already been generated', p_period_start, p_period_end;
    END IF;

    v_cycle_name := coalesce(nullif(trim(p_cycle_name), ''), to_char(p_period_start, 'FMMonth YYYY') || ' Maintenance');

    -- Continue numbering after the highest bill of this month (supports several cycles per month)
    PERFORM 1 FROM societies WHERE id = p_society_id FOR UPDATE;
    v_prefix := 'B' || to_char(p_period_start, 'YYMM') || '-';
    SELECT coalesce(max(substring(bill_number FROM '^' || v_prefix || '([0-9]+)$')::int), 0) INTO v_base
    FROM bills WHERE society_id = p_society_id;

    IF NOT p_dry_run THEN
        IF v_existing_cycle IS NOT NULL THEN
            v_cycle_id := v_existing_cycle; -- every bill of it was cancelled: reuse
            UPDATE billing_cycles SET cycle_name = v_cycle_name, due_date = p_due_date, status = 'published'
            WHERE id = v_cycle_id;
        ELSE
            INSERT INTO billing_cycles (society_id, cycle_name, period_start, period_end, due_date, status)
            VALUES (p_society_id, v_cycle_name, p_period_start, p_period_end, p_due_date, 'published')
            RETURNING id INTO v_cycle_id;
        END IF;
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
        -- Bills belong to the flat (033): the joined owner pays; with nobody joined yet the bill waits for them

        SELECT
            coalesce(sum(round(CASE r.calculation_type WHEN 'per_sqft' THEN r.rate * v_unit.carpet_area_sqft ELSE r.rate END, 2)), 0),
            coalesce(sum(round(round(CASE r.calculation_type WHEN 'per_sqft' THEN r.rate * v_unit.carpet_area_sqft ELSE r.rate END, 2) * r.tax_rate_percent / 100, 2)), 0)
        INTO v_subtotal, v_tax
        FROM billing_rules r
        WHERE r.society_id = p_society_id AND r.is_active = true
          AND r.calculation_type IN ('flat_per_unit', 'per_sqft')
          AND (r.applies_to_unit_type IS NULL OR r.applies_to_unit_type = '' OR r.applies_to_unit_type = v_unit.unit_type)
          -- a charge for chosen flats bills only those flats (033)
          AND (NOT r.applies_to_selected OR EXISTS (SELECT 1 FROM billing_rule_units x WHERE x.rule_id = r.id AND x.unit_id = v_unit.id));

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
                v_prefix || lpad((v_base + v_seq)::text, 4, '0'),
                current_date, p_due_date,
                v_subtotal, v_tax, v_subtotal + v_tax, 0, v_subtotal + v_tax, 'issued'
            )
            RETURNING id INTO v_bill_id;

            FOR v_rule IN
                SELECT * FROM billing_rules r
                WHERE r.society_id = p_society_id AND r.is_active = true
                  AND r.calculation_type IN ('flat_per_unit', 'per_sqft')
                  AND (r.applies_to_unit_type IS NULL OR r.applies_to_unit_type = '' OR r.applies_to_unit_type = v_unit.unit_type)
          -- a charge for chosen flats bills only those flats (033)
          AND (NOT r.applies_to_selected OR EXISTS (SELECT 1 FROM billing_rule_units x WHERE x.rule_id = r.id AND x.unit_id = v_unit.id))
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
            RAISE EXCEPTION 'No bills to generate: check the billing rules';
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

-- from 031_joining_link.sql; + the joining owner takes the flat's unclaimed bills
CREATE OR REPLACE FUNCTION public.attach_flat_owner(p_society_id UUID, p_unit_id UUID, p_uid UUID, p_invite_id UUID DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
    v_waiting_since TIMESTAMPTZ;
    v_claimed INT;
    v_due NUMERIC;
BEGIN
    UPDATE units SET current_owner_id = p_uid, updated_at = timezone('utc'::text, now()) WHERE id = p_unit_id;
    -- An owner change waiting on this flat is completed by whoever joins as its owner
    UPDATE unit_ownerships o
    SET owner_user_id = p_uid,
        owner_email = coalesce((SELECT email FROM profiles WHERE id = p_uid), o.owner_email),
        invite_id = coalesce(p_invite_id, o.invite_id)
    WHERE o.unit_id = p_unit_id AND o.to_date IS NULL AND o.owner_user_id IS NULL
    RETURNING o.created_at INTO v_waiting_since;
    IF FOUND THEN
        -- The dues stay with the flat: its unpaid bills are now the new owner's to pay
        UPDATE bills SET user_id = p_uid, updated_at = timezone('utc'::text, now())
        WHERE unit_id = p_unit_id AND balance_due > 0 AND status IN ('issued', 'partially_paid', 'overdue');
        -- Receipts recorded for the flat while the change waited are the new owner's too
        UPDATE payments SET user_id = p_uid
        WHERE unit_id = p_unit_id AND created_at >= v_waiting_since AND user_id IS DISTINCT FROM p_uid;
    ELSIF NOT EXISTS (SELECT 1 FROM unit_ownerships WHERE unit_id = p_unit_id AND to_date IS NULL) THEN
        INSERT INTO unit_ownerships (society_id, unit_id, owner_user_id, owner_name, owner_email, owner_mobile, from_date)
        SELECT p_society_id, p_unit_id, p_uid, coalesce(p.full_name, c.owner_name, p.email, 'Owner'), p.email, c.owner_mobile, current_date
        FROM units u LEFT JOIN profiles p ON p.id = p_uid LEFT JOIN unit_owner_contacts c ON c.unit_id = u.id
        WHERE u.id = p_unit_id;
    END IF;
    -- Bills belong to the flat (033): the owner who joins takes the ones nobody holds yet, with one notification
    WITH claimed AS (
        UPDATE bills SET user_id = p_uid, updated_at = timezone('utc'::text, now())
        WHERE unit_id = p_unit_id AND user_id IS NULL
        RETURNING balance_due, status
    )
    SELECT count(*), coalesce(sum(balance_due) FILTER (WHERE status IN ('issued', 'partially_paid', 'overdue')), 0)
    INTO v_claimed, v_due FROM claimed;
    IF v_claimed > 0 THEN
        PERFORM notify_users(p_society_id, ARRAY[p_uid], 'bill',
            'Bills for Flat ' || (SELECT unit_number FROM units WHERE id = p_unit_id),
            v_claimed || CASE WHEN v_claimed = 1 THEN ' bill' ELSE ' bills' END || ' · ' || inr_text(v_due) || ' due',
            'bills', p_unit_id);
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. MEMBER DUES: ONE ROW PER FLAT
-- ============================================================================
-- from 007_ledger.sql; + one row per flat, named by its owner, the expected owner, or "Not joined yet"
CREATE OR REPLACE FUNCTION public.member_dues(p_society_id UUID, p_as_of DATE DEFAULT current_date)
RETURNS TABLE (
    unit_number TEXT, wing TEXT, owner_name TEXT, owner_email TEXT,
    bills_count INT, outstanding NUMERIC, oldest_due_date DATE, days_overdue INT
) AS $$
BEGIN
    IF NOT can_view_financials(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s financial reports';
    END IF;
    RETURN QUERY
    SELECT u.unit_number::TEXT, w.name::TEXT,
           coalesce(o.full_name, c.owner_name, 'Not joined yet')::TEXT, o.email::TEXT,
           count(*)::INT, sum(b.balance_due)::NUMERIC, min(b.due_date),
           greatest(p_as_of - min(b.due_date), 0)::INT
    FROM bills b
    JOIN units u ON u.id = b.unit_id
    JOIN wings w ON w.id = u.wing_id
    LEFT JOIN unit_owner_contacts c ON c.unit_id = u.id
    LEFT JOIN LATERAL (
        SELECT p.full_name, p.email FROM society_memberships m JOIN profiles p ON p.id = m.user_id
        WHERE m.unit_id = u.id AND m.role = 'resident_owner' AND m.is_active
        ORDER BY m.created_at LIMIT 1
    ) o ON true
    WHERE b.society_id = p_society_id
      AND b.balance_due > 0
      AND b.status IN ('issued', 'partially_paid', 'overdue')
    GROUP BY u.id, u.unit_number, w.name, o.full_name, o.email, c.owner_name
    ORDER BY sum(b.balance_due) DESC, u.unit_number;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 4. A SOCIETY WITH ONE COMMITTEE MEMBER (spec 9.3)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.sole_committee_admin(p_society_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    IF NOT (is_platform_admin() OR is_committee_viewer(p_society_id)) THEN
        RETURN false;
    END IF;
    RETURN (SELECT count(DISTINCT m.user_id) FROM society_memberships m
            WHERE m.society_id = p_society_id AND m.is_active
              AND m.role IN ('society_admin', 'secretary', 'chairman', 'treasurer')) = 1;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- from 008_operations.sql; + self-approval while the society has one committee member
CREATE OR REPLACE FUNCTION public.decide_expense(p_expense_id UUID, p_approve BOOLEAN, p_notes TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_exp expenses%ROWTYPE;
    v_required INT;
    v_approvals INT;
    v_self BOOLEAN;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_exp.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can approve expenses';
    END IF;
    IF v_exp.status <> 'pending_approval' THEN
        RAISE EXCEPTION 'Expense is %, not pending approval', v_exp.status;
    END IF;
    -- The maker cannot approve, unless they are the society's only committee member (033, spec 9.3)
    v_self := v_exp.created_by = auth.uid();
    IF v_self AND NOT sole_committee_admin(v_exp.society_id) THEN
        RAISE EXCEPTION 'You created this expense; another committee member must approve it';
    END IF;
    IF EXISTS (SELECT 1 FROM expense_approvals WHERE expense_id = p_expense_id AND approver_id = auth.uid()) THEN
        RAISE EXCEPTION 'You have already recorded your decision on this expense';
    END IF;
    IF NOT p_approve AND length(trim(coalesce(p_notes, ''))) = 0 THEN
        RAISE EXCEPTION 'A reason is required to reject an expense';
    END IF;

    INSERT INTO expense_approvals (society_id, expense_id, approver_id, decision, notes)
    VALUES (v_exp.society_id, p_expense_id, auth.uid(), CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, nullif(trim(coalesce(p_notes, '')), ''));

    SELECT CASE WHEN require_two_step_expense_approval THEN 2 ELSE 1 END INTO v_required
    FROM society_settings WHERE society_id = v_exp.society_id;
    v_required := coalesce(v_required, 1);
    IF v_self THEN
        v_required := 1; -- a single member cannot be two approvers
    END IF;

    SELECT count(*) INTO v_approvals FROM expense_approvals WHERE expense_id = p_expense_id AND decision = 'approved';

    PERFORM set_config('sahvaas.expense_workflow', 'on', true);
    IF NOT p_approve THEN
        UPDATE expenses SET status = 'rejected', updated_at = timezone('utc'::text, now()) WHERE id = p_expense_id;
    ELSIF v_approvals >= v_required THEN
        UPDATE expenses SET status = 'approved', approved_by = auth.uid(), approved_at = timezone('utc'::text, now()),
                            updated_at = timezone('utc'::text, now())
        WHERE id = p_expense_id;
    END IF;
    PERFORM set_config('sahvaas.expense_workflow', 'off', true);

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_exp.society_id, auth.uid(), CASE WHEN p_approve AND v_self THEN 'expense.self_approved' WHEN p_approve THEN 'expense.approved' ELSE 'expense.rejected' END,
            'expense', p_expense_id::text, jsonb_build_object('approvals', v_approvals, 'required', v_required, 'notes', p_notes));

    RETURN jsonb_build_object(
        'status', CASE WHEN NOT p_approve THEN 'rejected' WHEN v_approvals >= v_required THEN 'approved' ELSE 'pending_approval' END,
        'approvals', v_approvals,
        'required', v_required
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. THE PRINTABLE BILL (spec 9.2)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.bill_document(p_bill_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_b bills%ROWTYPE;
    v_soc societies%ROWTYPE;
    v_set society_settings%ROWTYPE;
    v_unit RECORD;
    v_cycle billing_cycles%ROWTYPE;
    v_bank RECORD;
    v_name TEXT;
    v_arrears NUMERIC;
    v_advance NUMERIC;
BEGIN
    SELECT * INTO v_b FROM bills WHERE id = p_bill_id;
    IF NOT FOUND OR NOT (is_platform_admin() OR is_committee_viewer(v_b.society_id) OR v_b.user_id = auth.uid()
                         OR has_professional_permission(v_b.society_id, 'view_bills')) THEN
        RAISE EXCEPTION 'Bill not found';
    END IF;
    SELECT * INTO v_soc FROM societies WHERE id = v_b.society_id;
    SELECT * INTO v_set FROM society_settings WHERE society_id = v_b.society_id;
    SELECT u.unit_number, u.carpet_area_sqft, w.name AS wing INTO v_unit FROM units u LEFT JOIN wings w ON w.id = u.wing_id WHERE u.id = v_b.unit_id;
    SELECT * INTO v_cycle FROM billing_cycles WHERE id = v_b.cycle_id;
    SELECT bank_name, account_number, ifsc_code, branch_name INTO v_bank FROM bank_accounts
    WHERE society_id = v_b.society_id ORDER BY is_primary DESC, created_at LIMIT 1;
    SELECT coalesce(
        (SELECT full_name FROM profiles WHERE id = v_b.user_id),
        (SELECT p.full_name FROM society_memberships m JOIN profiles p ON p.id = m.user_id
         WHERE m.unit_id = v_b.unit_id AND m.role = 'resident_owner' AND m.is_active ORDER BY m.created_at LIMIT 1),
        (SELECT owner_name FROM unit_owner_contacts WHERE unit_id = v_b.unit_id)) INTO v_name;
    -- Earlier bills of the flat still unpaid
    SELECT coalesce(sum(balance_due), 0) INTO v_arrears FROM bills
    WHERE unit_id = v_b.unit_id AND id <> v_b.id AND balance_due > 0 AND status IN ('issued', 'partially_paid', 'overdue')
      AND (due_date < v_b.due_date OR (due_date = v_b.due_date AND created_at < v_b.created_at));
    -- Money received for the flat and not yet set against a bill (as flat_balance)
    v_advance := (SELECT coalesce(sum(p.amount - coalesce((SELECT sum(a.amount) FROM payment_allocations a WHERE a.payment_id = p.id), 0)), 0)
                  FROM payments p WHERE p.unit_id = v_b.unit_id AND p.status = 'verified')
               + (SELECT coalesce(sum(o.remaining), 0) FROM opening_advances o WHERE o.unit_id = v_b.unit_id);

    RETURN jsonb_build_object(
        'society', jsonb_build_object(
            'name', v_soc.name, 'registration_number', v_soc.registration_number,
            'address', concat_ws(', ', nullif(v_soc.address_line1, ''), nullif(v_soc.address_line2, ''), v_soc.city, v_soc.state, v_soc.pincode),
            'upi_id', v_set.upi_id, 'payee_name', coalesce(v_set.upi_payee_name, v_soc.name),
            'bank', CASE WHEN v_bank.bank_name IS NULL THEN NULL ELSE jsonb_build_object(
                'bank_name', v_bank.bank_name, 'account_number', v_bank.account_number, 'ifsc', v_bank.ifsc_code, 'branch', v_bank.branch_name) END),
        'flat', jsonb_build_object('number', v_unit.unit_number, 'wing', v_unit.wing, 'area', v_unit.carpet_area_sqft),
        'member_name', v_name,
        'bill', jsonb_build_object(
            'id', v_b.id, 'number', v_b.bill_number, 'bill_date', v_b.bill_date, 'due_date', v_b.due_date,
            'period', v_cycle.cycle_name, 'period_start', v_cycle.period_start, 'period_end', v_cycle.period_end,
            'status', v_b.status,
            'items', coalesce((SELECT jsonb_agg(jsonb_build_object('description', i.description, 'quantity', i.quantity, 'rate', i.unit_rate,
                                                                   'amount', i.amount, 'tax', i.tax_amount, 'total', i.total_item_amount) ORDER BY i.description)
                               FROM bill_items i WHERE i.bill_id = v_b.id), '[]'::jsonb),
            'subtotal', v_b.subtotal_amount, 'tax', v_b.tax_amount, 'late_fee', v_b.interest_or_late_fee,
            'total', v_b.total_amount, 'paid', v_b.amount_paid, 'balance', v_b.balance_due),
        'arrears', v_arrears,
        'advance', v_advance,
        'payable', greatest(v_b.balance_due + v_arrears - v_advance, 0),
        'late_fee_rule', CASE v_set.late_fee_type
            WHEN 'flat' THEN inr_text(v_set.late_fee_amount) || ' after the due date'
            WHEN 'percentage' THEN trim_scale(v_set.late_fee_amount)::text || '% of the bill after the due date'
            ELSE NULL END
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.set_rule_flats(UUID, UUID[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sole_committee_admin(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bill_document(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_rule_flats(UUID, UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sole_committee_admin(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bill_document(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.inr_text(NUMERIC) TO authenticated;
