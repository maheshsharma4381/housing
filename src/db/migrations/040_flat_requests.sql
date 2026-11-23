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
