-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 005: Self-serve Onboarding
--   * create_society()      - any signed-in user can register a society and
--                             becomes its first committee member
--   * bulk_upsert_units()   - committee imports buildings / wings / flats (CSV)
--   * member_invites        - committee invites residents by email
--   * claim_my_invites()    - invitee turns pending invites into memberships
--                             once their email is verified
-- Safe to re-run.
-- ============================================================================

-- Floors need a natural key so imports can upsert them
CREATE UNIQUE INDEX IF NOT EXISTS uq_wing_floor ON floors(wing_id, floor_number);

-- ============================================================================
-- 1. MEMBER INVITES
-- ============================================================================
CREATE TABLE IF NOT EXISTS member_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    email VARCHAR(191) NOT NULL,
    full_name VARCHAR(191),
    role VARCHAR(32) NOT NULL DEFAULT 'resident_owner' CHECK (role IN (
        'society_admin',
        'secretary',
        'chairman',
        'treasurer',
        'committee_member',
        'resident_owner',
        'resident_tenant'
    )),
    unit_id UUID REFERENCES units(id) ON DELETE SET NULL,
    invited_by UUID NOT NULL REFERENCES profiles(id),
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
    accepted_user_id UUID REFERENCES profiles(id),
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- One pending invite per email per flat (or per society when no flat)
CREATE UNIQUE INDEX IF NOT EXISTS uq_member_invite_pending
    ON member_invites (society_id, lower(email), coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_member_invites_email_pending
    ON member_invites (lower(email)) WHERE status = 'pending';

ALTER TABLE member_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS member_invites_select ON member_invites;
DROP POLICY IF EXISTS member_invites_admin_insert ON member_invites;
DROP POLICY IF EXISTS member_invites_admin_update ON member_invites;
DROP POLICY IF EXISTS member_invites_admin_delete ON member_invites;

CREATE POLICY member_invites_select ON member_invites
    FOR SELECT USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR lower(email) = lower(auth.jwt() ->> 'email')
    );

CREATE POLICY member_invites_admin_insert ON member_invites
    FOR INSERT WITH CHECK (
        (is_platform_admin() OR is_society_admin(society_id))
        AND invited_by = auth.uid()
        AND status = 'pending'
        AND accepted_user_id IS NULL
        AND (
            unit_id IS NULL
            OR EXISTS (SELECT 1 FROM units u WHERE u.id = member_invites.unit_id AND u.society_id = member_invites.society_id)
        )
    );

CREATE POLICY member_invites_admin_update ON member_invites
    FOR UPDATE USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));

CREATE POLICY member_invites_admin_delete ON member_invites
    FOR DELETE USING (is_platform_admin() OR is_society_admin(society_id));

