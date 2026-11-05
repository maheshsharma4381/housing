-- ============================================================================
-- 038: Loose ends (Phase 9)
--   1. Mobiles typed with a 0 after the country code (+91 0 98765 43210)
--   2. Waiting join requests and owner invites close once the person has joined
--   3. Bills name the bank the CA receives into
--   4. A deactivated society sends no notifications
-- ============================================================================

-- ============================================================================
-- 1. MOBILES WITH A 0 AFTER +91
-- ============================================================================
-- from 032_mobile_login.sql; + "+91 0 98765 43210" / "0091 098765 43210": the trunk 0 after 91 is dropped
CREATE OR REPLACE FUNCTION public.normalize_mobile(p TEXT)
RETURNS TEXT AS $$
    SELECT CASE
        WHEN d IS NULL THEN NULL
        WHEN intl AND d ~ '^910[0-9]{10}$' THEN '91' || substr(d, 4)
        WHEN intl THEN CASE WHEN length(d) BETWEEN 8 AND 15 THEN d END
        WHEN length(d) < 10 THEN NULL
        WHEN length(d) = 10 THEN '91' || d
        WHEN length(d) = 11 AND left(d, 1) = '0' THEN '91' || substr(d, 2)
        ELSE d
    END
    FROM (SELECT ltrim(coalesce(p, '')) ~ '^(\+|00)' AS intl,
                 nullif(regexp_replace(regexp_replace(ltrim(coalesce(p, '')), '^00', ''), '[^0-9]', '', 'g'), '') AS d) x
$$ LANGUAGE sql IMMUTABLE;

-- Numbers already saved by the old rule (13 digits: 91, 0, then the mobile)
UPDATE unit_owner_contacts SET owner_mobile = '91' || substr(owner_mobile, 4) WHERE owner_mobile ~ '^910[0-9]{10}$';
UPDATE unit_ownerships SET owner_mobile = '91' || substr(owner_mobile, 4) WHERE owner_mobile ~ '^910[0-9]{10}$';
UPDATE join_requests SET mobile = '91' || substr(mobile, 4) WHERE mobile ~ '^910[0-9]{10}$';

-- The pending-invite index is built on normalize_mobile: two invites that now name the same mobile
-- for the same flat keep only the newest, then the index is rebuilt with the new rule
UPDATE member_invites mi SET status = 'revoked'
WHERE mi.status = 'pending' AND mi.mobile IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM member_invites o
      WHERE o.status = 'pending' AND o.mobile IS NOT NULL AND o.society_id = mi.society_id
        AND normalize_mobile(o.mobile) = normalize_mobile(mi.mobile)
        AND coalesce(o.unit_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(mi.unit_id, '00000000-0000-0000-0000-000000000000'::uuid)
        AND (o.created_at, o.id) > (mi.created_at, mi.id));
REINDEX INDEX uq_member_invite_pending_mobile;

-- ============================================================================
-- 2. WAITING REQUESTS AND OWNER INVITES CLOSE ONCE THE PERSON HAS JOINED
-- ============================================================================
-- Any active membership in a society (an invite, a phone match, the committee) answers that person's
-- waiting join request there: it is marked approved, so nobody decides it again later
CREATE OR REPLACE FUNCTION public.trg_membership_closes_requests()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE join_requests
    SET status = 'approved', unit_id = coalesce(unit_id, NEW.unit_id), role = coalesce(role, NEW.role),
        decided_at = timezone('utc'::text, now())
    WHERE society_id = NEW.society_id AND user_id = NEW.user_id AND status = 'pending';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_membership_closes_requests ON society_memberships;
CREATE TRIGGER trg_membership_closes_requests
    AFTER INSERT OR UPDATE OF is_active ON society_memberships
    FOR EACH ROW WHEN (NEW.is_active) EXECUTE FUNCTION public.trg_membership_closes_requests();
REVOKE ALL ON FUNCTION public.trg_membership_closes_requests() FROM PUBLIC, anon, authenticated;

