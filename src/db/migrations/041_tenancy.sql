-- ============================================================================
-- 041: Phase 11B — tenant registration
--      (spec docs/superpowers/specs/2026-11-24-flat-changes-design.md, 5.3)
-- ============================================================================

-- ============================================================================
-- 1. DOCUMENT LISTS PER SOCIETY FOR TENANCY (and later shifting, transfer)
-- ============================================================================
CREATE TABLE IF NOT EXISTS request_checklists (
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('tenancy', 'shifting', 'transfer')),
    checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
    PRIMARY KEY (society_id, kind)
);
ALTER TABLE request_checklists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS request_checklists_select ON request_checklists;
CREATE POLICY request_checklists_select ON request_checklists FOR SELECT
    USING (has_society_membership(society_id) OR is_committee_viewer(society_id));

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

CREATE OR REPLACE FUNCTION public.trg_society_request_checklists()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM seed_request_checklists(NEW.id);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.trg_society_request_checklists() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_society_request_checklists ON societies;
CREATE TRIGGER trg_society_request_checklists AFTER INSERT ON societies FOR EACH ROW EXECUTE FUNCTION public.trg_society_request_checklists();

-- The 11A checklist rules: up to 10 items, a label of 2-120 characters, an item keeps a key it already had,
-- new items get d1, d2 ... after the highest used
CREATE OR REPLACE FUNCTION public.normalize_checklist(p_old JSONB, p_new JSONB)
RETURNS JSONB AS $$
DECLARE
    v_old JSONB := coalesce(p_old, '[]'::jsonb);
    v_next INT;
    v_item JSONB;
    v_label TEXT;
    v_key TEXT;
    v_out JSONB := '[]'::jsonb;
BEGIN
    IF p_new IS NULL OR jsonb_typeof(p_new) <> 'array' OR jsonb_array_length(p_new) > 10 THEN
        RAISE EXCEPTION 'Up to 10 documents, each with a name';
    END IF;
    SELECT coalesce(max(substr(k, 2)::int), 0) INTO v_next
    FROM (SELECT x ->> 'key' AS k FROM jsonb_array_elements(v_old || p_new) x) y
    WHERE k ~ '^d[0-9]+$';
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_new) LOOP
        v_label := trim(coalesce(v_item ->> 'label', ''));
        IF length(v_label) NOT BETWEEN 2 AND 120 OR coalesce(v_item ->> 'required', 'false') NOT IN ('true', 'false') THEN
            RAISE EXCEPTION 'Up to 10 documents, each with a name';
        END IF;
        v_key := v_item ->> 'key';
        IF v_key IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_old) o WHERE o ->> 'key' = v_key)
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_out) o WHERE o ->> 'key' = v_key) THEN
            v_next := v_next + 1;
            v_key := 'd' || v_next;
        END IF;
        v_out := v_out || jsonb_build_array(jsonb_build_object(
            'key', v_key, 'label', v_label, 'required', (coalesce(v_item ->> 'required', 'false'))::boolean));
    END LOOP;
    RETURN v_out;
