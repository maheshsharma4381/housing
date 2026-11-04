-- ============================================================================
-- 031 OWNERS' MOBILES AND ONE SOCIETY JOINING LINK (Phase 3B)
--   The secretary records each flat's owner name and mobile and shares one link.
--   A logged-in member whose verified mobile (auth.users.phone, set by phone OTP)
--   matches a flat joins it at once; anyone else becomes a join request in Approvals.
-- ============================================================================

-- ============================================================================
-- 1. MOBILES AND OWNER CONTACTS
-- ============================================================================
-- Digits with the country code: 10 Indian digits get 91; a leading + or 0 is dropped
CREATE OR REPLACE FUNCTION public.normalize_mobile(p TEXT)
RETURNS TEXT AS $$
    SELECT CASE
        WHEN d IS NULL OR length(d) < 10 THEN NULL
        WHEN length(d) = 10 THEN '91' || d
        WHEN length(d) = 11 AND left(d, 1) = '0' THEN '91' || substr(d, 2)
        ELSE d
    END
    FROM (SELECT nullif(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), '') AS d) x
$$ LANGUAGE sql IMMUTABLE;

ALTER TABLE units ADD COLUMN IF NOT EXISTS owner_name TEXT;
ALTER TABLE units ADD COLUMN IF NOT EXISTS owner_mobile TEXT;
CREATE INDEX IF NOT EXISTS idx_units_owner_mobile ON units (society_id, owner_mobile) WHERE owner_mobile IS NOT NULL;

CREATE OR REPLACE FUNCTION public.set_flat_owner_contacts(p_society_id UUID, p_rows JSONB)
RETURNS INT AS $$
DECLARE
    v_row JSONB;
    v_mobile TEXT;
    v_count INT := 0;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can change flats';
    END IF;
    FOR v_row IN SELECT * FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) LOOP
        v_mobile := NULL;
        IF length(trim(coalesce(v_row ->> 'mobile', ''))) > 0 THEN
            v_mobile := normalize_mobile(v_row ->> 'mobile');
            IF v_mobile IS NULL THEN
                RAISE EXCEPTION 'Mobile % is not a valid number', v_row ->> 'mobile';
            END IF;
        END IF;
        UPDATE units SET owner_name = nullif(trim(coalesce(v_row ->> 'name', '')), ''), owner_mobile = v_mobile,
                         updated_at = timezone('utc'::text, now())
        WHERE id::text = v_row ->> 'unit_id' AND society_id = p_society_id;
        IF FOUND THEN
            v_count := v_count + 1;
        END IF;
    END LOOP;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'units.owner_contacts', 'society', p_society_id::text, jsonb_build_object('flats', v_count));
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 2. ONE PLACE THAT MAKES SOMEONE A FLAT'S OWNER (invite or joining link)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.attach_flat_owner(p_society_id UUID, p_unit_id UUID, p_uid UUID, p_invite_id UUID DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
    v_waiting_since TIMESTAMPTZ;
BEGIN
    UPDATE units SET current_owner_id = p_uid, updated_at = timezone('utc'::text, now()) WHERE id = p_unit_id;
    -- An owner change waiting on this flat is completed by whoever joins as its owner
    UPDATE unit_ownerships o
    SET owner_user_id = p_uid,
        owner_email = coalesce((SELECT email FROM profiles WHERE id = p_uid), o.owner_email),
        invite_id = coalesce(p_invite_id, o.invite_id)
    WHERE o.unit_id = p_unit_id AND o.to_date IS NULL AND o.owner_user_id IS NULL
    RETURNING o.created_at INTO v_waiting_since;
    IF FOUND THEN
        -- The dues stay with the flat: its unpaid bills are now the new owner's to pay
        UPDATE bills SET user_id = p_uid, updated_at = timezone('utc'::text, now())
        WHERE unit_id = p_unit_id AND balance_due > 0 AND status IN ('issued', 'partially_paid', 'overdue');
        -- Receipts recorded for the flat while the change waited are the new owner's too
        UPDATE payments SET user_id = p_uid
        WHERE unit_id = p_unit_id AND created_at >= v_waiting_since AND user_id IS DISTINCT FROM p_uid;
    ELSIF NOT EXISTS (SELECT 1 FROM unit_ownerships WHERE unit_id = p_unit_id AND to_date IS NULL) THEN
        INSERT INTO unit_ownerships (society_id, unit_id, owner_user_id, owner_name, owner_email, owner_mobile, from_date)
        SELECT p_society_id, p_unit_id, p_uid, coalesce(p.full_name, u.owner_name, p.email, 'Owner'), p.email, u.owner_mobile, current_date
        FROM units u LEFT JOIN profiles p ON p.id = p_uid
        WHERE u.id = p_unit_id;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- An active membership with this role on this flat (re-activates an old row)
