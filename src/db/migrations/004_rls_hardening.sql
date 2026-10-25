-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 004: RLS Hardening & Missing Policies
-- Target: Supabase PostgreSQL
--
-- Fixes (see PROJECT_AUDIT.md §5.5 / §5.6):
--   * Pin search_path on SECURITY DEFINER functions
--   * Residents can no longer self-verify payments or edit complaint workflow fields
--   * Clients can no longer forge audit_logs / access_logs
--   * Professionals with view permissions can no longer modify bank accounts
--   * Adds policies for tables that had RLS enabled but no policy (fully blocked)
--
-- Safe to re-run: every policy is dropped before being (re)created.
-- ============================================================================

-- ============================================================================
-- 0. SECURITY DEFINER HARDENING
-- ============================================================================
ALTER FUNCTION public.is_platform_admin() SET search_path = public;
ALTER FUNCTION public.is_society_admin(UUID) SET search_path = public;
ALTER FUNCTION public.has_society_membership(UUID) SET search_path = public;
ALTER FUNCTION public.has_professional_permission(UUID, TEXT) SET search_path = public;
ALTER FUNCTION public.handle_new_user() SET search_path = public;
ALTER FUNCTION public.get_user_authorized_societies() SET search_path = public;
ALTER FUNCTION public.get_professional_authorized_societies() SET search_path = public;

-- Helper: is the current user an active professional with ANY grant on the society
CREATE OR REPLACE FUNCTION public.has_active_professional_grant(target_society_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.society_professional_access
    WHERE society_id = target_society_id
      AND professional_user_id = auth.uid()
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public;

-- ============================================================================
-- 1. PAYMENTS: residents may only submit pending, unverified payments
--    for their own unit and (optionally) their own bill
-- ============================================================================
DROP POLICY IF EXISTS payments_resident_insert ON payments;
CREATE POLICY payments_resident_insert ON payments
    FOR INSERT WITH CHECK (
        user_id = auth.uid()
        AND status = 'pending_verification'
        AND verified_by IS NULL
        AND verified_at IS NULL
        AND receipt_number IS NULL
        AND amount > 0
        AND EXISTS (
            SELECT 1 FROM society_memberships m
            WHERE m.user_id = auth.uid()
              AND m.society_id = payments.society_id
              AND m.unit_id = payments.unit_id
              AND m.is_active = true
        )
        AND (
            payments.bill_id IS NULL
            OR EXISTS (
                SELECT 1 FROM bills b
                WHERE b.id = payments.bill_id
                  AND b.user_id = auth.uid()
                  AND b.society_id = payments.society_id
            )
        )
    );

-- ============================================================================
-- 2. COMPLAINTS: residents may edit their ticket text, not the workflow fields
-- ============================================================================
CREATE OR REPLACE FUNCTION public.complaints_guard_resident_update()
RETURNS TRIGGER AS $$
BEGIN
  IF public.is_platform_admin() OR public.is_society_admin(OLD.society_id) THEN
    RETURN NEW;
  END IF;

  IF NEW.society_id      IS DISTINCT FROM OLD.society_id
  OR NEW.unit_id         IS DISTINCT FROM OLD.unit_id
  OR NEW.user_id         IS DISTINCT FROM OLD.user_id
  OR NEW.ticket_number   IS DISTINCT FROM OLD.ticket_number
  OR NEW.status          IS DISTINCT FROM OLD.status
  OR NEW.assigned_to     IS DISTINCT FROM OLD.assigned_to
  OR NEW.resolved_at     IS DISTINCT FROM OLD.resolved_at
  OR NEW.resolution_notes IS DISTINCT FROM OLD.resolution_notes THEN
    RAISE EXCEPTION 'Only the society committee can change complaint status, assignment or resolution';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_complaints_guard_resident_update ON complaints;
CREATE TRIGGER trg_complaints_guard_resident_update
  BEFORE UPDATE ON complaints
  FOR EACH ROW EXECUTE FUNCTION public.complaints_guard_resident_update();

DROP POLICY IF EXISTS complaints_insert ON complaints;
CREATE POLICY complaints_insert ON complaints
    FOR INSERT WITH CHECK (
        user_id = auth.uid()
        AND status = 'open'
        AND assigned_to IS NULL
        AND EXISTS (
            SELECT 1 FROM society_memberships m
            WHERE m.user_id = auth.uid()
              AND m.society_id = complaints.society_id
              AND m.unit_id = complaints.unit_id
              AND m.is_active = true
        )
    );

-- ============================================================================
-- 3. AUDIT & ACCESS LOGS: no forging from the client
-- ============================================================================
-- audit_logs are written only by SECURITY DEFINER functions / triggers
DROP POLICY IF EXISTS audit_logs_insert ON audit_logs;

DROP POLICY IF EXISTS access_logs_insert ON access_logs;
CREATE POLICY access_logs_insert ON access_logs
    FOR INSERT WITH CHECK (
        professional_user_id = auth.uid()
        AND public.has_active_professional_grant(society_id)
    );

-- ============================================================================
-- 4. BANK ACCOUNTS: split read (incl. professionals) from write (admins only)
-- ============================================================================
DROP POLICY IF EXISTS bank_accounts_policy ON bank_accounts;
DROP POLICY IF EXISTS bank_accounts_select ON bank_accounts;
DROP POLICY IF EXISTS bank_accounts_admin_write ON bank_accounts;
CREATE POLICY bank_accounts_select ON bank_accounts
    FOR SELECT USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR has_professional_permission(society_id, 'view_bank_reconciliation')
    );
