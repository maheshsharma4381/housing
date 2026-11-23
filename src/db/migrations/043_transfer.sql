-- ============================================================================
-- 043: Phase 11D — sale and transfer of a flat
--      (spec docs/superpowers/specs/2026-11-24-flat-changes-design.md, 5.5; the shifting gate from 5.4)
-- ============================================================================

-- ============================================================================
-- 1. LEDGERS, SYSTEM RULES, SETTINGS AND THE DOCUMENT LIST
-- ============================================================================
-- from 042; + 4600 Transfer fees and 4700 Transfer premium
CREATE OR REPLACE FUNCTION public.ensure_flat_change_ledgers(p_society_id UUID)
RETURNS VOID AS $$
BEGIN
    INSERT INTO accounts (society_id, code, name, type, group_id, is_system)
    SELECT p_society_id, x.code, x.name, x.type, default_account_group(p_society_id, x.code, x.type), true
    FROM (VALUES ('2400', 'Deposits received', 'liability'),
                 ('4400', 'Shifting charges', 'income'),
                 ('4500', 'Damage recovery', 'income'),
                 ('4600', 'Transfer fees', 'income'),
                 ('4700', 'Transfer premium', 'income')) AS x(code, name, type)
    ON CONFLICT (society_id, code) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.ensure_flat_change_ledgers(UUID) FROM PUBLIC, anon, authenticated;

-- from 042; + transfer_fee and transfer_premium
CREATE OR REPLACE FUNCTION public.system_rule(p_society_id UUID, p_key TEXT)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
    v_name TEXT;
    v_code TEXT;
BEGIN
    SELECT id INTO v_id FROM billing_rules WHERE society_id = p_society_id AND system_key = p_key;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;
    SELECT n, c INTO v_name, v_code FROM (VALUES
        ('shifting_charge', 'Shifting charges', '4400'),
        ('shifting_deposit', 'Shifting deposit (refundable)', '2400'),
        ('transfer_fee', 'Transfer fee', '4600'),
        ('transfer_premium', 'Transfer premium', '4700')) AS x(k, n, c)
    WHERE k = p_key;
    IF v_name IS NULL THEN
        RAISE EXCEPTION 'Unknown charge %', p_key;
    END IF;
    PERFORM ensure_flat_change_ledgers(p_society_id);
    INSERT INTO billing_rules (society_id, name, calculation_type, rate, account_code, is_active, is_system, system_key)
    VALUES (p_society_id, v_name, 'manual', 0, v_code, false, true, p_key)
    ON CONFLICT (society_id, system_key) WHERE system_key IS NOT NULL DO NOTHING;
    SELECT id INTO v_id FROM billing_rules WHERE society_id = p_society_id AND system_key = p_key;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.system_rule(UUID, TEXT) FROM PUBLIC, anon, authenticated;

ALTER TABLE society_settings ADD COLUMN IF NOT EXISTS transfer_fee NUMERIC(10,2) NOT NULL DEFAULT 500;
ALTER TABLE society_settings ADD COLUMN IF NOT EXISTS transfer_premium NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE society_settings ADD COLUMN IF NOT EXISTS shifting_required BOOLEAN NOT NULL DEFAULT false;

-- The premium cap is the law's (bye-law 38: at most ₹25,000); the fee is the society's own
CREATE OR REPLACE FUNCTION public.set_transfer_settings(p_society_id UUID, p_settings JSONB)
RETURNS VOID AS $$
DECLARE
    v_cur society_settings%ROWTYPE;
    v_fee NUMERIC;
    v_premium NUMERIC;
    v_required BOOLEAN;
BEGIN
    IF NOT is_society_admin(p_society_id) THEN
        RAISE EXCEPTION 'Only the committee can change this';
    END IF;
    INSERT INTO society_settings (society_id) VALUES (p_society_id) ON CONFLICT (society_id) DO NOTHING;
    SELECT * INTO v_cur FROM society_settings WHERE society_id = p_society_id;
    BEGIN
        v_fee := coalesce((p_settings ->> 'transfer_fee')::numeric, v_cur.transfer_fee);
        v_premium := coalesce((p_settings ->> 'transfer_premium')::numeric, v_cur.transfer_premium);
    EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'Amounts must be between ₹0 and ₹1,00,000';
    END;
    IF v_fee < 0 OR v_fee > 100000 OR v_premium < 0 THEN
        RAISE EXCEPTION 'Amounts must be between ₹0 and ₹1,00,000';
    END IF;
    IF v_premium > 25000 THEN
        RAISE EXCEPTION 'The transfer premium can be at most ₹25,000';
    END IF;
    v_required := coalesce((p_settings ->> 'shifting_required')::boolean, v_cur.shifting_required);
    UPDATE society_settings SET transfer_fee = round(v_fee, 2), transfer_premium = round(v_premium, 2),
        shifting_required = v_required
    WHERE society_id = p_society_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.set_transfer_settings(UUID, JSONB) TO authenticated;

-- from 041; + the transfer list (from the model bye-laws' transfer procedure; the committee uploads its own forms)
CREATE OR REPLACE FUNCTION public.seed_request_checklists(p_society_id UUID)
RETURNS VOID AS $$
BEGIN
    INSERT INTO request_checklists (society_id, kind, checklist) VALUES
    (p_society_id, 'tenancy', '[
        {"key":"agreement","label":"Registered leave and licence agreement","required":true},
        {"key":"police","label":"Police intimation or verification acknowledgement","required":true},
        {"key":"tenant_id","label":"Tenant''s photo ID","required":true},
        {"key":"tenant_photo","label":"Tenant''s photograph","required":false},
        {"key":"undertaking","label":"Owner''s undertaking in the society''s format","required":false}
    ]'::jsonb),
    (p_society_id, 'transfer', '[
        {"key":"notice","label":"Seller''s notice of transfer (society form)","required":true},
        {"key":"membership","label":"Buyer''s application for membership (society form)","required":true},
        {"key":"deed","label":"Registered sale deed or agreement","required":true},
        {"key":"index2","label":"Registration receipt or Index II","required":true},
        {"key":"loan","label":"Bank NOC or loan closure letter (if the flat had a loan)","required":false},
        {"key":"buyer_id","label":"Buyer''s photo ID","required":true},
        {"key":"buyer_photo","label":"Buyer''s photograph","required":true},
        {"key":"buyer_pan","label":"Buyer''s PAN","required":true},
        {"key":"nomination","label":"Buyer''s nomination form","required":false}
    ]'::jsonb)
    ON CONFLICT (society_id, kind) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.seed_request_checklists(UUID) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
    v_id UUID;
BEGIN
    FOR v_id IN SELECT id FROM societies LOOP
        PERFORM seed_request_checklists(v_id);
    END LOOP;
END $$;