CREATE OR REPLACE FUNCTION public.upsert_flat_membership(p_society_id UUID, p_uid UUID, p_unit_id UUID, p_role TEXT)
RETURNS VOID AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM society_memberships WHERE society_id = p_society_id AND user_id = p_uid AND unit_id IS NOT DISTINCT FROM p_unit_id) THEN
        UPDATE society_memberships SET role = p_role, is_active = true, updated_at = timezone('utc'::text, now())
        WHERE society_id = p_society_id AND user_id = p_uid AND unit_id IS NOT DISTINCT FROM p_unit_id;
    ELSE
        INSERT INTO society_memberships (society_id, user_id, role, unit_id) VALUES (p_society_id, p_uid, p_role, p_unit_id);
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- The login's own mobile, only once Supabase has confirmed it with a code (never a typed number)
CREATE OR REPLACE FUNCTION public.current_verified_phone()
RETURNS TEXT AS $$
    SELECT normalize_mobile(phone) FROM auth.users WHERE id = auth.uid() AND phone_confirmed_at IS NOT NULL
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Every flat whose expected owner mobile is this phone becomes this user's (one society, or all when NULL)
CREATE OR REPLACE FUNCTION public.attach_flats_by_phone(p_society_id UUID, p_uid UUID, p_phone TEXT)
RETURNS TABLE (society_id UUID, society_name TEXT, flat TEXT) AS $$
DECLARE
    v_unit RECORD;