CREATE POLICY bank_accounts_admin_write ON bank_accounts
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));

-- ============================================================================
-- 5. SOCIETIES & PROFILES
-- ============================================================================
-- Society creation is platform-admin only until a self-serve onboarding RPC exists
DROP POLICY IF EXISTS societies_platform_insert ON societies;
CREATE POLICY societies_platform_insert ON societies
    FOR INSERT WITH CHECK (is_platform_admin());

-- Society admins can see basic profiles of their own members
DROP POLICY IF EXISTS profiles_society_admin_read ON profiles;
CREATE POLICY profiles_society_admin_read ON profiles
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM society_memberships m
            WHERE m.user_id = profiles.id
              AND m.is_active = true
              AND is_society_admin(m.society_id)
        )
    );

-- ============================================================================
-- 6. TABLES THAT HAD RLS ENABLED BUT NO POLICIES
-- ============================================================================

-- society_settings: members need UPI details to pay
DROP POLICY IF EXISTS society_settings_select ON society_settings;
DROP POLICY IF EXISTS society_settings_admin_write ON society_settings;
CREATE POLICY society_settings_select ON society_settings
    FOR SELECT USING (
        is_platform_admin()
        OR has_society_membership(society_id)
        OR has_active_professional_grant(society_id)
    );
CREATE POLICY society_settings_admin_write ON society_settings
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));

-- Physical structure: buildings / wings / floors / parking_slots
DROP POLICY IF EXISTS buildings_select ON buildings;
DROP POLICY IF EXISTS buildings_admin_write ON buildings;
CREATE POLICY buildings_select ON buildings
    FOR SELECT USING (
        is_platform_admin() OR has_society_membership(society_id)
        OR has_professional_permission(society_id, 'view_units')
    );
CREATE POLICY buildings_admin_write ON buildings
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));

DROP POLICY IF EXISTS wings_select ON wings;
DROP POLICY IF EXISTS wings_admin_write ON wings;
CREATE POLICY wings_select ON wings
    FOR SELECT USING (
        is_platform_admin() OR has_society_membership(society_id)
        OR has_professional_permission(society_id, 'view_units')
    );
CREATE POLICY wings_admin_write ON wings
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));

DROP POLICY IF EXISTS floors_select ON floors;
DROP POLICY IF EXISTS floors_admin_write ON floors;
CREATE POLICY floors_select ON floors
    FOR SELECT USING (
        is_platform_admin() OR has_society_membership(society_id)
        OR has_professional_permission(society_id, 'view_units')
    );
CREATE POLICY floors_admin_write ON floors
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));

