-- ============================================================================
-- 040: Phase 11A — flat requests and NOC letters
--      (spec docs/superpowers/specs/2026-11-24-flat-changes-design.md, 5.1-5.2)
-- ============================================================================

-- ============================================================================
-- 1. NOC TYPES AND SHARE CERTIFICATE NUMBERS
-- ============================================================================
ALTER TABLE units ADD COLUMN IF NOT EXISTS share_certificate_no VARCHAR(32);

CREATE OR REPLACE FUNCTION public.set_share_certificate(p_unit_id UUID, p_number TEXT)
RETURNS VOID AS $$
DECLARE
    v_society UUID;
    v_no TEXT := nullif(trim(coalesce(p_number, '')), '');
BEGIN
    SELECT society_id INTO v_society FROM units WHERE id = p_unit_id;
    IF v_society IS NULL OR NOT is_society_admin(v_society) THEN
        RAISE EXCEPTION 'Only the committee can do this';
    END IF;
    IF length(coalesce(v_no, '')) > 32 THEN
        RAISE EXCEPTION 'The share certificate number can be up to 32 characters';
    END IF;
    UPDATE units SET share_certificate_no = v_no WHERE id = p_unit_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.set_share_certificate(UUID, TEXT) TO authenticated;

CREATE TABLE IF NOT EXISTS noc_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    code VARCHAR(32) NOT NULL,
    name VARCHAR(80) NOT NULL,
    title VARCHAR(120) NOT NULL,
    body TEXT NOT NULL,
    signatory VARCHAR(16) NOT NULL DEFAULT 'secretary' CHECK (signatory IN ('secretary', 'chairman', 'treasurer')),
    checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
    tenant_can_ask BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    sort INT NOT NULL DEFAULT 100,
    CONSTRAINT uq_noc_type_code UNIQUE (society_id, code)
);
ALTER TABLE noc_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS noc_types_select ON noc_types;
CREATE POLICY noc_types_select ON noc_types FOR SELECT
    USING (has_society_membership(society_id) OR is_committee_viewer(society_id));

-- Default letters. Placeholders: {society_name} {registration_number} {society_address} {member_name} {flat}
-- {share_certificate_no} {dues_line} {date} {purpose} {addressee}. Plain wording; each society checks it
-- with its legal adviser and can rewrite it.
CREATE OR REPLACE FUNCTION public.seed_noc_types(p_society_id UUID)
RETURNS VOID AS $$
DECLARE
    v_intro TEXT := E'{addressee}\n\nThis is to certify that {member_name} is a member of {society_name} '
        || E'(Registration No. {registration_number}), {society_address}, and holds flat {flat} '
        || E'under share certificate No. {share_certificate_no}.\n\n';
    v_end TEXT := E'\n\n{dues_line}\n\nThis certificate is issued at the member''s request for: {purpose}.';
