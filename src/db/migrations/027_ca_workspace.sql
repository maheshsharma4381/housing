-- ============================================================================
-- 027 THE CA WORKSPACE (Phase 2D)
--   A society without a CA can make a committee member its Accountant, with the
--   CA's manage_accounts powers. The CA / Accountant keeps the asset register and
--   matches bank lines; verifying payments stays with the committee. Locking a
--   year is proposed and approved by another committee member.
-- ============================================================================

-- ============================================================================
-- 1. THE ACCOUNTANT SWITCH
-- ============================================================================
ALTER TABLE society_memberships ADD COLUMN IF NOT EXISTS is_accountant BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE society_memberships DROP CONSTRAINT IF EXISTS chk_accountant_is_committee;
ALTER TABLE society_memberships ADD CONSTRAINT chk_accountant_is_committee
    CHECK (NOT is_accountant OR role IN ('society_admin', 'secretary', 'chairman', 'treasurer', 'committee_member'));

-- from 019_account_groups.sql; + an active membership with the Accountant switch on
CREATE OR REPLACE FUNCTION public.can_manage_accounts(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT is_platform_admin() OR has_professional_permission(p_society_id, 'manage_accounts')
        OR EXISTS (
            SELECT 1 FROM society_memberships m
            JOIN societies s ON s.id = m.society_id AND s.is_active = true
            WHERE m.society_id = p_society_id AND m.user_id = auth.uid() AND m.is_active = true AND m.is_accountant
        )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- from 014_ca_workspace.sql; + the Accountant
CREATE OR REPLACE FUNCTION public.can_propose_adjustment(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT is_society_admin(p_society_id)
        OR has_professional_permission(p_society_id, 'view_ledger')
        OR has_professional_permission(p_society_id, 'view_reports')
        OR can_manage_accounts(p_society_id)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.set_accountant(p_society_id UUID, p_user_id UUID, p_on BOOLEAN)
RETURNS JSONB AS $$
DECLARE
    v_id UUID;
    v_on BOOLEAN := coalesce(p_on, false);
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can choose the accountant';
    END IF;
    SELECT id INTO v_id FROM society_memberships
    WHERE society_id = p_society_id AND user_id = p_user_id AND is_active = true
      AND role IN ('society_admin', 'secretary', 'chairman', 'treasurer', 'committee_member')
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE;
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'Only an active committee member can be the society''s accountant';
    END IF;

    IF v_on THEN
        UPDATE society_memberships SET is_accountant = true, updated_at = timezone('utc'::text, now()) WHERE id = v_id;
    ELSE
        UPDATE society_memberships SET is_accountant = false, updated_at = timezone('utc'::text, now())
        WHERE society_id = p_society_id AND user_id = p_user_id AND is_accountant;
    END IF;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), CASE WHEN v_on THEN 'member.accountant_on' ELSE 'member.accountant_off' END,
            'society_membership', v_id::text, jsonb_build_object('user_id', p_user_id));
    RETURN jsonb_build_object('user_id', p_user_id, 'is_accountant', v_on);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 2. THE CA / ACCOUNTANT KEEPS THE ASSET REGISTER AND MATCHES BANK LINES