DROP POLICY IF EXISTS parking_slots_select ON parking_slots;
DROP POLICY IF EXISTS parking_slots_admin_write ON parking_slots;
CREATE POLICY parking_slots_select ON parking_slots
    FOR SELECT USING (is_platform_admin() OR has_society_membership(society_id));
CREATE POLICY parking_slots_admin_write ON parking_slots
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));

-- family_members / vehicles: owner manages own rows, committee sees all
DROP POLICY IF EXISTS family_members_select ON family_members;
DROP POLICY IF EXISTS family_members_write ON family_members;
CREATE POLICY family_members_select ON family_members
    FOR SELECT USING (
        is_platform_admin() OR is_society_admin(society_id) OR primary_user_id = auth.uid()
    );
CREATE POLICY family_members_write ON family_members
    FOR ALL USING (
        is_platform_admin() OR is_society_admin(society_id) OR primary_user_id = auth.uid()
    )
    WITH CHECK (
        is_platform_admin() OR is_society_admin(society_id)
        OR (primary_user_id = auth.uid() AND has_society_membership(society_id))
    );

DROP POLICY IF EXISTS vehicles_select ON vehicles;
DROP POLICY IF EXISTS vehicles_write ON vehicles;
CREATE POLICY vehicles_select ON vehicles
    FOR SELECT USING (
        is_platform_admin() OR is_society_admin(society_id) OR user_id = auth.uid()
    );
CREATE POLICY vehicles_write ON vehicles
    FOR ALL USING (
        is_platform_admin() OR is_society_admin(society_id) OR user_id = auth.uid()
    )
    WITH CHECK (
        is_platform_admin() OR is_society_admin(society_id)
        OR (user_id = auth.uid() AND has_society_membership(society_id))
    );

-- professional_invites: committee manages; invitee can see invites sent to their email
DROP POLICY IF EXISTS professional_invites_select ON professional_invites;
DROP POLICY IF EXISTS professional_invites_admin_write ON professional_invites;
CREATE POLICY professional_invites_select ON professional_invites
    FOR SELECT USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR lower(invited_email) = lower(auth.jwt() ->> 'email')
    );
CREATE POLICY professional_invites_admin_write ON professional_invites
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));

-- Billing configuration
DROP POLICY IF EXISTS billing_rules_select ON billing_rules;
DROP POLICY IF EXISTS billing_rules_admin_write ON billing_rules;
CREATE POLICY billing_rules_select ON billing_rules
    FOR SELECT USING (
        is_platform_admin() OR has_society_membership(society_id)
        OR has_professional_permission(society_id, 'view_bills')
    );
CREATE POLICY billing_rules_admin_write ON billing_rules
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));

DROP POLICY IF EXISTS billing_cycles_select ON billing_cycles;
DROP POLICY IF EXISTS billing_cycles_admin_write ON billing_cycles;
CREATE POLICY billing_cycles_select ON billing_cycles
    FOR SELECT USING (
        is_platform_admin() OR has_society_membership(society_id)
        OR has_professional_permission(society_id, 'view_bills')
    );
CREATE POLICY billing_cycles_admin_write ON billing_cycles
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));

-- bill_items follow the visibility of their parent bill
DROP POLICY IF EXISTS bill_items_select ON bill_items;
DROP POLICY IF EXISTS bill_items_admin_write ON bill_items;
CREATE POLICY bill_items_select ON bill_items
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM bills b
            WHERE b.id = bill_items.bill_id
              AND (
                is_platform_admin()
                OR is_society_admin(b.society_id)
                OR b.user_id = auth.uid()
                OR has_professional_permission(b.society_id, 'view_bills')
              )
        )
    );
CREATE POLICY bill_items_admin_write ON bill_items
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM bills b
            WHERE b.id = bill_items.bill_id
              AND (is_platform_admin() OR is_society_admin(b.society_id))
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM bills b
            WHERE b.id = bill_items.bill_id
              AND (is_platform_admin() OR is_society_admin(b.society_id))
        )
    );

