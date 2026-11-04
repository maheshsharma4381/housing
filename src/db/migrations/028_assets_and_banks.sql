-- ============================================================================
-- 028 ASSETS AND BANKS (Phase 2E)
--   An asset type is any active ledger under Fixed Assets except 1590 Accumulated
--   Depreciation, with its own default depreciation rate. Asset sale money goes to
--   the bank the CA chooses. An entry booked to the wrong bank moves by an
--   adjustment the committee approves.
-- ============================================================================

-- ============================================================================
-- 1. ASSET TYPES ARE FIXED-ASSET LEDGERS
-- ============================================================================
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS dep_rate NUMERIC(5,2) CHECK (dep_rate BETWEEN 0 AND 100);
UPDATE accounts SET dep_rate = default_dep_rate(code)
WHERE dep_rate IS NULL AND code IN ('1500', '1510', '1520', '1530', '1540', '1550');

ALTER TABLE fixed_assets DROP CONSTRAINT IF EXISTS fixed_assets_account_code_check;
ALTER TABLE expense_categories DROP CONSTRAINT IF EXISTS expense_categories_asset_account_code_check;
ALTER TABLE expense_categories ADD CONSTRAINT expense_categories_asset_account_code_check
    CHECK (society_id IS NOT NULL OR asset_account_code IS NULL OR asset_account_code IN ('1500', '1510', '1520', '1530', '1540', '1550'));

CREATE OR REPLACE FUNCTION public.is_asset_ledger(p_society_id UUID, p_code TEXT)
RETURNS BOOLEAN AS $$
    SELECT coalesce((
        SELECT a.is_active AND a.code <> '1590' AND account_group_key(a.group_id) = 'fixed_assets'
        FROM accounts a WHERE a.society_id = p_society_id AND a.code = p_code
    ), false)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.asset_dep_rate(p_society_id UUID, p_code TEXT)
RETURNS NUMERIC AS $$
    SELECT coalesce((SELECT dep_rate FROM accounts WHERE society_id = p_society_id AND code = p_code), default_dep_rate(p_code))
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.asset_ledgers(p_society_id UUID)
RETURNS JSONB AS $$
BEGIN
    IF NOT (can_view_financials(p_society_id) OR can_manage_accounts(p_society_id)) THEN
        RAISE EXCEPTION 'You do not have access to this society''s accounts';
    END IF;
    RETURN coalesce((
        SELECT jsonb_agg(jsonb_build_object('code', a.code, 'name', a.name, 'dep_rate', asset_dep_rate(p_society_id, a.code)) ORDER BY a.code)
        FROM accounts a
        WHERE a.society_id = p_society_id AND is_asset_ledger(p_society_id, a.code)
    ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.set_ledger_dep_rate(p_society_id UUID, p_code TEXT, p_rate NUMERIC)
RETURNS JSONB AS $$
DECLARE
    v_old NUMERIC;
BEGIN
    PERFORM require_manage_accounts(p_society_id);
    IF NOT is_asset_ledger(p_society_id, p_code) THEN
        RAISE EXCEPTION 'Choose a fixed-asset ledger';
    END IF;
    IF p_rate IS NULL OR p_rate < 0 OR p_rate > 100 THEN
        RAISE EXCEPTION 'Depreciation rate must be between 0 and 100';
    END IF;
    SELECT dep_rate INTO v_old FROM accounts WHERE society_id = p_society_id AND code = p_code;
    UPDATE accounts SET dep_rate = round(p_rate, 2) WHERE society_id = p_society_id AND code = p_code;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, new_value)
    VALUES (p_society_id, auth.uid(), 'chart.dep_rate_set', 'account', p_code,
            jsonb_build_object('dep_rate', v_old), jsonb_build_object('dep_rate', round(p_rate, 2)));
    RETURN jsonb_build_object('code', p_code, 'dep_rate', round(p_rate, 2));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.add_asset_ledger(p_society_id UUID, p_name TEXT, p_rate NUMERIC)
RETURNS TEXT AS $$
DECLARE
    v_group UUID;
    v_code TEXT;
BEGIN
    PERFORM require_manage_accounts(p_society_id);
    IF p_rate IS NULL OR p_rate < 0 OR p_rate > 100 THEN
        RAISE EXCEPTION 'Depreciation rate must be between 0 and 100';
    END IF;
    SELECT id INTO v_group FROM account_groups WHERE society_id = p_society_id AND system_key = 'fixed_assets';
    v_code := create_ledger(p_society_id, v_group, p_name);
    UPDATE accounts SET dep_rate = round(p_rate, 2) WHERE society_id = p_society_id AND code = v_code;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'chart.asset_ledger_added', 'account', v_code,
            jsonb_build_object('name', p_name, 'dep_rate', round(p_rate, 2)));
    RETURN v_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 022_bank_ledgers.sql; + the CA creates fixed-asset ledgers (asset types)
