-- ============================================================================
-- 017 BANK STATEMENT MATCH (P10, Pro plan)
--   1. Statement imports (parsed CSV rows from the browser), duplicate-safe
--   2. Auto-match: credits -> resident payments by UTR; debits -> vendor payments
--      by reference, TDS challans by amount + "TDS"; otherwise a suggestion by
--      amount and date
--   3. Committee actions: verify all matched, record an unknown credit as a flat's
--      payment, link / unlink / ignore, summary
--   Statement lines change only through these functions.
-- ============================================================================

CREATE TABLE IF NOT EXISTS bank_statement_imports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    bank_account_id UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
    file_name VARCHAR(191),
    bank_format VARCHAR(32),
    period_from DATE,
    period_to DATE,
    rows_total INT NOT NULL DEFAULT 0,
    rows_new INT NOT NULL DEFAULT 0,
    rows_duplicate INT NOT NULL DEFAULT 0,
    matched INT NOT NULL DEFAULT 0,
    suggested INT NOT NULL DEFAULT 0,
    uploaded_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS import_id UUID REFERENCES bank_statement_imports(id) ON DELETE SET NULL;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS line_hash TEXT;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS line_no INT;           -- position in the (chronological) upload
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS match_kind VARCHAR(16)
    CHECK (match_kind IN ('payment', 'vendor_payment', 'tds_challan', 'ignored'));
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS match_method VARCHAR(16)
    CHECK (match_method IN ('utr', 'reference', 'amount_date', 'manual', 'recorded'));
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS reconciled_vendor_payment_id UUID REFERENCES vendor_payments(id) ON DELETE SET NULL;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS reconciled_challan_id UUID REFERENCES tds_challans(id) ON DELETE SET NULL;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS suggested_kind VARCHAR(16) CHECK (suggested_kind IN ('payment', 'vendor_payment'));
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS suggested_id UUID;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS matched_by UUID REFERENCES profiles(id);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS matched_at TIMESTAMPTZ;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS match_note TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_line_hash ON bank_transactions (bank_account_id, line_hash) WHERE line_hash IS NOT NULL;
-- One statement line per payment / vendor payment / challan
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_line_payment ON bank_transactions (reconciled_payment_id) WHERE reconciled_payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_line_vendor_payment ON bank_transactions (reconciled_vendor_payment_id) WHERE reconciled_vendor_payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_line_challan ON bank_transactions (reconciled_challan_id) WHERE reconciled_challan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_lines_open ON bank_transactions (society_id, transaction_date) WHERE match_kind IS NULL;

ALTER TABLE bank_statement_imports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_statement_imports_select ON bank_statement_imports;
CREATE POLICY bank_statement_imports_select ON bank_statement_imports FOR SELECT USING (
    is_platform_admin() OR is_committee_viewer(society_id) OR has_professional_permission(society_id, 'view_bank_reconciliation'));

DROP POLICY IF EXISTS bank_transactions_admin_write ON bank_transactions;
DROP POLICY IF EXISTS bank_transactions_select ON bank_transactions;
CREATE POLICY bank_transactions_select ON bank_transactions FOR SELECT USING (
    is_platform_admin() OR is_committee_viewer(society_id) OR has_professional_permission(society_id, 'view_bank_reconciliation'));

-- ============================================================================
-- MATCHING
-- ============================================================================
CREATE OR REPLACE FUNCTION public.bank_line_text(p_line bank_transactions)
RETURNS TEXT AS $$
    SELECT upper(coalesce(p_line.description, '') || ' ' || coalesce(p_line.reference_number, ''))
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.match_bank_lines(p_society_id UUID)
RETURNS JSONB AS $$
DECLARE
    r bank_transactions%ROWTYPE;
    v_text TEXT;
    v_id UUID;
    v_n INT;
    v_matched INT := 0;
    v_suggested INT := 0;
