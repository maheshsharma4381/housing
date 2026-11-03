-- ============================================================================
-- 023 BANK RECONCILIATION PER BANK LEDGER
--   1. Every bank statement account (bank_accounts) belongs to one bank ledger.
--   2. The reconciliation's book balance is that ledger's balance (was 1000).
--   3. Matching and linking stay inside one bank: a payment, vendor payment
--      or TDS deposit matches only the statement of the bank it is in the
--      books under. A pending payment matched on a statement is posted to
--      that statement's bank when verified.
-- ============================================================================

ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS ledger_id UUID REFERENCES accounts(id);
UPDATE bank_accounts b SET ledger_id = a.id
FROM accounts a
WHERE a.society_id = b.society_id AND a.code = '1000' AND b.ledger_id IS NULL;

-- A statement account can move to another bank ledger (e.g. the CA's own ledger for that bank)
-- while none of its matched lines points at an entry the books keep in a different bank.
CREATE OR REPLACE FUNCTION public.trg_bank_account_ledger()
RETURNS TRIGGER AS $$
DECLARE
    v_other TEXT;
BEGIN
    IF NEW.ledger_id IS NULL THEN
        NEW.ledger_id := default_bank_ledger(NEW.society_id, 'receipt');
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.ledger_id IS DISTINCT FROM OLD.ledger_id THEN
        SELECT a.name INTO v_other
        FROM bank_transactions bt
        LEFT JOIN payments p ON p.id = bt.reconciled_payment_id
        LEFT JOIN vendor_payments vp ON vp.id = bt.reconciled_vendor_payment_id
        LEFT JOIN tds_challans c ON c.id = bt.reconciled_challan_id
        JOIN accounts a ON a.id = coalesce(p.bank_ledger_id, vp.bank_ledger_id, c.bank_ledger_id)
        WHERE bt.bank_account_id = NEW.id AND a.id <> NEW.ledger_id
        LIMIT 1;
        IF v_other IS NOT NULL THEN
            RAISE EXCEPTION 'Lines of this statement are matched to entries in % — rename that ledger instead, or unlink those lines first', v_other;
        END IF;
    END IF;
    IF (TG_OP = 'INSERT' OR NEW.ledger_id IS DISTINCT FROM OLD.ledger_id)
       AND NOT is_bank_ledger(NEW.society_id, NEW.ledger_id) THEN
        RAISE EXCEPTION 'Choose a bank ledger of this society';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_bank_account_ledger ON bank_accounts;
CREATE TRIGGER trg_bank_account_ledger
    BEFORE INSERT OR UPDATE OF ledger_id ON bank_accounts
    FOR EACH ROW EXECUTE FUNCTION public.trg_bank_account_ledger();

ALTER TABLE bank_accounts ALTER COLUMN ledger_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_accounts_ledger ON bank_accounts (ledger_id);

-- Body from 022: a verified payment's bank is the statement it is matched on,
-- then the statement account it came in through, then the default receiving bank
CREATE OR REPLACE FUNCTION public.trg_payment_bank()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.bank_ledger_id IS DISTINCT FROM OLD.bank_ledger_id AND OLD.status = 'verified' THEN
        RAISE EXCEPTION 'This payment is already in the books — ask your CA to move it';
    END IF;
    IF NEW.bank_ledger_id IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.bank_ledger_id IS DISTINCT FROM OLD.bank_ledger_id)
       AND NOT is_bank_ledger(NEW.society_id, NEW.bank_ledger_id) THEN
        RAISE EXCEPTION 'Choose a bank ledger of this society';
    END IF;
    IF NEW.status = 'verified' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'verified')
       AND NEW.payment_method <> 'cash' AND NEW.bank_ledger_id IS NULL THEN
        NEW.bank_ledger_id := coalesce(
            (SELECT ba.ledger_id FROM bank_transactions bt JOIN bank_accounts ba ON ba.id = bt.bank_account_id
             WHERE bt.reconciled_payment_id = NEW.id LIMIT 1),
            (SELECT ledger_id FROM bank_accounts WHERE id = NEW.bank_account_id),
            default_bank_ledger(NEW.society_id, 'receipt'));
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Body from 017; candidates only from the line's own bank ledger
CREATE OR REPLACE FUNCTION public.match_bank_lines(p_society_id UUID)
RETURNS JSONB AS $$
DECLARE
    r bank_transactions%ROWTYPE;
    v_text TEXT;
    v_id UUID;
    v_n INT;
    v_matched INT := 0;
    v_suggested INT := 0;
    v_ledger UUID;
