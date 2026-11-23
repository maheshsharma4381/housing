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
