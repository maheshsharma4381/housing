-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 002: Row Level Security (RLS) & Multi-Tenant Isolation Policies
-- Target: Supabase PostgreSQL
-- ============================================================================

-- Enable RLS on all tenant and platform tables
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_access_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE societies ENABLE ROW LEVEL SECURITY;
ALTER TABLE society_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE buildings ENABLE ROW LEVEL SECURITY;
ALTER TABLE wings ENABLE ROW LEVEL SECURITY;
ALTER TABLE floors ENABLE ROW LEVEL SECURITY;
ALTER TABLE units ENABLE ROW LEVEL SECURITY;
ALTER TABLE parking_slots ENABLE ROW LEVEL SECURITY;

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE society_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;

ALTER TABLE professional_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE society_professional_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE professional_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_logs ENABLE ROW LEVEL SECURITY;

ALTER TABLE billing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;

ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE funds ENABLE ROW LEVEL SECURITY;

ALTER TABLE gst_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE gst_2b_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE gst_2b_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE gst_reconciliations ENABLE ROW LEVEL SECURITY;

ALTER TABLE notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_metrics ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- HELPER FUNCTIONS FOR SECURITY CONTEXT EVALUATION
-- ============================================================================

-- Check if current user is an active Platform Super Admin
CREATE OR REPLACE FUNCTION is_platform_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM platform_admins 
    WHERE user_id = auth.uid() 
      AND is_active = true
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Check if current user is an authorized Society Admin / Committee member
CREATE OR REPLACE FUNCTION is_society_admin(target_society_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM society_memberships 
    WHERE society_id = target_society_id
      AND user_id = auth.uid()
      AND is_active = true
      AND role IN ('society_admin', 'secretary', 'chairman', 'treasurer')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Check if current user belongs to the society (resident, committee or admin)
CREATE OR REPLACE FUNCTION has_society_membership(target_society_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM society_memberships 
    WHERE society_id = target_society_id
      AND user_id = auth.uid()
      AND is_active = true
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Check if current user is an active professional with a granted permission
CREATE OR REPLACE FUNCTION has_professional_permission(target_society_id UUID, required_permission TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM society_professional_access 
    WHERE society_id = target_society_id
      AND professional_user_id = auth.uid()
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND permissions ? required_permission
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- 1. PLATFORM POLICIES
-- ============================================================================
CREATE POLICY platform_admins_policy ON platform_admins
    FOR ALL USING (is_platform_admin());

CREATE POLICY platform_settings_select ON platform_settings
    FOR SELECT USING (true);

CREATE POLICY platform_settings_modify ON platform_settings
    FOR ALL USING (is_platform_admin());

CREATE POLICY platform_features_select ON platform_features
    FOR SELECT USING (true);

CREATE POLICY support_sessions_policy ON support_access_sessions
    FOR ALL USING (is_platform_admin());

-- ============================================================================
-- 2. SOCIETY & INFRASTRUCTURE POLICIES
-- ============================================================================
CREATE POLICY societies_select ON societies
    FOR SELECT USING (
        is_platform_admin() 
        OR has_society_membership(id)
        OR EXISTS (
            SELECT 1 FROM society_professional_access 
            WHERE society_id = societies.id 
              AND professional_user_id = auth.uid() 
              AND status = 'active'
        )
    );

CREATE POLICY societies_admin_modify ON societies
    FOR UPDATE USING (is_platform_admin() OR is_society_admin(id));

CREATE POLICY units_select ON units
    FOR SELECT USING (
        is_platform_admin() 
        OR has_society_membership(society_id)
        OR has_professional_permission(society_id, 'view_units')
    );

CREATE POLICY units_admin_modify ON units
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id));

-- ============================================================================
-- 3. PROFILES & MEMBERSHIPS POLICIES
-- ============================================================================
CREATE POLICY profiles_self_read ON profiles
    FOR SELECT USING (id = auth.uid() OR is_platform_admin());

CREATE POLICY profiles_self_update ON profiles
    FOR UPDATE USING (id = auth.uid());

CREATE POLICY memberships_select ON society_memberships
    FOR SELECT USING (
        is_platform_admin()
        OR user_id = auth.uid()
        OR is_society_admin(society_id)
    );

CREATE POLICY memberships_admin_write ON society_memberships
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id));

-- ============================================================================
-- 4. PROFESSIONAL ACCESS POLICIES
-- ============================================================================
CREATE POLICY professional_profiles_self ON professional_profiles
    FOR ALL USING (user_id = auth.uid() OR is_platform_admin());

