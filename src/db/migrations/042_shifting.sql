-- ============================================================================
-- 042: Phase 11C — shifting charges and refundable deposits
--      (spec docs/superpowers/specs/2026-11-24-flat-changes-design.md, 5.4)
-- ============================================================================

-- ============================================================================
-- 1. LEDGERS, SYSTEM RULES, SETTINGS AND THE ONE-OFF FLAT CHARGE
-- ============================================================================
-- Made on first use; the CA can rename them or move them between groups
CREATE OR REPLACE FUNCTION public.ensure_flat_change_ledgers(p_society_id UUID)
RETURNS VOID AS $$
BEGIN
    INSERT INTO accounts (society_id, code, name, type, group_id, is_system)
    SELECT p_society_id, x.code, x.name, x.type, default_account_group(p_society_id, x.code, x.type), true
    FROM (VALUES ('2400', 'Deposits received', 'liability'),
                 ('4400', 'Shifting charges', 'income'),
                 ('4500', 'Damage recovery', 'income')) AS x(code, name, type)
    ON CONFLICT (society_id, code) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.ensure_flat_change_ledgers(UUID) FROM PUBLIC, anon, authenticated;

-- System rules carry the ledger of a one-off line; they are never active, so monthly bills never use them
ALTER TABLE billing_rules ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE billing_rules ADD COLUMN IF NOT EXISTS system_key VARCHAR(32);
ALTER TABLE billing_rules DROP CONSTRAINT IF EXISTS chk_system_rule_off;
ALTER TABLE billing_rules ADD CONSTRAINT chk_system_rule_off CHECK (NOT (is_system AND is_active));
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_rule_system_key ON billing_rules (society_id, system_key) WHERE system_key IS NOT NULL;

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
        ('shifting_deposit', 'Shifting deposit (refundable)', '2400')) AS x(k, n, c)
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

