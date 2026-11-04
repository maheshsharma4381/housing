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
-- 4. SUBMIT (every part must tie) AND WITHDRAW
-- ============================================================================
-- NULL when the stored draft may be posted; otherwise the first problem
CREATE OR REPLACE FUNCTION public.opening_balance_problem(p_society_id UUID)
RETURNS TEXT AS $$
DECLARE
    v_ob opening_balances%ROWTYPE;
    v_both JSONB;
    v_code TEXT;
    v_diff NUMERIC;
    v_expected NUMERIC;
    v_entered NUMERIC;
    v_flat TEXT;
BEGIN
    SELECT * INTO v_ob FROM opening_balances WHERE society_id = p_society_id;
    IF NOT FOUND OR (jsonb_array_length(v_ob.audited_lines) = 0 AND jsonb_array_length(v_ob.catchup_lines) = 0
                     AND jsonb_array_length(v_ob.flat_lines) = 0) THEN
        RETURN 'Nothing to submit — enter the balance sheet first';
    END IF;
    v_both := v_ob.audited_lines || v_ob.catchup_lines;

    SELECT x ->> 'code' INTO v_code
    FROM jsonb_array_elements(v_both) x
    JOIN accounts a ON a.society_id = p_society_id AND a.code = x ->> 'code'
    WHERE NOT a.is_active
    LIMIT 1;
    IF v_code IS NOT NULL THEN
        RETURN format('Ledger %s is inactive — choose an active ledger', v_code);
    END IF;

    v_diff := opening_lines_sum(v_ob.audited_lines);
    IF v_diff <> 0 THEN
        RETURN 'The balance sheet does not tally — the two sides differ by ' || money_text(v_diff);
    END IF;
    v_diff := opening_lines_sum(v_ob.catchup_lines);
    IF v_diff <> 0 THEN
        RETURN 'The catch-up entry does not tally — debits and credits differ by ' || money_text(v_diff);
    END IF;

    v_expected := opening_lines_sum(v_both, '1200');
    SELECT coalesce(sum((x ->> 'amount')::numeric), 0) INTO v_entered
    FROM jsonb_array_elements(v_ob.flat_lines) x WHERE (x ->> 'amount')::numeric > 0;
    IF v_entered <> v_expected THEN
        RETURN format('Flat-wise dues add up to %s but Members'' dues come to %s', money_text(v_entered), money_text(v_expected));
    END IF;

    v_expected := -opening_lines_sum(v_both, '2300');
    SELECT -coalesce(sum((x ->> 'amount')::numeric), 0) INTO v_entered
    FROM jsonb_array_elements(v_ob.flat_lines) x WHERE (x ->> 'amount')::numeric < 0;
    IF v_entered <> v_expected THEN
        RETURN format('Flat-wise advances add up to %s but Advances from members come to %s', money_text(v_entered), money_text(v_expected));
    END IF;

    v_expected := -opening_lines_sum(v_both, '2000');
    v_entered := opening_lines_sum(v_ob.vendor_lines);
    IF v_entered > v_expected THEN
        RETURN format('Vendor-wise payables add up to %s — more than Sundry Creditors of %s', money_text(v_entered), money_text(v_expected));
    END IF;

    SELECT party_name(p_society_id, 'flat', u.id::text) INTO v_flat
    FROM jsonb_array_elements(v_ob.flat_lines) x
    JOIN units u ON u.id::text = x ->> 'unit_id'
    JOIN wings w ON w.id = u.wing_id
    WHERE (x ->> 'amount')::numeric > 0 AND opening_unit_owner(u.id) IS NULL
    ORDER BY w.name, u.unit_number
    LIMIT 1;
    IF v_flat IS NOT NULL THEN
        RETURN v_flat || ' has no owner linked — ask the secretary to invite the owner first';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.submit_opening_balance(p_society_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_status TEXT;
    v_problem TEXT;
BEGIN
    IF NOT can_manage_accounts(p_society_id) THEN
        RAISE EXCEPTION 'Only the society''s CA or accountant can prepare the opening balance';
    END IF;
    SELECT status INTO v_status FROM opening_balances WHERE society_id = p_society_id FOR UPDATE;
    IF v_status IS NULL THEN
        RAISE EXCEPTION 'Nothing to submit — enter the balance sheet first';
    ELSIF v_status <> 'draft' THEN
        RAISE EXCEPTION 'Only a draft can be submitted';
    END IF;
    v_problem := opening_balance_problem(p_society_id);
    IF v_problem IS NOT NULL THEN
        RAISE EXCEPTION '%', v_problem;
    END IF;

    UPDATE opening_balances
    SET status = 'submitted', submitted_by = auth.uid(), submitted_at = timezone('utc'::text, now()),
        updated_at = timezone('utc'::text, now())
    WHERE society_id = p_society_id;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'opening_balance.submitted', 'opening_balance', p_society_id::text, '{}'::jsonb);
    RETURN opening_balance(p_society_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.reopen_opening_balance(p_society_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_status TEXT;
BEGIN
    IF NOT can_manage_accounts(p_society_id) THEN
        RAISE EXCEPTION 'Only the society''s CA or accountant can prepare the opening balance';
    END IF;
    SELECT status INTO v_status FROM opening_balances WHERE society_id = p_society_id FOR UPDATE;
    IF v_status IS DISTINCT FROM 'submitted' THEN
        RAISE EXCEPTION 'Only a submitted opening balance can be withdrawn';
    END IF;
    UPDATE opening_balances
    SET status = 'draft', submitted_by = NULL, submitted_at = NULL, updated_at = timezone('utc'::text, now())
    WHERE society_id = p_society_id;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'opening_balance.withdrawn', 'opening_balance', p_society_id::text, '{}'::jsonb);
    RETURN opening_balance(p_society_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. A LEDGER LINE CAN NAME ITS FLAT OR VENDOR
--    Used by the opening party journal; party_entries prefers it.
-- ============================================================================
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS party_key TEXT;

-- from 020_ledger_management.sql; + a line's "party" is kept in ledger_entries.party_key
CREATE OR REPLACE FUNCTION public.post_journal(
    p_society_id UUID,
    p_entry_date DATE,
    p_event_type TEXT,
    p_event_id UUID,
    p_narration TEXT,
    p_lines JSONB
)
RETURNS UUID AS $$
DECLARE
    v_journal_id UUID;
    v_line JSONB;
    v_amount NUMERIC;
    v_sum NUMERIC := 0;
    v_count INT := 0;
    v_account_id UUID;
    v_active BOOLEAN;
    v_prev NUMERIC;
    v_next INT;
BEGIN
    IF EXISTS (
        SELECT 1 FROM journal_entries
        WHERE society_id = p_society_id AND reference_event_type = p_event_type AND reference_event_id = p_event_id
    ) THEN
        RETURN NULL; -- already posted
    END IF;

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        v_amount := round(coalesce((v_line ->> 'amount')::NUMERIC, 0), 2);
        IF v_amount <> 0 THEN
            v_sum := v_sum + v_amount;
            v_count := v_count + 1;
        END IF;
    END LOOP;

    IF v_count = 0 THEN
        RETURN NULL; -- nothing to post (zero-value event)
    END IF;
    IF v_sum <> 0 THEN
        RAISE EXCEPTION 'Unbalanced journal for % %: debits and credits differ by %', p_event_type, p_event_id, v_sum;
    END IF;

    -- Serialize journal numbering per society
    PERFORM 1 FROM societies WHERE id = p_society_id FOR UPDATE;
    SELECT count(*) + 1 INTO v_next FROM journal_entries WHERE society_id = p_society_id;

    INSERT INTO journal_entries (society_id, entry_number, entry_date, reference_event_type, reference_event_id, narration, is_posted)
    VALUES (p_society_id, 'JV-' || lpad(v_next::text, 6, '0'), p_entry_date, p_event_type, p_event_id, p_narration, true)
    RETURNING id INTO v_journal_id;

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        v_amount := round(coalesce((v_line ->> 'amount')::NUMERIC, 0), 2);
        CONTINUE WHEN v_amount = 0;

        v_account_id := NULL;
        SELECT id, is_active INTO v_account_id, v_active FROM accounts WHERE society_id = p_society_id AND code = v_line ->> 'code';
        IF v_account_id IS NULL THEN
            RAISE EXCEPTION 'Account % is missing for society %', v_line ->> 'code', p_society_id;
        END IF;
        IF NOT v_active THEN
            RAISE EXCEPTION 'Ledger % is inactive', v_line ->> 'code';
        END IF;

        SELECT coalesce(sum(amount), 0) INTO v_prev FROM ledger_entries WHERE account_id = v_account_id;

        INSERT INTO ledger_entries (society_id, account_id, journal_entry_id, date, amount, balance_after, narration, party_key)
        VALUES (p_society_id, v_account_id, v_journal_id, p_entry_date, v_amount, v_prev + v_amount,
                coalesce(v_line ->> 'narration', p_narration), nullif(v_line ->> 'party', ''));
    END LOOP;

    RETURN v_journal_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 025_party_ledgers.sql; + a line's party_key wins. A society whose opening balance was approved
-- here gets its split from the tagged opening.parties journal; one that posted the old way (010)
-- keeps 025's split of the opening Members Receivable line by its opening bills.
CREATE OR REPLACE FUNCTION public.party_entries(p_society_id UUID)
RETURNS TABLE (kind TEXT, party_key TEXT, ledger_entry_id UUID, code TEXT, entry_date DATE,
               entry_number TEXT, narration TEXT, amount NUMERIC) AS $$
    WITH lines AS (
        SELECT l.id, l.amount, l.date, a.code::text AS code, j.entry_number::text AS entry_number,
               coalesce(l.narration, j.narration)::text AS narration,
               j.reference_event_type AS ev, j.reference_event_id AS ref, l.party_key AS party
        FROM ledger_entries l
        JOIN accounts a ON a.id = l.account_id
        JOIN journal_entries j ON j.id = l.journal_entry_id
        WHERE l.society_id = p_society_id AND a.code IN ('1200', '2300', '2000')
    ),
    legacy AS (
        SELECT NOT EXISTS (SELECT 1 FROM opening_balances ob WHERE ob.society_id = p_society_id AND ob.status = 'approved') AS yes
    ),
    opening_bills AS (
        SELECT b.unit_id, b.total_amount FROM bills b WHERE b.society_id = p_society_id AND b.is_opening_balance
    )
    -- Flats: bills, late fees, cancellations, advances applied, payments, opening lines
    SELECT 'flat'::text,
           coalesce(x.party, CASE
               WHEN x.ev IN ('bill.issued', 'bill.cancelled', 'bill.late_fee', 'bill.late_fee_cancelled', 'advance.applied')
                   THEN (SELECT b.unit_id::text FROM bills b WHERE b.id = x.ref AND b.society_id = p_society_id)
               WHEN x.ev = 'payment.verified'
                   THEN (SELECT p.unit_id::text FROM payments p WHERE p.id = x.ref AND p.society_id = p_society_id)
           END, 'unlinked'),
           x.id, x.code, x.date, x.entry_number, x.narration, x.amount
    FROM lines x
    WHERE x.code IN ('1200', '2300')
      AND NOT (x.ev = 'opening.balance' AND x.code = '1200' AND (SELECT yes FROM legacy))
    UNION ALL
    -- Opening balances posted the old way (010): the opening Members Receivable line, flat by flat
    SELECT 'flat', o.unit_id::text, x.id, x.code, x.date, x.entry_number, 'Opening balance (arrears)', o.total_amount
    FROM lines x CROSS JOIN opening_bills o
    WHERE x.ev = 'opening.balance' AND x.code = '1200' AND (SELECT yes FROM legacy)
    UNION ALL
    SELECT 'flat', 'unlinked', x.id, x.code, x.date, x.entry_number, 'Opening balance not split by flat',
           x.amount - coalesce((SELECT sum(total_amount) FROM opening_bills), 0)
    FROM lines x
    WHERE x.ev = 'opening.balance' AND x.code = '1200' AND (SELECT yes FROM legacy)
      AND x.amount <> coalesce((SELECT sum(total_amount) FROM opening_bills), 0)
    UNION ALL
    -- Vendors: bills (and their voids), payments (and their voids), opening lines
    SELECT 'vendor',
           coalesce(x.party, CASE
               WHEN x.ev IN ('expense.approved', 'expense.voided', 'expense.paid')
                   THEN (SELECT coalesce(e.vendor_id::text, 'payee') FROM expenses e WHERE e.id = x.ref AND e.society_id = p_society_id)
               WHEN x.ev IN ('vendor_payment.recorded', 'vendor_payment.voided')
                   THEN (SELECT coalesce(e.vendor_id::text, 'payee') FROM vendor_payments vp JOIN expenses e ON e.id = vp.expense_id
                         WHERE vp.id = x.ref AND vp.society_id = p_society_id)
           END, 'unlinked'),
           x.id, x.code, x.date, x.entry_number, x.narration, x.amount
    FROM lines x
    WHERE x.code = '2000'
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- from 014_ca_workspace.sql; + the opening catch-up, party and advance entries are manual too
CREATE OR REPLACE FUNCTION public.trg_journal_respect_lock()
RETURNS TRIGGER AS $$
DECLARE
    v_lock DATE := books_locked_until(NEW.society_id);
BEGIN
    IF v_lock IS NOT NULL AND NEW.entry_date <= v_lock THEN
        IF NEW.reference_event_type IN ('adjustment.approved', 'opening.balance', 'opening.catchup', 'opening.parties',
                                        'opening_advance.applied', 'depreciation.run') THEN
            RAISE EXCEPTION 'The books up to % are locked after audit — date this entry on or after %',
                to_char(v_lock, 'DD Mon YYYY'), to_char(v_lock + 1, 'DD Mon YYYY');
        END IF;
        NEW.narration := NEW.narration || ' [dated ' || to_char(NEW.entry_date, 'DD-Mon-YYYY') || '; that year is locked]';
        NEW.entry_date := v_lock + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 010_launch.sql; retired: the committee no longer posts opening balances
CREATE OR REPLACE FUNCTION public.post_opening_balances(
    p_society_id UUID,
    p_as_of DATE,
    p_accounts JSONB,
    p_member_dues JSONB DEFAULT '[]'::jsonb
)
RETURNS JSONB AS $$
BEGIN
    RAISE EXCEPTION 'Opening balances are now entered by the society''s CA under Opening Balance in the CA login';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5b. OPENING ADVANCES ARE USED ON BILLS; OPENING PAYABLES ARE PAID IN THE APP
-- ============================================================================
-- A flat's advance on the go-live date: used on its bills before any payment advance
CREATE TABLE IF NOT EXISTS opening_advances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    remaining NUMERIC(12,2) NOT NULL CHECK (remaining >= 0 AND remaining <= amount),
    as_of DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_opening_advances_unit ON opening_advances (unit_id);
ALTER TABLE opening_advances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS opening_advances_select ON opening_advances;
CREATE POLICY opening_advances_select ON opening_advances FOR SELECT USING (can_view_financials(society_id));

-- A vendor's payable on the go-live date: already in the opening party journal, paid like any bill
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS is_opening_balance BOOLEAN NOT NULL DEFAULT false;

-- Only the approval of an opening balance marks a vendor bill as an opening payable
CREATE OR REPLACE FUNCTION public.trg_expense_opening_flag()
RETURNS TRIGGER AS $$
BEGIN
    IF coalesce(current_setting('sahvaas.opening_payable', true), '') = 'on' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        NEW.is_opening_balance := false;
    ELSIF NEW.is_opening_balance IS DISTINCT FROM OLD.is_opening_balance THEN
        RAISE EXCEPTION 'The opening-payable mark is set only by the approved opening balance';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_expense_opening_flag ON expenses;
CREATE TRIGGER trg_expense_opening_flag
    BEFORE INSERT OR UPDATE OF is_opening_balance ON expenses
    FOR EACH ROW EXECUTE FUNCTION public.trg_expense_opening_flag();

-- from 010_launch.sql; + the flat's opening advance is used first
CREATE OR REPLACE FUNCTION public.ledger_apply_advance(p_bill_id UUID)
RETURNS NUMERIC AS $$
DECLARE
    v_bill bills%ROWTYPE;
    v_pay RECORD;
    v_adv RECORD;
    v_balance NUMERIC;
    v_alloc NUMERIC;
    v_total NUMERIC := 0;
BEGIN
    SELECT * INTO v_bill FROM bills WHERE id = p_bill_id FOR UPDATE;
    IF NOT FOUND OR v_bill.balance_due <= 0 OR v_bill.status NOT IN ('issued', 'partially_paid', 'overdue') THEN
        RETURN 0;
    END IF;
    v_balance := v_bill.balance_due;

    FOR v_adv IN
        SELECT a.id, a.remaining FROM opening_advances a
        WHERE a.society_id = v_bill.society_id AND a.unit_id = v_bill.unit_id AND a.remaining > 0
        ORDER BY a.created_at
        FOR UPDATE
    LOOP
        EXIT WHEN v_balance <= 0;
        v_alloc := least(v_adv.remaining, v_balance);
        UPDATE opening_advances SET remaining = remaining - v_alloc WHERE id = v_adv.id;
        v_balance := v_balance - v_alloc;
        v_total := v_total + v_alloc;
    END LOOP;

    IF v_balance > 0 THEN
        FOR v_pay IN
            SELECT p.id, p.amount - coalesce((SELECT sum(a.amount) FROM payment_allocations a WHERE a.payment_id = p.id), 0) AS remaining
            FROM payments p
            WHERE p.society_id = v_bill.society_id AND p.unit_id = v_bill.unit_id AND p.status = 'verified'
            ORDER BY p.verified_at NULLS FIRST, p.created_at
            FOR UPDATE OF p
        LOOP
            CONTINUE WHEN v_pay.remaining <= 0;
            v_alloc := least(v_pay.remaining, v_balance);
            INSERT INTO payment_allocations (society_id, payment_id, bill_id, amount)
            VALUES (v_bill.society_id, v_pay.id, v_bill.id, v_alloc);
            v_balance := v_balance - v_alloc;
            v_total := v_total + v_alloc;
            EXIT WHEN v_balance <= 0;
        END LOOP;
    END IF;

    IF v_total > 0 THEN
        UPDATE bills
        SET amount_paid = amount_paid + v_total,
            balance_due = balance_due - v_total,
            status = CASE WHEN balance_due - v_total <= 0 THEN 'paid' ELSE 'partially_paid' END,
            updated_at = timezone('utc'::text, now())
        WHERE id = v_bill.id;

        PERFORM post_journal(
            v_bill.society_id, v_bill.bill_date, 'advance.applied', v_bill.id,
            'Advance adjusted against bill ' || v_bill.bill_number,
            jsonb_build_array(
                jsonb_build_object('code', '2300', 'amount', v_total),
                jsonb_build_object('code', '1200', 'amount', -v_total)
            )
        );
    END IF;
    RETURN v_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 013_accounting.sql; + an opening payable posts nothing (the opening party journal holds it)
CREATE OR REPLACE FUNCTION public.ledger_post_expense_accrual(p_expense_id UUID)
RETURNS UUID AS $$
DECLARE
    v_exp expenses%ROWTYPE;
    v_vendor TEXT;
    v_gst_input NUMERIC;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id;
    IF NOT FOUND OR v_exp.status NOT IN ('approved', 'paid') OR v_exp.is_opening_balance THEN
        RETURN NULL;
    END IF;
    -- Expenses paid before accrual accounting were posted on payment (cash basis)
    IF EXISTS (SELECT 1 FROM journal_entries WHERE society_id = v_exp.society_id
               AND reference_event_type = 'expense.paid' AND reference_event_id = v_exp.id) THEN
        RETURN NULL;
    END IF;
    SELECT name INTO v_vendor FROM vendors WHERE id = v_exp.vendor_id;
    v_gst_input := CASE WHEN v_exp.gst_claimable THEN v_exp.gst_amount ELSE 0 END;

    RETURN post_journal(
        v_exp.society_id, coalesce(v_exp.invoice_date, v_exp.approved_at::date, current_date), 'expense.approved', v_exp.id,
        coalesce(v_exp.voucher_number, v_exp.expense_number) || ': ' || v_exp.title || coalesce(' (' || v_vendor || ')', coalesce(' (' || v_exp.payee_name || ')', '')),
        jsonb_build_array(
            jsonb_build_object('code', expense_debit_code(v_exp.society_id, v_exp.category, v_exp.expense_type, v_exp.asset_account_code),
                               'amount', v_exp.subtotal + v_exp.gst_amount - v_gst_input),
            jsonb_build_object('code', '1300', 'amount', v_gst_input),
            jsonb_build_object('code', '2000', 'amount', -(v_exp.subtotal + v_exp.gst_amount))
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 013_accounting.sql; + an opening payable never falls back to cash-basis posting when it is paid
-- (it has no accrual journal on purpose: the opening party journal holds it)
CREATE OR REPLACE FUNCTION public.ledger_post_expense(p_expense_id UUID)
RETURNS UUID AS $$
DECLARE
    v_exp expenses%ROWTYPE;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id;
    IF NOT FOUND OR NOT (v_exp.status = 'paid' OR v_exp.payment_status = 'paid') OR v_exp.is_opening_balance THEN
        RETURN NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM journal_entries WHERE society_id = v_exp.society_id
               AND reference_event_type = 'expense.approved' AND reference_event_id = v_exp.id) THEN
        RETURN NULL;
    END IF;
    RETURN post_journal(
        v_exp.society_id, coalesce(v_exp.paid_date, v_exp.invoice_date, current_date), 'expense.paid', v_exp.id,
        'Expense ' || v_exp.expense_number || ': ' || v_exp.title,
        jsonb_build_array(
            jsonb_build_object('code', expense_debit_code(v_exp.society_id, v_exp.category, v_exp.expense_type, v_exp.asset_account_code),
                               'amount', v_exp.net_payable + v_exp.tds_amount),
            jsonb_build_object('code', '1000', 'amount', -v_exp.net_payable),
            jsonb_build_object('code', '2200', 'amount', -v_exp.tds_amount)
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- from 013_accounting.sql; + an opening payable cannot be voided
CREATE OR REPLACE FUNCTION public.void_expense(p_expense_id UUID, p_reason TEXT)
RETURNS JSONB AS $$
DECLARE
    v_exp expenses%ROWTYPE;
    v_vp RECORD;
    v_asset fixed_assets%ROWTYPE;
    v_reversed BOOLEAN := false;
    v_reason TEXT := trim(coalesce(p_reason, ''));
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_exp.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can void expenses';
    END IF;
    IF length(v_reason) = 0 THEN
        RAISE EXCEPTION 'A reason is required to void an expense';
    END IF;
    IF v_exp.status = 'voided' THEN
        RAISE EXCEPTION 'Expense is already voided';
    END IF;
    IF v_exp.is_opening_balance THEN
        RAISE EXCEPTION 'An opening payable cannot be voided — it came from the approved opening balance';
    END IF;

    SELECT * INTO v_asset FROM fixed_assets WHERE expense_id = p_expense_id;
    IF FOUND THEN
        IF EXISTS (SELECT 1 FROM depreciation_lines WHERE asset_id = v_asset.id) THEN
            RAISE EXCEPTION 'Depreciation is already posted on asset %; record a disposal instead', v_asset.asset_number;
        END IF;
        IF v_asset.status = 'disposed' THEN
            RAISE EXCEPTION 'Asset % is already disposed', v_asset.asset_number;
        END IF;
        UPDATE fixed_assets SET status = 'voided', updated_at = timezone('utc'::text, now()) WHERE id = v_asset.id;
    END IF;

    FOR v_vp IN SELECT * FROM vendor_payments WHERE expense_id = p_expense_id AND status = 'recorded' ORDER BY created_at LOOP
        PERFORM ledger_reverse(v_exp.society_id, 'vendor_payment.recorded', v_vp.id, 'vendor_payment.voided', current_date,
                               'Payment ' || v_vp.payment_number || ' reversed: ' || v_reason);
        UPDATE vendor_payments SET status = 'voided' WHERE id = v_vp.id;
        v_reversed := true;
    END LOOP;

    IF ledger_reverse(v_exp.society_id, 'expense.approved', v_exp.id, 'expense.voided', current_date,
                      coalesce(v_exp.voucher_number, v_exp.expense_number) || ' voided: ' || v_reason) IS NOT NULL THEN
        v_reversed := true;
    END IF;
    IF ledger_reverse(v_exp.society_id, 'expense.paid', v_exp.id, 'expense.voided', current_date,
                      'Expense ' || v_exp.expense_number || ' voided: ' || v_reason) IS NOT NULL THEN
        v_reversed := true;
    END IF;

    PERFORM set_config('sahvaas.expense_workflow', 'on', true);
    UPDATE expenses SET status = 'voided', updated_at = timezone('utc'::text, now()) WHERE id = p_expense_id;
    PERFORM set_config('sahvaas.expense_workflow', 'off', true);

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, reason)
    VALUES (v_exp.society_id, auth.uid(), 'expense.voided', 'expense', p_expense_id::text,
            jsonb_build_object('expense_number', v_exp.expense_number, 'status', v_exp.status, 'net_payable', v_exp.net_payable,
                               'amount_settled', v_exp.amount_settled), v_reason);

    RETURN jsonb_build_object('status', 'voided', 'reversed', v_reversed);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 6. THE COMMITTEE DECIDES; APPROVAL POSTS THE BOOKS
--    opening.balance  audited sheet, dated the 31 March
--    opening.catchup  the months up to go-live, dated go-live
--    opening.parties  go-live dues / advances / payables moved onto flats and vendors
-- ============================================================================
CREATE OR REPLACE FUNCTION public.decide_opening_balance(p_society_id UUID, p_approve BOOLEAN, p_note TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_ob opening_balances%ROWTYPE;
    v_problem TEXT;
    v_line RECORD;
    v_cycle UUID;
    v_bill UUID;
    v_seq INT := 0;
    v_dues NUMERIC := 0;
    v_advance NUMERIC := 0;
    v_payable NUMERIC := 0;
    v_tagged JSONB := '[]'::jsonb;
    v_lines JSONB := '[]'::jsonb;
    v_applied JSONB := '[]'::jsonb;
    v_open RECORD;
    v_adv UUID;
    v_used NUMERIC;
    v_alloc NUMERIC;
    v_vseq INT := 0;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can approve the opening balance';
    END IF;
    SELECT * INTO v_ob FROM opening_balances WHERE society_id = p_society_id FOR UPDATE;
    IF NOT FOUND OR v_ob.status <> 'submitted' THEN
        RAISE EXCEPTION 'There is no opening balance waiting for approval';
    END IF;
    IF v_ob.submitted_by = auth.uid() THEN
        RAISE EXCEPTION 'You submitted this opening balance; another committee member must approve it';
    END IF;

    IF NOT p_approve THEN
        IF length(trim(coalesce(p_note, ''))) = 0 THEN
            RAISE EXCEPTION 'Give a reason for rejecting';
        END IF;
        UPDATE opening_balances
        SET status = 'draft', decision_note = trim(p_note), decided_by = auth.uid(),
            decided_at = timezone('utc'::text, now()), updated_at = timezone('utc'::text, now())
        WHERE society_id = p_society_id;
        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value, reason)
        VALUES (p_society_id, auth.uid(), 'opening_balance.rejected', 'opening_balance', p_society_id::text, '{}'::jsonb, trim(p_note));
        RETURN jsonb_build_object('status', 'rejected');
    END IF;

    v_problem := opening_balance_problem(p_society_id);
    IF v_problem IS NOT NULL THEN
        RAISE EXCEPTION '%', v_problem;
    END IF;

    -- 1. The audited balance sheet, exactly as entered
    PERFORM post_journal(p_society_id, v_ob.audited_as_of, 'opening.balance', p_society_id,
        'Opening balances as on ' || to_char(v_ob.audited_as_of, 'DD-Mon-YYYY') || ' (audited balance sheet)',
        (SELECT coalesce(jsonb_agg(jsonb_build_object('code', x ->> 'code', 'amount', (x ->> 'amount')::numeric)), '[]'::jsonb)
         FROM jsonb_array_elements(v_ob.audited_lines) x));

    -- 2. The catch-up entry
    IF jsonb_array_length(v_ob.catchup_lines) > 0 THEN
        PERFORM post_journal(p_society_id, v_ob.live_on, 'opening.catchup', p_society_id,
            'Catch-up entry from ' || to_char(v_ob.audited_as_of + 1, 'DD-Mon-YYYY') || ' to ' || to_char(v_ob.live_on - 1, 'DD-Mon-YYYY'),
            v_ob.catchup_lines);
    END IF;

    -- 3. Flat-wise dues become opening bills the owners can pay (they post nothing themselves)
    FOR v_line IN
        SELECT u.id AS unit_id, (x ->> 'amount')::numeric AS amount
        FROM jsonb_array_elements(v_ob.flat_lines) x
        JOIN units u ON u.id::text = x ->> 'unit_id'
        JOIN wings w ON w.id = u.wing_id
        WHERE (x ->> 'amount')::numeric > 0
        ORDER BY w.name, u.unit_number
    LOOP
        IF v_cycle IS NULL THEN
            INSERT INTO billing_cycles (society_id, cycle_name, period_start, period_end, due_date, status)
            VALUES (p_society_id, 'Opening balance (dues)', v_ob.live_on, v_ob.live_on, v_ob.live_on, 'published')
            RETURNING id INTO v_cycle;
        END IF;
        v_seq := v_seq + 1;
        INSERT INTO bills (society_id, cycle_id, unit_id, user_id, bill_number, bill_date, due_date,
                           subtotal_amount, total_amount, amount_paid, balance_due, status, is_opening_balance)
        VALUES (p_society_id, v_cycle, v_line.unit_id, opening_unit_owner(v_line.unit_id), 'OB-' || lpad(v_seq::text, 4, '0'),
                v_ob.live_on, v_ob.live_on, v_line.amount, v_line.amount, 0, v_line.amount, 'issued', true)
        RETURNING id INTO v_bill;
        INSERT INTO bill_items (bill_id, description, quantity, unit_rate, amount, total_item_amount)
        VALUES (v_bill, 'Opening balance (dues as on ' || to_char(v_ob.live_on, 'DD-Mon-YYYY') || ')', 1,
                v_line.amount, v_line.amount, v_line.amount);
        v_dues := v_dues + v_line.amount;
        v_tagged := v_tagged || jsonb_build_object('code', '1200', 'amount', v_line.amount, 'party', v_line.unit_id::text,
            'narration', 'Opening dues — ' || party_name(p_society_id, 'flat', v_line.unit_id::text));
    END LOOP;

    -- 4. Flat-wise advances: held for the flat and used on its open bills now, then on new bills
    FOR v_line IN
        SELECT u.id AS unit_id, -(x ->> 'amount')::numeric AS amount
        FROM jsonb_array_elements(v_ob.flat_lines) x
        JOIN units u ON u.id::text = x ->> 'unit_id'
        JOIN wings w ON w.id = u.wing_id
        WHERE (x ->> 'amount')::numeric < 0
        ORDER BY w.name, u.unit_number
    LOOP
        v_advance := v_advance + v_line.amount;
        v_tagged := v_tagged || jsonb_build_object('code', '2300', 'amount', -v_line.amount, 'party', v_line.unit_id::text,
            'narration', 'Opening advance — ' || party_name(p_society_id, 'flat', v_line.unit_id::text));

        INSERT INTO opening_advances (society_id, unit_id, amount, remaining, as_of)
        VALUES (p_society_id, v_line.unit_id, v_line.amount, v_line.amount, v_ob.live_on)
        RETURNING id INTO v_adv;
        v_used := 0;
        FOR v_open IN
            SELECT b.id, b.balance_due FROM bills b
            WHERE b.society_id = p_society_id AND b.unit_id = v_line.unit_id AND b.balance_due > 0
              AND b.status IN ('issued', 'partially_paid', 'overdue')
            ORDER BY b.due_date, b.bill_date, b.bill_number
            FOR UPDATE
        LOOP
            EXIT WHEN v_used >= v_line.amount;
            v_alloc := least(v_open.balance_due, v_line.amount - v_used);
            UPDATE bills
            SET amount_paid = amount_paid + v_alloc,
                balance_due = balance_due - v_alloc,
                status = CASE WHEN balance_due - v_alloc <= 0 THEN 'paid' ELSE 'partially_paid' END,
                updated_at = timezone('utc'::text, now())
            WHERE id = v_open.id;
            v_used := v_used + v_alloc;
        END LOOP;
        IF v_used > 0 THEN
            UPDATE opening_advances SET remaining = remaining - v_used WHERE id = v_adv;
            v_applied := v_applied || jsonb_build_object('id', v_adv, 'unit_id', v_line.unit_id, 'used', v_used);
        END IF;
    END LOOP;

    -- 5. Vendor-wise payables: an approved bill per vendor, paid like any other
    FOR v_line IN
        SELECT v.id AS vendor_id, (x ->> 'amount')::numeric AS amount
        FROM jsonb_array_elements(v_ob.vendor_lines) x
        JOIN vendors v ON v.id::text = x ->> 'vendor_id'
        ORDER BY v.name
    LOOP
        v_payable := v_payable + v_line.amount;
        v_tagged := v_tagged || jsonb_build_object('code', '2000', 'amount', -v_line.amount, 'party', v_line.vendor_id::text,
            'narration', 'Opening payable — ' || party_name(p_society_id, 'vendor', v_line.vendor_id::text));

        v_vseq := v_vseq + 1;
        PERFORM set_config('sahvaas.expense_workflow', 'on', true);
        PERFORM set_config('sahvaas.opening_payable', 'on', true);
        INSERT INTO expenses (society_id, vendor_id, category, title, subtotal, gst_amount, tds_amount,
                              invoice_number, invoice_date, expense_type, status, approved_by, approved_at, is_opening_balance)
        VALUES (p_society_id, v_line.vendor_id, 'other',
                'Opening balance (payable as on ' || to_char(v_ob.live_on, 'DD-Mon-YYYY') || ')',
                v_line.amount, 0, 0, 'OB-' || lpad(v_vseq::text, 4, '0'), v_ob.live_on, 'revenue', 'approved',
                auth.uid(), timezone('utc'::text, now()), true);
        PERFORM set_config('sahvaas.opening_payable', 'off', true);
        PERFORM set_config('sahvaas.expense_workflow', 'off', true);
    END LOOP;

    -- 6. Move those amounts from the control ledgers onto each flat and vendor
    IF v_dues <> 0 THEN
        v_lines := v_lines || jsonb_build_object('code', '1200', 'amount', -v_dues, 'narration', 'Members'' dues moved to flats');
    END IF;
    IF v_advance <> 0 THEN
        v_lines := v_lines || jsonb_build_object('code', '2300', 'amount', v_advance, 'narration', 'Advances moved to flats');
    END IF;
    IF v_payable <> 0 THEN
        v_lines := v_lines || jsonb_build_object('code', '2000', 'amount', v_payable, 'narration', 'Sundry Creditors moved to vendors');
    END IF;
    PERFORM post_journal(p_society_id, v_ob.live_on, 'opening.parties', p_society_id,
        'Opening dues, advances and payables by flat and vendor as on ' || to_char(v_ob.live_on, 'DD-Mon-YYYY'),
        v_lines || v_tagged);

    -- 7. Opening advances used on bills already issued
    FOR v_line IN
        SELECT (x ->> 'id')::uuid AS id, (x ->> 'unit_id')::uuid AS unit_id, (x ->> 'used')::numeric AS used
        FROM jsonb_array_elements(v_applied) x
    LOOP
        PERFORM post_journal(p_society_id, current_date, 'opening_advance.applied', v_line.id,
            'Opening advance adjusted against bills of ' || party_name(p_society_id, 'flat', v_line.unit_id::text),
            jsonb_build_array(
                jsonb_build_object('code', '2300', 'amount', v_line.used, 'party', v_line.unit_id::text),
                jsonb_build_object('code', '1200', 'amount', -v_line.used, 'party', v_line.unit_id::text)));
    END LOOP;

    UPDATE opening_balances
    SET status = 'approved', decided_by = auth.uid(), decided_at = timezone('utc'::text, now()),
        updated_at = timezone('utc'::text, now())
    WHERE society_id = p_society_id;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'opening_balance.approved', 'opening_balance', p_society_id::text,
            jsonb_build_object('audited_as_of', v_ob.audited_as_of, 'live_on', v_ob.live_on, 'opening_bills', v_seq,
                               'dues', v_dues, 'advances', v_advance, 'payables', v_payable));
    RETURN jsonb_build_object('status', 'approved', 'opening_bills', v_seq);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.post_journal(UUID, DATE, TEXT, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.party_entries(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_journal_respect_lock() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_expense_opening_flag() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decide_opening_balance(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_opening_balance(UUID, BOOLEAN, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.opening_balance_problem(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_opening_balance(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reopen_opening_balance(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_opening_balance(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_opening_balance(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.money_text(NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.opening_lines_sum(JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.opening_unit_owner(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.opening_balance(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_opening_balance(UUID, DATE, DATE, JSONB, JSONB, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.opening_balance(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_opening_balance(UUID, DATE, DATE, JSONB, JSONB, JSONB, JSONB) TO authenticated;
