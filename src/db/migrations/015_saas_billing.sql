-- ============================================================================
-- 015 SAAS BILLING (P11)
--   1. Plans Free / Basic / Pro with feature keys; billing settings; gateway secret
--   2. Every society starts on a 30-day trial (all features)
--   3. Per-society price override (custom rate, % discount, free months, excluded flats)
--   4. Quotes and GST invoices (SV-YYYY-NNNN, Indian financial-year series)
--   5. choose_plan: new / upgrade (prorated) / scheduled downgrade
--   6. Payments: platform NEFT mark-paid, gateway (Razorpay) via a shared secret;
--      on payment the plan starts and a draft bill lands in the society's books
--   7. Daily lifecycle: trial end -> Free, renewal invoices, grace, downgrade to Free
--   8. Entitlements: society_has_feature(); CA portal, asset register, GSTR-2B and
--      TDS register follow the plan (data is never deleted)
-- ============================================================================

-- ============================================================================
-- 1. PLANS, SETTINGS, SECRETS
-- ============================================================================
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS feature_keys TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS show_ads BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS storage_mb INT NOT NULL DEFAULT 500;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 100;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE subscription_plans DROP CONSTRAINT IF EXISTS chk_plan_feature_keys;
ALTER TABLE subscription_plans ADD CONSTRAINT chk_plan_feature_keys CHECK (
    feature_keys <@ ARRAY['ca_portal', 'asset_register', 'gst_recon', 'tds_register', 'bank_match', 'tally_export']::text[]
);

UPDATE subscription_plans SET is_active = false WHERE tier_code IN ('starter', 'growth', 'enterprise');
INSERT INTO subscription_plans (name, tier_code, monthly_rate_per_unit_inr, max_units, features_included, feature_keys, show_ads, storage_mb, sort_order, description) VALUES
    ('Free', 'free', 0, 100000,
     '["Billing & UPI collection", "Receipts", "Notices & tickets", "Double-entry books"]'::jsonb,
     '{}', true, 500, 10, 'Everything to run the society. Residents see a few local offers.'),
    ('Basic', 'basic', 10, 100000,
     '["Everything in Free", "No ads", "CA & auditor portal", "Asset register & depreciation"]'::jsonb,
     '{ca_portal,asset_register}', false, 5120, 20, 'For societies that work with a CA.'),
    ('Pro', 'pro', 18, 100000,
     '["Everything in Basic", "GSTR-2B reconciliation", "TDS register", "Bank statement match", "Tally export"]'::jsonb,
     '{ca_portal,asset_register,gst_recon,tds_register,bank_match,tally_export}', false, 25600, 30, 'For GST-registered and larger societies.')
ON CONFLICT (tier_code) DO NOTHING;

INSERT INTO platform_settings (key, value, description) VALUES
    ('billing', jsonb_build_object(
        'annual_months', 10, 'min_billable_flats', 20, 'trial_days', 30, 'due_days', 15, 'downgrade_days', 30,
        'renew_days_before', 15, 'gst_rate', 18, 'sac', '9983',
        'seller_name', 'Sahvaas', 'seller_gstin', '', 'seller_address', '', 'seller_state', 'Maharashtra', 'seller_phone', '0000000000',
        'bank_name', '', 'bank_account', '', 'bank_ifsc', '', 'bank_upi', ''
     ), 'SaaS pricing rules, GST and payment details shown on invoices')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.billing_setting(p_key TEXT)
RETURNS TEXT AS $$
    SELECT value ->> p_key FROM platform_settings WHERE key = 'billing'
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Hashes only; no policies, so nothing outside SECURITY DEFINER functions can read it
CREATE TABLE IF NOT EXISTS platform_secrets (
    key VARCHAR(64) PRIMARY KEY,
    value_sha256 TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
ALTER TABLE platform_secrets ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.sha256_hex(p_text TEXT)
RETURNS TEXT AS $$
    SELECT encode(sha256(convert_to(p_text, 'UTF8')), 'hex')
$$ LANGUAGE sql IMMUTABLE;

-- The same random value goes into Vercel as SAHVAAS_GATEWAY_SECRET
CREATE OR REPLACE FUNCTION public.platform_set_gateway_secret(p_secret TEXT)
RETURNS VOID AS $$
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;
    IF length(coalesce(p_secret, '')) < 32 THEN
        RAISE EXCEPTION 'Use a random secret of at least 32 characters';
    END IF;
    INSERT INTO platform_secrets (key, value_sha256) VALUES ('gateway', sha256_hex(p_secret))
    ON CONFLICT (key) DO UPDATE SET value_sha256 = EXCLUDED.value_sha256, updated_at = timezone('utc'::text, now());
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id)
    VALUES (NULL, auth.uid(), 'platform.gateway_secret_set', 'platform', 'gateway');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 2. SUBSCRIPTIONS: TRIAL FOR EVERY SOCIETY
-- ============================================================================
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS next_plan_id UUID REFERENCES subscription_plans(id);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_ends_on DATE;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now());
ALTER TABLE subscriptions ALTER COLUMN current_period_end DROP NOT NULL; -- Free has no end

CREATE OR REPLACE FUNCTION public.plan_id_of(p_code TEXT)
RETURNS UUID AS $$
    SELECT id FROM subscription_plans WHERE tier_code = p_code
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.start_trial(p_society_id UUID)
RETURNS VOID AS $$
DECLARE
    v_days INT := coalesce(billing_setting('trial_days')::int, 30);
