-- ============================================================================
-- 030 NOTIFICATIONS (Phase 3A)
--   An in-app inbox for every user, fed by database events (bills, notices,
--   complaints, payments, approvals) and by nightly dues reminders. Phones that
--   allow it get a payload-free web push; the inbox has the details.
-- ============================================================================

-- ============================================================================
-- 1. THE INBOX
-- ============================================================================
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    society_id UUID REFERENCES societies(id) ON DELETE CASCADE,
    kind VARCHAR(32) NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    link VARCHAR(32),
    ref_id UUID,
    ref_date DATE,                       -- the day a dues reminder is for (one per bill per day)
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    read_at TIMESTAMPTZ,
    pushed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unpushed ON notifications (created_at) WHERE pushed_at IS NULL;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notifications_select_own ON notifications;
CREATE POLICY notifications_select_own ON notifications FOR SELECT USING (user_id = auth.uid());

-- One row per distinct user who still belongs to the society (a removed member hears nothing)
CREATE OR REPLACE FUNCTION public.notify_users(
    p_society_id UUID, p_user_ids UUID[], p_kind TEXT, p_title TEXT, p_body TEXT, p_link TEXT, p_ref_id UUID DEFAULT NULL,
    p_ref_date DATE DEFAULT NULL
)
RETURNS INT AS $$
DECLARE
    v_count INT;
BEGIN
    INSERT INTO notifications (user_id, society_id, kind, title, body, link, ref_id, ref_date)
    SELECT DISTINCT u, p_society_id, p_kind, p_title, p_body, p_link, p_ref_id, p_ref_date
    FROM unnest(coalesce(p_user_ids, '{}'::uuid[])) AS u
    WHERE u IS NOT NULL
      AND (p_society_id IS NULL OR EXISTS (
          SELECT 1 FROM society_memberships m WHERE m.society_id = p_society_id AND m.user_id = u AND m.is_active));
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.committee_admin_ids(p_society_id UUID)
RETURNS UUID[] AS $$
    SELECT coalesce(array_agg(DISTINCT m.user_id), '{}'::uuid[])
    FROM society_memberships m
    WHERE m.society_id = p_society_id AND m.is_active AND m.role IN ('society_admin', 'secretary', 'chairman', 'treasurer')
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids UUID[] DEFAULT NULL)
RETURNS INT AS $$
DECLARE
    v_count INT;