BEGIN
    FOR r IN SELECT * FROM bank_transactions WHERE society_id = p_society_id AND match_kind IS NULL ORDER BY transaction_date LOOP
        v_text := bank_line_text(r);
        v_id := NULL;

        IF r.type = 'credit' THEN
            -- Resident payment whose UTR appears in the narration
            SELECT p.id INTO v_id FROM payments p
            WHERE p.society_id = p_society_id AND p.status IN ('pending_verification', 'verified')
              AND abs(p.amount - r.amount) < 0.01 AND length(p.transaction_reference_utr) >= 6
              AND position(upper(p.transaction_reference_utr) IN v_text) > 0
              AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.reconciled_payment_id = p.id)
            ORDER BY p.payment_date LIMIT 1;
            IF v_id IS NOT NULL THEN
                UPDATE bank_transactions SET match_kind = 'payment', match_method = 'utr', reconciled_payment_id = v_id,
                       is_reconciled = true, matched_at = timezone('utc'::text, now()), suggested_kind = NULL, suggested_id = NULL
                WHERE id = r.id;
                v_matched := v_matched + 1;
                CONTINUE;
            END IF;
            -- Otherwise: one payment of the same amount within 3 days -> suggestion
            SELECT count(*), min(p.id::text)::uuid INTO v_n, v_id FROM payments p
            WHERE p.society_id = p_society_id AND p.status IN ('pending_verification', 'verified')
              AND abs(p.amount - r.amount) < 0.01 AND abs(p.payment_date - r.transaction_date) <= 3
              AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.reconciled_payment_id = p.id);
            IF v_n = 1 THEN
                UPDATE bank_transactions SET suggested_kind = 'payment', suggested_id = v_id WHERE id = r.id;
                v_suggested := v_suggested + 1;
            END IF;
        ELSE
            -- Vendor payment whose UTR / cheque reference appears in the narration
            SELECT vp.id INTO v_id FROM vendor_payments vp
            WHERE vp.society_id = p_society_id AND vp.status = 'recorded' AND abs(vp.amount - r.amount) < 0.01
              AND length(coalesce(vp.reference, '')) >= 6 AND position(upper(vp.reference) IN v_text) > 0
              AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.reconciled_vendor_payment_id = vp.id)
            ORDER BY vp.paid_on LIMIT 1;
            IF v_id IS NOT NULL THEN
                UPDATE bank_transactions SET match_kind = 'vendor_payment', match_method = 'reference', reconciled_vendor_payment_id = v_id,
                       is_reconciled = true, matched_at = timezone('utc'::text, now()), suggested_kind = NULL, suggested_id = NULL
                WHERE id = r.id;
                v_matched := v_matched + 1;
                CONTINUE;
            END IF;
            -- TDS deposit: same amount, near the date, narration names the challan or TDS
            SELECT c.id INTO v_id FROM tds_challans c
            WHERE c.society_id = p_society_id AND abs(c.amount - r.amount) < 0.01 AND abs(c.paid_on - r.transaction_date) <= 7
              AND (position(upper(c.challan_number) IN v_text) > 0 OR v_text ~ '(TDS|ITNS|CBDT|INCOME TAX|OLTAS)')
              AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.reconciled_challan_id = c.id)
            ORDER BY c.paid_on LIMIT 1;
            IF v_id IS NOT NULL THEN
                UPDATE bank_transactions SET match_kind = 'tds_challan', match_method = 'reference', reconciled_challan_id = v_id,
                       is_reconciled = true, matched_at = timezone('utc'::text, now()), suggested_kind = NULL, suggested_id = NULL
                WHERE id = r.id;
                v_matched := v_matched + 1;
                CONTINUE;
            END IF;
            SELECT count(*), min(vp.id::text)::uuid INTO v_n, v_id FROM vendor_payments vp
            WHERE vp.society_id = p_society_id AND vp.status = 'recorded' AND abs(vp.amount - r.amount) < 0.01
              AND abs(vp.paid_on - r.transaction_date) <= 5
              AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.reconciled_vendor_payment_id = vp.id);
            IF v_n = 1 THEN
                UPDATE bank_transactions SET suggested_kind = 'vendor_payment', suggested_id = v_id WHERE id = r.id;
                v_suggested := v_suggested + 1;
            END IF;
        END IF;
    END LOOP;
    RETURN jsonb_build_object('matched', v_matched, 'suggested', v_suggested);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- IMPORT (rows oldest first; the browser reverses newest-first statements)
