-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 001: Initial Multi-Tenant Schema Architecture
-- Target: PostgreSQL / Supabase
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. PLATFORM LEVEL TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform_admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL, -- references auth.users(id)
    role VARCHAR(32) NOT NULL DEFAULT 'super_admin',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_platform_admin_user UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS platform_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key VARCHAR(64) NOT NULL UNIQUE,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    description TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS platform_features (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    feature_key VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(128) NOT NULL,
    description TEXT,
    is_globally_enabled BOOLEAN NOT NULL DEFAULT true,
    min_plan_tier VARCHAR(32) NOT NULL DEFAULT 'starter',
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS support_access_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform_admin_id UUID NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
    society_id UUID NOT NULL,
    reason TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    expires_at TIMESTAMPTZ NOT NULL,
    is_revoked BOOLEAN NOT NULL DEFAULT false
);

-- ============================================================================
-- 2. SOCIETIES & GEOGRAPHY (MULTI-TENANCY ROOT)
-- ============================================================================

CREATE TABLE IF NOT EXISTS societies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(191) NOT NULL,
    slug VARCHAR(96) NOT NULL UNIQUE,
    registration_number VARCHAR(96),
    gstin VARCHAR(15),
    address_line1 TEXT NOT NULL,
    address_line2 TEXT,
    city VARCHAR(96) NOT NULL,
    state VARCHAR(96) NOT NULL,
    pincode VARCHAR(12) NOT NULL,
    total_units INT NOT NULL DEFAULT 0,
    contact_email VARCHAR(191) NOT NULL,
    contact_phone VARCHAR(32) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    subscription_status VARCHAR(32) NOT NULL DEFAULT 'trial' CHECK (subscription_status IN ('trial', 'active', 'suspended', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS society_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL UNIQUE REFERENCES societies(id) ON DELETE CASCADE,
    due_day_of_month SMALLINT NOT NULL DEFAULT 10,
    late_fee_type VARCHAR(16) NOT NULL DEFAULT 'percentage' CHECK (late_fee_type IN ('flat', 'percentage', 'none')),
    late_fee_amount NUMERIC(10,2) NOT NULL DEFAULT 2.00,
    currency VARCHAR(8) NOT NULL DEFAULT 'INR',
    upi_id VARCHAR(128),
    upi_payee_name VARCHAR(128),
    qr_code_url TEXT,
    fiscal_year_start_month SMALLINT NOT NULL DEFAULT 4, -- April for India
    require_two_step_expense_approval BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS buildings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    name VARCHAR(96) NOT NULL,
    code VARCHAR(32) NOT NULL,
    total_floors INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_building_code UNIQUE(society_id, code)
);

CREATE TABLE IF NOT EXISTS wings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    building_id UUID NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    name VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_building_wing UNIQUE(building_id, name)
);

CREATE TABLE IF NOT EXISTS floors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    wing_id UUID NOT NULL REFERENCES wings(id) ON DELETE CASCADE,
    floor_number SMALLINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS units (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    building_id UUID NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    wing_id UUID NOT NULL REFERENCES wings(id) ON DELETE CASCADE,
    floor_id UUID REFERENCES floors(id) ON DELETE SET NULL,
    unit_number VARCHAR(32) NOT NULL,
    unit_type VARCHAR(32) NOT NULL DEFAULT '2BHK',
    carpet_area_sqft NUMERIC(8,2) NOT NULL DEFAULT 0.00,
    super_builtup_sqft NUMERIC(8,2) DEFAULT 0.00,
    occupancy_status VARCHAR(32) NOT NULL DEFAULT 'owner_occupied' CHECK (occupancy_status IN ('owner_occupied', 'tenant_occupied', 'vacant', 'under_renovation')),
    current_owner_id UUID, -- references profiles(id)
    current_tenant_id UUID, -- references profiles(id)
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_wing_unit UNIQUE(society_id, wing_id, unit_number)
);