CREATE OR REPLACE FUNCTION public.group_allows_ledgers(p_group_id UUID)
RETURNS BOOLEAN AS $$
    SELECT coalesce(account_group_key(p_group_id), '') NOT IN ('members_dues', 'sundry_creditors', 'member_advances')
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- from 013_accounting.sql; + any asset type (fixed-asset ledger)
CREATE OR REPLACE FUNCTION public.expenses_accounting_checks()
RETURNS TRIGGER AS $$
DECLARE
    v_workflow BOOLEAN := coalesce(current_setting('sahvaas.expense_workflow', true), '') = 'on';
    v_cat expense_categories;
    v_dup TEXT;
BEGIN
    IF NEW.expense_type = 'capital' THEN
        IF NEW.asset_account_code IS NULL THEN
            v_cat := resolve_expense_category(NEW.society_id, NEW.category);
            NEW.asset_account_code := v_cat.asset_account_code;
        END IF;
        IF NEW.asset_account_code IS NULL OR NOT is_asset_ledger(NEW.society_id, NEW.asset_account_code) THEN
            RAISE EXCEPTION 'Pick an asset type for a purchase booked as an asset';
        END IF;
    ELSE
        NEW.asset_account_code := NULL;
    END IF;

    IF (TG_OP = 'INSERT' OR NEW.tds_amount IS DISTINCT FROM OLD.tds_amount OR NEW.subtotal IS DISTINCT FROM OLD.subtotal)
       AND NEW.tds_amount > NEW.subtotal THEN
        RAISE EXCEPTION 'TDS cannot be more than the taxable amount';
    END IF;
    IF NEW.tds_suggested IS NOT NULL AND NEW.tds_amount <> NEW.tds_suggested
       AND length(trim(coalesce(NEW.tds_override_reason, ''))) = 0 THEN
        RAISE EXCEPTION 'TDS differs from the suggested ₹% — add a reason', NEW.tds_suggested;
    END IF;

    IF NEW.invoice_status = 'none' THEN
        IF length(trim(coalesce(NEW.payee_name, ''))) = 0 THEN
            RAISE EXCEPTION 'Enter who was paid — a voucher needs the payee name';
        END IF;
        IF NEW.document_url IS NULL THEN
            RAISE EXCEPTION 'Attach a photo of the work or a handwritten receipt for the voucher';
        END IF;
        IF NEW.gst_amount <> 0 THEN
            RAISE EXCEPTION 'GST can only be recorded with a tax invoice';
        END IF;
        NEW.gst_claimable := false;
        IF TG_OP = 'INSERT' AND coalesce(NEW.voucher_number, '') = '' THEN
            NEW.voucher_number := 'PV-' || lpad(next_society_number(NEW.society_id, 'expenses', 'voucher_number', 'PV-')::text, 4, '0');
        END IF;
    ELSIF NEW.invoice_status = 'pending' AND NEW.invoice_due_by IS NULL THEN
        NEW.invoice_due_by := current_date + 7;
    END IF;

    IF (TG_OP = 'INSERT' OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number)
       AND NEW.vendor_id IS NOT NULL AND length(trim(coalesce(NEW.invoice_number, ''))) > 0
       AND NEW.status NOT IN ('voided', 'rejected') THEN
        SELECT expense_number INTO v_dup FROM expenses
        WHERE society_id = NEW.society_id AND vendor_id = NEW.vendor_id
          AND lower(trim(invoice_number)) = lower(trim(NEW.invoice_number))
          AND status NOT IN ('voided', 'rejected') AND id <> NEW.id
        LIMIT 1;
        IF v_dup IS NOT NULL THEN
            RAISE EXCEPTION 'Invoice % from this vendor is already recorded as %', trim(NEW.invoice_number), v_dup;
        END IF;
    END IF;

    IF auth.uid() IS NOT NULL AND NOT v_workflow THEN
        IF TG_OP = 'INSERT' THEN
            NEW.amount_settled := 0;
            NEW.tds_deducted := 0;
        ELSE
            IF NEW.amount_settled IS DISTINCT FROM OLD.amount_settled OR NEW.tds_deducted IS DISTINCT FROM OLD.tds_deducted
               OR NEW.voucher_number IS DISTINCT FROM OLD.voucher_number THEN
                RAISE EXCEPTION 'Use the payment workflow to record payments';
            END IF;
            IF OLD.status IN ('approved', 'paid') AND (
                NEW.expense_type IS DISTINCT FROM OLD.expense_type
                OR NEW.asset_account_code IS DISTINCT FROM OLD.asset_account_code
                OR NEW.gst_claimable IS DISTINCT FROM OLD.gst_claimable
                OR NEW.category IS DISTINCT FROM OLD.category
                OR NEW.invoice_status IS DISTINCT FROM OLD.invoice_status
            ) THEN
                RAISE EXCEPTION 'Approved expenses cannot be edited; void it and create a new one';
            END IF;
        END IF;
    ELSIF TG_OP = 'INSERT' AND NEW.status = 'paid' AND NEW.amount_settled = 0 THEN
        -- Imports / seeds of already-paid bills count as fully settled
        NEW.amount_settled := NEW.subtotal + NEW.gst_amount;
        NEW.tds_deducted := NEW.tds_amount;
        NEW.payment_status := 'paid';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 013_accounting.sql; + the asset type's own rate