CREATE POLICY society_pro_access_read ON society_professional_access
    FOR SELECT USING (
        is_platform_admin()
        OR professional_user_id = auth.uid()
        OR is_society_admin(society_id)
    );

CREATE POLICY society_pro_access_write ON society_professional_access
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id));

CREATE POLICY access_logs_insert ON access_logs
    FOR INSERT WITH CHECK (professional_user_id = auth.uid());

CREATE POLICY access_logs_select ON access_logs
    FOR SELECT USING (is_platform_admin() OR is_society_admin(society_id));

-- ============================================================================
-- 5. BILLING & PAYMENTS POLICIES (ISOLATED TO OWNER & COMMITTEE)
-- ============================================================================
CREATE POLICY bills_select ON bills
    FOR SELECT USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR user_id = auth.uid()
        OR has_professional_permission(society_id, 'view_bills')
    );

CREATE POLICY bills_admin_write ON bills
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id));

CREATE POLICY payments_select ON payments
    FOR SELECT USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR user_id = auth.uid()
        OR has_professional_permission(society_id, 'view_payments')
    );

CREATE POLICY payments_resident_insert ON payments
    FOR INSERT WITH CHECK (
        user_id = auth.uid() 
        AND has_society_membership(society_id)
    );

CREATE POLICY payments_admin_verify ON payments
    FOR UPDATE USING (is_platform_admin() OR is_society_admin(society_id));

-- ============================================================================
-- 6. EXPENSES & BANK ACCOUNTS POLICIES
-- ============================================================================
CREATE POLICY bank_accounts_policy ON bank_accounts
    FOR ALL USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR has_professional_permission(society_id, 'view_bank_reconciliation')
    );

CREATE POLICY expenses_select ON expenses
    FOR SELECT USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR has_professional_permission(society_id, 'view_expenses')
    );

CREATE POLICY expenses_admin_write ON expenses
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id));

-- ============================================================================
-- 7. FINANCIAL ENGINE & LEDGER POLICIES
-- ============================================================================
CREATE POLICY ledger_select ON ledger_entries
    FOR SELECT USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR has_professional_permission(society_id, 'view_ledger')
    );

CREATE POLICY accounts_select ON accounts
    FOR SELECT USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR has_professional_permission(society_id, 'view_reports')
    );

-- ============================================================================
-- 8. GST MODULE POLICIES
-- ============================================================================
CREATE POLICY gst_profile_select ON gst_profiles
    FOR SELECT USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR has_professional_permission(society_id, 'audit_gst')
    );

CREATE POLICY gst_2b_uploads_policy ON gst_2b_uploads
    FOR ALL USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR has_professional_permission(society_id, 'audit_gst')
    );

CREATE POLICY gst_2b_invoices_policy ON gst_2b_invoices
    FOR ALL USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR has_professional_permission(society_id, 'audit_gst')
    );

-- ============================================================================
-- 9. NOTICES, COMPLAINTS & DOCUMENTS
-- ============================================================================
CREATE POLICY notices_select ON notices
    FOR SELECT USING (
        is_platform_admin()
        OR has_society_membership(society_id)
    );

CREATE POLICY notices_admin_write ON notices
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id));

CREATE POLICY complaints_select ON complaints
    FOR SELECT USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR user_id = auth.uid()
    );

CREATE POLICY complaints_insert ON complaints
    FOR INSERT WITH CHECK (
        user_id = auth.uid()
        AND has_society_membership(society_id)
    );

CREATE POLICY complaints_update ON complaints
    FOR UPDATE USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR user_id = auth.uid()
    );

CREATE POLICY documents_select ON documents
    FOR SELECT USING (
        is_platform_admin()
        OR (has_society_membership(society_id) AND (NOT is_restricted_to_committee OR is_society_admin(society_id)))
        OR has_professional_permission(society_id, 'view_documents')
    );

CREATE POLICY documents_admin_write ON documents
    FOR ALL USING (is_platform_admin() OR is_society_admin(society_id));

-- ============================================================================
-- 10. AUDIT LOGS POLICIES
-- ============================================================================
CREATE POLICY audit_logs_select ON audit_logs
    FOR SELECT USING (
        is_platform_admin() 
        OR (society_id IS NOT NULL AND is_society_admin(society_id))
        OR (society_id IS NOT NULL AND has_professional_permission(society_id, 'view_audit_logs'))
    );

CREATE POLICY audit_logs_insert ON audit_logs
    FOR INSERT WITH CHECK (auth.uid() = user_id);