CREATE TABLE IF NOT EXISTS parking_slots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    slot_number VARCHAR(32) NOT NULL,
    slot_type VARCHAR(32) NOT NULL DEFAULT 'covered_4w',
    assigned_unit_id UUID REFERENCES units(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_parking_slot UNIQUE(society_id, slot_number)
);

-- ============================================================================
-- 3. USERS, PROFILES & SOCIETY MEMBERSHIPS
-- ============================================================================

CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY, -- matches auth.users.id
    full_name VARCHAR(191) NOT NULL,
    email VARCHAR(191) NOT NULL UNIQUE,
    phone VARCHAR(32),
    avatar_url TEXT,
    is_platform_admin BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS society_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    role VARCHAR(32) NOT NULL DEFAULT 'resident_owner' CHECK (role IN (
        'society_admin',
        'secretary',
        'chairman',
        'treasurer',
        'committee_member',
        'resident_owner',
        'resident_tenant'
    )),
    unit_id UUID REFERENCES units(id) ON DELETE SET NULL,
    is_primary_contact BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    joined_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_user_unit UNIQUE(society_id, user_id, unit_id)
);

CREATE TABLE IF NOT EXISTS family_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    primary_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    full_name VARCHAR(191) NOT NULL,
    relationship VARCHAR(64) NOT NULL,
    phone VARCHAR(32),
    is_emergency_contact BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS vehicles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    vehicle_type VARCHAR(32) NOT NULL DEFAULT '4_wheeler',
    registration_number VARCHAR(32) NOT NULL,
    parking_slot_id UUID REFERENCES parking_slots(id) ON DELETE SET NULL,
    tag_rfid VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_vehicle_reg UNIQUE(society_id, registration_number)
);

-- ============================================================================
-- 4. PROFESSIONAL ACCESS MODEL (CA, AUDITOR, TAX, GST)
-- ============================================================================

CREATE TABLE IF NOT EXISTS professional_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
    firm_name VARCHAR(191) NOT NULL,
    profession VARCHAR(32) NOT NULL CHECK (profession IN (
        'ca',
        'auditor',
        'accountant',
        'tax_consultant',
        'gst_consultant',
        'financial_consultant'
    )),
    membership_number VARCHAR(64),
    gstin VARCHAR(15),
    verified BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS society_professional_access (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    professional_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    role VARCHAR(32) NOT NULL CHECK (role IN (
        'ca',
        'auditor',
        'accountant',
        'tax_consultant',
        'gst_consultant',
        'financial_consultant'
    )),
    status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'expired', 'revoked')),
    permissions JSONB NOT NULL DEFAULT '["view_reports"]'::jsonb,
    granted_by UUID NOT NULL REFERENCES profiles(id),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revocation_reason TEXT,
    notes TEXT,
    CONSTRAINT uq_society_professional UNIQUE(society_id, professional_user_id)
);

CREATE TABLE IF NOT EXISTS professional_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    invited_email VARCHAR(191) NOT NULL,
    role VARCHAR(32) NOT NULL,
    permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
    invited_by UUID NOT NULL REFERENCES profiles(id),
    invitation_token VARCHAR(128) NOT NULL UNIQUE,
    status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS access_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    professional_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    module_accessed VARCHAR(64) NOT NULL,
    action_performed VARCHAR(64) NOT NULL,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- ============================================================================