-- ============================================================================
-- 2. CREATE SOCIETY
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_society(
    p_name TEXT,
    p_address_line1 TEXT,
    p_city TEXT,
    p_state TEXT,
    p_pincode TEXT,
    p_contact_email TEXT,
    p_contact_phone TEXT,
    p_registration_number TEXT DEFAULT NULL,
    p_address_line2 TEXT DEFAULT NULL,
    p_creator_role TEXT DEFAULT 'secretary'
)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_society_id UUID;
    v_slug TEXT;
    v_recent INT;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'You must be signed in to register a society';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_uid) THEN
        RAISE EXCEPTION 'Profile not found for current user';
    END IF;
    IF length(trim(coalesce(p_name, ''))) < 3 THEN
        RAISE EXCEPTION 'Society name must be at least 3 characters';
    END IF;
    IF coalesce(p_pincode, '') !~ '^[0-9]{6}$' THEN
        RAISE EXCEPTION 'Pincode must be 6 digits';
    END IF;
    IF length(trim(coalesce(p_address_line1, ''))) = 0
       OR length(trim(coalesce(p_city, ''))) = 0
       OR length(trim(coalesce(p_state, ''))) = 0 THEN
        RAISE EXCEPTION 'Address, city and state are required';
    END IF;
    IF coalesce(p_contact_email, '') !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
        RAISE EXCEPTION 'A valid contact email is required';
    END IF;
    IF length(regexp_replace(coalesce(p_contact_phone, ''), '[^0-9]', '', 'g')) < 10 THEN
        RAISE EXCEPTION 'A valid 10-digit contact phone is required';
    END IF;
    IF p_creator_role NOT IN ('society_admin', 'secretary', 'chairman', 'treasurer') THEN
        RAISE EXCEPTION 'Creator role must be secretary, chairman, treasurer or society_admin';
    END IF;

    -- Basic abuse guard: max 3 new societies per user per day
    SELECT count(*) INTO v_recent
    FROM society_memberships
    WHERE user_id = v_uid AND created_at > now() - interval '1 day'
      AND role IN ('society_admin', 'secretary', 'chairman', 'treasurer')
      AND unit_id IS NULL;
    IF v_recent >= 3 AND NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Too many societies created today. Please contact support.';
    END IF;

    v_slug := trim(BOTH '-' FROM left(lower(regexp_replace(trim(p_name), '[^a-zA-Z0-9]+', '-', 'g')), 80));
    IF v_slug = '' THEN
        v_slug := 'society';
    END IF;
    IF EXISTS (SELECT 1 FROM societies WHERE slug = v_slug) THEN
        v_slug := v_slug || '-' || substr(md5(random()::text), 1, 6);
    END IF;

    INSERT INTO societies (
        name, slug, registration_number, address_line1, address_line2,
        city, state, pincode, contact_email, contact_phone
    ) VALUES (
        trim(p_name), v_slug, nullif(trim(p_registration_number), ''), trim(p_address_line1), nullif(trim(p_address_line2), ''),
        trim(p_city), trim(p_state), p_pincode, lower(trim(p_contact_email)), trim(p_contact_phone)
    )
    RETURNING id INTO v_society_id;

    INSERT INTO society_settings (society_id) VALUES (v_society_id);

    INSERT INTO society_memberships (society_id, user_id, role, is_primary_contact)
    VALUES (v_society_id, v_uid, p_creator_role, true);

    -- Default chart of accounts (used by the ledger engine in a later phase)
    INSERT INTO accounts (society_id, code, name, type, is_system) VALUES
        (v_society_id, '1000', 'Bank Accounts',               'asset',     true),
        (v_society_id, '1100', 'Cash in Hand',                'asset',     true),
        (v_society_id, '1200', 'Members Receivable',          'asset',     true),
        (v_society_id, '2000', 'Sundry Creditors',            'liability', true),
        (v_society_id, '2100', 'GST Payable',                 'liability', true),
        (v_society_id, '2200', 'TDS Payable',                 'liability', true),
        (v_society_id, '2300', 'Advance Maintenance Received','liability', true),
        (v_society_id, '3000', 'Sinking Fund',                'equity',    true),
        (v_society_id, '3100', 'Repair & Maintenance Fund',   'equity',    true),
        (v_society_id, '3200', 'General Reserve',             'equity',    true),
        (v_society_id, '4000', 'Maintenance Charges',         'income',    true),
        (v_society_id, '4100', 'Interest on Late Payment',    'income',    true),
        (v_society_id, '4200', 'Other Income',                'income',    true),
        (v_society_id, '5000', 'Repairs & Maintenance',       'expense',   true),
        (v_society_id, '5100', 'Security Charges',            'expense',   true),
        (v_society_id, '5200', 'Housekeeping',                'expense',   true),
        (v_society_id, '5300', 'Electricity (Common Areas)',  'expense',   true),
        (v_society_id, '5400', 'Water Charges',               'expense',   true),
        (v_society_id, '5900', 'Other Expenses',              'expense',   true);

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_society_id, v_uid, 'society.created', 'society', v_society_id::text,
            jsonb_build_object('name', trim(p_name), 'slug', v_slug));

    RETURN v_society_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. BULK UNIT IMPORT