BEGIN
    INSERT INTO noc_types (society_id, code, name, title, body, checklist, tenant_can_ask, sort) VALUES
    (p_society_id, 'sale', 'Sale of flat', 'No Objection Certificate — Sale of flat',
     v_intro || 'The society has no objection to the member selling the flat, subject to the transfer of the shares and '
        || 'membership under the society''s bye-laws.' || v_end, '[]', false, 10),
    (p_society_id, 'home_loan', 'Home loan / mortgage', 'No Objection Certificate — Home loan',
     v_intro || 'The society has no objection to the member mortgaging the flat for a home loan. The society will note '
        || 'the lender''s charge in its records on receipt of the lender''s letter.' || v_end,
     '[{"key":"sanction","label":"Bank''s sanction letter or request","required":false}]', false, 20),
    (p_society_id, 'leave_licence', 'Leave and licence (tenant registration)', 'No Objection Certificate — Leave and licence',
     v_intro || 'The society has no objection to the member giving the flat on leave and licence, subject to the '
        || 'society''s bye-laws and the police intimation required by law.' || v_end,
     '[{"key":"agreement","label":"Draft or registered leave and licence agreement","required":true}]', false, 30),
    (p_society_id, 'electricity', 'Electricity meter name change', 'No Objection Certificate — Electricity meter',
     v_intro || 'The society has no objection to the electricity meter of the flat being transferred to the member''s name.' || v_end,
     '[]', false, 40),
    (p_society_id, 'passport', 'Passport / address proof', 'Residence Certificate',
     E'{addressee}\n\nThis is to certify that {member_name} resides in flat {flat} of {society_name} '
        || E'(Registration No. {registration_number}), {society_address}.' || v_end,
     '[{"key":"id","label":"Photo ID of the applicant","required":true}]', true, 50),
    (p_society_id, 'gas', 'Gas connection', 'No Objection Certificate — Gas connection',
     E'{addressee}\n\nThis is to certify that {member_name} resides in flat {flat} of {society_name} '
        || E'(Registration No. {registration_number}), {society_address}. The society has no objection to a gas '
        || 'connection being installed in the flat in this name.' || v_end, '[]', true, 60),
    (p_society_id, 'repairs', 'Repairs / renovation', 'No Objection Certificate — Repairs',
     v_intro || 'The society has no objection to the repairs or renovation described in the member''s application, '
        || 'subject to the society''s rules on working hours, debris removal and structural changes.' || v_end,
     '[{"key":"scope","label":"Scope of work or contractor quote","required":true}]', false, 70)
    ON CONFLICT (society_id, code) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.seed_noc_types(UUID) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
    v_id UUID;
BEGIN
    FOR v_id IN SELECT id FROM societies LOOP
        PERFORM seed_noc_types(v_id);
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.trg_society_noc_types()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM seed_noc_types(NEW.id);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.trg_society_noc_types() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_society_noc_types ON societies;
CREATE TRIGGER trg_society_noc_types AFTER INSERT ON societies FOR EACH ROW EXECUTE FUNCTION public.trg_society_noc_types();

CREATE OR REPLACE FUNCTION public.save_noc_type(
    p_society_id UUID, p_id UUID, p_name TEXT, p_title TEXT, p_body TEXT, p_signatory TEXT,
    p_checklist JSONB, p_tenant_can_ask BOOLEAN, p_active BOOLEAN
)
RETURNS UUID AS $$
DECLARE
    v_name TEXT := trim(coalesce(p_name, ''));
    v_title TEXT := trim(coalesce(p_title, ''));
    v_body TEXT := trim(coalesce(p_body, ''));
    v_old JSONB := '[]'::jsonb;
    v_next INT;
    v_item JSONB;
    v_label TEXT;
    v_key TEXT;
    v_out JSONB := '[]'::jsonb;
    v_id UUID;
