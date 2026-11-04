-- ============================================================================
-- 026 OPENING BALANCE IN THE CA LOGIN (Phase 2C)
--   The CA enters the last audited balance sheet (31 March) exactly as it is, a
--   catch-up entry for the months up to go-live, and each flat's dues or advance
--   (and optionally each vendor's payable) on the go-live date. The committee
--   approves it; only then does it reach the books.
--   Lines: debit positive, credit negative.
--     audited_lines  [{code, amount, side: 'liabilities'|'assets', label?}]
--     catchup_lines  [{code, amount}]
--     flat_lines     [{unit_id, amount}]   dues positive, advance negative
--     vendor_lines   [{vendor_id, amount}] payable, positive
-- ============================================================================

-- ============================================================================
-- 1. DRAFT STORAGE
-- ============================================================================
CREATE TABLE IF NOT EXISTS opening_balances (
    society_id UUID PRIMARY KEY REFERENCES societies(id) ON DELETE CASCADE,
    audited_as_of DATE NOT NULL CHECK (extract(month FROM audited_as_of) = 3 AND extract(day FROM audited_as_of) = 31),
    live_on DATE NOT NULL,
    audited_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    catchup_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    flat_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    vendor_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved')),
    decision_note TEXT,
    prepared_by UUID REFERENCES profiles(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    submitted_by UUID REFERENCES profiles(id),
    submitted_at TIMESTAMPTZ,
    decided_by UUID REFERENCES profiles(id),
    decided_at TIMESTAMPTZ
);
ALTER TABLE opening_balances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS opening_balances_select ON opening_balances;
CREATE POLICY opening_balances_select ON opening_balances
    FOR SELECT USING (can_view_financials(society_id) OR can_manage_accounts(society_id));

-- '₹1,50,000.00' for messages
CREATE OR REPLACE FUNCTION public.money_text(p NUMERIC)
RETURNS TEXT AS $$
    SELECT '₹' || to_char(abs(round(coalesce(p, 0), 2)), 'FM99,99,99,99,990.00')
$$ LANGUAGE sql STABLE;

-- Sum of a line list, optionally for one ledger code
CREATE OR REPLACE FUNCTION public.opening_lines_sum(p_lines JSONB, p_code TEXT DEFAULT NULL)
RETURNS NUMERIC AS $$
    SELECT coalesce(sum((x ->> 'amount')::numeric), 0)
    FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x
    WHERE p_code IS NULL OR x ->> 'code' = p_code
$$ LANGUAGE sql IMMUTABLE;

-- The flat's owner: the earliest active owner membership, else units.current_owner_id
CREATE OR REPLACE FUNCTION public.opening_unit_owner(p_unit_id UUID)
RETURNS UUID AS $$
    SELECT coalesce(
        (SELECT m.user_id FROM society_memberships m JOIN units u ON u.id = m.unit_id
         WHERE u.id = p_unit_id AND m.society_id = u.society_id AND m.role = 'resident_owner' AND m.is_active = true
         ORDER BY m.created_at LIMIT 1),
        (SELECT current_owner_id FROM units WHERE id = p_unit_id))
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 2. READ: the draft, its checks, and every flat and vendor
-- ============================================================================
CREATE OR REPLACE FUNCTION public.opening_balance(p_society_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_ob opening_balances%ROWTYPE;
    v_status TEXT;
    v_both JSONB;
    v_flats JSONB;
    v_vendors JSONB;
BEGIN
    IF NOT (can_view_financials(p_society_id) OR can_manage_accounts(p_society_id)) THEN
        RAISE EXCEPTION 'You do not have access to this society''s accounts';
    END IF;

    SELECT * INTO v_ob FROM opening_balances WHERE society_id = p_society_id;
    IF FOUND THEN
        v_status := v_ob.status;
    ELSE
        v_status := 'none';
        v_ob.audited_lines := '[]'::jsonb;
        v_ob.catchup_lines := '[]'::jsonb;
        v_ob.flat_lines := '[]'::jsonb;
        v_ob.vendor_lines := '[]'::jsonb;
    END IF;
    v_both := v_ob.audited_lines || v_ob.catchup_lines;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'unit_id', u.id,
               'name', party_name(p_society_id, 'flat', u.id::text),
               'owner_name', (SELECT coalesce(p.full_name, p.email) FROM profiles p WHERE p.id = opening_unit_owner(u.id))
           ) ORDER BY w.name, u.unit_number), '[]'::jsonb)
    INTO v_flats
    FROM units u JOIN wings w ON w.id = u.wing_id
    WHERE u.society_id = p_society_id;

    SELECT coalesce(jsonb_agg(jsonb_build_object('vendor_id', v.id, 'name', party_name(p_society_id, 'vendor', v.id::text))
           ORDER BY v.name), '[]'::jsonb)
    INTO v_vendors
    FROM vendors v
    WHERE v.society_id = p_society_id;

    RETURN jsonb_build_object(
        'status', v_status,
        'audited_as_of', v_ob.audited_as_of,
        'live_on', v_ob.live_on,
        'audited_lines', v_ob.audited_lines,
        'catchup_lines', v_ob.catchup_lines,
        'flat_lines', v_ob.flat_lines,
        'vendor_lines', v_ob.vendor_lines,
        'decision_note', v_ob.decision_note,
        'prepared_by_name', (SELECT full_name FROM profiles WHERE id = v_ob.prepared_by),
        'submitted_by_name', (SELECT full_name FROM profiles WHERE id = v_ob.submitted_by),
        'submitted_at', v_ob.submitted_at,
        'decided_at', v_ob.decided_at,
        'checks', jsonb_build_object(
            'audited_difference', opening_lines_sum(v_ob.audited_lines),
            'catchup_difference', opening_lines_sum(v_ob.catchup_lines),
            'dues_expected', opening_lines_sum(v_both, '1200'),
            'dues_entered', (SELECT coalesce(sum((x ->> 'amount')::numeric), 0)
                             FROM jsonb_array_elements(v_ob.flat_lines) x WHERE (x ->> 'amount')::numeric > 0),
            'advance_expected', -opening_lines_sum(v_both, '2300'),
            'advance_entered', -(SELECT coalesce(sum((x ->> 'amount')::numeric), 0)
                                 FROM jsonb_array_elements(v_ob.flat_lines) x WHERE (x ->> 'amount')::numeric < 0),
            'creditors_expected', -opening_lines_sum(v_both, '2000'),
            'vendors_entered', opening_lines_sum(v_ob.vendor_lines)
        ),
        'flats', v_flats,
        'vendors', v_vendors
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. SAVE A DRAFT (the CA; any time before it is submitted)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.save_opening_balance(
    p_society_id UUID,
    p_audited_as_of DATE,
    p_live_on DATE,
    p_audited_lines JSONB,
    p_catchup_lines JSONB,
    p_flat_lines JSONB,
    p_vendor_lines JSONB
)
RETURNS JSONB AS $$
DECLARE
    v_status TEXT;
    v_line JSONB;
    v_code TEXT;
    v_type TEXT;
    v_amount NUMERIC;
    v_side TEXT;
    v_key TEXT;
    v_seen TEXT[] := '{}';
    v_audited JSONB := '[]'::jsonb;
    v_catchup JSONB := '[]'::jsonb;
    v_flats JSONB := '[]'::jsonb;
    v_vendors JSONB := '[]'::jsonb;
BEGIN
    IF NOT can_manage_accounts(p_society_id) THEN
        RAISE EXCEPTION 'Only the society''s CA or accountant can prepare the opening balance';
    END IF;
    SELECT status INTO v_status FROM opening_balances WHERE society_id = p_society_id FOR UPDATE;
    IF v_status = 'submitted' THEN
        RAISE EXCEPTION 'The opening balance is waiting for the committee — withdraw it to make changes';
    ELSIF v_status = 'approved' THEN
        RAISE EXCEPTION 'The opening balance is already approved — correct it with an adjustment';
    END IF;
    IF EXISTS (SELECT 1 FROM journal_entries WHERE society_id = p_society_id AND reference_event_type = 'opening.balance') THEN
        RAISE EXCEPTION 'Opening balances are already in the books for this society';
    END IF;
    IF p_audited_as_of IS NULL OR extract(month FROM p_audited_as_of) <> 3 OR extract(day FROM p_audited_as_of) <> 31 THEN
        RAISE EXCEPTION 'The audited balance sheet date must be a 31 March';
    END IF;
    IF p_live_on IS NULL OR p_live_on < p_audited_as_of OR p_live_on > current_date THEN
        RAISE EXCEPTION 'The go-live date must be on or after the audited balance sheet date and not in the future';
    END IF;

    -- Audited balance sheet: asset, liability and fund ledgers only
    FOR v_line IN SELECT * FROM jsonb_array_elements(coalesce(p_audited_lines, '[]'::jsonb)) LOOP
        v_code := v_line ->> 'code';
        v_amount := round(coalesce((v_line ->> 'amount')::numeric, 0), 2);
        CONTINUE WHEN v_amount = 0;
        SELECT type INTO v_type FROM accounts WHERE society_id = p_society_id AND code = v_code;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Unknown ledger %', v_code;
        END IF;
        IF v_type IN ('income', 'expense') THEN
            RAISE EXCEPTION 'A balance sheet line cannot use % (an income or expense ledger) — put it in the catch-up entry', v_code;
        END IF;
        v_side := CASE WHEN v_line ->> 'side' IN ('liabilities', 'assets') THEN v_line ->> 'side'
                       WHEN v_amount < 0 THEN 'liabilities' ELSE 'assets' END;
        v_audited := v_audited || jsonb_strip_nulls(jsonb_build_object(
            'code', v_code, 'amount', v_amount, 'side', v_side,
            'label', nullif(trim(coalesce(v_line ->> 'label', '')), '')));
    END LOOP;

    -- Catch-up entry: any ledger
    FOR v_line IN SELECT * FROM jsonb_array_elements(coalesce(p_catchup_lines, '[]'::jsonb)) LOOP
        v_code := v_line ->> 'code';
        v_amount := round(coalesce((v_line ->> 'amount')::numeric, 0), 2);
        CONTINUE WHEN v_amount = 0;
        IF NOT EXISTS (SELECT 1 FROM accounts WHERE society_id = p_society_id AND code = v_code) THEN
            RAISE EXCEPTION 'Unknown ledger %', v_code;
        END IF;
        v_catchup := v_catchup || jsonb_build_object('code', v_code, 'amount', v_amount);
    END LOOP;

    -- Flat-wise dues (+) and advances (−) on the go-live date
    FOR v_line IN SELECT * FROM jsonb_array_elements(coalesce(p_flat_lines, '[]'::jsonb)) LOOP
        v_key := v_line ->> 'unit_id';
        v_amount := round(coalesce((v_line ->> 'amount')::numeric, 0), 2);
        CONTINUE WHEN v_amount = 0;
        IF NOT EXISTS (SELECT 1 FROM units WHERE id::text = v_key AND society_id = p_society_id) THEN
            RAISE EXCEPTION 'Flat not found in this society';
        END IF;
        IF v_key = ANY (v_seen) THEN
            RAISE EXCEPTION 'Each flat appears once';
        END IF;
        v_seen := v_seen || v_key;
        v_flats := v_flats || jsonb_build_object('unit_id', v_key, 'amount', v_amount);
    END LOOP;

    -- Vendor-wise payables (optional)
    v_seen := '{}';
    FOR v_line IN SELECT * FROM jsonb_array_elements(coalesce(p_vendor_lines, '[]'::jsonb)) LOOP
        v_key := v_line ->> 'vendor_id';
        v_amount := round(coalesce((v_line ->> 'amount')::numeric, 0), 2);
        CONTINUE WHEN v_amount = 0;
        IF NOT EXISTS (SELECT 1 FROM vendors WHERE id::text = v_key AND society_id = p_society_id) THEN
            RAISE EXCEPTION 'Vendor not found in this society';
        END IF;
        IF v_key = ANY (v_seen) THEN
            RAISE EXCEPTION 'Each vendor appears once';
        END IF;
        IF v_amount < 0 THEN
            RAISE EXCEPTION 'Vendor payables are entered as positive amounts';
        END IF;
        v_seen := v_seen || v_key;
        v_vendors := v_vendors || jsonb_build_object('vendor_id', v_key, 'amount', v_amount);
    END LOOP;

    INSERT INTO opening_balances (society_id, audited_as_of, live_on, audited_lines, catchup_lines, flat_lines, vendor_lines,
                                  status, prepared_by, updated_at)
    VALUES (p_society_id, p_audited_as_of, p_live_on, v_audited, v_catchup, v_flats, v_vendors,
            'draft', auth.uid(), timezone('utc'::text, now()))
    ON CONFLICT (society_id) DO UPDATE
    SET audited_as_of = EXCLUDED.audited_as_of, live_on = EXCLUDED.live_on,
        audited_lines = EXCLUDED.audited_lines, catchup_lines = EXCLUDED.catchup_lines,
        flat_lines = EXCLUDED.flat_lines, vendor_lines = EXCLUDED.vendor_lines,
        status = 'draft', prepared_by = EXCLUDED.prepared_by, updated_at = EXCLUDED.updated_at;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'opening_balance.saved', 'opening_balance', p_society_id::text,
            jsonb_build_object('audited_as_of', p_audited_as_of, 'live_on', p_live_on,
                               'audited_lines', jsonb_array_length(v_audited), 'catchup_lines', jsonb_array_length(v_catchup),
                               'flats', jsonb_array_length(v_flats), 'vendors', jsonb_array_length(v_vendors)));

    RETURN opening_balance(p_society_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.money_text(NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.opening_lines_sum(JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.opening_unit_owner(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.opening_balance(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_opening_balance(UUID, DATE, DATE, JSONB, JSONB, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.opening_balance(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_opening_balance(UUID, DATE, DATE, JSONB, JSONB, JSONB, JSONB) TO authenticated;
