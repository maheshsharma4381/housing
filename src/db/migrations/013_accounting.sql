-- ============================================================================
-- 013 ACCOUNTING CORE (P8)
--   1. Chart of accounts v2: GST input, vendor advances, fixed assets,
--      accumulated depreciation, professional fees, depreciation, software
--   2. Tax rules: tds_rules (platform, dated) and expense_categories
--      (platform defaults + society additions) -> ledger head + TDS nature
--   3. Vendors: PAN from GSTIN, entity type, lower-deduction certificate
--   4. Expenses: revenue vs capital, GST claimable, TDS suggestion + override
--      reason, invoice pending / no-invoice payment vouchers, duplicate check
--   5. suggest_tds(): category -> rule -> PAN entity -> yearly vendor total
--   6. Accrual: approval posts Dr expense/asset (+GST input) / Cr creditors and
--      creates the fixed asset; unpaid approved expenses are backfilled
--   7. Vendor payments (partial, TDS once), mark_expense_paid wrapper,
--      TDS challans, attach a pending invoice
--   8. void_expense v2: reverses payments and the accrual
--   9. Fixed assets: register, opening assets, depreciation preview / post,
--      disposal, rate changes
-- ============================================================================

-- ============================================================================
-- 1. CHART OF ACCOUNTS v2
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
        ('1300', 'GST Input Credit', 'asset'),
        ('1400', 'Advances & Deposits to Vendors', 'asset'),
        ('1500', 'Plant & Machinery', 'asset'),
        ('1510', 'Electrical Installations', 'asset'),
        ('1520', 'Furniture & Fixtures', 'asset'),
        ('1530', 'Computers & Equipment', 'asset'),
        ('1540', 'CCTV & Security Equipment', 'asset'),
        ('1550', 'Building Improvements', 'asset'),
        ('1590', 'Accumulated Depreciation', 'asset'),
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
        ('4300', 'Gain / Loss on Sale of Assets', 'income'),
        ('5000', 'Repairs & Maintenance', 'expense'),
        ('5100', 'Security Charges', 'expense'),
        ('5200', 'Housekeeping', 'expense'),
        ('5300', 'Electricity (Common Areas)', 'expense'),
        ('5400', 'Water Charges', 'expense'),
        ('5600', 'Professional & Audit Fees', 'expense'),
        ('5700', 'Property Tax', 'expense'),
        ('5800', 'Depreciation', 'expense'),
        ('5850', 'Software & Subscriptions', 'expense'),
        ('5900', 'Other Expenses', 'expense')
    ) AS a(code, name, type)
    ON CONFLICT (society_id, code) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT id FROM societies LOOP
        PERFORM ensure_default_accounts(r.id);
    END LOOP;
END
$$;

-- create_society() seeds the original 19 accounts; this tops up new ones at commit
CREATE OR REPLACE FUNCTION public.trg_society_default_accounts()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM societies WHERE id = NEW.id) THEN
        PERFORM ensure_default_accounts(NEW.id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_society_default_accounts ON societies;
CREATE CONSTRAINT TRIGGER trg_society_default_accounts
    AFTER INSERT ON societies
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.trg_society_default_accounts();

-- ============================================================================
-- 2. TAX RULES
-- ============================================================================
CREATE TABLE IF NOT EXISTS tds_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nature VARCHAR(32) NOT NULL CHECK (nature IN ('contract', 'professional', 'technical', 'rent_building', 'rent_machinery')),
    label VARCHAR(96) NOT NULL,
    section_label VARCHAR(32) NOT NULL,           -- editable: the Income-tax Act, 2025 renumbers sections
    rate_individual NUMERIC(5,2) NOT NULL CHECK (rate_individual BETWEEN 0 AND 100),
    rate_other NUMERIC(5,2) NOT NULL CHECK (rate_other BETWEEN 0 AND 100),
    single_bill_limit NUMERIC(14,2),              -- TDS when one bill is above this
    annual_limit NUMERIC(14,2),                   -- ... or the vendor's FY total is above this
    effective_from DATE NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    updated_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_tds_rule_nature_from UNIQUE (nature, effective_from)
);

-- Defaults: rates as amended by the Finance Act 2025. Confirm with a CA before go-live.
INSERT INTO tds_rules (nature, label, section_label, rate_individual, rate_other, single_bill_limit, annual_limit, effective_from) VALUES
    ('contract',       'Contract work',          '194C', 1,  2,  30000, 100000, '2025-04-01'),
    ('professional',   'Professional fees',      '194J', 10, 10, NULL,  50000,  '2025-04-01'),
    ('technical',      'Technical services',     '194J', 2,  2,  NULL,  50000,  '2025-04-01'),
    ('rent_building',  'Rent — building / hall', '194I', 10, 10, 50000, NULL,   '2025-04-01'),
    ('rent_machinery', 'Rent — machinery',       '194I', 2,  2,  50000, NULL,   '2025-04-01')
ON CONFLICT (nature, effective_from) DO NOTHING;

INSERT INTO platform_settings (key, value, description) VALUES
    ('tds_no_pan_rate', '{"rate": 20}', 'TDS rate when the vendor has no PAN (206AA)')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE tds_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tds_rules_select ON tds_rules;
