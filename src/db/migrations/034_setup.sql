-- ============================================================================
-- 034 SETUP IN SIX SHORT STEPS (Phase 4B)
--   Society (short form) → Flats → Maintenance → UPI → Owners → Done (first bills).
--   Every step is recorded for the platform owner's setup funnel (spec 11 item 2).
-- ============================================================================

CREATE TABLE IF NOT EXISTS setup_events (
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    step VARCHAR(32) NOT NULL,
    user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    PRIMARY KEY (society_id, step)
);
ALTER TABLE setup_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS setup_events_select ON setup_events;
CREATE POLICY setup_events_select ON setup_events FOR SELECT USING (is_platform_admin() OR is_committee_viewer(society_id));
REVOKE INSERT, UPDATE, DELETE ON setup_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_setup_step(p_society_id UUID, p_step TEXT)
RETURNS VOID AS $$
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can set up the society';
    END IF;
    IF p_step NOT IN ('society', 'flats', 'maintenance', 'upi', 'upi_skipped', 'owners', 'owners_skipped', 'first_bill') THEN
        RAISE EXCEPTION 'Unknown setup step %', p_step;
    END IF;
    INSERT INTO setup_events (society_id, step, user_id) VALUES (p_society_id, p_step, auth.uid())
    ON CONFLICT (society_id, step) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 005_onboarding.sql; + the short form (city, state, pincode, role), and the first setup step recorded
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
    -- The short form (034): address and contact details come later, in the Society profile
    IF length(trim(coalesce(p_city, ''))) = 0 OR length(trim(coalesce(p_state, ''))) = 0 THEN
        RAISE EXCEPTION 'City and state are required';
    END IF;
    IF length(trim(coalesce(p_contact_email, ''))) > 0 AND p_contact_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
        RAISE EXCEPTION 'A valid contact email is required';
    END IF;
    IF length(trim(coalesce(p_contact_phone, ''))) > 0 AND length(regexp_replace(p_contact_phone, '[^0-9]', '', 'g')) < 10 THEN
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
        trim(p_name), v_slug, nullif(trim(p_registration_number), ''), trim(coalesce(p_address_line1, '')), nullif(trim(p_address_line2), ''),
        trim(p_city), trim(p_state), p_pincode, lower(trim(coalesce(p_contact_email, ''))), trim(coalesce(p_contact_phone, ''))
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
    INSERT INTO setup_events (society_id, step, user_id) VALUES (v_society_id, 'society', v_uid) ON CONFLICT DO NOTHING;

    RETURN v_society_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- MAINTENANCE IN ONE SCREEN
-- ============================================================================
ALTER TABLE billing_rules ADD COLUMN IF NOT EXISTS setup_key VARCHAR(16);
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_rules_setup_key ON billing_rules (society_id, setup_key) WHERE setup_key IS NOT NULL;

-- One setup charge: created once, then updated (never duplicated); is_active follows the toggle
CREATE OR REPLACE FUNCTION public.put_setup_rule(p_society_id UUID, p_key TEXT, p_name TEXT, p_code TEXT, p_type TEXT,
                                                 p_rate NUMERIC, p_selected BOOLEAN, p_active BOOLEAN)