BEGIN
    IF NOT is_society_admin(p_society_id) THEN
        RAISE EXCEPTION 'Only the committee can change NOC letters';
    END IF;
    IF p_id IS NOT NULL THEN
        SELECT checklist INTO v_old FROM noc_types WHERE id = p_id AND society_id = p_society_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'This NOC is not in your society';
        END IF;
    END IF;
    IF length(v_name) NOT BETWEEN 2 AND 80 THEN
        RAISE EXCEPTION 'Name the NOC (2 to 80 characters)';
    END IF;
    IF length(v_title) NOT BETWEEN 2 AND 120 THEN
        RAISE EXCEPTION 'Give the letter a title (2 to 120 characters)';
    END IF;
    IF length(v_body) NOT BETWEEN 20 AND 4000 THEN
        RAISE EXCEPTION 'Write the letter (20 to 4000 characters)';
    END IF;
    IF coalesce(p_signatory, '') NOT IN ('secretary', 'chairman', 'treasurer') THEN
        RAISE EXCEPTION 'Choose who signs';
    END IF;
    IF p_checklist IS NULL OR jsonb_typeof(p_checklist) <> 'array' OR jsonb_array_length(p_checklist) > 10 THEN
        RAISE EXCEPTION 'Up to 10 documents, each with a name';
    END IF;

    -- keys: an item keeps a key it already had; new items get d1, d2 ... after the highest used
    SELECT coalesce(max(substr(k, 2)::int), 0) INTO v_next
    FROM (SELECT x ->> 'key' AS k FROM jsonb_array_elements(v_old || p_checklist) x) y
    WHERE k ~ '^d[0-9]+$';
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_checklist) LOOP
        v_label := trim(coalesce(v_item ->> 'label', ''));
        IF length(v_label) NOT BETWEEN 2 AND 120 THEN
            RAISE EXCEPTION 'Up to 10 documents, each with a name';
        END IF;
        v_key := v_item ->> 'key';
        IF v_key IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_old) o WHERE o ->> 'key' = v_key)
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_out) o WHERE o ->> 'key' = v_key) THEN
            v_next := v_next + 1;
            v_key := 'd' || v_next;
        END IF;
        v_out := v_out || jsonb_build_array(jsonb_build_object(
            'key', v_key, 'label', v_label, 'required', coalesce((v_item ->> 'required')::boolean, false)));
    END LOOP;

    IF p_id IS NULL THEN
        INSERT INTO noc_types (society_id, code, name, title, body, signatory, checklist, tenant_can_ask, is_active, sort)
        VALUES (p_society_id,
                'custom-' || (SELECT count(*) + 1 FROM noc_types WHERE society_id = p_society_id AND code LIKE 'custom-%'),
                v_name, v_title, v_body, p_signatory, v_out, coalesce(p_tenant_can_ask, false), coalesce(p_active, true),
                (SELECT coalesce(max(sort), 0) + 10 FROM noc_types WHERE society_id = p_society_id))
        RETURNING id INTO v_id;
        RETURN v_id;
    END IF;
    UPDATE noc_types SET name = v_name, title = v_title, body = v_body, signatory = p_signatory, checklist = v_out,
        tenant_can_ask = coalesce(p_tenant_can_ask, false), is_active = coalesce(p_active, true)
    WHERE id = p_id;
    RETURN p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.save_noc_type(UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, BOOLEAN, BOOLEAN) TO authenticated;

