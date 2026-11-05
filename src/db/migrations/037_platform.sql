-- ============================================================================
-- 037 THE PLATFORM OWNER'S DASHBOARD (Phase 6, spec 11 items 2–5)
--   Setup funnel, society health, revenue, a read-only support view that is
--   time-limited, audit-logged and announced to the committee, and announcements.
-- ============================================================================

-- ============================================================================
-- 2. SETUP FUNNEL (from 034's setup_events)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.platform_setup_funnel()
RETURNS JSONB AS $$
DECLARE
    v_order TEXT[] := ARRAY['society', 'flats', 'maintenance', 'upi', 'owners', 'first_bill'];
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Only the platform owner can see this';
    END IF;
    RETURN (
        WITH ev AS (
            -- "Skip" on the owners step counts as passing it
            SELECT society_id, CASE WHEN step = 'owners_skipped' THEN 'owners' ELSE step END AS step, created_at FROM setup_events
        ),
        per AS (
            SELECT s.id, array_agg(DISTINCT ev.step) AS steps
            FROM societies s JOIN ev ON ev.society_id = s.id
            GROUP BY s.id
        ),
        stopped AS (
            SELECT (SELECT st FROM unnest(v_order[2:]) WITH ORDINALITY AS o(st, n) WHERE NOT st = ANY (per.steps) ORDER BY n LIMIT 1) AS at
            FROM per WHERE NOT 'first_bill' = ANY (per.steps)
        ),
        firsts AS (
            SELECT extract(epoch FROM (fb.created_at - p.created_at)) / 60 AS minutes
            FROM setup_events fb
            JOIN society_memberships m ON m.society_id = fb.society_id AND m.is_primary_contact
            JOIN profiles p ON p.id = m.user_id
            WHERE fb.step = 'first_bill'
        )
        SELECT jsonb_build_object(
            'steps', (SELECT jsonb_agg(jsonb_build_object('step', st, 'reached', (SELECT count(*) FROM per WHERE st = ANY (per.steps))) ORDER BY n)
                      FROM unnest(v_order) WITH ORDINALITY AS o(st, n)),
            'stopped_at', coalesce((SELECT jsonb_object_agg(at, c) FROM (SELECT at, count(*) c FROM stopped WHERE at IS NOT NULL GROUP BY at) x), '{}'::jsonb),
            'first_bill', jsonb_build_object(
                'societies', (SELECT count(*) FROM firsts),
                'median_minutes', (SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes))::numeric, 1) FROM firsts))
        )
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. SOCIETY HEALTH (one row per society)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.platform_society_health()
RETURNS TABLE (society_id UUID, name TEXT, city TEXT, flats INT, owners_joined_pct NUMERIC, collection_pct NUMERIC,
               ca_invited BOOLEAN, opening_approved BOOLEAN, last_active TIMESTAMPTZ, flag TEXT) AS $$
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Only the platform owner can see this';
    END IF;
    RETURN QUERY
    SELECT s.id, s.name::TEXT, s.city::TEXT, x.flats::INT,
           CASE WHEN x.flats = 0 THEN 0 ELSE round(100.0 * x.joined / x.flats, 1) END,
           CASE WHEN x.billed = 0 THEN 0 ELSE round(100.0 * x.collected / x.billed, 1) END,
           x.ca, x.ob,
           x.active,
           CASE
               -- a week after starting and still no first bill: call them
               WHEN s.created_at < now() - interval '7 days'
                    AND NOT EXISTS (SELECT 1 FROM setup_events e WHERE e.society_id = s.id AND e.step = 'first_bill')
                    AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.society_id = s.id) THEN 'stuck'
               WHEN x.active < now() - interval '30 days' THEN 'quiet'
           END
    FROM societies s
    CROSS JOIN LATERAL (
        SELECT
            (SELECT count(*) FROM units u WHERE u.society_id = s.id) AS flats,
            (SELECT count(DISTINCT m.unit_id) FROM society_memberships m
             WHERE m.society_id = s.id AND m.role = 'resident_owner' AND m.is_active AND m.unit_id IS NOT NULL) AS joined,
            (SELECT coalesce(sum(b.total_amount), 0) FROM bills b
             WHERE b.society_id = s.id AND b.status <> 'cancelled' AND b.bill_date >= date_trunc('month', current_date)::date) AS billed,
            (SELECT coalesce(sum(b.total_amount - b.balance_due), 0) FROM bills b
             WHERE b.society_id = s.id AND b.status <> 'cancelled' AND b.bill_date >= date_trunc('month', current_date)::date) AS collected,
            EXISTS (SELECT 1 FROM professional_invites pi WHERE pi.society_id = s.id)
              OR EXISTS (SELECT 1 FROM society_professional_access a WHERE a.society_id = s.id) AS ca,
            EXISTS (SELECT 1 FROM opening_balances o WHERE o.society_id = s.id AND o.status = 'approved') AS ob,
            greatest(s.created_at,
                     (SELECT max(l."timestamp") FROM audit_logs l WHERE l.society_id = s.id),
                     (SELECT max(p.created_at) FROM payments p WHERE p.society_id = s.id)) AS active
    ) x
    WHERE s.is_active
    ORDER BY s.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 4. REVENUE
