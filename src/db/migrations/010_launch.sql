-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 010: Launch Readiness
--   1. Suspended societies lose access (helpers require societies.is_active)
--   2. Advance (overpayment) automatically adjusted against new bills
--   3. Opening balances for societies migrating from Tally / registers
--   4. Late fees: system runner + nightly pg_cron job (when available)
--   5. Platform-owner tools: overview, status changes, plan assignment
-- Safe to re-run.
-- ============================================================================

-- ============================================================================
-- 1. SUSPENSION ENFORCEMENT
--    Membership / committee / professional checks only pass for active
--    societies. Platform admins are unaffected and can reactivate.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.is_society_admin(target_society_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM society_memberships m
    JOIN societies s ON s.id = m.society_id AND s.is_active = true
    WHERE m.society_id = target_society_id
      AND m.user_id = auth.uid()
      AND m.is_active = true
      AND m.role IN ('society_admin', 'secretary', 'chairman', 'treasurer')
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.has_society_membership(target_society_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM society_memberships m
    JOIN societies s ON s.id = m.society_id AND s.is_active = true
    WHERE m.society_id = target_society_id
      AND m.user_id = auth.uid()
      AND m.is_active = true
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.has_professional_permission(target_society_id UUID, required_permission TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM society_professional_access spa
    JOIN societies s ON s.id = spa.society_id AND s.is_active = true
    WHERE spa.society_id = target_society_id
      AND spa.professional_user_id = auth.uid()
      AND spa.status = 'active'
      AND (spa.expires_at IS NULL OR spa.expires_at > now())
      AND spa.permissions ? required_permission
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.has_active_professional_grant(target_society_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM society_professional_access spa
    JOIN societies s ON s.id = spa.society_id AND s.is_active = true
    WHERE spa.society_id = target_society_id
      AND spa.professional_user_id = auth.uid()
      AND spa.status = 'active'
      AND (spa.expires_at IS NULL OR spa.expires_at > now())
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.has_society_role(target_society_id UUID, roles TEXT[])
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM society_memberships m
        JOIN societies s ON s.id = m.society_id AND s.is_active = true
        WHERE m.society_id = target_society_id AND m.user_id = auth.uid()
          AND m.is_active = true AND m.role = ANY (roles)
    )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 2. OPENING-BALANCE BILLS DO NOT POST INCOME
-- ============================================================================
ALTER TABLE bills ADD COLUMN IF NOT EXISTS is_opening_balance BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.ledger_post_bill(p_bill_id UUID)
RETURNS UUID AS $$
DECLARE
    v_bill bills%ROWTYPE;
    v_unit TEXT;
    v_receivable NUMERIC;
    v_items_total NUMERIC := 0;
    v_lines JSONB := '[]'::jsonb;
    v_group RECORD;
BEGIN
    SELECT * INTO v_bill FROM bills WHERE id = p_bill_id;
    -- Opening arrears are already in the opening-balance journal
    IF NOT FOUND OR v_bill.status IN ('draft', 'cancelled') OR v_bill.is_opening_balance THEN
        RETURN NULL;
    END IF;
    SELECT unit_number INTO v_unit FROM units WHERE id = v_bill.unit_id;

    v_receivable := v_bill.total_amount - v_bill.interest_or_late_fee;
    v_lines := v_lines || jsonb_build_object('code', '1200', 'amount', v_receivable);

    FOR v_group IN
        SELECT coalesce(r.account_code, '4000') AS code, sum(i.amount) AS amount
        FROM bill_items i LEFT JOIN billing_rules r ON r.id = i.rule_id
        WHERE i.bill_id = p_bill_id
          AND NOT (i.rule_id IS NULL AND i.description = 'Late payment charge')
        GROUP BY 1
    LOOP
        v_lines := v_lines || jsonb_build_object('code', v_group.code, 'amount', -v_group.amount);
        v_items_total := v_items_total + v_group.amount;
    END LOOP;

    v_lines := v_lines || jsonb_build_object('code', '2100', 'amount', -v_bill.tax_amount);
    v_lines := v_lines || jsonb_build_object('code', '4000', 'amount', -(v_receivable - v_bill.tax_amount - v_items_total));

    RETURN post_journal(
        v_bill.society_id, v_bill.bill_date, 'bill.issued', v_bill.id,
        'Bill ' || v_bill.bill_number || ' issued to flat ' || coalesce(v_unit, '?'),
        v_lines
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. ADVANCE AUTO-ADJUSTMENT
--    Unallocated amounts of the flat's verified payments settle a new bill;
--    journal: Dr 2300 Advance / Cr 1200 Receivable.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ledger_apply_advance(p_bill_id UUID)
RETURNS NUMERIC AS $$
DECLARE
    v_bill bills%ROWTYPE;
    v_pay RECORD;
    v_balance NUMERIC;
    v_alloc NUMERIC;
    v_total NUMERIC := 0;
BEGIN
    SELECT * INTO v_bill FROM bills WHERE id = p_bill_id FOR UPDATE;
    IF NOT FOUND OR v_bill.balance_due <= 0 OR v_bill.status NOT IN ('issued', 'partially_paid', 'overdue') THEN
        RETURN 0;
    END IF;
    v_balance := v_bill.balance_due;

    FOR v_pay IN
        SELECT p.id, p.amount - coalesce((SELECT sum(a.amount) FROM payment_allocations a WHERE a.payment_id = p.id), 0) AS remaining
        FROM payments p
        WHERE p.society_id = v_bill.society_id AND p.unit_id = v_bill.unit_id AND p.status = 'verified'
        ORDER BY p.verified_at NULLS FIRST, p.created_at
        FOR UPDATE OF p
    LOOP
        CONTINUE WHEN v_pay.remaining <= 0;
        v_alloc := least(v_pay.remaining, v_balance);
        INSERT INTO payment_allocations (society_id, payment_id, bill_id, amount)
        VALUES (v_bill.society_id, v_pay.id, v_bill.id, v_alloc);
        v_balance := v_balance - v_alloc;
        v_total := v_total + v_alloc;
        EXIT WHEN v_balance <= 0;
    END LOOP;

    IF v_total > 0 THEN
        UPDATE bills
        SET amount_paid = amount_paid + v_total,
            balance_due = balance_due - v_total,
            status = CASE WHEN balance_due - v_total <= 0 THEN 'paid' ELSE 'partially_paid' END,
            updated_at = timezone('utc'::text, now())
        WHERE id = v_bill.id;

        PERFORM post_journal(
            v_bill.society_id, v_bill.bill_date, 'advance.applied', v_bill.id,
            'Advance adjusted against bill ' || v_bill.bill_number,
            jsonb_build_array(
                jsonb_build_object('code', '2300', 'amount', v_total),
                jsonb_build_object('code', '1200', 'amount', -v_total)
            )
        );
    END IF;
    RETURN v_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.trg_ledger_bill_insert()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM ledger_post_bill(NEW.id);
    PERFORM ledger_apply_advance(NEW.id);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 4. OPENING BALANCES (one-time per society)
--    p_accounts:     [{ "code": "1000", "amount": 250000 }, ...]  debit +, credit −
--    p_member_dues:  [{ "unit_number": "A-101", "wing": "A", "amount": 4500 }, ...]
--    Member dues become opening bills (so residents can pay them) and the
--    1200 Receivable line; any difference goes to 3200 General Reserve.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.post_opening_balances(
    p_society_id UUID,
    p_as_of DATE,
    p_accounts JSONB,
    p_member_dues JSONB DEFAULT '[]'::jsonb
)
RETURNS JSONB AS $$
DECLARE
    v_line JSONB;
    v_lines JSONB := '[]'::jsonb;
    v_sum NUMERIC := 0;
    v_amount NUMERIC;
    v_code TEXT;
    v_dues_total NUMERIC := 0;
    v_balancing NUMERIC;
    v_cycle UUID;
    v_unit RECORD;
    v_owner UUID;
    v_seq INT := 0;
    v_bill UUID;
    v_journal UUID;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can post opening balances';
    END IF;
    IF EXISTS (SELECT 1 FROM journal_entries WHERE society_id = p_society_id AND reference_event_type = 'opening.balance') THEN
        RAISE EXCEPTION 'Opening balances have already been posted for this society';
    END IF;
    IF p_as_of IS NULL OR p_as_of > current_date THEN
        RAISE EXCEPTION 'Opening date must be today or earlier';
    END IF;
    PERFORM ensure_default_accounts(p_society_id);

    FOR v_line IN SELECT * FROM jsonb_array_elements(coalesce(p_accounts, '[]'::jsonb)) LOOP
        v_code := v_line ->> 'code';
        v_amount := round(coalesce((v_line ->> 'amount')::NUMERIC, 0), 2);
        CONTINUE WHEN v_amount = 0;
        IF v_code = '1200' THEN
            RAISE EXCEPTION 'Enter member dues flat-wise instead of a Members Receivable total';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM accounts WHERE society_id = p_society_id AND code = v_code) THEN
            RAISE EXCEPTION 'Unknown account code %', v_code;
        END IF;
        v_lines := v_lines || jsonb_build_object('code', v_code, 'amount', v_amount);
        v_sum := v_sum + v_amount;
    END LOOP;

    -- Member arrears as opening bills
    IF jsonb_array_length(coalesce(p_member_dues, '[]'::jsonb)) > 0 THEN
        INSERT INTO billing_cycles (society_id, cycle_name, period_start, period_end, due_date, status)
        VALUES (p_society_id, 'Opening balance (arrears)', p_as_of, p_as_of, p_as_of, 'published')
        RETURNING id INTO v_cycle;

        FOR v_line IN SELECT * FROM jsonb_array_elements(p_member_dues) LOOP
            v_amount := round(coalesce((v_line ->> 'amount')::NUMERIC, 0), 2);
            CONTINUE WHEN v_amount = 0;
            IF v_amount < 0 THEN
                RAISE EXCEPTION 'Flat %: enter advances received as a 2300 Advance Maintenance account line, not negative dues', v_line ->> 'unit_number';
            END IF;

            SELECT u.* INTO v_unit FROM units u JOIN wings w ON w.id = u.wing_id
            WHERE u.society_id = p_society_id
              AND u.unit_number = trim(v_line ->> 'unit_number')
              AND (coalesce(v_line ->> 'wing', '') = '' OR w.name = v_line ->> 'wing')
            LIMIT 1;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Flat % not found — import flats first', v_line ->> 'unit_number';
            END IF;

            SELECT m.user_id INTO v_owner FROM society_memberships m
            WHERE m.society_id = p_society_id AND m.unit_id = v_unit.id AND m.role = 'resident_owner' AND m.is_active = true
            ORDER BY m.created_at LIMIT 1;
            v_owner := coalesce(v_owner, v_unit.current_owner_id);
            IF v_owner IS NULL THEN
                RAISE EXCEPTION 'Flat % has no owner linked — invite the owner before posting their arrears', v_unit.unit_number;
            END IF;

            v_seq := v_seq + 1;
            INSERT INTO bills (society_id, cycle_id, unit_id, user_id, bill_number, bill_date, due_date,
                               subtotal_amount, total_amount, amount_paid, balance_due, status, is_opening_balance)
            VALUES (p_society_id, v_cycle, v_unit.id, v_owner, 'OB-' || lpad(v_seq::text, 4, '0'), p_as_of, p_as_of,
                    v_amount, v_amount, 0, v_amount, 'issued', true)
            RETURNING id INTO v_bill;
            INSERT INTO bill_items (bill_id, description, quantity, unit_rate, amount, total_item_amount)
            VALUES (v_bill, 'Opening balance (arrears as on ' || to_char(p_as_of, 'DD-Mon-YYYY') || ')', 1, v_amount, v_amount, v_amount);

            v_dues_total := v_dues_total + v_amount;
            v_owner := NULL;
        END LOOP;
        v_lines := v_lines || jsonb_build_object('code', '1200', 'amount', v_dues_total);
        v_sum := v_sum + v_dues_total;
    END IF;

    v_balancing := -v_sum;
    IF v_balancing <> 0 THEN
        v_lines := v_lines || jsonb_build_object('code', '3200', 'amount', v_balancing,
                                                 'narration', 'Opening balance difference (General Reserve)');
    END IF;

    v_journal := post_journal(p_society_id, p_as_of, 'opening.balance', p_society_id,
                              'Opening balances as on ' || to_char(p_as_of, 'DD-Mon-YYYY'), v_lines);
    IF v_journal IS NULL THEN
        RAISE EXCEPTION 'Nothing to post — enter at least one balance';
    END IF;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'ledger.opening_balances', 'society', p_society_id::text,
            jsonb_build_object('as_of', p_as_of, 'member_dues', v_dues_total, 'balancing_to_reserve', v_balancing));

    RETURN jsonb_build_object('journal_id', v_journal, 'member_dues_total', v_dues_total,
                              'opening_bills', v_seq, 'balancing_to_general_reserve', v_balancing);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. LATE FEES: shared runner, committee wrapper, nightly system job
-- ============================================================================
CREATE OR REPLACE FUNCTION public.run_late_fees(p_society_id UUID, p_as_of DATE)
RETURNS JSONB AS $$
DECLARE
    v_settings society_settings%ROWTYPE;
    v_bill RECORD;
    v_fee NUMERIC;
    v_marked INT := 0;
    v_fees INT := 0;
    v_fee_total NUMERIC := 0;
BEGIN
    SELECT * INTO v_settings FROM society_settings WHERE society_id = p_society_id;

    FOR v_bill IN
        SELECT * FROM bills
        WHERE society_id = p_society_id
          AND due_date < p_as_of
          AND balance_due > 0
          AND status IN ('issued', 'partially_paid', 'overdue')
          AND NOT is_opening_balance
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

    -- audit_logs.user_id is required; the nightly job runs without a user
    IF (v_marked > 0 OR v_fees > 0) AND auth.uid() IS NOT NULL THEN
        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (p_society_id, auth.uid(), 'bills.late_fees_applied', 'society', p_society_id::text,
                jsonb_build_object('marked_overdue', v_marked, 'late_fees', v_fees, 'total', v_fee_total, 'as_of', p_as_of));
    END IF;

    RETURN jsonb_build_object('marked_overdue', v_marked, 'late_fees_applied', v_fees, 'late_fee_total', v_fee_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.apply_late_fees(p_society_id UUID, p_as_of DATE DEFAULT current_date)
RETURNS JSONB AS $$
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can apply late fees';
    END IF;
    RETURN run_late_fees(p_society_id, p_as_of);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.apply_late_fees_all(p_as_of DATE DEFAULT current_date)
RETURNS INT AS $$
DECLARE
    r RECORD;
    v_count INT := 0;
BEGIN
    FOR r IN SELECT id FROM societies WHERE is_active = true LOOP
        PERFORM run_late_fees(r.id, p_as_of);
        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.run_late_fees(UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_late_fees_all(DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ledger_apply_advance(UUID) FROM PUBLIC, anon, authenticated;

-- Nightly at 00:30 IST (19:00 UTC) when pg_cron is available (Supabase: Database → Extensions)
DO $outer$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
        CREATE EXTENSION IF NOT EXISTS pg_cron;
        PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sahvaas-late-fees';
        PERFORM cron.schedule('sahvaas-late-fees', '0 19 * * *', $cron$SELECT public.apply_late_fees_all()$cron$);
    END IF;
END
$outer$;

-- ============================================================================
-- 6. PLATFORM-OWNER TOOLS
-- ============================================================================
INSERT INTO subscription_plans (name, tier_code, monthly_rate_per_unit_inr, max_units, features_included) VALUES
    ('Standalone Society', 'starter', 12, 60,
     '["Resident PWA", "UPI collections & receipts", "Double-entry ledger", "Notices & helpdesk"]'::jsonb),
    ('Multi-Wing Society', 'growth', 18, 250,
     '["Everything in Standalone", "CA & auditor portal", "GSTR-2B reconciliation", "Expense approvals"]'::jsonb),
    ('Township / Multi-Tower', 'enterprise', 25, 100000,
     '["Everything in Multi-Wing", "Priority support", "Data migration assistance"]'::jsonb)
ON CONFLICT (tier_code) DO NOTHING;

CREATE OR REPLACE FUNCTION public.platform_society_overview()
RETURNS TABLE (
    id UUID, name TEXT, slug TEXT, city TEXT, state TEXT, subscription_status TEXT, is_active BOOLEAN,
    created_at TIMESTAMPTZ, total_units INT, members INT, billed_this_month NUMERIC, collected_this_month NUMERIC,
    plan_tier TEXT, plan_period_end DATE
) AS $$
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;
    RETURN QUERY
    SELECT s.id, s.name::TEXT, s.slug::TEXT, s.city::TEXT, s.state::TEXT, s.subscription_status::TEXT, s.is_active,
           s.created_at, s.total_units,
           (SELECT count(*)::INT FROM society_memberships m WHERE m.society_id = s.id AND m.is_active),
           (SELECT coalesce(sum(b.total_amount), 0) FROM bills b WHERE b.society_id = s.id AND b.bill_date >= date_trunc('month', current_date)),
           (SELECT coalesce(sum(p.amount), 0) FROM payments p WHERE p.society_id = s.id AND p.status = 'verified' AND p.verified_at >= date_trunc('month', current_date)),
           sp.tier_code::TEXT, sub.current_period_end
    FROM societies s
    LEFT JOIN subscriptions sub ON sub.society_id = s.id
    LEFT JOIN subscription_plans sp ON sp.id = sub.plan_id
    ORDER BY s.created_at DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.platform_set_society_status(p_society_id UUID, p_status TEXT, p_reason TEXT DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
    v_old TEXT;
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;
    IF p_status NOT IN ('trial', 'active', 'suspended', 'cancelled') THEN
        RAISE EXCEPTION 'Invalid status %', p_status;
    END IF;
    IF p_status IN ('suspended', 'cancelled') AND length(trim(coalesce(p_reason, ''))) = 0 THEN
        RAISE EXCEPTION 'A reason is required to suspend or cancel a society';
    END IF;
    SELECT subscription_status INTO v_old FROM societies WHERE id = p_society_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Society not found';
    END IF;

    UPDATE societies
    SET subscription_status = p_status,
        is_active = p_status IN ('trial', 'active'),
        updated_at = timezone('utc'::text, now())
    WHERE id = p_society_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, new_value, reason)
    VALUES (p_society_id, auth.uid(), 'platform.society_status', 'society', p_society_id::text,
            jsonb_build_object('status', v_old), jsonb_build_object('status', p_status), p_reason);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.platform_assign_plan(
    p_society_id UUID, p_tier_code TEXT, p_billing_term TEXT DEFAULT 'annual', p_period_end DATE DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
    v_plan UUID;
    v_units INT;
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;
    SELECT id INTO v_plan FROM subscription_plans WHERE tier_code = p_tier_code AND is_active;
    IF v_plan IS NULL THEN
        RAISE EXCEPTION 'Unknown plan %', p_tier_code;
    END IF;
    SELECT total_units INTO v_units FROM societies WHERE id = p_society_id;

    INSERT INTO subscriptions (society_id, plan_id, billing_term, status, current_period_start, current_period_end, unit_count)
    VALUES (p_society_id, v_plan, p_billing_term, 'active', current_date,
            coalesce(p_period_end, (current_date + CASE WHEN p_billing_term = 'monthly' THEN interval '1 month' ELSE interval '1 year' END)::date),
            coalesce(v_units, 0))
    ON CONFLICT (society_id) DO UPDATE SET
        plan_id = EXCLUDED.plan_id, billing_term = EXCLUDED.billing_term, status = 'active',
        current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end,
        unit_count = EXCLUDED.unit_count;

    UPDATE societies SET subscription_status = 'active', is_active = true, updated_at = timezone('utc'::text, now())
    WHERE id = p_society_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'platform.plan_assigned', 'society', p_society_id::text,
            jsonb_build_object('tier', p_tier_code, 'term', p_billing_term));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 7. PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.post_opening_balances(UUID, DATE, JSONB, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_society_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_set_society_status(UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_assign_plan(UUID, TEXT, TEXT, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_opening_balances(UUID, DATE, JSONB, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_society_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_set_society_status(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_assign_plan(UUID, TEXT, TEXT, DATE) TO authenticated;