BEGIN
    INSERT INTO subscriptions (society_id, plan_id, billing_term, status, current_period_start, current_period_end, trial_ends_on, unit_count)
    VALUES (p_society_id, plan_id_of('pro'), 'annual', 'trial', current_date, current_date + v_days - 1, current_date + v_days - 1, 0)
    ON CONFLICT (society_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.trg_society_start_trial()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM start_trial(NEW.id);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_society_start_trial ON societies;
CREATE TRIGGER trg_society_start_trial AFTER INSERT ON societies
    FOR EACH ROW EXECUTE FUNCTION public.trg_society_start_trial();

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT s.id FROM societies s WHERE NOT EXISTS (SELECT 1 FROM subscriptions x WHERE x.society_id = s.id) LOOP
        PERFORM start_trial(r.id);
    END LOOP;
END
$$;

-- ============================================================================
-- 3. PRICE OVERRIDES (platform admin)
-- ============================================================================
CREATE TABLE IF NOT EXISTS society_pricing_overrides (
    society_id UUID PRIMARY KEY REFERENCES societies(id) ON DELETE CASCADE,
    custom_rate NUMERIC(8,2) CHECK (custom_rate >= 0),
    discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
    free_months INT NOT NULL DEFAULT 0 CHECK (free_months BETWEEN 0 AND 24),
    excluded_units INT NOT NULL DEFAULT 0 CHECK (excluded_units >= 0),
    valid_till DATE,
    reason TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
    updated_by UUID REFERENCES profiles(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
ALTER TABLE society_pricing_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS society_pricing_overrides_admin ON society_pricing_overrides;
CREATE POLICY society_pricing_overrides_admin ON society_pricing_overrides
    FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());

-- ============================================================================
-- 4. QUOTES AND INVOICES
-- ============================================================================
-- Price for one billing period (or p_months of it, for prorated upgrades)
CREATE OR REPLACE FUNCTION public.subscription_quote(p_society_id UUID, p_plan_code TEXT, p_term TEXT, p_months NUMERIC DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_plan subscription_plans%ROWTYPE;
    v_ovr society_pricing_overrides%ROWTYPE;
    v_units INT;
    v_billable INT;
    v_rate NUMERIC;
    v_annual NUMERIC := coalesce(billing_setting('annual_months')::numeric, 10);
    v_min INT := coalesce(billing_setting('min_billable_flats')::int, 20);
    v_gst_rate NUMERIC := coalesce(billing_setting('gst_rate')::numeric, 18);
    v_months NUMERIC;
    v_gross NUMERIC;
    v_discount NUMERIC;
    v_taxable NUMERIC;
    v_gst NUMERIC;
BEGIN
    IF NOT (is_platform_admin() OR is_committee_viewer(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can see Sahvaas pricing';
    END IF;
    IF p_term NOT IN ('monthly', 'annual') THEN
        RAISE EXCEPTION 'Billing must be monthly or annual';
    END IF;
    SELECT * INTO v_plan FROM subscription_plans WHERE tier_code = p_plan_code AND is_active;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown plan %', p_plan_code;
    END IF;
    SELECT * INTO v_ovr FROM society_pricing_overrides
    WHERE society_id = p_society_id AND (valid_till IS NULL OR valid_till >= current_date);

    SELECT count(*) INTO v_units FROM units WHERE society_id = p_society_id;
    v_units := greatest(v_units - coalesce(v_ovr.excluded_units, 0), 0);
    v_rate := CASE WHEN v_plan.monthly_rate_per_unit_inr = 0 THEN 0 ELSE coalesce(v_ovr.custom_rate, v_plan.monthly_rate_per_unit_inr) END;
    v_billable := CASE WHEN v_rate = 0 THEN v_units ELSE greatest(v_units, v_min) END;
    -- Annual billing charges `annual_months` (e.g. 10) for 12 months of use
    v_months := coalesce(p_months, 1) * CASE WHEN p_term = 'annual' THEN v_annual / CASE WHEN p_months IS NULL THEN 1 ELSE 12 END ELSE 1 END;
    v_gross := round(v_billable * v_rate * v_months, 2);
    v_discount := round(v_gross * coalesce(v_ovr.discount_percent, 0) / 100, 2);
    v_taxable := v_gross - v_discount;
    v_gst := round(v_taxable * v_gst_rate / 100, 2);

    RETURN jsonb_build_object(
        'plan_code', v_plan.tier_code, 'plan_name', v_plan.name, 'term', p_term,
        'units', v_units, 'billable_units', v_billable, 'min_billable', v_min, 'rate', v_rate,
        'months_charged', v_months, 'period_months', CASE WHEN p_term = 'annual' THEN 12 ELSE 1 END,
        'gross', v_gross, 'discount', v_discount, 'discount_percent', coalesce(v_ovr.discount_percent, 0),
        'taxable', v_taxable, 'gst_rate', v_gst_rate, 'gst', v_gst, 'total', v_taxable + v_gst,
        'monthly_equivalent', round(v_taxable / CASE WHEN p_months IS NOT NULL THEN greatest(p_months, 1)
                                                      WHEN p_term = 'annual' THEN 12 ELSE 1 END, 2),
        'savings_vs_monthly', CASE WHEN p_term = 'annual' AND p_months IS NULL THEN round(v_billable * v_rate * (12 - v_annual), 2) ELSE 0 END,
        'free_months', coalesce(v_ovr.free_months, 0)
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE TABLE IF NOT EXISTS platform_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number VARCHAR(32) NOT NULL UNIQUE,
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES subscription_plans(id),
    plan_code VARCHAR(32) NOT NULL,
    billing_term VARCHAR(16) NOT NULL CHECK (billing_term IN ('monthly', 'annual')),
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('new', 'renewal', 'upgrade')),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    billable_units INT NOT NULL,
    rate NUMERIC(8,2) NOT NULL,
    months_charged NUMERIC(6,2) NOT NULL,
    gross NUMERIC(12,2) NOT NULL,
    discount NUMERIC(12,2) NOT NULL DEFAULT 0,
    taxable NUMERIC(12,2) NOT NULL,
    gst_rate NUMERIC(5,2) NOT NULL,
    gst_amount NUMERIC(12,2) NOT NULL,
    total NUMERIC(12,2) NOT NULL,
    seller JSONB NOT NULL,     -- name, GSTIN, address, SAC at issue time
    bill_to JSONB NOT NULL,    -- society name, address, GSTIN at issue time
    status VARCHAR(16) NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'paid', 'void')),
    issued_on DATE NOT NULL DEFAULT current_date,
    due_on DATE NOT NULL,
    paid_on DATE,
    payment_method VARCHAR(16) CHECK (payment_method IN ('gateway', 'neft', 'complimentary')),
    payment_reference VARCHAR(128),
    gateway_order_id VARCHAR(64),
    gateway_payment_id VARCHAR(64) UNIQUE,
    created_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_platform_invoices_society ON platform_invoices (society_id, status);
ALTER TABLE platform_invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_invoices_select ON platform_invoices;
CREATE POLICY platform_invoices_select ON platform_invoices
    FOR SELECT USING (is_platform_admin() OR is_committee_viewer(society_id));

-- One series per Indian financial year: SV-2026-0001 ... (FY starting April 2026)
CREATE OR REPLACE FUNCTION public.platform_next_invoice_number(p_date DATE)
RETURNS TEXT AS $$
DECLARE
    v_prefix TEXT := 'SV-' || extract(year FROM fy_start_of(p_date))::int || '-';
    v_n INT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('sahvaas.platform_invoice_number'));
    SELECT coalesce(max(substring(invoice_number FROM length(v_prefix) + 1)::int), 0) + 1 INTO v_n
    FROM platform_invoices WHERE invoice_number LIKE v_prefix || '%';
    RETURN v_prefix || lpad(v_n::text, 4, '0');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.create_platform_invoice(
    p_society_id UUID, p_quote JSONB, p_kind TEXT, p_period_start DATE, p_period_end DATE, p_issued_on DATE DEFAULT current_date
)
RETURNS UUID AS $$
DECLARE
    v_soc societies%ROWTYPE;
    v_id UUID;
BEGIN
    SELECT * INTO v_soc FROM societies WHERE id = p_society_id;
    INSERT INTO platform_invoices (
        invoice_number, society_id, plan_id, plan_code, billing_term, kind, period_start, period_end,
        billable_units, rate, months_charged, gross, discount, taxable, gst_rate, gst_amount, total,
        seller, bill_to, issued_on, due_on, created_by
    ) VALUES (
        platform_next_invoice_number(p_issued_on), p_society_id, plan_id_of(p_quote ->> 'plan_code'), p_quote ->> 'plan_code',
        p_quote ->> 'term', p_kind, p_period_start, p_period_end,
        (p_quote ->> 'billable_units')::int, (p_quote ->> 'rate')::numeric, (p_quote ->> 'months_charged')::numeric,
        (p_quote ->> 'gross')::numeric, (p_quote ->> 'discount')::numeric, (p_quote ->> 'taxable')::numeric,
        (p_quote ->> 'gst_rate')::numeric, (p_quote ->> 'gst')::numeric, (p_quote ->> 'total')::numeric,
        jsonb_build_object('name', billing_setting('seller_name'), 'gstin', billing_setting('seller_gstin'),
                           'address', billing_setting('seller_address'), 'state', billing_setting('seller_state'), 'sac', billing_setting('sac')),
        jsonb_build_object('name', v_soc.name, 'gstin', v_soc.gstin, 'state', v_soc.state,
                           'address', concat_ws(', ', v_soc.address_line1, v_soc.address_line2, v_soc.city, v_soc.pincode)),
        p_issued_on, p_issued_on + coalesce(billing_setting('due_days')::int, 15), auth.uid()
    ) RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. CHOOSING A PLAN
-- ============================================================================
CREATE OR REPLACE FUNCTION public.choose_plan(p_society_id UUID, p_plan_code TEXT, p_term TEXT DEFAULT 'annual')
RETURNS JSONB AS $$
DECLARE
    v_sub subscriptions%ROWTYPE;
    v_cur subscription_plans%ROWTYPE;
    v_new subscription_plans%ROWTYPE;
    v_quote JSONB;
    v_cur_quote JSONB;
    v_in_trial BOOLEAN;
    v_paid_period BOOLEAN;
    v_start DATE;
    v_end DATE;
    v_months NUMERIC;
    v_invoice UUID;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can change the Sahvaas plan';
    END IF;
    SELECT * INTO v_new FROM subscription_plans WHERE tier_code = p_plan_code AND is_active;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown plan %', p_plan_code;
    END IF;
    PERFORM start_trial(p_society_id);
    SELECT * INTO v_sub FROM subscriptions WHERE society_id = p_society_id FOR UPDATE;
    SELECT * INTO v_cur FROM subscription_plans WHERE id = v_sub.plan_id;

    v_in_trial := v_sub.trial_ends_on >= current_date AND (v_sub.status = 'trial' OR v_sub.current_period_start > current_date);
    v_paid_period := NOT v_in_trial AND v_sub.status IN ('active', 'past_due') AND v_cur.monthly_rate_per_unit_inr > 0
                     AND v_sub.current_period_end >= current_date;

    -- A new choice replaces any unpaid new / upgrade invoice
    UPDATE platform_invoices SET status = 'void'
    WHERE society_id = p_society_id AND status = 'issued' AND kind IN ('new', 'upgrade');

    IF v_new.monthly_rate_per_unit_inr = 0 THEN
        IF v_paid_period THEN
            UPDATE subscriptions SET next_plan_id = v_new.id, updated_at = timezone('utc'::text, now()) WHERE society_id = p_society_id;
            RETURN jsonb_build_object('scheduled', true, 'plan_code', v_new.tier_code, 'effective_on', v_sub.current_period_end + 1);
        END IF;
        UPDATE subscriptions
        SET plan_id = v_new.id, status = 'active', current_period_start = greatest(current_date, coalesce(v_sub.trial_ends_on + 1, current_date)),
            current_period_end = NULL, next_plan_id = NULL, updated_at = timezone('utc'::text, now())
        WHERE society_id = p_society_id;
        -- Trial features still run until the trial date; the society is now on a chosen plan
        UPDATE societies SET subscription_status = 'active' WHERE id = p_society_id AND subscription_status = 'trial';
        RETURN jsonb_build_object('scheduled', false, 'plan_code', 'free');
    END IF;

    IF v_paid_period AND v_cur.id = v_new.id THEN
        RAISE EXCEPTION 'You are already on %; the renewal invoice comes before % ends', v_cur.name, v_sub.current_period_end;
    END IF;

    IF v_paid_period AND v_new.monthly_rate_per_unit_inr < v_cur.monthly_rate_per_unit_inr THEN
        UPDATE subscriptions SET next_plan_id = v_new.id, updated_at = timezone('utc'::text, now()) WHERE society_id = p_society_id;
        RETURN jsonb_build_object('scheduled', true, 'plan_code', v_new.tier_code, 'effective_on', v_sub.current_period_end + 1);
    END IF;

    IF v_paid_period THEN
        -- Upgrade now: pay only the difference for the whole months left in the period
        v_months := least(ceil((v_sub.current_period_end - current_date + 1) / 30.0),
                          CASE WHEN v_sub.billing_term = 'annual' THEN 12 ELSE 1 END);
        v_quote := subscription_quote(p_society_id, v_new.tier_code, v_sub.billing_term, v_months);
        v_cur_quote := subscription_quote(p_society_id, v_cur.tier_code, v_sub.billing_term, v_months);
        v_quote := v_quote || jsonb_build_object(
            'rate', (v_quote ->> 'rate')::numeric - (v_cur_quote ->> 'rate')::numeric,
            'gross', (v_quote ->> 'gross')::numeric - (v_cur_quote ->> 'gross')::numeric,
            'discount', (v_quote ->> 'discount')::numeric - (v_cur_quote ->> 'discount')::numeric,
            'taxable', (v_quote ->> 'taxable')::numeric - (v_cur_quote ->> 'taxable')::numeric,
            'gst', (v_quote ->> 'gst')::numeric - (v_cur_quote ->> 'gst')::numeric,
            'total', (v_quote ->> 'total')::numeric - (v_cur_quote ->> 'total')::numeric
        );
        v_invoice := create_platform_invoice(p_society_id, v_quote, 'upgrade', current_date, v_sub.current_period_end);
    ELSE
        v_quote := subscription_quote(p_society_id, v_new.tier_code, p_term);
        v_start := CASE WHEN v_in_trial THEN v_sub.trial_ends_on + 1 ELSE current_date END;
        v_end := (v_start + make_interval(months => CASE WHEN p_term = 'annual' THEN 12 ELSE 1 END
                                                   + coalesce((v_quote ->> 'free_months')::int, 0)) - interval '1 day')::date;
        v_invoice := create_platform_invoice(p_society_id, v_quote, 'new', v_start, v_end);
    END IF;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'billing.plan_chosen', 'platform_invoice', v_invoice::text,
            jsonb_build_object('plan', v_new.tier_code, 'term', p_term));
    RETURN (SELECT jsonb_build_object('scheduled', false, 'invoice_id', i.id, 'invoice_number', i.invoice_number, 'total', i.total,
                                      'kind', i.kind, 'period_start', i.period_start, 'period_end', i.period_end, 'due_on', i.due_on)
            FROM platform_invoices i WHERE i.id = v_invoice);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 6. PAYMENTS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.apply_platform_invoice_payment(
    p_invoice_id UUID, p_method TEXT, p_reference TEXT, p_paid_on DATE, p_gateway_payment_id TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_inv platform_invoices%ROWTYPE;
    v_vendor UUID;
BEGIN
    SELECT * INTO v_inv FROM platform_invoices WHERE id = p_invoice_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice not found';
    END IF;
    IF v_inv.status = 'paid' THEN
        RETURN jsonb_build_object('status', 'paid', 'already', true);
    END IF;

    UPDATE platform_invoices
    SET status = 'paid', paid_on = coalesce(p_paid_on, current_date), payment_method = p_method,
        payment_reference = nullif(trim(coalesce(p_reference, '')), ''), gateway_payment_id = p_gateway_payment_id
    WHERE id = p_invoice_id;

    IF v_inv.kind = 'upgrade' THEN
        UPDATE subscriptions SET plan_id = v_inv.plan_id, next_plan_id = NULL, updated_at = timezone('utc'::text, now())
        WHERE society_id = v_inv.society_id;
    ELSE
        UPDATE subscriptions
        SET plan_id = v_inv.plan_id, billing_term = v_inv.billing_term, status = 'active',
            current_period_start = v_inv.period_start, current_period_end = v_inv.period_end,
            next_plan_id = NULL, unit_count = v_inv.billable_units, updated_at = timezone('utc'::text, now())
        WHERE society_id = v_inv.society_id;
    END IF;
    UPDATE societies SET subscription_status = 'active', updated_at = timezone('utc'::text, now())
    WHERE id = v_inv.society_id AND subscription_status = 'trial';

    -- The society pays Sahvaas from its own funds: a draft bill for the committee to approve
    SELECT id INTO v_vendor FROM vendors WHERE society_id = v_inv.society_id AND lower(name) = lower(v_inv.seller ->> 'name') LIMIT 1;
    IF v_vendor IS NULL THEN
        INSERT INTO vendors (society_id, name, phone, gstin, category)
        VALUES (v_inv.society_id, coalesce(v_inv.seller ->> 'name', 'Sahvaas'), coalesce(billing_setting('seller_phone'), '0000000000'),
                nullif(v_inv.seller ->> 'gstin', ''), 'other')
        RETURNING id INTO v_vendor;
    END IF;
    INSERT INTO expenses (society_id, vendor_id, category, title, invoice_number, invoice_date, subtotal, gst_amount, tds_amount, status)
    VALUES (v_inv.society_id, v_vendor, 'software',
            'Sahvaas ' || initcap(v_inv.plan_code) || ' plan · ' || to_char(v_inv.period_start, 'DD Mon YYYY') || ' – ' || to_char(v_inv.period_end, 'DD Mon YYYY'),
            v_inv.invoice_number, v_inv.issued_on, v_inv.taxable, v_inv.gst_amount, 0, 'pending_approval');

    -- Gateway webhooks have no user; the invoice itself records method and payment id
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    SELECT v_inv.society_id, auth.uid(), 'billing.invoice_paid', 'platform_invoice', p_invoice_id::text,
           jsonb_build_object('number', v_inv.invoice_number, 'total', v_inv.total, 'method', p_method, 'reference', p_reference)
    WHERE auth.uid() IS NOT NULL;
    RETURN jsonb_build_object('status', 'paid', 'already', false, 'invoice_number', v_inv.invoice_number);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.platform_mark_invoice_paid(p_invoice_id UUID, p_reference TEXT, p_paid_on DATE DEFAULT current_date)
RETURNS JSONB AS $$
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;
    IF length(trim(coalesce(p_reference, ''))) = 0 THEN
        RAISE EXCEPTION 'Enter the bank UTR / reference';
    END IF;
    RETURN apply_platform_invoice_payment(p_invoice_id, 'neft', p_reference, p_paid_on);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Committee: remember the gateway order created for an invoice (server route)
CREATE OR REPLACE FUNCTION public.attach_gateway_order(p_invoice_id UUID, p_order_id TEXT)
RETURNS VOID AS $$
DECLARE
    v_inv platform_invoices%ROWTYPE;
BEGIN
    SELECT * INTO v_inv FROM platform_invoices WHERE id = p_invoice_id FOR UPDATE;
    IF NOT FOUND OR NOT (is_platform_admin() OR is_society_admin(v_inv.society_id)) THEN
        RAISE EXCEPTION 'Invoice not found';
    END IF;
    IF v_inv.status <> 'issued' THEN
        RAISE EXCEPTION 'This invoice is %', v_inv.status;
    END IF;
    UPDATE platform_invoices SET gateway_order_id = p_order_id WHERE id = p_invoice_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Called by the Sahvaas server after it has verified the gateway's signature.
-- Works without a user session (webhooks); guarded by the shared gateway secret.
CREATE OR REPLACE FUNCTION public.gateway_record_payment(
    p_secret TEXT, p_invoice_id UUID, p_order_id TEXT, p_payment_id TEXT, p_amount_paise BIGINT
)
RETURNS JSONB AS $$
DECLARE
    v_hash TEXT;
    v_inv platform_invoices%ROWTYPE;
BEGIN
    SELECT value_sha256 INTO v_hash FROM platform_secrets WHERE key = 'gateway';
    IF v_hash IS NULL OR sha256_hex(coalesce(p_secret, '')) <> v_hash THEN
        RAISE EXCEPTION 'Not authorised';
    END IF;
    SELECT * INTO v_inv FROM platform_invoices WHERE id = p_invoice_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice not found';
    END IF;
    IF v_inv.gateway_payment_id = p_payment_id THEN
        RETURN jsonb_build_object('status', 'paid', 'already', true);
    END IF;
    IF v_inv.gateway_order_id IS NOT NULL AND v_inv.gateway_order_id <> p_order_id THEN
        RAISE EXCEPTION 'Order does not match this invoice';
    END IF;
    IF p_amount_paise <> round(v_inv.total * 100) THEN
        RAISE EXCEPTION 'Amount % paise does not match invoice total', p_amount_paise;
    END IF;
    RETURN apply_platform_invoice_payment(p_invoice_id, 'gateway', p_payment_id, current_date, p_payment_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 7. DAILY LIFECYCLE
-- ============================================================================
CREATE OR REPLACE FUNCTION public.run_subscription_lifecycle(p_today DATE DEFAULT current_date)
RETURNS JSONB AS $$
DECLARE
    r RECORD;
    v_free UUID := plan_id_of('free');
    v_renew_before INT := coalesce(billing_setting('renew_days_before')::int, 15);
    v_downgrade_days INT := coalesce(billing_setting('downgrade_days')::int, 30);
    v_trials INT := 0;
    v_switched INT := 0;
    v_renewals INT := 0;
    v_grace INT := 0;
    v_downgraded INT := 0;
    v_quote JSONB;
    v_start DATE;
BEGIN
    IF auth.uid() IS NOT NULL AND NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;

    -- a) Trial over without a paid plan -> Free
    FOR r IN SELECT * FROM subscriptions WHERE status = 'trial' AND trial_ends_on < p_today LOOP
        UPDATE subscriptions SET plan_id = v_free, status = 'active', current_period_start = r.trial_ends_on + 1,
                                 current_period_end = NULL, next_plan_id = NULL, updated_at = timezone('utc'::text, now())
        WHERE society_id = r.society_id;
        UPDATE societies SET subscription_status = 'active' WHERE id = r.society_id AND subscription_status = 'trial';
        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id)
        SELECT r.society_id, auth.uid(), 'billing.trial_ended', 'society', r.society_id::text WHERE auth.uid() IS NOT NULL;
        v_trials := v_trials + 1;
    END LOOP;

    -- b) Scheduled switch to Free at the end of a paid period
    FOR r IN SELECT * FROM subscriptions WHERE next_plan_id = v_free AND current_period_end < p_today LOOP
        UPDATE subscriptions SET plan_id = v_free, current_period_start = r.current_period_end + 1, current_period_end = NULL,
                                 next_plan_id = NULL, status = 'active', updated_at = timezone('utc'::text, now())
        WHERE society_id = r.society_id;
        v_switched := v_switched + 1;
    END LOOP;

    -- c) Renewal invoice `renew_days_before` days before a paid period ends
    FOR r IN
        SELECT s.*, coalesce(np.tier_code, p.tier_code) AS renew_code
        FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
        LEFT JOIN subscription_plans np ON np.id = s.next_plan_id
        WHERE s.status IN ('active', 'past_due') AND s.auto_renew AND p.monthly_rate_per_unit_inr > 0
          AND s.current_period_end IS NOT NULL AND s.current_period_end - p_today <= v_renew_before
          AND coalesce(np.monthly_rate_per_unit_inr, 1) > 0
          AND NOT EXISTS (SELECT 1 FROM platform_invoices i WHERE i.society_id = s.society_id AND i.status IN ('issued', 'paid')
                          AND i.kind IN ('new', 'renewal') AND i.period_start = s.current_period_end + 1)
    LOOP
        v_quote := subscription_quote(r.society_id, r.renew_code, r.billing_term) - 'free_months';
        v_start := r.current_period_end + 1;
        PERFORM create_platform_invoice(r.society_id, v_quote, 'renewal', v_start,
            (v_start + make_interval(months => CASE WHEN r.billing_term = 'annual' THEN 12 ELSE 1 END) - interval '1 day')::date, p_today);
        v_renewals := v_renewals + 1;
    END LOOP;

    -- d) Period over and renewal unpaid: grace (past_due), then Free after `downgrade_days` from the invoice
    FOR r IN
        SELECT s.society_id, s.status, i.issued_on
        FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
        JOIN platform_invoices i ON i.society_id = s.society_id AND i.status = 'issued' AND i.kind = 'renewal'
                                 AND i.period_start = s.current_period_end + 1
        WHERE p.monthly_rate_per_unit_inr > 0 AND s.current_period_end < p_today
    LOOP
        IF p_today > r.issued_on + v_downgrade_days THEN
            UPDATE subscriptions SET plan_id = v_free, status = 'active', current_period_start = p_today, current_period_end = NULL,
                                     next_plan_id = NULL, updated_at = timezone('utc'::text, now())
            WHERE society_id = r.society_id;
            INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id)
            SELECT r.society_id, auth.uid(), 'billing.moved_to_free', 'society', r.society_id::text WHERE auth.uid() IS NOT NULL;
            v_downgraded := v_downgraded + 1;
        ELSIF r.status <> 'past_due' THEN
            UPDATE subscriptions SET status = 'past_due', updated_at = timezone('utc'::text, now()) WHERE society_id = r.society_id;
            v_grace := v_grace + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('trials_ended', v_trials, 'switched_to_free', v_switched, 'renewal_invoices', v_renewals,
                              'in_grace', v_grace, 'moved_to_free', v_downgraded);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DO $outer$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
        CREATE EXTENSION IF NOT EXISTS pg_cron;
        PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sahvaas-subscriptions';
        PERFORM cron.schedule('sahvaas-subscriptions', '30 19 * * *', $cron$SELECT public.run_subscription_lifecycle()$cron$);
    END IF;
