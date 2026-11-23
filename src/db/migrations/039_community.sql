-- ============================================================================
-- 039: Phase 10 — notice read record, one-vote-per-flat polls, staff register
--      (spec docs/superpowers/specs/2026-11-23-community-design.md)
-- ============================================================================

-- ============================================================================
-- 1. NOTICE READ RECORD
--    "Seen" = shown to the person on their Notices screen. Counted per person,
--    over the notice's audience (as trg_notify_notice), never the committee.
-- ============================================================================
CREATE TABLE IF NOT EXISTS notice_reads (
    notice_id UUID NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (notice_id, user_id)
);
ALTER TABLE notice_reads ENABLE ROW LEVEL SECURITY;

-- The people a notice is for: one row per person (their first flat), committee roles and the publisher left out
CREATE OR REPLACE FUNCTION public.notice_audience(p_notice_id UUID)
RETURNS TABLE(user_id UUID, unit_id UUID) AS $$
    SELECT DISTINCT ON (m.user_id) m.user_id, m.unit_id
    FROM notices n
    JOIN society_memberships m ON m.society_id = n.society_id AND m.is_active
    LEFT JOIN units u ON u.id = m.unit_id
    WHERE n.id = p_notice_id
      AND m.user_id <> n.published_by
      AND m.role IN ('resident_owner', 'resident_tenant')
      AND NOT EXISTS (SELECT 1 FROM society_memberships c
                      WHERE c.society_id = n.society_id AND c.user_id = m.user_id AND c.is_active
                        AND c.role IN ('society_admin', 'secretary', 'chairman', 'treasurer', 'committee_member'))
      AND (n.target_audience = 'all'
           OR (n.target_audience = 'owners_only' AND m.role = 'resident_owner')
           OR (n.target_audience = 'tenants_only' AND m.role = 'resident_tenant'))
    ORDER BY m.user_id, u.unit_number
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.notice_audience(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.mark_notices_seen(p_notice_ids UUID[])
RETURNS INT AS $$
DECLARE
    v_count INT;
BEGIN
    IF auth.uid() IS NULL OR p_notice_ids IS NULL THEN
        RETURN 0;
    END IF;
    INSERT INTO notice_reads (notice_id, user_id)
    SELECT n.id, auth.uid()
    FROM notices n
    WHERE n.id = ANY (p_notice_ids)
      AND (n.expires_at IS NULL OR n.expires_at > now())
      AND EXISTS (SELECT 1 FROM notice_audience(n.id) a WHERE a.user_id = auth.uid())
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.notice_read_summary(p_notice_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_society UUID;
BEGIN
    SELECT society_id INTO v_society FROM notices WHERE id = p_notice_id;
    IF v_society IS NULL OR NOT is_committee_viewer(v_society) THEN
        RAISE EXCEPTION 'Only the committee can see this';
    END IF;
    RETURN (
        SELECT jsonb_build_object(
            'seen', count(r.user_id),
            'total', count(*),
            'not_seen', coalesce(jsonb_agg(jsonb_build_object('name', p.full_name, 'wing', w.name, 'unit_number', u.unit_number)
                                           ORDER BY w.name, u.unit_number, p.full_name) FILTER (WHERE r.user_id IS NULL), '[]'::jsonb))
        FROM notice_audience(p_notice_id) a
        JOIN profiles p ON p.id = a.user_id
        LEFT JOIN units u ON u.id = a.unit_id
        LEFT JOIN wings w ON w.id = u.wing_id
        LEFT JOIN notice_reads r ON r.notice_id = p_notice_id AND r.user_id = a.user_id
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.mark_notices_seen(UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notice_read_summary(UUID) TO authenticated;

-- ============================================================================
-- 2. POLLS — one vote per flat, counted from owners only. The choice of each
--    flat is never readable (poll_votes has no policies); the committee sees
--    counts and which flats voted, residents see counts once the poll closes.
--    A poll shows members' views; decisions are taken in the general body meeting.
-- ============================================================================
CREATE TABLE IF NOT EXISTS polls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    question VARCHAR(200) NOT NULL,
    details TEXT,
    options TEXT[] NOT NULL,
    closes_at TIMESTAMPTZ NOT NULL,
    closed_at TIMESTAMPTZ,
    created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_polls_society ON polls (society_id, created_at DESC);
ALTER TABLE polls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS polls_select ON polls;
CREATE POLICY polls_select ON polls FOR SELECT USING (has_society_membership(society_id));

CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    option_index INT NOT NULL,
    voted_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    voted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (poll_id, unit_id)
);
ALTER TABLE poll_votes ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.poll_is_open(p polls)
RETURNS BOOLEAN AS $$
    SELECT p.closed_at IS NULL AND p.closes_at > now()
$$ LANGUAGE sql STABLE SET search_path = public;

-- Flats that can vote: at least one active owner membership
CREATE OR REPLACE FUNCTION public.poll_eligible_units(p_society_id UUID)
RETURNS SETOF UUID AS $$
    SELECT DISTINCT m.unit_id FROM society_memberships m
    WHERE m.society_id = p_society_id AND m.is_active AND m.role = 'resident_owner' AND m.unit_id IS NOT NULL
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.poll_eligible_units(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_poll(p_society_id UUID, p_question TEXT, p_details TEXT, p_options TEXT[], p_closes_at TIMESTAMPTZ)
RETURNS UUID AS $$
DECLARE
    v_question TEXT := trim(coalesce(p_question, ''));
    v_details TEXT := nullif(trim(coalesce(p_details, '')), '');
    v_options TEXT[];
    v_id UUID;
BEGIN
    IF NOT is_society_admin(p_society_id) THEN
        RAISE EXCEPTION 'Only the committee can open a poll';
    END IF;
    IF length(v_question) NOT BETWEEN 5 AND 200 THEN
        RAISE EXCEPTION 'Write the question (5 to 200 characters)';
    END IF;
    IF length(coalesce(v_details, '')) > 1000 THEN
        RAISE EXCEPTION 'Details can be up to 1000 characters';
    END IF;
    SELECT coalesce(array_agg(trim(o) ORDER BY i), '{}') INTO v_options
    FROM unnest(coalesce(p_options, '{}')) WITH ORDINALITY AS t(o, i) WHERE trim(coalesce(o, '')) <> '';
    IF cardinality(v_options) NOT BETWEEN 2 AND 6 OR EXISTS (SELECT 1 FROM unnest(v_options) o WHERE length(o) > 80) THEN
        RAISE EXCEPTION 'Give 2 to 6 options, each up to 80 characters';
    END IF;
    IF p_closes_at IS NULL OR p_closes_at < now() + interval '1 hour' OR p_closes_at > now() + interval '60 days' THEN
        RAISE EXCEPTION 'Close the poll between 1 hour and 60 days from now';
    END IF;

    INSERT INTO polls (society_id, question, details, options, closes_at, created_by)
    VALUES (p_society_id, v_question, v_details, v_options, p_closes_at, auth.uid())
    RETURNING id INTO v_id;

    PERFORM notify_users(p_society_id, (
        SELECT array_agg(DISTINCT m.user_id) FROM society_memberships m
        WHERE m.society_id = p_society_id AND m.is_active AND m.role = 'resident_owner'
    ), 'poll', 'Poll: ' || v_question, NULL, 'polls', v_id);
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.cast_poll_vote(p_poll_id UUID, p_unit_id UUID, p_option_index INT)
RETURNS VOID AS $$
DECLARE
    v_p polls%ROWTYPE;
BEGIN
    SELECT * INTO v_p FROM polls WHERE id = p_poll_id;
    IF NOT FOUND OR NOT EXISTS (
        SELECT 1 FROM society_memberships m JOIN societies s ON s.id = m.society_id AND s.is_active
        WHERE m.society_id = v_p.society_id AND m.user_id = auth.uid() AND m.unit_id = p_unit_id
          AND m.is_active AND m.role = 'resident_owner') THEN
        RAISE EXCEPTION 'Only an owner of this flat can vote';
    END IF;
    IF NOT poll_is_open(v_p) THEN
        RAISE EXCEPTION 'This poll is closed';
    END IF;
    IF p_option_index IS NULL OR p_option_index < 0 OR p_option_index >= cardinality(v_p.options) THEN
        RAISE EXCEPTION 'Choose one of the options';
    END IF;
    INSERT INTO poll_votes (poll_id, unit_id, option_index, voted_by)
    VALUES (p_poll_id, p_unit_id, p_option_index, auth.uid())
    ON CONFLICT (poll_id, unit_id) DO UPDATE
        SET option_index = EXCLUDED.option_index, voted_by = EXCLUDED.voted_by, voted_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.close_poll(p_poll_id UUID)
RETURNS VOID AS $$
DECLARE
    v_p polls%ROWTYPE;
BEGIN
    SELECT * INTO v_p FROM polls WHERE id = p_poll_id;
    IF NOT FOUND OR NOT is_society_admin(v_p.society_id) THEN
        RAISE EXCEPTION 'Only the committee can close a poll';
    END IF;
    IF NOT poll_is_open(v_p) THEN
        RAISE EXCEPTION 'This poll is closed';
    END IF;
    UPDATE polls SET closed_at = now() WHERE id = p_poll_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.delete_poll(p_poll_id UUID)
RETURNS VOID AS $$
DECLARE
    v_society UUID;
BEGIN
    SELECT society_id INTO v_society FROM polls WHERE id = p_poll_id;
    IF v_society IS NULL OR NOT is_society_admin(v_society) THEN
        RAISE EXCEPTION 'Only the committee can delete a poll';
    END IF;
    IF EXISTS (SELECT 1 FROM poll_votes WHERE poll_id = p_poll_id) THEN
        RAISE EXCEPTION 'A poll with votes cannot be deleted';
    END IF;
    DELETE FROM polls WHERE id = p_poll_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.poll_view(p_poll_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_p polls%ROWTYPE;
    v_open BOOLEAN;
    v_committee BOOLEAN;
BEGIN
    SELECT * INTO v_p FROM polls WHERE id = p_poll_id;
    IF NOT FOUND OR NOT (has_society_membership(v_p.society_id) OR is_committee_viewer(v_p.society_id)) THEN
        RAISE EXCEPTION 'This poll is not in your society';
    END IF;
    v_open := poll_is_open(v_p);
    v_committee := is_committee_viewer(v_p.society_id);
    RETURN jsonb_build_object(
        'open', v_open,
        'my_flats', coalesce((
            SELECT jsonb_agg(jsonb_build_object('unit_id', f.unit_id, 'wing', f.wing, 'unit_number', f.unit_number, 'choice', f.choice)
                             ORDER BY f.wing, f.unit_number)
            FROM (SELECT DISTINCT m.unit_id, w.name AS wing, u.unit_number, v.option_index AS choice
                  FROM society_memberships m
                  JOIN units u ON u.id = m.unit_id
                  LEFT JOIN wings w ON w.id = u.wing_id
                  LEFT JOIN poll_votes v ON v.poll_id = p_poll_id AND v.unit_id = m.unit_id
                  WHERE m.society_id = v_p.society_id AND m.user_id = auth.uid() AND m.is_active AND m.role = 'resident_owner') f
        ), '[]'::jsonb),
        'counts', CASE WHEN v_committee OR NOT v_open THEN (
            SELECT jsonb_agg((SELECT count(*) FROM poll_votes v WHERE v.poll_id = p_poll_id AND v.option_index = i - 1) ORDER BY i)
            FROM generate_series(1, cardinality(v_p.options)) i) END,
        'voted', (SELECT count(*) FROM poll_votes WHERE poll_id = p_poll_id),
        'eligible', (SELECT count(*) FROM poll_eligible_units(v_p.society_id))
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.poll_flats(p_poll_id UUID)
RETURNS TABLE(wing TEXT, unit_number TEXT, voted BOOLEAN) AS $$
DECLARE
    v_society UUID;
BEGIN
    SELECT society_id INTO v_society FROM polls WHERE id = p_poll_id;
    IF v_society IS NULL OR NOT is_committee_viewer(v_society) THEN
        RAISE EXCEPTION 'Only the committee can see this';
    END IF;
    RETURN QUERY
        SELECT w.name::TEXT, u.unit_number::TEXT, EXISTS (SELECT 1 FROM poll_votes v WHERE v.poll_id = p_poll_id AND v.unit_id = u.id)
        FROM poll_eligible_units(v_society) e(unit_id)
        JOIN units u ON u.id = e.unit_id
        LEFT JOIN wings w ON w.id = u.wing_id
        ORDER BY w.name, u.unit_number;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.create_poll(UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cast_poll_vote(UUID, UUID, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_poll(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_poll(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.poll_view(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.poll_flats(UUID) TO authenticated;

-- ============================================================================
-- 3. STAFF REGISTER — domestic and society staff, the flats they work in,
--    photo for every member, ID proof for the committee only.
--    Files: staff-files/<society_id>/<staff_id>/photo-<x>  and  /id-<x>
-- ============================================================================
CREATE TABLE IF NOT EXISTS staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    name VARCHAR(80) NOT NULL,
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('maid', 'driver', 'cook', 'cleaner', 'nanny', 'other')),
    mobile VARCHAR(16),
    photo_path TEXT,
    id_proof_path TEXT,
    police_verified_on DATE,
    notes TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_mobile ON staff (society_id, mobile) WHERE is_active AND mobile IS NOT NULL;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS staff_flats (
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    added_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    PRIMARY KEY (staff_id, unit_id)
);
ALTER TABLE staff_flats ENABLE ROW LEVEL SECURITY;

-- The caller's own flats (as owner or tenant) in a society
CREATE OR REPLACE FUNCTION public.my_household_units(p_society_id UUID)
RETURNS SETOF UUID AS $$
    SELECT DISTINCT m.unit_id FROM society_memberships m
    JOIN societies s ON s.id = m.society_id AND s.is_active
    WHERE m.society_id = p_society_id AND m.user_id = auth.uid() AND m.is_active
      AND m.role IN ('resident_owner', 'resident_tenant') AND m.unit_id IS NOT NULL
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.my_household_units(UUID) FROM PUBLIC, anon, authenticated;

-- The committee, or a resident whose flats are the only ones this person works in
CREATE OR REPLACE FUNCTION public.can_edit_staff(p_staff_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (SELECT 1 FROM staff s WHERE s.id = p_staff_id AND (
        is_society_admin(s.society_id)
        OR (s.is_active
            AND EXISTS (SELECT 1 FROM staff_flats f WHERE f.staff_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM staff_flats f WHERE f.staff_id = s.id
                            AND f.unit_id NOT IN (SELECT my_household_units(s.society_id))))))
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.can_edit_staff(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_edit_staff(UUID) TO authenticated; -- used by storage policies

-- The committee, or the resident who added this person while they still work in that resident's flat
CREATE OR REPLACE FUNCTION public.can_upload_staff_id(p_staff_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (SELECT 1 FROM staff s WHERE s.id = p_staff_id AND (
        is_society_admin(s.society_id)
        OR (s.is_active AND s.created_by = auth.uid()
            AND EXISTS (SELECT 1 FROM staff_flats f WHERE f.staff_id = s.id
                        AND f.unit_id IN (SELECT my_household_units(s.society_id))))))
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.can_upload_staff_id(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_upload_staff_id(UUID) TO authenticated; -- used by storage policies

CREATE OR REPLACE FUNCTION public.save_staff(p_society_id UUID, p_id UUID, p_name TEXT, p_kind TEXT, p_mobile TEXT, p_unit_ids UUID[])
RETURNS UUID AS $$
DECLARE
    v_admin BOOLEAN := is_society_admin(p_society_id);
    v_name TEXT := trim(coalesce(p_name, ''));
    v_mobile TEXT;
    v_units UUID[] := coalesce(p_unit_ids, '{}');
    v_id UUID;
BEGIN
    IF length(v_name) NOT BETWEEN 1 AND 80 THEN
        RAISE EXCEPTION 'Enter the name (1 to 80 characters)';
    END IF;
    IF coalesce(p_kind, '') NOT IN ('maid', 'driver', 'cook', 'cleaner', 'nanny', 'other') THEN
        RAISE EXCEPTION 'Choose what they do';
    END IF;
    IF trim(coalesce(p_mobile, '')) <> '' THEN
        v_mobile := normalize_mobile(p_mobile);
        IF v_mobile IS NULL THEN
            RAISE EXCEPTION 'Enter a valid mobile number';
        END IF;
    END IF;
    IF v_admin THEN
        IF EXISTS (SELECT 1 FROM unnest(v_units) u WHERE NOT EXISTS (SELECT 1 FROM units x WHERE x.id = u AND x.society_id = p_society_id)) THEN
            RAISE EXCEPTION 'Choose flats of this society';
        END IF;
    ELSIF cardinality(v_units) = 0
       OR EXISTS (SELECT 1 FROM unnest(v_units) u WHERE u NOT IN (SELECT my_household_units(p_society_id))) THEN
        RAISE EXCEPTION 'You can add staff only for your own flat';
    END IF;

    IF p_id IS NULL THEN
        -- the same person already in the register: link the flats instead of a duplicate
        SELECT id INTO v_id FROM staff WHERE society_id = p_society_id AND is_active AND mobile = v_mobile AND v_mobile IS NOT NULL;
        IF v_id IS NULL THEN
            INSERT INTO staff (society_id, name, kind, mobile, created_by)
            VALUES (p_society_id, v_name, p_kind, v_mobile, auth.uid()) RETURNING id INTO v_id;
        END IF;
        INSERT INTO staff_flats (staff_id, unit_id, added_by)
        SELECT v_id, u, auth.uid() FROM unnest(v_units) u ON CONFLICT DO NOTHING;
        RETURN v_id;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM staff WHERE id = p_id AND society_id = p_society_id) OR NOT can_edit_staff(p_id) THEN
        RAISE EXCEPTION 'Only the committee can change this person';
    END IF;
    IF v_mobile IS NOT NULL AND EXISTS (SELECT 1 FROM staff WHERE society_id = p_society_id AND is_active AND mobile = v_mobile AND id <> p_id) THEN
        RAISE EXCEPTION 'Another person in the register has this mobile number';
    END IF;
    UPDATE staff SET name = v_name, kind = p_kind, mobile = v_mobile WHERE id = p_id;
    IF v_admin THEN
        DELETE FROM staff_flats WHERE staff_id = p_id AND unit_id <> ALL (v_units);
    END IF;
    INSERT INTO staff_flats (staff_id, unit_id, added_by)
    SELECT p_id, u, auth.uid() FROM unnest(v_units) u ON CONFLICT DO NOTHING;
    RETURN p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.unlink_staff(p_staff_id UUID, p_unit_id UUID)
RETURNS VOID AS $$
DECLARE
    v_society UUID;
BEGIN
    SELECT society_id INTO v_society FROM staff WHERE id = p_staff_id;
    IF v_society IS NULL OR NOT (is_society_admin(v_society) OR p_unit_id IN (SELECT my_household_units(v_society))) THEN
        RAISE EXCEPTION 'Only the committee or that flat can do this';
    END IF;
    DELETE FROM staff_flats WHERE staff_id = p_staff_id AND unit_id = p_unit_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.staff_admin_check(p_staff_id UUID)
RETURNS UUID AS $$
DECLARE
    v_society UUID;
BEGIN
    SELECT society_id INTO v_society FROM staff WHERE id = p_staff_id;
    IF v_society IS NULL OR NOT is_society_admin(v_society) THEN
        RAISE EXCEPTION 'Only the committee can do this';
    END IF;
    RETURN v_society;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.staff_admin_check(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_staff_verified(p_staff_id UUID, p_verified_on DATE)
RETURNS VOID AS $$
BEGIN
    PERFORM staff_admin_check(p_staff_id);
    UPDATE staff SET police_verified_on = p_verified_on WHERE id = p_staff_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.set_staff_notes(p_staff_id UUID, p_notes TEXT)
RETURNS VOID AS $$
BEGIN
    PERFORM staff_admin_check(p_staff_id);
    UPDATE staff SET notes = nullif(trim(coalesce(p_notes, '')), '') WHERE id = p_staff_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.set_staff_active(p_staff_id UUID, p_active BOOLEAN)
RETURNS VOID AS $$
DECLARE
    v_s staff%ROWTYPE;
BEGIN
    PERFORM staff_admin_check(p_staff_id);
    SELECT * INTO v_s FROM staff WHERE id = p_staff_id;
    IF p_active AND v_s.mobile IS NOT NULL AND EXISTS (
        SELECT 1 FROM staff WHERE society_id = v_s.society_id AND is_active AND mobile = v_s.mobile AND id <> p_staff_id) THEN
        RAISE EXCEPTION 'Another person in the register has this mobile number';
    END IF;
    UPDATE staff SET is_active = coalesce(p_active, true) WHERE id = p_staff_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.set_staff_file(p_staff_id UUID, p_kind TEXT, p_path TEXT)
RETURNS VOID AS $$
DECLARE
    v_society UUID;
BEGIN
    SELECT society_id INTO v_society FROM staff WHERE id = p_staff_id;
    IF v_society IS NULL OR coalesce(p_kind, '') NOT IN ('photo', 'id')
       OR coalesce(p_path, '') !~ ('^' || v_society::text || '/' || p_staff_id::text || '/' || p_kind || '-[^/]+$') THEN
        RAISE EXCEPTION 'That file does not belong to this person';
    END IF;
    IF p_kind = 'photo' THEN
        IF NOT can_edit_staff(p_staff_id) THEN
            RAISE EXCEPTION 'Only the committee can change this person';
        END IF;
        UPDATE staff SET photo_path = p_path WHERE id = p_staff_id;
    ELSE
        IF NOT can_upload_staff_id(p_staff_id) THEN
            RAISE EXCEPTION 'Only the committee can change this person';
        END IF;
        UPDATE staff SET id_proof_path = p_path WHERE id = p_staff_id;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.staff_list(p_society_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_committee BOOLEAN := is_committee_viewer(p_society_id);
BEGIN
    IF NOT (v_committee OR has_society_membership(p_society_id)) THEN
        RAISE EXCEPTION 'Only members of this society can see its staff';
    END IF;
    RETURN coalesce((
        SELECT jsonb_agg(jsonb_build_object(
            'id', s.id, 'name', s.name, 'kind', s.kind, 'photo_path', s.photo_path,
            'police_verified', s.police_verified_on IS NOT NULL,
            'police_verified_on', CASE WHEN v_committee THEN s.police_verified_on END,
            'active', s.is_active,
            'mine', x.mine,
            'mobile', CASE WHEN v_committee OR x.mine THEN s.mobile END,
            'notes', CASE WHEN v_committee THEN s.notes END,
            'id_proof', CASE WHEN v_committee THEN s.id_proof_path END,
            'flats', coalesce((
                SELECT jsonb_agg(jsonb_build_object('unit_id', u.id, 'wing', w.name, 'unit_number', u.unit_number) ORDER BY w.name, u.unit_number)
                FROM staff_flats f JOIN units u ON u.id = f.unit_id LEFT JOIN wings w ON w.id = u.wing_id
                WHERE f.staff_id = s.id AND (v_committee OR f.unit_id IN (SELECT my_household_units(p_society_id)))
            ), '[]'::jsonb)
        ) ORDER BY s.is_active DESC, s.name)
        FROM staff s
        CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM staff_flats f WHERE f.staff_id = s.id
                                           AND f.unit_id IN (SELECT my_household_units(p_society_id))) AS mine) x
        WHERE s.society_id = p_society_id AND (s.is_active OR v_committee)
    ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.save_staff(UUID, UUID, TEXT, TEXT, TEXT, UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlink_staff(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_staff_verified(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_staff_notes(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_staff_active(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_staff_file(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_list(UUID) TO authenticated;

-- Storage
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('staff-files', 'staff-files', false, 5242880)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.storage_staff_id(p_name TEXT)
RETURNS UUID AS $$
    SELECT CASE
        WHEN (storage.foldername(p_name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN ((storage.foldername(p_name))[2])::uuid
    END
$$ LANGUAGE sql STABLE;

-- staff has no policies, so a storage policy reads it through this helper
CREATE OR REPLACE FUNCTION public.staff_society_id(p_staff_id UUID)
RETURNS UUID AS $$
    SELECT society_id FROM staff WHERE id = p_staff_id
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.staff_society_id(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_society_id(UUID) TO authenticated; -- used by storage policies

DROP POLICY IF EXISTS "staff files: read" ON storage.objects;
DROP POLICY IF EXISTS "staff files: upload" ON storage.objects;

CREATE POLICY "staff files: read" ON storage.objects
    FOR SELECT TO authenticated USING (
        bucket_id = 'staff-files'
        AND public.storage_society_id(name) IS NOT NULL
        AND (
            public.is_committee_viewer(public.storage_society_id(name))
            OR (split_part(name, '/', 3) LIKE 'photo-%' AND public.has_society_membership(public.storage_society_id(name)))
        )
    );

CREATE POLICY "staff files: upload" ON storage.objects
    FOR INSERT TO authenticated WITH CHECK (
        bucket_id = 'staff-files'
        AND public.storage_society_id(name) IS NOT NULL
        AND public.staff_society_id(public.storage_staff_id(name)) = public.storage_society_id(name)
        AND (
            (split_part(name, '/', 3) LIKE 'photo-%' AND public.can_edit_staff(public.storage_staff_id(name)))
            OR (split_part(name, '/', 3) LIKE 'id-%' AND public.can_upload_staff_id(public.storage_staff_id(name)))
        )
    );