-- 5. BILLING & INVOICING
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL,
    description TEXT,
    calculation_type VARCHAR(32) NOT NULL DEFAULT 'flat_per_unit' CHECK (calculation_type IN ('flat_per_unit', 'per_sqft', 'metered', 'manual')),
    rate NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    applies_to_unit_type VARCHAR(32),
    tax_rate_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    hsn_sac_code VARCHAR(16) DEFAULT '999598',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS billing_cycles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    cycle_name VARCHAR(128) NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    due_date DATE NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'generated', 'published')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_billing_cycle UNIQUE(society_id, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS bills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    cycle_id UUID NOT NULL REFERENCES billing_cycles(id) ON DELETE CASCADE,
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    bill_number VARCHAR(64) NOT NULL,
    bill_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE NOT NULL,
    subtotal_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    interest_or_late_fee NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    total_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    balance_due NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    status VARCHAR(32) NOT NULL DEFAULT 'issued' CHECK (status IN ('draft', 'issued', 'partially_paid', 'paid', 'overdue', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_bill_number UNIQUE(society_id, bill_number)
);

CREATE TABLE IF NOT EXISTS bill_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_id UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    rule_id UUID REFERENCES billing_rules(id) ON DELETE SET NULL,
    description VARCHAR(255) NOT NULL,
    quantity NUMERIC(10,2) NOT NULL DEFAULT 1.00,
    unit_rate NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    total_item_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00
);

-- ============================================================================
-- 6. PAYMENTS, BANK ACCOUNTS & RECONCILIATIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS bank_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    bank_name VARCHAR(128) NOT NULL,
    account_number VARCHAR(64) NOT NULL,
    ifsc_code VARCHAR(16) NOT NULL,
    branch_name VARCHAR(128) NOT NULL,
    account_type VARCHAR(32) NOT NULL DEFAULT 'current' CHECK (account_type IN ('current', 'savings', 'fd')),
    opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    current_balance NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    is_primary BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_account_no UNIQUE(society_id, account_number)
);

CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    bill_id UUID REFERENCES bills(id) ON DELETE SET NULL,
    payment_number VARCHAR(64) NOT NULL,
    amount NUMERIC(12,2) NOT NULL,
    payment_method VARCHAR(32) NOT NULL DEFAULT 'upi' CHECK (payment_method IN ('upi', 'neft_rtgs', 'cheque', 'cash')),
    transaction_reference_utr VARCHAR(128) NOT NULL,
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(32) NOT NULL DEFAULT 'pending_verification' CHECK (status IN ('pending_verification', 'verified', 'rejected', 'refunded')),
    bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,
    verification_notes TEXT,
    verified_by UUID REFERENCES profiles(id),
    verified_at TIMESTAMPTZ,
    receipt_number VARCHAR(64),
    receipt_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_payment_number UNIQUE(society_id, payment_number)
);

CREATE TABLE IF NOT EXISTS bank_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    bank_account_id UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
    transaction_date DATE NOT NULL,
    value_date DATE NOT NULL,
    description TEXT NOT NULL,
    reference_number VARCHAR(128),
    type VARCHAR(16) NOT NULL CHECK (type IN ('credit', 'debit')),
    amount NUMERIC(14,2) NOT NULL,
    running_balance NUMERIC(14,2),
    is_reconciled BOOLEAN NOT NULL DEFAULT false,
    reconciled_payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- ============================================================================
-- 7. VENDORS & EXPENSES
-- ============================================================================

CREATE TABLE IF NOT EXISTS vendors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    name VARCHAR(191) NOT NULL,
    category VARCHAR(64) NOT NULL DEFAULT 'other',
    contact_person VARCHAR(128),
    phone VARCHAR(32) NOT NULL,
    email VARCHAR(191),
    gstin VARCHAR(15),
    pan VARCHAR(10),
    bank_name VARCHAR(128),
    account_number VARCHAR(64),
    ifsc VARCHAR(16),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
    expense_number VARCHAR(64) NOT NULL,
    category VARCHAR(64) NOT NULL,
    title VARCHAR(191) NOT NULL,
    description TEXT,
    invoice_number VARCHAR(96),
    invoice_date DATE,
    subtotal NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    gst_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    tds_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    net_payable NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    status VARCHAR(32) NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'paid', 'voided')),
    payment_status VARCHAR(16) NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid')),
    approved_by UUID REFERENCES profiles(id),
    approved_at TIMESTAMPTZ,
    paid_date DATE,
    payment_reference VARCHAR(128),
    document_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_expense_number UNIQUE(society_id, expense_number)
);

-- ============================================================================
-- 8. FINANCIAL ENGINE & LEDGERS (AUTOMATED DUAL ENTRY BEHIND REAL EVENTS)
-- ============================================================================

CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    code VARCHAR(32) NOT NULL,
    name VARCHAR(128) NOT NULL,
    type VARCHAR(32) NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
    parent_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    is_system BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_account_code UNIQUE(society_id, code)
);

CREATE TABLE IF NOT EXISTS journal_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    entry_number VARCHAR(64) NOT NULL,
    entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
    reference_event_type VARCHAR(64) NOT NULL,
    reference_event_id UUID NOT NULL,
    narration TEXT NOT NULL,
    is_posted BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_journal_number UNIQUE(society_id, entry_number)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    amount NUMERIC(14,2) NOT NULL, -- positive = debit, negative = credit
    balance_after NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    narration TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS funds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL,
    purpose TEXT,
    target_balance NUMERIC(14,2),
    current_balance NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- ============================================================================
-- 9. GST MODULE (GSTR-2B EXCEL/JSON MVP ENGINE)
-- ============================================================================

CREATE TABLE IF NOT EXISTS gst_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL UNIQUE REFERENCES societies(id) ON DELETE CASCADE,
    gstin VARCHAR(15) NOT NULL UNIQUE,
    legal_name VARCHAR(191) NOT NULL,
    trade_name VARCHAR(191) NOT NULL,
    filing_frequency VARCHAR(16) NOT NULL DEFAULT 'monthly' CHECK (filing_frequency IN ('monthly', 'quarterly')),
    is_composition BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS gst_2b_uploads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    return_period VARCHAR(12) NOT NULL, -- e.g. "102026"
    file_name VARCHAR(255) NOT NULL,
    file_format VARCHAR(16) NOT NULL CHECK (file_format IN ('json', 'excel')),
    uploaded_by UUID NOT NULL REFERENCES profiles(id),
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    total_invoices_found INT NOT NULL DEFAULT 0,
    total_taxable_value NUMERIC(14,2) NOT NULL DEFAULT 0.00,
    total_igst NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    total_cgst NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    total_sgst NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    reconciliation_status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (reconciliation_status IN ('pending', 'in_progress', 'completed'))
);

CREATE TABLE IF NOT EXISTS gst_2b_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    upload_id UUID NOT NULL REFERENCES gst_2b_uploads(id) ON DELETE CASCADE,
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    supplier_gstin VARCHAR(15) NOT NULL,
    supplier_trade_name VARCHAR(191) NOT NULL,
    invoice_number VARCHAR(96) NOT NULL,
    invoice_type VARCHAR(32) NOT NULL DEFAULT 'B2B',
    invoice_date DATE NOT NULL,
    invoice_value NUMERIC(12,2) NOT NULL,
    taxable_value NUMERIC(12,2) NOT NULL,
    igst NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    cgst NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    sgst NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    itc_availability VARCHAR(4) NOT NULL DEFAULT 'Y',
    reconciliation_match_status VARCHAR(32) NOT NULL DEFAULT 'missing_in_books' CHECK (
        reconciliation_match_status IN ('exact_match', 'partial_match', 'missing_in_books', 'missing_in_2b')
    )
);

CREATE TABLE IF NOT EXISTS gst_reconciliations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    period VARCHAR(12) NOT NULL,
    total_books_invoices INT NOT NULL DEFAULT 0,
    total_portal_invoices INT NOT NULL DEFAULT 0,
    matched_count INT NOT NULL DEFAULT 0,
    mismatched_count INT NOT NULL DEFAULT 0,
    reviewed_by UUID REFERENCES profiles(id),
    reviewed_at TIMESTAMPTZ,
    review_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- ============================================================================
-- 10. COMMUNICATIONS, COMPLAINTS & DOCUMENTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS notices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    title VARCHAR(191) NOT NULL,
    content TEXT NOT NULL,
    category VARCHAR(32) NOT NULL DEFAULT 'general' CHECK (category IN ('general', 'agm_egm', 'maintenance', 'water_power', 'emergency')),
    is_pinned BOOLEAN NOT NULL DEFAULT false,
    published_by UUID NOT NULL REFERENCES profiles(id),
    published_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    expires_at TIMESTAMPTZ,
    attachment_url TEXT,
    target_audience VARCHAR(32) NOT NULL DEFAULT 'all' CHECK (target_audience IN ('all', 'owners_only', 'tenants_only', 'committee_only'))
);

