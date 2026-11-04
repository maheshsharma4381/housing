-- ============================================================================
-- 027 THE CA WORKSPACE (Phase 2D)
--   A society without a CA can make a committee member its Accountant, with the
--   CA's manage_accounts powers. The CA / Accountant keeps the asset register and
--   matches bank lines; verifying payments stays with the committee. Locking a
--   year is proposed and approved by another committee member.
-- ============================================================================

-- ============================================================================
-- 1. THE ACCOUNTANT SWITCH
-- ============================================================================
ALTER TABLE society_memberships ADD COLUMN IF NOT EXISTS is_accountant BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE society_memberships DROP CONSTRAINT IF EXISTS chk_accountant_is_committee;
ALTER TABLE society_memberships ADD CONSTRAINT chk_accountant_is_committee
    CHECK (NOT is_accountant OR role IN ('society_admin', 'secretary', 'chairman', 'treasurer', 'committee_member'));

-- from 019_account_groups.sql; + an active membership with the Accountant switch on
CREATE OR REPLACE FUNCTION public.can_manage_accounts(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT is_platform_admin() OR has_professional_permission(p_society_id, 'manage_accounts')
        OR EXISTS (
            SELECT 1 FROM society_memberships m
            JOIN societies s ON s.id = m.society_id AND s.is_active = true
            WHERE m.society_id = p_society_id AND m.user_id = auth.uid() AND m.is_active = true AND m.is_accountant
        )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- from 014_ca_workspace.sql; + the Accountant
CREATE OR REPLACE FUNCTION public.can_propose_adjustment(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT is_society_admin(p_society_id)
        OR has_professional_permission(p_society_id, 'view_ledger')
        OR has_professional_permission(p_society_id, 'view_reports')
        OR can_manage_accounts(p_society_id)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.set_accountant(p_society_id UUID, p_user_id UUID, p_on BOOLEAN)
RETURNS JSONB AS $$
DECLARE
    v_id UUID;
    v_on BOOLEAN := coalesce(p_on, false);
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can choose the accountant';
    END IF;
    SELECT id INTO v_id FROM society_memberships
    WHERE society_id = p_society_id AND user_id = p_user_id AND is_active = true
      AND role IN ('society_admin', 'secretary', 'chairman', 'treasurer', 'committee_member')
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE;
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'Only an active committee member can be the society''s accountant';
    END IF;

    IF v_on THEN
        UPDATE society_memberships SET is_accountant = true, updated_at = timezone('utc'::text, now()) WHERE id = v_id;
    ELSE
        UPDATE society_memberships SET is_accountant = false, updated_at = timezone('utc'::text, now())
        WHERE society_id = p_society_id AND user_id = p_user_id AND is_accountant;
    END IF;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), CASE WHEN v_on THEN 'member.accountant_on' ELSE 'member.accountant_off' END,
            'society_membership', v_id::text, jsonb_build_object('user_id', p_user_id));
    RETURN jsonb_build_object('user_id', p_user_id, 'is_accountant', v_on);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.set_accountant(UUID, UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_accountant(UUID, UUID, BOOLEAN) TO authenticated;
