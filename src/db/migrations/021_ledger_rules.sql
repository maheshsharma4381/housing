-- ============================================================================
-- 021 RULES FOLLOW THE CHART, NOT CODE LISTS
--   1. Adjustments: a ledger is kept by its own register when it sits in Fixed
--      Assets, Members' Dues, Sundry Creditors or Advances from Members (or is
--      1200/2000/2300/1590), so CA ledgers in those groups are protected too.
--      Inactive ledgers cannot be adjusted.
--   2. Maintenance charges may credit any active income or fund (equity)
--      ledger, including ones the CA created; the fixed code list is gone.
--   3. Receipts & Payments: bank and cash are the ledgers in the Bank Accounts
--      and Cash-in-Hand groups, so a transfer between two banks is neither a
--      receipt nor a payment.
-- ============================================================================

-- ============================================================================
-- 1. ADJUSTMENTS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ledger_blocked_for_adjustment(p_society_id UUID, p_code TEXT)
RETURNS BOOLEAN AS $$
    SELECT coalesce((
        SELECT NOT a.is_active
            OR a.code IN ('1200', '2000', '2300', '1590')
            OR coalesce(account_group_key(a.group_id), '') IN ('fixed_assets', 'members_dues', 'sundry_creditors', 'member_advances')
        FROM accounts a WHERE a.society_id = p_society_id AND a.code = p_code
    ), false)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.validate_adjustment_lines(p_society_id UUID, p_lines JSONB)
RETURNS JSONB AS $$
DECLARE
    v_line JSONB;
    v_out JSONB := '[]'::jsonb;
    v_amount NUMERIC;
    v_code TEXT;
    v_sum NUMERIC := 0;
BEGIN
    IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 2 OR jsonb_array_length(p_lines) > 20 THEN
        RAISE EXCEPTION 'An adjustment needs 2 to 20 lines';
    END IF;
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        v_code := v_line ->> 'code';
        v_amount := round(coalesce((v_line ->> 'amount')::numeric, 0), 2);
        IF v_amount = 0 THEN
            RAISE EXCEPTION 'Every line needs a debit or credit amount';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM accounts WHERE society_id = p_society_id AND code = v_code) THEN
            RAISE EXCEPTION 'Unknown account %', v_code;
        END IF;
        IF EXISTS (SELECT 1 FROM accounts WHERE society_id = p_society_id AND code = v_code AND NOT is_active) THEN
            RAISE EXCEPTION 'Ledger % is inactive', v_code;
        END IF;
        IF ledger_blocked_for_adjustment(p_society_id, v_code) THEN
            RAISE EXCEPTION 'Account % is kept by its own register (members, vendors, advances or assets) — adjust it there', v_code;
        END IF;
        v_out := v_out || jsonb_build_object('code', v_code, 'amount', v_amount);
        v_sum := v_sum + v_amount;
    END LOOP;
    IF v_sum <> 0 THEN
        RAISE EXCEPTION 'Debits and credits must be equal (difference ₹%)', v_sum;
    END IF;
    RETURN v_out;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- chart_of_accounts as in 020, with adjustable from the groups
CREATE OR REPLACE FUNCTION public.chart_of_accounts(p_society_id UUID)
RETURNS JSONB AS $$
BEGIN
    IF NOT (can_view_financials(p_society_id) OR can_manage_accounts(p_society_id)) THEN
        RAISE EXCEPTION 'You do not have access to this society''s accounts';
    END IF;
    RETURN jsonb_build_object(
        'groups', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'id', g.id, 'parent_id', g.parent_id, 'name', g.name, 'nature', g.nature,
                'system_key', g.system_key, 'sort_order', g.sort_order,
                'allows_ledgers', group_allows_ledgers(g.id)
            ) ORDER BY g.sort_order, g.name)
            FROM account_groups g WHERE g.society_id = p_society_id
        ), '[]'::jsonb),
        'ledgers', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'code', a.code, 'name', a.name, 'nature', a.type, 'group_id', a.group_id,
                'is_system', a.is_system, 'is_active', a.is_active,
                'balance', coalesce(b.bal, 0),
                'adjustable', NOT ledger_blocked_for_adjustment(p_society_id, a.code)
            ) ORDER BY a.code)
            FROM accounts a
            LEFT JOIN (
                SELECT l.account_id, sum(l.amount) AS bal FROM ledger_entries l
                WHERE l.society_id = p_society_id GROUP BY l.account_id
            ) b ON b.account_id = a.id
            WHERE a.society_id = p_society_id
        ), '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 2. MAINTENANCE CHARGES CREDIT ANY ACTIVE INCOME OR FUND LEDGER
