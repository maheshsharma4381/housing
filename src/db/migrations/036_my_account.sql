-- ============================================================================
-- 036 MY ACCOUNT: THE OWNER'S FLAT STATEMENT (Phase 5, spec 10.2)
--   The same entries and numbers as the CA's party ledger for the flat (party_entries, 025/026).
--   After an owner change the new owner's statement starts at the transfer date,
--   with "Brought forward from previous owner". Tenants see none of it.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.my_flat_statement(p_unit_id UUID, p_from DATE, p_to DATE)
RETURNS JSONB AS $$
DECLARE
    v_unit units%ROWTYPE;
    v_start DATE;
    v_had_previous BOOLEAN;
    v_from DATE;
    v_opening NUMERIC;
    v_lines JSONB;
    v_closing NUMERIC;
BEGIN
    SELECT * INTO v_unit FROM units WHERE id = p_unit_id;
    IF NOT FOUND OR NOT EXISTS (
        SELECT 1 FROM society_memberships m
        WHERE m.unit_id = p_unit_id AND m.user_id = auth.uid() AND m.role = 'resident_owner' AND m.is_active) THEN
        RAISE EXCEPTION 'Only the flat''s owner can see its account';
    END IF;
    IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
        RAISE EXCEPTION 'Choose a date range';
    END IF;

    -- The flat's current ownership period, shared by all its owners (a second owner has no period of their own):
    -- what happened before an owner change belongs to the previous owner's statement.
    -- It was an owner change when transfer_flat_owner made the period (created_by), or an earlier period exists
    -- (a seller who never joined has no closed period).
    SELECT o.from_date,
           o.created_by IS NOT NULL OR EXISTS (SELECT 1 FROM unit_ownerships p WHERE p.unit_id = p_unit_id AND p.to_date IS NOT NULL)
    INTO v_start, v_had_previous
    FROM unit_ownerships o
    WHERE o.unit_id = p_unit_id AND o.to_date IS NULL
    ORDER BY o.from_date DESC LIMIT 1;
    v_had_previous := coalesce(v_had_previous, false);
    IF v_had_previous AND p_to < v_start THEN
        RAISE EXCEPTION 'You became the owner on %; choose dates from then', to_char(v_start, 'DD Mon YYYY');
    END IF;
    v_from := CASE WHEN v_had_previous THEN greatest(p_from, v_start) ELSE p_from END;

    SELECT coalesce(sum(amount), 0) INTO v_opening
    FROM party_entries(v_unit.society_id)
    WHERE kind = 'flat' AND party_key = p_unit_id::text AND entry_date < v_from;

    SELECT jsonb_agg(jsonb_build_object(
               'date', x.entry_date, 'entry_number', x.entry_number, 'narration', x.narration,
               'debit', CASE WHEN x.amount > 0 THEN x.amount END,
               'credit', CASE WHEN x.amount < 0 THEN -x.amount END,
               'balance', v_opening + x.running,
               -- what the line came from: a bill (bill.*) or a receipt (payment.*) — linked only when this owner can open it
               'ref_type', j.reference_event_type,
               'ref_id', CASE
                   WHEN j.reference_event_type LIKE 'bill.%'
                        AND EXISTS (SELECT 1 FROM bills b WHERE b.id = j.reference_event_id AND b.user_id = auth.uid()) THEN j.reference_event_id
                   WHEN j.reference_event_type LIKE 'payment.%'
                        AND EXISTS (SELECT 1 FROM payments p WHERE p.id = j.reference_event_id AND p.user_id = auth.uid()) THEN j.reference_event_id
               END
           ) ORDER BY x.entry_date, x.entry_number, x.ledger_entry_id),
           v_opening + coalesce(sum(x.amount), 0)
    INTO v_lines, v_closing
    FROM (
        SELECT e.*, sum(e.amount) OVER (ORDER BY e.entry_date, e.entry_number, e.ledger_entry_id) AS running
        FROM party_entries(v_unit.society_id) e
        WHERE e.kind = 'flat' AND e.party_key = p_unit_id::text AND e.entry_date BETWEEN v_from AND p_to
    ) x
    LEFT JOIN ledger_entries le ON le.id = x.ledger_entry_id
    LEFT JOIN journal_entries j ON j.id = le.journal_entry_id;

    RETURN jsonb_build_object(
        'name', party_name(v_unit.society_id, 'flat', p_unit_id::text),
        'flat', v_unit.unit_number,
        'from', v_from, 'to', p_to,
        'opening', v_opening,
        'opening_label', CASE WHEN v_had_previous AND v_from = v_start THEN 'Brought forward from previous owner' ELSE 'Opening balance' END,
        'lines', coalesce(v_lines, '[]'::jsonb),
        'closing', coalesce(v_closing, v_opening)
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.my_flat_statement(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_flat_statement(UUID, DATE, DATE) TO authenticated;
