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

-- ============================================================================
-- 2. APPLYING, FEES AND CANCELLATION
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_transfer_request(p_unit_id UUID, p_details JSONB)
RETURNS UUID AS $$
DECLARE
    v_society UUID;
    v_name TEXT := trim(regexp_replace(coalesce(p_details ->> 'buyer_name', ''), '\s+', ' ', 'g'));
    v_mobile_in TEXT := trim(coalesce(p_details ->> 'buyer_mobile', ''));
    v_mobile TEXT;
    v_email TEXT := nullif(lower(trim(coalesce(p_details ->> 'buyer_email', ''))), '');
    v_number TEXT := nullif(trim(regexp_replace(coalesce(p_details ->> 'deed_number', ''), '\s+', ' ', 'g')), '');
    v_deed DATE;
    v_today DATE := (now() AT TIME ZONE 'Asia/Kolkata')::date;
    v_id UUID;
BEGIN
    SELECT society_id INTO v_society FROM units WHERE id = p_unit_id;
    IF v_society IS NULL OR NOT (is_society_admin(v_society) OR is_flat_owner(p_unit_id, auth.uid())) THEN
        RAISE EXCEPTION 'Only an owner of this flat can apply for a transfer';
    END IF;
    IF length(v_name) NOT BETWEEN 2 AND 120 THEN
        RAISE EXCEPTION 'Enter the buyer''s name';
    END IF;
    IF v_mobile_in = '' THEN
        RAISE EXCEPTION 'Enter the buyer''s mobile number';
    END IF;
    v_mobile := normalize_mobile(v_mobile_in);
    IF v_mobile IS NULL THEN
        RAISE EXCEPTION 'Mobile % is not a valid number', v_mobile_in;
    END IF;
    IF v_email IS NOT NULL AND (position('@' IN v_email) < 2 OR length(v_email) > 160) THEN
        RAISE EXCEPTION 'Enter a valid email for the buyer';
    END IF;
    -- the buyer is someone else: an owner's own mobile would hand the flat back to the seller
    IF EXISTS (
        SELECT 1 FROM society_memberships m
        LEFT JOIN auth.users au ON au.id = m.user_id
        LEFT JOIN profiles pr ON pr.id = m.user_id
        WHERE m.unit_id = p_unit_id AND m.is_active AND m.role <> 'resident_tenant'
          AND (normalize_mobile(au.phone) = v_mobile OR normalize_mobile(pr.phone) = v_mobile)) THEN
        RAISE EXCEPTION 'This mobile belongs to an owner of this flat';
    END IF;
    BEGIN
        v_deed := nullif(p_details ->> 'deed_date', '')::date;
    EXCEPTION WHEN others THEN
        v_deed := NULL;
    END;
    IF v_deed IS NULL THEN
        RAISE EXCEPTION 'Enter the sale deed date';
    END IF;
    IF v_deed > v_today THEN
        RAISE EXCEPTION 'The sale deed date cannot be in the future';
    END IF;
    IF length(coalesce(v_number, '')) > 40 THEN
        RAISE EXCEPTION 'The registration number can be up to 40 characters';
    END IF;
    PERFORM 1 FROM units WHERE id = p_unit_id FOR UPDATE;   -- one open transfer per flat
    IF EXISTS (SELECT 1 FROM flat_requests WHERE unit_id = p_unit_id AND kind = 'transfer' AND status IN ('submitted', 'changes_asked')) THEN
        RAISE EXCEPTION 'A transfer request for this flat is already open';
    END IF;

    INSERT INTO flat_requests (society_id, unit_id, kind, applicant_id, details, checklist)
    VALUES (v_society, p_unit_id, 'transfer', auth.uid(),
            jsonb_strip_nulls(jsonb_build_object('buyer_name', v_name, 'buyer_mobile', v_mobile, 'buyer_email', v_email,
                                                 'deed_date', v_deed, 'deed_number', v_number)),
            coalesce((SELECT checklist FROM request_checklists WHERE society_id = v_society AND kind = 'transfer'), '[]'::jsonb))
    RETURNING id INTO v_id;
    INSERT INTO request_events (request_id, actor, action) VALUES (v_id, auth.uid(), 'submitted');
    PERFORM notify_users(v_society, array_remove(society_managers(v_society), auth.uid()), 'request',
        'Transfer requested for flat ' || flat_label(p_unit_id), NULL, 'requests', v_id);
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.create_transfer_request(UUID, JSONB) TO authenticated;

-- An open transfer request, locked, for a managing role
CREATE OR REPLACE FUNCTION public.open_transfer_for_committee(p_request_id UUID)
RETURNS flat_requests AS $$
DECLARE
    v_r flat_requests%ROWTYPE;
BEGIN
    SELECT * INTO v_r FROM flat_requests WHERE id = p_request_id AND kind = 'transfer' FOR UPDATE;
    IF NOT FOUND OR NOT is_society_admin(v_r.society_id) THEN
        RAISE EXCEPTION 'Only the committee can do this';
    END IF;
    IF v_r.status NOT IN ('submitted', 'changes_asked') THEN
        RAISE EXCEPTION 'This request has already been decided';
    END IF;
    RETURN v_r;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.open_transfer_for_committee(UUID) FROM PUBLIC, anon, authenticated;