-- ============================================================================
ALTER TABLE billing_rules DROP CONSTRAINT IF EXISTS chk_billing_rules_account_code;

CREATE OR REPLACE FUNCTION public.trg_billing_rule_account()
RETURNS TRIGGER AS $$
BEGIN
    -- Checked when a charge starts crediting a ledger; an old, switched-off charge can still be edited
    IF NOT NEW.is_active THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.account_code IS NOT DISTINCT FROM OLD.account_code AND OLD.is_active THEN
        RETURN NEW;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM accounts
        WHERE society_id = NEW.society_id AND code = NEW.account_code AND is_active AND type IN ('income', 'equity')
    ) THEN
        RAISE EXCEPTION 'Maintenance charges can only go to an active income or fund ledger';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_billing_rule_account ON billing_rules;
CREATE TRIGGER trg_billing_rule_account
    BEFORE INSERT OR UPDATE ON billing_rules
    FOR EACH ROW EXECUTE FUNCTION public.trg_billing_rule_account();

-- ============================================================================
-- 3. RECEIPTS & PAYMENTS: CASH = BANK ACCOUNTS + CASH-IN-HAND GROUPS
--    (body as in 014 otherwise)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.receipts_payments(p_society_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (section TEXT, code TEXT, name TEXT, amount NUMERIC) AS $$
BEGIN
    IF NOT can_view_financials(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s financial reports';
    END IF;
    RETURN QUERY
    WITH cash AS (
        SELECT ac.id FROM accounts ac
        WHERE ac.society_id = p_society_id AND account_group_key(ac.group_id) IN ('bank_accounts', 'cash_in_hand')
    ), lines AS (
        SELECT l.journal_entry_id AS jid, l.account_id, l.amount AS amt, l.account_id IN (SELECT c.id FROM cash c) AS is_cash
        FROM ledger_entries l
        WHERE l.society_id = p_society_id AND l.date BETWEEN p_from AND p_to
    ), per AS (
        SELECT ln.jid,
               coalesce(sum(ln.amt) FILTER (WHERE ln.is_cash), 0) AS cash_net,
               coalesce(-sum(ln.amt) FILTER (WHERE NOT ln.is_cash AND ln.amt < 0), 0) AS credits,
               coalesce(sum(ln.amt) FILTER (WHERE NOT ln.is_cash AND ln.amt > 0), 0) AS debits
        FROM lines ln GROUP BY ln.jid
    ), alloc AS (
        SELECT 'receipt'::text AS sec, ln.account_id, -ln.amt * p.cash_net / p.credits AS share
        FROM lines ln JOIN per p ON p.jid = ln.jid
        WHERE NOT ln.is_cash AND ln.amt < 0 AND p.cash_net > 0 AND p.credits > 0
        UNION ALL
        SELECT 'payment', ln.account_id, ln.amt * -p.cash_net / p.debits
        FROM lines ln JOIN per p ON p.jid = ln.jid
        WHERE NOT ln.is_cash AND ln.amt > 0 AND p.cash_net < 0 AND p.debits > 0
    ), opening AS (
        SELECT coalesce(sum(l.amount), 0) AS bal FROM ledger_entries l
        WHERE l.society_id = p_society_id AND l.date < p_from AND l.account_id IN (SELECT c.id FROM cash c)
    ), closing AS (
        SELECT coalesce(sum(l.amount), 0) AS bal FROM ledger_entries l
        WHERE l.society_id = p_society_id AND l.date <= p_to AND l.account_id IN (SELECT c.id FROM cash c)
    ), result AS (
        SELECT 'opening'::text AS sec, NULL::text AS acode, 'Opening bank & cash'::text AS aname, (SELECT o.bal FROM opening o) AS val, 0 AS ord
        UNION ALL
        SELECT x.sec, a.code::text, a.name::text, round(sum(x.share), 2), CASE x.sec WHEN 'receipt' THEN 1 ELSE 2 END
        FROM alloc x JOIN accounts a ON a.id = x.account_id
        GROUP BY x.sec, a.code, a.name
        UNION ALL
        SELECT 'closing', NULL, 'Closing bank & cash', (SELECT cl.bal FROM closing cl), 3
    )
    SELECT r.sec, r.acode, r.aname, r.val FROM result r ORDER BY r.ord, r.acode;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.ledger_blocked_for_adjustment(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_billing_rule_account() FROM PUBLIC, anon, authenticated;
