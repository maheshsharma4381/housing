-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 012: Consent, Roles & Scale (AUDIT_REPORT.md → F2)
--   H3   invites are accepted or declined explicitly by the invitee
--   M6   committee_member = read-only committee access
--   M3   society_summary(): dashboard totals computed in the database
--   M7   leads: demo requests from the public contact form
--   M12  reserve_notification(): dedupe + daily cap for outbound email
-- Safe to re-run.
-- ============================================================================

-- ============================================================================
-- 1. H3 — EXPLICIT INVITE ACCEPTANCE
-- ============================================================================
ALTER TABLE member_invites DROP CONSTRAINT IF EXISTS member_invites_status_check;
ALTER TABLE member_invites ADD CONSTRAINT member_invites_status_check
    CHECK (status IN ('pending', 'accepted', 'declined', 'revoked'));

-- The verified email of the current user, or NULL
CREATE OR REPLACE FUNCTION public.current_verified_email()
RETURNS TEXT AS $$
    SELECT lower(email) FROM auth.users WHERE id = auth.uid() AND email_confirmed_at IS NOT NULL
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.current_verified_email() FROM PUBLIC, anon, authenticated;

-- Accept one member invite row for a user (internal; caller has checked email + status)
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

    UPDATE member_invites
    SET status = 'accepted', accepted_user_id = p_uid, accepted_at = timezone('utc'::text, now())
    WHERE id = p_invite.id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_invite.society_id, p_uid, 'invite.accepted', 'member_invite', p_invite.id::text,
            jsonb_build_object('role', p_invite.role, 'unit_id', p_invite.unit_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.accept_member_invite_row(member_invites, UUID) FROM PUBLIC, anon, authenticated;

-- Accept one professional invite row (internal)
CREATE OR REPLACE FUNCTION public.accept_professional_invite_row(p_invite professional_invites, p_uid UUID)
RETURNS VOID AS $$
BEGIN
    INSERT INTO society_professional_access (
        society_id, professional_user_id, role, status, permissions, granted_by, granted_at, expires_at
    ) VALUES (
        p_invite.society_id, p_uid, p_invite.role, 'active', p_invite.permissions,
        p_invite.invited_by, timezone('utc'::text, now()), p_invite.access_until
    )
    ON CONFLICT (society_id, professional_user_id) DO UPDATE SET
        role = EXCLUDED.role, status = 'active', permissions = EXCLUDED.permissions,
        granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at, expires_at = EXCLUDED.expires_at;

    UPDATE professional_invites SET status = 'accepted' WHERE id = p_invite.id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_invite.society_id, p_uid, 'professional.access_granted', 'professional_invite', p_invite.id::text,
            jsonb_build_object('role', p_invite.role, 'permissions', p_invite.permissions, 'until', p_invite.access_until));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.accept_professional_invite_row(professional_invites, UUID) FROM PUBLIC, anon, authenticated;

-- Bulk accept (kept for scripts/tests; the app no longer calls these on login)
CREATE OR REPLACE FUNCTION public.claim_my_invites()
RETURNS INT AS $$
DECLARE
    v_email TEXT := current_verified_email();
    v_invite member_invites%ROWTYPE;
    v_count INT := 0;
BEGIN
    IF v_email IS NULL THEN
        RETURN 0;
    END IF;
    FOR v_invite IN
        SELECT mi.* FROM member_invites mi
        JOIN societies s ON s.id = mi.society_id AND s.is_active = true
        WHERE mi.status = 'pending' AND lower(mi.email) = v_email
        FOR UPDATE OF mi
    LOOP
        PERFORM accept_member_invite_row(v_invite, auth.uid());
        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.claim_professional_invites()
RETURNS INT AS $$
DECLARE
    v_email TEXT := current_verified_email();
    v_invite professional_invites%ROWTYPE;
    v_count INT := 0;