-- A bill for one flat outside the monthly run: lines [{rule_key, description, amount}], only amounts above 0.
-- It sits in a one-day "Flat charges" cycle and posts like any bill (the line's system rule names the ledger).
CREATE OR REPLACE FUNCTION public.charge_flat(p_unit_id UUID, p_lines JSONB, p_due_date DATE)
RETURNS UUID AS $$
DECLARE
    v_society UUID;
    v_today DATE := (now() AT TIME ZONE 'Asia/Kolkata')::date;
    v_total NUMERIC;
    v_cycle UUID;
    v_prefix TEXT;
    v_seq INT;
    v_owner UUID;
    v_bill UUID;
    v_line JSONB;
BEGIN
    SELECT society_id INTO v_society FROM units WHERE id = p_unit_id;
    SELECT coalesce(sum(round((x ->> 'amount')::numeric, 2)), 0) INTO v_total
    FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x WHERE (x ->> 'amount')::numeric > 0;
    IF v_society IS NULL OR v_total <= 0 THEN
        RETURN NULL;
    END IF;

    INSERT INTO billing_cycles (society_id, cycle_name, period_start, period_end, due_date, status)
    VALUES (v_society, 'Flat charges ' || to_char(v_today, 'DD Mon YYYY'), v_today, v_today, p_due_date, 'published')
    ON CONFLICT (society_id, period_start, period_end) DO NOTHING;
    SELECT id INTO v_cycle FROM billing_cycles WHERE society_id = v_society AND period_start = v_today AND period_end = v_today;

    PERFORM 1 FROM societies WHERE id = v_society FOR UPDATE;
    v_prefix := 'C' || to_char(v_today, 'YYMM') || '-';
    SELECT coalesce(max(substring(bill_number FROM '^' || v_prefix || '([0-9]+)$')::int), 0) + 1 INTO v_seq
    FROM bills WHERE society_id = v_society;
    SELECT m.user_id INTO v_owner FROM society_memberships m
    WHERE m.society_id = v_society AND m.unit_id = p_unit_id AND m.is_active AND m.role = 'resident_owner'
    ORDER BY m.created_at LIMIT 1;

    INSERT INTO bills (society_id, cycle_id, unit_id, user_id, bill_number, bill_date, due_date,
                       subtotal_amount, tax_amount, total_amount, amount_paid, balance_due, status)
    VALUES (v_society, v_cycle, p_unit_id, v_owner, v_prefix || lpad(v_seq::text, 4, '0'), v_today, p_due_date,
            v_total, 0, v_total, 0, v_total, 'issued')
    RETURNING id INTO v_bill;
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        CONTINUE WHEN round((v_line ->> 'amount')::numeric, 2) <= 0;
        INSERT INTO bill_items (bill_id, rule_id, description, quantity, unit_rate, amount, tax_rate, tax_amount, total_item_amount)
        VALUES (v_bill, system_rule(v_society, v_line ->> 'rule_key'), left(v_line ->> 'description', 255), 1,
                round((v_line ->> 'amount')::numeric, 2), round((v_line ->> 'amount')::numeric, 2), 0, 0, round((v_line ->> 'amount')::numeric, 2));
    END LOOP;
    RETURN v_bill;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.charge_flat(UUID, JSONB, DATE) FROM PUBLIC, anon, authenticated;

ALTER TABLE society_settings ADD COLUMN IF NOT EXISTS move_in_charge NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE society_settings ADD COLUMN IF NOT EXISTS move_in_deposit NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE society_settings ADD COLUMN IF NOT EXISTS move_out_charge NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE society_settings ADD COLUMN IF NOT EXISTS move_out_deposit NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE society_settings ADD COLUMN IF NOT EXISTS shifting_from TIME NOT NULL DEFAULT '08:00';
ALTER TABLE society_settings ADD COLUMN IF NOT EXISTS shifting_to TIME NOT NULL DEFAULT '20:00';

CREATE OR REPLACE FUNCTION public.set_shifting_settings(p_society_id UUID, p_settings JSONB)
RETURNS VOID AS $$
DECLARE
    v_cur society_settings%ROWTYPE;
    v_in_c NUMERIC; v_in_d NUMERIC; v_out_c NUMERIC; v_out_d NUMERIC;
    v_from TIME; v_to TIME;
BEGIN
    IF NOT is_society_admin(p_society_id) THEN
        RAISE EXCEPTION 'Only the committee can change this';
    END IF;
    INSERT INTO society_settings (society_id) VALUES (p_society_id) ON CONFLICT (society_id) DO NOTHING;
    SELECT * INTO v_cur FROM society_settings WHERE society_id = p_society_id;
    BEGIN
        v_in_c := coalesce((p_settings ->> 'move_in_charge')::numeric, v_cur.move_in_charge);
        v_in_d := coalesce((p_settings ->> 'move_in_deposit')::numeric, v_cur.move_in_deposit);
        v_out_c := coalesce((p_settings ->> 'move_out_charge')::numeric, v_cur.move_out_charge);
        v_out_d := coalesce((p_settings ->> 'move_out_deposit')::numeric, v_cur.move_out_deposit);
    EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'Amounts must be between ₹0 and ₹1,00,000';
    END;
    IF least(v_in_c, v_in_d, v_out_c, v_out_d) < 0 OR greatest(v_in_c, v_in_d, v_out_c, v_out_d) > 100000 THEN
        RAISE EXCEPTION 'Amounts must be between ₹0 and ₹1,00,000';
    END IF;
    BEGIN
        v_from := coalesce((p_settings ->> 'shifting_from')::time, v_cur.shifting_from);
        v_to := coalesce((p_settings ->> 'shifting_to')::time, v_cur.shifting_to);
    EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'Choose the shifting hours';
    END;
    IF v_to <= v_from THEN
        RAISE EXCEPTION 'Choose the shifting hours';
    END IF;
    UPDATE society_settings SET move_in_charge = round(v_in_c, 2), move_in_deposit = round(v_in_d, 2),
        move_out_charge = round(v_out_c, 2), move_out_deposit = round(v_out_d, 2), shifting_from = v_from, shifting_to = v_to
    WHERE society_id = p_society_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.set_shifting_settings(UUID, JSONB) TO authenticated;