-- from 033_flat_bills.sql; + the person's own owner invites for the flat are accepted, and a waiting
-- owner change's invite to someone else is revoked (038)
CREATE OR REPLACE FUNCTION public.attach_flat_owner(p_society_id UUID, p_unit_id UUID, p_uid UUID, p_invite_id UUID DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
    v_waiting_since TIMESTAMPTZ;
    v_claimed INT;
    v_due NUMERIC;
    v_change_invite UUID;
    v_email TEXT;
    v_phone TEXT;
BEGIN
    -- A mobile login starts as "Member": take the name the committee typed for the flat (032)
    UPDATE profiles p SET full_name = c.owner_name, updated_at = timezone('utc'::text, now())
    FROM unit_owner_contacts c
    WHERE p.id = p_uid AND p.full_name = 'Member' AND c.unit_id = p_unit_id AND nullif(trim(c.owner_name), '') IS NOT NULL;
    UPDATE units SET current_owner_id = p_uid, updated_at = timezone('utc'::text, now()) WHERE id = p_unit_id;
    -- the invite of an owner change still waiting on this flat (038)
    SELECT invite_id INTO v_change_invite FROM unit_ownerships
    WHERE unit_id = p_unit_id AND to_date IS NULL AND owner_user_id IS NULL;
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
        SELECT p_society_id, p_unit_id, p_uid, coalesce(nullif(p.full_name, 'Member'), c.owner_name, p.email, 'Owner'), p.email, c.owner_mobile, current_date
        FROM units u LEFT JOIN profiles p ON p.id = p_uid LEFT JOIN unit_owner_contacts c ON c.unit_id = u.id
        WHERE u.id = p_unit_id;
    END IF;
    -- Bills belong to the flat (033): the owner who joins takes the ones nobody holds yet, with one notification
    WITH claimed AS (
        UPDATE bills SET user_id = p_uid, updated_at = timezone('utc'::text, now())
        WHERE unit_id = p_unit_id AND user_id IS NULL
        RETURNING balance_due, status
    )
    SELECT count(*) FILTER (WHERE balance_due > 0 AND status IN ('issued', 'partially_paid', 'overdue')),
           coalesce(sum(balance_due) FILTER (WHERE status IN ('issued', 'partially_paid', 'overdue')), 0)
    INTO v_claimed, v_due FROM claimed;
    -- money received for the flat before anyone joined is theirs too
    UPDATE payments SET user_id = p_uid WHERE unit_id = p_unit_id AND user_id IS NULL;
    -- Invites that named this person as the flat's owner are settled by their joining (038).
    -- An invite to someone else for the same flat (a joint owner) stays for the committee.
    SELECT CASE WHEN email_confirmed_at IS NOT NULL THEN nullif(lower(email), '') END,
           CASE WHEN phone_confirmed_at IS NOT NULL THEN
               (SELECT CASE WHEN length(d) BETWEEN 8 AND 15 THEN d END
                FROM (SELECT nullif(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), '') AS d) x) END
    INTO v_email, v_phone FROM auth.users WHERE id = p_uid;
    UPDATE member_invites
    SET status = 'accepted', accepted_user_id = p_uid, accepted_at = timezone('utc'::text, now())
    WHERE society_id = p_society_id AND unit_id = p_unit_id AND role = 'resident_owner' AND status = 'pending'
      AND id IS DISTINCT FROM p_invite_id
      AND ((v_email IS NOT NULL AND lower(email) = v_email) OR (v_phone IS NOT NULL AND normalize_mobile(mobile) = v_phone));
    -- the owner change is complete with whoever joined: its invite to another person is not needed any more
    UPDATE member_invites SET status = 'revoked'
    WHERE id = v_change_invite AND status = 'pending' AND id IS DISTINCT FROM p_invite_id;
    IF v_claimed > 0 THEN
        PERFORM notify_users(p_society_id, ARRAY[p_uid], 'bill',
            'Bills for Flat ' || (SELECT unit_number FROM units WHERE id = p_unit_id),
            v_claimed || CASE WHEN v_claimed = 1 THEN ' bill' ELSE ' bills' END || ' · ' || inr_text(v_due) || ' due',
            'bills', p_unit_id);
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 031_joining_link.sql; + the phone match runs before the "already waiting" answer (038)
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
    -- Only the login's own confirmed mobile attaches anyone (a typed number never does).
    -- It runs before "already waiting": a mobile saved on a flat later still joins it (038)
    SELECT array_agg(a.flat) INTO v_flats FROM attach_flats_by_phone(v_soc.id, auth.uid(), current_verified_phone()) a;
    IF cardinality(v_flats) > 0 THEN
        RETURN jsonb_build_object('status', 'joined', 'society_name', v_soc.name, 'flat', array_to_string(v_flats, ', '));
    END IF;

    IF EXISTS (SELECT 1 FROM join_requests WHERE society_id = v_soc.id AND user_id = auth.uid() AND status = 'pending') THEN
        RETURN jsonb_build_object('status', 'requested', 'society_name', v_soc.name, 'flat', NULL);
    END IF;

    -- Requests the committee has not decided yet: at most 30, or 2 per flat in a bigger society
    IF (SELECT count(*) FROM join_requests WHERE society_id = v_soc.id AND status = 'pending')
       >= greatest(30, 2 * (SELECT count(*) FROM units WHERE society_id = v_soc.id)) THEN
        RAISE EXCEPTION 'Too many join requests waiting — ask your secretary';
    END IF;
    IF length(v_name) < 2 THEN
        RAISE EXCEPTION 'Enter your name';
    END IF;
    INSERT INTO join_requests (society_id, user_id, full_name, mobile, flat_hint)
    VALUES (v_soc.id, auth.uid(), v_name, coalesce(normalize_mobile(p_mobile), nullif(trim(coalesce(p_mobile, '')), '')), v_hint)
    ON CONFLICT (society_id, user_id) WHERE status = 'pending' DO NOTHING
    RETURNING id INTO v_req;
    IF v_req IS NULL THEN
        -- the same person asked twice at once: one request is enough
        RETURN jsonb_build_object('status', 'requested', 'society_name', v_soc.name, 'flat', v_hint);
    END IF;
    PERFORM notify_users(v_soc.id, committee_admin_ids(v_soc.id), 'join_request', 'Join request: ' || v_name,
        concat_ws(' · ', 'Flat ' || v_hint, nullif(trim(coalesce(p_mobile, '')), '')), 'approvals', v_req);
    RETURN jsonb_build_object('status', 'requested', 'society_name', v_soc.name, 'flat', v_hint);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.attach_flat_owner(UUID, UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.join_society(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_society(TEXT, TEXT, TEXT, TEXT) TO authenticated;