BEGIN
    IF v_email IS NULL THEN
        RETURN 0;
    END IF;
    UPDATE professional_invites SET status = 'expired'
    WHERE status = 'pending' AND lower(invited_email) = v_email AND expires_at <= now();
    FOR v_invite IN
        SELECT pi.* FROM professional_invites pi
        JOIN societies s ON s.id = pi.society_id AND s.is_active = true
        WHERE pi.status = 'pending' AND lower(pi.invited_email) = v_email
        FOR UPDATE OF pi
    LOOP
        PERFORM accept_professional_invite_row(v_invite, auth.uid());
        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- What the signed-in (verified) user has been invited to
CREATE OR REPLACE FUNCTION public.my_pending_invites()
RETURNS TABLE (
    kind TEXT, id UUID, society_name TEXT, society_city TEXT, role TEXT, flat TEXT,
    permissions JSONB, invited_by_name TEXT, invited_at TIMESTAMPTZ, expires_at TIMESTAMPTZ
) AS $$
DECLARE
    v_email TEXT := current_verified_email();
BEGIN
    IF v_email IS NULL THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT 'member'::TEXT, mi.id, s.name::TEXT, s.city::TEXT, mi.role::TEXT, u.unit_number::TEXT,
           NULL::JSONB, p.full_name::TEXT, mi.created_at, NULL::TIMESTAMPTZ
    FROM member_invites mi
    JOIN societies s ON s.id = mi.society_id AND s.is_active = true
    LEFT JOIN units u ON u.id = mi.unit_id
    LEFT JOIN profiles p ON p.id = mi.invited_by
    WHERE mi.status = 'pending' AND lower(mi.email) = v_email
    UNION ALL
    SELECT 'professional'::TEXT, pi.id, s.name::TEXT, s.city::TEXT, pi.role::TEXT, NULL::TEXT,
           pi.permissions, p.full_name::TEXT, pi.created_at, pi.expires_at
    FROM professional_invites pi
    JOIN societies s ON s.id = pi.society_id AND s.is_active = true
    LEFT JOIN profiles p ON p.id = pi.invited_by
    WHERE pi.status = 'pending' AND lower(pi.invited_email) = v_email AND pi.expires_at > now()
    ORDER BY 9 DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.respond_to_invite(p_kind TEXT, p_invite_id UUID, p_accept BOOLEAN)
RETURNS JSONB AS $$
DECLARE
    v_email TEXT := current_verified_email();
    v_member member_invites%ROWTYPE;
    v_pro professional_invites%ROWTYPE;
BEGIN
    IF v_email IS NULL THEN
        RAISE EXCEPTION 'Verify your email address before responding to invitations';
    END IF;

    IF p_kind = 'member' THEN
        SELECT mi.* INTO v_member FROM member_invites mi
        JOIN societies s ON s.id = mi.society_id AND s.is_active = true
        WHERE mi.id = p_invite_id AND mi.status = 'pending' AND lower(mi.email) = v_email
        FOR UPDATE OF mi;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Invitation not found or no longer pending';
        END IF;
        IF p_accept THEN
            PERFORM accept_member_invite_row(v_member, auth.uid());
        ELSE
            UPDATE member_invites SET status = 'declined' WHERE id = p_invite_id;
        END IF;
        RETURN jsonb_build_object('kind', 'member', 'society_id', v_member.society_id, 'accepted', p_accept);
    ELSIF p_kind = 'professional' THEN
        SELECT pi.* INTO v_pro FROM professional_invites pi
        JOIN societies s ON s.id = pi.society_id AND s.is_active = true
        WHERE pi.id = p_invite_id AND pi.status = 'pending' AND lower(pi.invited_email) = v_email AND pi.expires_at > now()
        FOR UPDATE OF pi;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Invitation not found or no longer pending';
        END IF;
        IF p_accept THEN
            PERFORM accept_professional_invite_row(v_pro, auth.uid());
        ELSE
            UPDATE professional_invites SET status = 'declined' WHERE id = p_invite_id;
        END IF;
        RETURN jsonb_build_object('kind', 'professional', 'society_id', v_pro.society_id, 'accepted', p_accept);
    END IF;
    RAISE EXCEPTION 'Unknown invitation type %', p_kind;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 2. M6 — committee_member: read-only committee access