--    p_units: [{ "building": "Tower A", "wing": "A", "floor": 1,
--                "unit_number": "A-101", "unit_type": "2BHK",
--                "carpet_area_sqft": 650, "occupancy_status": "owner_occupied" }]
-- ============================================================================
CREATE OR REPLACE FUNCTION public.bulk_upsert_units(p_society_id UUID, p_units JSONB)
RETURNS JSONB AS $$
DECLARE
    v_row JSONB;
    v_idx INT := 0;
    v_inserted INT := 0;
    v_updated INT := 0;
    v_building TEXT;
    v_wing TEXT;
    v_floor INT;
    v_unit_number TEXT;
    v_unit_type TEXT;
    v_area NUMERIC;
    v_occupancy TEXT;
    v_building_id UUID;
    v_wing_id UUID;
    v_floor_id UUID;
    v_was_insert BOOLEAN;
    v_total INT;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can import units';
    END IF;
    IF jsonb_typeof(p_units) <> 'array' THEN
        RAISE EXCEPTION 'Units payload must be a JSON array';
    END IF;
    IF jsonb_array_length(p_units) = 0 THEN
        RAISE EXCEPTION 'No units to import';
    END IF;
    IF jsonb_array_length(p_units) > 2000 THEN
        RAISE EXCEPTION 'Import at most 2000 units at a time';
    END IF;

    FOR v_row IN SELECT * FROM jsonb_array_elements(p_units) LOOP
        v_idx := v_idx + 1;

        v_building    := coalesce(nullif(trim(v_row ->> 'building'), ''), 'Main');
        v_wing        := coalesce(nullif(trim(v_row ->> 'wing'), ''), 'A');
        v_unit_number := nullif(trim(v_row ->> 'unit_number'), '');
        v_unit_type   := coalesce(nullif(trim(v_row ->> 'unit_type'), ''), '2BHK');
        v_occupancy   := coalesce(nullif(trim(v_row ->> 'occupancy_status'), ''), 'owner_occupied');

        IF v_unit_number IS NULL THEN
            RAISE EXCEPTION 'Row %: unit_number is required', v_idx;
        END IF;
        IF length(v_unit_number) > 32 OR length(v_wing) > 32 OR length(v_building) > 96 OR length(v_unit_type) > 32 THEN
            RAISE EXCEPTION 'Row %: a value is too long', v_idx;
        END IF;
        IF v_occupancy NOT IN ('owner_occupied', 'tenant_occupied', 'vacant', 'under_renovation') THEN
            RAISE EXCEPTION 'Row %: occupancy_status "%" is invalid', v_idx, v_occupancy;
        END IF;

        BEGIN
            v_floor := nullif(trim(v_row ->> 'floor'), '')::INT;
            v_area  := coalesce(nullif(trim(v_row ->> 'carpet_area_sqft'), '')::NUMERIC, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            RAISE EXCEPTION 'Row %: floor and carpet_area_sqft must be numbers', v_idx;
        END;
        IF v_area < 0 OR v_area > 999999 THEN
            RAISE EXCEPTION 'Row %: carpet_area_sqft is out of range', v_idx;
        END IF;

        INSERT INTO buildings (society_id, name, code, total_floors)
        VALUES (p_society_id, v_building, upper(left(regexp_replace(v_building, '\s+', '', 'g'), 32)), greatest(coalesce(v_floor, 0), 1))
        ON CONFLICT (society_id, code) DO UPDATE
            SET total_floors = greatest(buildings.total_floors, EXCLUDED.total_floors)
        RETURNING id INTO v_building_id;

        INSERT INTO wings (society_id, building_id, name)
        VALUES (p_society_id, v_building_id, v_wing)
        ON CONFLICT (building_id, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id INTO v_wing_id;

        v_floor_id := NULL;
        IF v_floor IS NOT NULL THEN
            INSERT INTO floors (society_id, wing_id, floor_number)
            VALUES (p_society_id, v_wing_id, v_floor)
            ON CONFLICT (wing_id, floor_number) DO UPDATE SET floor_number = EXCLUDED.floor_number
            RETURNING id INTO v_floor_id;
        END IF;

        INSERT INTO units (
            society_id, building_id, wing_id, floor_id, unit_number,
            unit_type, carpet_area_sqft, occupancy_status
        ) VALUES (
            p_society_id, v_building_id, v_wing_id, v_floor_id, v_unit_number,
            v_unit_type, v_area, v_occupancy
        )
        ON CONFLICT (society_id, wing_id, unit_number) DO UPDATE SET
            building_id = EXCLUDED.building_id,
            floor_id = EXCLUDED.floor_id,
            unit_type = EXCLUDED.unit_type,
            carpet_area_sqft = EXCLUDED.carpet_area_sqft,
            occupancy_status = EXCLUDED.occupancy_status,
            updated_at = timezone('utc'::text, now())
        RETURNING (xmax = 0) INTO v_was_insert;

        IF v_was_insert THEN
            v_inserted := v_inserted + 1;
        ELSE
            v_updated := v_updated + 1;
        END IF;
    END LOOP;

    SELECT count(*) INTO v_total FROM units WHERE society_id = p_society_id;
    UPDATE societies SET total_units = v_total, updated_at = timezone('utc'::text, now())
    WHERE id = p_society_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'units.imported', 'society', p_society_id::text,
            jsonb_build_object('inserted', v_inserted, 'updated', v_updated));

    RETURN jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'total_units', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 4. CLAIM INVITES
--    Only verified emails can claim, so nobody can sign up with someone
--    else's address and take over their flat.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.claim_my_invites()
RETURNS INT AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_email TEXT;
    v_confirmed TIMESTAMPTZ;
    v_invite member_invites%ROWTYPE;
    v_count INT := 0;
BEGIN
    IF v_uid IS NULL THEN
        RETURN 0;
    END IF;

    SELECT email, email_confirmed_at INTO v_email, v_confirmed
    FROM auth.users WHERE id = v_uid;

    IF v_email IS NULL OR v_confirmed IS NULL THEN
        RETURN 0;
    END IF;

    FOR v_invite IN
        SELECT mi.* FROM member_invites mi
        JOIN societies s ON s.id = mi.society_id AND s.is_active = true
        WHERE mi.status = 'pending' AND lower(mi.email) = lower(v_email)
        FOR UPDATE OF mi
    LOOP
        IF EXISTS (
            SELECT 1 FROM society_memberships
            WHERE society_id = v_invite.society_id
              AND user_id = v_uid
              AND unit_id IS NOT DISTINCT FROM v_invite.unit_id
        ) THEN
            UPDATE society_memberships
            SET role = v_invite.role, is_active = true, updated_at = timezone('utc'::text, now())
            WHERE society_id = v_invite.society_id
              AND user_id = v_uid
              AND unit_id IS NOT DISTINCT FROM v_invite.unit_id;
        ELSE
            INSERT INTO society_memberships (society_id, user_id, role, unit_id)
            VALUES (v_invite.society_id, v_uid, v_invite.role, v_invite.unit_id);
        END IF;

        IF v_invite.unit_id IS NOT NULL THEN
            IF v_invite.role = 'resident_owner' THEN
                UPDATE units SET current_owner_id = v_uid, updated_at = timezone('utc'::text, now())
                WHERE id = v_invite.unit_id;
            ELSIF v_invite.role = 'resident_tenant' THEN
                UPDATE units SET current_tenant_id = v_uid, occupancy_status = 'tenant_occupied',
                                 updated_at = timezone('utc'::text, now())
                WHERE id = v_invite.unit_id;
            END IF;
        END IF;

        UPDATE member_invites
        SET status = 'accepted', accepted_user_id = v_uid, accepted_at = timezone('utc'::text, now())
        WHERE id = v_invite.id;

        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (v_invite.society_id, v_uid, 'invite.accepted', 'member_invite', v_invite.id::text,
                jsonb_build_object('role', v_invite.role, 'unit_id', v_invite.unit_id));

        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. FUNCTION PRIVILEGES: signed-in users only
-- ============================================================================
REVOKE ALL ON FUNCTION public.create_society(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bulk_upsert_units(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.claim_my_invites() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_society(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_upsert_units(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_my_invites() TO authenticated;
