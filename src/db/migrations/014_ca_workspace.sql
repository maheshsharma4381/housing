-- ============================================================================
-- 014 CA WORKSPACE (P9)
--   1. Financial-year helpers and FY lock (after audit): manual postings into a
--      locked year are refused; system events are moved to the first open day
--   2. Last year's audited figures (comparatives for year 1 on Sahvaas)
--   3. Comparative I&E and Balance Sheet, Receipts & Payments, account ledger,
--      payables ageing, TDS register, GST summary
--   4. CA adjustment proposals -> committee approval -> journal
--      (plain journals, or "capitalise this expense" which also creates the asset)
-- ============================================================================

-- ============================================================================
-- 1. FINANCIAL YEAR HELPERS + LOCK
-- ============================================================================
-- 31 March that ends the Indian financial year containing p_date
CREATE OR REPLACE FUNCTION public.fy_end_of(p_date DATE)
RETURNS DATE AS $$
    SELECT make_date(extract(year FROM p_date)::int + CASE WHEN extract(month FROM p_date) >= 4 THEN 1 ELSE 0 END, 3, 31)
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.fy_start_of(p_date DATE)
RETURNS DATE AS $$
    SELECT (fy_end_of(p_date) - interval '1 year' + interval '1 day')::date
$$ LANGUAGE sql IMMUTABLE;

CREATE TABLE IF NOT EXISTS financial_year_locks (
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    fy_end DATE NOT NULL CHECK (extract(month FROM fy_end) = 3 AND extract(day FROM fy_end) = 31),
    locked_by UUID REFERENCES profiles(id),
    locked_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    note TEXT,
    PRIMARY KEY (society_id, fy_end)
);
ALTER TABLE financial_year_locks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS financial_year_locks_select ON financial_year_locks;
CREATE POLICY financial_year_locks_select ON financial_year_locks
    FOR SELECT USING (can_view_financials(society_id) OR has_professional_permission(society_id, 'view_expenses'));

CREATE OR REPLACE FUNCTION public.books_locked_until(p_society_id UUID)
RETURNS DATE AS $$
    SELECT max(fy_end) FROM financial_year_locks WHERE society_id = p_society_id
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Manual entries (adjustments, opening balances, depreciation) cannot go into a locked year.
-- Everything else that arrives late (a receipt, a bill payment, a vendor bill dated last year)
-- is posted on the first day of the open year, with the original date kept in the narration.
CREATE OR REPLACE FUNCTION public.trg_journal_respect_lock()
RETURNS TRIGGER AS $$
DECLARE
    v_lock DATE := books_locked_until(NEW.society_id);
BEGIN
    IF v_lock IS NOT NULL AND NEW.entry_date <= v_lock THEN
        IF NEW.reference_event_type IN ('adjustment.approved', 'opening.balance', 'depreciation.run') THEN
            RAISE EXCEPTION 'The books up to % are locked after audit — date this entry on or after %',
                to_char(v_lock, 'DD Mon YYYY'), to_char(v_lock + 1, 'DD Mon YYYY');
        END IF;
        NEW.narration := NEW.narration || ' [dated ' || to_char(NEW.entry_date, 'DD-Mon-YYYY') || '; that year is locked]';
        NEW.entry_date := v_lock + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_journal_respect_lock ON journal_entries;
CREATE TRIGGER trg_journal_respect_lock BEFORE INSERT ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION public.trg_journal_respect_lock();

-- Ledger lines always carry their journal's (possibly moved) date
CREATE OR REPLACE FUNCTION public.trg_ledger_entry_date()
RETURNS TRIGGER AS $$
BEGIN
    SELECT entry_date INTO NEW.date FROM journal_entries WHERE id = NEW.journal_entry_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_ledger_entry_date ON ledger_entries;
CREATE TRIGGER trg_ledger_entry_date BEFORE INSERT ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION public.trg_ledger_entry_date();