--    The committee keeps these powers too; verifying payments stays committee-only
--    (verify_matched_payments, and verify_payment inside record_bank_receipt).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.can_keep_books(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT is_platform_admin() OR is_society_admin(p_society_id) OR can_manage_accounts(p_society_id)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- from 013_accounting.sql; + the CA / Accountant (can_keep_books)
CREATE OR REPLACE FUNCTION public.add_existing_asset(
    p_society_id UUID,
    p_name TEXT,
    p_account_code TEXT,
    p_put_to_use DATE,
    p_cost NUMERIC,
    p_wdv NUMERIC,
    p_as_of DATE,
    p_rate NUMERIC DEFAULT NULL,
    p_location TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
BEGIN
    IF NOT can_keep_books(p_society_id) THEN
        RAISE EXCEPTION 'Only the society committee can add assets';
    END IF;
    IF length(trim(coalesce(p_name, ''))) < 2 THEN
        RAISE EXCEPTION 'Enter the asset name';
    END IF;
    IF p_account_code NOT IN ('1500', '1510', '1520', '1530', '1540', '1550') THEN
        RAISE EXCEPTION 'Pick an asset type';
    END IF;
    IF coalesce(p_wdv, -1) < 0 OR coalesce(p_cost, -1) < p_wdv THEN
        RAISE EXCEPTION 'Written-down value must be between 0 and the original cost';
    END IF;
    IF p_put_to_use IS NULL OR p_as_of IS NULL OR p_put_to_use > p_as_of THEN
        RAISE EXCEPTION 'Purchase date must be on or before the opening date';
    END IF;

    INSERT INTO fixed_assets (society_id, asset_number, name, account_code, put_to_use_date, cost, opening_wdv, opening_as_of,
                              location, dep_rate, created_by)
    VALUES (p_society_id,
            'FA-' || lpad(next_society_number(p_society_id, 'fixed_assets', 'asset_number', 'FA-')::text, 4, '0'),
            trim(p_name), p_account_code, p_put_to_use, round(p_cost, 2), round(p_wdv, 2), p_as_of,
            nullif(trim(coalesce(p_location, '')), ''), coalesce(p_rate, default_dep_rate(p_account_code)), auth.uid())
    RETURNING id INTO v_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'asset.added_existing', 'fixed_asset', v_id::text,
            jsonb_build_object('name', trim(p_name), 'cost', p_cost, 'wdv', p_wdv, 'as_of', p_as_of));
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 013_accounting.sql; + the CA / Accountant (can_keep_books)
CREATE OR REPLACE FUNCTION public.update_asset(
    p_asset_id UUID, p_name TEXT, p_location TEXT, p_dep_rate NUMERIC, p_dep_method TEXT, p_reason TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_asset fixed_assets%ROWTYPE;
BEGIN
    SELECT * INTO v_asset FROM fixed_assets WHERE id = p_asset_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Asset not found';
    END IF;
    IF NOT can_keep_books(v_asset.society_id) THEN
        RAISE EXCEPTION 'Only the society committee can change assets';
    END IF;
    IF v_asset.status <> 'active' THEN
        RAISE EXCEPTION 'Asset % is %', v_asset.asset_number, v_asset.status;
    END IF;
    IF p_dep_rate IS NULL OR p_dep_rate < 0 OR p_dep_rate > 100 THEN
        RAISE EXCEPTION 'Depreciation rate must be between 0 and 100';
    END IF;
    IF coalesce(p_dep_method, '') NOT IN ('wdv', 'slm') THEN
        RAISE EXCEPTION 'Method must be WDV or SLM';
    END IF;
    IF (p_dep_rate <> v_asset.dep_rate OR p_dep_method <> v_asset.dep_method) AND length(trim(coalesce(p_reason, ''))) = 0 THEN
        RAISE EXCEPTION 'Give a reason for changing the depreciation rate or method';
    END IF;

    UPDATE fixed_assets
    SET name = coalesce(nullif(trim(coalesce(p_name, '')), ''), name),
        location = nullif(trim(coalesce(p_location, '')), ''),
        dep_rate = p_dep_rate, dep_method = p_dep_method,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_asset_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, new_value, reason)
    VALUES (v_asset.society_id, auth.uid(), 'asset.updated', 'fixed_asset', p_asset_id::text,
            jsonb_build_object('rate', v_asset.dep_rate, 'method', v_asset.dep_method, 'name', v_asset.name),
            jsonb_build_object('rate', p_dep_rate, 'method', p_dep_method, 'name', p_name), nullif(trim(coalesce(p_reason, '')), ''));
    RETURN jsonb_build_object('status', 'updated');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 013_accounting.sql; + the CA / Accountant can read it
CREATE OR REPLACE FUNCTION public.preview_depreciation(p_society_id UUID, p_fy_end DATE)
RETURNS TABLE (
    asset_id UUID, asset_number TEXT, name TEXT, account_code TEXT, put_to_use_date DATE,
    opening_wdv NUMERIC, additions NUMERIC, rate NUMERIC, half_rate BOOLEAN, depreciation NUMERIC, closing_wdv NUMERIC
) AS $$
DECLARE
    v_start DATE;
BEGIN
    IF NOT (is_platform_admin() OR can_view_financials(p_society_id) OR has_professional_permission(p_society_id, 'view_expenses')
             OR can_manage_accounts(p_society_id)) THEN
        RAISE EXCEPTION 'You do not have access to this society''s assets';
    END IF;
    IF p_fy_end IS NULL OR extract(month FROM p_fy_end) <> 3 OR extract(day FROM p_fy_end) <> 31 THEN
        RAISE EXCEPTION 'A financial year ends on 31 March';
    END IF;
    v_start := (p_fy_end - interval '1 year' + interval '1 day')::date;

    RETURN QUERY
    WITH acc AS (
        SELECT l.asset_id AS id, sum(l.amount) AS dep
        FROM depreciation_lines l JOIN depreciation_runs r ON r.id = l.run_id
        WHERE r.society_id = p_society_id AND r.fy_end < v_start
        GROUP BY l.asset_id
    ), base AS (
        SELECT a.*, coalesce(acc.dep, 0) AS acc_dep,
               (a.opening_as_of IS NULL AND a.put_to_use_date >= v_start) AS is_addition
        FROM fixed_assets a LEFT JOIN acc ON acc.id = a.id
        WHERE a.society_id = p_society_id AND a.status = 'active' AND a.put_to_use_date <= p_fy_end
    ), calc AS (
        SELECT b.*,
               CASE WHEN b.is_addition THEN 0 ELSE greatest(coalesce(b.opening_wdv, b.cost) - b.acc_dep, 0) END AS wdv_open,
               CASE WHEN b.is_addition THEN b.cost ELSE 0 END AS adds,
               (b.is_addition AND (p_fy_end - b.put_to_use_date + 1) < 180) AS half
        FROM base b
    ), dep AS (
        SELECT c.*,
               least(c.wdv_open + c.adds,
                     round(CASE WHEN c.dep_method = 'slm' THEN coalesce(c.opening_wdv, c.cost) ELSE c.wdv_open + c.adds END
                           * c.dep_rate / 100 * CASE WHEN c.half THEN 0.5 ELSE 1 END, 0)) AS amount
        FROM calc c
    )
    SELECT d.id, d.asset_number::text, d.name::text, d.account_code::text, d.put_to_use_date,
           d.wdv_open, d.adds, d.dep_rate, d.half, d.amount, d.wdv_open + d.adds - d.amount
    FROM dep d
    ORDER BY d.asset_number;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- from 013_accounting.sql; + the CA / Accountant (can_keep_books)
CREATE OR REPLACE FUNCTION public.post_depreciation(p_society_id UUID, p_fy_end DATE)
RETURNS JSONB AS $$
DECLARE
    v_run UUID;
    v_total NUMERIC;
    v_count INT;
BEGIN
    IF NOT can_keep_books(p_society_id) THEN
        RAISE EXCEPTION 'Only the society committee can post depreciation';
    END IF;
    IF p_fy_end IS NULL OR extract(month FROM p_fy_end) <> 3 OR extract(day FROM p_fy_end) <> 31 THEN
        RAISE EXCEPTION 'A financial year ends on 31 March';
    END IF;
    IF current_date < p_fy_end - 30 THEN
        RAISE EXCEPTION 'Depreciation for the year ending % can be posted from %', to_char(p_fy_end, 'DD Mon YYYY'),
            to_char(p_fy_end - 30, 'DD Mon YYYY');
    END IF;
    IF EXISTS (SELECT 1 FROM depreciation_runs WHERE society_id = p_society_id AND fy_end = p_fy_end) THEN
        RAISE EXCEPTION 'Depreciation for the year ending % is already posted', to_char(p_fy_end, 'DD Mon YYYY');
    END IF;

    SELECT coalesce(sum(depreciation), 0), count(*) FILTER (WHERE depreciation > 0) INTO v_total, v_count
    FROM preview_depreciation(p_society_id, p_fy_end);
    IF v_total <= 0 THEN
        RAISE EXCEPTION 'Nothing to depreciate for this year';
    END IF;

    INSERT INTO depreciation_runs (society_id, fy_start, fy_end, total, posted_by)
    VALUES (p_society_id, (p_fy_end - interval '1 year' + interval '1 day')::date, p_fy_end, v_total, auth.uid())
    RETURNING id INTO v_run;

    INSERT INTO depreciation_lines (run_id, society_id, asset_id, opening_wdv, additions, rate, half_rate, amount, closing_wdv)
    SELECT v_run, p_society_id, p.asset_id, p.opening_wdv, p.additions, p.rate, p.half_rate, p.depreciation, p.closing_wdv
    FROM preview_depreciation(p_society_id, p_fy_end) p
    WHERE p.depreciation > 0;

    PERFORM post_journal(p_society_id, p_fy_end, 'depreciation.run', v_run,
                         'Depreciation for FY ' || extract(year FROM p_fy_end - interval '1 year') || '-' || to_char(p_fy_end, 'YY'),
                         jsonb_build_array(
                             jsonb_build_object('code', '5800', 'amount', v_total),
                             jsonb_build_object('code', '1590', 'amount', -v_total)
                         ));

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'depreciation.posted', 'depreciation_run', v_run::text,
            jsonb_build_object('fy_end', p_fy_end, 'total', v_total, 'assets', v_count));
    RETURN jsonb_build_object('run_id', v_run, 'total', v_total, 'assets', v_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 013_accounting.sql; + the CA / Accountant (can_keep_books)
CREATE OR REPLACE FUNCTION public.dispose_asset(
    p_asset_id UUID, p_disposed_on DATE, p_sale_amount NUMERIC DEFAULT 0, p_mode TEXT DEFAULT 'bank', p_reason TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_asset fixed_assets%ROWTYPE;
    v_sale NUMERIC := round(coalesce(p_sale_amount, 0), 2);
    v_carrying NUMERIC;
    v_acc NUMERIC;
    v_gain NUMERIC;
BEGIN
    SELECT * INTO v_asset FROM fixed_assets WHERE id = p_asset_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Asset not found';
    END IF;
    IF NOT can_keep_books(v_asset.society_id) THEN
        RAISE EXCEPTION 'Only the society committee can dispose of assets';
    END IF;
    IF v_asset.status <> 'active' THEN
        RAISE EXCEPTION 'Asset % is %', v_asset.asset_number, v_asset.status;
    END IF;
    IF p_disposed_on IS NULL OR p_disposed_on > current_date OR p_disposed_on < v_asset.put_to_use_date THEN
        RAISE EXCEPTION 'Disposal date must be between the purchase date and today';
    END IF;
    IF v_sale < 0 THEN
        RAISE EXCEPTION 'Sale amount cannot be negative';
    END IF;
    IF coalesce(p_mode, '') NOT IN ('bank', 'cash') THEN
        RAISE EXCEPTION 'Money received must be bank or cash';
    END IF;
    IF length(trim(coalesce(p_reason, ''))) = 0 THEN
        RAISE EXCEPTION 'Give a reason (e.g. sold as scrap)';
    END IF;

    -- The asset account holds the cost (bought here) or the opening WDV (brought in)
    v_carrying := coalesce(v_asset.opening_wdv, v_asset.cost);
    SELECT coalesce(sum(amount), 0) INTO v_acc FROM depreciation_lines WHERE asset_id = p_asset_id;
    v_gain := v_sale - (v_carrying - v_acc);

    PERFORM post_journal(v_asset.society_id, p_disposed_on, 'asset.disposed', v_asset.id,
                         'Asset ' || v_asset.asset_number || ' ' || v_asset.name || ' disposed: ' || trim(p_reason),
                         jsonb_build_array(
                             jsonb_build_object('code', CASE WHEN p_mode = 'cash' THEN '1100' ELSE '1000' END, 'amount', v_sale),
                             jsonb_build_object('code', '1590', 'amount', v_acc),
                             jsonb_build_object('code', v_asset.account_code, 'amount', -v_carrying),
                             jsonb_build_object('code', '4300', 'amount', -v_gain)
                         ));

    UPDATE fixed_assets
    SET status = 'disposed', disposed_on = p_disposed_on, disposal_amount = v_sale, updated_at = timezone('utc'::text, now())
    WHERE id = p_asset_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value, reason)
    VALUES (v_asset.society_id, auth.uid(), 'asset.disposed', 'fixed_asset', p_asset_id::text,
            jsonb_build_object('sale', v_sale, 'book_value', v_carrying - v_acc, 'gain', v_gain), trim(p_reason));
    RETURN jsonb_build_object('book_value', v_carrying - v_acc, 'gain', v_gain);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 017_bank_reconciliation.sql; + the CA / Accountant (can_keep_books)
CREATE OR REPLACE FUNCTION public.import_bank_statement(p_bank_account_id UUID, p_file_name TEXT, p_format TEXT, p_rows JSONB)
RETURNS JSONB AS $$
DECLARE
    v_acc bank_accounts%ROWTYPE;
    v_import UUID;
    v_row JSONB;
    v_date DATE;
    v_debit NUMERIC;
    v_credit NUMERIC;
    v_desc TEXT;
    v_ref TEXT;
    v_balance NUMERIC;
    v_key TEXT;
    v_seen JSONB := '{}'::jsonb;
    v_occ INT;
    v_total INT := 0;
    v_new INT := 0;
    v_from DATE;
    v_to DATE;
    v_last_balance NUMERIC;
    v_match JSONB;
BEGIN
    SELECT * INTO v_acc FROM bank_accounts WHERE id = p_bank_account_id;
    IF NOT FOUND OR NOT can_keep_books(v_acc.society_id) THEN
        RAISE EXCEPTION 'Bank account not found';
    END IF;
    PERFORM require_feature(v_acc.society_id, 'bank_match', 'Bank statement match');
    IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
        RAISE EXCEPTION 'The statement has no transactions';
    END IF;
    IF jsonb_array_length(p_rows) > 5000 THEN
        RAISE EXCEPTION 'Upload at most 5,000 lines at a time (split the statement by month)';
    END IF;

    INSERT INTO bank_statement_imports (society_id, bank_account_id, file_name, bank_format, uploaded_by)
    VALUES (v_acc.society_id, v_acc.id, left(p_file_name, 191), left(p_format, 32), auth.uid())
    RETURNING id INTO v_import;

    FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
        v_date := (v_row ->> 'date')::date;
        v_debit := round(coalesce((v_row ->> 'debit')::numeric, 0), 2);
        v_credit := round(coalesce((v_row ->> 'credit')::numeric, 0), 2);
        v_desc := left(trim(coalesce(v_row ->> 'description', '')), 500);
        v_ref := nullif(left(trim(coalesce(v_row ->> 'reference', '')), 128), '');
        v_balance := (v_row ->> 'balance')::numeric;
        IF v_date IS NULL OR (v_debit = 0) = (v_credit = 0) OR v_debit < 0 OR v_credit < 0 THEN
            RAISE EXCEPTION 'Line % needs a date and exactly one of debit or credit', v_total + 1;
        END IF;
        v_total := v_total + 1;
        v_from := least(coalesce(v_from, v_date), v_date);
        v_to := greatest(coalesce(v_to, v_date), v_date);
        IF v_balance IS NOT NULL AND v_date >= v_to THEN
            v_last_balance := v_balance;
        END IF;

        -- Same line in a re-uploaded file gets the same hash; identical lines on a day are told apart by order
        v_key := concat_ws('|', v_date, CASE WHEN v_debit > 0 THEN 'D' ELSE 'C' END, greatest(v_debit, v_credit), lower(v_desc), coalesce(v_ref, ''), coalesce(v_balance::text, ''));
        v_occ := coalesce((v_seen ->> v_key)::int, 0) + 1;
        v_seen := v_seen || jsonb_build_object(v_key, v_occ);

        INSERT INTO bank_transactions (society_id, bank_account_id, transaction_date, value_date, description, reference_number,
                                       type, amount, running_balance, import_id, line_hash, line_no)
        VALUES (v_acc.society_id, v_acc.id, v_date, coalesce((v_row ->> 'value_date')::date, v_date), v_desc, v_ref,
                CASE WHEN v_debit > 0 THEN 'debit' ELSE 'credit' END, greatest(v_debit, v_credit), v_balance, v_import,
                sha256_hex(v_acc.id::text || '|' || v_key || '|' || v_occ), v_total)
        ON CONFLICT (bank_account_id, line_hash) WHERE line_hash IS NOT NULL DO NOTHING;
        IF FOUND THEN
            v_new := v_new + 1;
        END IF;
    END LOOP;

    IF v_last_balance IS NOT NULL THEN
        UPDATE bank_accounts SET current_balance = v_last_balance WHERE id = v_acc.id;
    END IF;
    v_match := match_bank_lines(v_acc.society_id);

    UPDATE bank_statement_imports
    SET period_from = v_from, period_to = v_to, rows_total = v_total, rows_new = v_new, rows_duplicate = v_total - v_new,
        matched = (v_match ->> 'matched')::int, suggested = (v_match ->> 'suggested')::int
    WHERE id = v_import;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_acc.society_id, auth.uid(), 'bank.statement_imported', 'bank_statement_import', v_import::text,
            jsonb_build_object('file', p_file_name, 'lines', v_total, 'new', v_new, 'matched', v_match ->> 'matched'));
    RETURN jsonb_build_object('import_id', v_import, 'rows', v_total, 'new', v_new, 'duplicates', v_total - v_new,
                              'matched', (v_match ->> 'matched')::int, 'suggested', (v_match ->> 'suggested')::int,
                              'from', v_from, 'to', v_to);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 017_bank_reconciliation.sql; + the CA / Accountant (can_keep_books): link, confirm, ignore and unlink
