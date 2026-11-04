-- ============================================================================
-- 029 OWNER CHANGE AND OWNERSHIP HISTORY (Phase 2F)
--   Who owned each flat from when to when. The secretary records an owner change:
--   the old owner loses the flat, the new owner is invited, and the flat's unpaid
--   bills move to the new owner when they join (the dues stay with the flat).
-- ============================================================================

-- ============================================================================
-- 1. OWNERSHIP HISTORY
-- ============================================================================
CREATE TABLE IF NOT EXISTS unit_ownerships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    owner_user_id UUID REFERENCES profiles(id),
    owner_name TEXT NOT NULL,
    owner_email TEXT,
    owner_mobile TEXT,
    from_date DATE NOT NULL,
    to_date DATE CHECK (to_date IS NULL OR to_date >= from_date),
    invite_id UUID REFERENCES member_invites(id) ON DELETE SET NULL,
    created_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_unit_ownership_open ON unit_ownerships (unit_id) WHERE to_date IS NULL;
CREATE INDEX IF NOT EXISTS idx_unit_ownerships_unit ON unit_ownerships (unit_id, from_date);
ALTER TABLE unit_ownerships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS unit_ownerships_select ON unit_ownerships;
CREATE POLICY unit_ownerships_select ON unit_ownerships FOR SELECT USING (can_view_financials(society_id));

-- Today's owners start the history
INSERT INTO unit_ownerships (society_id, unit_id, owner_user_id, owner_name, owner_email, from_date)
SELECT u.society_id, u.id, o.user_id, coalesce(p.full_name, p.email, 'Owner'), p.email, o.since
FROM units u
CROSS JOIN LATERAL (
    SELECT coalesce(
               (SELECT m.user_id FROM society_memberships m
                WHERE m.unit_id = u.id AND m.society_id = u.society_id AND m.role = 'resident_owner' AND m.is_active
                ORDER BY m.created_at LIMIT 1),
               u.current_owner_id) AS user_id,
           coalesce(
               (SELECT coalesce(m.joined_date, m.created_at::date) FROM society_memberships m
                WHERE m.unit_id = u.id AND m.society_id = u.society_id AND m.role = 'resident_owner' AND m.is_active
                ORDER BY m.created_at LIMIT 1),
               u.created_at::date) AS since
) o
LEFT JOIN profiles p ON p.id = o.user_id
WHERE o.user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM unit_ownerships x WHERE x.unit_id = u.id AND x.to_date IS NULL);

-- from 012_consent_and_roles.sql; + the ownership history is kept as owners join
CREATE OR REPLACE FUNCTION public.accept_member_invite_row(p_invite member_invites, p_uid UUID)
RETURNS VOID AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM society_memberships
        WHERE society_id = p_invite.society_id AND user_id = p_uid
          AND unit_id IS NOT DISTINCT FROM p_invite.unit_id
    ) THEN
        UPDATE society_memberships
        SET role = p_invite.role, is_active = true, updated_at = timezone('utc'::text, now())
        WHERE society_id = p_invite.society_id AND user_id = p_uid
          AND unit_id IS NOT DISTINCT FROM p_invite.unit_id;
    ELSE
        INSERT INTO society_memberships (society_id, user_id, role, unit_id)
        VALUES (p_invite.society_id, p_uid, p_invite.role, p_invite.unit_id);
    END IF;

    IF p_invite.unit_id IS NOT NULL THEN
        IF p_invite.role = 'resident_owner' THEN
            UPDATE units SET current_owner_id = p_uid, updated_at = timezone('utc'::text, now())
            WHERE id = p_invite.unit_id;
        ELSIF p_invite.role = 'resident_tenant' THEN
            UPDATE units SET current_tenant_id = p_uid, occupancy_status = 'tenant_occupied',
                             updated_at = timezone('utc'::text, now())
            WHERE id = p_invite.unit_id;
        END IF;
    END IF;

    -- Ownership history (029): the owner an owner change was waiting for, or a flat's first owner
    IF p_invite.unit_id IS NOT NULL AND p_invite.role = 'resident_owner' THEN
        UPDATE unit_ownerships SET owner_user_id = p_uid
        WHERE invite_id = p_invite.id AND owner_user_id IS NULL;
        IF FOUND THEN
            -- The dues stay with the flat: its unpaid bills are now the new owner's to pay
            UPDATE bills SET user_id = p_uid, updated_at = timezone('utc'::text, now())
            WHERE unit_id = p_invite.unit_id AND balance_due > 0 AND status IN ('issued', 'partially_paid', 'overdue');
        ELSIF NOT EXISTS (SELECT 1 FROM unit_ownerships WHERE unit_id = p_invite.unit_id AND to_date IS NULL) THEN
            INSERT INTO unit_ownerships (society_id, unit_id, owner_user_id, owner_name, owner_email, from_date)
            SELECT p_invite.society_id, p_invite.unit_id, p_uid, coalesce(p.full_name, p.email, p_invite.email),
                   coalesce(p.email, p_invite.email), current_date
            FROM (SELECT 1) one LEFT JOIN profiles p ON p.id = p_uid;
        END IF;
    END IF;

    UPDATE member_invites
    SET status = 'accepted', accepted_user_id = p_uid, accepted_at = timezone('utc'::text, now())
    WHERE id = p_invite.id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_invite.society_id, p_uid, 'invite.accepted', 'member_invite', p_invite.id::text,
            jsonb_build_object('role', p_invite.role, 'unit_id', p_invite.unit_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.flat_owner_periods(p_unit_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_society UUID;
BEGIN
    SELECT society_id INTO v_society FROM units WHERE id = p_unit_id;
    IF v_society IS NULL OR NOT can_view_financials(v_society) THEN
        RAISE EXCEPTION 'You do not have access to this society''s accounts';
    END IF;
    RETURN coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                   'id', o.id, 'owner_name', o.owner_name, 'owner_email', o.owner_email, 'owner_mobile', o.owner_mobile,
                   'from_date', o.from_date, 'to_date', o.to_date, 'joined', o.owner_user_id IS NOT NULL
               ) ORDER BY o.from_date, o.created_at)
        FROM unit_ownerships o WHERE o.unit_id = p_unit_id
    ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 2. THE SECRETARY RECORDS AN OWNER CHANGE