BEGIN
    IF p_phone IS NULL OR p_uid IS NULL THEN
        RETURN;
    END IF;
    FOR v_unit IN
        SELECT u.id, u.society_id, u.unit_number, s.name FROM units u JOIN societies s ON s.id = u.society_id AND s.is_active
        WHERE (p_society_id IS NULL OR u.society_id = p_society_id)
          AND (u.owner_mobile = p_phone
               OR EXISTS (SELECT 1 FROM unit_ownerships o WHERE o.unit_id = u.id AND o.to_date IS NULL
                            AND o.owner_user_id IS NULL AND normalize_mobile(o.owner_mobile) = p_phone))
          -- already this user's flat: nothing to do
          AND NOT EXISTS (SELECT 1 FROM society_memberships m WHERE m.user_id = p_uid AND m.unit_id = u.id
                            AND m.role = 'resident_owner' AND m.is_active)
        ORDER BY s.name, u.unit_number
    LOOP
        PERFORM upsert_flat_membership(v_unit.society_id, p_uid, v_unit.id, 'resident_owner');
        PERFORM attach_flat_owner(v_unit.society_id, v_unit.id, p_uid, NULL);
        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (v_unit.society_id, p_uid, 'member.joined_by_mobile', 'unit', v_unit.id::text, jsonb_build_object('flat', v_unit.unit_number));
        society_id := v_unit.society_id;
        society_name := v_unit.name;
        flat := v_unit.unit_number;
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 029_owner_change.sql; + the owner steps live in attach_flat_owner (shared with the joining link)
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

    -- Ownership history (029 / 031): the waiting owner change, or the flat's first owner
    IF p_invite.unit_id IS NOT NULL AND p_invite.role = 'resident_owner' THEN
        PERFORM attach_flat_owner(p_invite.society_id, p_invite.unit_id, p_uid, p_invite.id);
    END IF;

    UPDATE member_invites
    SET status = 'accepted', accepted_user_id = p_uid, accepted_at = timezone('utc'::text, now())
    WHERE id = p_invite.id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_invite.society_id, p_uid, 'invite.accepted', 'member_invite', p_invite.id::text,
            jsonb_build_object('role', p_invite.role, 'unit_id', p_invite.unit_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 029_owner_change.sql; + the flat's owner contact follows the new owner
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
    IF position('@' IN v_email) < 2 THEN
        RAISE EXCEPTION 'Enter the new owner''s email — they join with it';
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
    UPDATE units SET owner_name = v_name, owner_mobile = normalize_mobile(p_new_owner_mobile) WHERE id = p_unit_id;

    IF v_waiting THEN
        IF v_has_prev THEN
            UPDATE unit_ownerships SET to_date = p_transfer_date - 1 WHERE id = v_prev.id;
        END IF;
        UPDATE member_invites SET status = 'revoked'
        WHERE society_id = v_unit.society_id AND unit_id = p_unit_id AND role = 'resident_owner' AND status = 'pending';
        INSERT INTO member_invites (society_id, email, full_name, role, unit_id, invited_by)
        VALUES (v_unit.society_id, v_email, v_name, 'resident_owner', p_unit_id, auth.uid())
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
-- 3. THE JOINING LINK AND JOIN REQUESTS
-- ============================================================================
ALTER TABLE societies ADD COLUMN IF NOT EXISTS join_code VARCHAR(16);
CREATE UNIQUE INDEX IF NOT EXISTS uq_societies_join_code ON societies (join_code) WHERE join_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS join_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    mobile TEXT,
    flat_hint TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    unit_id UUID REFERENCES units(id) ON DELETE SET NULL,
    role VARCHAR(32),
    decided_by UUID REFERENCES profiles(id),
    decided_at TIMESTAMPTZ,
    decision_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_join_requests_society ON join_requests (society_id, status, created_at);
ALTER TABLE join_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS join_requests_select ON join_requests;
CREATE POLICY join_requests_select ON join_requests
    FOR SELECT USING (user_id = auth.uid() OR is_platform_admin() OR is_committee_viewer(society_id));

CREATE OR REPLACE FUNCTION public.society_join_code(p_society_id UUID)
RETURNS TEXT AS $$
DECLARE
    v_code TEXT;
BEGIN
    IF NOT (is_platform_admin() OR is_committee_viewer(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can share the joining link';
    END IF;
    SELECT join_code INTO v_code FROM societies WHERE id = p_society_id;
    IF v_code IS NULL THEN
        v_code := encode(gen_random_bytes(6), 'hex');
        UPDATE societies SET join_code = v_code WHERE id = p_society_id;
    END IF;
    RETURN v_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.new_join_code(p_society_id UUID)
RETURNS TEXT AS $$
DECLARE
    v_code TEXT := encode(gen_random_bytes(6), 'hex');
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can change the joining link';
    END IF;
    UPDATE societies SET join_code = v_code WHERE id = p_society_id;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'society.join_link_changed', 'society', p_society_id::text, '{}'::jsonb);
    RETURN v_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.join_society(p_code TEXT, p_name TEXT, p_mobile TEXT, p_flat_hint TEXT)
RETURNS JSONB AS $$
DECLARE
    v_soc societies%ROWTYPE;
    v_flats TEXT[];
    v_name TEXT := trim(coalesce(p_name, ''));
    v_hint TEXT := nullif(trim(coalesce(p_flat_hint, '')), '');
    v_req UUID;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Log in first';
    END IF;
    SELECT * INTO v_soc FROM societies WHERE join_code = p_code AND is_active;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'This joining link has changed — ask your secretary for the new one';
    END IF;
    IF EXISTS (SELECT 1 FROM society_memberships WHERE society_id = v_soc.id AND user_id = auth.uid() AND is_active) THEN
        RAISE EXCEPTION 'You are already a member of %', v_soc.name;
    END IF;
    IF EXISTS (SELECT 1 FROM join_requests WHERE society_id = v_soc.id AND user_id = auth.uid() AND status = 'pending') THEN
        RETURN jsonb_build_object('status', 'requested', 'society_name', v_soc.name, 'flat', NULL);
    END IF;

    -- Only the login's own confirmed mobile attaches anyone (a typed number never does)
    SELECT array_agg(a.flat) INTO v_flats FROM attach_flats_by_phone(v_soc.id, auth.uid(), current_verified_phone()) a;
    IF cardinality(v_flats) > 0 THEN
        RETURN jsonb_build_object('status', 'joined', 'society_name', v_soc.name, 'flat', array_to_string(v_flats, ', '));
    END IF;

    IF (SELECT count(*) FROM join_requests WHERE society_id = v_soc.id AND created_at > timezone('utc'::text, now()) - interval '1 day') >= 30 THEN
        RAISE EXCEPTION 'Too many join requests today — ask your secretary';
    END IF;
    IF length(v_name) < 2 THEN
        RAISE EXCEPTION 'Enter your name';
    END IF;
    INSERT INTO join_requests (society_id, user_id, full_name, mobile, flat_hint)
    VALUES (v_soc.id, auth.uid(), v_name, coalesce(normalize_mobile(p_mobile), nullif(trim(coalesce(p_mobile, '')), '')), v_hint)
    RETURNING id INTO v_req;
    PERFORM notify_users(v_soc.id, committee_admin_ids(v_soc.id), 'join_request', 'Join request: ' || v_name,
        concat_ws(' · ', 'Flat ' || v_hint, nullif(trim(coalesce(p_mobile, '')), '')), 'approvals', v_req);
    RETURN jsonb_build_object('status', 'requested', 'society_name', v_soc.name, 'flat', v_hint);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.decide_join_request(
    p_request_id UUID, p_approve BOOLEAN, p_unit_id UUID DEFAULT NULL, p_role TEXT DEFAULT 'resident_owner', p_note TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_r join_requests%ROWTYPE;
    v_soc TEXT;
BEGIN
    SELECT * INTO v_r FROM join_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Request not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_r.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can decide join requests';
    END IF;
    IF v_r.status <> 'pending' THEN
        RAISE EXCEPTION 'This request is already %', v_r.status;
    END IF;
    SELECT name INTO v_soc FROM societies WHERE id = v_r.society_id;

    IF p_approve THEN
        IF p_unit_id IS NULL OR NOT EXISTS (SELECT 1 FROM units WHERE id = p_unit_id AND society_id = v_r.society_id) THEN
            RAISE EXCEPTION 'Choose the flat';
        END IF;
        IF coalesce(p_role, '') NOT IN ('resident_owner', 'resident_tenant') THEN
            RAISE EXCEPTION 'Role must be owner or tenant';
        END IF;
        PERFORM upsert_flat_membership(v_r.society_id, v_r.user_id, p_unit_id, p_role);
        IF p_role = 'resident_owner' THEN
            PERFORM attach_flat_owner(v_r.society_id, p_unit_id, v_r.user_id, NULL);
        ELSE
            UPDATE units SET current_tenant_id = v_r.user_id, occupancy_status = 'tenant_occupied',
                             updated_at = timezone('utc'::text, now())
            WHERE id = p_unit_id;
        END IF;
        UPDATE join_requests SET status = 'approved', unit_id = p_unit_id, role = p_role, decided_by = auth.uid(),
                                 decided_at = timezone('utc'::text, now()), decision_note = nullif(trim(coalesce(p_note, '')), '')
        WHERE id = p_request_id;
        PERFORM notify_users(NULL, ARRAY[v_r.user_id], 'join_result', 'You have joined ' || v_soc,
            'Flat ' || (SELECT unit_number FROM units WHERE id = p_unit_id), NULL, p_request_id);
    ELSE
        IF length(trim(coalesce(p_note, ''))) = 0 THEN
            RAISE EXCEPTION 'Give a reason for rejecting';
        END IF;
        UPDATE join_requests SET status = 'rejected', decided_by = auth.uid(), decided_at = timezone('utc'::text, now()),
                                 decision_note = trim(p_note)
        WHERE id = p_request_id;
        PERFORM notify_users(NULL, ARRAY[v_r.user_id], 'join_result', 'Your request to join ' || v_soc || ' was not approved',
            trim(p_note), NULL, p_request_id);
    END IF;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_r.society_id, auth.uid(), CASE WHEN p_approve THEN 'join.approved' ELSE 'join.rejected' END, 'join_request',
            p_request_id::text, jsonb_build_object('unit_id', p_unit_id, 'role', p_role));
    RETURN jsonb_build_object('status', CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.attach_flat_owner(UUID, UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_flat_membership(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.current_verified_phone() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attach_flats_by_phone(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_flat_owner_contacts(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.society_join_code(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.new_join_code(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.join_society(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decide_join_request(UUID, BOOLEAN, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_flat_owner_contacts(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.society_join_code(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.new_join_code(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_society(TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_join_request(UUID, BOOLEAN, UUID, TEXT, TEXT) TO authenticated;