CREATE OR REPLACE FUNCTION public.bank_line_for_update(p_line_id UUID)
RETURNS bank_transactions AS $$
DECLARE
    v_line bank_transactions%ROWTYPE;
BEGIN
    SELECT * INTO v_line FROM bank_transactions WHERE id = p_line_id FOR UPDATE;
    IF NOT FOUND OR NOT can_keep_books(v_line.society_id) THEN
        RAISE EXCEPTION 'Statement line not found';
    END IF;
    RETURN v_line;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 023_bank_statement_ledgers.sql; + the CA / Accountant can read it
CREATE OR REPLACE FUNCTION public.bank_reconciliation_summary(p_bank_account_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_acc bank_accounts%ROWTYPE;
    v_book NUMERIC;
    v_statement NUMERIC;
    v_statement_date DATE;
BEGIN
    SELECT * INTO v_acc FROM bank_accounts WHERE id = p_bank_account_id;
    IF NOT FOUND OR NOT (is_platform_admin() OR is_committee_viewer(v_acc.society_id)
                         OR has_professional_permission(v_acc.society_id, 'view_bank_reconciliation')
                         OR can_manage_accounts(v_acc.society_id)) THEN
        RAISE EXCEPTION 'Bank account not found';
    END IF;
    SELECT running_balance, transaction_date INTO v_statement, v_statement_date FROM bank_transactions
    WHERE bank_account_id = p_bank_account_id AND running_balance IS NOT NULL
    ORDER BY transaction_date DESC, created_at DESC, line_no DESC NULLS LAST LIMIT 1;
    SELECT coalesce(sum(l.amount), 0) INTO v_book FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
    WHERE l.society_id = v_acc.society_id AND a.id = v_acc.ledger_id AND (v_statement_date IS NULL OR l.date <= v_statement_date);

    RETURN (SELECT jsonb_build_object(
        'statement_balance', v_statement, 'statement_date', v_statement_date, 'book_balance', v_book,
        'lines', count(*),
        'matched', count(*) FILTER (WHERE match_kind IN ('payment', 'vendor_payment', 'tds_challan')),
        'ignored', count(*) FILTER (WHERE match_kind = 'ignored'),
        'suggested', count(*) FILTER (WHERE match_kind IS NULL AND suggested_id IS NOT NULL),
        'open_credits', count(*) FILTER (WHERE match_kind IS NULL AND type = 'credit'),
        'open_credit_total', coalesce(sum(amount) FILTER (WHERE match_kind IS NULL AND type = 'credit'), 0),
        'open_debits', count(*) FILTER (WHERE match_kind IS NULL AND type = 'debit'),
        'open_debit_total', coalesce(sum(amount) FILTER (WHERE match_kind IS NULL AND type = 'debit'), 0),
        'ready_to_verify', (SELECT count(*) FROM bank_transactions b JOIN payments p ON p.id = b.reconciled_payment_id
                            WHERE b.bank_account_id = p_bank_account_id AND p.status = 'pending_verification')
    ) FROM bank_transactions WHERE bank_account_id = p_bank_account_id);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- The CA / Accountant reads and keeps the bank accounts and statements
DROP POLICY IF EXISTS bank_accounts_select ON bank_accounts;
CREATE POLICY bank_accounts_select ON bank_accounts
    FOR SELECT USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR has_professional_permission(society_id, 'view_bank_reconciliation')
        OR can_manage_accounts(society_id)
    );