RETURNS VOID AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM billing_rules WHERE society_id = p_society_id AND setup_key = p_key) THEN
        UPDATE billing_rules SET calculation_type = p_type, rate = CASE WHEN p_active THEN p_rate ELSE rate END,
                                 is_active = p_active, applies_to_selected = p_selected
        WHERE society_id = p_society_id AND setup_key = p_key;
    ELSIF p_active THEN
        INSERT INTO billing_rules (society_id, name, calculation_type, rate, account_code, applies_to_selected, setup_key)
        VALUES (p_society_id, p_name, p_type, p_rate, p_code, p_selected, p_key);
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.setup_maintenance(
    p_society_id UUID, p_mode TEXT, p_rate NUMERIC, p_extras JSONB, p_due_day INT, p_first INT, p_every INT
)
RETURNS INT AS $$
DECLARE
    v_amount NUMERIC;
    v_extra RECORD;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can set up maintenance';
    END IF;
    IF coalesce(p_rate, 0) <= 0 THEN
        RAISE EXCEPTION 'Enter the maintenance amount';
    END IF;
    IF p_mode NOT IN ('flat', 'sqft') THEN
        RAISE EXCEPTION 'Choose "Same for all" or "Per sq.ft"';
    END IF;
    IF coalesce(p_due_day, 0) NOT BETWEEN 1 AND 28 THEN
        RAISE EXCEPTION 'Due day must be between 1 and 28';
    END IF;

    PERFORM put_setup_rule(p_society_id, 'maintenance', 'Maintenance', '4000',
                           CASE p_mode WHEN 'sqft' THEN 'per_sqft' ELSE 'flat_per_unit' END, p_rate, false, true);
    FOR v_extra IN
        SELECT k.key, k.name, k.code, k.selected,
               (SELECT (e ->> 'amount')::numeric FROM jsonb_array_elements(coalesce(p_extras, '[]'::jsonb)) e WHERE e ->> 'key' = k.key LIMIT 1) AS amount
        FROM (VALUES ('sinking', 'Sinking Fund', '3000', false),
                     ('repair', 'Repair Fund', '3100', false),
                     -- parking applies only to the flats the secretary picks later (033)
                     ('parking', 'Parking', '4200', true)) AS k(key, name, code, selected)
    LOOP
        v_amount := v_extra.amount;
        PERFORM put_setup_rule(p_society_id, v_extra.key, v_extra.name, v_extra.code, 'flat_per_unit',
                               coalesce(v_amount, 0), v_extra.selected, coalesce(v_amount, 0) > 0);
    END LOOP;

    UPDATE society_settings SET due_day_of_month = p_due_day, updated_at = timezone('utc'::text, now()) WHERE society_id = p_society_id;
    PERFORM set_reminder_schedule(p_society_id, p_first, p_every);
    PERFORM record_setup_step(p_society_id, 'maintenance');
    RETURN (SELECT count(*) FROM billing_rules WHERE society_id = p_society_id AND setup_key IS NOT NULL AND is_active);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Per-sq.ft areas: only the area changes (bulk_upsert_units would reset building, floor, type and occupancy)
CREATE OR REPLACE FUNCTION public.set_unit_areas(p_society_id UUID, p_rows JSONB)
RETURNS INT AS $$
DECLARE
    v_count INT;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can change flats';
    END IF;
    UPDATE units u SET carpet_area_sqft = (r ->> 'carpet_area_sqft')::numeric, updated_at = timezone('utc'::text, now())
    FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
    WHERE u.society_id = p_society_id AND u.id::text = r ->> 'unit_id' AND (r ->> 'carpet_area_sqft')::numeric > 0;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- WHERE THE SETUP STANDS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.setup_status(p_society_id UUID)
RETURNS JSONB AS $$
BEGIN
    IF NOT (is_platform_admin() OR is_committee_viewer(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can see the setup';
    END IF;
    RETURN jsonb_build_object(
        'steps', coalesce((SELECT jsonb_agg(step ORDER BY created_at) FROM setup_events WHERE society_id = p_society_id), '[]'::jsonb),
        'flats', (SELECT count(*) FROM units WHERE society_id = p_society_id),
        'rules', (SELECT count(*) FROM billing_rules WHERE society_id = p_society_id AND is_active),
        'upi', coalesce((SELECT length(trim(coalesce(upi_id, ''))) > 0 FROM society_settings WHERE society_id = p_society_id), false),
        'owners_entered', (SELECT count(*) FROM unit_owner_contacts WHERE society_id = p_society_id AND owner_mobile IS NOT NULL),
        'bills', (SELECT count(*) FROM bills WHERE society_id = p_society_id AND status <> 'cancelled'),
        'joined_owners', (SELECT count(DISTINCT unit_id) FROM society_memberships
                          WHERE society_id = p_society_id AND role = 'resident_owner' AND is_active AND unit_id IS NOT NULL)
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.put_setup_rule(UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, BOOLEAN, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_setup_step(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.setup_maintenance(UUID, TEXT, NUMERIC, JSONB, INT, INT, INT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.setup_status(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_setup_step(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.set_unit_areas(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_unit_areas(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.setup_maintenance(UUID, TEXT, NUMERIC, JSONB, INT, INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.setup_status(UUID) TO authenticated;