DROP POLICY IF EXISTS tds_rules_platform_write ON tds_rules;
CREATE POLICY tds_rules_select ON tds_rules FOR SELECT TO authenticated USING (true);
CREATE POLICY tds_rules_platform_write ON tds_rules
    FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());

CREATE TABLE IF NOT EXISTS expense_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID REFERENCES societies(id) ON DELETE CASCADE,   -- NULL = Sahvaas default
    key VARCHAR(48) NOT NULL CHECK (key ~ '^[a-z0-9_]+$'),
    label VARCHAR(96) NOT NULL,
    account_code VARCHAR(32) NOT NULL,             -- head when booked as an expense
    asset_account_code VARCHAR(32) CHECK (asset_account_code IN ('1500', '1510', '1520', '1530', '1540', '1550')),
    asset_threshold NUMERIC(14,2),                 -- suggest "asset" at or above this amount
    tds_nature VARCHAR(32) NOT NULL DEFAULT 'none'
        CHECK (tds_nature IN ('none', 'goods', 'contract', 'professional', 'technical', 'rent_building', 'rent_machinery')),
    sort_order INT NOT NULL DEFAULT 100,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_category_key
    ON expense_categories (coalesce(society_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

INSERT INTO expense_categories (society_id, key, label, account_code, asset_account_code, asset_threshold, tds_nature, sort_order)
SELECT NULL, c.key, c.label, c.account_code, c.asset_code, c.threshold, c.nature, c.sort_order
FROM (VALUES
    ('security',      'Security',                    '5100', NULL,   NULL::numeric, 'contract',     10),
    ('housekeeping',  'Housekeeping',                '5200', NULL,   NULL,          'contract',     20),
    ('gardening',     'Gardening',                   '5200', NULL,   NULL,          'contract',     30),
    ('pest_control',  'Pest control',                '5200', NULL,   NULL,          'contract',     40),
    ('electricity',   'Electricity (common)',        '5300', NULL,   NULL,          'none',         50),
    ('water',         'Water',                       '5400', NULL,   NULL,          'none',         60),
    ('repairs',       'Repairs & maintenance',       '5000', NULL,   NULL,          'contract',     70),
    ('plumbing',      'Plumbing',                    '5000', NULL,   NULL,          'contract',     80),
    ('electrical',    'Electrical work',             '5000', '1510', 25000,         'contract',     90),
    ('painting',      'Painting',                    '5000', NULL,   NULL,          'contract',    100),
    ('lift_amc',      'Lift AMC',                    '5000', NULL,   NULL,          'contract',    110),
    ('cctv',          'CCTV / security equipment',   '5000', '1540', 25000,         'contract',    120),
    ('pump_motor',    'Pump / motor',                '5000', '1500', 25000,         'contract',    130),
    ('generator',     'Generator',                   '5000', '1500', 25000,         'contract',    140),
    ('furniture',     'Furniture',                   '5900', '1520', 25000,         'goods',       150),
    ('computers',     'Computers / equipment',       '5900', '1530', 25000,         'goods',       160),
    ('building_works','Major building works',        '5000', '1550', 25000,         'contract',    170),
    ('legal_audit',   'Legal / audit fees',          '5600', NULL,   NULL,          'professional',180),
    ('professional',  'Architect / consultant fees', '5600', NULL,   NULL,          'professional',190),
    ('property_tax',  'Property tax',                '5700', NULL,   NULL,          'none',        200),
    ('software',      'Software & subscriptions',    '5850', NULL,   NULL,          'none',        210),
    ('bank_charges',  'Bank charges',                '5900', NULL,   NULL,          'none',        220),
    ('other',         'Other',                       '5900', NULL,   NULL,          'none',        900)
) AS c(key, label, account_code, asset_code, threshold, nature, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM expense_categories e WHERE e.society_id IS NULL AND e.key = c.key);

ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS expense_categories_select ON expense_categories;
DROP POLICY IF EXISTS expense_categories_write ON expense_categories;
CREATE POLICY expense_categories_select ON expense_categories
    FOR SELECT USING (
        society_id IS NULL OR is_platform_admin() OR is_committee_viewer(society_id)
        OR has_professional_permission(society_id, 'view_expenses')
    );
CREATE POLICY expense_categories_write ON expense_categories
    FOR ALL USING (
        (society_id IS NULL AND is_platform_admin())
        OR (society_id IS NOT NULL AND (is_platform_admin() OR is_society_admin(society_id)))
    )
    WITH CHECK (
        (society_id IS NULL AND is_platform_admin())
        OR (society_id IS NOT NULL AND (is_platform_admin() OR is_society_admin(society_id)))
    );

-- A society's own category wins over the Sahvaas default with the same key
CREATE OR REPLACE FUNCTION public.resolve_expense_category(p_society_id UUID, p_key TEXT)
RETURNS expense_categories AS $$
    SELECT * FROM expense_categories
    WHERE key = p_key AND is_active AND (society_id = p_society_id OR society_id IS NULL)
    ORDER BY society_id NULLS LAST
    LIMIT 1
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. VENDORS: PAN, ENTITY TYPE, LOWER-DEDUCTION CERTIFICATE
-- ============================================================================
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS tds_override_rate NUMERIC(5,2) CHECK (tds_override_rate BETWEEN 0 AND 100);
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS tds_certificate_no VARCHAR(64);
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS tds_override_valid_till DATE;

-- PAN as given, else characters 3-12 of the GSTIN
CREATE OR REPLACE FUNCTION public.vendor_pan(p_pan TEXT, p_gstin TEXT)
RETURNS TEXT AS $$
    SELECT CASE
        WHEN upper(trim(coalesce(p_pan, ''))) ~ '^[A-Z]{5}[0-9]{4}[A-Z]$' THEN upper(trim(p_pan))
        WHEN upper(trim(coalesce(p_gstin, ''))) ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$' THEN substr(upper(trim(p_gstin)), 3, 10)
        ELSE NULL
    END
$$ LANGUAGE sql IMMUTABLE;

-- 4th letter of a PAN: P (person) and H (HUF) take the individual rate; C, F, A, T ... the other rate
CREATE OR REPLACE FUNCTION public.pan_entity(p_pan TEXT)
RETURNS TEXT AS $$
    SELECT CASE WHEN p_pan IS NULL THEN NULL WHEN substr(p_pan, 4, 1) IN ('P', 'H') THEN 'individual' ELSE 'other' END
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.vendors_normalise()
RETURNS TRIGGER AS $$
BEGIN
    NEW.gstin := nullif(upper(trim(coalesce(NEW.gstin, ''))), '');
    NEW.pan := coalesce(vendor_pan(NEW.pan, NULL), vendor_pan(NULL, NEW.gstin), nullif(upper(trim(coalesce(NEW.pan, ''))), ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_vendors_normalise ON vendors;
CREATE TRIGGER trg_vendors_normalise BEFORE INSERT OR UPDATE ON vendors
    FOR EACH ROW EXECUTE FUNCTION public.vendors_normalise();

-- ============================================================================
-- 4. EXPENSES: CLASSIFICATION, TDS, INVOICE STATUS, VOUCHERS
-- ============================================================================
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS expense_type VARCHAR(16) NOT NULL DEFAULT 'revenue'
    CHECK (expense_type IN ('revenue', 'capital'));
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS asset_account_code VARCHAR(32);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS asset_location VARCHAR(128);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS funded_from VARCHAR(16) NOT NULL DEFAULT 'general'
    CHECK (funded_from IN ('general', 'sinking_fund', 'repair_fund'));
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS gst_claimable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tds_nature VARCHAR(32);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tds_section VARCHAR(32);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tds_rate NUMERIC(5,2);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tds_rule_id UUID REFERENCES tds_rules(id);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tds_suggested NUMERIC(12,2);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tds_override_reason TEXT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS invoice_status VARCHAR(16) NOT NULL DEFAULT 'invoice'
    CHECK (invoice_status IN ('invoice', 'pending', 'none'));
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS invoice_due_by DATE;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS voucher_number VARCHAR(32);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payee_name VARCHAR(128);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payee_phone VARCHAR(32);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS extraction JSONB;       -- what the invoice reader returned (audit)
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS amount_settled NUMERIC(12,2) NOT NULL DEFAULT 0;  -- paid + TDS so far
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tds_deducted NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_payment_status_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_payment_status_check CHECK (payment_status IN ('unpaid', 'partial', 'paid'));

-- Legacy rows that were already paid count as fully settled
UPDATE expenses SET amount_settled = subtotal + gst_amount, tds_deducted = tds_amount
WHERE (status = 'paid' OR payment_status = 'paid') AND amount_settled = 0;

ALTER TABLE society_settings ADD COLUMN IF NOT EXISTS voucher_cash_limit NUMERIC(12,2) NOT NULL DEFAULT 5000
    CHECK (voucher_cash_limit >= 0);

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
        IF NEW.asset_account_code IS NULL OR NEW.asset_account_code NOT IN ('1500', '1510', '1520', '1530', '1540', '1550') THEN
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

DROP TRIGGER IF EXISTS trg_expenses_accounting_checks ON expenses;
CREATE TRIGGER trg_expenses_accounting_checks
    BEFORE INSERT OR UPDATE ON expenses
    FOR EACH ROW EXECUTE FUNCTION public.expenses_accounting_checks();

-- ============================================================================
-- 5. TDS SUGGESTION
--    Returns { applies, nature, section, label, rate, amount, base, rule_id,
--              pan, entity, rate_source, reason, fy_total, single_limit, annual_limit }
--    reason: no_category | no_tds | goods | no_rule | below_limits | single_bill | annual_total
-- ============================================================================
CREATE OR REPLACE FUNCTION public.suggest_tds(
    p_society_id UUID,
    p_vendor_id UUID,
    p_category TEXT,
    p_taxable NUMERIC,
    p_invoice_date DATE DEFAULT NULL,
    p_expense_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_date DATE := coalesce(p_invoice_date, current_date);
    v_taxable NUMERIC := round(coalesce(p_taxable, 0), 2);
    v_cat expense_categories;
    v_rule tds_rules%ROWTYPE;
    v_vendor vendors%ROWTYPE;
    v_pan TEXT;
    v_entity TEXT;
    v_rate NUMERIC;
    v_rate_source TEXT;
    v_fy_start DATE;
    v_prior NUMERIC := 0;
    v_prior_untaxed NUMERIC := 0;
    v_base NUMERIC;
    v_reason TEXT := 'below_limits';
    v_applies BOOLEAN := false;
    v_amount NUMERIC := 0;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can work out TDS';
    END IF;

    v_cat := resolve_expense_category(p_society_id, p_category);
    IF v_cat.id IS NULL THEN
        RETURN jsonb_build_object('applies', false, 'amount', 0, 'rate', 0, 'nature', 'none', 'reason', 'no_category');
    END IF;
    IF v_cat.tds_nature IN ('none', 'goods') THEN
        RETURN jsonb_build_object('applies', false, 'amount', 0, 'rate', 0, 'nature', v_cat.tds_nature,
                                  'reason', CASE WHEN v_cat.tds_nature = 'goods' THEN 'goods' ELSE 'no_tds' END);
    END IF;

    SELECT * INTO v_rule FROM tds_rules
    WHERE nature = v_cat.tds_nature AND is_active AND effective_from <= v_date
    ORDER BY effective_from DESC LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('applies', false, 'amount', 0, 'rate', 0, 'nature', v_cat.tds_nature, 'reason', 'no_rule');
    END IF;

    IF p_vendor_id IS NOT NULL THEN
        SELECT * INTO v_vendor FROM vendors WHERE id = p_vendor_id AND society_id = p_society_id;
    END IF;
    v_pan := vendor_pan(v_vendor.pan, v_vendor.gstin);
    v_entity := pan_entity(v_pan);

    -- The vendor's total for the Indian financial year (April-March) of the invoice
    v_fy_start := make_date(extract(year FROM v_date)::int - CASE WHEN extract(month FROM v_date) < 4 THEN 1 ELSE 0 END, 4, 1);
    IF v_vendor.id IS NOT NULL THEN
        SELECT coalesce(sum(subtotal), 0), coalesce(sum(subtotal) FILTER (WHERE tds_amount = 0), 0)
        INTO v_prior, v_prior_untaxed
        FROM expenses
        WHERE society_id = p_society_id AND vendor_id = v_vendor.id
          AND status NOT IN ('voided', 'rejected', 'draft')
          AND coalesce(invoice_date, created_at::date) >= v_fy_start
          AND coalesce(invoice_date, created_at::date) < (v_fy_start + interval '1 year')::date
          AND (p_expense_id IS NULL OR id <> p_expense_id);
    END IF;

    v_base := v_taxable;
    IF v_rule.single_bill_limit IS NOT NULL AND v_taxable > v_rule.single_bill_limit THEN
        v_applies := true;
        v_reason := 'single_bill';
    END IF;
    IF v_rule.annual_limit IS NOT NULL AND v_prior + v_taxable > v_rule.annual_limit THEN
        IF NOT v_applies THEN
            v_reason := 'annual_total';
            -- Crossing the yearly limit: TDS also covers this year's earlier bills that had none
            v_base := v_taxable + v_prior_untaxed;
        END IF;
        v_applies := true;
    END IF;

    IF v_vendor.tds_override_rate IS NOT NULL
       AND (v_vendor.tds_override_valid_till IS NULL OR v_vendor.tds_override_valid_till >= v_date) THEN
        v_rate := v_vendor.tds_override_rate;
        v_rate_source := 'certificate';
    ELSIF v_pan IS NULL THEN
        SELECT coalesce((value ->> 'rate')::numeric, 20) INTO v_rate FROM platform_settings WHERE key = 'tds_no_pan_rate';
        v_rate := coalesce(v_rate, 20);
        v_rate_source := 'no_pan';
    ELSE
        v_rate := CASE WHEN v_entity = 'individual' THEN v_rule.rate_individual ELSE v_rule.rate_other END;
        v_rate_source := v_entity;
    END IF;

    IF v_applies THEN
        v_amount := least(round(v_base * v_rate / 100, 0), v_taxable);
    END IF;

    RETURN jsonb_build_object(
        'applies', v_applies,
        'nature', v_cat.tds_nature,
        'section', v_rule.section_label,
        'label', v_rule.label,
        'rate', CASE WHEN v_applies THEN v_rate ELSE 0 END,
        'amount', v_amount,
        'base', CASE WHEN v_applies THEN v_base ELSE 0 END,
        'rule_id', v_rule.id,
        'pan', v_pan,
        'entity', v_entity,
        'rate_source', v_rate_source,
        'reason', v_reason,
        'fy_total', v_prior + v_taxable,
        'single_limit', v_rule.single_bill_limit,
        'annual_limit', v_rule.annual_limit
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 6. ACCRUAL ON APPROVAL + FIXED ASSET CREATION
-- ============================================================================
CREATE OR REPLACE FUNCTION public.expense_debit_code(p_society_id UUID, p_category TEXT, p_type TEXT, p_asset_code TEXT)
RETURNS TEXT AS $$
    SELECT CASE
        WHEN p_type = 'capital' THEN p_asset_code
        ELSE coalesce((resolve_expense_category(p_society_id, p_category)).account_code, expense_account_code(p_category))
    END
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE TABLE IF NOT EXISTS fixed_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    asset_number VARCHAR(32) NOT NULL,
    name VARCHAR(191) NOT NULL,
    account_code VARCHAR(32) NOT NULL CHECK (account_code IN ('1500', '1510', '1520', '1530', '1540', '1550')),
    expense_id UUID UNIQUE REFERENCES expenses(id),
    vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
    put_to_use_date DATE NOT NULL,
    cost NUMERIC(14,2) NOT NULL CHECK (cost >= 0),
    opening_wdv NUMERIC(14,2) CHECK (opening_wdv >= 0),    -- assets brought in with the opening balances
    opening_as_of DATE,
    location VARCHAR(128),
    funded_from VARCHAR(16) NOT NULL DEFAULT 'general' CHECK (funded_from IN ('general', 'sinking_fund', 'repair_fund')),
    dep_method VARCHAR(8) NOT NULL DEFAULT 'wdv' CHECK (dep_method IN ('wdv', 'slm')),
    dep_rate NUMERIC(5,2) NOT NULL CHECK (dep_rate BETWEEN 0 AND 100),
    status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disposed', 'voided')),
    disposed_on DATE,
    disposal_amount NUMERIC(14,2),
    notes TEXT,
    created_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_asset_number UNIQUE (society_id, asset_number)
);
CREATE INDEX IF NOT EXISTS idx_fixed_assets_society ON fixed_assets (society_id, status);

-- Income-tax WDV rates as defaults; the committee can change a rate (logged)
CREATE OR REPLACE FUNCTION public.default_dep_rate(p_code TEXT)
RETURNS NUMERIC AS $$
    SELECT CASE p_code
        WHEN '1500' THEN 15 WHEN '1510' THEN 10 WHEN '1520' THEN 10
        WHEN '1530' THEN 40 WHEN '1540' THEN 15 WHEN '1550' THEN 10 ELSE 10
    END::numeric
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.ledger_post_expense_accrual(p_expense_id UUID)
RETURNS UUID AS $$
DECLARE
    v_exp expenses%ROWTYPE;
    v_vendor TEXT;
    v_gst_input NUMERIC;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id;
    IF NOT FOUND OR v_exp.status NOT IN ('approved', 'paid') THEN
        RETURN NULL;
    END IF;
    -- Expenses paid before accrual accounting were posted on payment (cash basis)
    IF EXISTS (SELECT 1 FROM journal_entries WHERE society_id = v_exp.society_id
               AND reference_event_type = 'expense.paid' AND reference_event_id = v_exp.id) THEN
        RETURN NULL;
    END IF;
    SELECT name INTO v_vendor FROM vendors WHERE id = v_exp.vendor_id;
    v_gst_input := CASE WHEN v_exp.gst_claimable THEN v_exp.gst_amount ELSE 0 END;

    RETURN post_journal(
        v_exp.society_id, coalesce(v_exp.invoice_date, v_exp.approved_at::date, current_date), 'expense.approved', v_exp.id,
        coalesce(v_exp.voucher_number, v_exp.expense_number) || ': ' || v_exp.title || coalesce(' (' || v_vendor || ')', coalesce(' (' || v_exp.payee_name || ')', '')),
        jsonb_build_array(
            jsonb_build_object('code', expense_debit_code(v_exp.society_id, v_exp.category, v_exp.expense_type, v_exp.asset_account_code),
                               'amount', v_exp.subtotal + v_exp.gst_amount - v_gst_input),
            jsonb_build_object('code', '1300', 'amount', v_gst_input),
            jsonb_build_object('code', '2000', 'amount', -(v_exp.subtotal + v_exp.gst_amount))
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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
            v_exp.asset_location, v_exp.funded_from, default_dep_rate(v_exp.asset_account_code), v_exp.approved_by)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.trg_expense_approved()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'approved' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'approved') THEN
        PERFORM ledger_post_expense_accrual(NEW.id);
        PERFORM create_asset_for_expense(NEW.id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_expense_approved ON expenses;
CREATE TRIGGER trg_expense_approved
    AFTER INSERT OR UPDATE OF status ON expenses
    FOR EACH ROW EXECUTE FUNCTION public.trg_expense_approved();

-- Cash-basis posting stays only for legacy rows; accrued expenses post per payment
CREATE OR REPLACE FUNCTION public.ledger_post_expense(p_expense_id UUID)
RETURNS UUID AS $$
DECLARE
    v_exp expenses%ROWTYPE;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id;
    IF NOT FOUND OR NOT (v_exp.status = 'paid' OR v_exp.payment_status = 'paid') THEN
        RETURN NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM journal_entries WHERE society_id = v_exp.society_id
               AND reference_event_type = 'expense.approved' AND reference_event_id = v_exp.id) THEN
        RETURN NULL;
    END IF;
    RETURN post_journal(
        v_exp.society_id, coalesce(v_exp.paid_date, v_exp.invoice_date, current_date), 'expense.paid', v_exp.id,
        'Expense ' || v_exp.expense_number || ': ' || v_exp.title,
        jsonb_build_array(
            jsonb_build_object('code', expense_debit_code(v_exp.society_id, v_exp.category, v_exp.expense_type, v_exp.asset_account_code),
                               'amount', v_exp.net_payable + v_exp.tds_amount),
            jsonb_build_object('code', '1000', 'amount', -v_exp.net_payable),
            jsonb_build_object('code', '2200', 'amount', -v_exp.tds_amount)
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Backfill: approved-but-unpaid expenses become payables now
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT e.id FROM expenses e
        WHERE e.status = 'approved' AND e.payment_status = 'unpaid'
          AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.society_id = e.society_id AND j.reference_event_id = e.id)
    LOOP
        PERFORM ledger_post_expense_accrual(r.id);
    END LOOP;
END
$$;

-- ============================================================================
-- 7. VENDOR PAYMENTS, TDS CHALLANS, PENDING INVOICES
-- ============================================================================
CREATE TABLE IF NOT EXISTS vendor_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    expense_id UUID NOT NULL REFERENCES expenses(id),
    payment_number VARCHAR(32) NOT NULL,
    paid_on DATE NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),          -- money that left the bank / cash
    tds_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tds_amount >= 0),
    mode VARCHAR(16) NOT NULL CHECK (mode IN ('neft', 'upi', 'cheque', 'cash')),
    reference VARCHAR(128),
    bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,
    proof_url TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'voided')),
    created_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_vendor_payment UNIQUE (society_id, payment_number),
    CONSTRAINT chk_vendor_payment_positive CHECK (amount + tds_amount > 0),
    CONSTRAINT chk_vendor_payment_proof_in_society CHECK (proof_url IS NULL OR proof_url LIKE society_id::text || '/%')
);
CREATE INDEX IF NOT EXISTS idx_vendor_payments_expense ON vendor_payments (expense_id);

CREATE TABLE IF NOT EXISTS tds_challans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    challan_number VARCHAR(64) NOT NULL,
    paid_on DATE NOT NULL,
    period_month DATE NOT NULL,                     -- first day of the month the TDS relates to
    section_label VARCHAR(32),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    reference VARCHAR(128),
    created_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_tds_challan UNIQUE (society_id, challan_number)
);