-- ============================================================================
CREATE OR REPLACE FUNCTION public.is_committee_viewer(target_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT is_society_admin(target_society_id) OR has_society_role(target_society_id, ARRAY['committee_member'])
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'bills', 'billing_cycles', 'billing_rules', 'payments', 'payment_allocations', 'expenses', 'expense_approvals',
        'vendors', 'accounts', 'journal_entries', 'ledger_entries', 'funds', 'bank_accounts', 'complaints',
        'documents', 'member_invites', 'society_professional_access', 'audit_remarks', 'society_memberships', 'access_logs'
    ] LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_committee_read', t);
        EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (has_society_role(society_id, ARRAY[''committee_member'']))',
                       t || '_committee_read', t);
    END LOOP;
END $$;

DROP POLICY IF EXISTS bill_items_committee_read ON bill_items;
CREATE POLICY bill_items_committee_read ON bill_items
    FOR SELECT USING (EXISTS (SELECT 1 FROM bills b WHERE b.id = bill_items.bill_id AND has_society_role(b.society_id, ARRAY['committee_member'])));

DROP POLICY IF EXISTS complaint_updates_committee_read ON complaint_updates;
CREATE POLICY complaint_updates_committee_read ON complaint_updates
    FOR SELECT USING (has_society_role(society_id, ARRAY['committee_member']));

-- Member names for the read-only committee
DROP POLICY IF EXISTS profiles_committee_read ON profiles;
CREATE POLICY profiles_committee_read ON profiles
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM society_memberships m
            WHERE m.user_id = profiles.id AND m.is_active = true
              AND has_society_role(m.society_id, ARRAY['committee_member'])
        )
    );