-- ============================================================================
CREATE OR REPLACE FUNCTION public.platform_revenue()
RETURNS JSONB AS $$
DECLARE
    v_month_start DATE := date_trunc('month', current_date)::date;
    v_month_end DATE := (date_trunc('month', current_date) + interval '1 month - 1 day')::date;
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Only the platform owner can see this';
    END IF;
    RETURN (
        WITH b AS (SELECT * FROM platform_billing_overview())
        SELECT jsonb_build_object(
            'plans', coalesce((SELECT jsonb_object_agg(k, c) FROM (
                SELECT CASE WHEN in_trial THEN 'trial' ELSE coalesce(plan_code, 'free') END AS k, count(*) c FROM b GROUP BY 1) p), '{}'::jsonb),
            'mrr', (SELECT coalesce(sum(monthly_value), 0) FROM b WHERE NOT in_trial AND coalesce(plan_code, 'free') <> 'free'),
            'trials_ending_this_week', (SELECT count(*) FROM b WHERE in_trial AND trial_ends_on BETWEEN current_date AND current_date + 7),
            'unpaid_invoices', (SELECT jsonb_build_object('count', count(*), 'total', coalesce(sum(total), 0))
                                FROM platform_invoices WHERE status = 'issued'),
            -- free-plan economics: what sponsors pay this month against what login codes cost
            'ads_this_month', (SELECT coalesce(sum(monthly_price), 0) FROM ad_campaigns
                               WHERE status = 'live' AND starts_on <= v_month_end AND ends_on >= v_month_start),
            'otp_cost_this_month', (SELECT coalesce(sum(cost), 0) FROM otp_log WHERE created_at >= v_month_start)
        )
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. SUPPORT: VIEW A SOCIETY READ-ONLY (one hour, audit-logged, the committee is told)
-- ============================================================================
CREATE TABLE IF NOT EXISTS support_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    admin_id UUID NOT NULL REFERENCES profiles(id),
    reason TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_sessions_open ON support_sessions (society_id, admin_id, expires_at);
ALTER TABLE support_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON support_sessions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.start_support_view(p_society_id UUID, p_reason TEXT)
RETURNS JSONB AS $$
DECLARE
    v_id UUID;
    v_expires TIMESTAMPTZ := timezone('utc'::text, now()) + interval '1 hour';
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Only the platform owner can open a society for support';
    END IF;
    IF length(trim(coalesce(p_reason, ''))) < 3 THEN
        RAISE EXCEPTION 'Say why you are opening this society';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM societies WHERE id = p_society_id) THEN
        RAISE EXCEPTION 'Society not found';
    END IF;
    INSERT INTO support_sessions (society_id, admin_id, reason, expires_at)
    VALUES (p_society_id, auth.uid(), trim(p_reason), v_expires) RETURNING id INTO v_id;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'support.view_started', 'support_session', v_id::text, jsonb_build_object('reason', trim(p_reason)));
    PERFORM notify_users(p_society_id, committee_admin_ids(p_society_id), 'support_view',
        'Sahvaas support viewed your society on ' || to_char(timezone('Asia/Kolkata', now()), 'DD Mon YYYY'),
        'Read-only, for one hour. Reason: ' || trim(p_reason), NULL, v_id);
    RETURN jsonb_build_object('session_id', v_id, 'expires_at', v_expires);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.support_snapshot(p_society_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_session support_sessions%ROWTYPE;
    v_soc societies%ROWTYPE;
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Only the platform owner can open a society for support';
    END IF;
    SELECT * INTO v_session FROM support_sessions
    WHERE society_id = p_society_id AND admin_id = auth.uid() AND expires_at > timezone('utc'::text, now())
    ORDER BY expires_at DESC LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Start a support session first (it lasts one hour)';
    END IF;
    SELECT * INTO v_soc FROM societies WHERE id = p_society_id;
    -- every view is in the society's audit log
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'support.viewed', 'support_session', v_session.id::text, '{}'::jsonb);
    RETURN jsonb_build_object(
        'expires_at', v_session.expires_at,
        'society', jsonb_build_object('name', v_soc.name, 'city', v_soc.city, 'state', v_soc.state, 'created_at', v_soc.created_at),
        'setup', setup_status(p_society_id),
        'cards', home_cards(p_society_id),
        'members', (SELECT jsonb_build_object('active', count(*) FILTER (WHERE is_active),
                                              'owners', count(*) FILTER (WHERE is_active AND role = 'resident_owner'))
                    FROM society_memberships WHERE society_id = p_society_id),
        'bills', coalesce((SELECT jsonb_agg(x ORDER BY x.created_at DESC) FROM (
            SELECT b.bill_number, u.unit_number, b.total_amount, b.balance_due, b.status, b.due_date, b.created_at
            FROM bills b JOIN units u ON u.id = b.unit_id WHERE b.society_id = p_society_id ORDER BY b.created_at DESC LIMIT 20) x), '[]'::jsonb),
        'payments', coalesce((SELECT jsonb_agg(x ORDER BY x.created_at DESC) FROM (
            SELECT p.payment_number, u.unit_number, p.amount, p.status, p.payment_date, p.created_at
            FROM payments p JOIN units u ON u.id = p.unit_id WHERE p.society_id = p_society_id ORDER BY p.created_at DESC LIMIT 20) x), '[]'::jsonb),
        'complaints', coalesce((SELECT jsonb_agg(x ORDER BY x.created_at DESC) FROM (
            SELECT c.title, c.status, c.created_at FROM complaints c
            WHERE c.society_id = p_society_id AND c.status IN ('open', 'in_progress') ORDER BY c.created_at DESC LIMIT 20) x), '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5b. ANNOUNCEMENTS TO SECRETARIES (in-app and push through notifications)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.platform_announce(p_title TEXT, p_body TEXT, p_plan TEXT DEFAULT NULL, p_state TEXT DEFAULT NULL)
RETURNS INT AS $$
DECLARE
    r RECORD;
    v_sent INT := 0;
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Only the platform owner can send announcements';
    END IF;
    IF length(trim(coalesce(p_title, ''))) < 3 THEN
        RAISE EXCEPTION 'Give the announcement a title';
    END IF;
    FOR r IN
        SELECT s.id FROM societies s
        LEFT JOIN platform_billing_overview() b ON b.society_id = s.id
        WHERE s.is_active
          AND (nullif(trim(coalesce(p_state, '')), '') IS NULL OR lower(s.state) = lower(trim(p_state)))
          AND (nullif(trim(coalesce(p_plan, '')), '') IS NULL
               OR (CASE WHEN b.in_trial THEN 'trial' ELSE coalesce(b.plan_code, 'free') END) = trim(p_plan))
    LOOP
        v_sent := v_sent + notify_users(r.id, committee_admin_ids(r.id), 'announcement', trim(p_title), nullif(trim(coalesce(p_body, '')), ''), NULL, NULL);
    END LOOP;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (NULL, auth.uid(), 'platform.announcement', 'announcement', 'all',
            jsonb_build_object('title', p_title, 'plan', p_plan, 'state', p_state, 'sent', v_sent));
    RETURN v_sent;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.platform_setup_funnel() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_society_health() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_revenue() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.start_support_view(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.support_snapshot(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_announce(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_setup_funnel() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_society_health() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_revenue() TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_support_view(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.support_snapshot(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_announce(TEXT, TEXT, TEXT, TEXT) TO authenticated;