BEGIN
    UPDATE notifications SET read_at = timezone('utc'::text, now())
    WHERE user_id = auth.uid() AND read_at IS NULL AND (p_ids IS NULL OR id = ANY (p_ids));
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.unread_notification_count()
RETURNS INT AS $$
    SELECT count(*)::int FROM notifications WHERE user_id = auth.uid() AND read_at IS NULL
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 2. EVENTS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trg_notify_bill()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IN ('issued', 'partially_paid', 'overdue') THEN
        PERFORM notify_users(NEW.society_id, ARRAY[NEW.user_id], 'bill', 'New bill ' || NEW.bill_number,
            'Flat ' || coalesce((SELECT unit_number FROM units WHERE id = NEW.unit_id), '') || ' · ' || money_text(NEW.total_amount)
                || ' due ' || to_char(NEW.due_date, 'DD Mon'),
            'bills', NEW.id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_notify_bill ON bills;
CREATE TRIGGER trg_notify_bill AFTER INSERT ON bills FOR EACH ROW EXECUTE FUNCTION public.trg_notify_bill();

-- A notice reaches its audience (and the committee), never its publisher
CREATE OR REPLACE FUNCTION public.trg_notify_notice()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM notify_users(NEW.society_id, (
        SELECT array_agg(DISTINCT m.user_id) FROM society_memberships m
        WHERE m.society_id = NEW.society_id AND m.is_active AND m.user_id <> NEW.published_by
          AND (NEW.target_audience = 'all'
               OR m.role IN ('society_admin', 'secretary', 'chairman', 'treasurer', 'committee_member')
               OR (NEW.target_audience = 'owners_only' AND m.role = 'resident_owner')
               OR (NEW.target_audience = 'tenants_only' AND m.role = 'resident_tenant'))
    ), 'notice', 'Notice: ' || NEW.title, NULL, 'notices', NEW.id);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_notify_notice ON notices;
CREATE TRIGGER trg_notify_notice AFTER INSERT ON notices FOR EACH ROW EXECUTE FUNCTION public.trg_notify_notice();

CREATE OR REPLACE FUNCTION public.trg_notify_complaint_status()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        PERFORM notify_users(NEW.society_id, ARRAY[NEW.user_id], 'complaint',
            'Complaint ' || NEW.ticket_number || ' is ' || replace(NEW.status, '_', ' '), NEW.title, 'complaints', NEW.id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_notify_complaint_status ON complaints;
CREATE TRIGGER trg_notify_complaint_status AFTER UPDATE OF status ON complaints FOR EACH ROW EXECUTE FUNCTION public.trg_notify_complaint_status();

CREATE OR REPLACE FUNCTION public.trg_notify_complaint_reply()
RETURNS TRIGGER AS $$
DECLARE
    v_c complaints%ROWTYPE;
BEGIN
    SELECT * INTO v_c FROM complaints WHERE id = NEW.complaint_id;
    IF FOUND AND NEW.author_id <> v_c.user_id THEN
        PERFORM notify_users(v_c.society_id, ARRAY[v_c.user_id], 'complaint', 'New reply on complaint ' || v_c.ticket_number,
            left(NEW.message, 140), 'complaints', v_c.id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_notify_complaint_reply ON complaint_updates;
CREATE TRIGGER trg_notify_complaint_reply AFTER INSERT ON complaint_updates FOR EACH ROW EXECUTE FUNCTION public.trg_notify_complaint_reply();

CREATE OR REPLACE FUNCTION public.trg_notify_payment()
RETURNS TRIGGER AS $$
DECLARE
    v_flat TEXT := coalesce((SELECT unit_number FROM units WHERE id = NEW.unit_id), '');
BEGIN
    IF TG_OP = 'INSERT' AND NEW.status = 'pending_verification' THEN
        PERFORM notify_users(NEW.society_id, array_remove(committee_admin_ids(NEW.society_id), NEW.user_id), 'payment_to_verify',
            'Payment to verify: Flat ' || v_flat || ' · ' || money_text(NEW.amount), NULL, 'payments', NEW.id);
    ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('verified', 'rejected') THEN
        PERFORM notify_users(NEW.society_id, ARRAY[NEW.user_id], 'payment_result',
            CASE WHEN NEW.status = 'verified' THEN 'Payment verified' ELSE 'Payment rejected' END,
            money_text(NEW.amount) || ' for Flat ' || v_flat || coalesce(' · receipt ' || NEW.receipt_number, ''), 'payments', NEW.id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_notify_payment ON payments;
CREATE TRIGGER trg_notify_payment AFTER INSERT OR UPDATE OF status ON payments FOR EACH ROW EXECUTE FUNCTION public.trg_notify_payment();

CREATE OR REPLACE FUNCTION public.trg_notify_expense()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'pending_approval' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
        PERFORM notify_users(NEW.society_id, array_remove(committee_admin_ids(NEW.society_id), NEW.created_by), 'bill_to_approve',
            'Vendor bill to approve: ' || NEW.title, money_text(NEW.subtotal + coalesce(NEW.gst_amount, 0)), 'expenses', NEW.id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_notify_expense ON expenses;
CREATE TRIGGER trg_notify_expense AFTER INSERT OR UPDATE OF status ON expenses FOR EACH ROW EXECUTE FUNCTION public.trg_notify_expense();

CREATE OR REPLACE FUNCTION public.trg_notify_proposal()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'pending' THEN
        PERFORM notify_users(NEW.society_id, array_remove(committee_admin_ids(NEW.society_id), NEW.proposed_by), 'approval_needed',
            'Approval needed: ' || NEW.proposal_number, left(NEW.reason, 140), 'approvals', NEW.id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_notify_proposal ON adjustment_proposals;
CREATE TRIGGER trg_notify_proposal AFTER INSERT ON adjustment_proposals FOR EACH ROW EXECUTE FUNCTION public.trg_notify_proposal();

CREATE OR REPLACE FUNCTION public.trg_notify_opening_balance()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM NEW.status THEN
        PERFORM notify_users(NEW.society_id, array_remove(committee_admin_ids(NEW.society_id), NEW.submitted_by), 'approval_needed',
            'Opening balance to approve', NULL, 'approvals', NEW.society_id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_notify_opening_balance ON opening_balances;
CREATE TRIGGER trg_notify_opening_balance AFTER UPDATE OF status ON opening_balances FOR EACH ROW EXECUTE FUNCTION public.trg_notify_opening_balance();

-- ============================================================================
-- 3. DUES REMINDERS ON THE COMMITTEE'S SCHEDULE
--    On day `first` after the due date, then every `every` days while unpaid.
-- ============================================================================
ALTER TABLE society_settings ADD COLUMN IF NOT EXISTS reminder_first_days INT NOT NULL DEFAULT 3
    CHECK (reminder_first_days BETWEEN 1 AND 60);
ALTER TABLE society_settings ADD COLUMN IF NOT EXISTS reminder_every_days INT NOT NULL DEFAULT 7
    CHECK (reminder_every_days BETWEEN 1 AND 60);

CREATE OR REPLACE FUNCTION public.set_reminder_schedule(p_society_id UUID, p_first INT, p_every INT)
RETURNS JSONB AS $$
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can set reminders';
    END IF;
    IF p_first IS NULL OR p_every IS NULL OR p_first NOT BETWEEN 1 AND 60 OR p_every NOT BETWEEN 1 AND 60 THEN
        RAISE EXCEPTION 'Reminders run between 1 and 60 days';
    END IF;
    UPDATE society_settings SET reminder_first_days = p_first, reminder_every_days = p_every WHERE society_id = p_society_id;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'settings.reminders', 'society', p_society_id::text,
            jsonb_build_object('first', p_first, 'every', p_every));
    RETURN jsonb_build_object('first', p_first, 'every', p_every);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- System job (pg_cron); one reminder per unpaid bill per day at most
CREATE OR REPLACE FUNCTION public.send_dues_reminders(p_as_of DATE DEFAULT current_date)
RETURNS INT AS $$
DECLARE
    r RECORD;
    v_sent INT := 0;
BEGIN
    FOR r IN
        SELECT b.id, b.society_id, b.user_id, b.balance_due, b.due_date, u.unit_number,
               s.reminder_first_days AS first_days, s.reminder_every_days AS every_days, (p_as_of - b.due_date) AS d
        FROM bills b
        JOIN units u ON u.id = b.unit_id
        JOIN society_settings s ON s.society_id = b.society_id
        WHERE b.balance_due > 0 AND b.status IN ('issued', 'partially_paid', 'overdue') AND b.due_date < p_as_of
    LOOP
        CONTINUE WHEN NOT (r.d = r.first_days OR (r.d > r.first_days AND (r.d - r.first_days) % r.every_days = 0));
        CONTINUE WHEN EXISTS (SELECT 1 FROM notifications n
                              WHERE n.kind = 'dues_reminder' AND n.ref_id = r.id AND n.ref_date = p_as_of);
        v_sent := v_sent + notify_users(r.society_id, ARRAY[r.user_id], 'dues_reminder',
            'Reminder: ' || money_text(r.balance_due) || ' due for Flat ' || r.unit_number,
            'Due since ' || to_char(r.due_date, 'DD Mon YYYY'), 'bills', r.id, p_as_of);
    END LOOP;
    RETURN v_sent;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Nightly at 01:00 IST (19:30 UTC), after the late-fee job, when pg_cron is available
DO $outer$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
        CREATE EXTENSION IF NOT EXISTS pg_cron;
        PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sahvaas-dues-reminders';
        PERFORM cron.schedule('sahvaas-dues-reminders', '30 19 * * *', $cron$SELECT public.send_dues_reminders()$cron$);
    END IF;
END
$outer$;

-- ============================================================================
-- PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.send_dues_reminders(DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_reminder_schedule(UUID, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_reminder_schedule(UUID, INT, INT) TO authenticated;
REVOKE ALL ON FUNCTION public.notify_users(UUID, UUID[], TEXT, TEXT, TEXT, TEXT, UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.committee_admin_ids(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_notify_bill() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_notify_notice() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_notify_complaint_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_notify_complaint_reply() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_notify_payment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_notify_expense() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_notify_proposal() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_notify_opening_balance() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_notifications_read(UUID[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unread_notification_count() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_notifications_read(UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unread_notification_count() TO authenticated;