CREATE OR REPLACE FUNCTION public.can_view_financials(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT is_platform_admin()
        OR is_committee_viewer(p_society_id)
        OR has_professional_permission(p_society_id, 'view_reports')
        OR has_professional_permission(p_society_id, 'view_ledger')
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. M3 — DASHBOARD SUMMARY (no 1000-row API cap)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.society_summary(p_society_id UUID)
RETURNS JSONB AS $$
BEGIN
    IF NOT (is_platform_admin() OR is_committee_viewer(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can view the summary';
    END IF;
    RETURN jsonb_build_object(
        'units', (SELECT count(*) FROM units WHERE society_id = p_society_id),
        'members', (SELECT count(*) FROM society_memberships WHERE society_id = p_society_id AND is_active),
        'billed', (SELECT coalesce(sum(total_amount), 0) FROM bills WHERE society_id = p_society_id AND status <> 'cancelled'),
        'collected', (SELECT coalesce(sum(amount_paid), 0) FROM bills WHERE society_id = p_society_id AND status <> 'cancelled'),
        'outstanding', (SELECT coalesce(sum(balance_due), 0) FROM bills WHERE society_id = p_society_id AND status IN ('issued', 'partially_paid', 'overdue')),
        'overdue_flats', (SELECT count(DISTINCT unit_id) FROM bills WHERE society_id = p_society_id AND status = 'overdue' AND balance_due > 0),
        'bills', (SELECT count(*) FROM bills WHERE society_id = p_society_id),
        'pending_payments', (SELECT count(*) FROM payments WHERE society_id = p_society_id AND status = 'pending_verification'),
        'pending_expenses', (SELECT count(*) FROM expenses WHERE society_id = p_society_id AND status = 'pending_approval'),
        'open_complaints', (SELECT count(*) FROM complaints WHERE society_id = p_society_id AND status IN ('open', 'in_progress')),
        'upi_configured', (SELECT upi_id IS NOT NULL AND upi_id <> '' FROM society_settings WHERE society_id = p_society_id)
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 4. M7 — LEADS FROM THE PUBLIC CONTACT FORM
-- ============================================================================
CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(120) NOT NULL CHECK (length(trim(name)) >= 2),
    email VARCHAR(191) NOT NULL CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    phone VARCHAR(32) NOT NULL CHECK (length(regexp_replace(phone, '[^0-9]', '', 'g')) BETWEEN 10 AND 13),
    society_name VARCHAR(191) NOT NULL CHECK (length(trim(society_name)) >= 3),
    city VARCHAR(96),
    units INT CHECK (units IS NULL OR units BETWEEN 1 AND 100000),
    message TEXT CHECK (message IS NULL OR length(message) <= 2000),
    status VARCHAR(16) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'converted', 'closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS leads_public_insert ON leads;
DROP POLICY IF EXISTS leads_platform_read ON leads;
DROP POLICY IF EXISTS leads_platform_update ON leads;
CREATE POLICY leads_public_insert ON leads FOR INSERT TO anon, authenticated WITH CHECK (status = 'new');
CREATE POLICY leads_platform_read ON leads FOR SELECT USING (is_platform_admin());
CREATE POLICY leads_platform_update ON leads FOR UPDATE USING (is_platform_admin()) WITH CHECK (is_platform_admin());

-- Basic flood guard: the same email can submit at most 3 times per day
CREATE OR REPLACE FUNCTION public.leads_rate_limit()
RETURNS TRIGGER AS $$
BEGIN
    IF (SELECT count(*) FROM leads WHERE lower(email) = lower(NEW.email) AND created_at > now() - interval '1 day') >= 3 THEN
        RAISE EXCEPTION 'We already have your request — our team will contact you shortly';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_leads_rate_limit ON leads;
CREATE TRIGGER trg_leads_rate_limit BEFORE INSERT ON leads FOR EACH ROW EXECUTE FUNCTION public.leads_rate_limit();

-- ============================================================================
-- 5. M12 — NOTIFICATION LOG: dedupe + daily cap
-- ============================================================================
CREATE TABLE IF NOT EXISTS notification_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    type VARCHAR(32) NOT NULL,
    ref_id UUID NOT NULL,
    recipients INT NOT NULL CHECK (recipients >= 0),
    sent_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_notification_log_society_day ON notification_log(society_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_log_ref ON notification_log(type, ref_id, created_at DESC);
ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_log_read ON notification_log;
CREATE POLICY notification_log_read ON notification_log FOR SELECT USING (is_platform_admin() OR is_society_admin(society_id));

-- Returns {allowed, reason}; records the send when allowed.
-- Same event (type + id) is emailed at most once per 24 h; max 2000 emails per society per day.
CREATE OR REPLACE FUNCTION public.reserve_notification(p_society_id UUID, p_type TEXT, p_ref_id UUID, p_recipients INT)
RETURNS JSONB AS $$
DECLARE
    v_today INT;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'Only the society committee can send notifications');
    END IF;
    IF p_type NOT IN ('member_invite', 'professional_invite', 'bills_issued', 'receipt') OR p_recipients < 1 THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'Invalid notification');
    END IF;
    PERFORM 1 FROM societies WHERE id = p_society_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM notification_log WHERE type = p_type AND ref_id = p_ref_id AND created_at > now() - interval '24 hours') THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'Already emailed in the last 24 hours');
    END IF;
    SELECT coalesce(sum(recipients), 0) INTO v_today FROM notification_log
    WHERE society_id = p_society_id AND created_at > now() - interval '24 hours';
    IF v_today + p_recipients > 2000 THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'Daily email limit reached for this society');
    END IF;
    INSERT INTO notification_log (society_id, type, ref_id, recipients, sent_by)
    VALUES (p_society_id, p_type, p_ref_id, p_recipients, auth.uid());
    RETURN jsonb_build_object('allowed', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 6. PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.my_pending_invites() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.respond_to_invite(TEXT, UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.society_summary(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reserve_notification(UUID, TEXT, UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_pending_invites() TO authenticated;
GRANT EXECUTE ON FUNCTION public.respond_to_invite(TEXT, UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.society_summary(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_notification(UUID, TEXT, UUID, INT) TO authenticated;