-- ============================================================================
-- 2. LAST YEAR'S AUDITED FIGURES (comparatives)
--    Same sign as the ledger: debit positive, credit negative.
-- ============================================================================
CREATE TABLE IF NOT EXISTS prior_year_balances (
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    fy_end DATE NOT NULL CHECK (extract(month FROM fy_end) = 3 AND extract(day FROM fy_end) = 31),
    account_code VARCHAR(32) NOT NULL,
    amount NUMERIC(14,2) NOT NULL,
    entered_by UUID REFERENCES profiles(id),
    entered_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    PRIMARY KEY (society_id, fy_end, account_code)
);
ALTER TABLE prior_year_balances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prior_year_balances_select ON prior_year_balances;
CREATE POLICY prior_year_balances_select ON prior_year_balances FOR SELECT USING (can_view_financials(society_id));

-- Replaces the whole set for that year. Committee or a CA with report access may enter them.
CREATE OR REPLACE FUNCTION public.save_prior_year_balances(p_society_id UUID, p_fy_end DATE, p_lines JSONB)
RETURNS JSONB AS $$
DECLARE
    v_line JSONB;
    v_code TEXT;
    v_amount NUMERIC;
    v_count INT := 0;
    v_sum NUMERIC := 0;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id) OR has_professional_permission(p_society_id, 'view_reports')) THEN
        RAISE EXCEPTION 'Only the committee or the society''s CA can enter last year''s figures';
    END IF;
    IF p_fy_end IS NULL OR extract(month FROM p_fy_end) <> 3 OR extract(day FROM p_fy_end) <> 31 OR p_fy_end >= current_date THEN
        RAISE EXCEPTION 'Choose a financial year that has ended (31 March)';
    END IF;

    DELETE FROM prior_year_balances WHERE society_id = p_society_id AND fy_end = p_fy_end;
    FOR v_line IN SELECT * FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) LOOP
        v_code := v_line ->> 'code';
        v_amount := round(coalesce((v_line ->> 'amount')::numeric, 0), 2);
        CONTINUE WHEN v_amount = 0;
        IF NOT EXISTS (SELECT 1 FROM accounts WHERE society_id = p_society_id AND code = v_code) THEN
            RAISE EXCEPTION 'Unknown account code %', v_code;
        END IF;
        INSERT INTO prior_year_balances (society_id, fy_end, account_code, amount, entered_by)
        VALUES (p_society_id, p_fy_end, v_code, v_amount, auth.uid());
        v_count := v_count + 1;
        v_sum := v_sum + v_amount;
    END LOOP;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'reports.prior_year_saved', 'society', p_society_id::text,
            jsonb_build_object('fy_end', p_fy_end, 'lines', v_count, 'difference', v_sum));
    RETURN jsonb_build_object('lines', v_count, 'difference', v_sum);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. REPORTS
-- ============================================================================