CREATE OR REPLACE FUNCTION public.create_asset_for_expense(p_expense_id UUID)
RETURNS UUID AS $$
DECLARE
    v_exp expenses%ROWTYPE;
    v_id UUID;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id;
    IF NOT FOUND OR v_exp.expense_type <> 'capital' OR v_exp.status NOT IN ('approved', 'paid') THEN
        RETURN NULL;
    END IF;
    SELECT id INTO v_id FROM fixed_assets WHERE expense_id = p_expense_id;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;
    INSERT INTO fixed_assets (society_id, asset_number, name, account_code, expense_id, vendor_id, put_to_use_date,
                              cost, location, funded_from, dep_rate, created_by)
    VALUES (v_exp.society_id,
            'FA-' || lpad(next_society_number(v_exp.society_id, 'fixed_assets', 'asset_number', 'FA-')::text, 4, '0'),
            v_exp.title, v_exp.asset_account_code, v_exp.id, v_exp.vendor_id,
            coalesce(v_exp.invoice_date, v_exp.approved_at::date, current_date),
            v_exp.subtotal + v_exp.gst_amount - CASE WHEN v_exp.gst_claimable THEN v_exp.gst_amount ELSE 0 END,
            v_exp.asset_location, v_exp.funded_from, asset_dep_rate(v_exp.society_id, v_exp.asset_account_code), v_exp.approved_by)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 027_ca_workspace.sql; + any asset type, with its own rate
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
    IF NOT is_asset_ledger(p_society_id, p_account_code) THEN
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
            nullif(trim(coalesce(p_location, '')), ''), coalesce(p_rate, asset_dep_rate(p_society_id, p_account_code)), auth.uid())
    RETURNING id INTO v_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'asset.added_existing', 'fixed_asset', v_id::text,
            jsonb_build_object('name', trim(p_name), 'cost', p_cost, 'wdv', p_wdv, 'as_of', p_as_of));
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 014_ca_workspace.sql; + any asset type
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
    IF NOT is_asset_ledger(v_exp.society_id, p_asset_account_code) THEN
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

