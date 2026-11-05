-- ============================================================================
-- 035 THE SECRETARY'S HOME (Phase 4C, spec 9.4)
--   Four cards in one call, and one tap to remind every overdue flat.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.home_cards(p_society_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_today DATE := current_date;
BEGIN
    IF NOT (is_platform_admin() OR is_committee_viewer(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can see this';
    END IF;
    RETURN jsonb_build_object(
        'to_receive', (
            SELECT jsonb_build_object(
                'amount', coalesce(sum(b.balance_due), 0),
                'flats', count(DISTINCT b.unit_id),
                'overdue_flats', count(DISTINCT b.unit_id) FILTER (WHERE b.due_date < v_today))
            FROM bills b
            WHERE b.society_id = p_society_id AND b.balance_due > 0 AND b.status IN ('issued', 'partially_paid', 'overdue')),
        'to_pay', (
            -- what the vendors are still owed in cash: the bill less what is settled and the TDS still to deduct
            -- (invoice_due_by is the date to attach a missing invoice, not a payment due date:
            --  a bill is due 30 days after its invoice, or after it was recorded)
            SELECT jsonb_build_object(
                'amount', coalesce(sum(x.cash), 0),
                'vendors', count(DISTINCT x.who),
                'due_this_week', count(*) FILTER (WHERE x.due <= v_today + 7))
            FROM (
                SELECT e.subtotal + e.gst_amount - e.amount_settled - greatest(e.tds_amount - e.tds_deducted, 0) AS cash,
                       coalesce(e.vendor_id::text, e.payee_name, e.title) AS who,
                       coalesce(e.invoice_date, e.created_at::date) + 30 AS due
                FROM expenses e
                WHERE e.society_id = p_society_id AND e.status = 'approved'
            ) x
            WHERE x.cash > 0.005),
        'approvals', (
            SELECT jsonb_build_object('vendor_bills', v, 'adjustments', a, 'opening_balance', o, 'join_requests', j, 'total', v + a + o + j)
            FROM (SELECT
                (SELECT count(*) FROM expenses WHERE society_id = p_society_id AND status = 'pending_approval') AS v,
                (SELECT count(*) FROM adjustment_proposals WHERE society_id = p_society_id AND status = 'pending') AS a,
                (SELECT count(*) FROM opening_balances WHERE society_id = p_society_id AND status = 'submitted') AS o,
                (SELECT count(*) FROM join_requests WHERE society_id = p_society_id AND status = 'pending') AS j) c),
        'payments_to_verify', (SELECT count(*) FROM payments WHERE society_id = p_society_id AND status = 'pending_verification')
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- "Send reminder to N overdue flats": one notification per flat (its oldest overdue bill), at most once a day per bill
CREATE OR REPLACE FUNCTION public.remind_overdue_flats(p_society_id UUID)
RETURNS JSONB AS $$
DECLARE
    r RECORD;
    v_reminded INT := 0;
    v_waiting INT := 0;
    v_not_joined INT := 0;
    v_already INT := 0;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can send reminders';
    END IF;
    FOR r IN
        SELECT DISTINCT ON (b.unit_id) b.id, b.unit_id, b.user_id, b.due_date, u.unit_number,
               (SELECT sum(x.balance_due) FROM bills x WHERE x.unit_id = b.unit_id AND x.balance_due > 0
                  AND x.status IN ('issued', 'partially_paid', 'overdue') AND x.due_date < current_date) AS overdue,
               EXISTS (SELECT 1 FROM society_memberships m WHERE m.unit_id = b.unit_id AND m.user_id = b.user_id
                         AND m.role = 'resident_owner' AND m.is_active) AS owner_joined,
               EXISTS (SELECT 1 FROM payments p WHERE p.unit_id = b.unit_id AND p.status = 'pending_verification') AS paid_waiting,
               -- reminded today already (by the nightly job or an earlier tap), about any of the flat's bills
               EXISTS (SELECT 1 FROM notifications n JOIN bills x ON x.id = n.ref_id
                       WHERE n.kind = 'dues_reminder' AND n.ref_date = current_date AND x.unit_id = b.unit_id) AS reminded_today
        FROM bills b JOIN units u ON u.id = b.unit_id
        WHERE b.society_id = p_society_id AND b.balance_due > 0 AND b.status IN ('issued', 'partially_paid', 'overdue')
          AND b.due_date < current_date
        ORDER BY b.unit_id, b.due_date, b.created_at
    LOOP
        IF NOT r.owner_joined THEN
            v_not_joined := v_not_joined + 1;
        ELSIF r.paid_waiting THEN
            v_waiting := v_waiting + 1;
        ELSIF r.reminded_today THEN
            v_already := v_already + 1;
        ELSE
            v_reminded := v_reminded + notify_users(p_society_id, ARRAY[r.user_id], 'dues_reminder',
                'Maintenance due: Flat ' || r.unit_number,
                money_text(r.overdue) || ' overdue since ' || to_char(r.due_date, 'DD Mon YYYY'), 'bills', r.id, current_date);
        END IF;
    END LOOP;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'dues.reminders_sent', 'society', p_society_id::text,
            jsonb_build_object('reminded', v_reminded, 'payment_waiting', v_waiting, 'not_joined', v_not_joined, 'already_today', v_already));
    RETURN jsonb_build_object('reminded', v_reminded, 'payment_waiting', v_waiting, 'not_joined', v_not_joined, 'already_today', v_already);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.home_cards(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remind_overdue_flats(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.home_cards(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remind_overdue_flats(UUID) TO authenticated;
