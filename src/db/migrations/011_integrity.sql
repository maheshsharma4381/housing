-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 011: Integrity & Security Fixes (AUDIT_REPORT.md → F1)
--   C2  file paths must stay inside their own society folder; storage read
--       policy also checks the folder matches the record's society
--   H1  financial records cannot be deleted by clients; corrections go
--       through cancel_bill() / void_expense() with reversal journals
--   H2  bills, bill items, billing cycles and payments change only through
--       the workflow RPCs (no direct client writes)
--   M1  committees cannot change their own subscription / activation
--   M2  bill numbers continue per month, so several cycles per month work;
--       a fully cancelled cycle can be regenerated
-- Safe to re-run.
-- ============================================================================

-- ============================================================================
-- 1. C2 — FILE PATHS TIED TO THE OWNING SOCIETY
-- ============================================================================
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS chk_expenses_document_in_society;
ALTER TABLE expenses ADD CONSTRAINT chk_expenses_document_in_society
    CHECK (document_url IS NULL OR document_url LIKE society_id::text || '/%');

ALTER TABLE notices DROP CONSTRAINT IF EXISTS chk_notices_attachment_in_society;
ALTER TABLE notices ADD CONSTRAINT chk_notices_attachment_in_society
    CHECK (attachment_url IS NULL OR attachment_url LIKE society_id::text || '/%');

-- Folder name → society id, or NULL when it is not a uuid (never throws)
CREATE OR REPLACE FUNCTION public.storage_society_id(p_name TEXT)
RETURNS UUID AS $$
    SELECT CASE
        WHEN (storage.foldername(p_name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN ((storage.foldername(p_name))[1])::uuid
    END
$$ LANGUAGE sql STABLE;

DROP POLICY IF EXISTS "society files: read" ON storage.objects;
DROP POLICY IF EXISTS "society files: committee upload" ON storage.objects;
DROP POLICY IF EXISTS "society files: committee delete" ON storage.objects;

CREATE POLICY "society files: read" ON storage.objects
    FOR SELECT TO authenticated USING (
        bucket_id = 'society-files'
        AND public.storage_society_id(name) IS NOT NULL
        AND (
            EXISTS (SELECT 1 FROM public.documents d
                    WHERE d.file_url = storage.objects.name
                      AND d.society_id = public.storage_society_id(storage.objects.name))
            OR EXISTS (SELECT 1 FROM public.expenses e
                       WHERE e.document_url = storage.objects.name
                         AND e.society_id = public.storage_society_id(storage.objects.name))
            OR public.is_society_admin(public.storage_society_id(name))
        )
    );

CREATE POLICY "society files: committee upload" ON storage.objects
    FOR INSERT TO authenticated WITH CHECK (
        bucket_id = 'society-files'
        AND public.storage_society_id(name) IS NOT NULL
        AND (public.is_platform_admin() OR public.is_society_admin(public.storage_society_id(name)))
    );

CREATE POLICY "society files: committee delete" ON storage.objects
    FOR DELETE TO authenticated USING (
        bucket_id = 'society-files'
        AND public.storage_society_id(name) IS NOT NULL
        AND (public.is_platform_admin() OR public.is_society_admin(public.storage_society_id(name)))
    );

-- ============================================================================
-- 2. H1 + H2 — NO DIRECT CLIENT WRITES TO MONEY TABLES
--    generate_bills / verify_payment / apply_late_fees / opening balances /
--    cancel_bill are SECURITY DEFINER and keep working; RLS still decides reads.
-- ============================================================================
DROP POLICY IF EXISTS bills_admin_write ON bills;
DROP POLICY IF EXISTS bill_items_admin_write ON bill_items;
DROP POLICY IF EXISTS billing_cycles_admin_write ON billing_cycles;
DROP POLICY IF EXISTS payments_admin_verify ON payments;

-- Flats: committee may add/edit, but delete only flats with no history
DROP POLICY IF EXISTS units_admin_modify ON units;
DROP POLICY IF EXISTS units_admin_insert ON units;
DROP POLICY IF EXISTS units_admin_update ON units;
DROP POLICY IF EXISTS units_admin_delete ON units;
CREATE POLICY units_admin_insert ON units
    FOR INSERT WITH CHECK (is_platform_admin() OR is_society_admin(society_id));
CREATE POLICY units_admin_update ON units
    FOR UPDATE USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));
