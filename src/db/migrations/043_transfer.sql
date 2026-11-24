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
    -- the buyer is someone else: an owner's own mobile or email would hand the flat back to the seller
    -- (the invite is claimed by mobile or by email)
    IF EXISTS (
        SELECT 1 FROM society_memberships m
        LEFT JOIN auth.users au ON au.id = m.user_id
        LEFT JOIN profiles pr ON pr.id = m.user_id
        WHERE m.unit_id = p_unit_id AND m.is_active AND m.role <> 'resident_tenant'
          AND (normalize_mobile(au.phone) = v_mobile OR normalize_mobile(pr.phone) = v_mobile
               OR (v_email IS NOT NULL AND (lower(au.email) = v_email OR lower(pr.email) = v_email)))) THEN
        RAISE EXCEPTION 'This mobile or email belongs to an owner of this flat';
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
    IF EXISTS (SELECT 1 FROM unit_ownerships WHERE unit_id = p_unit_id AND to_date IS NULL AND owner_user_id IS NULL) THEN
        RAISE EXCEPTION 'This flat has an owner change waiting for the new owner to join';
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

-- cancel_bill (011) without the role check. What was paid on the bill (a payment, or an advance the bill took on
-- issue) goes back to the flat's advance first, so a sale that did not happen keeps none of the seller's money.
CREATE OR REPLACE FUNCTION public.cancel_flat_charge(p_bill_id UUID, p_reason TEXT)
RETURNS VOID AS $$
DECLARE
    v_bill bills%ROWTYPE;
    v_allocated NUMERIC;
    v_left NUMERIC;
    v_back NUMERIC;
    v_adv RECORD;