END;
$$ LANGUAGE plpgsql IMMUTABLE SET search_path = public;
REVOKE ALL ON FUNCTION public.normalize_checklist(JSONB, JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.save_request_checklist(p_society_id UUID, p_kind TEXT, p_checklist JSONB)
RETURNS JSONB AS $$
DECLARE
    v_old JSONB;
    v_new JSONB;
BEGIN
    IF NOT is_society_admin(p_society_id) THEN
        RAISE EXCEPTION 'Only the committee can change this';
    END IF;
    IF coalesce(p_kind, '') NOT IN ('tenancy', 'shifting', 'transfer') THEN
        RAISE EXCEPTION 'Choose a kind of request';
    END IF;
    SELECT checklist INTO v_old FROM request_checklists WHERE society_id = p_society_id AND kind = p_kind;
    v_new := normalize_checklist(v_old, p_checklist);
    INSERT INTO request_checklists (society_id, kind, checklist) VALUES (p_society_id, p_kind, v_new)
    ON CONFLICT (society_id, kind) DO UPDATE SET checklist = EXCLUDED.checklist;
    RETURN v_new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.save_request_checklist(UUID, TEXT, JSONB) TO authenticated;

-- ============================================================================
-- 2. TENANCY REQUESTS AND THE TENANCIES REGISTER
--    A tenancy row is made when the committee approves the request (section 3).
-- ============================================================================
CREATE TABLE IF NOT EXISTS tenancies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    request_id UUID UNIQUE REFERENCES flat_requests(id) ON DELETE SET NULL,
    tenant_name VARCHAR(80) NOT NULL,
    tenant_mobile VARCHAR(16) NOT NULL,
    tenant_email VARCHAR(191),
    occupants INT NOT NULL DEFAULT 1 CHECK (occupants BETWEEN 1 AND 20),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL CHECK (end_date > start_date),
    police_ref VARCHAR(60),
    status VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'renewed')),
    ended_on DATE,
    renews_id UUID REFERENCES tenancies(id) ON DELETE SET NULL,
    invite_id UUID REFERENCES member_invites(id) ON DELETE SET NULL,
    reminded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenancy_active ON tenancies (unit_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_tenancies_society ON tenancies (society_id, status, end_date);
ALTER TABLE tenancies ENABLE ROW LEVEL SECURITY;

-- The committee; the flat's owners for tenancies since they became owners; the tenant living there
CREATE OR REPLACE FUNCTION public.can_see_tenancy(p_tenancy_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (SELECT 1 FROM tenancies t WHERE t.id = p_tenancy_id AND (
        is_committee_viewer(t.society_id)
        OR (is_flat_owner(t.unit_id, auth.uid()) AND t.created_at >= current_ownership_since(t.unit_id))
        OR EXISTS (SELECT 1 FROM society_memberships m JOIN societies s ON s.id = m.society_id AND s.is_active
                   WHERE m.unit_id = t.unit_id AND m.user_id = auth.uid() AND m.is_active AND m.role = 'resident_tenant')))
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.can_see_tenancy(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_see_tenancy(UUID) TO authenticated; -- used by RLS
DROP POLICY IF EXISTS tenancies_select ON tenancies;
CREATE POLICY tenancies_select ON tenancies FOR SELECT USING (can_see_tenancy(id));

-- Cleaned tenancy details, or an exception with the message the form shows
CREATE OR REPLACE FUNCTION public.clean_tenancy_details(p JSONB)
RETURNS JSONB AS $$
DECLARE
    v_name TEXT := trim(regexp_replace(coalesce(p ->> 'tenant_name', ''), '\s+', ' ', 'g'));
    v_mobile TEXT := normalize_mobile(p ->> 'tenant_mobile');
    v_email TEXT := lower(trim(coalesce(p ->> 'tenant_email', '')));
    v_occupants INT;
    v_start DATE;
    v_end DATE;
    v_police TEXT := trim(regexp_replace(coalesce(p ->> 'police_ref', ''), '\s+', ' ', 'g'));
BEGIN
    IF length(v_name) NOT BETWEEN 2 AND 80 THEN
        RAISE EXCEPTION 'Enter the tenant''s name (2 to 80 characters)';
    END IF;
    IF v_mobile IS NULL THEN
        RAISE EXCEPTION 'Enter a valid mobile number';
    END IF;
    IF v_email <> '' AND v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
        RAISE EXCEPTION 'Enter a valid email address';
    END IF;
    BEGIN
        v_occupants := (p ->> 'occupants')::int;
    EXCEPTION WHEN others THEN
        v_occupants := NULL;
    END;
    IF v_occupants IS NULL OR v_occupants NOT BETWEEN 1 AND 20 THEN
        RAISE EXCEPTION 'Number of people living there: 1 to 20';
    END IF;
    BEGIN
        v_start := (p ->> 'start_date')::date;
        v_end := (p ->> 'end_date')::date;
    EXCEPTION WHEN others THEN
        v_start := NULL;
    END;
    IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start OR v_end > v_start + interval '60 months' THEN
        RAISE EXCEPTION 'The agreement must end after it starts, within 60 months';
    END IF;
    IF length(v_police) > 60 THEN
        RAISE EXCEPTION 'The police reference can be up to 60 characters';
    END IF;
    RETURN jsonb_build_object('tenant_name', v_name, 'tenant_mobile', v_mobile, 'tenant_email', nullif(v_email, ''),
        'occupants', v_occupants, 'start_date', v_start, 'end_date', v_end, 'police_ref', nullif(v_police, ''),
        'renews_id', nullif(p ->> 'renews_id', ''));
END;
$$ LANGUAGE plpgsql IMMUTABLE SET search_path = public;
REVOKE ALL ON FUNCTION public.clean_tenancy_details(JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_tenancy_request(p_unit_id UUID, p_details JSONB)
RETURNS UUID AS $$
DECLARE
    v_society UUID;
    v_details JSONB;
    v_active UUID;
    v_renews UUID;
    v_id UUID;
BEGIN
    SELECT society_id INTO v_society FROM units WHERE id = p_unit_id;
    IF v_society IS NULL OR NOT (is_society_admin(v_society) OR is_flat_owner(p_unit_id, auth.uid())) THEN
        RAISE EXCEPTION 'Only an owner of this flat can register a tenant';
    END IF;
    v_details := clean_tenancy_details(coalesce(p_details, '{}'::jsonb));
    SELECT id INTO v_active FROM tenancies WHERE unit_id = p_unit_id AND status = 'active';
    IF v_details ->> 'renews_id' IS NOT NULL THEN
        BEGIN
            v_renews := (v_details ->> 'renews_id')::uuid;
        EXCEPTION WHEN others THEN
            v_renews := NULL;
        END;
        IF v_renews IS NULL OR v_renews IS DISTINCT FROM v_active THEN
            RAISE EXCEPTION 'Choose the tenancy this renews';
        END IF;
    ELSIF v_active IS NOT NULL THEN
        RAISE EXCEPTION 'This flat already has a tenant. End that tenancy or renew it.';
    END IF;

    INSERT INTO flat_requests (society_id, unit_id, kind, applicant_id, details, checklist)
    VALUES (v_society, p_unit_id, 'tenancy', auth.uid(), v_details,
            coalesce((SELECT checklist FROM request_checklists WHERE society_id = v_society AND kind = 'tenancy'), '[]'::jsonb))
    RETURNING id INTO v_id;
    INSERT INTO request_events (request_id, actor, action) VALUES (v_id, auth.uid(), 'submitted');
    PERFORM notify_users(v_society, array_remove(society_managers(v_society), auth.uid()), 'request',
        'Tenant registration for flat ' || flat_label(p_unit_id), NULL, 'requests', v_id);
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.create_tenancy_request(UUID, JSONB) TO authenticated;

-- ============================================================================
-- 3. APPROVAL, RENEWAL AND ENDING
-- ============================================================================
-- The tenancy an approved request makes: a renewal replaces the one it names and keeps its invite; a new tenant
-- gets a resident_tenant invite unless a tenant on the flat already has that mobile
CREATE OR REPLACE FUNCTION public.approve_tenancy(p_r flat_requests)
RETURNS UUID AS $$
DECLARE
    d JSONB := p_r.details;
    v_old tenancies%ROWTYPE;
    v_invite UUID;
    v_id UUID;
BEGIN
    IF d ->> 'renews_id' IS NOT NULL THEN
        SELECT * INTO v_old FROM tenancies WHERE id = (d ->> 'renews_id')::uuid AND unit_id = p_r.unit_id FOR UPDATE;
        IF NOT FOUND OR v_old.status <> 'active' THEN
            RAISE EXCEPTION 'The tenancy being renewed has already ended';
        END IF;
        UPDATE tenancies SET status = 'renewed' WHERE id = v_old.id;
        v_invite := v_old.invite_id;
    ELSE
        IF EXISTS (SELECT 1 FROM tenancies WHERE unit_id = p_r.unit_id AND status = 'active') THEN
            RAISE EXCEPTION 'This flat already has a tenant. End that tenancy or renew it.';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM society_memberships m
            LEFT JOIN auth.users au ON au.id = m.user_id
            LEFT JOIN profiles pr ON pr.id = m.user_id
            WHERE m.unit_id = p_r.unit_id AND m.is_active AND m.role = 'resident_tenant'
              AND (normalize_mobile(au.phone) = d ->> 'tenant_mobile' OR normalize_mobile(pr.phone) = d ->> 'tenant_mobile')) THEN
            SELECT id INTO v_invite FROM member_invites
            WHERE society_id = p_r.society_id AND unit_id = p_r.unit_id AND status = 'pending'
              AND normalize_mobile(mobile) = d ->> 'tenant_mobile';
            IF v_invite IS NULL THEN
                INSERT INTO member_invites (society_id, email, mobile, full_name, role, unit_id, invited_by)
                VALUES (p_r.society_id, d ->> 'tenant_email', d ->> 'tenant_mobile', d ->> 'tenant_name', 'resident_tenant',
                        p_r.unit_id, auth.uid())
                RETURNING id INTO v_invite;
            END IF;
        END IF;
    END IF;
    INSERT INTO tenancies (society_id, unit_id, request_id, tenant_name, tenant_mobile, tenant_email, occupants,
                           start_date, end_date, police_ref, renews_id, invite_id)
    VALUES (p_r.society_id, p_r.unit_id, p_r.id, d ->> 'tenant_name', d ->> 'tenant_mobile', d ->> 'tenant_email',
            (d ->> 'occupants')::int, (d ->> 'start_date')::date, (d ->> 'end_date')::date, d ->> 'police_ref',
            v_old.id, v_invite)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.approve_tenancy(flat_requests) FROM PUBLIC, anon, authenticated;

-- decide_request from 040, with the tenancy branch
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
    v_type := coalesce(v_type, CASE v_r.kind WHEN 'tenancy' THEN 'Tenant registration' ELSE initcap(v_r.kind) END);

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

CREATE OR REPLACE FUNCTION public.end_tenancy(p_tenancy_id UUID, p_end_date DATE)
RETURNS VOID AS $$
DECLARE
    v_t tenancies%ROWTYPE;
    v_end DATE := coalesce(p_end_date, (now() AT TIME ZONE 'Asia/Kolkata')::date);
BEGIN
    SELECT * INTO v_t FROM tenancies WHERE id = p_tenancy_id FOR UPDATE;
    IF NOT FOUND OR NOT (is_society_admin(v_t.society_id)
        OR (is_flat_owner(v_t.unit_id, auth.uid()) AND v_t.created_at >= current_ownership_since(v_t.unit_id))) THEN
        RAISE EXCEPTION 'Only an owner of this flat or the committee can end the tenancy';
    END IF;
    IF v_t.status <> 'active' THEN
        RAISE EXCEPTION 'This tenancy has already ended';
    END IF;
    -- a chosen date cannot come before the start; ending today a tenancy that has not started (a renewal) cancels it
    IF p_end_date IS NOT NULL AND p_end_date < v_t.start_date THEN
        RAISE EXCEPTION 'The end date cannot be before the tenancy started';
    END IF;
    UPDATE tenancies SET status = 'ended', ended_on = v_end WHERE id = p_tenancy_id;
    -- the tenant leaves: their access to the flat ends, and an invite not yet accepted can no longer be
    UPDATE society_memberships SET is_active = false
    WHERE unit_id = v_t.unit_id AND role = 'resident_tenant' AND is_active;
    UPDATE member_invites SET status = 'revoked'
    WHERE unit_id = v_t.unit_id AND role = 'resident_tenant' AND status = 'pending';
    IF v_t.request_id IS NOT NULL THEN
        INSERT INTO request_events (request_id, actor, action, note)
        VALUES (v_t.request_id, auth.uid(), 'tenancy_ended', to_char(v_end, 'DD Mon YYYY'));
    END IF;
    PERFORM notify_users(v_t.society_id, array_remove(society_managers(v_t.society_id), auth.uid()), 'tenancy',
        'Tenancy of flat ' || flat_label(v_t.unit_id) || ' ended', v_t.tenant_name, 'requests', p_tenancy_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.end_tenancy(UUID, DATE) TO authenticated;