-- Bank statement lines
DROP POLICY IF EXISTS bank_transactions_select ON bank_transactions;
DROP POLICY IF EXISTS bank_transactions_admin_write ON bank_transactions;
CREATE POLICY bank_transactions_select ON bank_transactions
    FOR SELECT USING (
        is_platform_admin() OR is_society_admin(society_id)
        OR has_professional_permission(society_id, 'view_bank_reconciliation')
    );
CREATE POLICY bank_transactions_admin_write ON bank_transactions
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));

-- Vendors
DROP POLICY IF EXISTS vendors_select ON vendors;
DROP POLICY IF EXISTS vendors_admin_write ON vendors;
CREATE POLICY vendors_select ON vendors
    FOR SELECT USING (
        is_platform_admin() OR is_society_admin(society_id)
        OR has_professional_permission(society_id, 'view_expenses')
    );
CREATE POLICY vendors_admin_write ON vendors
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));

-- Accounting: journal entries are read-only for clients (posted by triggers)
DROP POLICY IF EXISTS journal_entries_select ON journal_entries;
CREATE POLICY journal_entries_select ON journal_entries
    FOR SELECT USING (
        is_platform_admin() OR is_society_admin(society_id)
        OR has_professional_permission(society_id, 'view_ledger')
    );

-- Chart of accounts can be extended by the committee (system accounts stay locked)
DROP POLICY IF EXISTS accounts_admin_write ON accounts;
CREATE POLICY accounts_admin_write ON accounts
    FOR ALL USING (
        (is_platform_admin() OR is_society_admin(society_id)) AND is_system = false
    )
    WITH CHECK (
        (is_platform_admin() OR is_society_admin(society_id)) AND is_system = false
    );

DROP POLICY IF EXISTS funds_select ON funds;
DROP POLICY IF EXISTS funds_admin_write ON funds;
CREATE POLICY funds_select ON funds
    FOR SELECT USING (
        is_platform_admin() OR has_society_membership(society_id)
        OR has_professional_permission(society_id, 'view_reports')
    );
CREATE POLICY funds_admin_write ON funds
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));

-- GST
DROP POLICY IF EXISTS gst_profile_admin_write ON gst_profiles;
CREATE POLICY gst_profile_admin_write ON gst_profiles
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));

DROP POLICY IF EXISTS gst_reconciliations_policy ON gst_reconciliations;
CREATE POLICY gst_reconciliations_policy ON gst_reconciliations
    FOR ALL USING (
        is_platform_admin() OR is_society_admin(society_id)
        OR has_professional_permission(society_id, 'audit_gst')
    )
    WITH CHECK (
        is_platform_admin() OR is_society_admin(society_id)
        OR has_professional_permission(society_id, 'audit_gst')
    );

-- ============================================================================
-- 7. PLATFORM / SAAS TABLES
-- ============================================================================
DROP POLICY IF EXISTS platform_features_modify ON platform_features;
CREATE POLICY platform_features_modify ON platform_features
    FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());

DROP POLICY IF EXISTS subscription_plans_select ON subscription_plans;
DROP POLICY IF EXISTS subscription_plans_modify ON subscription_plans;
CREATE POLICY subscription_plans_select ON subscription_plans
    FOR SELECT USING (is_active = true OR is_platform_admin());
CREATE POLICY subscription_plans_modify ON subscription_plans
    FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());

DROP POLICY IF EXISTS subscriptions_select ON subscriptions;
DROP POLICY IF EXISTS subscriptions_modify ON subscriptions;
CREATE POLICY subscriptions_select ON subscriptions
    FOR SELECT USING (is_platform_admin() OR is_society_admin(society_id));
CREATE POLICY subscriptions_modify ON subscriptions
    FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());

DROP POLICY IF EXISTS usage_metrics_select ON usage_metrics;
DROP POLICY IF EXISTS usage_metrics_modify ON usage_metrics;
CREATE POLICY usage_metrics_select ON usage_metrics
    FOR SELECT USING (is_platform_admin() OR is_society_admin(society_id));
CREATE POLICY usage_metrics_modify ON usage_metrics
    FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());