BEGIN
    SELECT * INTO v_bill FROM bills WHERE id = p_bill_id FOR UPDATE;
    IF NOT FOUND OR v_bill.status = 'cancelled' THEN
        RETURN;
    END IF;
    IF v_bill.amount_paid > 0 THEN
        SELECT coalesce(sum(amount), 0) INTO v_allocated FROM payment_allocations WHERE bill_id = p_bill_id;
        -- the rest came from opening advances (ledger_apply_advance uses them first); put it back, newest first
        v_left := greatest(v_bill.amount_paid - v_allocated, 0);
        FOR v_adv IN SELECT id, amount - remaining AS used FROM opening_advances
                     WHERE unit_id = v_bill.unit_id AND remaining < amount ORDER BY created_at DESC FOR UPDATE LOOP
            EXIT WHEN v_left <= 0;
            v_back := least(v_adv.used, v_left);
            UPDATE opening_advances SET remaining = remaining + v_back WHERE id = v_adv.id;
            v_left := v_left - v_back;
        END LOOP;
        DELETE FROM payment_allocations WHERE bill_id = p_bill_id;
        PERFORM post_journal(v_bill.society_id, current_date, 'advance.returned', v_bill.id,
            'Paid on bill ' || v_bill.bill_number || ' back to the flat''s advance: ' || p_reason,
            jsonb_build_array(
                jsonb_build_object('code', '1200', 'amount', v_bill.amount_paid, 'party', v_bill.unit_id::text),
                jsonb_build_object('code', '2300', 'amount', -v_bill.amount_paid, 'party', v_bill.unit_id::text)));
    END IF;
    UPDATE bills SET status = 'cancelled', amount_paid = 0, balance_due = 0, updated_at = timezone('utc'::text, now()) WHERE id = p_bill_id;
    PERFORM ledger_reverse(v_bill.society_id, 'bill.issued', v_bill.id, 'bill.cancelled', current_date,
                           'Bill ' || v_bill.bill_number || ' cancelled: ' || p_reason);
    PERFORM ledger_reverse(v_bill.society_id, 'bill.late_fee', v_bill.id, 'bill.late_fee_cancelled', current_date,
                           'Late fee on bill ' || v_bill.bill_number || ' cancelled');
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, reason)
    VALUES (v_bill.society_id, auth.uid(), 'bill.cancelled', 'bill', p_bill_id::text,
            jsonb_build_object('bill_number', v_bill.bill_number, 'total', v_bill.total_amount, 'status', v_bill.status,
                               'paid_back_to_advance', v_bill.amount_paid), p_reason);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.cancel_flat_charge(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- A withdrawn or rejected transfer takes its fee bill with it; anything paid on it becomes the flat's advance
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

-- ============================================================================
-- 3. APPROVAL RUNS THE OWNER CHANGE
-- ============================================================================
-- The committee's part before approving: the original share certificate received, its number, the endorsement
-- and transfer dates (each key optional; the transfer date defaults to the approval day)
CREATE OR REPLACE FUNCTION public.save_transfer_handover(p_request_id UUID, p_details JSONB)
RETURNS VOID AS $$
DECLARE
    v_r flat_requests%ROWTYPE;
    v_add JSONB := '{}'::jsonb;
    v_cert TEXT;
    v_date DATE;
BEGIN
    v_r := open_transfer_for_committee(p_request_id);
    IF p_details ? 'certificate_received' THEN
        v_add := v_add || jsonb_build_object('certificate_received', coalesce((p_details ->> 'certificate_received')::boolean, false));
    END IF;
    IF p_details ? 'share_certificate_no' THEN
        v_cert := nullif(trim(coalesce(p_details ->> 'share_certificate_no', '')), '');
        IF length(coalesce(v_cert, '')) > 40 THEN
            RAISE EXCEPTION 'The share certificate number can be up to 40 characters';
        END IF;
        v_add := v_add || jsonb_build_object('share_certificate_no', v_cert);
    END IF;
    IF p_details ? 'endorsed_on' THEN
        BEGIN
            v_date := nullif(p_details ->> 'endorsed_on', '')::date;
        EXCEPTION WHEN others THEN
            RAISE EXCEPTION 'Enter the endorsement date';
        END;
        v_add := v_add || jsonb_build_object('endorsed_on', v_date);
    END IF;
    IF p_details ? 'transfer_date' THEN
        BEGIN
            v_date := nullif(p_details ->> 'transfer_date', '')::date;
        EXCEPTION WHEN others THEN
            RAISE EXCEPTION 'Enter the transfer date';
        END;
        IF v_date > current_date THEN   -- the day transfer_flat_owner checks against
            RAISE EXCEPTION 'The transfer date cannot be in the future';
        END IF;
        v_add := v_add || jsonb_build_object('transfer_date', v_date);
    END IF;
    -- a key sent empty is removed, so the default applies again
    UPDATE flat_requests SET details = jsonb_strip_nulls(details || v_add) WHERE id = p_request_id;
    IF coalesce((v_add ->> 'certificate_received')::boolean, false)
       AND NOT coalesce((v_r.details ->> 'certificate_received')::boolean, false) THEN
        INSERT INTO request_events (request_id, actor, action) VALUES (p_request_id, auth.uid(), 'certificate_received');
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.save_transfer_handover(UUID, JSONB) TO authenticated;

-- decide_request from 042, with the shifting gate and the transfer branch (their checks run before the status changes)
CREATE OR REPLACE FUNCTION public.decide_request(p_request_id UUID, p_decision TEXT, p_note TEXT)
RETURNS JSONB AS $$
DECLARE
    v_r flat_requests%ROWTYPE;
    v_type TEXT;
    v_note TEXT := nullif(trim(coalesce(p_note, '')), '');
    v_missing TEXT;
    v_on DATE := (now() AT TIME ZONE 'Asia/Kolkata')::date;
    v_doc JSONB;
    v_seq INT;
    v_letter UUID;
    v_number TEXT;
    v_tenancy UUID;
    v_set society_settings%ROWTYPE;
    v_charge NUMERIC;
    v_deposit NUMERIC;
    v_bill UUID;
    v_shifting UUID;
    v_dues NUMERIC;
    v_xfer JSONB;
    v_xfer_date DATE;
    v_cert TEXT;
    v_told UUID[];
BEGIN
    SELECT * INTO v_r FROM flat_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND OR NOT is_society_admin(v_r.society_id) THEN
        RAISE EXCEPTION 'Only the committee can decide requests';
    END IF;
    IF coalesce(p_decision, '') NOT IN ('approve', 'changes', 'reject') THEN
        RAISE EXCEPTION 'Choose approve, changes or reject';
    END IF;
    IF v_r.status NOT IN ('submitted', 'changes_asked') THEN
        RAISE EXCEPTION 'This request has already been decided';
    END IF;
    IF v_r.status = 'changes_asked' AND p_decision <> 'reject' THEN
        RAISE EXCEPTION 'Wait for the applicant to send the changes';
    END IF;
    SELECT name INTO v_type FROM noc_types WHERE id = v_r.noc_type_id;
    v_type := coalesce(v_type, CASE v_r.kind WHEN 'tenancy' THEN 'Tenant registration' WHEN 'shifting' THEN 'Shifting' ELSE initcap(v_r.kind) END);

    IF p_decision = 'changes' THEN
        IF length(coalesce(v_note, '')) NOT BETWEEN 3 AND 500 THEN
            RAISE EXCEPTION 'Write what needs to change';
        END IF;
        UPDATE flat_requests SET status = 'changes_asked', committee_note = v_note WHERE id = p_request_id;
        INSERT INTO request_events (request_id, actor, action, note) VALUES (p_request_id, auth.uid(), 'changes_asked', v_note);
        PERFORM notify_users(v_r.society_id, ARRAY[v_r.applicant_id], 'request', 'Changes needed: ' || v_type, v_note, 'requests', p_request_id);
        RETURN jsonb_build_object('status', 'changes_asked');
    END IF;

    IF p_decision = 'reject' THEN
        IF length(coalesce(v_note, '')) NOT BETWEEN 3 AND 500 THEN
            RAISE EXCEPTION 'Write the reason';
        END IF;
        UPDATE flat_requests SET status = 'rejected', committee_note = v_note, decided_at = now(), decided_by = auth.uid()
        WHERE id = p_request_id;
        INSERT INTO request_events (request_id, actor, action, note) VALUES (p_request_id, auth.uid(), 'rejected', v_note);
        PERFORM notify_users(v_r.society_id, ARRAY[v_r.applicant_id], 'request',
            CASE WHEN v_r.kind = 'noc' THEN 'NOC request declined: ' ELSE 'Request declined: ' END || v_type, v_note, 'requests', p_request_id);
        RETURN jsonb_build_object('status', 'rejected');
    END IF;

    -- approve: every required document is there
    SELECT c ->> 'label' INTO v_missing
    FROM jsonb_array_elements(v_r.checklist) WITH ORDINALITY AS t(c, i)
    WHERE coalesce((c ->> 'required')::boolean, false)
      AND NOT EXISTS (SELECT 1 FROM request_documents d WHERE d.request_id = p_request_id AND d.item_key = c ->> 'key')
    ORDER BY i LIMIT 1;
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'Add "%" before approving', v_missing;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM society_memberships m WHERE m.unit_id = v_r.unit_id AND m.user_id = v_r.applicant_id AND m.is_active)
       AND NOT EXISTS (SELECT 1 FROM society_memberships m WHERE m.society_id = v_r.society_id AND m.user_id = v_r.applicant_id
                       AND m.is_active AND m.role IN ('society_admin', 'secretary', 'chairman', 'treasurer')) THEN
        RAISE EXCEPTION 'The applicant is no longer a member of this flat';
    END IF;
    -- 043: a society can require the shifting booked first (a move-in for a tenant, a move-out for a sale)
    -- A renewal is the same tenant staying, so no move. A sale needs the move-out approved: once the flat is sold
    -- the seller is no longer a member and a booking still waiting could never be approved.
    IF v_r.kind IN ('tenancy', 'transfer')
       AND NOT (v_r.kind = 'tenancy' AND v_r.details ->> 'renews_id' IS NOT NULL)
       AND coalesce((SELECT shifting_required FROM society_settings WHERE society_id = v_r.society_id), false)
       AND NOT EXISTS (SELECT 1 FROM flat_requests s
                       WHERE s.unit_id = v_r.unit_id AND s.kind = 'shifting'
                         AND s.status IN ('approved', CASE v_r.kind WHEN 'tenancy' THEN 'submitted' ELSE 'approved' END)
                         AND s.details ->> 'direction' = CASE v_r.kind WHEN 'tenancy' THEN 'in' ELSE 'out' END
                         AND s.submitted_at >= v_r.submitted_at - interval '60 days') THEN
        RAISE EXCEPTION 'Book the move-% shifting for this flat first', CASE v_r.kind WHEN 'tenancy' THEN 'in' ELSE 'out' END;
    END IF;

    -- 043: a transfer needs the fees billed, the original share certificate in hand and no dues
    IF v_r.kind = 'transfer' THEN
        -- transfer_flat_owner would overwrite a change that waits for its new owner (2F's correction path)
        IF EXISTS (SELECT 1 FROM unit_ownerships WHERE unit_id = v_r.unit_id AND to_date IS NULL AND owner_user_id IS NULL) THEN
            RAISE EXCEPTION 'This flat has an owner change waiting for the new owner to join';
        END IF;
        IF NOT v_r.details ? 'fees_billed_at' THEN
            RAISE EXCEPTION 'Bill the transfer fees first (₹0 if none)';
        END IF;
        IF NOT coalesce((v_r.details ->> 'certificate_received')::boolean, false) THEN
            RAISE EXCEPTION 'Tick that the original share certificate is received';
        END IF;
        v_dues := flat_dues_on(v_r.unit_id, greatest(v_on, current_date));
        IF v_dues > 0 THEN
            RAISE EXCEPTION 'Clear dues of % before the transfer', inr_text(v_dues);
        END IF;
    END IF;

    UPDATE flat_requests SET status = 'approved', committee_note = v_note, decided_at = now(), decided_by = auth.uid()
    WHERE id = p_request_id;
    INSERT INTO request_events (request_id, actor, action, note) VALUES (p_request_id, auth.uid(), 'approved', v_note);

    -- 041: an approved tenant registration records the tenancy and invites the tenant
    IF v_r.kind = 'tenancy' THEN
        v_tenancy := approve_tenancy(v_r);
        PERFORM notify_users(v_r.society_id, (
            SELECT array_agg(DISTINCT x) FROM (
                SELECT v_r.applicant_id AS x
                UNION SELECT m.user_id FROM society_memberships m
                WHERE m.unit_id = v_r.unit_id AND m.is_active
                  AND m.role IN ('resident_owner', 'society_admin', 'secretary', 'chairman', 'treasurer', 'committee_member')
            ) y WHERE x IS NOT NULL AND x <> auth.uid()
        ), 'request', 'Tenant registered for flat ' || flat_label(v_r.unit_id), NULL, 'requests', p_request_id);
        RETURN jsonb_build_object('status', 'approved', 'tenancy_id', v_tenancy);
    END IF;

    -- 042: an approved shifting bills the society's charge and refundable deposit for that direction
    IF v_r.kind = 'shifting' THEN
        SELECT * INTO v_set FROM society_settings WHERE society_id = v_r.society_id;
        v_charge := coalesce(CASE v_r.details ->> 'direction' WHEN 'in' THEN v_set.move_in_charge ELSE v_set.move_out_charge END, 0);
        v_deposit := coalesce(CASE v_r.details ->> 'direction' WHEN 'in' THEN v_set.move_in_deposit ELSE v_set.move_out_deposit END, 0);
        v_bill := charge_flat(v_r.unit_id, jsonb_build_array(
            jsonb_build_object('rule_key', 'shifting_charge', 'amount', v_charge,
                'description', 'Shifting charges (' || CASE v_r.details ->> 'direction' WHEN 'in' THEN 'moving in' ELSE 'moving out' END || ')'),
            jsonb_build_object('rule_key', 'shifting_deposit', 'amount', v_deposit, 'description', 'Shifting deposit (refundable)')),
            greatest(v_on + 7, (v_r.details ->> 'date')::date));
        INSERT INTO shiftings (society_id, unit_id, request_id, direction, shift_date, shift_time, vehicle,
                               charge_amount, deposit_amount, bill_id, deposit_status)
        VALUES (v_r.society_id, v_r.unit_id, p_request_id, v_r.details ->> 'direction', (v_r.details ->> 'date')::date,
                (v_r.details ->> 'time')::time, nullif(v_r.details ->> 'vehicle', ''), v_charge, v_deposit, v_bill,
                CASE WHEN v_deposit > 0 THEN 'held' ELSE 'none' END)
        RETURNING id INTO v_shifting;
        PERFORM notify_users(v_r.society_id, (
            SELECT array_agg(DISTINCT x) FROM (
                SELECT v_r.applicant_id AS x
                UNION SELECT m.user_id FROM society_memberships m
                WHERE m.unit_id = v_r.unit_id AND m.is_active
                  AND m.role IN ('resident_owner', 'society_admin', 'secretary', 'chairman', 'treasurer', 'committee_member')
            ) y WHERE x IS NOT NULL AND x <> auth.uid()
        ), 'request', 'Shifting approved for flat ' || flat_label(v_r.unit_id) || ' on '
                      || to_char((v_r.details ->> 'date')::date, 'DD Mon YYYY'), NULL, 'requests', p_request_id);
        RETURN jsonb_build_object('status', 'approved', 'shifting_id', v_shifting, 'bill_id', v_bill);
    END IF;

    -- 043: an approved transfer runs the owner change (Phase 2F) and records the share certificate
    IF v_r.kind = 'transfer' THEN
        -- told before the change: notifications go to active members, and the seller's owners stop being ones
        SELECT array_agg(DISTINCT x) INTO v_told FROM (
            SELECT v_r.applicant_id AS x
            UNION SELECT m.user_id FROM society_memberships m
            WHERE m.unit_id = v_r.unit_id AND m.is_active
              AND m.role IN ('resident_owner', 'society_admin', 'secretary', 'chairman', 'treasurer', 'committee_member')
            UNION SELECT unnest(society_managers(v_r.society_id))
        ) y WHERE x IS NOT NULL AND x <> auth.uid();
        PERFORM notify_users(v_r.society_id, v_told, 'request', 'Transfer approved for flat ' || flat_label(v_r.unit_id),
                             NULL, 'requests', p_request_id);
        -- current_date, the day transfer_flat_owner checks against
        v_xfer_date := coalesce((v_r.details ->> 'transfer_date')::date, current_date);
        v_xfer := transfer_flat_owner(v_r.unit_id, v_r.details ->> 'buyer_name', v_r.details ->> 'buyer_email',
                                      v_r.details ->> 'buyer_mobile', v_xfer_date);
        -- a seller on the committee keeps the committee role but not the flat (transfer_flat_owner ends owner memberships only)
        UPDATE society_memberships SET unit_id = NULL, updated_at = timezone('utc'::text, now())
        WHERE unit_id = v_r.unit_id AND is_active AND role IN ('society_admin', 'secretary', 'chairman', 'treasurer', 'committee_member');
        SELECT coalesce(v_r.details ->> 'share_certificate_no', share_certificate_no) INTO v_cert FROM units WHERE id = v_r.unit_id;
        UPDATE units SET share_certificate_no = v_cert, updated_at = timezone('utc'::text, now()) WHERE id = v_r.unit_id;
        UPDATE flat_requests SET details = details || jsonb_strip_nulls(jsonb_build_object(
                'transfer_date', v_xfer_date,
                'endorsed_on', coalesce((v_r.details ->> 'endorsed_on')::date, v_xfer_date),
                'share_certificate_no', v_cert,
                'ownership_id', v_xfer -> 'ownership_id', 'invite_id', v_xfer -> 'invite_id'))
        WHERE id = p_request_id;
        RETURN jsonb_build_object('status', 'approved', 'ownership_id', v_xfer -> 'ownership_id', 'invite_id', v_xfer -> 'invite_id');
    END IF;

    IF v_r.kind = 'noc' THEN
        PERFORM 1 FROM societies WHERE id = v_r.society_id FOR UPDATE;  -- one number at a time per society
        v_doc := render_noc(p_request_id, v_on);
        SELECT coalesce(max(seq), 0) + 1 INTO v_seq FROM noc_letters WHERE society_id = v_r.society_id AND fy = fy_label(v_on);
        v_number := 'NOC/' || fy_label(v_on) || '/' || lpad(v_seq::text, 3, '0');
        INSERT INTO noc_letters (society_id, request_id, number, fy, seq, issued_on, type_name, title, body, signatory,
                                 issued_to, flat_label, dues_amount, created_by)
        VALUES (v_r.society_id, p_request_id, v_number, fy_label(v_on), v_seq, v_on, v_doc ->> 'type_name', v_doc ->> 'title',
                v_doc ->> 'body', v_doc ->> 'signatory', v_doc ->> 'issued_to', v_doc ->> 'flat_label',
                (v_doc ->> 'dues_amount')::numeric, auth.uid())
        RETURNING id INTO v_letter;
        PERFORM notify_users(v_r.society_id, ARRAY[v_r.applicant_id], 'request', 'NOC approved: ' || v_type, v_number, 'requests', p_request_id);
        RETURN jsonb_build_object('status', 'approved', 'letter_id', v_letter, 'number', v_number);
    END IF;

    PERFORM notify_users(v_r.society_id, ARRAY[v_r.applicant_id], 'request', 'Request approved: ' || v_type, v_note, 'requests', p_request_id);
    RETURN jsonb_build_object('status', 'approved');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.decide_request(UUID, TEXT, TEXT) TO authenticated;

-- ============================================================================
-- 4. WHAT THE SCREENS READ
-- ============================================================================
-- The flat's dues on an open request, the figure the approval checks (the seller and the committee see it)
CREATE OR REPLACE FUNCTION public.request_flat_dues(p_request_id UUID)
RETURNS NUMERIC AS $$
    SELECT flat_dues_on(r.unit_id, greatest((now() AT TIME ZONE 'Asia/Kolkata')::date, current_date))
    FROM flat_requests r
    WHERE r.id = p_request_id AND r.status IN ('submitted', 'changes_asked') AND can_see_request(r.id)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.request_flat_dues(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_flat_dues(UUID) TO authenticated;
