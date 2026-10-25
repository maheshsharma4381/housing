-- ============================================================================
-- SAHVAAS DEMO SEED
-- Creates "Palm Heights CHS (Demo)" with 32 flats, UPI settings, a maintenance
-- bill, notices, a pending expense and a complaint — owned by an existing user.
--
-- How to use (Supabase SQL Editor, after running all migrations):
--   1. Sign up in the app once and verify your email.
--   2. Replace the email on the line marked CHANGE ME.
--   3. Run this file. Sign in again: you land on /society as Secretary and
--      also own flat A-101 (open /resident to see the resident view).
-- ============================================================================
DO $$
DECLARE
    v_email TEXT := 'you@example.com';  -- CHANGE ME
    v_uid UUID;
    v_society UUID;
    v_units JSONB;
    v_unit_a101 UUID;
    v_cycle UUID;
    v_bill UUID;
    v_vendor UUID;
BEGIN
    SELECT id INTO v_uid FROM auth.users WHERE lower(email) = lower(v_email);
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'No auth user with email %. Sign up in the app first.', v_email;
    END IF;

    -- Act as that user so the onboarding RPCs apply their normal checks
    PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'email', v_email, 'role', 'authenticated')::text, true);

    v_society := public.create_society(
        'Palm Heights CHS (Demo)', 'Plot 12, Sector 19A', 'Navi Mumbai', 'Maharashtra', '400706',
        v_email, '+91 98200 00000', 'TNA/HSG/0000/DEMO', 'Nerul West', 'secretary'
    );

    UPDATE society_settings
    SET upi_id = 'palmheights.demo@icici', upi_payee_name = 'Palm Heights CHS Ltd (Demo)'
    WHERE society_id = v_society;

    -- Wings A & B, floors 1-4, 4 flats per floor
    SELECT jsonb_agg(jsonb_build_object(
        'building', 'Palm Heights',
        'wing', w,
        'floor', f,
        'unit_number', w || '-' || f || lpad(n::text, 2, '0'),
        'unit_type', CASE WHEN n IN (1, 4) THEN '3BHK' ELSE '2BHK' END,
        'carpet_area_sqft', CASE WHEN n IN (1, 4) THEN 980 ELSE 690 END,
        'occupancy_status', CASE WHEN (f + n) % 7 = 0 THEN 'vacant' WHEN (f * n) % 5 = 0 THEN 'tenant_occupied' ELSE 'owner_occupied' END
    ))
    INTO v_units
    FROM unnest(ARRAY['A', 'B']) AS w, generate_series(1, 4) AS f, generate_series(1, 4) AS n;

    PERFORM public.bulk_upsert_units(v_society, v_units);

    -- The seeding user also owns A-101 so the resident portal has data
    SELECT id INTO v_unit_a101 FROM units WHERE society_id = v_society AND unit_number = 'A-101';
    INSERT INTO society_memberships (society_id, user_id, role, unit_id)
    VALUES (v_society, v_uid, 'resident_owner', v_unit_a101);
    UPDATE units SET current_owner_id = v_uid WHERE id = v_unit_a101;

    -- One issued maintenance bill for A-101
    INSERT INTO billing_cycles (society_id, cycle_name, period_start, period_end, due_date, status)
    VALUES (v_society, to_char(date_trunc('month', current_date), 'Mon YYYY') || ' Maintenance',
            date_trunc('month', current_date)::date,
            (date_trunc('month', current_date) + interval '1 month - 1 day')::date,
            (date_trunc('month', current_date) + interval '9 days')::date,
            'published')
    RETURNING id INTO v_cycle;

    INSERT INTO bills (society_id, cycle_id, unit_id, user_id, bill_number, due_date,
                       subtotal_amount, total_amount, balance_due, status)
    VALUES (v_society, v_cycle, v_unit_a101, v_uid, 'PH-' || to_char(current_date, 'YYYYMM') || '-A101',
            (date_trunc('month', current_date) + interval '9 days')::date,
            3500, 3500, 3500, 'issued')
    RETURNING id INTO v_bill;

    INSERT INTO bill_items (bill_id, description, quantity, unit_rate, amount, total_item_amount) VALUES
        (v_bill, 'Maintenance charges', 1, 2800, 2800, 2800),
        (v_bill, 'Sinking fund', 1, 400, 400, 400),
        (v_bill, 'Repair fund', 1, 300, 300, 300);

    -- Notices
    INSERT INTO notices (society_id, title, content, category, is_pinned, published_by) VALUES
        (v_society, 'Water supply interruption on Sunday',
         'Overhead tank cleaning is scheduled for Sunday 10 AM - 2 PM. Please store water in advance.',
         'water_power', true, v_uid),
        (v_society, 'Annual General Meeting',
         'The AGM will be held in the clubhouse on the last Saturday of this month at 6 PM. Agenda: audited accounts, repair fund, parking policy.',
         'agm_egm', false, v_uid);

    -- A pending vendor expense
    INSERT INTO vendors (society_id, name, category, contact_person, phone, gstin)
    VALUES (v_society, 'SecureGuard Services (Demo)', 'security', 'Ramesh Patil', '+91 90000 00000', '27AAAAA0000A1Z5')
    RETURNING id INTO v_vendor;

    INSERT INTO expenses (society_id, vendor_id, expense_number, category, title, invoice_number, invoice_date,
                          subtotal, gst_amount, tds_amount, net_payable, status)
    VALUES (v_society, v_vendor, 'EXP-0001', 'security', 'Security guards - monthly contract', 'SG/2026/118', current_date,
            42000, 7560, 840, 48720, 'pending_approval');

    -- A resident complaint
    INSERT INTO complaints (society_id, unit_id, user_id, ticket_number, category, title, description, priority)
    VALUES (v_society, v_unit_a101, v_uid, 'TKT-0001', 'plumbing', 'Water leakage in bathroom',
            'Seepage from the ceiling of the common bathroom since last week.', 'high');

    RAISE NOTICE 'Demo society % created for %', v_society, v_email;
END $$;
