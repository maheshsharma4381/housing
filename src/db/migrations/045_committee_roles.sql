-- ============================================================================
-- 045: committee roles change in the app
--   * change_committee_role(): the Secretary, Chairman or society admin moves a member to another post,
--     brings a flat owner onto the committee, or takes someone off it. No re-invite.
--   * One Secretary, one Chairman and one Treasurer at a time: whoever takes a post (by this function or by
--     accepting an invite) moves the previous holder down to Committee member, and both are told.
--   * The society always keeps an active Secretary, Chairman or society admin.
--   * committee_terms keeps every term (who held which post, from when, until when) for the AGM and audit;
--     committee_history() reads it. Terms open and close from the memberships themselves (trigger).
-- ============================================================================

CREATE TABLE IF NOT EXISTS committee_terms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    membership_id UUID REFERENCES society_memberships(id) ON DELETE SET NULL,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    role VARCHAR(32) NOT NULL CHECK (role IN ('society_admin', 'secretary', 'chairman', 'treasurer', 'committee_member')),
    from_date DATE NOT NULL DEFAULT CURRENT_DATE,
    to_date DATE,
    started_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    ended_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_committee_terms_society ON committee_terms (society_id, from_date DESC);
CREATE INDEX IF NOT EXISTS idx_committee_terms_open ON committee_terms (membership_id) WHERE to_date IS NULL;
ALTER TABLE committee_terms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS committee_terms_select ON committee_terms;
CREATE POLICY committee_terms_select ON committee_terms
    FOR SELECT USING (is_platform_admin() OR is_committee_viewer(society_id));
-- written only by the trigger below (SECURITY DEFINER); nobody edits history by hand
REVOKE INSERT, UPDATE, DELETE ON committee_terms FROM PUBLIC, anon, authenticated;

-- Today's committee becomes the first open terms, from the day each joined
INSERT INTO committee_terms (society_id, membership_id, user_id, role, from_date)
SELECT m.society_id, m.id, m.user_id, m.role, m.joined_date
FROM society_memberships m
WHERE m.is_active AND m.role IN ('society_admin', 'secretary', 'chairman', 'treasurer', 'committee_member')
  AND NOT EXISTS (SELECT 1 FROM committee_terms t WHERE t.membership_id = m.id AND t.to_date IS NULL);

CREATE OR REPLACE FUNCTION public.role_title(p_role TEXT)
RETURNS TEXT AS $$
    SELECT CASE p_role
        WHEN 'society_admin' THEN 'Society admin'
        WHEN 'secretary' THEN 'Secretary'
        WHEN 'chairman' THEN 'Chairman'
        WHEN 'treasurer' THEN 'Treasurer'
        WHEN 'committee_member' THEN 'Committee member'
        ELSE initcap(replace(coalesce(p_role, ''), '_', ' '))
    END
$$ LANGUAGE sql IMMUTABLE SET search_path = public;

-- Terms follow the memberships; a single-holder post moves its previous holder down
CREATE OR REPLACE FUNCTION public.trg_committee_terms()
RETURNS TRIGGER AS $$
DECLARE
    committee CONSTANT TEXT[] := ARRAY['society_admin', 'secretary', 'chairman', 'treasurer', 'committee_member'];
    v_was BOOLEAN := TG_OP = 'UPDATE' AND OLD.is_active AND OLD.role = ANY(committee);
    v_is BOOLEAN := NEW.is_active AND NEW.role = ANY(committee);
    v_moved BOOLEAN;
    v_society TEXT;
    v_down UUID[];
BEGIN
    v_moved := v_was AND v_is AND OLD.role IS DISTINCT FROM NEW.role;
    IF v_was AND (NOT v_is OR v_moved) THEN
        UPDATE committee_terms SET to_date = CURRENT_DATE, ended_by = auth.uid()
        WHERE membership_id = NEW.id AND to_date IS NULL;
    END IF;
    IF v_is AND (NOT v_was OR v_moved) THEN
        INSERT INTO committee_terms (society_id, membership_id, user_id, role, from_date, started_by)
        VALUES (NEW.society_id, NEW.id, NEW.user_id, NEW.role, CURRENT_DATE, auth.uid());

        IF NEW.role IN ('secretary', 'chairman', 'treasurer') THEN
            WITH down AS (
                UPDATE society_memberships SET role = 'committee_member', updated_at = timezone('utc'::text, now())
                WHERE society_id = NEW.society_id AND role = NEW.role AND is_active AND id <> NEW.id
                RETURNING user_id
            )
            SELECT array_agg(user_id) INTO v_down FROM down;
            IF v_down IS NOT NULL THEN
                SELECT name INTO v_society FROM societies WHERE id = NEW.society_id;
                PERFORM notify_users(NEW.society_id, v_down, 'committee_role',
                    'You are now Committee member of ' || v_society,
                    'A new ' || role_title(NEW.role) || ' has taken over. You can still see everything as a committee member.',
                    'home');
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_committee_terms ON society_memberships;
CREATE TRIGGER trg_committee_terms
    AFTER INSERT OR UPDATE OF role, is_active ON society_memberships
    FOR EACH ROW EXECUTE FUNCTION public.trg_committee_terms();