DROP POLICY IF EXISTS bank_accounts_admin_write ON bank_accounts;
CREATE POLICY bank_accounts_admin_write ON bank_accounts
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id) OR can_manage_accounts(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id) OR can_manage_accounts(society_id));
DROP POLICY IF EXISTS bank_statement_imports_select ON bank_statement_imports;
CREATE POLICY bank_statement_imports_select ON bank_statement_imports FOR SELECT USING (
    is_platform_admin() OR is_committee_viewer(society_id) OR has_professional_permission(society_id, 'view_bank_reconciliation')
    OR can_manage_accounts(society_id));
DROP POLICY IF EXISTS bank_transactions_select ON bank_transactions;
CREATE POLICY bank_transactions_select ON bank_transactions FOR SELECT USING (
    is_platform_admin() OR is_committee_viewer(society_id) OR has_professional_permission(society_id, 'view_bank_reconciliation')
    OR can_manage_accounts(society_id));

-- ============================================================================
-- 3. A YEAR LOCK IS PROPOSED; ANOTHER COMMITTEE MEMBER APPROVES IT (in Approvals)
-- ============================================================================
ALTER TABLE adjustment_proposals DROP CONSTRAINT IF EXISTS adjustment_proposals_kind_check;
ALTER TABLE adjustment_proposals ADD CONSTRAINT adjustment_proposals_kind_check
    CHECK (kind IN ('journal', 'capitalise', 'year_lock'));

