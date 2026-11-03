-- ============================================================================
-- 022 SEVERAL BANK ACCOUNTS
--   1. A bank is any active ledger in the Bank Accounts group. The CA sets a
--      default bank for receipts and one for payments (society_bank_defaults);
--      with none set, both are 1000.
--   2. Resident receipts, vendor payments and TDS deposits record the bank
--      ledger they went through (bank_ledger_id) and post to it. Cash stays
--      on 1100. Rows posted before this migration were posted to 1000.
--   3. The secretary may pick the bank a payment came into (set_payment_bank)
--      or a vendor payment / TDS deposit left from (p_bank_ledger_id).
--   4. Chart decisions: the CA may create ledgers in Duties & Taxes; Fixed
--      Assets takes no CA ledgers until the asset register follows the chart.
--      A default bank or a bill type's ledger cannot be deactivated.
-- ============================================================================

-- ============================================================================
-- 1. DEFAULT BANKS AND THE BANK OF EACH POSTING
-- ============================================================================
CREATE TABLE IF NOT EXISTS society_bank_defaults (
    society_id UUID PRIMARY KEY REFERENCES societies(id) ON DELETE CASCADE,
    receipt_account_id UUID REFERENCES accounts(id),
    payment_account_id UUID REFERENCES accounts(id),
    updated_by UUID REFERENCES profiles(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE society_bank_defaults ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS society_bank_defaults_select ON society_bank_defaults;
CREATE POLICY society_bank_defaults_select ON society_bank_defaults
    FOR SELECT USING (
        is_platform_admin() OR is_committee_viewer(society_id)
        OR can_view_financials(society_id) OR can_manage_accounts(society_id)
    );

ALTER TABLE payments ADD COLUMN IF NOT EXISTS bank_ledger_id UUID REFERENCES accounts(id);
ALTER TABLE vendor_payments ADD COLUMN IF NOT EXISTS bank_ledger_id UUID REFERENCES accounts(id);
ALTER TABLE tds_challans ADD COLUMN IF NOT EXISTS bank_ledger_id UUID REFERENCES accounts(id);

-- Everything already in the books went through 1000 (cash through 1100)
UPDATE payments p SET bank_ledger_id = a.id
FROM accounts a
WHERE a.society_id = p.society_id AND a.code = '1000' AND p.bank_ledger_id IS NULL
  AND p.status IN ('verified', 'refunded') AND p.payment_method <> 'cash';
UPDATE vendor_payments vp SET bank_ledger_id = a.id
FROM accounts a
WHERE a.society_id = vp.society_id AND a.code = '1000' AND vp.bank_ledger_id IS NULL AND vp.mode <> 'cash';
UPDATE tds_challans c SET bank_ledger_id = a.id
FROM accounts a
WHERE a.society_id = c.society_id AND a.code = '1000' AND c.bank_ledger_id IS NULL;

CREATE OR REPLACE FUNCTION public.is_bank_ledger(p_society_id UUID, p_account_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM accounts
        WHERE id = p_account_id AND society_id = p_society_id AND is_active
          AND account_group_key(group_id) = 'bank_accounts'
    )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- p_kind: 'receipt' | 'payment'. The CA's choice while it is still an active bank ledger, else 1000.
CREATE OR REPLACE FUNCTION public.default_bank_ledger(p_society_id UUID, p_kind TEXT)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
BEGIN
    SELECT CASE WHEN p_kind = 'payment' THEN payment_account_id ELSE receipt_account_id END
    INTO v_id
    FROM society_bank_defaults WHERE society_id = p_society_id;
    IF v_id IS NOT NULL AND is_bank_ledger(p_society_id, v_id) THEN
        RETURN v_id;
    END IF;
    RETURN (SELECT id FROM accounts WHERE society_id = p_society_id AND code = '1000');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- A payment's bank is fixed once it is in the books; a verified non-cash payment always has one
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
        NEW.bank_ledger_id := default_bank_ledger(NEW.society_id, 'receipt');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_payment_bank ON payments;
CREATE TRIGGER trg_payment_bank
    BEFORE INSERT OR UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION public.trg_payment_bank();

-- Vendor payments (non-cash) and TDS deposits always name the bank they left from
CREATE OR REPLACE FUNCTION public.trg_bank_ledger_default()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_TABLE_NAME = 'vendor_payments' AND to_jsonb(NEW) ->> 'mode' = 'cash' THEN
        RETURN NEW;
    END IF;
    IF NEW.bank_ledger_id IS NULL THEN
        NEW.bank_ledger_id := default_bank_ledger(NEW.society_id, 'payment');
    ELSIF NOT is_bank_ledger(NEW.society_id, NEW.bank_ledger_id) THEN
        RAISE EXCEPTION 'Choose a bank ledger of this society';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_bank_ledger_default ON vendor_payments;
CREATE TRIGGER trg_bank_ledger_default
    BEFORE INSERT ON vendor_payments
    FOR EACH ROW EXECUTE FUNCTION public.trg_bank_ledger_default();
DROP TRIGGER IF EXISTS trg_bank_ledger_default ON tds_challans;
CREATE TRIGGER trg_bank_ledger_default
    BEFORE INSERT ON tds_challans
    FOR EACH ROW EXECUTE FUNCTION public.trg_bank_ledger_default();

-- ============================================================================
-- 2. POSTINGS GO TO THE BANK THEY WENT THROUGH
--    Bodies from 007 / 013; only the bank line (and its choice) changes.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ledger_post_payment(p_payment_id UUID)
RETURNS UUID AS $$
DECLARE
    v_payment payments%ROWTYPE;
    v_unit TEXT;
    v_allocated NUMERIC;
BEGIN
    SELECT * INTO v_payment FROM payments WHERE id = p_payment_id;
    IF NOT FOUND OR v_payment.status <> 'verified' THEN
        RETURN NULL;
    END IF;
    SELECT unit_number INTO v_unit FROM units WHERE id = v_payment.unit_id;
    SELECT coalesce(sum(amount), 0) INTO v_allocated FROM payment_allocations WHERE payment_id = p_payment_id;

    RETURN post_journal(
        v_payment.society_id, v_payment.payment_date, 'payment.verified', v_payment.id,
        'Receipt ' || coalesce(v_payment.receipt_number, v_payment.payment_number) || ' from flat ' || coalesce(v_unit, '?')
            || ' (' || upper(v_payment.payment_method) || ' ' || v_payment.transaction_reference_utr || ')',
        jsonb_build_array(
            jsonb_build_object('code', CASE WHEN v_payment.payment_method = 'cash' THEN '1100'
                ELSE (SELECT code FROM accounts WHERE id = coalesce(v_payment.bank_ledger_id, default_bank_ledger(v_payment.society_id, 'receipt'))) END,
                'amount', v_payment.amount),
            jsonb_build_object('code', '1200', 'amount', -v_allocated),
            jsonb_build_object('code', '2300', 'amount', -(v_payment.amount - v_allocated))
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.record_vendor_payment(UUID, NUMERIC, NUMERIC, TEXT, TEXT, DATE, TEXT, UUID);
CREATE OR REPLACE FUNCTION public.record_vendor_payment(
    p_expense_id UUID,
    p_amount NUMERIC,
    p_tds NUMERIC DEFAULT NULL,
    p_mode TEXT DEFAULT 'neft',
    p_reference TEXT DEFAULT NULL,
    p_paid_on DATE DEFAULT NULL,
    p_proof_url TEXT DEFAULT NULL,
    p_bank_account_id UUID DEFAULT NULL,
    p_bank_ledger_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_exp expenses%ROWTYPE;
    v_mode TEXT := lower(trim(coalesce(p_mode, '')));
    v_paid_on DATE := coalesce(p_paid_on, current_date);
    v_amount NUMERIC := round(coalesce(p_amount, 0), 2);
    v_outstanding NUMERIC;
    v_tds_left NUMERIC;
    v_tds NUMERIC;
    v_settle NUMERIC;
    v_final BOOLEAN;
    v_limit NUMERIC;
    v_id UUID;
    v_number TEXT;
    v_bank UUID;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_exp.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can record expense payments';
    END IF;
    IF v_exp.status <> 'approved' THEN
        RAISE EXCEPTION 'Only approved expenses can be paid (this one is %)', v_exp.status;
    END IF;
    IF v_mode NOT IN ('neft', 'upi', 'cheque', 'cash') THEN
        RAISE EXCEPTION 'Payment mode must be NEFT, UPI, cheque or cash';
    END IF;
    IF v_amount < 0 THEN
        RAISE EXCEPTION 'Amount cannot be negative';
    END IF;
    IF v_paid_on > current_date THEN
        RAISE EXCEPTION 'Payment date cannot be in the future';
    END IF;
    IF p_bank_account_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM bank_accounts WHERE id = p_bank_account_id AND society_id = v_exp.society_id
    ) THEN
        RAISE EXCEPTION 'Bank account not found for this society';
    END IF;
    -- 022: the bank the money left from (cash goes to Cash-in-Hand)
    IF v_mode = 'cash' THEN
        v_bank := NULL;
    ELSIF p_bank_ledger_id IS NOT NULL THEN
        IF NOT is_bank_ledger(v_exp.society_id, p_bank_ledger_id) THEN
            RAISE EXCEPTION 'Choose a bank ledger of this society';
        END IF;
        v_bank := p_bank_ledger_id;
    ELSE
        v_bank := default_bank_ledger(v_exp.society_id, 'payment');
    END IF;

    v_outstanding := v_exp.subtotal + v_exp.gst_amount - v_exp.amount_settled;
    v_tds_left := v_exp.tds_amount - v_exp.tds_deducted;
    v_tds := coalesce(round(p_tds, 2), v_tds_left);       -- default: deduct the remaining TDS now
    IF v_tds < 0 OR v_tds > v_tds_left THEN
        RAISE EXCEPTION 'TDS for this payment can be at most ₹%', v_tds_left;
    END IF;
    v_settle := v_amount + v_tds;
    IF v_settle <= 0 THEN
        RAISE EXCEPTION 'Enter the amount paid';
    END IF;
    IF v_settle > v_outstanding + 0.005 THEN
        RAISE EXCEPTION 'This is more than the ₹% still payable', v_outstanding;
    END IF;
    v_final := abs(v_settle - v_outstanding) < 0.005;
    IF v_final AND v_tds <> v_tds_left THEN
        RAISE EXCEPTION 'Deduct the remaining TDS ₹% with the final payment', v_tds_left;
    END IF;
    IF v_exp.invoice_status = 'none' AND v_mode = 'cash' THEN
        SELECT voucher_cash_limit INTO v_limit FROM society_settings WHERE society_id = v_exp.society_id;
        v_limit := coalesce(v_limit, 5000);
        IF v_amount > v_limit THEN
            RAISE EXCEPTION 'Cash payments without an invoice are limited to ₹% — pay by UPI or bank', v_limit;
        END IF;
    END IF;

    -- Safety net for rows approved outside the normal flow
    PERFORM ledger_post_expense_accrual(v_exp.id);

    v_number := 'VP-' || lpad(next_society_number(v_exp.society_id, 'vendor_payments', 'payment_number', 'VP-')::text, 4, '0');
    INSERT INTO vendor_payments (society_id, expense_id, payment_number, paid_on, amount, tds_amount, mode, reference,
                                 bank_account_id, proof_url, created_by, bank_ledger_id)
    VALUES (v_exp.society_id, v_exp.id, v_number, v_paid_on, v_amount, v_tds, v_mode,
            nullif(trim(coalesce(p_reference, '')), ''), p_bank_account_id, p_proof_url, auth.uid(), v_bank)
    RETURNING id INTO v_id;

    PERFORM post_journal(
        v_exp.society_id, v_paid_on, 'vendor_payment.recorded', v_id,
        'Payment ' || v_number || ' for ' || coalesce(v_exp.voucher_number, v_exp.expense_number) || ' (' || upper(v_mode)
            || coalesce(' ' || nullif(trim(coalesce(p_reference, '')), ''), '') || ')',
        jsonb_build_array(
            jsonb_build_object('code', '2000', 'amount', v_settle),
            jsonb_build_object('code', CASE WHEN v_mode = 'cash' THEN '1100' ELSE (SELECT code FROM accounts WHERE id = v_bank) END, 'amount', -v_amount),
            jsonb_build_object('code', '2200', 'amount', -v_tds)
        )
    );

    PERFORM set_config('sahvaas.expense_workflow', 'on', true);
    UPDATE expenses
    SET amount_settled = amount_settled + v_settle,
        tds_deducted = tds_deducted + v_tds,
        payment_status = CASE WHEN v_final THEN 'paid' ELSE 'partial' END,
        status = CASE WHEN v_final THEN 'paid' ELSE status END,
        paid_date = CASE WHEN v_final THEN v_paid_on ELSE paid_date END,
        payment_reference = coalesce(nullif(trim(coalesce(p_reference, '')), ''), payment_reference),
        updated_at = timezone('utc'::text, now())
    WHERE id = v_exp.id;
    PERFORM set_config('sahvaas.expense_workflow', 'off', true);

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_exp.society_id, auth.uid(), 'expense.payment_recorded', 'expense', v_exp.id::text,
            jsonb_build_object('payment_number', v_number, 'amount', v_amount, 'tds', v_tds, 'mode', v_mode,
                               'reference', p_reference, 'outstanding', v_outstanding - v_settle));

    RETURN jsonb_build_object(
        'payment_id', v_id,
        'payment_number', v_number,
        'settled', v_settle,
        'outstanding', round(v_outstanding - v_settle, 2),
        'status', CASE WHEN v_final THEN 'paid' ELSE 'partial' END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.record_tds_challan(UUID, TEXT, NUMERIC, DATE, DATE, TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.record_tds_challan(
    p_society_id UUID,
    p_challan_number TEXT,
    p_amount NUMERIC,
    p_paid_on DATE,
    p_period_month DATE,
    p_section TEXT DEFAULT NULL,
    p_reference TEXT DEFAULT NULL,
    p_bank_ledger_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_payable NUMERIC;
    v_amount NUMERIC := round(coalesce(p_amount, 0), 2);
    v_id UUID;
    v_bank UUID;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can record TDS deposits';
    END IF;
    IF length(trim(coalesce(p_challan_number, ''))) = 0 THEN
        RAISE EXCEPTION 'Challan number is required';
    END IF;
    IF v_amount <= 0 THEN
        RAISE EXCEPTION 'Enter the amount deposited';
    END IF;
    IF p_paid_on IS NULL OR p_paid_on > current_date THEN
        RAISE EXCEPTION 'Deposit date must be today or earlier';
    END IF;

    SELECT -coalesce(sum(l.amount), 0) INTO v_payable
    FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
    WHERE l.society_id = p_society_id AND a.code = '2200';
    IF v_amount > v_payable + 0.005 THEN
        RAISE EXCEPTION 'Only ₹% of TDS is waiting to be deposited', v_payable;
    END IF;
    -- 022: the bank the deposit left from
    IF p_bank_ledger_id IS NOT NULL THEN
        IF NOT is_bank_ledger(p_society_id, p_bank_ledger_id) THEN
            RAISE EXCEPTION 'Choose a bank ledger of this society';
        END IF;
        v_bank := p_bank_ledger_id;
    ELSE
        v_bank := default_bank_ledger(p_society_id, 'payment');
    END IF;

    INSERT INTO tds_challans (society_id, challan_number, paid_on, period_month, section_label, amount, reference, created_by, bank_ledger_id)
    VALUES (p_society_id, trim(p_challan_number), p_paid_on, date_trunc('month', coalesce(p_period_month, p_paid_on))::date,
            nullif(trim(coalesce(p_section, '')), ''), v_amount, nullif(trim(coalesce(p_reference, '')), ''), auth.uid(), v_bank)
    RETURNING id INTO v_id;

    PERFORM post_journal(p_society_id, p_paid_on, 'tds.deposited', v_id,
                         'TDS deposited, challan ' || trim(p_challan_number),
                         jsonb_build_array(
                             jsonb_build_object('code', '2200', 'amount', v_amount),
                             jsonb_build_object('code', (SELECT code FROM accounts WHERE id = v_bank), 'amount', -v_amount)
                         ));

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'tds.deposited', 'tds_challan', v_id::text,
            jsonb_build_object('challan', trim(p_challan_number), 'amount', v_amount));

    RETURN jsonb_build_object('id', v_id, 'remaining', round(v_payable - v_amount, 2));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. CHART DECISIONS (body from 020)
--    Duties & Taxes now takes CA ledgers; Fixed Assets waits for the asset register.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.group_allows_ledgers(p_group_id UUID)
RETURNS BOOLEAN AS $$
    SELECT coalesce(account_group_key(p_group_id), '') NOT IN ('members_dues', 'sundry_creditors', 'member_advances', 'fixed_assets')
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Body from 020, plus: a default bank or a bill type's ledger stays active
CREATE OR REPLACE FUNCTION public.set_ledger_active(p_society_id UUID, p_code TEXT, p_active BOOLEAN)
RETURNS VOID AS $$
DECLARE
    v_ledger accounts%ROWTYPE;
BEGIN
    PERFORM require_manage_accounts(p_society_id);
    SELECT * INTO v_ledger FROM accounts WHERE society_id = p_society_id AND code = p_code;
    IF v_ledger.id IS NULL THEN
        RAISE EXCEPTION 'Unknown ledger %', p_code;
    END IF;
    IF NOT coalesce(p_active, false) THEN
        IF v_ledger.is_system THEN
            RAISE EXCEPTION 'This ledger cannot be deactivated';
        END IF;
        IF EXISTS (SELECT 1 FROM society_bank_defaults
                   WHERE society_id = p_society_id AND v_ledger.id IN (receipt_account_id, payment_account_id)) THEN
            RAISE EXCEPTION 'This ledger is a default bank — choose another default bank first';
        END IF;
        IF EXISTS (SELECT 1 FROM expense_categories WHERE society_id = p_society_id AND account_code = p_code AND is_active) THEN
            RAISE EXCEPTION 'A bill type uses this ledger — point the bill type to another ledger first';
        END IF;
        -- Income and expense ledgers start every financial year at zero; others carry their balance
        IF coalesce((
            SELECT sum(amount) FROM ledger_entries
            WHERE account_id = v_ledger.id
              AND (v_ledger.type NOT IN ('income', 'expense') OR date >= fy_start_of(current_date))
        ), 0) <> 0 THEN
            RAISE EXCEPTION 'Move its balance to another ledger first';
        END IF;
        IF EXISTS (SELECT 1 FROM billing_rules WHERE society_id = p_society_id AND account_code = p_code AND is_active) THEN
            RAISE EXCEPTION 'A maintenance charge uses this ledger';
        END IF;
    END IF;
    IF v_ledger.is_active IS DISTINCT FROM coalesce(p_active, false) THEN
        UPDATE accounts SET is_active = coalesce(p_active, false) WHERE id = v_ledger.id;
        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (p_society_id, auth.uid(),
                CASE WHEN coalesce(p_active, false) THEN 'chart.ledger_activated' ELSE 'chart.ledger_deactivated' END,
                'ledger', p_code, jsonb_build_object('code', p_code, 'name', v_ledger.name));
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 4. RPCs
-- ============================================================================
CREATE OR REPLACE FUNCTION public.bank_ledgers(p_society_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_receipt UUID;
    v_payment UUID;
BEGIN
    IF NOT (is_platform_admin() OR is_committee_viewer(p_society_id) OR can_view_financials(p_society_id)
            OR can_manage_accounts(p_society_id) OR has_professional_permission(p_society_id, 'view_bank_reconciliation')) THEN
        RAISE EXCEPTION 'You do not have access to this society''s accounts';
    END IF;
    v_receipt := default_bank_ledger(p_society_id, 'receipt');
    v_payment := default_bank_ledger(p_society_id, 'payment');
    RETURN coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                   'id', a.id, 'code', a.code, 'name', a.name,
                   'is_default_receipt', a.id = v_receipt, 'is_default_payment', a.id = v_payment
               ) ORDER BY a.code)
        FROM accounts a
        WHERE a.society_id = p_society_id AND a.is_active AND account_group_key(a.group_id) = 'bank_accounts'
    ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.set_default_banks(p_society_id UUID, p_receipt_ledger_id UUID, p_payment_ledger_id UUID)
RETURNS VOID AS $$
DECLARE
    v_old JSONB;
BEGIN
    PERFORM require_manage_accounts(p_society_id);
    IF NOT is_bank_ledger(p_society_id, p_receipt_ledger_id) OR NOT is_bank_ledger(p_society_id, p_payment_ledger_id) THEN
        RAISE EXCEPTION 'Choose a bank ledger of this society';
    END IF;
    v_old := jsonb_build_object(
        'receipt', (SELECT name FROM accounts WHERE id = default_bank_ledger(p_society_id, 'receipt')),
        'payment', (SELECT name FROM accounts WHERE id = default_bank_ledger(p_society_id, 'payment')));

    INSERT INTO society_bank_defaults (society_id, receipt_account_id, payment_account_id, updated_by, updated_at)
    VALUES (p_society_id, p_receipt_ledger_id, p_payment_ledger_id, auth.uid(), timezone('utc'::text, now()))
    ON CONFLICT (society_id) DO UPDATE
    SET receipt_account_id = EXCLUDED.receipt_account_id,
        payment_account_id = EXCLUDED.payment_account_id,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, new_value)
    VALUES (p_society_id, auth.uid(), 'chart.default_banks', 'society', p_society_id::text, v_old,
            jsonb_build_object('receipt', (SELECT name FROM accounts WHERE id = p_receipt_ledger_id),
                               'payment', (SELECT name FROM accounts WHERE id = p_payment_ledger_id)));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- The secretary says which bank a resident's payment came into, before verifying it
CREATE OR REPLACE FUNCTION public.set_payment_bank(p_payment_id UUID, p_bank_ledger_id UUID)
RETURNS VOID AS $$
DECLARE
    v_payment payments%ROWTYPE;
BEGIN
    SELECT * INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;
    IF NOT FOUND OR NOT (is_platform_admin() OR is_society_admin(v_payment.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can verify payments';
    END IF;
    IF v_payment.payment_method = 'cash' THEN
        RAISE EXCEPTION 'Cash payments go to Cash-in-Hand';
    END IF;
    IF v_payment.status <> 'pending_verification' THEN
        RAISE EXCEPTION 'This payment is already in the books — ask your CA to move it';
    END IF;
    IF EXISTS (SELECT 1 FROM bank_transactions WHERE reconciled_payment_id = p_payment_id) THEN
        RAISE EXCEPTION 'This payment is matched to a bank statement line — that bank decides';
    END IF;
    IF NOT is_bank_ledger(v_payment.society_id, p_bank_ledger_id) THEN
        RAISE EXCEPTION 'Choose a bank ledger of this society';
    END IF;
    UPDATE payments SET bank_ledger_id = p_bank_ledger_id WHERE id = p_payment_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.is_bank_ledger(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.default_bank_ledger(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_payment_bank() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_bank_ledger_default() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.record_vendor_payment(UUID, NUMERIC, NUMERIC, TEXT, TEXT, DATE, TEXT, UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_tds_challan(UUID, TEXT, NUMERIC, DATE, DATE, TEXT, TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_ledgers(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_default_banks(UUID, UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_payment_bank(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_vendor_payment(UUID, NUMERIC, NUMERIC, TEXT, TEXT, DATE, TEXT, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_tds_challan(UUID, TEXT, NUMERIC, DATE, DATE, TEXT, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_ledgers(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_default_banks(UUID, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_payment_bank(UUID, UUID) TO authenticated;