-- Current period vs the whole previous financial year (audited figures if entered, else the books)
CREATE OR REPLACE FUNCTION public.income_expenditure_compare(p_society_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (type TEXT, code TEXT, name TEXT, current NUMERIC, previous NUMERIC, previous_source TEXT) AS $$
DECLARE
    v_prev_end DATE;
    v_audited BOOLEAN;
BEGIN
    IF NOT can_view_financials(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s financial reports';
    END IF;
    v_prev_end := fy_start_of(p_from) - 1;
    v_audited := EXISTS (SELECT 1 FROM prior_year_balances WHERE society_id = p_society_id AND fy_end = v_prev_end);

    RETURN QUERY
    WITH cur AS (
        SELECT l.account_id, sum(l.amount) AS amt FROM ledger_entries l
        WHERE l.society_id = p_society_id AND l.date BETWEEN p_from AND p_to GROUP BY 1
    ), prev_books AS (
        SELECT l.account_id, sum(l.amount) AS amt FROM ledger_entries l
        WHERE l.society_id = p_society_id AND l.date BETWEEN fy_start_of(v_prev_end) AND v_prev_end GROUP BY 1
    ), prev AS (
        SELECT a.id AS account_id, p.amount AS amt FROM prior_year_balances p
        JOIN accounts a ON a.society_id = p.society_id AND a.code = p.account_code
        WHERE v_audited AND p.society_id = p_society_id AND p.fy_end = v_prev_end
        UNION ALL
        SELECT account_id, amt FROM prev_books WHERE NOT v_audited
    )
    SELECT a.type::text, a.code::text, a.name::text,
           (CASE WHEN a.type = 'income' THEN -1 ELSE 1 END * coalesce(c.amt, 0))::numeric,
           (CASE WHEN a.type = 'income' THEN -1 ELSE 1 END * coalesce(pv.amt, 0))::numeric,
           CASE WHEN v_audited THEN 'audited' ELSE 'books' END
    FROM accounts a
    LEFT JOIN cur c ON c.account_id = a.id
    LEFT JOIN prev pv ON pv.account_id = a.id
    WHERE a.society_id = p_society_id AND a.type IN ('income', 'expense')
      AND (coalesce(c.amt, 0) <> 0 OR coalesce(pv.amt, 0) <> 0)
    ORDER BY a.type DESC, a.code;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Balances (debit positive) as at p_as_of and as at the previous year end
CREATE OR REPLACE FUNCTION public.balance_sheet_compare(p_society_id UUID, p_as_of DATE DEFAULT current_date)
RETURNS TABLE (type TEXT, code TEXT, name TEXT, current NUMERIC, previous NUMERIC, previous_source TEXT, previous_as_of DATE) AS $$
DECLARE
    v_prev_end DATE;
    v_audited BOOLEAN;
BEGIN
    IF NOT can_view_financials(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s financial reports';
    END IF;
    v_prev_end := fy_start_of(p_as_of) - 1;
    v_audited := EXISTS (SELECT 1 FROM prior_year_balances WHERE society_id = p_society_id AND fy_end = v_prev_end);

    RETURN QUERY
    WITH cur AS (
        SELECT l.account_id, sum(l.amount) AS amt FROM ledger_entries l
        WHERE l.society_id = p_society_id AND l.date <= p_as_of GROUP BY 1
    ), prev AS (
        SELECT a.id AS account_id, p.amount AS amt FROM prior_year_balances p
        JOIN accounts a ON a.society_id = p.society_id AND a.code = p.account_code
        WHERE v_audited AND p.society_id = p_society_id AND p.fy_end = v_prev_end
        UNION ALL
        SELECT l.account_id, sum(l.amount) FROM ledger_entries l
        WHERE NOT v_audited AND l.society_id = p_society_id AND l.date <= v_prev_end GROUP BY 1
    )
    SELECT a.type::text, a.code::text, a.name::text, coalesce(c.amt, 0)::numeric, coalesce(pv.amt, 0)::numeric,
           CASE WHEN v_audited THEN 'audited' ELSE 'books' END, v_prev_end
    FROM accounts a
    LEFT JOIN cur c ON c.account_id = a.id
    LEFT JOIN prev pv ON pv.account_id = a.id
    WHERE a.society_id = p_society_id AND (coalesce(c.amt, 0) <> 0 OR coalesce(pv.amt, 0) <> 0)
    ORDER BY a.code;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Cash-basis summary: bank + cash movements, each journal's counter-accounts sharing it pro rata
CREATE OR REPLACE FUNCTION public.receipts_payments(p_society_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (section TEXT, code TEXT, name TEXT, amount NUMERIC) AS $$
BEGIN
    IF NOT can_view_financials(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s financial reports';
    END IF;
    RETURN QUERY
    WITH cash AS (
        SELECT ac.id FROM accounts ac WHERE ac.society_id = p_society_id AND ac.code IN ('1000', '1100')
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

-- One account's entries with a running balance (debit positive); first row is the opening balance
CREATE OR REPLACE FUNCTION public.account_ledger(p_society_id UUID, p_code TEXT, p_from DATE, p_to DATE)
RETURNS TABLE (entry_date DATE, entry_number TEXT, narration TEXT, debit NUMERIC, credit NUMERIC, balance NUMERIC) AS $$
DECLARE
    v_account UUID;
    v_opening NUMERIC;
BEGIN
    IF NOT can_view_financials(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s financial reports';
    END IF;
    SELECT id INTO v_account FROM accounts WHERE society_id = p_society_id AND code = p_code;
    IF v_account IS NULL THEN
        RAISE EXCEPTION 'Unknown account %', p_code;
    END IF;
    SELECT coalesce(sum(amount), 0) INTO v_opening FROM ledger_entries WHERE account_id = v_account AND date < p_from;

    RETURN QUERY
    SELECT p_from, NULL::text, 'Opening balance'::text, NULL::numeric, NULL::numeric, v_opening
    UNION ALL
    SELECT x.date, x.entry_number, x.narration, x.debit, x.credit, x.balance FROM (
        SELECT l.date, j.entry_number::text AS entry_number, l.narration::text AS narration,
               greatest(l.amount, 0) AS debit, greatest(-l.amount, 0) AS credit,
               v_opening + sum(l.amount) OVER (ORDER BY l.date, j.entry_number, l.id) AS balance
        FROM ledger_entries l JOIN journal_entries j ON j.id = l.journal_entry_id
        WHERE l.account_id = v_account AND l.date BETWEEN p_from AND p_to
    ) x
    ORDER BY 1, 2 NULLS FIRST;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.can_view_expenses(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT is_platform_admin() OR is_committee_viewer(p_society_id) OR has_professional_permission(p_society_id, 'view_expenses')
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.payables_ageing(p_society_id UUID, p_as_of DATE DEFAULT current_date)
RETURNS TABLE (expense_id UUID, expense_number TEXT, payee TEXT, title TEXT, bill_date DATE, outstanding NUMERIC, days INT, bucket TEXT) AS $$
BEGIN
    IF NOT can_view_expenses(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s expenses';
    END IF;
    RETURN QUERY
    SELECT e.id, coalesce(e.voucher_number, e.expense_number)::text, coalesce(v.name, e.payee_name, '—')::text, e.title::text,
           coalesce(e.invoice_date, e.approved_at::date, e.created_at::date) AS d,
           (e.subtotal + e.gst_amount - e.amount_settled)::numeric,
           (p_as_of - coalesce(e.invoice_date, e.approved_at::date, e.created_at::date))::int,
           CASE
               WHEN p_as_of - coalesce(e.invoice_date, e.approved_at::date, e.created_at::date) <= 30 THEN '0-30'
               WHEN p_as_of - coalesce(e.invoice_date, e.approved_at::date, e.created_at::date) <= 60 THEN '31-60'
               WHEN p_as_of - coalesce(e.invoice_date, e.approved_at::date, e.created_at::date) <= 90 THEN '61-90'
               ELSE '90+'
           END
    FROM expenses e LEFT JOIN vendors v ON v.id = e.vendor_id
    WHERE e.society_id = p_society_id AND e.status = 'approved' AND e.subtotal + e.gst_amount - e.amount_settled > 0
    ORDER BY d;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- TDS deducted per payment (plus older bills paid in one go before vendor payments existed)
CREATE OR REPLACE FUNCTION public.tds_register(p_society_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (paid_on DATE, reference TEXT, expense_number TEXT, vendor TEXT, pan TEXT, entity TEXT,
               section TEXT, rate NUMERIC, taxable NUMERIC, amount_paid NUMERIC, tds NUMERIC) AS $$
BEGIN
    IF NOT (can_view_expenses(p_society_id) OR can_view_financials(p_society_id)) THEN
        RAISE EXCEPTION 'You do not have access to this society''s expenses';
    END IF;
    RETURN QUERY
    SELECT vp.paid_on, vp.payment_number::text, e.expense_number::text, coalesce(v.name, e.payee_name)::text,
           vendor_pan(v.pan, v.gstin), pan_entity(vendor_pan(v.pan, v.gstin)), e.tds_section::text, e.tds_rate,
           e.subtotal, vp.amount, vp.tds_amount
    FROM vendor_payments vp JOIN expenses e ON e.id = vp.expense_id LEFT JOIN vendors v ON v.id = e.vendor_id
    WHERE vp.society_id = p_society_id AND vp.status = 'recorded' AND vp.tds_amount > 0 AND vp.paid_on BETWEEN p_from AND p_to
    UNION ALL
    SELECT e.paid_date, coalesce(e.payment_reference, '—')::text, e.expense_number::text, coalesce(v.name, e.payee_name)::text,
           vendor_pan(v.pan, v.gstin), pan_entity(vendor_pan(v.pan, v.gstin)), e.tds_section::text, e.tds_rate,
           e.subtotal, e.net_payable, e.tds_amount
    FROM expenses e LEFT JOIN vendors v ON v.id = e.vendor_id
    WHERE e.society_id = p_society_id AND e.status = 'paid' AND e.tds_amount > 0 AND e.paid_date BETWEEN p_from AND p_to
      AND NOT EXISTS (SELECT 1 FROM vendor_payments vp WHERE vp.expense_id = e.id)
    ORDER BY 1, 2;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.gst_summary(p_society_id UUID, p_from DATE, p_to DATE)
RETURNS JSONB AS $$
DECLARE
    v_output NUMERIC;
    v_input NUMERIC;
    v_blocked NUMERIC;
BEGIN
    IF NOT can_view_financials(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s financial reports';
    END IF;
    SELECT -coalesce(sum(l.amount), 0) INTO v_output
    FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
    WHERE l.society_id = p_society_id AND a.code = '2100' AND l.date BETWEEN p_from AND p_to;
    SELECT coalesce(sum(l.amount), 0) INTO v_input
    FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
    WHERE l.society_id = p_society_id AND a.code = '1300' AND l.date BETWEEN p_from AND p_to;
    SELECT coalesce(sum(gst_amount), 0) INTO v_blocked FROM expenses
    WHERE society_id = p_society_id AND status IN ('approved', 'paid') AND NOT gst_claimable AND gst_amount > 0
      AND coalesce(invoice_date, approved_at::date) BETWEEN p_from AND p_to;
    RETURN jsonb_build_object('output_gst', v_output, 'input_claimed', v_input, 'input_not_claimed', v_blocked,
                              'net_payable', v_output - v_input);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 4. CA ADJUSTMENT PROPOSALS
-- ============================================================================
CREATE TABLE IF NOT EXISTS adjustment_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    proposal_number VARCHAR(32) NOT NULL,
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('journal', 'capitalise')),
    entry_date DATE NOT NULL,
    reason TEXT NOT NULL CHECK (length(trim(reason)) >= 5),
    lines JSONB NOT NULL,                       -- [{code, amount}] debit positive
    expense_id UUID REFERENCES expenses(id),    -- capitalise: the bill to move into assets
    asset_account_code VARCHAR(32),
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    proposed_by UUID NOT NULL REFERENCES profiles(id),
    proposed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    decided_by UUID REFERENCES profiles(id),
    decided_at TIMESTAMPTZ,
    decision_note TEXT,
    journal_id UUID REFERENCES journal_entries(id),
    CONSTRAINT uq_society_proposal_number UNIQUE (society_id, proposal_number)
);
CREATE INDEX IF NOT EXISTS idx_adjustment_proposals_society ON adjustment_proposals (society_id, status);

ALTER TABLE adjustment_proposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS adjustment_proposals_select ON adjustment_proposals;
CREATE POLICY adjustment_proposals_select ON adjustment_proposals FOR SELECT USING (can_view_financials(society_id));

CREATE OR REPLACE FUNCTION public.can_propose_adjustment(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT is_society_admin(p_society_id)
        OR has_professional_permission(p_society_id, 'view_ledger')
        OR has_professional_permission(p_society_id, 'view_reports')
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Accounts tied to a sub-ledger (members, vendors, advances, asset register) change only
-- through their own workflows, so plain adjustments cannot touch them.
CREATE OR REPLACE FUNCTION public.adjustment_blocked_code(p_code TEXT)
RETURNS BOOLEAN AS $$
    SELECT p_code IN ('1200', '2000', '2300', '1500', '1510', '1520', '1530', '1540', '1550', '1590')
$$ LANGUAGE sql IMMUTABLE;

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
        IF adjustment_blocked_code(v_code) THEN
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

CREATE OR REPLACE FUNCTION public.check_adjustment_date(p_society_id UUID, p_date DATE)
RETURNS VOID AS $$
DECLARE
    v_lock DATE := books_locked_until(p_society_id);
BEGIN
    IF p_date IS NULL OR p_date > current_date THEN
        RAISE EXCEPTION 'Adjustment date must be today or earlier';
    END IF;
    IF v_lock IS NOT NULL AND p_date <= v_lock THEN
        RAISE EXCEPTION 'The books up to % are locked after audit', to_char(v_lock, 'DD Mon YYYY');
    END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.propose_adjustment(p_society_id UUID, p_entry_date DATE, p_reason TEXT, p_lines JSONB)
RETURNS JSONB AS $$
DECLARE
    v_lines JSONB;
    v_id UUID;
    v_number TEXT;
BEGIN
    IF NOT can_propose_adjustment(p_society_id) THEN
        RAISE EXCEPTION 'Only the committee or the society''s CA can propose adjustments';
    END IF;
    IF length(trim(coalesce(p_reason, ''))) < 5 THEN
        RAISE EXCEPTION 'Explain the adjustment (at least a few words)';
    END IF;
    PERFORM check_adjustment_date(p_society_id, p_entry_date);
    v_lines := validate_adjustment_lines(p_society_id, p_lines);

    v_number := 'AP-' || lpad(next_society_number(p_society_id, 'adjustment_proposals', 'proposal_number', 'AP-')::text, 4, '0');
    INSERT INTO adjustment_proposals (society_id, proposal_number, kind, entry_date, reason, lines, proposed_by)
    VALUES (p_society_id, v_number, 'journal', p_entry_date, trim(p_reason), v_lines, auth.uid())
    RETURNING id INTO v_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'adjustment.proposed', 'adjustment_proposal', v_id::text,
            jsonb_build_object('number', v_number, 'lines', v_lines, 'reason', trim(p_reason)));
    RETURN jsonb_build_object('id', v_id, 'proposal_number', v_number);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- "This repair should have been an asset": Dr asset / Cr the head it was booked to, and on
-- approval the bill becomes a capital purchase in the asset register.
CREATE OR REPLACE FUNCTION public.propose_capitalisation(p_expense_id UUID, p_asset_account_code TEXT, p_reason TEXT, p_entry_date DATE DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_exp expenses%ROWTYPE;
    v_amount NUMERIC;
    v_head TEXT;
    v_date DATE;
    v_id UUID;
    v_number TEXT;
    v_lines JSONB;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF NOT can_propose_adjustment(v_exp.society_id) THEN
        RAISE EXCEPTION 'Only the committee or the society''s CA can propose adjustments';
    END IF;
    IF v_exp.status NOT IN ('approved', 'paid') OR v_exp.expense_type <> 'revenue' THEN
        RAISE EXCEPTION 'Only an approved or paid regular expense can be moved to assets';
    END IF;
    IF p_asset_account_code NOT IN ('1500', '1510', '1520', '1530', '1540', '1550') THEN
        RAISE EXCEPTION 'Pick an asset type';
    END IF;
    IF length(trim(coalesce(p_reason, ''))) < 5 THEN
        RAISE EXCEPTION 'Explain the adjustment (at least a few words)';
    END IF;
    IF EXISTS (SELECT 1 FROM adjustment_proposals WHERE expense_id = p_expense_id AND status = 'pending') THEN
        RAISE EXCEPTION 'There is already a pending proposal for this expense';
    END IF;

    v_date := coalesce(p_entry_date, current_date);
    PERFORM check_adjustment_date(v_exp.society_id, v_date);
    v_amount := v_exp.subtotal + v_exp.gst_amount - CASE WHEN v_exp.gst_claimable THEN v_exp.gst_amount ELSE 0 END;
    v_head := expense_debit_code(v_exp.society_id, v_exp.category, 'revenue', NULL);
    v_lines := jsonb_build_array(
        jsonb_build_object('code', p_asset_account_code, 'amount', v_amount),
        jsonb_build_object('code', v_head, 'amount', -v_amount)
    );

    v_number := 'AP-' || lpad(next_society_number(v_exp.society_id, 'adjustment_proposals', 'proposal_number', 'AP-')::text, 4, '0');
    INSERT INTO adjustment_proposals (society_id, proposal_number, kind, entry_date, reason, lines, expense_id, asset_account_code, proposed_by)
    VALUES (v_exp.society_id, v_number, 'capitalise', v_date, trim(p_reason), v_lines, v_exp.id, p_asset_account_code, auth.uid())
    RETURNING id INTO v_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_exp.society_id, auth.uid(), 'adjustment.proposed', 'adjustment_proposal', v_id::text,
            jsonb_build_object('number', v_number, 'capitalise', v_exp.expense_number, 'amount', v_amount));
    RETURN jsonb_build_object('id', v_id, 'proposal_number', v_number, 'amount', v_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.decide_adjustment(p_proposal_id UUID, p_approve BOOLEAN, p_note TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_p adjustment_proposals%ROWTYPE;
    v_exp expenses%ROWTYPE;
    v_journal UUID;
    v_who TEXT;
BEGIN
    SELECT * INTO v_p FROM adjustment_proposals WHERE id = p_proposal_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Proposal not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_p.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can approve adjustments';
    END IF;
    IF v_p.status <> 'pending' THEN
        RAISE EXCEPTION 'This proposal is already %', v_p.status;
    END IF;
    IF v_p.proposed_by = auth.uid() THEN
        RAISE EXCEPTION 'You proposed this adjustment; another committee member must decide';
    END IF;
    IF NOT p_approve AND length(trim(coalesce(p_note, ''))) = 0 THEN
        RAISE EXCEPTION 'Give a reason for rejecting';
    END IF;

    IF p_approve THEN
        IF v_p.kind = 'capitalise' THEN
            SELECT * INTO v_exp FROM expenses WHERE id = v_p.expense_id FOR UPDATE;
            IF v_exp.status NOT IN ('approved', 'paid') OR v_exp.expense_type <> 'revenue' THEN
                RAISE EXCEPTION 'The expense has changed since this proposal (now %) — ask for a new proposal', v_exp.status;
            END IF;
        END IF;
        SELECT full_name INTO v_who FROM profiles WHERE id = v_p.proposed_by;
        v_journal := post_journal(v_p.society_id, v_p.entry_date, 'adjustment.approved', v_p.id,
                                  v_p.proposal_number || ' (' || coalesce(v_who, 'CA') || '): ' || v_p.reason, v_p.lines);
        IF v_p.kind = 'capitalise' THEN
            PERFORM set_config('sahvaas.expense_workflow', 'on', true);
            UPDATE expenses SET expense_type = 'capital', asset_account_code = v_p.asset_account_code,
                                updated_at = timezone('utc'::text, now())
            WHERE id = v_exp.id;
            PERFORM set_config('sahvaas.expense_workflow', 'off', true);
            PERFORM create_asset_for_expense(v_exp.id);
        END IF;
    END IF;

    UPDATE adjustment_proposals
    SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
        decided_by = auth.uid(), decided_at = timezone('utc'::text, now()),
        decision_note = nullif(trim(coalesce(p_note, '')), ''), journal_id = v_journal
    WHERE id = p_proposal_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value, reason)
    VALUES (v_p.society_id, auth.uid(), CASE WHEN p_approve THEN 'adjustment.approved' ELSE 'adjustment.rejected' END,
            'adjustment_proposal', p_proposal_id::text, jsonb_build_object('number', v_p.proposal_number, 'journal', v_journal),
            nullif(trim(coalesce(p_note, '')), ''));
    RETURN jsonb_build_object('status', CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, 'journal_id', v_journal);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.withdraw_adjustment(p_proposal_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_p adjustment_proposals%ROWTYPE;
BEGIN
    SELECT * INTO v_p FROM adjustment_proposals WHERE id = p_proposal_id FOR UPDATE;
    IF NOT FOUND OR v_p.proposed_by <> auth.uid() THEN
        RAISE EXCEPTION 'Proposal not found';
    END IF;
    IF v_p.status <> 'pending' THEN
        RAISE EXCEPTION 'This proposal is already %', v_p.status;
    END IF;
    UPDATE adjustment_proposals SET status = 'withdrawn', decided_at = timezone('utc'::text, now()) WHERE id = p_proposal_id;
    RETURN jsonb_build_object('status', 'withdrawn');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.lock_financial_year(p_society_id UUID, p_fy_end DATE, p_note TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_pending INT;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can lock a financial year';
    END IF;
    IF p_fy_end IS NULL OR extract(month FROM p_fy_end) <> 3 OR extract(day FROM p_fy_end) <> 31 OR p_fy_end >= current_date THEN
        RAISE EXCEPTION 'Only a financial year that has ended (31 March) can be locked';
    END IF;
    IF EXISTS (SELECT 1 FROM financial_year_locks WHERE society_id = p_society_id AND fy_end >= p_fy_end) THEN
        RAISE EXCEPTION 'This year is already locked';
    END IF;
    SELECT count(*) INTO v_pending FROM adjustment_proposals
    WHERE society_id = p_society_id AND status = 'pending' AND entry_date <= p_fy_end;
    IF v_pending > 0 THEN
        RAISE EXCEPTION 'Decide the % pending adjustment(s) for this year first', v_pending;
    END IF;

    INSERT INTO financial_year_locks (society_id, fy_end, locked_by, note)
    VALUES (p_society_id, p_fy_end, auth.uid(), nullif(trim(coalesce(p_note, '')), ''));
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'books.year_locked', 'society', p_society_id::text,
            jsonb_build_object('fy_end', p_fy_end, 'note', p_note));
    RETURN jsonb_build_object('locked_until', p_fy_end);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Unlocking an audited year is a support action for the platform owner only
CREATE OR REPLACE FUNCTION public.unlock_financial_year(p_society_id UUID, p_fy_end DATE, p_reason TEXT)
RETURNS JSONB AS $$
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Only Sahvaas support can unlock an audited year';
    END IF;
    IF length(trim(coalesce(p_reason, ''))) = 0 THEN
        RAISE EXCEPTION 'A reason is required';
    END IF;
    DELETE FROM financial_year_locks WHERE society_id = p_society_id AND fy_end >= p_fy_end;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value, reason)
    VALUES (p_society_id, auth.uid(), 'books.year_unlocked', 'society', p_society_id::text,
            jsonb_build_object('fy_end', p_fy_end), trim(p_reason));
    RETURN jsonb_build_object('unlocked_from', p_fy_end);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.books_locked_until(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.trg_journal_respect_lock() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_ledger_entry_date() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_adjustment_lines(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_adjustment_date(UUID, DATE) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.save_prior_year_balances(UUID, DATE, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.income_expenditure_compare(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.balance_sheet_compare(UUID, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.receipts_payments(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.account_ledger(UUID, TEXT, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_view_expenses(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.payables_ageing(UUID, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tds_register(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gst_summary(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_propose_adjustment(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.propose_adjustment(UUID, DATE, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.propose_capitalisation(UUID, TEXT, TEXT, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decide_adjustment(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.withdraw_adjustment(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lock_financial_year(UUID, DATE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unlock_financial_year(UUID, DATE, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.books_locked_until(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_prior_year_balances(UUID, DATE, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.income_expenditure_compare(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.balance_sheet_compare(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receipts_payments(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.account_ledger(UUID, TEXT, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_view_expenses(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payables_ageing(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tds_register(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gst_summary(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_propose_adjustment(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.propose_adjustment(UUID, DATE, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.propose_capitalisation(UUID, TEXT, TEXT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_adjustment(UUID, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_adjustment(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lock_financial_year(UUID, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_financial_year(UUID, DATE, TEXT) TO authenticated;