REVOKE ALL ON FUNCTION public.trg_committee_terms() FROM PUBLIC, anon, authenticated;

-- p_role NULL takes the member off the committee (their flat, if any, stays)
CREATE OR REPLACE FUNCTION public.change_committee_role(p_society_id UUID, p_user_id UUID, p_role TEXT)
RETURNS JSONB AS $$
DECLARE
    committee CONSTANT TEXT[] := ARRAY['society_admin', 'secretary', 'chairman', 'treasurer', 'committee_member'];
    v_cm society_memberships%ROWTYPE;
    v_previous TEXT;
    v_society TEXT;
BEGIN
    IF NOT (is_platform_admin() OR has_society_role(p_society_id, ARRAY['society_admin', 'secretary', 'chairman'])) THEN
        RAISE EXCEPTION 'Only the Secretary or Chairman can change committee roles';
    END IF;
    IF p_role IS NOT NULL AND NOT (p_role = ANY(committee)) THEN
        RAISE EXCEPTION 'Choose Secretary, Chairman, Treasurer or Committee member';
    END IF;

    SELECT * INTO v_cm FROM society_memberships
    WHERE society_id = p_society_id AND user_id = p_user_id AND is_active AND role = ANY(committee)
    ORDER BY created_at LIMIT 1
    FOR UPDATE;
    v_previous := v_cm.role;

    IF p_role IS NULL THEN
        IF v_cm.id IS NULL THEN
            RAISE EXCEPTION 'They are not on the committee';
        END IF;
        UPDATE society_memberships SET is_active = false, updated_at = timezone('utc'::text, now()) WHERE id = v_cm.id;
    ELSIF v_cm.id IS NOT NULL THEN
        IF v_cm.role = p_role THEN
            RETURN jsonb_build_object('user_id', p_user_id, 'role', p_role, 'previous_role', v_previous);
        END IF;
        UPDATE society_memberships SET role = p_role, updated_at = timezone('utc'::text, now()) WHERE id = v_cm.id;
    ELSE
        IF NOT EXISTS (SELECT 1 FROM society_memberships WHERE society_id = p_society_id AND user_id = p_user_id AND is_active) THEN
            RAISE EXCEPTION 'Only members of this society can join the committee: invite them first';
        END IF;
        INSERT INTO society_memberships (society_id, user_id, role, unit_id, is_active)
        VALUES (p_society_id, p_user_id, p_role, NULL, true);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM society_memberships
                   WHERE society_id = p_society_id AND is_active AND role IN ('society_admin', 'secretary', 'chairman')) THEN
        RAISE EXCEPTION 'The society needs a Secretary or Chairman: choose the new one before this change';
    END IF;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, new_value)
    VALUES (p_society_id, auth.uid(), 'member.role_changed', 'society_membership', coalesce(v_cm.id::text, p_user_id::text),
            jsonb_build_object('user_id', p_user_id, 'role', v_previous),
            jsonb_build_object('user_id', p_user_id, 'role', p_role));

    IF p_user_id IS DISTINCT FROM auth.uid() THEN
        SELECT name INTO v_society FROM societies WHERE id = p_society_id;
        PERFORM notify_users(p_society_id, ARRAY[p_user_id], 'committee_role',
            CASE WHEN p_role IS NULL THEN 'You are no longer on the committee of ' || v_society
                 ELSE 'You are now ' || role_title(p_role) || ' of ' || v_society END,
            CASE WHEN p_role IS NULL THEN 'Your flat and payments stay as they are.'
                 ELSE 'Open Sahvaas to see what your role can do.' END,
            'home');
    END IF;

    RETURN jsonb_build_object('user_id', p_user_id, 'role', p_role, 'previous_role', v_previous);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.change_committee_role(UUID, UUID, TEXT) TO authenticated;

-- Every term, newest first, for the committee (and the platform owner)
CREATE OR REPLACE FUNCTION public.committee_history(p_society_id UUID)
RETURNS JSONB AS $$
BEGIN
    IF NOT (is_platform_admin() OR is_committee_viewer(p_society_id)) THEN
        RAISE EXCEPTION 'Only the committee can see the committee history';
    END IF;
    RETURN coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                   'user_id', t.user_id, 'name', coalesce(p.full_name, p.email, 'Member'), 'role', t.role,
                   'from_date', t.from_date, 'to_date', t.to_date)
               ORDER BY t.from_date DESC, t.created_at DESC)
        FROM committee_terms t
        LEFT JOIN profiles p ON p.id = t.user_id
        WHERE t.society_id = p_society_id), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.committee_history(UUID) TO authenticated;