CREATE TABLE IF NOT EXISTS complaints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    ticket_number VARCHAR(32) NOT NULL,
    category VARCHAR(32) NOT NULL DEFAULT 'other',
    title VARCHAR(191) NOT NULL,
    description TEXT NOT NULL,
    priority VARCHAR(16) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    status VARCHAR(32) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    assigned_to UUID REFERENCES profiles(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    resolution_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_complaint_ticket UNIQUE(society_id, ticket_number)
);

CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    category VARCHAR(32) NOT NULL DEFAULT 'financials' CHECK (category IN ('bylaws', 'conveyance', 'audit_reports', 'agm_minutes', 'insurance', 'noc_forms', 'financials')),
    title VARCHAR(191) NOT NULL,
    description TEXT,
    file_url TEXT NOT NULL,
    file_size_kb INT NOT NULL DEFAULT 0,
    uploaded_by UUID NOT NULL REFERENCES profiles(id),
    is_restricted_to_committee BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- ============================================================================
-- 11. AUDIT TRAILS, SUBSCRIPTIONS & PLATFORM USAGE
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID REFERENCES societies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id),
    action VARCHAR(64) NOT NULL,
    entity_type VARCHAR(64) NOT NULL,
    entity_id VARCHAR(64) NOT NULL,
    old_value JSONB,
    new_value JSONB,
    reason TEXT,
    ip_address VARCHAR(45),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS subscription_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(96) NOT NULL,
    tier_code VARCHAR(32) NOT NULL UNIQUE,
    monthly_rate_per_unit_inr NUMERIC(8,2) NOT NULL DEFAULT 15.00,
    max_units INT NOT NULL DEFAULT 500,
    features_included JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL UNIQUE REFERENCES societies(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES subscription_plans(id),
    billing_term VARCHAR(16) NOT NULL DEFAULT 'annual' CHECK (billing_term IN ('monthly', 'annual')),
    status VARCHAR(32) NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'active', 'past_due', 'suspended')),
    current_period_start DATE NOT NULL DEFAULT CURRENT_DATE,
    current_period_end DATE NOT NULL,
    unit_count INT NOT NULL DEFAULT 0,
    auto_renew BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS usage_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    metric_month VARCHAR(7) NOT NULL, -- e.g. "2026-10"
    active_members_count INT NOT NULL DEFAULT 0,
    bills_issued INT NOT NULL DEFAULT 0,
    payments_processed INT NOT NULL DEFAULT 0,
    storage_bytes_used BIGINT NOT NULL DEFAULT 0,
    ai_tokens_consumed BIGINT NOT NULL DEFAULT 0,
    api_requests_count BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_month_metric UNIQUE(society_id, metric_month)
);

-- ============================================================================
-- INDEXES FOR MULTI-TENANCY & QUERY PERFORMANCE
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_memberships_society_user ON society_memberships(society_id, user_id);
CREATE INDEX IF NOT EXISTS idx_units_society_id ON units(society_id);
CREATE INDEX IF NOT EXISTS idx_bills_society_user ON bills(society_id, user_id);
CREATE INDEX IF NOT EXISTS idx_payments_society_unit ON payments(society_id, unit_id);
CREATE INDEX IF NOT EXISTS idx_bank_tx_society_acc ON bank_transactions(society_id, bank_account_id);
CREATE INDEX IF NOT EXISTS idx_expenses_society_id ON expenses(society_id);
CREATE INDEX IF NOT EXISTS idx_audit_society_timestamp ON audit_logs(society_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_pro_access_society ON society_professional_access(society_id, professional_user_id);
CREATE INDEX IF NOT EXISTS idx_complaints_society_status ON complaints(society_id, status);