-- ============================================================================
-- What the flat owes (unpaid bills) and holds in advance (unallocated payments + opening advance)
CREATE OR REPLACE FUNCTION public.flat_balance(p_unit_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_society UUID;
BEGIN
    SELECT society_id INTO v_society FROM units WHERE id = p_unit_id;
    IF v_society IS NULL OR NOT can_view_financials(v_society) THEN
        RAISE EXCEPTION 'You do not have access to this society''s accounts';
    END IF;
    RETURN jsonb_build_object(
        'dues', (SELECT coalesce(sum(b.balance_due), 0) FROM bills b
                 WHERE b.unit_id = p_unit_id AND b.balance_due > 0 AND b.status IN ('issued', 'partially_paid', 'overdue')),
        'advance', (SELECT coalesce(sum(p.amount - coalesce((SELECT sum(a.amount) FROM payment_allocations a WHERE a.payment_id = p.id), 0)), 0)
                    FROM payments p WHERE p.unit_id = p_unit_id AND p.status = 'verified')
                 + (SELECT coalesce(sum(o.remaining), 0) FROM opening_advances o WHERE o.unit_id = p_unit_id)
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.transfer_flat_owner(
    p_unit_id UUID, p_new_owner_name TEXT, p_new_owner_email TEXT, p_new_owner_mobile TEXT, p_transfer_date DATE
)
RETURNS JSONB AS $$
DECLARE
    v_unit units%ROWTYPE;
    v_open unit_ownerships%ROWTYPE;
    v_name TEXT := trim(coalesce(p_new_owner_name, ''));
    v_email TEXT := lower(trim(coalesce(p_new_owner_email, '')));
    v_invite UUID;
    v_period UUID;
    v_balance JSONB;
BEGIN
    SELECT * INTO v_unit FROM units WHERE id = p_unit_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Flat not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_unit.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can record an owner change';
    END IF;
    IF length(v_name) < 2 THEN
        RAISE EXCEPTION 'Enter the new owner''s name';
    END IF;
    IF position('@' IN v_email) < 2 THEN
        RAISE EXCEPTION 'Enter the new owner''s email — they join with it';
    END IF;
    IF p_transfer_date IS NULL OR p_transfer_date > current_date THEN
        RAISE EXCEPTION 'The transfer date cannot be in the future';
    END IF;
    SELECT * INTO v_open FROM unit_ownerships WHERE unit_id = p_unit_id AND to_date IS NULL FOR UPDATE;
    IF FOUND AND v_open.owner_user_id IS NULL THEN
        RAISE EXCEPTION 'This flat already has a new owner waiting to join';
    END IF;
    IF FOUND AND p_transfer_date <= v_open.from_date THEN
        RAISE EXCEPTION 'The transfer date must be after % (when the current owner''s period began)', to_char(v_open.from_date, 'DD Mon YYYY');
    END IF;

    v_balance := flat_balance(p_unit_id);

    -- The current owner's period ends the day before; they lose the flat
    UPDATE unit_ownerships SET to_date = p_transfer_date - 1 WHERE unit_id = p_unit_id AND to_date IS NULL;
    UPDATE society_memberships SET is_active = false, updated_at = timezone('utc'::text, now())
    WHERE society_id = v_unit.society_id AND unit_id = p_unit_id AND role = 'resident_owner' AND is_active;

    -- The new owner is invited; their period waits for them to join
    UPDATE member_invites SET status = 'revoked'
    WHERE society_id = v_unit.society_id AND unit_id = p_unit_id AND role = 'resident_owner' AND status = 'pending';
    INSERT INTO member_invites (society_id, email, full_name, role, unit_id, invited_by)
    VALUES (v_unit.society_id, v_email, v_name, 'resident_owner', p_unit_id, auth.uid())
    RETURNING id INTO v_invite;
    INSERT INTO unit_ownerships (society_id, unit_id, owner_name, owner_email, owner_mobile, from_date, invite_id, created_by)
    VALUES (v_unit.society_id, p_unit_id, v_name, v_email, nullif(trim(coalesce(p_new_owner_mobile, '')), ''), p_transfer_date,
            v_invite, auth.uid())
    RETURNING id INTO v_period;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_unit.society_id, auth.uid(), 'unit.owner_changed', 'unit', p_unit_id::text,
            jsonb_build_object('new_owner', v_name, 'email', v_email, 'transfer_date', p_transfer_date,
                               'dues', v_balance -> 'dues', 'advance', v_balance -> 'advance'));
    RETURN jsonb_build_object('ownership_id', v_period, 'invite_id', v_invite,
                              'dues', v_balance -> 'dues', 'advance', v_balance -> 'advance');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.flat_balance(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.transfer_flat_owner(UUID, TEXT, TEXT, TEXT, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.flat_balance(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_flat_owner(UUID, TEXT, TEXT, TEXT, DATE) TO authenticated;
REVOKE ALL ON FUNCTION public.flat_owner_periods(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.flat_owner_periods(UUID) TO authenticated;
