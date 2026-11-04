-- ============================================================================
-- 032 LOG IN WITH A MOBILE (Phase 3C)
--   Supabase phone auth sends a one-time code through our Send SMS hook
--   (/api/auth/sms-hook). The hook asks otp_claim whether this number may get a
--   code now and reports the result to otp_result, which keeps the cost.
--   Accounts may now have a phone and no email; invites may name a mobile.
-- ============================================================================

-- ============================================================================
-- 1. ACCOUNTS WITHOUT AN EMAIL
-- ============================================================================
ALTER TABLE profiles ALTER COLUMN email DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email, phone, is_platform_admin, created_at, updated_at)
  VALUES (
    NEW.id,
    -- a phone login has no name or email yet: "Member" until they give their name
    COALESCE(nullif(trim(NEW.raw_user_meta_data->>'full_name'), ''), nullif(split_part(coalesce(NEW.email, ''), '@', 1), ''), 'Member'),
    NEW.email,
    NEW.phone,
    false, -- STRICT: Prevent self-promotion to Platform Admin
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 2. INVITES BY MOBILE
-- ============================================================================
ALTER TABLE member_invites ALTER COLUMN email DROP NOT NULL;
ALTER TABLE member_invites ADD COLUMN IF NOT EXISTS mobile TEXT;
ALTER TABLE member_invites DROP CONSTRAINT IF EXISTS member_invites_contact_check;
ALTER TABLE member_invites ADD CONSTRAINT member_invites_contact_check
    CHECK ((email IS NOT NULL AND length(trim(email)) > 0) OR normalize_mobile(mobile) IS NOT NULL);
ALTER TABLE member_invites DROP CONSTRAINT IF EXISTS member_invites_mobile_check;
ALTER TABLE member_invites ADD CONSTRAINT member_invites_mobile_check
    CHECK (mobile IS NULL OR normalize_mobile(mobile) IS NOT NULL);
-- One pending invite per mobile per flat (the email index already does this for emails)
CREATE UNIQUE INDEX IF NOT EXISTS uq_member_invite_pending_mobile
    ON member_invites (society_id, normalize_mobile(mobile), coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE status = 'pending' AND mobile IS NOT NULL;

ALTER TABLE professional_invites ALTER COLUMN invited_email DROP NOT NULL;
ALTER TABLE professional_invites ADD COLUMN IF NOT EXISTS invited_mobile TEXT;
ALTER TABLE professional_invites DROP CONSTRAINT IF EXISTS professional_invites_contact_check;
ALTER TABLE professional_invites ADD CONSTRAINT professional_invites_contact_check
    CHECK ((invited_email IS NOT NULL AND length(trim(invited_email)) > 0) OR normalize_mobile(invited_mobile) IS NOT NULL);
ALTER TABLE professional_invites DROP CONSTRAINT IF EXISTS professional_invites_mobile_check;
ALTER TABLE professional_invites ADD CONSTRAINT professional_invites_mobile_check
    CHECK (invited_mobile IS NULL OR normalize_mobile(invited_mobile) IS NOT NULL);

-- from 012_consent_and_roles.sql; + invites by mobile reach the confirmed login phone
CREATE OR REPLACE FUNCTION public.my_pending_invites()
RETURNS TABLE (
    kind TEXT, id UUID, society_name TEXT, society_city TEXT, role TEXT, flat TEXT,
    permissions JSONB, invited_by_name TEXT, invited_at TIMESTAMPTZ, expires_at TIMESTAMPTZ
) AS $$
DECLARE
    v_email TEXT := current_verified_email();
    v_phone TEXT := current_verified_phone();
BEGIN
    IF v_email IS NULL AND v_phone IS NULL THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT 'member'::TEXT, mi.id, s.name::TEXT, s.city::TEXT, mi.role::TEXT, u.unit_number::TEXT,
           NULL::JSONB, p.full_name::TEXT, mi.created_at, NULL::TIMESTAMPTZ
    FROM member_invites mi
    JOIN societies s ON s.id = mi.society_id AND s.is_active = true
    LEFT JOIN units u ON u.id = mi.unit_id
    LEFT JOIN profiles p ON p.id = mi.invited_by
    WHERE mi.status = 'pending' AND (lower(mi.email) = v_email OR normalize_mobile(mi.mobile) = v_phone)
    UNION ALL
    SELECT 'professional'::TEXT, pi.id, s.name::TEXT, s.city::TEXT, pi.role::TEXT, NULL::TEXT,
           pi.permissions, p.full_name::TEXT, pi.created_at, pi.expires_at
    FROM professional_invites pi
    JOIN societies s ON s.id = pi.society_id AND s.is_active = true
    LEFT JOIN profiles p ON p.id = pi.invited_by
    WHERE pi.status = 'pending' AND (lower(pi.invited_email) = v_email OR normalize_mobile(pi.invited_mobile) = v_phone)
      AND pi.expires_at > now()
    ORDER BY 9 DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- from 012_consent_and_roles.sql; + a confirmed mobile may answer an invite made to it
CREATE OR REPLACE FUNCTION public.respond_to_invite(p_kind TEXT, p_invite_id UUID, p_accept BOOLEAN)
RETURNS JSONB AS $$
DECLARE
    v_email TEXT := current_verified_email();
    v_phone TEXT := current_verified_phone();
    v_member member_invites%ROWTYPE;
    v_pro professional_invites%ROWTYPE;
BEGIN
    IF v_email IS NULL AND v_phone IS NULL THEN
        RAISE EXCEPTION 'Verify your email or mobile before responding to invitations';
    END IF;

    IF p_kind = 'member' THEN
        SELECT mi.* INTO v_member FROM member_invites mi
        JOIN societies s ON s.id = mi.society_id AND s.is_active = true
        WHERE mi.id = p_invite_id AND mi.status = 'pending' AND (lower(mi.email) = v_email OR normalize_mobile(mi.mobile) = v_phone)
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
        WHERE pi.id = p_invite_id AND pi.status = 'pending' AND (lower(pi.invited_email) = v_email OR normalize_mobile(pi.invited_mobile) = v_phone)
          AND pi.expires_at > now()
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

-- from 031_joining_link.sql; + the new owner may be named by mobile alone
CREATE OR REPLACE FUNCTION public.transfer_flat_owner(
    p_unit_id UUID, p_new_owner_name TEXT, p_new_owner_email TEXT, p_new_owner_mobile TEXT, p_transfer_date DATE
)
RETURNS JSONB AS $$
DECLARE
    v_unit units%ROWTYPE;
    v_open unit_ownerships%ROWTYPE;
    v_name TEXT := trim(coalesce(p_new_owner_name, ''));
    v_email TEXT := nullif(lower(trim(coalesce(p_new_owner_email, ''))), '');
    v_invite UUID;
    v_period UUID;
    v_balance JSONB;
    v_waiting BOOLEAN := false;
    v_prev unit_ownerships%ROWTYPE;
    v_has_prev BOOLEAN := false;
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
    IF v_email IS NULL AND length(trim(coalesce(p_new_owner_mobile, ''))) = 0 THEN
        RAISE EXCEPTION 'Enter the new owner''s mobile or email — they join with it';
    END IF;
    IF v_email IS NOT NULL AND position('@' IN v_email) < 2 THEN
        RAISE EXCEPTION 'Enter a valid email for the new owner';
    END IF;
    IF length(trim(coalesce(p_new_owner_mobile, ''))) > 0 AND normalize_mobile(p_new_owner_mobile) IS NULL THEN
        RAISE EXCEPTION 'Mobile % is not a valid number', p_new_owner_mobile;
    END IF;
    IF p_transfer_date IS NULL OR p_transfer_date > current_date THEN
        RAISE EXCEPTION 'The transfer date cannot be in the future';
    END IF;
    SELECT * INTO v_open FROM unit_ownerships WHERE unit_id = p_unit_id AND to_date IS NULL FOR UPDATE;
    IF FOUND AND v_open.owner_user_id IS NULL THEN
        -- A change already waits: this one corrects it, checked against the previous owner's start
        v_waiting := true;
        SELECT * INTO v_prev FROM unit_ownerships
        WHERE unit_id = p_unit_id AND to_date IS NOT NULL ORDER BY from_date DESC LIMIT 1 FOR UPDATE;
        v_has_prev := FOUND;
        IF v_has_prev AND p_transfer_date <= v_prev.from_date THEN
            RAISE EXCEPTION 'The transfer date must be after % (when the current owner''s period began)', to_char(v_prev.from_date, 'DD Mon YYYY');
        END IF;
    ELSIF FOUND AND p_transfer_date <= v_open.from_date THEN
        RAISE EXCEPTION 'The transfer date must be after % (when the current owner''s period began)', to_char(v_open.from_date, 'DD Mon YYYY');
    END IF;

    v_balance := flat_balance(p_unit_id);
    -- The joining link now matches the new owner's mobile, not the seller's (031)
    PERFORM put_owner_contact(v_unit.society_id, p_unit_id, true, v_name, true, normalize_mobile(p_new_owner_mobile));

    IF v_waiting THEN
        IF v_has_prev THEN
            UPDATE unit_ownerships SET to_date = p_transfer_date - 1 WHERE id = v_prev.id;
        END IF;
        UPDATE member_invites SET status = 'revoked'
        WHERE society_id = v_unit.society_id AND unit_id = p_unit_id AND role = 'resident_owner' AND status = 'pending';
        INSERT INTO member_invites (society_id, email, mobile, full_name, role, unit_id, invited_by)
        VALUES (v_unit.society_id, v_email, normalize_mobile(p_new_owner_mobile), v_name, 'resident_owner', p_unit_id, auth.uid())
        RETURNING id INTO v_invite;
        UPDATE unit_ownerships
        SET owner_name = v_name, owner_email = v_email, owner_mobile = nullif(trim(coalesce(p_new_owner_mobile, '')), ''),
            from_date = p_transfer_date, invite_id = v_invite
        WHERE id = v_open.id
        RETURNING id INTO v_period;
        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (v_unit.society_id, auth.uid(), 'unit.owner_change_corrected', 'unit', p_unit_id::text,
                jsonb_build_object('new_owner', v_name, 'email', v_email, 'transfer_date', p_transfer_date));
        RETURN jsonb_build_object('ownership_id', v_period, 'invite_id', v_invite,
                                  'dues', v_balance -> 'dues', 'advance', v_balance -> 'advance');
    END IF;

    -- The current owner's period ends the day before; they lose the flat
    UPDATE unit_ownerships SET to_date = p_transfer_date - 1 WHERE unit_id = p_unit_id AND to_date IS NULL;
    UPDATE society_memberships SET is_active = false, updated_at = timezone('utc'::text, now())
    WHERE society_id = v_unit.society_id AND unit_id = p_unit_id AND role = 'resident_owner' AND is_active;

    -- The new owner is invited; their period waits for them to join
    UPDATE member_invites SET status = 'revoked'
    WHERE society_id = v_unit.society_id AND unit_id = p_unit_id AND role = 'resident_owner' AND status = 'pending';
    INSERT INTO member_invites (society_id, email, mobile, full_name, role, unit_id, invited_by)
    VALUES (v_unit.society_id, v_email, normalize_mobile(p_new_owner_mobile), v_name, 'resident_owner', p_unit_id, auth.uid())
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
-- 3. FLATS CLAIMED BY THE LOGIN'S PHONE
-- ============================================================================
-- After a mobile login: every flat whose owner mobile the committee entered as this phone becomes theirs
CREATE OR REPLACE FUNCTION public.claim_my_flats()
RETURNS JSONB AS $$
DECLARE
    v_out JSONB;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN '[]'::jsonb;
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('society_name', a.society_name, 'flat', a.flat)), '[]'::jsonb) INTO v_out
    FROM attach_flats_by_phone(NULL, auth.uid(), current_verified_phone()) a;
    RETURN v_out;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 4. CODES: LIMITS, LOG AND COST
