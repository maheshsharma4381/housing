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