-- ============================================================================
-- 2. FLAT REQUESTS, DOCUMENTS AND HISTORY
--    One engine for NOC (11A), tenancy, shifting and transfer (11B-11D).
--    Seen by the committee, the applicant and the flat's owners; never other residents.
-- ============================================================================
CREATE TABLE IF NOT EXISTS flat_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('noc', 'tenancy', 'shifting', 'transfer')),
    noc_type_id UUID REFERENCES noc_types(id) ON DELETE SET NULL,
    applicant_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'submitted'
        CHECK (status IN ('submitted', 'changes_asked', 'approved', 'rejected', 'withdrawn', 'done')),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
    committee_note TEXT,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ,
    decided_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flat_requests_society ON flat_requests (society_id, status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_flat_requests_unit ON flat_requests (unit_id);
ALTER TABLE flat_requests ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS request_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES flat_requests(id) ON DELETE CASCADE,
    item_key VARCHAR(16) NOT NULL,
    path TEXT NOT NULL,
    file_name VARCHAR(160),
    uploaded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_request_documents ON request_documents (request_id);
ALTER TABLE request_documents ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS request_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES flat_requests(id) ON DELETE CASCADE,
    actor UUID REFERENCES profiles(id) ON DELETE SET NULL,
    action VARCHAR(24) NOT NULL,
    note TEXT,
    at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_request_events ON request_events (request_id, at);
ALTER TABLE request_events ENABLE ROW LEVEL SECURITY;

-- An owner of a flat: an active owner membership on it, or a committee membership that carries the flat
CREATE OR REPLACE FUNCTION public.is_flat_owner(p_unit_id UUID, p_uid UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM society_memberships m JOIN societies s ON s.id = m.society_id AND s.is_active
        WHERE m.unit_id = p_unit_id AND m.user_id = p_uid AND m.is_active
          AND m.role IN ('resident_owner', 'society_admin', 'secretary', 'chairman', 'treasurer', 'committee_member'))
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.is_flat_owner(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- "A-101" when another wing has a 101 too, else "101" (the app's flatLabels rule)
CREATE OR REPLACE FUNCTION public.flat_label(p_unit_id UUID)
RETURNS TEXT AS $$
    SELECT CASE WHEN w.name IS NOT NULL AND EXISTS (
                    SELECT 1 FROM units o WHERE o.society_id = u.society_id AND o.unit_number = u.unit_number AND o.id <> u.id)
                THEN w.name || '-' || u.unit_number ELSE u.unit_number END
    FROM units u LEFT JOIN wings w ON w.id = u.wing_id
    WHERE u.id = p_unit_id
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.flat_label(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.can_see_request(p_request_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (SELECT 1 FROM flat_requests r WHERE r.id = p_request_id AND (
        is_committee_viewer(r.society_id) OR r.applicant_id = auth.uid() OR is_flat_owner(r.unit_id, auth.uid())))
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.can_see_request(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_see_request(UUID) TO authenticated; -- used by RLS and storage policies

-- The applicant, an owner of the flat, or a managing role; only while the request is open
CREATE OR REPLACE FUNCTION public.can_edit_request(p_request_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (SELECT 1 FROM flat_requests r WHERE r.id = p_request_id AND (
        is_society_admin(r.society_id) OR r.applicant_id = auth.uid() OR is_flat_owner(r.unit_id, auth.uid())))
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
-- uploads only while the request is open
CREATE OR REPLACE FUNCTION public.can_upload_to_request(p_request_id UUID)
RETURNS BOOLEAN AS $$
    SELECT can_edit_request(p_request_id)
       AND EXISTS (SELECT 1 FROM flat_requests r WHERE r.id = p_request_id AND r.status IN ('submitted', 'changes_asked'))
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.can_upload_to_request(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_upload_to_request(UUID) TO authenticated; -- used by storage policies
REVOKE ALL ON FUNCTION public.can_edit_request(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_edit_request(UUID) TO authenticated; -- used by storage policies

CREATE OR REPLACE FUNCTION public.request_society_id(p_request_id UUID)
RETURNS UUID AS $$
    SELECT society_id FROM flat_requests WHERE id = p_request_id
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.request_society_id(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_society_id(UUID) TO authenticated; -- used by storage policies

DROP POLICY IF EXISTS flat_requests_select ON flat_requests;
CREATE POLICY flat_requests_select ON flat_requests FOR SELECT USING (can_see_request(id));
DROP POLICY IF EXISTS request_documents_select ON request_documents;
CREATE POLICY request_documents_select ON request_documents FOR SELECT USING (can_see_request(request_id));
DROP POLICY IF EXISTS request_events_select ON request_events;
CREATE POLICY request_events_select ON request_events FOR SELECT USING (can_see_request(request_id));

-- The managing roles of a society (they decide requests)
CREATE OR REPLACE FUNCTION public.society_managers(p_society_id UUID)
RETURNS UUID[] AS $$
    SELECT array_agg(DISTINCT m.user_id) FROM society_memberships m
    WHERE m.society_id = p_society_id AND m.is_active AND m.role IN ('society_admin', 'secretary', 'chairman', 'treasurer')
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.society_managers(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_noc_request(p_unit_id UUID, p_noc_type_id UUID, p_purpose TEXT, p_addressee TEXT)
RETURNS UUID AS $$
DECLARE
    v_society UUID;
    v_type noc_types%ROWTYPE;
    v_purpose TEXT := trim(coalesce(p_purpose, ''));
    v_addressee TEXT := trim(coalesce(p_addressee, ''));
    v_id UUID;
BEGIN
    SELECT society_id INTO v_society FROM units WHERE id = p_unit_id;
    SELECT * INTO v_type FROM noc_types WHERE id = p_noc_type_id;
    IF v_society IS NULL OR NOT (
        is_society_admin(v_society)
        OR is_flat_owner(p_unit_id, auth.uid())
        OR (coalesce(v_type.tenant_can_ask, false) AND EXISTS (
            SELECT 1 FROM society_memberships m JOIN societies s ON s.id = m.society_id AND s.is_active
            WHERE m.unit_id = p_unit_id AND m.user_id = auth.uid() AND m.is_active AND m.role = 'resident_tenant'))) THEN
        RAISE EXCEPTION 'Only an owner of this flat can ask for this NOC';
    END IF;
    IF v_type.id IS NULL OR v_type.society_id <> v_society OR NOT v_type.is_active THEN
        RAISE EXCEPTION 'This NOC is not available';
    END IF;
    IF length(v_purpose) NOT BETWEEN 3 AND 300 THEN
        RAISE EXCEPTION 'Write the purpose (3 to 300 characters)';
    END IF;
    IF length(v_addressee) > 160 THEN
        RAISE EXCEPTION 'The addressee can be up to 160 characters';
    END IF;

    INSERT INTO flat_requests (society_id, unit_id, kind, noc_type_id, applicant_id, details, checklist)
    VALUES (v_society, p_unit_id, 'noc', v_type.id, auth.uid(),
            jsonb_build_object('purpose', v_purpose, 'addressee', v_addressee), v_type.checklist)
    RETURNING id INTO v_id;
    INSERT INTO request_events (request_id, actor, action) VALUES (v_id, auth.uid(), 'submitted');
    PERFORM notify_users(v_society, array_remove(society_managers(v_society), auth.uid()), 'request',
        'NOC request: ' || v_type.name || ' for flat ' || flat_label(p_unit_id), NULL, 'requests', v_id);
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Shared checks for changes to an open request
CREATE OR REPLACE FUNCTION public.open_request_for_change(p_request_id UUID)
RETURNS flat_requests AS $$
DECLARE
    v_r flat_requests%ROWTYPE;
BEGIN
    SELECT * INTO v_r FROM flat_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND OR NOT can_edit_request(p_request_id) THEN
        RAISE EXCEPTION 'Only the applicant or the committee can do this';
    END IF;
    IF v_r.status NOT IN ('submitted', 'changes_asked') THEN
        RAISE EXCEPTION 'This request can no longer be changed';
    END IF;
    RETURN v_r;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.open_request_for_change(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.add_request_document(p_request_id UUID, p_item_key TEXT, p_path TEXT, p_file_name TEXT)
RETURNS UUID AS $$
DECLARE
    v_r flat_requests%ROWTYPE;
    v_id UUID;
BEGIN
    v_r := open_request_for_change(p_request_id);
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_r.checklist) c WHERE c ->> 'key' = p_item_key) THEN
        RAISE EXCEPTION 'Choose a document from the list';
    END IF;
    IF coalesce(p_path, '') !~ ('^' || v_r.society_id::text || '/' || v_r.id::text || '/[^/]+$') THEN
        RAISE EXCEPTION 'That file does not belong to this request';
    END IF;
    INSERT INTO request_documents (request_id, item_key, path, file_name, uploaded_by)
    VALUES (p_request_id, p_item_key, p_path, left(trim(coalesce(p_file_name, '')), 160), auth.uid())
    RETURNING id INTO v_id;
    INSERT INTO request_events (request_id, actor, action, note) VALUES (p_request_id, auth.uid(), 'document_added', p_item_key);
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.remove_request_document(p_document_id UUID)
RETURNS VOID AS $$
DECLARE
    v_request UUID;
    v_key TEXT;
BEGIN
    SELECT request_id, item_key INTO v_request, v_key FROM request_documents WHERE id = p_document_id;
    IF v_request IS NULL THEN
        RAISE EXCEPTION 'Only the applicant or the committee can do this';
    END IF;
    PERFORM open_request_for_change(v_request);
    DELETE FROM request_documents WHERE id = p_document_id;
    INSERT INTO request_events (request_id, actor, action, note) VALUES (v_request, auth.uid(), 'document_removed', v_key);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.withdraw_request(p_request_id UUID)
RETURNS VOID AS $$
BEGIN
    PERFORM open_request_for_change(p_request_id);
    UPDATE flat_requests SET status = 'withdrawn' WHERE id = p_request_id;
    INSERT INTO request_events (request_id, actor, action) VALUES (p_request_id, auth.uid(), 'withdrawn');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.resubmit_request(p_request_id UUID, p_note TEXT)
RETURNS VOID AS $$
DECLARE
    v_r flat_requests%ROWTYPE;
BEGIN
    v_r := open_request_for_change(p_request_id);
    IF v_r.status <> 'changes_asked' THEN
        RAISE EXCEPTION 'This request is already with the committee';
    END IF;
    UPDATE flat_requests SET status = 'submitted' WHERE id = p_request_id;
    INSERT INTO request_events (request_id, actor, action, note)
    VALUES (p_request_id, auth.uid(), 'resubmitted', nullif(trim(coalesce(p_note, '')), ''));
    PERFORM notify_users(v_r.society_id, array_remove(society_managers(v_r.society_id), auth.uid()), 'request',
        'Request updated for flat ' || flat_label(v_r.unit_id), NULL, 'requests', p_request_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.create_noc_request(UUID, UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_request_document(UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_request_document(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_request(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resubmit_request(UUID, TEXT) TO authenticated;

-- Files: request-files/<society_id>/<request_id>/<name>
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('request-files', 'request-files', false, 10485760, ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE OR REPLACE FUNCTION public.storage_request_id(p_name TEXT)
RETURNS UUID AS $$
    SELECT CASE
        WHEN (storage.foldername(p_name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN ((storage.foldername(p_name))[2])::uuid
    END
$$ LANGUAGE sql STABLE;

DROP POLICY IF EXISTS "request files: read" ON storage.objects;
DROP POLICY IF EXISTS "request files: upload" ON storage.objects;
CREATE POLICY "request files: read" ON storage.objects
    FOR SELECT TO authenticated USING (
        bucket_id = 'request-files'
        AND public.storage_request_id(name) IS NOT NULL
        AND public.request_society_id(public.storage_request_id(name)) = public.storage_society_id(name)
        AND public.can_see_request(public.storage_request_id(name))
    );
CREATE POLICY "request files: upload" ON storage.objects
    FOR INSERT TO authenticated WITH CHECK (
        bucket_id = 'request-files'
        AND public.storage_request_id(name) IS NOT NULL
        AND public.request_society_id(public.storage_request_id(name)) = public.storage_society_id(name)
        AND public.can_upload_to_request(public.storage_request_id(name))
    );

-- ============================================================================
-- 3. DECISIONS AND NOC LETTERS
--    Approving a NOC request renders the society's template into a numbered letter
--    (NOC/<FY>/<nnn>, per society per financial year), with the flat's dues on that day.
-- ============================================================================
CREATE TABLE IF NOT EXISTS noc_letters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    request_id UUID NOT NULL UNIQUE REFERENCES flat_requests(id) ON DELETE CASCADE,
    number VARCHAR(24) NOT NULL,
    fy VARCHAR(7) NOT NULL,
    seq INT NOT NULL,
    issued_on DATE NOT NULL,
    type_name TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    signatory VARCHAR(16) NOT NULL,
    issued_to TEXT,
    flat_label TEXT,
    dues_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_noc_letter_seq UNIQUE (society_id, fy, seq)
);
ALTER TABLE noc_letters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS noc_letters_select ON noc_letters;
CREATE POLICY noc_letters_select ON noc_letters FOR SELECT USING (can_see_request(request_id));

CREATE OR REPLACE FUNCTION public.fy_label(p_date DATE)
RETURNS TEXT AS $$
    SELECT y::text || '-' || lpad(((y + 1) % 100)::text, 2, '0')
    FROM (SELECT CASE WHEN extract(month FROM p_date) >= 4 THEN extract(year FROM p_date)::int
                      ELSE extract(year FROM p_date)::int - 1 END AS y) x
$$ LANGUAGE sql IMMUTABLE SET search_path = public;

CREATE OR REPLACE FUNCTION public.noc_letter_number(p_society_id UUID, p_on DATE)
RETURNS TEXT AS $$
    SELECT 'NOC/' || fy_label(p_on) || '/' || lpad((coalesce(max(seq), 0) + 1)::text, 3, '0')
    FROM noc_letters WHERE society_id = p_society_id AND fy = fy_label(p_on)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.noc_letter_number(UUID, DATE) FROM PUBLIC, anon, authenticated;

-- The flat's balance on a day, from the same entries as My account and the CA's party ledger (> 0 = owed)
CREATE OR REPLACE FUNCTION public.flat_dues_on(p_unit_id UUID, p_on DATE)
RETURNS NUMERIC AS $$
    SELECT coalesce(sum(e.amount), 0)
    FROM units u, party_entries(u.society_id) e
    WHERE u.id = p_unit_id AND e.kind = 'flat' AND e.party_key = p_unit_id::text AND e.entry_date <= p_on
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.flat_dues_on(UUID, DATE) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.render_noc(p_request_id UUID, p_on DATE)
RETURNS JSONB AS $$
DECLARE
    v_r flat_requests%ROWTYPE;
    v_t noc_types%ROWTYPE;
    v_s societies%ROWTYPE;
    v_u units%ROWTYPE;
    v_dues NUMERIC;
    v_date TEXT := to_char(p_on, 'DD Mon YYYY');
    v_body TEXT;
    v_name TEXT;
BEGIN
    SELECT * INTO v_r FROM flat_requests WHERE id = p_request_id;
    SELECT * INTO v_t FROM noc_types WHERE id = v_r.noc_type_id;
    SELECT * INTO v_s FROM societies WHERE id = v_r.society_id;
    SELECT * INTO v_u FROM units WHERE id = v_r.unit_id;
    SELECT full_name INTO v_name FROM profiles WHERE id = v_r.applicant_id;
    v_dues := flat_dues_on(v_r.unit_id, p_on);
    v_body := v_t.body;
    v_body := replace(v_body, '{addressee}', coalesce(nullif(v_r.details ->> 'addressee', ''), 'To whomsoever it may concern'));
    v_body := replace(v_body, '{society_name}', v_s.name);
    v_body := replace(v_body, '{registration_number}', coalesce(nullif(v_s.registration_number, ''), '—'));
    v_body := replace(v_body, '{society_address}', concat_ws(', ', nullif(v_s.address_line1, ''), nullif(v_s.address_line2, ''),
        nullif(v_s.city, ''), trim(coalesce(v_s.state, '') || ' ' || coalesce(v_s.pincode, ''))));
    v_body := replace(v_body, '{member_name}', coalesce(nullif(v_name, ''), '—'));
    v_body := replace(v_body, '{flat}', flat_label(v_r.unit_id));
    v_body := replace(v_body, '{share_certificate_no}', coalesce(v_u.share_certificate_no, 'not recorded'));
    v_body := replace(v_body, '{dues_line}', CASE WHEN v_dues > 0
        THEN 'Dues of ' || inr_text(v_dues) || ' are outstanding as on ' || v_date || '.'
        ELSE 'There are no dues outstanding as on ' || v_date || '.' END);
    v_body := replace(v_body, '{date}', v_date);
    v_body := replace(v_body, '{purpose}', coalesce(nullif(v_r.details ->> 'purpose', ''), '—'));
    RETURN jsonb_build_object('title', v_t.title, 'body', v_body, 'dues_amount', v_dues, 'type_name', v_t.name,
                              'signatory', v_t.signatory, 'issued_to', v_name, 'flat_label', flat_label(v_r.unit_id), 'date', p_on);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.render_noc(UUID, DATE) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.noc_preview(p_request_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_society UUID := request_society_id(p_request_id);
BEGIN
    IF v_society IS NULL OR NOT is_committee_viewer(v_society)
       OR NOT EXISTS (SELECT 1 FROM flat_requests WHERE id = p_request_id AND kind = 'noc') THEN
        RAISE EXCEPTION 'Only the committee can see this';
    END IF;
    RETURN render_noc(p_request_id, (now() AT TIME ZONE 'Asia/Kolkata')::date);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

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
    v_type := coalesce(v_type, initcap(v_r.kind));

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

    UPDATE flat_requests SET status = 'approved', committee_note = v_note, decided_at = now(), decided_by = auth.uid()
    WHERE id = p_request_id;
    INSERT INTO request_events (request_id, actor, action, note) VALUES (p_request_id, auth.uid(), 'approved', v_note);

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

GRANT EXECUTE ON FUNCTION public.noc_preview(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_request(UUID, TEXT, TEXT) TO authenticated;