-- ============================================================================
CREATE TABLE IF NOT EXISTS otp_settings (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    per_number_daily INT NOT NULL DEFAULT 5 CHECK (per_number_daily > 0),
    unknown_per_number_daily INT NOT NULL DEFAULT 3 CHECK (unknown_per_number_daily > 0),
    platform_daily_cap INT NOT NULL DEFAULT 2000 CHECK (platform_daily_cap >= 0),
    resend_seconds INT NOT NULL DEFAULT 60 CHECK (resend_seconds >= 0),
    -- rupees per message before GST (spec 3, Oct 2026)
    cost_whatsapp NUMERIC(8,3) NOT NULL DEFAULT 0.115,
    cost_sms NUMERIC(8,3) NOT NULL DEFAULT 0.200,
    cost_foreign NUMERIC(8,3) NOT NULL DEFAULT 0.800,
    updated_by UUID REFERENCES profiles(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
INSERT INTO otp_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS otp_blocked_numbers (
    mobile TEXT PRIMARY KEY,
    reason TEXT,
    blocked_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS otp_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mobile TEXT NOT NULL,
    society_id UUID REFERENCES societies(id) ON DELETE SET NULL,
    known BOOLEAN NOT NULL DEFAULT false,
    foreign_number BOOLEAN NOT NULL DEFAULT false,
    status VARCHAR(16) NOT NULL CHECK (status IN ('claimed', 'sent', 'failed', 'refused')),
    channel VARCHAR(16) CHECK (channel IN ('whatsapp', 'sms', 'console')),
    reason TEXT,
    cost NUMERIC(8,3) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_otp_log_mobile ON otp_log (mobile, created_at);
CREATE INDEX IF NOT EXISTS idx_otp_log_counted ON otp_log (created_at) WHERE status IN ('claimed', 'sent');
CREATE INDEX IF NOT EXISTS idx_otp_log_society ON otp_log (society_id, created_at) WHERE society_id IS NOT NULL;

-- Read only through otp_overview (platform owner); written only by the hook's service role
ALTER TABLE otp_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_blocked_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON otp_settings, otp_blocked_numbers, otp_log FROM PUBLIC, anon, authenticated;

-- May this number get a code now? Records the attempt either way; refusals never count toward a limit.
CREATE OR REPLACE FUNCTION public.otp_claim(p_phone TEXT)
RETURNS JSONB AS $$
DECLARE
    v_m TEXT := normalize_mobile(p_phone);
    v_s otp_settings%ROWTYPE;
    v_soc UUID;
    v_known BOOLEAN;
    v_foreign BOOLEAN;
    v_reason TEXT;
    v_id UUID;
BEGIN
    IF v_m IS NULL THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'Enter a valid mobile number', 'log_id', NULL, 'foreign', false, 'known', false);
    END IF;
    -- one decision at a time per number, so two quick taps cannot both pass the limits
    PERFORM pg_advisory_xact_lock(hashtext('otp:' || v_m));
    SELECT * INTO v_s FROM otp_settings WHERE id = 1;
    v_foreign := NOT (length(v_m) = 12 AND left(v_m, 2) = '91');

    -- A known number: registered against a flat, invited, or already a member, a professional or the platform owner
    SELECT c.society_id INTO v_soc FROM unit_owner_contacts c JOIN societies s ON s.id = c.society_id AND s.is_active
    WHERE c.owner_mobile = v_m LIMIT 1;
    IF v_soc IS NULL THEN
        SELECT o.society_id INTO v_soc FROM unit_ownerships o
        WHERE o.to_date IS NULL AND o.owner_user_id IS NULL AND normalize_mobile(o.owner_mobile) = v_m LIMIT 1;
    END IF;
    IF v_soc IS NULL THEN
        SELECT mi.society_id INTO v_soc FROM member_invites mi WHERE mi.status = 'pending' AND normalize_mobile(mi.mobile) = v_m LIMIT 1;
    END IF;
    IF v_soc IS NULL THEN
        SELECT pi.society_id INTO v_soc FROM professional_invites pi
        WHERE pi.status = 'pending' AND pi.expires_at > now() AND normalize_mobile(pi.invited_mobile) = v_m LIMIT 1;
    END IF;
    IF v_soc IS NULL THEN
        SELECT m.society_id INTO v_soc FROM auth.users au JOIN society_memberships m ON m.user_id = au.id AND m.is_active
        WHERE normalize_mobile(au.phone) = v_m ORDER BY m.created_at LIMIT 1;
    END IF;
    v_known := v_soc IS NOT NULL OR EXISTS (
        SELECT 1 FROM auth.users au
        WHERE normalize_mobile(au.phone) = v_m
          AND (EXISTS (SELECT 1 FROM platform_admins pa WHERE pa.user_id = au.id)
               OR EXISTS (SELECT 1 FROM society_professional_access spa
                          WHERE spa.professional_user_id = au.id AND spa.status = 'active')));

    IF EXISTS (SELECT 1 FROM otp_blocked_numbers WHERE mobile = v_m) THEN
        v_reason := 'This mobile number is blocked — contact Sahvaas support';
    ELSIF EXISTS (SELECT 1 FROM otp_log WHERE mobile = v_m AND status IN ('claimed', 'sent', 'failed')
                    AND created_at > timezone('utc'::text, now()) - make_interval(secs => v_s.resend_seconds)) THEN
        v_reason := 'Wait a minute before asking for another code';
    ELSIF (SELECT count(*) FROM otp_log WHERE mobile = v_m AND status IN ('claimed', 'sent')
             AND created_at > timezone('utc'::text, now()) - interval '1 day')
          >= (CASE WHEN v_known THEN v_s.per_number_daily ELSE v_s.unknown_per_number_daily END) THEN
        v_reason := 'Too many codes for this number today — try again tomorrow';
    ELSIF (SELECT count(*) FROM otp_log WHERE status IN ('claimed', 'sent')
             AND created_at > timezone('utc'::text, now()) - interval '1 day') >= v_s.platform_daily_cap THEN
        v_reason := 'Mobile login is busy right now — try again later';
    END IF;

    INSERT INTO otp_log (mobile, society_id, known, foreign_number, status, reason)
    VALUES (v_m, v_soc, v_known, v_foreign, CASE WHEN v_reason IS NULL THEN 'claimed' ELSE 'refused' END, v_reason)
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('allowed', v_reason IS NULL, 'reason', v_reason,
        'log_id', CASE WHEN v_reason IS NULL THEN v_id END, 'foreign', v_foreign, 'known', v_known);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- The hook reports how the code went out; a failed send costs nothing and does not count toward the limits
CREATE OR REPLACE FUNCTION public.otp_result(p_log_id UUID, p_channel TEXT, p_ok BOOLEAN, p_error TEXT)
RETURNS VOID AS $$
DECLARE
    v_s otp_settings%ROWTYPE;
BEGIN
    SELECT * INTO v_s FROM otp_settings WHERE id = 1;
    UPDATE otp_log SET
        status = CASE WHEN p_ok THEN 'sent' ELSE 'failed' END,
        channel = p_channel,
        reason = left(p_error, 300),
        cost = CASE
            WHEN NOT p_ok OR p_channel = 'console' THEN 0
            WHEN foreign_number THEN v_s.cost_foreign
            WHEN p_channel = 'sms' THEN v_s.cost_sms
            ELSE v_s.cost_whatsapp
        END
    WHERE id = p_log_id AND status = 'claimed';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. THE PLATFORM OWNER'S VIEW (spec 11 item 1)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.otp_overview(p_days INT DEFAULT 30)
RETURNS JSONB AS $$
DECLARE
    v_from TIMESTAMPTZ := timezone('utc'::text, now()) - make_interval(days => greatest(coalesce(p_days, 30), 1));
    v_year TIMESTAMPTZ := timezone('utc'::text, now()) - interval '365 days';
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Only the platform owner can see OTP costs';
    END IF;
    RETURN jsonb_build_object(
        'days', greatest(coalesce(p_days, 30), 1),
        'totals', (
            SELECT jsonb_build_object(
                'whatsapp', count(*) FILTER (WHERE status = 'sent' AND channel = 'whatsapp' AND NOT foreign_number),
                'sms', count(*) FILTER (WHERE status = 'sent' AND channel = 'sms'),
                'foreign', count(*) FILTER (WHERE status = 'sent' AND foreign_number),
                'console', count(*) FILTER (WHERE status = 'sent' AND channel = 'console'),
                'failed', count(*) FILTER (WHERE status = 'failed'),
                'refused', count(*) FILTER (WHERE status = 'refused'),
                'cost', coalesce(sum(cost), 0))
            FROM otp_log WHERE created_at >= v_from),
        'societies', coalesce((
            SELECT jsonb_agg(row_to_json(x) ORDER BY x.sent_year DESC, x.name)
            FROM (
                SELECT s.id AS society_id, s.name,
                       (SELECT count(*) FROM units u WHERE u.society_id = s.id) AS flats,
                       count(*) FILTER (WHERE l.status = 'sent' AND l.created_at >= v_from) AS sent,
                       coalesce(sum(l.cost) FILTER (WHERE l.created_at >= v_from), 0) AS cost,
                       count(*) FILTER (WHERE l.status = 'sent') AS sent_year,
                       count(*) FILTER (WHERE l.status = 'sent')
                           > 5 * greatest((SELECT count(*) FROM units u WHERE u.society_id = s.id), 1) AS alert
                FROM otp_log l JOIN societies s ON s.id = l.society_id
                WHERE l.created_at >= v_year
                GROUP BY s.id, s.name
            ) x), '[]'::jsonb),
        'unattributed', (SELECT count(*) FROM otp_log WHERE society_id IS NULL AND status = 'sent' AND created_at >= v_from),
        'settings', (SELECT to_jsonb(o) - 'id' FROM otp_settings o WHERE id = 1),
        'blocked', coalesce((SELECT jsonb_agg(jsonb_build_object('mobile', b.mobile, 'reason', b.reason, 'created_at', b.created_at)
                                             ORDER BY b.created_at DESC) FROM otp_blocked_numbers b), '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.set_otp_settings(p JSONB)
RETURNS VOID AS $$
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Only the platform owner can see OTP costs';
    END IF;
    UPDATE otp_settings SET
        per_number_daily = coalesce((p ->> 'per_number_daily')::int, per_number_daily),
        unknown_per_number_daily = coalesce((p ->> 'unknown_per_number_daily')::int, unknown_per_number_daily),
        platform_daily_cap = coalesce((p ->> 'platform_daily_cap')::int, platform_daily_cap),
        resend_seconds = coalesce((p ->> 'resend_seconds')::int, resend_seconds),
        cost_whatsapp = coalesce((p ->> 'cost_whatsapp')::numeric, cost_whatsapp),
        cost_sms = coalesce((p ->> 'cost_sms')::numeric, cost_sms),
        cost_foreign = coalesce((p ->> 'cost_foreign')::numeric, cost_foreign),
        updated_by = auth.uid(),
        updated_at = timezone('utc'::text, now())
    WHERE id = 1;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (NULL, auth.uid(), 'platform.otp_settings', 'otp_settings', '1', p);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.block_mobile(p_mobile TEXT, p_reason TEXT)
RETURNS VOID AS $$
DECLARE
    v_m TEXT := normalize_mobile(p_mobile);
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Only the platform owner can see OTP costs';
    END IF;
    IF v_m IS NULL THEN
        RAISE EXCEPTION 'Enter a valid mobile number';
    END IF;
    INSERT INTO otp_blocked_numbers (mobile, reason, blocked_by) VALUES (v_m, nullif(trim(coalesce(p_reason, '')), ''), auth.uid())
    ON CONFLICT (mobile) DO UPDATE SET reason = EXCLUDED.reason, blocked_by = EXCLUDED.blocked_by;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (NULL, auth.uid(), 'platform.mobile_blocked', 'mobile', v_m, jsonb_build_object('reason', p_reason));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.unblock_mobile(p_mobile TEXT)
RETURNS VOID AS $$
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Only the platform owner can see OTP costs';
    END IF;
    DELETE FROM otp_blocked_numbers WHERE mobile = normalize_mobile(p_mobile);
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (NULL, auth.uid(), 'platform.mobile_unblocked', 'mobile', coalesce(normalize_mobile(p_mobile), p_mobile), '{}'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.otp_claim(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.otp_result(UUID, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_my_flats() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.otp_overview(INT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_otp_settings(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.block_mobile(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unblock_mobile(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_my_flats() TO authenticated;
GRANT EXECUTE ON FUNCTION public.otp_overview(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_otp_settings(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.block_mobile(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unblock_mobile(TEXT) TO authenticated;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION public.otp_claim(TEXT) TO service_role';
        EXECUTE 'GRANT EXECUTE ON FUNCTION public.otp_result(UUID, TEXT, BOOLEAN, TEXT) TO service_role';
    END IF;
END;
$$;