CREATE POLICY units_admin_delete ON units
    FOR DELETE USING (
        (is_platform_admin() OR is_society_admin(society_id))
        AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.unit_id = units.id)
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.unit_id = units.id)
        AND NOT EXISTS (SELECT 1 FROM complaints c WHERE c.unit_id = units.id)
    );

-- Expenses: delete only before anything is approved or paid
DROP POLICY IF EXISTS expenses_admin_write ON expenses;
DROP POLICY IF EXISTS expenses_admin_insert ON expenses;
DROP POLICY IF EXISTS expenses_admin_update ON expenses;
DROP POLICY IF EXISTS expenses_admin_delete ON expenses;
CREATE POLICY expenses_admin_insert ON expenses
    FOR INSERT WITH CHECK (is_platform_admin() OR is_society_admin(society_id));
CREATE POLICY expenses_admin_update ON expenses
    FOR UPDATE USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));
CREATE POLICY expenses_admin_delete ON expenses
    FOR DELETE USING (
        (is_platform_admin() OR is_society_admin(society_id))
        AND status IN ('draft', 'pending_approval', 'rejected')
    );

-- Defence in depth (e.g. platform-admin mistakes): a flat / cycle with bills
-- or payments cannot be deleted at all. NO ACTION still lets a whole society cascade.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT con.conname, cl.relname AS tbl, att.attname AS col, ref.relname AS reftbl
        FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid
        JOIN pg_class ref ON ref.oid = con.confrelid
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
        WHERE con.contype = 'f' AND con.confdeltype = 'c'
          AND (cl.relname, att.attname) IN (('bills', 'unit_id'), ('bills', 'cycle_id'), ('payments', 'unit_id'))
    LOOP
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tbl, r.conname);
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE NO ACTION',
                       r.tbl, r.conname, r.col, r.reftbl);
    END LOOP;
END $$;

-- ============================================================================
-- 3. M1 — SUBSCRIPTION FIELDS ARE PLATFORM-CONTROLLED
-- ============================================================================
CREATE OR REPLACE FUNCTION public.societies_guard_platform_fields()
RETURNS TRIGGER AS $$
BEGIN
    -- SECURITY DEFINER RPCs run as the function owner, so only direct client edits reach this check
    IF current_user IN ('authenticated', 'anon') AND NOT public.is_platform_admin() THEN
        IF NEW.subscription_status IS DISTINCT FROM OLD.subscription_status
           OR NEW.is_active IS DISTINCT FROM OLD.is_active
           OR NEW.slug IS DISTINCT FROM OLD.slug
           OR NEW.total_units IS DISTINCT FROM OLD.total_units THEN
            RAISE EXCEPTION 'Subscription, activation, slug and unit count are managed by Sahvaas';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public; -- deliberately NOT security definer (reads current_user)

DROP TRIGGER IF EXISTS trg_societies_guard_platform_fields ON societies;
CREATE TRIGGER trg_societies_guard_platform_fields
    BEFORE UPDATE ON societies
    FOR EACH ROW EXECUTE FUNCTION public.societies_guard_platform_fields();

-- ============================================================================
-- 4. M2 — BILL NUMBERING + REGENERATING A CANCELLED CYCLE
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
        v_owner := coalesce(v_owner, v_unit.current_owner_id);

        IF v_owner IS NULL THEN
            v_skipped := v_skipped || jsonb_build_object('unit_number', v_unit.unit_number, 'reason', 'No owner linked');
            CONTINUE;
        END IF;

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
-- 5. H1 — CORRECTIONS WITH REVERSAL JOURNALS
-- ============================================================================

-- Post the exact opposite of an existing journal (internal)
CREATE OR REPLACE FUNCTION public.ledger_reverse(
    p_society_id UUID, p_event_type TEXT, p_event_id UUID, p_reversal_type TEXT, p_date DATE, p_narration TEXT
)
RETURNS UUID AS $$
DECLARE
    v_lines JSONB;