-- from 014_ca_workspace.sql; now proposes the lock (same checks, same signature); decide_adjustment locks
CREATE OR REPLACE FUNCTION public.lock_financial_year(p_society_id UUID, p_fy_end DATE, p_note TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_pending INT;
    v_id UUID;
    v_number TEXT;
    v_reason TEXT;
BEGIN
    IF NOT can_keep_books(p_society_id) THEN
        RAISE EXCEPTION 'Only the committee or the society''s CA can propose a year lock';
    END IF;
    IF p_fy_end IS NULL OR extract(month FROM p_fy_end) <> 3 OR extract(day FROM p_fy_end) <> 31 OR p_fy_end >= current_date THEN
        RAISE EXCEPTION 'Only a financial year that has ended (31 March) can be locked';
    END IF;
    IF EXISTS (SELECT 1 FROM financial_year_locks WHERE society_id = p_society_id AND fy_end >= p_fy_end) THEN
        RAISE EXCEPTION 'This year is already locked';
    END IF;
    SELECT count(*) INTO v_pending FROM adjustment_proposals
    WHERE society_id = p_society_id AND status = 'pending' AND kind <> 'year_lock' AND entry_date <= p_fy_end;
    IF v_pending > 0 THEN
        RAISE EXCEPTION 'Decide the % pending adjustment(s) for this year first', v_pending;
    END IF;
    IF EXISTS (SELECT 1 FROM opening_balances WHERE society_id = p_society_id AND status = 'submitted' AND audited_as_of <= p_fy_end) THEN
        RAISE EXCEPTION 'Approve or send back the submitted opening balance first';
    END IF;
    IF EXISTS (SELECT 1 FROM adjustment_proposals
               WHERE society_id = p_society_id AND status = 'pending' AND kind = 'year_lock' AND entry_date = p_fy_end) THEN
        RAISE EXCEPTION 'A lock for this year is already waiting for the committee';
    END IF;

    v_reason := CASE WHEN length(trim(coalesce(p_note, ''))) >= 5 THEN trim(p_note)
                     ELSE 'Lock the books up to ' || to_char(p_fy_end, 'DD Mon YYYY') END;
    v_number := 'AP-' || lpad(next_society_number(p_society_id, 'adjustment_proposals', 'proposal_number', 'AP-')::text, 4, '0');
    INSERT INTO adjustment_proposals (society_id, proposal_number, kind, entry_date, reason, lines, proposed_by)
    VALUES (p_society_id, v_number, 'year_lock', p_fy_end, v_reason, '[]'::jsonb, auth.uid())
    RETURNING id INTO v_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'books.year_lock_proposed', 'adjustment_proposal', v_id::text,
            jsonb_build_object('number', v_number, 'fy_end', p_fy_end, 'note', p_note));
    RETURN jsonb_build_object('id', v_id, 'proposal_number', v_number, 'status', 'pending');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 014_ca_workspace.sql; + a year_lock proposal locks the books instead of posting a journal
