-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 007: Double-Entry Ledger Engine & Financial Reports
--
-- Every money event posts a balanced journal automatically (no manual entry):
--   bill issued       Dr 1200 Members Receivable   Cr income/fund accounts + 2100 GST
--   late fee          Dr 1200 Members Receivable   Cr 4100 Interest on Late Payment
--   payment verified  Dr 1000 Bank / 1100 Cash      Cr 1200 Receivable (+ 2300 Advance)
--   expense paid      Dr 5xxx Expense               Cr 1000 Bank + 2200 TDS Payable
-- Ledger amounts: positive = debit, negative = credit.
-- Postings are idempotent per (event type, event id). Clients can only read.
-- Safe to re-run.
-- ============================================================================

-- Which account a billing rule credits (fund contributions are not income)
ALTER TABLE billing_rules ADD COLUMN IF NOT EXISTS account_code VARCHAR(8) NOT NULL DEFAULT '4000';
ALTER TABLE billing_rules DROP CONSTRAINT IF EXISTS chk_billing_rules_account_code;
ALTER TABLE billing_rules ADD CONSTRAINT chk_billing_rules_account_code
    CHECK (account_code IN ('4000', '4200', '3000', '3100', '3200'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_event
    ON journal_entries (society_id, reference_event_type, reference_event_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account_date ON ledger_entries (account_id, date);
CREATE INDEX IF NOT EXISTS idx_ledger_society_date ON ledger_entries (society_id, date);

-- ============================================================================
-- 1. DEFAULT CHART OF ACCOUNTS (idempotent; create_society also seeds these)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ensure_default_accounts(p_society_id UUID)
RETURNS VOID AS $$
BEGIN
    INSERT INTO accounts (society_id, code, name, type, is_system)
    SELECT p_society_id, a.code, a.name, a.type, true
    FROM (VALUES
        ('1000', 'Bank Accounts', 'asset'),
        ('1100', 'Cash in Hand', 'asset'),
        ('1200', 'Members Receivable', 'asset'),
        ('2000', 'Sundry Creditors', 'liability'),
        ('2100', 'GST Payable', 'liability'),
        ('2200', 'TDS Payable', 'liability'),
        ('2300', 'Advance Maintenance Received', 'liability'),
        ('3000', 'Sinking Fund', 'equity'),
        ('3100', 'Repair & Maintenance Fund', 'equity'),
        ('3200', 'General Reserve', 'equity'),
        ('4000', 'Maintenance Charges', 'income'),
        ('4100', 'Interest on Late Payment', 'income'),
        ('4200', 'Other Income', 'income'),
        ('5000', 'Repairs & Maintenance', 'expense'),
        ('5100', 'Security Charges', 'expense'),
        ('5200', 'Housekeeping', 'expense'),
        ('5300', 'Electricity (Common Areas)', 'expense'),
        ('5400', 'Water Charges', 'expense'),
        ('5900', 'Other Expenses', 'expense')
    ) AS a(code, name, type)
    ON CONFLICT (society_id, code) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 2. CORE POSTING FUNCTION (internal)
--    p_lines: [{ "code": "1200", "amount": 2685 }, { "code": "4000", "amount": -2325 }, ...]
-- ============================================================================
CREATE OR REPLACE FUNCTION public.post_journal(
    p_society_id UUID,
    p_entry_date DATE,
    p_event_type TEXT,
    p_event_id UUID,
    p_narration TEXT,
    p_lines JSONB
)
RETURNS UUID AS $$
DECLARE
    v_journal_id UUID;
    v_line JSONB;
    v_amount NUMERIC;
    v_sum NUMERIC := 0;
    v_count INT := 0;
    v_account_id UUID;
    v_prev NUMERIC;
    v_next INT;
BEGIN
    IF EXISTS (
        SELECT 1 FROM journal_entries
        WHERE society_id = p_society_id AND reference_event_type = p_event_type AND reference_event_id = p_event_id
    ) THEN
        RETURN NULL; -- already posted
    END IF;

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        v_amount := round(coalesce((v_line ->> 'amount')::NUMERIC, 0), 2);
        IF v_amount <> 0 THEN
            v_sum := v_sum + v_amount;
            v_count := v_count + 1;
        END IF;
    END LOOP;

    IF v_count = 0 THEN
        RETURN NULL; -- nothing to post (zero-value event)
    END IF;
    IF v_sum <> 0 THEN
        RAISE EXCEPTION 'Unbalanced journal for % %: debits and credits differ by %', p_event_type, p_event_id, v_sum;
    END IF;

    -- Serialize journal numbering per society
    PERFORM 1 FROM societies WHERE id = p_society_id FOR UPDATE;
    SELECT count(*) + 1 INTO v_next FROM journal_entries WHERE society_id = p_society_id;

    INSERT INTO journal_entries (society_id, entry_number, entry_date, reference_event_type, reference_event_id, narration, is_posted)
    VALUES (p_society_id, 'JV-' || lpad(v_next::text, 6, '0'), p_entry_date, p_event_type, p_event_id, p_narration, true)
    RETURNING id INTO v_journal_id;

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        v_amount := round(coalesce((v_line ->> 'amount')::NUMERIC, 0), 2);
        CONTINUE WHEN v_amount = 0;

        SELECT id INTO v_account_id FROM accounts WHERE society_id = p_society_id AND code = v_line ->> 'code';
        IF v_account_id IS NULL THEN
            RAISE EXCEPTION 'Account % is missing for society %', v_line ->> 'code', p_society_id;
        END IF;

        SELECT coalesce(sum(amount), 0) INTO v_prev FROM ledger_entries WHERE account_id = v_account_id;

        INSERT INTO ledger_entries (society_id, account_id, journal_entry_id, date, amount, balance_after, narration)
        VALUES (p_society_id, v_account_id, v_journal_id, p_entry_date, v_amount, v_prev + v_amount,
                coalesce(v_line ->> 'narration', p_narration));
    END LOOP;

    RETURN v_journal_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. EVENT POSTERS
-- ============================================================================

-- Bill issued (excludes late fees, which post separately)
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
    IF NOT FOUND OR v_bill.status IN ('draft', 'cancelled') THEN
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
    -- Any amount not explained by line items (e.g. bills created without items) is maintenance income
    v_lines := v_lines || jsonb_build_object('code', '4000', 'amount', -(v_receivable - v_bill.tax_amount - v_items_total));

    RETURN post_journal(
        v_bill.society_id, v_bill.bill_date, 'bill.issued', v_bill.id,
        'Bill ' || v_bill.bill_number || ' issued to flat ' || coalesce(v_unit, '?'),
        v_lines
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.ledger_post_late_fee(p_bill_id UUID, p_amount NUMERIC)
RETURNS UUID AS $$
DECLARE
    v_bill bills%ROWTYPE;
BEGIN
    SELECT * INTO v_bill FROM bills WHERE id = p_bill_id;
    IF NOT FOUND OR coalesce(p_amount, 0) <= 0 THEN
        RETURN NULL;
    END IF;
    RETURN post_journal(
        v_bill.society_id, coalesce(v_bill.late_fee_applied_at::date, current_date), 'bill.late_fee', v_bill.id,
        'Late payment charge on bill ' || v_bill.bill_number,
        jsonb_build_array(
            jsonb_build_object('code', '1200', 'amount', p_amount),
            jsonb_build_object('code', '4100', 'amount', -p_amount)
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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
            jsonb_build_object('code', CASE WHEN v_payment.payment_method = 'cash' THEN '1100' ELSE '1000' END, 'amount', v_payment.amount),
            jsonb_build_object('code', '1200', 'amount', -v_allocated),
            jsonb_build_object('code', '2300', 'amount', -(v_payment.amount - v_allocated))
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.expense_account_code(p_category TEXT)
RETURNS TEXT AS $$
    SELECT CASE
        WHEN p_category ~* 'secur|guard' THEN '5100'
        WHEN p_category ~* 'housekeep|clean|garden' THEN '5200'
        WHEN p_category ~* 'electric|power|light' THEN '5300'
        WHEN p_category ~* 'water' THEN '5400'
        WHEN p_category ~* 'repair|maint|lift|plumb|paint' THEN '5000'
        ELSE '5900'
    END
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.ledger_post_expense(p_expense_id UUID)
RETURNS UUID AS $$
DECLARE
    v_exp expenses%ROWTYPE;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id;
    IF NOT FOUND OR NOT (v_exp.status = 'paid' OR v_exp.payment_status = 'paid') THEN
        RETURN NULL;
    END IF;
    RETURN post_journal(
        v_exp.society_id, coalesce(v_exp.paid_date, v_exp.invoice_date, current_date), 'expense.paid', v_exp.id,
        'Expense ' || v_exp.expense_number || ': ' || v_exp.title,
        jsonb_build_array(
            jsonb_build_object('code', expense_account_code(v_exp.category), 'amount', v_exp.net_payable + v_exp.tds_amount),
            jsonb_build_object('code', '1000', 'amount', -v_exp.net_payable),
            jsonb_build_object('code', '2200', 'amount', -v_exp.tds_amount)
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 4. TRIGGERS
-- ============================================================================

-- Bills: deferred to commit so the bill's line items exist when posting
CREATE OR REPLACE FUNCTION public.trg_ledger_bill_insert()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM ledger_post_bill(NEW.id);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_ledger_bill_insert ON bills;
CREATE CONSTRAINT TRIGGER trg_ledger_bill_insert
    AFTER INSERT ON bills
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.trg_ledger_bill_insert();

CREATE OR REPLACE FUNCTION public.trg_ledger_bill_late_fee()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.interest_or_late_fee > OLD.interest_or_late_fee THEN
        PERFORM ledger_post_late_fee(NEW.id, NEW.interest_or_late_fee - OLD.interest_or_late_fee);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_ledger_bill_late_fee ON bills;
CREATE TRIGGER trg_ledger_bill_late_fee
    AFTER UPDATE OF interest_or_late_fee ON bills
    FOR EACH ROW EXECUTE FUNCTION public.trg_ledger_bill_late_fee();

CREATE OR REPLACE FUNCTION public.trg_ledger_payment_verified()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'verified' AND OLD.status IS DISTINCT FROM 'verified' THEN
        PERFORM ledger_post_payment(NEW.id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_ledger_payment_verified ON payments;
CREATE TRIGGER trg_ledger_payment_verified
    AFTER UPDATE OF status ON payments
    FOR EACH ROW EXECUTE FUNCTION public.trg_ledger_payment_verified();

CREATE OR REPLACE FUNCTION public.trg_ledger_expense_paid()
RETURNS TRIGGER AS $$
BEGIN
    IF (NEW.status = 'paid' OR NEW.payment_status = 'paid')
       AND (TG_OP = 'INSERT' OR NOT (OLD.status = 'paid' OR OLD.payment_status = 'paid')) THEN
        PERFORM ledger_post_expense(NEW.id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_ledger_expense_paid ON expenses;
CREATE TRIGGER trg_ledger_expense_paid
    AFTER INSERT OR UPDATE OF status, payment_status ON expenses
    FOR EACH ROW EXECUTE FUNCTION public.trg_ledger_expense_paid();

-- ============================================================================
-- 5. REPORTS (committee, platform admin, or professionals with view_reports/view_ledger)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.can_view_financials(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT is_platform_admin()
        OR is_society_admin(p_society_id)
        OR has_professional_permission(p_society_id, 'view_reports')
        OR has_professional_permission(p_society_id, 'view_ledger')
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.trial_balance(p_society_id UUID, p_as_of DATE DEFAULT current_date)
RETURNS TABLE (code TEXT, name TEXT, type TEXT, debit NUMERIC, credit NUMERIC) AS $$
BEGIN
    IF NOT can_view_financials(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s financial reports';
    END IF;
    RETURN QUERY
    SELECT a.code::TEXT, a.name::TEXT, a.type::TEXT,
           greatest(sum(l.amount), 0)::NUMERIC AS debit,
           greatest(-sum(l.amount), 0)::NUMERIC AS credit
    FROM accounts a
    JOIN ledger_entries l ON l.account_id = a.id AND l.date <= p_as_of
    WHERE a.society_id = p_society_id
    GROUP BY a.code, a.name, a.type
    HAVING sum(l.amount) <> 0
    ORDER BY a.code;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.income_expenditure(p_society_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (type TEXT, code TEXT, name TEXT, amount NUMERIC) AS $$
BEGIN
    IF NOT can_view_financials(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s financial reports';
    END IF;
    RETURN QUERY
    SELECT a.type::TEXT, a.code::TEXT, a.name::TEXT,
           (CASE WHEN a.type = 'income' THEN -sum(l.amount) ELSE sum(l.amount) END)::NUMERIC AS amount
    FROM accounts a
    JOIN ledger_entries l ON l.account_id = a.id AND l.date BETWEEN p_from AND p_to
    WHERE a.society_id = p_society_id AND a.type IN ('income', 'expense')
    GROUP BY a.type, a.code, a.name
    HAVING sum(l.amount) <> 0
    ORDER BY a.type DESC, a.code;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

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
    SELECT u.unit_number::TEXT, w.name::TEXT, p.full_name::TEXT, p.email::TEXT,
           count(*)::INT, sum(b.balance_due)::NUMERIC, min(b.due_date),
           greatest(p_as_of - min(b.due_date), 0)::INT
    FROM bills b
    JOIN units u ON u.id = b.unit_id
    JOIN wings w ON w.id = u.wing_id
    LEFT JOIN profiles p ON p.id = b.user_id
    WHERE b.society_id = p_society_id
      AND b.balance_due > 0
      AND b.status IN ('issued', 'partially_paid', 'overdue')
    GROUP BY u.unit_number, w.name, p.full_name, p.email
    ORDER BY sum(b.balance_due) DESC, u.unit_number;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 6. PRIVILEGES: posting functions are internal; reports are callable
-- ============================================================================
REVOKE ALL ON FUNCTION public.post_journal(UUID, DATE, TEXT, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ledger_post_bill(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ledger_post_late_fee(UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ledger_post_payment(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ledger_post_expense(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ensure_default_accounts(UUID) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.trial_balance(UUID, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.income_expenditure(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.member_dues(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trial_balance(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.income_expenditure(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.member_dues(UUID, DATE) TO authenticated;

-- ============================================================================
-- 7. BACKFILL: post history that existed before this migration
-- ============================================================================
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT id FROM societies LOOP
        PERFORM ensure_default_accounts(r.id);
    END LOOP;
    FOR r IN SELECT id FROM bills ORDER BY created_at LOOP
        PERFORM ledger_post_bill(r.id);
    END LOOP;
    FOR r IN SELECT id, interest_or_late_fee FROM bills WHERE interest_or_late_fee > 0 ORDER BY created_at LOOP
        PERFORM ledger_post_late_fee(r.id, r.interest_or_late_fee);
    END LOOP;
    FOR r IN SELECT id FROM payments WHERE status = 'verified' ORDER BY verified_at NULLS FIRST, created_at LOOP
        PERFORM ledger_post_payment(r.id);
    END LOOP;
    FOR r IN SELECT id FROM expenses WHERE status = 'paid' OR payment_status = 'paid' ORDER BY created_at LOOP
        PERFORM ledger_post_expense(r.id);
    END LOOP;
END $$;