BEGIN
    SELECT jsonb_agg(jsonb_build_object('code', a.code, 'amount', -l.amount))
    INTO v_lines
    FROM journal_entries j
    JOIN ledger_entries l ON l.journal_entry_id = j.id
    JOIN accounts a ON a.id = l.account_id
    WHERE j.society_id = p_society_id AND j.reference_event_type = p_event_type AND j.reference_event_id = p_event_id;

    IF v_lines IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN post_journal(p_society_id, p_date, p_reversal_type, p_event_id, p_narration, v_lines);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.cancel_bill(p_bill_id UUID, p_reason TEXT)
RETURNS JSONB AS $$
DECLARE
    v_bill bills%ROWTYPE;
BEGIN
    SELECT * INTO v_bill FROM bills WHERE id = p_bill_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bill not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_bill.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can cancel bills';
    END IF;
    IF length(trim(coalesce(p_reason, ''))) = 0 THEN
        RAISE EXCEPTION 'A reason is required to cancel a bill';
    END IF;
    IF v_bill.status = 'cancelled' THEN
        RAISE EXCEPTION 'Bill is already cancelled';
    END IF;
    IF v_bill.is_opening_balance THEN
        RAISE EXCEPTION 'Opening-balance arrears cannot be cancelled here; ask your CA for a correcting entry';
    END IF;
    IF v_bill.amount_paid > 0 OR EXISTS (SELECT 1 FROM payment_allocations WHERE bill_id = p_bill_id) THEN
        RAISE EXCEPTION 'This bill already has payments against it and cannot be cancelled';
    END IF;

    UPDATE bills SET status = 'cancelled', balance_due = 0, updated_at = timezone('utc'::text, now())
    WHERE id = p_bill_id;

    PERFORM ledger_reverse(v_bill.society_id, 'bill.issued', v_bill.id, 'bill.cancelled', current_date,
                           'Bill ' || v_bill.bill_number || ' cancelled: ' || trim(p_reason));
    PERFORM ledger_reverse(v_bill.society_id, 'bill.late_fee', v_bill.id, 'bill.late_fee_cancelled', current_date,
                           'Late fee on bill ' || v_bill.bill_number || ' cancelled');

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, reason)
    VALUES (v_bill.society_id, auth.uid(), 'bill.cancelled', 'bill', p_bill_id::text,
            jsonb_build_object('bill_number', v_bill.bill_number, 'total', v_bill.total_amount, 'status', v_bill.status), trim(p_reason));

    RETURN jsonb_build_object('status', 'cancelled', 'bill_number', v_bill.bill_number);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.void_expense(p_expense_id UUID, p_reason TEXT)
RETURNS JSONB AS $$
DECLARE
    v_exp expenses%ROWTYPE;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_exp.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can void expenses';
    END IF;
    IF length(trim(coalesce(p_reason, ''))) = 0 THEN
        RAISE EXCEPTION 'A reason is required to void an expense';
    END IF;
    IF v_exp.status = 'voided' THEN
        RAISE EXCEPTION 'Expense is already voided';
    END IF;

    IF v_exp.status = 'paid' OR v_exp.payment_status = 'paid' THEN
        PERFORM ledger_reverse(v_exp.society_id, 'expense.paid', v_exp.id, 'expense.voided', current_date,
                               'Expense ' || v_exp.expense_number || ' voided: ' || trim(p_reason));
    END IF;

    PERFORM set_config('sahvaas.expense_workflow', 'on', true);
    UPDATE expenses SET status = 'voided', updated_at = timezone('utc'::text, now()) WHERE id = p_expense_id;
    PERFORM set_config('sahvaas.expense_workflow', 'off', true);

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, reason)
    VALUES (v_exp.society_id, auth.uid(), 'expense.voided', 'expense', p_expense_id::text,
            jsonb_build_object('expense_number', v_exp.expense_number, 'status', v_exp.status, 'net_payable', v_exp.net_payable), trim(p_reason));

    RETURN jsonb_build_object('status', 'voided', 'reversed', v_exp.status = 'paid' OR v_exp.payment_status = 'paid');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 6. PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.ledger_reverse(UUID, TEXT, UUID, TEXT, DATE, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_bill(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_expense(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_bill(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_expense(UUID, TEXT) TO authenticated;