CREATE OR REPLACE FUNCTION public.decide_adjustment(p_proposal_id UUID, p_approve BOOLEAN, p_note TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_p adjustment_proposals%ROWTYPE;
    v_exp expenses%ROWTYPE;
    v_journal UUID;
    v_who TEXT;
    v_pending INT;
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

    IF p_approve AND v_p.kind = 'year_lock' THEN
        -- A year lock: checked again now, then the books up to entry_date are locked; no journal
        IF EXISTS (SELECT 1 FROM financial_year_locks WHERE society_id = v_p.society_id AND fy_end >= v_p.entry_date) THEN
            RAISE EXCEPTION 'This year is already locked';
        END IF;
        SELECT count(*) INTO v_pending FROM adjustment_proposals
        WHERE society_id = v_p.society_id AND status = 'pending' AND kind <> 'year_lock' AND entry_date <= v_p.entry_date;
        IF v_pending > 0 THEN
            RAISE EXCEPTION 'Decide the % pending adjustment(s) for this year first', v_pending;
        END IF;
        IF EXISTS (SELECT 1 FROM opening_balances WHERE society_id = v_p.society_id AND status = 'submitted' AND audited_as_of <= v_p.entry_date) THEN
            RAISE EXCEPTION 'Approve or send back the submitted opening balance first';
        END IF;
        INSERT INTO financial_year_locks (society_id, fy_end, locked_by, note)
        VALUES (v_p.society_id, v_p.entry_date, v_p.proposed_by, v_p.reason);
        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (v_p.society_id, auth.uid(), 'books.year_locked', 'society', v_p.society_id::text,
                jsonb_build_object('fy_end', v_p.entry_date, 'note', v_p.reason, 'proposal', v_p.proposal_number));
    ELSIF p_approve THEN
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

-- ============================================================================
-- 4. AFTER REVIEW
-- ============================================================================
-- An Accountant who leaves the committee (removed, or now a resident) stops being the Accountant;
-- rejoining later does not bring the role back.
CREATE OR REPLACE FUNCTION public.trg_membership_accountant()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_accountant AND (NOT NEW.is_active OR NOT OLD.is_active
        OR NEW.role NOT IN ('society_admin', 'secretary', 'chairman', 'treasurer', 'committee_member')) THEN
        NEW.is_accountant := false;
        IF auth.uid() IS NOT NULL THEN
            INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
            VALUES (NEW.society_id, auth.uid(), 'member.accountant_off', 'society_membership', NEW.id::text,
                    jsonb_build_object('user_id', NEW.user_id,
                                       'reason', CASE WHEN NOT NEW.is_active THEN 'removed from the society' ELSE 'no longer on the committee' END));
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_membership_accountant ON society_memberships;
CREATE TRIGGER trg_membership_accountant
    BEFORE UPDATE ON society_memberships
    FOR EACH ROW EXECUTE FUNCTION public.trg_membership_accountant();

-- from 017_bank_reconciliation.sql; + the CA / Accountant records a pending payment that the committee verifies
CREATE OR REPLACE FUNCTION public.record_bank_receipt(p_line_id UUID, p_unit_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_line bank_transactions;
    v_unit units%ROWTYPE;
    v_owner UUID;
    v_utr TEXT;
    v_payment UUID;
    v_result JSONB;
BEGIN
    v_line := bank_line_for_update(p_line_id);
    IF v_line.type <> 'credit' OR v_line.match_kind IS NOT NULL THEN
        RAISE EXCEPTION 'Only an unmatched credit can be recorded as a payment';
    END IF;
    SELECT * INTO v_unit FROM units WHERE id = p_unit_id AND society_id = v_line.society_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Flat not found';
    END IF;
    SELECT m.user_id INTO v_owner FROM society_memberships m
    WHERE m.society_id = v_line.society_id AND m.unit_id = p_unit_id AND m.role = 'resident_owner' AND m.is_active
    ORDER BY m.created_at LIMIT 1;
    v_owner := coalesce(v_owner, v_unit.current_owner_id);
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Flat % has no owner linked yet — invite the owner first', v_unit.unit_number;
    END IF;

    v_utr := coalesce(substring(bank_line_text(v_line) FROM '([0-9]{12})'), v_line.reference_number, 'BANK-' || left(v_line.id::text, 8));
    INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, payment_method, transaction_reference_utr,
                          payment_date, status, bank_account_id)
    VALUES (v_line.society_id, p_unit_id, v_owner, 'BNK-' || to_char(v_line.transaction_date, 'YYYYMMDD') || '-' || left(md5(v_line.id::text), 6),
            v_line.amount, CASE WHEN bank_line_text(v_line) ~ 'UPI' THEN 'upi' ELSE 'neft_rtgs' END, v_utr,
            v_line.transaction_date, 'pending_verification', v_line.bank_account_id)
    RETURNING id INTO v_payment;
    IF is_platform_admin() OR is_society_admin(v_line.society_id) THEN
        v_result := verify_payment(v_payment, true, 'Received in bank; recorded by the committee from the statement');
    ELSE
        -- The CA / Accountant points the credit at the flat; the committee verifies it in Payments
        v_result := jsonb_build_object('status', 'pending_verification');
    END IF;

    UPDATE bank_transactions
    SET match_kind = 'payment', match_method = 'recorded', is_reconciled = true, reconciled_payment_id = v_payment,
        suggested_kind = NULL, suggested_id = NULL, matched_by = auth.uid(), matched_at = timezone('utc'::text, now()),
        match_note = 'Recorded for flat ' || v_unit.unit_number
                     || CASE WHEN v_result ->> 'status' = 'pending_verification' THEN ' — waiting for the committee to verify' ELSE '' END
    WHERE id = p_line_id;
    RETURN v_result || jsonb_build_object('payment_id', v_payment);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 014_ca_workspace.sql; + the Accountant enters last year's figures too
CREATE OR REPLACE FUNCTION public.save_prior_year_balances(p_society_id UUID, p_fy_end DATE, p_lines JSONB)
RETURNS JSONB AS $$
DECLARE
    v_line JSONB;
    v_code TEXT;
    v_amount NUMERIC;
    v_count INT := 0;
    v_sum NUMERIC := 0;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id) OR has_professional_permission(p_society_id, 'view_reports')
            OR can_manage_accounts(p_society_id)) THEN
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
-- PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.trg_membership_accountant() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.can_keep_books(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_accountant(UUID, UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_accountant(UUID, UUID, BOOLEAN) TO authenticated;