END
$outer$;

-- ============================================================================
-- 8. ENTITLEMENTS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.society_in_trial(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT coalesce((SELECT s.trial_ends_on >= current_date AND (s.status = 'trial' OR s.current_period_start > current_date)
                     FROM subscriptions s WHERE s.society_id = p_society_id), false)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.society_has_feature(p_society_id UUID, p_key TEXT)
RETURNS BOOLEAN AS $$
    SELECT society_in_trial(p_society_id) OR coalesce((
        SELECT p_key = ANY(p.feature_keys) FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
        WHERE s.society_id = p_society_id
    ), false)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Plan summary for the committee screens
CREATE OR REPLACE FUNCTION public.society_plan(p_society_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_sub subscriptions%ROWTYPE;
    v_plan subscription_plans%ROWTYPE;
    v_next TEXT;
    v_trial BOOLEAN;
    v_inv platform_invoices%ROWTYPE;
    v_all TEXT[] := ARRAY['ca_portal', 'asset_register', 'gst_recon', 'tds_register', 'bank_match', 'tally_export'];
BEGIN
    IF NOT (is_platform_admin() OR is_committee_viewer(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can see the Sahvaas plan';
    END IF;
    SELECT * INTO v_sub FROM subscriptions WHERE society_id = p_society_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    SELECT * INTO v_plan FROM subscription_plans WHERE id = v_sub.plan_id;
    SELECT tier_code INTO v_next FROM subscription_plans WHERE id = v_sub.next_plan_id;
    v_trial := society_in_trial(p_society_id);
    SELECT * INTO v_inv FROM platform_invoices WHERE society_id = p_society_id AND status = 'issued' ORDER BY issued_on DESC LIMIT 1;

    RETURN jsonb_build_object(
        'plan_code', CASE WHEN v_trial AND v_sub.status = 'trial' THEN 'trial' ELSE v_plan.tier_code END,
        'paid_plan_code', v_plan.tier_code,
        'plan_name', CASE WHEN v_trial AND v_sub.status = 'trial' THEN 'Free trial' ELSE v_plan.name END,
        'status', v_sub.status, 'in_trial', v_trial, 'trial_ends_on', v_sub.trial_ends_on,
        'term', v_sub.billing_term, 'period_start', v_sub.current_period_start, 'period_end', v_sub.current_period_end,
        'next_plan_code', v_next,
        'features', CASE WHEN v_trial THEN v_all ELSE v_plan.feature_keys END,
        'show_ads', NOT v_trial AND v_plan.show_ads,
        'open_invoice', CASE WHEN v_inv.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', v_inv.id, 'invoice_number', v_inv.invoice_number, 'total', v_inv.total, 'kind', v_inv.kind,
            'issued_on', v_inv.issued_on, 'due_on', v_inv.due_on, 'period_start', v_inv.period_start, 'period_end', v_inv.period_end,
            'overdue', v_inv.due_on < current_date,
            'moves_to_free_on', CASE WHEN v_inv.kind = 'renewal' THEN v_inv.issued_on + coalesce(billing_setting('downgrade_days')::int, 30) + 1 END
        ) END
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- CA portal follows the plan: grants stay, but give no access on Free
CREATE OR REPLACE FUNCTION public.has_professional_permission(target_society_id UUID, required_permission TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN society_has_feature(target_society_id, 'ca_portal') AND EXISTS (
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

CREATE OR REPLACE FUNCTION public.require_feature(p_society_id UUID, p_key TEXT, p_label TEXT)
RETURNS VOID AS $$
BEGIN
    IF NOT society_has_feature(p_society_id, p_key) THEN
        RAISE EXCEPTION '% is part of the % plan — upgrade under Plan & Billing', p_label,
            CASE WHEN p_key IN ('ca_portal', 'asset_register') THEN 'Basic and Pro' ELSE 'Pro' END;
    END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.trg_feature_ca_invite()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM require_feature(NEW.society_id, 'ca_portal', 'CA & auditor access');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_feature_ca_invite ON professional_invites;
CREATE TRIGGER trg_feature_ca_invite BEFORE INSERT ON professional_invites
    FOR EACH ROW EXECUTE FUNCTION public.trg_feature_ca_invite();

-- Bills booked as assets still create register rows on any plan (the books stay right);
-- adding old assets, depreciation, disposal and rate changes need the asset register
CREATE OR REPLACE FUNCTION public.trg_feature_asset_register()
RETURNS TRIGGER AS $$
BEGIN
    -- Nested IFs: PL/pgSQL may evaluate every operand, and depreciation_runs has no opening_as_of
    IF TG_TABLE_NAME = 'depreciation_runs' THEN
        PERFORM require_feature(NEW.society_id, 'asset_register', 'The asset register');
    ELSIF TG_OP = 'INSERT' THEN
        IF NEW.opening_as_of IS NOT NULL THEN
            PERFORM require_feature(NEW.society_id, 'asset_register', 'The asset register');
        END IF;
    ELSIF NEW.status = 'disposed' OR NEW.dep_rate IS DISTINCT FROM OLD.dep_rate OR NEW.dep_method IS DISTINCT FROM OLD.dep_method THEN
        PERFORM require_feature(NEW.society_id, 'asset_register', 'The asset register');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_feature_asset_register ON fixed_assets;
CREATE TRIGGER trg_feature_asset_register BEFORE INSERT OR UPDATE ON fixed_assets
    FOR EACH ROW EXECUTE FUNCTION public.trg_feature_asset_register();
DROP TRIGGER IF EXISTS trg_feature_asset_register ON depreciation_runs;
CREATE TRIGGER trg_feature_asset_register BEFORE INSERT ON depreciation_runs
    FOR EACH ROW EXECUTE FUNCTION public.trg_feature_asset_register();

CREATE OR REPLACE FUNCTION public.trg_feature_gst_recon()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM require_feature(NEW.society_id, 'gst_recon', 'GSTR-2B reconciliation');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_feature_gst_recon ON gst_2b_uploads;
CREATE TRIGGER trg_feature_gst_recon BEFORE INSERT ON gst_2b_uploads
    FOR EACH ROW EXECUTE FUNCTION public.trg_feature_gst_recon();

-- TDS register (014) behind the Pro plan
CREATE OR REPLACE FUNCTION public.tds_register(p_society_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (paid_on DATE, reference TEXT, expense_number TEXT, vendor TEXT, pan TEXT, entity TEXT,
               section TEXT, rate NUMERIC, taxable NUMERIC, amount_paid NUMERIC, tds NUMERIC) AS $$
BEGIN
    IF NOT (can_view_expenses(p_society_id) OR can_view_financials(p_society_id)) THEN
        RAISE EXCEPTION 'You do not have access to this society''s expenses';
    END IF;
    PERFORM require_feature(p_society_id, 'tds_register', 'The TDS register');
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

-- ============================================================================
-- 9. PLATFORM OWNER: BILLING OVERVIEW AND OVERRIDES
-- ============================================================================
CREATE OR REPLACE FUNCTION public.platform_billing_overview()
RETURNS TABLE (
    society_id UUID, name TEXT, city TEXT, units INT, plan_code TEXT, status TEXT, in_trial BOOLEAN, trial_ends_on DATE,
    term TEXT, period_end DATE, next_plan_code TEXT, monthly_value NUMERIC, open_invoice_total NUMERIC, open_invoice_due DATE,
    has_override BOOLEAN
) AS $$
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;
    RETURN QUERY
    SELECT s.id, s.name::text, s.city::text, (SELECT count(*)::int FROM units u WHERE u.society_id = s.id),
           p.tier_code::text, sub.status::text, society_in_trial(s.id), sub.trial_ends_on, sub.billing_term::text,
           sub.current_period_end, np.tier_code::text,
           -- Booked value: paid plans count even if they start after the trial
           CASE WHEN p.monthly_rate_per_unit_inr > 0 AND sub.status IN ('active', 'past_due')
                THEN (subscription_quote(s.id, p.tier_code, sub.billing_term) ->> 'monthly_equivalent')::numeric ELSE 0 END,
           (SELECT sum(i.total) FROM platform_invoices i WHERE i.society_id = s.id AND i.status = 'issued'),
           (SELECT min(i.due_on) FROM platform_invoices i WHERE i.society_id = s.id AND i.status = 'issued'),
           EXISTS (SELECT 1 FROM society_pricing_overrides o WHERE o.society_id = s.id)
    FROM societies s
    JOIN subscriptions sub ON sub.society_id = s.id
    JOIN subscription_plans p ON p.id = sub.plan_id
    LEFT JOIN subscription_plans np ON np.id = sub.next_plan_id
    ORDER BY s.created_at DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.platform_set_pricing_override(
    p_society_id UUID, p_custom_rate NUMERIC, p_discount_percent NUMERIC, p_free_months INT, p_excluded_units INT,
    p_valid_till DATE, p_reason TEXT
)
RETURNS VOID AS $$
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;
    INSERT INTO society_pricing_overrides (society_id, custom_rate, discount_percent, free_months, excluded_units, valid_till, reason, updated_by)
    VALUES (p_society_id, p_custom_rate, coalesce(p_discount_percent, 0), coalesce(p_free_months, 0), coalesce(p_excluded_units, 0),
            p_valid_till, trim(coalesce(p_reason, '')), auth.uid())
    ON CONFLICT (society_id) DO UPDATE SET
        custom_rate = EXCLUDED.custom_rate, discount_percent = EXCLUDED.discount_percent, free_months = EXCLUDED.free_months,
        excluded_units = EXCLUDED.excluded_units, valid_till = EXCLUDED.valid_till, reason = EXCLUDED.reason,
        updated_by = EXCLUDED.updated_by, updated_at = timezone('utc'::text, now());
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value, reason)
    VALUES (p_society_id, auth.uid(), 'platform.pricing_override', 'society', p_society_id::text,
            jsonb_build_object('rate', p_custom_rate, 'discount', p_discount_percent, 'free_months', p_free_months,
                               'excluded_units', p_excluded_units, 'valid_till', p_valid_till), trim(coalesce(p_reason, '')));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 10. PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.billing_setting(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.start_trial(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_society_start_trial() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.platform_next_invoice_number(DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_platform_invoice(UUID, JSONB, TEXT, DATE, DATE, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_platform_invoice_payment(UUID, TEXT, TEXT, DATE, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_feature_ca_invite() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_feature_asset_register() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_feature_gst_recon() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.platform_set_gateway_secret(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.subscription_quote(UUID, TEXT, TEXT, NUMERIC) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.choose_plan(UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_mark_invoice_paid(UUID, TEXT, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.attach_gateway_order(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gateway_record_payment(TEXT, UUID, TEXT, TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.run_subscription_lifecycle(DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.society_plan(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_billing_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_set_pricing_override(UUID, NUMERIC, NUMERIC, INT, INT, DATE, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.billing_setting(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_set_gateway_secret(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_quote(UUID, TEXT, TEXT, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.choose_plan(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_mark_invoice_paid(UUID, TEXT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attach_gateway_order(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gateway_record_payment(TEXT, UUID, TEXT, TEXT, BIGINT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_subscription_lifecycle(DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.society_plan(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.society_in_trial(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.society_has_feature(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_billing_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_set_pricing_override(UUID, NUMERIC, NUMERIC, INT, INT, DATE, TEXT) TO authenticated;