-- from 024_bill_types.sql; + a society's asset suggestion must be one of its asset types
CREATE OR REPLACE FUNCTION public.trg_bill_type_ledger()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.society_id IS NOT NULL AND NEW.is_active AND NOT EXISTS (
        SELECT 1 FROM accounts
        WHERE society_id = NEW.society_id AND code = NEW.account_code AND type = 'expense' AND is_active
    ) THEN
        RAISE EXCEPTION 'A bill type can only point to an active expense ledger';
    END IF;
    IF NEW.society_id IS NOT NULL AND NEW.is_active AND NEW.asset_account_code IS NOT NULL
       AND NOT is_asset_ledger(NEW.society_id, NEW.asset_account_code) THEN
        RAISE EXCEPTION 'Choose a fixed-asset ledger for the asset suggestion';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 2. ASSET SALE MONEY GOES TO THE CHOSEN BANK
-- ============================================================================
DROP FUNCTION IF EXISTS public.dispose_asset(UUID, DATE, NUMERIC, TEXT, TEXT);

-- from 027_ca_workspace.sql; + p_bank_ledger_id: the bank that received the money
CREATE OR REPLACE FUNCTION public.dispose_asset(
    p_asset_id UUID, p_disposed_on DATE, p_sale_amount NUMERIC DEFAULT 0, p_mode TEXT DEFAULT 'bank', p_reason TEXT DEFAULT NULL,
    p_bank_ledger_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_asset fixed_assets%ROWTYPE;
    v_sale NUMERIC := round(coalesce(p_sale_amount, 0), 2);
    v_carrying NUMERIC;
    v_acc NUMERIC;
    v_gain NUMERIC;
    v_money_code TEXT;
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

    -- Sale money: cash to Cash-in-Hand; bank to the chosen bank ledger, else the default receiving bank
    IF p_mode = 'cash' THEN
        v_money_code := '1100';
    ELSE
        IF p_bank_ledger_id IS NOT NULL AND NOT is_bank_ledger(v_asset.society_id, p_bank_ledger_id) THEN
            RAISE EXCEPTION 'Choose a bank ledger of this society';
        END IF;
        SELECT code INTO v_money_code FROM accounts
        WHERE id = coalesce(p_bank_ledger_id, default_bank_ledger(v_asset.society_id, 'receipt'));
    END IF;

    -- The asset account holds the cost (bought here) or the opening WDV (brought in)
    v_carrying := coalesce(v_asset.opening_wdv, v_asset.cost);
    SELECT coalesce(sum(amount), 0) INTO v_acc FROM depreciation_lines WHERE asset_id = p_asset_id;
    v_gain := v_sale - (v_carrying - v_acc);

    PERFORM post_journal(v_asset.society_id, p_disposed_on, 'asset.disposed', v_asset.id,
                         'Asset ' || v_asset.asset_number || ' ' || v_asset.name || ' disposed: ' || trim(p_reason),
                         jsonb_build_array(
                             jsonb_build_object('code', v_money_code, 'amount', v_sale),
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

-- ============================================================================
-- 3. AN ENTRY BOOKED TO THE WRONG BANK MOVES BY AN APPROVED ADJUSTMENT
-- ============================================================================
ALTER TABLE adjustment_proposals DROP CONSTRAINT IF EXISTS adjustment_proposals_kind_check;
ALTER TABLE adjustment_proposals ADD CONSTRAINT adjustment_proposals_kind_check
    CHECK (kind IN ('journal', 'capitalise', 'year_lock', 'bank_move'));
ALTER TABLE adjustment_proposals ADD COLUMN IF NOT EXISTS move_entity_type VARCHAR(16)
    CHECK (move_entity_type IN ('payment', 'vendor_payment', 'tds_challan'));
ALTER TABLE adjustment_proposals ADD COLUMN IF NOT EXISTS move_entity_id UUID;
ALTER TABLE adjustment_proposals ADD COLUMN IF NOT EXISTS move_from_ledger_id UUID REFERENCES accounts(id);
ALTER TABLE adjustment_proposals ADD COLUMN IF NOT EXISTS move_to_ledger_id UUID REFERENCES accounts(id);

-- The entry a move is about: its bank, amount, date, direction and state
CREATE OR REPLACE FUNCTION public.bank_move_entry(p_society_id UUID, p_type TEXT, p_id UUID)
RETURNS TABLE (from_ledger UUID, amount NUMERIC, entry_date DATE, money_in BOOLEAN, is_cash BOOLEAN, usable BOOLEAN, matched BOOLEAN) AS $$
    SELECT p.bank_ledger_id, p.amount, p.payment_date, true, p.payment_method = 'cash', p.status = 'verified',
           EXISTS (SELECT 1 FROM bank_transactions b WHERE b.reconciled_payment_id = p.id)
    FROM payments p WHERE p_type = 'payment' AND p.id = p_id AND p.society_id = p_society_id
    UNION ALL
    SELECT v.bank_ledger_id, v.amount, v.paid_on, false, v.mode = 'cash', v.status = 'recorded',
           EXISTS (SELECT 1 FROM bank_transactions b WHERE b.reconciled_vendor_payment_id = v.id)
    FROM vendor_payments v WHERE p_type = 'vendor_payment' AND v.id = p_id AND v.society_id = p_society_id
    UNION ALL
    SELECT c.bank_ledger_id, c.amount, c.paid_on, false, false, true,
           EXISTS (SELECT 1 FROM bank_transactions b WHERE b.reconciled_challan_id = c.id)
    FROM tds_challans c WHERE p_type = 'tds_challan' AND c.id = p_id AND c.society_id = p_society_id
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.propose_bank_move(
    p_society_id UUID, p_entity_type TEXT, p_entity_id UUID, p_to_ledger_id UUID, p_reason TEXT
)
RETURNS JSONB AS $$
DECLARE
    v_e RECORD;
    v_from_code TEXT;
    v_to_code TEXT;
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
    SELECT * INTO v_e FROM bank_move_entry(p_society_id, p_entity_type, p_entity_id);
    IF NOT FOUND OR NOT v_e.usable THEN
        RAISE EXCEPTION 'Entry not found';
    END IF;
    IF v_e.is_cash THEN
        RAISE EXCEPTION '%', CASE WHEN v_e.money_in THEN 'This was received in cash — there is no bank to move'
                                  ELSE 'This was paid in cash — there is no bank to move' END;
    END IF;
    IF p_to_ledger_id IS NULL OR NOT is_bank_ledger(p_society_id, p_to_ledger_id) THEN
        RAISE EXCEPTION 'Choose a bank ledger of this society';
    END IF;
    IF v_e.from_ledger = p_to_ledger_id THEN
        RAISE EXCEPTION 'It is already in %', (SELECT name FROM accounts WHERE id = p_to_ledger_id);
    END IF;
    IF v_e.matched THEN
        RAISE EXCEPTION 'Unlink it from the bank statement first';
    END IF;
    IF EXISTS (SELECT 1 FROM adjustment_proposals
               WHERE society_id = p_society_id AND status = 'pending' AND kind = 'bank_move' AND move_entity_id = p_entity_id) THEN
        RAISE EXCEPTION 'A move for this entry is already waiting for the committee';
    END IF;
    PERFORM check_adjustment_date(p_society_id, v_e.entry_date);

    SELECT code INTO v_from_code FROM accounts WHERE id = v_e.from_ledger;
    SELECT code INTO v_to_code FROM accounts WHERE id = p_to_ledger_id;
    v_lines := CASE WHEN v_e.money_in
        THEN jsonb_build_array(jsonb_build_object('code', v_to_code, 'amount', v_e.amount),
                               jsonb_build_object('code', v_from_code, 'amount', -v_e.amount))
        ELSE jsonb_build_array(jsonb_build_object('code', v_from_code, 'amount', v_e.amount),
                               jsonb_build_object('code', v_to_code, 'amount', -v_e.amount)) END;

    v_number := 'AP-' || lpad(next_society_number(p_society_id, 'adjustment_proposals', 'proposal_number', 'AP-')::text, 4, '0');
    INSERT INTO adjustment_proposals (society_id, proposal_number, kind, entry_date, reason, lines, proposed_by,
                                      move_entity_type, move_entity_id, move_from_ledger_id, move_to_ledger_id)
    VALUES (p_society_id, v_number, 'bank_move', v_e.entry_date, trim(p_reason), v_lines, auth.uid(),
            p_entity_type, p_entity_id, v_e.from_ledger, p_to_ledger_id)
    RETURNING id INTO v_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'adjustment.proposed', 'adjustment_proposal', v_id::text,
            jsonb_build_object('number', v_number, 'bank_move', jsonb_build_object('type', p_entity_type, 'id', p_entity_id,
                                                                                  'from', v_from_code, 'to', v_to_code),
                               'reason', trim(p_reason)));
    RETURN jsonb_build_object('id', v_id, 'proposal_number', v_number);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 023_bank_statement_ledgers.sql; + an approved bank move may re-point a verified payment
CREATE OR REPLACE FUNCTION public.trg_payment_bank()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.bank_ledger_id IS DISTINCT FROM OLD.bank_ledger_id AND OLD.status = 'verified'
       AND coalesce(current_setting('sahvaas.bank_move', true), '') <> 'on' THEN
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

-- from 027_ca_workspace.sql; + a bank_move proposal posts the move and re-points the entry's bank
CREATE OR REPLACE FUNCTION public.decide_adjustment(p_proposal_id UUID, p_approve BOOLEAN, p_note TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_p adjustment_proposals%ROWTYPE;
    v_exp expenses%ROWTYPE;
    v_journal UUID;
    v_who TEXT;
    v_pending INT;
    v_move RECORD;
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
    ELSIF p_approve AND v_p.kind = 'bank_move' THEN
        -- A bank move: the entry must still be as proposed; post the move, then re-point the entry
        SELECT * INTO v_move FROM bank_move_entry(v_p.society_id, v_p.move_entity_type, v_p.move_entity_id);
        IF NOT FOUND OR NOT v_move.usable OR v_move.matched OR v_move.from_ledger IS DISTINCT FROM v_p.move_from_ledger_id THEN
            RAISE EXCEPTION 'This entry has changed since the proposal — ask for a new one';
        END IF;
        SELECT full_name INTO v_who FROM profiles WHERE id = v_p.proposed_by;
        v_journal := post_journal(v_p.society_id, v_p.entry_date, 'adjustment.approved', v_p.id,
                                  v_p.proposal_number || ' (' || coalesce(v_who, 'CA') || '): ' || v_p.reason, v_p.lines);
        PERFORM set_config('sahvaas.bank_move', 'on', true);
        IF v_p.move_entity_type = 'payment' THEN
            UPDATE payments SET bank_ledger_id = v_p.move_to_ledger_id WHERE id = v_p.move_entity_id;
        ELSIF v_p.move_entity_type = 'vendor_payment' THEN
            UPDATE vendor_payments SET bank_ledger_id = v_p.move_to_ledger_id WHERE id = v_p.move_entity_id;
        ELSE
            UPDATE tds_challans SET bank_ledger_id = v_p.move_to_ledger_id WHERE id = v_p.move_entity_id;
        END IF;
        PERFORM set_config('sahvaas.bank_move', 'off', true);
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
-- PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.bank_move_entry(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.propose_bank_move(UUID, TEXT, UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.propose_bank_move(UUID, TEXT, UUID, UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.dispose_asset(UUID, DATE, NUMERIC, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispose_asset(UUID, DATE, NUMERIC, TEXT, TEXT, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.is_asset_ledger(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.asset_dep_rate(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.asset_ledgers(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_ledger_dep_rate(UUID, TEXT, NUMERIC) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.add_asset_ledger(UUID, TEXT, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.asset_ledgers(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_ledger_dep_rate(UUID, TEXT, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_asset_ledger(UUID, TEXT, NUMERIC) TO authenticated;