-- The committee bills the fee and premium (prefilled from the settings; a family transfer can be ₹0 premium)
CREATE OR REPLACE FUNCTION public.bill_transfer_fees(p_request_id UUID, p_fee NUMERIC, p_premium NUMERIC)
RETURNS UUID AS $$
DECLARE
    v_r flat_requests%ROWTYPE;
    v_fee NUMERIC := round(coalesce(p_fee, 0), 2);
    v_premium NUMERIC := round(coalesce(p_premium, 0), 2);
    v_bill UUID;
BEGIN
    v_r := open_transfer_for_committee(p_request_id);
    IF v_r.details ? 'fees_billed_at' THEN
        RAISE EXCEPTION 'The transfer fees are already billed';
    END IF;
    IF v_fee < 0 OR v_fee > 100000 OR v_premium < 0 THEN
        RAISE EXCEPTION 'Amounts must be between ₹0 and ₹1,00,000';
    END IF;
    IF v_premium > 25000 THEN
        RAISE EXCEPTION 'The transfer premium can be at most ₹25,000';
    END IF;
    v_bill := charge_flat(v_r.unit_id, jsonb_build_array(
        jsonb_build_object('rule_key', 'transfer_fee', 'description', 'Transfer fee', 'amount', v_fee),
        jsonb_build_object('rule_key', 'transfer_premium', 'description', 'Transfer premium', 'amount', v_premium)),
        (now() AT TIME ZONE 'Asia/Kolkata')::date + 7);
    UPDATE flat_requests SET details = details || jsonb_build_object('fee', v_fee, 'premium', v_premium,
                                                                     'fee_bill_id', v_bill, 'fees_billed_at', now())
    WHERE id = p_request_id;
    INSERT INTO request_events (request_id, actor, action, note) VALUES (p_request_id, auth.uid(), 'fees_billed', inr_text(v_fee + v_premium));
    IF v_bill IS NOT NULL THEN
        PERFORM notify_users(v_r.society_id, (
            SELECT array_agg(DISTINCT x) FROM (
                SELECT v_r.applicant_id AS x
                UNION SELECT m.user_id FROM society_memberships m
                WHERE m.unit_id = v_r.unit_id AND m.is_active
                  AND m.role IN ('resident_owner', 'society_admin', 'secretary', 'chairman', 'treasurer', 'committee_member')
            ) y WHERE x IS NOT NULL AND x <> auth.uid()
        ), 'request', 'Transfer fees billed for flat ' || flat_label(v_r.unit_id) || ': ' || inr_text(v_fee + v_premium),
           NULL, 'requests', p_request_id);
    END IF;
    RETURN v_bill;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.bill_transfer_fees(UUID, NUMERIC, NUMERIC) TO authenticated;

-- cancel_bill (011) without the role check, and only for a bill nothing was paid on
CREATE OR REPLACE FUNCTION public.cancel_flat_charge(p_bill_id UUID, p_reason TEXT)
RETURNS VOID AS $$
DECLARE
    v_bill bills%ROWTYPE;
BEGIN
    SELECT * INTO v_bill FROM bills WHERE id = p_bill_id FOR UPDATE;
    IF NOT FOUND OR v_bill.status = 'cancelled' OR v_bill.amount_paid > 0
       OR EXISTS (SELECT 1 FROM payment_allocations WHERE bill_id = p_bill_id) THEN
        RETURN;
    END IF;
    UPDATE bills SET status = 'cancelled', balance_due = 0, updated_at = timezone('utc'::text, now()) WHERE id = p_bill_id;
    PERFORM ledger_reverse(v_bill.society_id, 'bill.issued', v_bill.id, 'bill.cancelled', current_date,
                           'Bill ' || v_bill.bill_number || ' cancelled: ' || p_reason);
    PERFORM ledger_reverse(v_bill.society_id, 'bill.late_fee', v_bill.id, 'bill.late_fee_cancelled', current_date,
                           'Late fee on bill ' || v_bill.bill_number || ' cancelled');
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, reason)
    VALUES (v_bill.society_id, auth.uid(), 'bill.cancelled', 'bill', p_bill_id::text,
            jsonb_build_object('bill_number', v_bill.bill_number, 'total', v_bill.total_amount, 'status', v_bill.status), p_reason);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.cancel_flat_charge(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- A withdrawn or rejected transfer takes its unpaid fee bill with it; a paid one stays (the committee refunds outside)
CREATE OR REPLACE FUNCTION public.trg_transfer_closed_cancels_fees()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.details ->> 'fee_bill_id' IS NOT NULL THEN
        PERFORM cancel_flat_charge((NEW.details ->> 'fee_bill_id')::uuid, 'Transfer request ' || NEW.status);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.trg_transfer_closed_cancels_fees() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_transfer_closed_cancels_fees ON flat_requests;
CREATE TRIGGER trg_transfer_closed_cancels_fees AFTER UPDATE OF status ON flat_requests
    FOR EACH ROW WHEN (NEW.kind = 'transfer' AND NEW.status IN ('withdrawn', 'rejected') AND OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION public.trg_transfer_closed_cancels_fees();