--   p_rows: [{ "date": "2026-10-14", "value_date": null, "description": "...",
--              "reference": "...", "debit": 0, "credit": 4170, "balance": 12345.67 }]
-- ============================================================================
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
    IF NOT FOUND OR NOT (is_platform_admin() OR is_society_admin(v_acc.society_id)) THEN
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

-- ============================================================================
-- COMMITTEE ACTIONS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.bank_line_for_update(p_line_id UUID)
RETURNS bank_transactions AS $$
DECLARE
    v_line bank_transactions%ROWTYPE;
BEGIN
    SELECT * INTO v_line FROM bank_transactions WHERE id = p_line_id FOR UPDATE;
    IF NOT FOUND OR NOT (is_platform_admin() OR is_society_admin(v_line.society_id)) THEN
        RAISE EXCEPTION 'Statement line not found';
    END IF;
    RETURN v_line;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.link_bank_line(p_line_id UUID, p_kind TEXT, p_target_id UUID, p_note TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_line bank_transactions;
    v_amount NUMERIC;
BEGIN
    v_line := bank_line_for_update(p_line_id);
    IF v_line.match_kind IS NOT NULL THEN
        RAISE EXCEPTION 'This line is already matched — unlink it first';
    END IF;
    IF p_kind = 'payment' THEN
        IF v_line.type <> 'credit' THEN RAISE EXCEPTION 'A resident payment matches money coming in'; END IF;
        SELECT amount INTO v_amount FROM payments WHERE id = p_target_id AND society_id = v_line.society_id
          AND status IN ('pending_verification', 'verified');
    ELSIF p_kind = 'vendor_payment' THEN
        IF v_line.type <> 'debit' THEN RAISE EXCEPTION 'A vendor payment matches money going out'; END IF;
        SELECT amount INTO v_amount FROM vendor_payments WHERE id = p_target_id AND society_id = v_line.society_id AND status = 'recorded';
    ELSIF p_kind = 'tds_challan' THEN
        IF v_line.type <> 'debit' THEN RAISE EXCEPTION 'A TDS deposit matches money going out'; END IF;
        SELECT amount INTO v_amount FROM tds_challans WHERE id = p_target_id AND society_id = v_line.society_id;
    ELSE
        RAISE EXCEPTION 'Unknown match type %', p_kind;
    END IF;
    IF v_amount IS NULL THEN
        RAISE EXCEPTION 'That record was not found';
    END IF;
    IF abs(v_amount - v_line.amount) >= 0.01 THEN
        RAISE EXCEPTION 'Amounts differ (₹% in the bank, ₹% in the books)', v_line.amount, v_amount;
    END IF;

    UPDATE bank_transactions
    SET match_kind = p_kind, match_method = 'manual', is_reconciled = true,
        reconciled_payment_id = CASE WHEN p_kind = 'payment' THEN p_target_id END,
        reconciled_vendor_payment_id = CASE WHEN p_kind = 'vendor_payment' THEN p_target_id END,
        reconciled_challan_id = CASE WHEN p_kind = 'tds_challan' THEN p_target_id END,
        suggested_kind = NULL, suggested_id = NULL, matched_by = auth.uid(), matched_at = timezone('utc'::text, now()),
        match_note = nullif(trim(coalesce(p_note, '')), '')
    WHERE id = p_line_id;
    RETURN jsonb_build_object('status', 'matched');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.confirm_bank_suggestion(p_line_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_line bank_transactions;
BEGIN
    v_line := bank_line_for_update(p_line_id);
    IF v_line.suggested_id IS NULL THEN
        RAISE EXCEPTION 'No suggestion on this line';
    END IF;
    RETURN link_bank_line(p_line_id, v_line.suggested_kind, v_line.suggested_id, 'Suggested match confirmed');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.ignore_bank_line(p_line_id UUID, p_note TEXT)
RETURNS JSONB AS $$
BEGIN
    PERFORM bank_line_for_update(p_line_id);
    IF length(trim(coalesce(p_note, ''))) < 3 THEN
        RAISE EXCEPTION 'Say why (e.g. bank interest, transfer between our accounts)';
    END IF;
    UPDATE bank_transactions SET match_kind = 'ignored', match_method = 'manual', is_reconciled = true, suggested_kind = NULL,
           suggested_id = NULL, matched_by = auth.uid(), matched_at = timezone('utc'::text, now()), match_note = trim(p_note)
    WHERE id = p_line_id;
    RETURN jsonb_build_object('status', 'ignored');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.unlink_bank_line(p_line_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_line bank_transactions;
BEGIN
    v_line := bank_line_for_update(p_line_id);
    IF v_line.match_method = 'recorded' THEN
        RAISE EXCEPTION 'This payment was recorded from the statement; void or reject it in Payments instead';
    END IF;
    UPDATE bank_transactions SET match_kind = NULL, match_method = NULL, is_reconciled = false, reconciled_payment_id = NULL,
           reconciled_vendor_payment_id = NULL, reconciled_challan_id = NULL, matched_by = NULL, matched_at = NULL, match_note = NULL
    WHERE id = p_line_id;
    RETURN jsonb_build_object('status', 'open');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Resident UTRs found in the statement: verify them all (receipts are issued as usual)
CREATE OR REPLACE FUNCTION public.verify_matched_payments(p_society_id UUID)
RETURNS JSONB AS $$
DECLARE
    r RECORD;
    v_ids UUID[] := '{}';
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can verify payments';
    END IF;
    FOR r IN
        SELECT p.id, b.transaction_date FROM bank_transactions b JOIN payments p ON p.id = b.reconciled_payment_id
        WHERE b.society_id = p_society_id AND p.status = 'pending_verification'
        ORDER BY b.transaction_date
    LOOP
        PERFORM verify_payment(r.id, true, 'Found in bank statement of ' || to_char(r.transaction_date, 'DD Mon YYYY'));
        v_ids := v_ids || r.id;
    END LOOP;
    RETURN jsonb_build_object('verified', cardinality(v_ids), 'payment_ids', to_jsonb(v_ids));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Money came in without a UTR submission: record it as that flat's payment and verify it
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
    v_result := verify_payment(v_payment, true, 'Received in bank; recorded by the committee from the statement');

    UPDATE bank_transactions
    SET match_kind = 'payment', match_method = 'recorded', is_reconciled = true, reconciled_payment_id = v_payment,
        suggested_kind = NULL, suggested_id = NULL, matched_by = auth.uid(), matched_at = timezone('utc'::text, now()),
        match_note = 'Recorded for flat ' || v_unit.unit_number
    WHERE id = p_line_id;
    RETURN v_result || jsonb_build_object('payment_id', v_payment);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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
                         OR has_professional_permission(v_acc.society_id, 'view_bank_reconciliation')) THEN
        RAISE EXCEPTION 'Bank account not found';
    END IF;
    SELECT running_balance, transaction_date INTO v_statement, v_statement_date FROM bank_transactions
    WHERE bank_account_id = p_bank_account_id AND running_balance IS NOT NULL
    ORDER BY transaction_date DESC, created_at DESC, line_no DESC NULLS LAST LIMIT 1;
    SELECT coalesce(sum(l.amount), 0) INTO v_book FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
    WHERE l.society_id = v_acc.society_id AND a.code = '1000' AND (v_statement_date IS NULL OR l.date <= v_statement_date);

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

-- ============================================================================
-- PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.match_bank_lines(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bank_line_for_update(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.import_bank_statement(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.link_bank_line(UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.confirm_bank_suggestion(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ignore_bank_line(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unlink_bank_line(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.verify_matched_payments(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_bank_receipt(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_reconciliation_summary(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_bank_statement(UUID, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.link_bank_line(UUID, TEXT, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_bank_suggestion(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ignore_bank_line(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlink_bank_line(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_matched_payments(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_bank_receipt(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_summary(UUID) TO authenticated;
