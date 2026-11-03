-- ============================================================================
-- 025 VENDOR-WISE AND FLAT-WISE LEDGERS
--   Party ledgers are not rows in `accounts`. Every line on Members
--   Receivable (1200), Advance Maintenance (2300) and Sundry Creditors (2000)
--   belongs to a flat or a vendor through its journal's reference (the bill,
--   payment, expense or vendor payment behind it). The opening-balance line
--   on 1200 is split flat by flat using the opening bills. Lines with no flat
--   or vendor behind them show as "Not linked", so party totals always equal
--   the control ledgers. Bills without a vendor (vouchers) are "Other payees".
-- ============================================================================

-- kind 'flat' (1200, 2300) or 'vendor' (2000); party_key: units.id / vendors.id as text, 'payee' or 'unlinked'
CREATE OR REPLACE FUNCTION public.party_entries(p_society_id UUID)
RETURNS TABLE (kind TEXT, party_key TEXT, ledger_entry_id UUID, code TEXT, entry_date DATE,
               entry_number TEXT, narration TEXT, amount NUMERIC) AS $$
    WITH lines AS (
        SELECT l.id, l.amount, l.date, a.code::text AS code, j.entry_number::text AS entry_number,
               coalesce(l.narration, j.narration)::text AS narration,
               j.reference_event_type AS ev, j.reference_event_id AS ref
        FROM ledger_entries l
        JOIN accounts a ON a.id = l.account_id
        JOIN journal_entries j ON j.id = l.journal_entry_id
        WHERE l.society_id = p_society_id AND a.code IN ('1200', '2300', '2000')
    ),
    opening_bills AS (
        SELECT b.unit_id, b.total_amount FROM bills b WHERE b.society_id = p_society_id AND b.is_opening_balance
    )
    -- Flats: bills, late fees, cancellations, advances applied, payments
    SELECT 'flat'::text,
           coalesce(CASE
               WHEN x.ev IN ('bill.issued', 'bill.cancelled', 'bill.late_fee', 'bill.late_fee_cancelled', 'advance.applied')
                   THEN (SELECT b.unit_id::text FROM bills b WHERE b.id = x.ref AND b.society_id = p_society_id)
               WHEN x.ev = 'payment.verified'
                   THEN (SELECT p.unit_id::text FROM payments p WHERE p.id = x.ref AND p.society_id = p_society_id)
           END, 'unlinked'),
           x.id, x.code, x.date, x.entry_number, x.narration, x.amount
    FROM lines x
    WHERE x.code IN ('1200', '2300') AND NOT (x.ev = 'opening.balance' AND x.code = '1200')
    UNION ALL
    -- The opening Members Receivable line, flat by flat
    SELECT 'flat', o.unit_id::text, x.id, x.code, x.date, x.entry_number, 'Opening balance (arrears)', o.total_amount
    FROM lines x CROSS JOIN opening_bills o
    WHERE x.ev = 'opening.balance' AND x.code = '1200'
    UNION ALL
    SELECT 'flat', 'unlinked', x.id, x.code, x.date, x.entry_number, 'Opening balance not split by flat',
           x.amount - coalesce((SELECT sum(total_amount) FROM opening_bills), 0)
    FROM lines x
    WHERE x.ev = 'opening.balance' AND x.code = '1200'
      AND x.amount <> coalesce((SELECT sum(total_amount) FROM opening_bills), 0)
    UNION ALL
    -- Vendors: bills (and their voids) and payments (and their voids)
    SELECT 'vendor',
           coalesce(CASE
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

-- Flat: "Flat 101" ("Flat A-101" when another wing has a 101). Vendor: its name (with PAN when two share a name).
CREATE OR REPLACE FUNCTION public.party_name(p_society_id UUID, p_kind TEXT, p_key TEXT)
RETURNS TEXT AS $$
    SELECT CASE
        WHEN p_key = 'unlinked' THEN CASE WHEN p_kind = 'flat' THEN 'Not linked to a flat' ELSE 'Not linked to a vendor' END
        WHEN p_key = 'payee' THEN 'Other payees'
        WHEN p_kind = 'flat' THEN (
            SELECT 'Flat ' || CASE WHEN EXISTS (SELECT 1 FROM units u2 WHERE u2.society_id = p_society_id
                                                  AND u2.unit_number = u.unit_number AND u2.id <> u.id)
                                   THEN w.name || '-' ELSE '' END || u.unit_number
            FROM units u JOIN wings w ON w.id = u.wing_id
            WHERE u.id::text = p_key AND u.society_id = p_society_id)
        ELSE (
            SELECT v.name || CASE WHEN EXISTS (SELECT 1 FROM vendors v2 WHERE v2.society_id = p_society_id
                                                 AND lower(trim(v2.name)) = lower(trim(v.name)) AND v2.id <> v.id)
                                  THEN ' (' || coalesce(v.pan, left(v.id::text, 8)) || ')' ELSE '' END
            FROM vendors v
            WHERE v.id::text = p_key AND v.society_id = p_society_id)
    END
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.require_party_access(p_society_id UUID)
RETURNS VOID AS $$
BEGIN
    IF NOT (can_view_financials(p_society_id) OR can_manage_accounts(p_society_id)) THEN
        RAISE EXCEPTION 'You do not have access to this society''s accounts';
    END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- BALANCES
--   flat:   {parties:[{key, name, owner_name, dues, advance, balance}], control:{dues, advance}}
--           dues = the 1200 part, advance = minus the 2300 part, balance = dues - advance (owed by the flat)
--   vendor: {parties:[{key, name, balance}], control:{payable}}   balance = owed to the vendor
--   Every flat and every vendor is listed; "Other payees" and "Not linked" only when not zero.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.party_balances(p_society_id UUID, p_kind TEXT, p_as_of DATE DEFAULT current_date)
RETURNS JSONB AS $$
DECLARE
    v_as_of DATE := coalesce(p_as_of, current_date);
    v_control JSONB;
BEGIN
    PERFORM require_party_access(p_society_id);
    IF p_kind IS NULL OR p_kind NOT IN ('flat', 'vendor') THEN
        RAISE EXCEPTION 'Unknown party type %', p_kind;
    END IF;

    SELECT CASE WHEN p_kind = 'flat'
                THEN jsonb_build_object('dues', coalesce(sum(l.amount) FILTER (WHERE a.code = '1200'), 0),
                                        'advance', -coalesce(sum(l.amount) FILTER (WHERE a.code = '2300'), 0))
                ELSE jsonb_build_object('payable', -coalesce(sum(l.amount) FILTER (WHERE a.code = '2000'), 0))
           END
    INTO v_control
    FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
    WHERE l.society_id = p_society_id AND a.code IN ('1200', '2300', '2000') AND l.date <= v_as_of;

    IF p_kind = 'flat' THEN
        RETURN jsonb_build_object('control', v_control, 'parties', coalesce((
            WITH e AS (
                SELECT party_key, code, amount FROM party_entries(p_society_id)
                WHERE kind = 'flat' AND entry_date <= v_as_of
            ), k AS (
                SELECT u.id::text AS key FROM units u WHERE u.society_id = p_society_id
                UNION
                SELECT DISTINCT party_key FROM e
            ), p AS (
                SELECT k.key, party_name(p_society_id, 'flat', k.key) AS name,
                       (SELECT pr.full_name FROM society_memberships m JOIN profiles pr ON pr.id = m.user_id
                        WHERE m.society_id = p_society_id AND m.unit_id::text = k.key AND m.role = 'resident_owner' AND m.is_active
                        ORDER BY m.created_at LIMIT 1) AS owner_name,
                       coalesce((SELECT sum(amount) FROM e WHERE e.party_key = k.key AND e.code = '1200'), 0) AS dues,
                       -coalesce((SELECT sum(amount) FROM e WHERE e.party_key = k.key AND e.code = '2300'), 0) AS advance
                FROM k
            )
            SELECT jsonb_agg(jsonb_build_object('key', key, 'name', name, 'owner_name', owner_name,
                                                'dues', dues, 'advance', advance, 'balance', dues - advance)
                             ORDER BY key = 'unlinked', name)
            FROM p
            WHERE key <> 'unlinked' OR dues <> 0 OR advance <> 0
        ), '[]'::jsonb));
    END IF;

    RETURN jsonb_build_object('control', v_control, 'parties', coalesce((
        WITH e AS (
            SELECT party_key, amount FROM party_entries(p_society_id)
            WHERE kind = 'vendor' AND entry_date <= v_as_of
        ), k AS (
            SELECT v.id::text AS key FROM vendors v WHERE v.society_id = p_society_id
            UNION
            SELECT DISTINCT party_key FROM e
        ), p AS (
            SELECT k.key, party_name(p_society_id, 'vendor', k.key) AS name,
                   -coalesce((SELECT sum(amount) FROM e WHERE e.party_key = k.key), 0) AS balance
            FROM k
        )
        SELECT jsonb_agg(jsonb_build_object('key', key, 'name', name, 'balance', balance)
                         ORDER BY key IN ('payee', 'unlinked'), name)
        FROM p
        WHERE key NOT IN ('payee', 'unlinked') OR balance <> 0
    ), '[]'::jsonb));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- STATEMENT: {name, opening, lines:[{date, entry_number, narration, debit, credit, balance}], closing}
--   Flats run debit-positive (what the flat owes); vendors credit-positive (what is owed to them).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.party_statement(p_society_id UUID, p_kind TEXT, p_key TEXT, p_from DATE, p_to DATE)
RETURNS JSONB AS $$
DECLARE
    v_sign INT;
    v_name TEXT;
    v_opening NUMERIC;
    v_lines JSONB;
    v_closing NUMERIC;
BEGIN
    PERFORM require_party_access(p_society_id);
    IF p_kind IS NULL OR p_kind NOT IN ('flat', 'vendor') THEN
        RAISE EXCEPTION 'Unknown party type %', p_kind;
    END IF;
    IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
        RAISE EXCEPTION 'Choose a date range';
    END IF;
    v_name := party_name(p_society_id, p_kind, p_key);
    IF v_name IS NULL THEN
        RAISE EXCEPTION 'Party not found';
    END IF;
    v_sign := CASE WHEN p_kind = 'flat' THEN 1 ELSE -1 END;

    SELECT v_sign * coalesce(sum(amount), 0) INTO v_opening
    FROM party_entries(p_society_id)
    WHERE kind = p_kind AND party_key = p_key AND entry_date < p_from;

    SELECT jsonb_agg(jsonb_build_object(
               'date', x.entry_date, 'entry_number', x.entry_number, 'narration', x.narration,
               'debit', CASE WHEN x.amount > 0 THEN x.amount END,
               'credit', CASE WHEN x.amount < 0 THEN -x.amount END,
               'balance', v_opening + v_sign * x.running
           ) ORDER BY x.entry_date, x.entry_number, x.ledger_entry_id),
           v_opening + v_sign * coalesce(sum(x.amount), 0)
    INTO v_lines, v_closing
    FROM (
        SELECT e.*, sum(e.amount) OVER (ORDER BY e.entry_date, e.entry_number, e.ledger_entry_id) AS running
        FROM party_entries(p_society_id) e
        WHERE e.kind = p_kind AND e.party_key = p_key AND e.entry_date BETWEEN p_from AND p_to
    ) x;

    RETURN jsonb_build_object('name', v_name, 'opening', v_opening, 'lines', coalesce(v_lines, '[]'::jsonb),
                              'closing', coalesce(v_closing, v_opening));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- TALLY: which party each Members Receivable / Sundry Creditors line belongs to
--   [{ledger_entry_id, kind, key, name, amount}]; 2300 stays one ledger in Tally.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.party_lines(p_society_id UUID, p_from DATE, p_to DATE)
RETURNS JSONB AS $$
BEGIN
    PERFORM require_party_access(p_society_id);
    RETURN coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                   'ledger_entry_id', e.ledger_entry_id, 'kind', e.kind, 'key', e.party_key,
                   'name', n.name, 'amount', e.amount
               ) ORDER BY e.entry_date, e.ledger_entry_id, n.name)
        FROM party_entries(p_society_id) e
        JOIN LATERAL (SELECT party_name(p_society_id, e.kind, e.party_key) AS name) n ON true
        WHERE e.code IN ('1200', '2000') AND e.entry_date BETWEEN p_from AND p_to
    ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.party_entries(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.party_name(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.require_party_access(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.party_balances(UUID, TEXT, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.party_statement(UUID, TEXT, TEXT, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.party_lines(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.party_balances(UUID, TEXT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.party_statement(UUID, TEXT, TEXT, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.party_lines(UUID, DATE, DATE) TO authenticated;
