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

-- ============================================================================
-- 2. BOOKING AND APPROVAL
-- ============================================================================
CREATE TABLE IF NOT EXISTS shiftings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    request_id UUID UNIQUE REFERENCES flat_requests(id) ON DELETE SET NULL,
    direction VARCHAR(3) NOT NULL CHECK (direction IN ('in', 'out')),
    shift_date DATE NOT NULL,
    shift_time TIME NOT NULL,
    vehicle TEXT,
    charge_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    deposit_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    bill_id UUID REFERENCES bills(id) ON DELETE SET NULL,
    deposit_status VARCHAR(10) NOT NULL DEFAULT 'none' CHECK (deposit_status IN ('none', 'held', 'refunded')),
    kept_amount NUMERIC(10,2),
    kept_reason TEXT,
    refunded_on DATE,
    refund_journal_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shiftings_society ON shiftings (society_id, shift_date);
ALTER TABLE shiftings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shiftings_select ON shiftings;
CREATE POLICY shiftings_select ON shiftings FOR SELECT USING (can_see_request(request_id));

CREATE OR REPLACE FUNCTION public.create_shifting_request(p_unit_id UUID, p_details JSONB)
RETURNS UUID AS $$
DECLARE
    v_society UUID;
    v_set society_settings%ROWTYPE;
    v_dir TEXT := p_details ->> 'direction';
    v_date DATE;
    v_time TIME;
    v_vehicle TEXT := trim(regexp_replace(coalesce(p_details ->> 'vehicle', ''), '\s+', ' ', 'g'));
    v_today DATE := (now() AT TIME ZONE 'Asia/Kolkata')::date;
    v_from TIME;
    v_to TIME;
    v_id UUID;
BEGIN
    SELECT society_id INTO v_society FROM units WHERE id = p_unit_id;
    IF v_society IS NULL OR NOT (
        is_society_admin(v_society) OR is_flat_owner(p_unit_id, auth.uid())
        OR EXISTS (SELECT 1 FROM society_memberships m JOIN societies s ON s.id = m.society_id AND s.is_active
                   WHERE m.unit_id = p_unit_id AND m.user_id = auth.uid() AND m.is_active AND m.role = 'resident_tenant')) THEN
        RAISE EXCEPTION 'Only someone living in this flat can book shifting';
    END IF;
    IF coalesce(v_dir, '') NOT IN ('in', 'out') THEN
        RAISE EXCEPTION 'Choose moving in or moving out';
    END IF;
    BEGIN
        v_date := (p_details ->> 'date')::date;
    EXCEPTION WHEN others THEN
        v_date := NULL;
    END;
    IF v_date IS NULL OR v_date < v_today OR v_date > v_today + 90 THEN
        RAISE EXCEPTION 'Choose a date from today up to 90 days ahead';
    END IF;
    SELECT * INTO v_set FROM society_settings WHERE society_id = v_society;
    v_from := coalesce(v_set.shifting_from, '08:00'::time);
    v_to := coalesce(v_set.shifting_to, '20:00'::time);
    BEGIN
        v_time := (p_details ->> 'time')::time;
    EXCEPTION WHEN others THEN
        v_time := NULL;
    END;
    IF v_time IS NULL OR v_time < v_from OR v_time > v_to THEN
        RAISE EXCEPTION 'Shifting is allowed between % and %', to_char(v_from, 'HH24:MI'), to_char(v_to, 'HH24:MI');
    END IF;
    IF length(v_vehicle) > 80 THEN
        RAISE EXCEPTION 'Vehicle details can be up to 80 characters';
    END IF;

    INSERT INTO flat_requests (society_id, unit_id, kind, applicant_id, details, checklist)
    VALUES (v_society, p_unit_id, 'shifting', auth.uid(),
            jsonb_build_object('direction', v_dir, 'date', v_date, 'time', to_char(v_time, 'HH24:MI'), 'vehicle', v_vehicle),
            coalesce((SELECT checklist FROM request_checklists WHERE society_id = v_society AND kind = 'shifting'), '[]'::jsonb))
    RETURNING id INTO v_id;
    INSERT INTO request_events (request_id, actor, action) VALUES (v_id, auth.uid(), 'submitted');
    PERFORM notify_users(v_society, array_remove(society_managers(v_society), auth.uid()), 'request',
        'Shifting booked for flat ' || flat_label(p_unit_id) || ' on ' || to_char(v_date, 'DD Mon YYYY'), NULL, 'requests', v_id);
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.create_shifting_request(UUID, JSONB) TO authenticated;

-- decide_request from 041, with the shifting branch
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
            v_on + 7);
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