ALTER TABLE vendor_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tds_challans ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vendor_payments_select ON vendor_payments;
DROP POLICY IF EXISTS tds_challans_select ON tds_challans;
DROP POLICY IF EXISTS fixed_assets_select ON fixed_assets;
CREATE POLICY vendor_payments_select ON vendor_payments
    FOR SELECT USING (is_platform_admin() OR is_committee_viewer(society_id) OR has_professional_permission(society_id, 'view_expenses'));
CREATE POLICY tds_challans_select ON tds_challans
    FOR SELECT USING (is_platform_admin() OR is_committee_viewer(society_id) OR has_professional_permission(society_id, 'view_expenses')
                      OR has_professional_permission(society_id, 'view_ledger'));
CREATE POLICY fixed_assets_select ON fixed_assets
    FOR SELECT USING (is_platform_admin() OR is_committee_viewer(society_id) OR has_professional_permission(society_id, 'view_expenses')
                      OR can_view_financials(society_id));
-- No write policies: these tables change only through the functions below

CREATE OR REPLACE FUNCTION public.record_vendor_payment(
    p_expense_id UUID,
    p_amount NUMERIC,
    p_tds NUMERIC DEFAULT NULL,
    p_mode TEXT DEFAULT 'neft',
    p_reference TEXT DEFAULT NULL,
    p_paid_on DATE DEFAULT NULL,
    p_proof_url TEXT DEFAULT NULL,
    p_bank_account_id UUID DEFAULT NULL
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
                                 bank_account_id, proof_url, created_by)
    VALUES (v_exp.society_id, v_exp.id, v_number, v_paid_on, v_amount, v_tds, v_mode,
            nullif(trim(coalesce(p_reference, '')), ''), p_bank_account_id, p_proof_url, auth.uid())
    RETURNING id INTO v_id;

    PERFORM post_journal(
        v_exp.society_id, v_paid_on, 'vendor_payment.recorded', v_id,
        'Payment ' || v_number || ' for ' || coalesce(v_exp.voucher_number, v_exp.expense_number) || ' (' || upper(v_mode)
            || coalesce(' ' || nullif(trim(coalesce(p_reference, '')), ''), '') || ')',
        jsonb_build_array(
            jsonb_build_object('code', '2000', 'amount', v_settle),
            jsonb_build_object('code', CASE WHEN v_mode = 'cash' THEN '1100' ELSE '1000' END, 'amount', -v_amount),
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

-- Kept for existing callers: pays whatever is still payable in one go
CREATE OR REPLACE FUNCTION public.mark_expense_paid(p_expense_id UUID, p_paid_date DATE DEFAULT current_date, p_reference TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_exp expenses%ROWTYPE;
    v_tds_left NUMERIC;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_exp.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can record expense payments';
    END IF;
    v_tds_left := v_exp.tds_amount - v_exp.tds_deducted;
    PERFORM record_vendor_payment(p_expense_id,
                                  v_exp.subtotal + v_exp.gst_amount - v_exp.amount_settled - v_tds_left,
                                  v_tds_left, 'neft', p_reference, coalesce(p_paid_date, current_date));
    RETURN jsonb_build_object('status', 'paid', 'net_payable', v_exp.net_payable);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.record_tds_challan(
    p_society_id UUID,
    p_challan_number TEXT,
    p_amount NUMERIC,
    p_paid_on DATE,
    p_period_month DATE,
    p_section TEXT DEFAULT NULL,
    p_reference TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_payable NUMERIC;
    v_amount NUMERIC := round(coalesce(p_amount, 0), 2);
    v_id UUID;
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

    INSERT INTO tds_challans (society_id, challan_number, paid_on, period_month, section_label, amount, reference, created_by)
    VALUES (p_society_id, trim(p_challan_number), p_paid_on, date_trunc('month', coalesce(p_period_month, p_paid_on))::date,
            nullif(trim(coalesce(p_section, '')), ''), v_amount, nullif(trim(coalesce(p_reference, '')), ''), auth.uid())
    RETURNING id INTO v_id;

    PERFORM post_journal(p_society_id, p_paid_on, 'tds.deposited', v_id,
                         'TDS deposited, challan ' || trim(p_challan_number),
                         jsonb_build_array(
                             jsonb_build_object('code', '2200', 'amount', v_amount),
                             jsonb_build_object('code', '1000', 'amount', -v_amount)
                         ));

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'tds.deposited', 'tds_challan', v_id::text,
            jsonb_build_object('challan', trim(p_challan_number), 'amount', v_amount));

    RETURN jsonb_build_object('id', v_id, 'remaining', round(v_payable - v_amount, 2));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- "Invoice comes later": attach it once it arrives (allowed even after payment)
CREATE OR REPLACE FUNCTION public.attach_expense_invoice(
    p_expense_id UUID, p_document_url TEXT, p_invoice_number TEXT DEFAULT NULL, p_invoice_date DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_exp expenses%ROWTYPE;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_exp.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can attach invoices';
    END IF;
    IF v_exp.invoice_status <> 'pending' THEN
        RAISE EXCEPTION 'This expense is not waiting for an invoice';
    END IF;
    IF p_document_url IS NULL OR p_document_url NOT LIKE v_exp.society_id::text || '/%' THEN
        RAISE EXCEPTION 'Upload the invoice file first';
    END IF;

    PERFORM set_config('sahvaas.expense_workflow', 'on', true);
    UPDATE expenses
    SET document_url = p_document_url,
        invoice_number = coalesce(nullif(trim(coalesce(p_invoice_number, '')), ''), invoice_number),
        invoice_date = coalesce(p_invoice_date, invoice_date),
        invoice_status = 'invoice',
        updated_at = timezone('utc'::text, now())
    WHERE id = p_expense_id;
    PERFORM set_config('sahvaas.expense_workflow', 'off', true);

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_exp.society_id, auth.uid(), 'expense.invoice_attached', 'expense', p_expense_id::text,
            jsonb_build_object('invoice_number', p_invoice_number, 'document', p_document_url));
    RETURN jsonb_build_object('status', 'attached');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 8. VOID v2: reverse payments, then the accrual (or the legacy cash entry)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.void_expense(p_expense_id UUID, p_reason TEXT)
RETURNS JSONB AS $$
DECLARE
    v_exp expenses%ROWTYPE;
    v_vp RECORD;
    v_asset fixed_assets%ROWTYPE;
    v_reversed BOOLEAN := false;
    v_reason TEXT := trim(coalesce(p_reason, ''));
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_exp.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can void expenses';
    END IF;
    IF length(v_reason) = 0 THEN
        RAISE EXCEPTION 'A reason is required to void an expense';
    END IF;
    IF v_exp.status = 'voided' THEN
        RAISE EXCEPTION 'Expense is already voided';
    END IF;

    SELECT * INTO v_asset FROM fixed_assets WHERE expense_id = p_expense_id;
    IF FOUND THEN
        IF EXISTS (SELECT 1 FROM depreciation_lines WHERE asset_id = v_asset.id) THEN
            RAISE EXCEPTION 'Depreciation is already posted on asset %; record a disposal instead', v_asset.asset_number;
        END IF;
        IF v_asset.status = 'disposed' THEN
            RAISE EXCEPTION 'Asset % is already disposed', v_asset.asset_number;
        END IF;
        UPDATE fixed_assets SET status = 'voided', updated_at = timezone('utc'::text, now()) WHERE id = v_asset.id;
    END IF;

    FOR v_vp IN SELECT * FROM vendor_payments WHERE expense_id = p_expense_id AND status = 'recorded' ORDER BY created_at LOOP
        PERFORM ledger_reverse(v_exp.society_id, 'vendor_payment.recorded', v_vp.id, 'vendor_payment.voided', current_date,
                               'Payment ' || v_vp.payment_number || ' reversed: ' || v_reason);
        UPDATE vendor_payments SET status = 'voided' WHERE id = v_vp.id;
        v_reversed := true;
    END LOOP;

    IF ledger_reverse(v_exp.society_id, 'expense.approved', v_exp.id, 'expense.voided', current_date,
                      coalesce(v_exp.voucher_number, v_exp.expense_number) || ' voided: ' || v_reason) IS NOT NULL THEN
        v_reversed := true;
    END IF;
    IF ledger_reverse(v_exp.society_id, 'expense.paid', v_exp.id, 'expense.voided', current_date,
                      'Expense ' || v_exp.expense_number || ' voided: ' || v_reason) IS NOT NULL THEN
        v_reversed := true;
    END IF;

    PERFORM set_config('sahvaas.expense_workflow', 'on', true);
    UPDATE expenses SET status = 'voided', updated_at = timezone('utc'::text, now()) WHERE id = p_expense_id;
    PERFORM set_config('sahvaas.expense_workflow', 'off', true);

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, reason)
    VALUES (v_exp.society_id, auth.uid(), 'expense.voided', 'expense', p_expense_id::text,
            jsonb_build_object('expense_number', v_exp.expense_number, 'status', v_exp.status, 'net_payable', v_exp.net_payable,
                               'amount_settled', v_exp.amount_settled), v_reason);

    RETURN jsonb_build_object('status', 'voided', 'reversed', v_reversed);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 9. FIXED ASSETS: OPENING ASSETS, DEPRECIATION, DISPOSAL
-- ============================================================================
CREATE TABLE IF NOT EXISTS depreciation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    fy_start DATE NOT NULL,
    fy_end DATE NOT NULL,
    total NUMERIC(14,2) NOT NULL,
    posted_by UUID REFERENCES profiles(id),
    posted_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_depreciation_fy UNIQUE (society_id, fy_end)
);

CREATE TABLE IF NOT EXISTS depreciation_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES depreciation_runs(id) ON DELETE CASCADE,
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    asset_id UUID NOT NULL REFERENCES fixed_assets(id),
    opening_wdv NUMERIC(14,2) NOT NULL,
    additions NUMERIC(14,2) NOT NULL,
    rate NUMERIC(5,2) NOT NULL,
    half_rate BOOLEAN NOT NULL,
    amount NUMERIC(14,2) NOT NULL,
    closing_wdv NUMERIC(14,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_depreciation_lines_asset ON depreciation_lines (asset_id);

ALTER TABLE depreciation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE depreciation_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS depreciation_runs_select ON depreciation_runs;
DROP POLICY IF EXISTS depreciation_lines_select ON depreciation_lines;
CREATE POLICY depreciation_runs_select ON depreciation_runs
    FOR SELECT USING (is_platform_admin() OR is_committee_viewer(society_id) OR can_view_financials(society_id)
                      OR has_professional_permission(society_id, 'view_expenses'));
CREATE POLICY depreciation_lines_select ON depreciation_lines
    FOR SELECT USING (is_platform_admin() OR is_committee_viewer(society_id) OR can_view_financials(society_id)
                      OR has_professional_permission(society_id, 'view_expenses'));

-- Existing assets: their value must already be in the opening balances (no journal here)
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
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
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
    IF NOT (is_platform_admin() OR is_society_admin(v_asset.society_id)) THEN
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

-- WDV at the start of the year, additions during it, depreciation for it.
-- Additions used for less than 180 days in the year get half the rate.
CREATE OR REPLACE FUNCTION public.preview_depreciation(p_society_id UUID, p_fy_end DATE)
RETURNS TABLE (
    asset_id UUID, asset_number TEXT, name TEXT, account_code TEXT, put_to_use_date DATE,
    opening_wdv NUMERIC, additions NUMERIC, rate NUMERIC, half_rate BOOLEAN, depreciation NUMERIC, closing_wdv NUMERIC
) AS $$
DECLARE
    v_start DATE;
BEGIN
    IF NOT (is_platform_admin() OR can_view_financials(p_society_id) OR has_professional_permission(p_society_id, 'view_expenses')) THEN
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

CREATE OR REPLACE FUNCTION public.post_depreciation(p_society_id UUID, p_fy_end DATE)
RETURNS JSONB AS $$
DECLARE
    v_run UUID;
    v_total NUMERIC;
    v_count INT;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
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

-- Sale or scrap: remove the asset at its book value, gain / loss to 4300
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
    IF NOT (is_platform_admin() OR is_society_admin(v_asset.society_id)) THEN
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

-- ============================================================================
-- 10. PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.ensure_default_accounts(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_society_default_accounts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_expense_category(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.expense_debit_code(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ledger_post_expense_accrual(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_asset_for_expense(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_expense_approved() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ledger_post_expense(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expenses_accounting_checks() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.suggest_tds(UUID, UUID, TEXT, NUMERIC, DATE, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_vendor_payment(UUID, NUMERIC, NUMERIC, TEXT, TEXT, DATE, TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_expense_paid(UUID, DATE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_tds_challan(UUID, TEXT, NUMERIC, DATE, DATE, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.attach_expense_invoice(UUID, TEXT, TEXT, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_expense(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.add_existing_asset(UUID, TEXT, TEXT, DATE, NUMERIC, NUMERIC, DATE, NUMERIC, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_asset(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.preview_depreciation(UUID, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.post_depreciation(UUID, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dispose_asset(UUID, DATE, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.resolve_expense_category(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.suggest_tds(UUID, UUID, TEXT, NUMERIC, DATE, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_vendor_payment(UUID, NUMERIC, NUMERIC, TEXT, TEXT, DATE, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_expense_paid(UUID, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_tds_challan(UUID, TEXT, NUMERIC, DATE, DATE, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attach_expense_invoice(UUID, TEXT, TEXT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_expense(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_existing_asset(UUID, TEXT, TEXT, DATE, NUMERIC, NUMERIC, DATE, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_asset(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_depreciation(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.post_depreciation(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispose_asset(UUID, DATE, NUMERIC, TEXT, TEXT) TO authenticated;
