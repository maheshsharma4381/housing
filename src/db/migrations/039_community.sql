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