BEGIN
    FOR r IN SELECT * FROM bank_transactions WHERE society_id = p_society_id AND match_kind IS NULL ORDER BY transaction_date LOOP
        v_text := bank_line_text(r);
        SELECT ledger_id INTO v_ledger FROM bank_accounts WHERE id = r.bank_account_id;
        v_id := NULL;

        IF r.type = 'credit' THEN
            -- Resident payment whose UTR appears in the narration
            SELECT p.id INTO v_id FROM payments p
            WHERE p.society_id = p_society_id AND p.status IN ('pending_verification', 'verified')
              AND (p.bank_ledger_id = v_ledger OR (p.status = 'pending_verification' AND p.bank_ledger_id IS NULL))
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
              AND (p.bank_ledger_id = v_ledger OR (p.status = 'pending_verification' AND p.bank_ledger_id IS NULL))
              AND abs(p.amount - r.amount) < 0.01 AND abs(p.payment_date - r.transaction_date) <= 3
              AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.reconciled_payment_id = p.id);
            IF v_n = 1 THEN
                UPDATE bank_transactions SET suggested_kind = 'payment', suggested_id = v_id WHERE id = r.id;
                v_suggested := v_suggested + 1;
            END IF;
        ELSE
            -- Vendor payment whose UTR / cheque reference appears in the narration
            SELECT vp.id INTO v_id FROM vendor_payments vp
            WHERE vp.society_id = p_society_id AND vp.status = 'recorded' AND vp.bank_ledger_id = v_ledger AND abs(vp.amount - r.amount) < 0.01
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
            WHERE c.society_id = p_society_id AND c.bank_ledger_id = v_ledger AND abs(c.amount - r.amount) < 0.01 AND abs(c.paid_on - r.transaction_date) <= 7
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
            WHERE vp.society_id = p_society_id AND vp.status = 'recorded' AND vp.bank_ledger_id = v_ledger AND abs(vp.amount - r.amount) < 0.01
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

-- Body from 017, plus the same-bank check
CREATE OR REPLACE FUNCTION public.link_bank_line(p_line_id UUID, p_kind TEXT, p_target_id UUID, p_note TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_line bank_transactions;
    v_amount NUMERIC;
    v_ledger UUID;
    v_bank UUID;
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
    -- 023: a record matches only the statement of the bank it is in the books under
    SELECT ledger_id INTO v_ledger FROM bank_accounts WHERE id = v_line.bank_account_id;
    IF p_kind = 'payment' THEN
        SELECT bank_ledger_id INTO v_bank FROM payments WHERE id = p_target_id;
        IF v_bank IS NOT NULL AND v_bank <> v_ledger THEN
            RAISE EXCEPTION 'This payment is in % in the books — match it on that bank''s statement',
                (SELECT name FROM accounts WHERE id = v_bank);
        END IF;
    ELSE
        IF p_kind = 'vendor_payment' THEN
            SELECT bank_ledger_id INTO v_bank FROM vendor_payments WHERE id = p_target_id;
        ELSE
            SELECT bank_ledger_id INTO v_bank FROM tds_challans WHERE id = p_target_id;
        END IF;
        IF v_bank IS NULL THEN
            RAISE EXCEPTION 'This was paid in cash';
        ELSIF v_bank <> v_ledger THEN
            RAISE EXCEPTION 'This was paid from % in the books — match it on that bank''s statement',
                (SELECT name FROM accounts WHERE id = v_bank);
        END IF;
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

-- Body from 017; the book side is the account's bank ledger instead of 1000
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

REVOKE ALL ON FUNCTION public.trg_bank_account_ledger() FROM PUBLIC, anon, authenticated;
