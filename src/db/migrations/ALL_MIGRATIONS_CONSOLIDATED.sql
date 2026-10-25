-- ============================================================================
-- SAHVAAS: ALL MIGRATIONS CONSOLIDATED (001 + 002 + 003 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011 + 012 + 013 + 014 + 015 + 016 + 017)
-- Generated from the individual files - edit those, then regenerate this file.
-- Run once on a FRESH Supabase project (SQL Editor).
-- ============================================================================

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


-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 003: Auth Security, Profile Triggers & Privilege Escalation Hardening
-- Target: Supabase PostgreSQL
-- ============================================================================

-- 1. Automated Profile Creation Trigger on Auth Signup
-- When a user registers through Supabase Auth, securely insert a corresponding profile row.
-- Automatically enforces that is_platform_admin is ALWAYS false on creation.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    full_name,
    email,
    phone,
    is_platform_admin,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      split_part(NEW.email, '@', 1)
    ),
    NEW.email,
    NEW.phone,
    false, -- STRICT: Prevent self-promotion to Platform Admin
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Bind trigger to auth.users table
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 2. Prevent Privilege Escalation in Profiles
-- Users can update their own personal info (full_name, phone, avatar_url)
-- but MUST NEVER be able to update is_platform_admin.
DROP POLICY IF EXISTS profiles_self_update ON public.profiles;

CREATE POLICY profiles_self_update ON public.profiles
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    -- Ensure is_platform_admin cannot be changed by non-platform admins
    AND (
      is_platform_admin = (SELECT is_platform_admin FROM public.profiles WHERE id = auth.uid())
      OR public.is_platform_admin()
    )
  );

-- 3. Secure Helper: Get User's Authorized Societies
-- Returns list of society IDs that the authenticated user actually belongs to.
CREATE OR REPLACE FUNCTION public.get_user_authorized_societies()
RETURNS TABLE (
  society_id UUID,
  society_name VARCHAR,
  role VARCHAR,
  is_primary BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    s.id AS society_id,
    s.name AS society_name,
    sm.role::VARCHAR AS role,
    sm.is_primary_contact AS is_primary
  FROM public.society_memberships sm
  JOIN public.societies s ON s.id = sm.society_id
  WHERE sm.user_id = auth.uid()
    AND sm.is_active = true
    AND s.is_active = true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 4. Secure Helper: Get User's Active Professional Society Grants
CREATE OR REPLACE FUNCTION public.get_professional_authorized_societies()
RETURNS TABLE (
  society_id UUID,
  society_name VARCHAR,
  role VARCHAR,
  permissions JSONB,
  expires_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    s.id AS society_id,
    s.name AS society_name,
    spa.role::VARCHAR AS role,
    spa.permissions,
    spa.expires_at
  FROM public.society_professional_access spa
  JOIN public.societies s ON s.id = spa.society_id
  WHERE spa.professional_user_id = auth.uid()
    AND spa.status = 'active'
    AND (spa.expires_at IS NULL OR spa.expires_at > now())
    AND s.is_active = true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;


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


-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 005: Self-serve Onboarding
--   * create_society()      - any signed-in user can register a society and
--                             becomes its first committee member
--   * bulk_upsert_units()   - committee imports buildings / wings / flats (CSV)
--   * member_invites        - committee invites residents by email
--   * claim_my_invites()    - invitee turns pending invites into memberships
--                             once their email is verified
-- Safe to re-run.
-- ============================================================================

-- Floors need a natural key so imports can upsert them
CREATE UNIQUE INDEX IF NOT EXISTS uq_wing_floor ON floors(wing_id, floor_number);

-- ============================================================================
-- 1. MEMBER INVITES
-- ============================================================================
CREATE TABLE IF NOT EXISTS member_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    email VARCHAR(191) NOT NULL,
    full_name VARCHAR(191),
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
    invited_by UUID NOT NULL REFERENCES profiles(id),
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
    accepted_user_id UUID REFERENCES profiles(id),
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- One pending invite per email per flat (or per society when no flat)
CREATE UNIQUE INDEX IF NOT EXISTS uq_member_invite_pending
    ON member_invites (society_id, lower(email), coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_member_invites_email_pending
    ON member_invites (lower(email)) WHERE status = 'pending';

ALTER TABLE member_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS member_invites_select ON member_invites;
DROP POLICY IF EXISTS member_invites_admin_insert ON member_invites;
DROP POLICY IF EXISTS member_invites_admin_update ON member_invites;
DROP POLICY IF EXISTS member_invites_admin_delete ON member_invites;

CREATE POLICY member_invites_select ON member_invites
    FOR SELECT USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR lower(email) = lower(auth.jwt() ->> 'email')
    );

CREATE POLICY member_invites_admin_insert ON member_invites
    FOR INSERT WITH CHECK (
        (is_platform_admin() OR is_society_admin(society_id))
        AND invited_by = auth.uid()
        AND status = 'pending'
        AND accepted_user_id IS NULL
        AND (
            unit_id IS NULL
            OR EXISTS (SELECT 1 FROM units u WHERE u.id = member_invites.unit_id AND u.society_id = member_invites.society_id)
        )
    );

CREATE POLICY member_invites_admin_update ON member_invites
    FOR UPDATE USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));

CREATE POLICY member_invites_admin_delete ON member_invites
    FOR DELETE USING (is_platform_admin() OR is_society_admin(society_id));

-- ============================================================================
-- 2. CREATE SOCIETY
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_society(
    p_name TEXT,
    p_address_line1 TEXT,
    p_city TEXT,
    p_state TEXT,
    p_pincode TEXT,
    p_contact_email TEXT,
    p_contact_phone TEXT,
    p_registration_number TEXT DEFAULT NULL,
    p_address_line2 TEXT DEFAULT NULL,
    p_creator_role TEXT DEFAULT 'secretary'
)
RETURNS UUID AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_society_id UUID;
    v_slug TEXT;
    v_recent INT;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'You must be signed in to register a society';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_uid) THEN
        RAISE EXCEPTION 'Profile not found for current user';
    END IF;
    IF length(trim(coalesce(p_name, ''))) < 3 THEN
        RAISE EXCEPTION 'Society name must be at least 3 characters';
    END IF;
    IF coalesce(p_pincode, '') !~ '^[0-9]{6}$' THEN
        RAISE EXCEPTION 'Pincode must be 6 digits';
    END IF;
    IF length(trim(coalesce(p_address_line1, ''))) = 0
       OR length(trim(coalesce(p_city, ''))) = 0
       OR length(trim(coalesce(p_state, ''))) = 0 THEN
        RAISE EXCEPTION 'Address, city and state are required';
    END IF;
    IF coalesce(p_contact_email, '') !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
        RAISE EXCEPTION 'A valid contact email is required';
    END IF;
    IF length(regexp_replace(coalesce(p_contact_phone, ''), '[^0-9]', '', 'g')) < 10 THEN
        RAISE EXCEPTION 'A valid 10-digit contact phone is required';
    END IF;
    IF p_creator_role NOT IN ('society_admin', 'secretary', 'chairman', 'treasurer') THEN
        RAISE EXCEPTION 'Creator role must be secretary, chairman, treasurer or society_admin';
    END IF;

    -- Basic abuse guard: max 3 new societies per user per day
    SELECT count(*) INTO v_recent
    FROM society_memberships
    WHERE user_id = v_uid AND created_at > now() - interval '1 day'
      AND role IN ('society_admin', 'secretary', 'chairman', 'treasurer')
      AND unit_id IS NULL;
    IF v_recent >= 3 AND NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Too many societies created today. Please contact support.';
    END IF;

    v_slug := trim(BOTH '-' FROM left(lower(regexp_replace(trim(p_name), '[^a-zA-Z0-9]+', '-', 'g')), 80));
    IF v_slug = '' THEN
        v_slug := 'society';
    END IF;
    IF EXISTS (SELECT 1 FROM societies WHERE slug = v_slug) THEN
        v_slug := v_slug || '-' || substr(md5(random()::text), 1, 6);
    END IF;

    INSERT INTO societies (
        name, slug, registration_number, address_line1, address_line2,
        city, state, pincode, contact_email, contact_phone
    ) VALUES (
        trim(p_name), v_slug, nullif(trim(p_registration_number), ''), trim(p_address_line1), nullif(trim(p_address_line2), ''),
        trim(p_city), trim(p_state), p_pincode, lower(trim(p_contact_email)), trim(p_contact_phone)
    )
    RETURNING id INTO v_society_id;

    INSERT INTO society_settings (society_id) VALUES (v_society_id);

    INSERT INTO society_memberships (society_id, user_id, role, is_primary_contact)
    VALUES (v_society_id, v_uid, p_creator_role, true);

    -- Default chart of accounts (used by the ledger engine in a later phase)
    INSERT INTO accounts (society_id, code, name, type, is_system) VALUES
        (v_society_id, '1000', 'Bank Accounts',               'asset',     true),
        (v_society_id, '1100', 'Cash in Hand',                'asset',     true),
        (v_society_id, '1200', 'Members Receivable',          'asset',     true),
        (v_society_id, '2000', 'Sundry Creditors',            'liability', true),
        (v_society_id, '2100', 'GST Payable',                 'liability', true),
        (v_society_id, '2200', 'TDS Payable',                 'liability', true),
        (v_society_id, '2300', 'Advance Maintenance Received','liability', true),
        (v_society_id, '3000', 'Sinking Fund',                'equity',    true),
        (v_society_id, '3100', 'Repair & Maintenance Fund',   'equity',    true),
        (v_society_id, '3200', 'General Reserve',             'equity',    true),
        (v_society_id, '4000', 'Maintenance Charges',         'income',    true),
        (v_society_id, '4100', 'Interest on Late Payment',    'income',    true),
        (v_society_id, '4200', 'Other Income',                'income',    true),
        (v_society_id, '5000', 'Repairs & Maintenance',       'expense',   true),
        (v_society_id, '5100', 'Security Charges',            'expense',   true),
        (v_society_id, '5200', 'Housekeeping',                'expense',   true),
        (v_society_id, '5300', 'Electricity (Common Areas)',  'expense',   true),
        (v_society_id, '5400', 'Water Charges',               'expense',   true),
        (v_society_id, '5900', 'Other Expenses',              'expense',   true);

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_society_id, v_uid, 'society.created', 'society', v_society_id::text,
            jsonb_build_object('name', trim(p_name), 'slug', v_slug));

    RETURN v_society_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. BULK UNIT IMPORT
--    p_units: [{ "building": "Tower A", "wing": "A", "floor": 1,
--                "unit_number": "A-101", "unit_type": "2BHK",
--                "carpet_area_sqft": 650, "occupancy_status": "owner_occupied" }]
-- ============================================================================
CREATE OR REPLACE FUNCTION public.bulk_upsert_units(p_society_id UUID, p_units JSONB)
RETURNS JSONB AS $$
DECLARE
    v_row JSONB;
    v_idx INT := 0;
    v_inserted INT := 0;
    v_updated INT := 0;
    v_building TEXT;
    v_wing TEXT;
    v_floor INT;
    v_unit_number TEXT;
    v_unit_type TEXT;
    v_area NUMERIC;
    v_occupancy TEXT;
    v_building_id UUID;
    v_wing_id UUID;
    v_floor_id UUID;
    v_was_insert BOOLEAN;
    v_total INT;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can import units';
    END IF;
    IF jsonb_typeof(p_units) <> 'array' THEN
        RAISE EXCEPTION 'Units payload must be a JSON array';
    END IF;
    IF jsonb_array_length(p_units) = 0 THEN
        RAISE EXCEPTION 'No units to import';
    END IF;
    IF jsonb_array_length(p_units) > 2000 THEN
        RAISE EXCEPTION 'Import at most 2000 units at a time';
    END IF;

    FOR v_row IN SELECT * FROM jsonb_array_elements(p_units) LOOP
        v_idx := v_idx + 1;

        v_building    := coalesce(nullif(trim(v_row ->> 'building'), ''), 'Main');
        v_wing        := coalesce(nullif(trim(v_row ->> 'wing'), ''), 'A');
        v_unit_number := nullif(trim(v_row ->> 'unit_number'), '');
        v_unit_type   := coalesce(nullif(trim(v_row ->> 'unit_type'), ''), '2BHK');
        v_occupancy   := coalesce(nullif(trim(v_row ->> 'occupancy_status'), ''), 'owner_occupied');

        IF v_unit_number IS NULL THEN
            RAISE EXCEPTION 'Row %: unit_number is required', v_idx;
        END IF;
        IF length(v_unit_number) > 32 OR length(v_wing) > 32 OR length(v_building) > 96 OR length(v_unit_type) > 32 THEN
            RAISE EXCEPTION 'Row %: a value is too long', v_idx;
        END IF;
        IF v_occupancy NOT IN ('owner_occupied', 'tenant_occupied', 'vacant', 'under_renovation') THEN
            RAISE EXCEPTION 'Row %: occupancy_status "%" is invalid', v_idx, v_occupancy;
        END IF;

        BEGIN
            v_floor := nullif(trim(v_row ->> 'floor'), '')::INT;
            v_area  := coalesce(nullif(trim(v_row ->> 'carpet_area_sqft'), '')::NUMERIC, 0);
        EXCEPTION WHEN invalid_text_representation THEN
            RAISE EXCEPTION 'Row %: floor and carpet_area_sqft must be numbers', v_idx;
        END;
        IF v_area < 0 OR v_area > 999999 THEN
            RAISE EXCEPTION 'Row %: carpet_area_sqft is out of range', v_idx;
        END IF;

        INSERT INTO buildings (society_id, name, code, total_floors)
        VALUES (p_society_id, v_building, upper(left(regexp_replace(v_building, '\s+', '', 'g'), 32)), greatest(coalesce(v_floor, 0), 1))
        ON CONFLICT (society_id, code) DO UPDATE
            SET total_floors = greatest(buildings.total_floors, EXCLUDED.total_floors)
        RETURNING id INTO v_building_id;

        INSERT INTO wings (society_id, building_id, name)
        VALUES (p_society_id, v_building_id, v_wing)
        ON CONFLICT (building_id, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id INTO v_wing_id;

        v_floor_id := NULL;
        IF v_floor IS NOT NULL THEN
            INSERT INTO floors (society_id, wing_id, floor_number)
            VALUES (p_society_id, v_wing_id, v_floor)
            ON CONFLICT (wing_id, floor_number) DO UPDATE SET floor_number = EXCLUDED.floor_number
            RETURNING id INTO v_floor_id;
        END IF;

        INSERT INTO units (
            society_id, building_id, wing_id, floor_id, unit_number,
            unit_type, carpet_area_sqft, occupancy_status
        ) VALUES (
            p_society_id, v_building_id, v_wing_id, v_floor_id, v_unit_number,
            v_unit_type, v_area, v_occupancy
        )
        ON CONFLICT (society_id, wing_id, unit_number) DO UPDATE SET
            building_id = EXCLUDED.building_id,
            floor_id = EXCLUDED.floor_id,
            unit_type = EXCLUDED.unit_type,
            carpet_area_sqft = EXCLUDED.carpet_area_sqft,
            occupancy_status = EXCLUDED.occupancy_status,
            updated_at = timezone('utc'::text, now())
        RETURNING (xmax = 0) INTO v_was_insert;

        IF v_was_insert THEN
            v_inserted := v_inserted + 1;
        ELSE
            v_updated := v_updated + 1;
        END IF;
    END LOOP;

    SELECT count(*) INTO v_total FROM units WHERE society_id = p_society_id;
    UPDATE societies SET total_units = v_total, updated_at = timezone('utc'::text, now())
    WHERE id = p_society_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'units.imported', 'society', p_society_id::text,
            jsonb_build_object('inserted', v_inserted, 'updated', v_updated));

    RETURN jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'total_units', v_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 4. CLAIM INVITES
--    Only verified emails can claim, so nobody can sign up with someone
--    else's address and take over their flat.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.claim_my_invites()
RETURNS INT AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_email TEXT;
    v_confirmed TIMESTAMPTZ;
    v_invite member_invites%ROWTYPE;
    v_count INT := 0;
BEGIN
    IF v_uid IS NULL THEN
        RETURN 0;
    END IF;

    SELECT email, email_confirmed_at INTO v_email, v_confirmed
    FROM auth.users WHERE id = v_uid;

    IF v_email IS NULL OR v_confirmed IS NULL THEN
        RETURN 0;
    END IF;

    FOR v_invite IN
        SELECT mi.* FROM member_invites mi
        JOIN societies s ON s.id = mi.society_id AND s.is_active = true
        WHERE mi.status = 'pending' AND lower(mi.email) = lower(v_email)
        FOR UPDATE OF mi
    LOOP
        IF EXISTS (
            SELECT 1 FROM society_memberships
            WHERE society_id = v_invite.society_id
              AND user_id = v_uid
              AND unit_id IS NOT DISTINCT FROM v_invite.unit_id
        ) THEN
            UPDATE society_memberships
            SET role = v_invite.role, is_active = true, updated_at = timezone('utc'::text, now())
            WHERE society_id = v_invite.society_id
              AND user_id = v_uid
              AND unit_id IS NOT DISTINCT FROM v_invite.unit_id;
        ELSE
            INSERT INTO society_memberships (society_id, user_id, role, unit_id)
            VALUES (v_invite.society_id, v_uid, v_invite.role, v_invite.unit_id);
        END IF;

        IF v_invite.unit_id IS NOT NULL THEN
            IF v_invite.role = 'resident_owner' THEN
                UPDATE units SET current_owner_id = v_uid, updated_at = timezone('utc'::text, now())
                WHERE id = v_invite.unit_id;
            ELSIF v_invite.role = 'resident_tenant' THEN
                UPDATE units SET current_tenant_id = v_uid, occupancy_status = 'tenant_occupied',
                                 updated_at = timezone('utc'::text, now())
                WHERE id = v_invite.unit_id;
            END IF;
        END IF;

        UPDATE member_invites
        SET status = 'accepted', accepted_user_id = v_uid, accepted_at = timezone('utc'::text, now())
        WHERE id = v_invite.id;

        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (v_invite.society_id, v_uid, 'invite.accepted', 'member_invite', v_invite.id::text,
                jsonb_build_object('role', v_invite.role, 'unit_id', v_invite.unit_id));

        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. FUNCTION PRIVILEGES: signed-in users only
-- ============================================================================
REVOKE ALL ON FUNCTION public.create_society(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bulk_upsert_units(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.claim_my_invites() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_society(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_upsert_units(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_my_invites() TO authenticated;


-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 006: Billing & Payment Verification (the "money loop")
--   * generate_bills()   - preview / generate one billing cycle from rules
--   * verify_payment()   - treasurer approves (receipt + FIFO allocation to
--                          bills) or rejects a resident's UTR submission
--   * apply_late_fees()  - marks overdue bills and adds the late fee once
--   * payment_allocations, duplicate-UTR guard, receipt numbering
-- Safe to re-run.
-- ============================================================================

ALTER TABLE bills ADD COLUMN IF NOT EXISTS late_fee_applied_at TIMESTAMPTZ;

-- Same UTR cannot be submitted twice while pending or verified (fraud / double click)
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_utr_active
    ON payments (society_id, transaction_reference_utr)
    WHERE status IN ('pending_verification', 'verified');

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_receipt_number
    ON payments (society_id, receipt_number)
    WHERE receipt_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bills_unit_outstanding
    ON bills (unit_id, due_date) WHERE balance_due > 0;

-- ============================================================================
-- 1. PAYMENT ALLOCATIONS (which bills a verified payment settled)
-- ============================================================================
CREATE TABLE IF NOT EXISTS payment_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    bill_id UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_payment ON payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_bill ON payment_allocations(bill_id);

ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;

-- Read-only for clients; written by verify_payment()
DROP POLICY IF EXISTS payment_allocations_select ON payment_allocations;
CREATE POLICY payment_allocations_select ON payment_allocations
    FOR SELECT USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR has_professional_permission(society_id, 'view_payments')
        OR EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_allocations.payment_id AND p.user_id = auth.uid())
    );

-- ============================================================================
-- 2. GENERATE BILLS
--    Bills each flat's owner (resident_owner membership, else units.current_owner_id)
--    using active flat_per_unit / per_sqft rules. p_dry_run = true returns the
--    preview without writing anything.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.generate_bills(
    p_society_id UUID,
    p_period_start DATE,
    p_period_end DATE,
    p_due_date DATE,
    p_cycle_name TEXT DEFAULT NULL,
    p_dry_run BOOLEAN DEFAULT false
)
RETURNS JSONB AS $$
DECLARE
    v_cycle_id UUID;
    v_cycle_name TEXT;
    v_unit RECORD;
    v_rule RECORD;
    v_owner UUID;
    v_bill_id UUID;
    v_seq INT := 0;
    v_line NUMERIC;
    v_line_tax NUMERIC;
    v_subtotal NUMERIC;
    v_tax NUMERIC;
    v_total_all NUMERIC := 0;
    v_skipped JSONB := '[]'::jsonb;
    v_preview JSONB := '[]'::jsonb;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can generate bills';
    END IF;
    IF p_period_end < p_period_start THEN
        RAISE EXCEPTION 'Period end must be on or after period start';
    END IF;
    IF p_due_date < p_period_start THEN
        RAISE EXCEPTION 'Due date cannot be before the billing period starts';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM billing_rules
        WHERE society_id = p_society_id AND is_active = true
          AND calculation_type IN ('flat_per_unit', 'per_sqft')
    ) THEN
        RAISE EXCEPTION 'Add at least one active billing rule (flat per unit or per sq.ft) first';
    END IF;
    IF EXISTS (
        SELECT 1 FROM billing_cycles
        WHERE society_id = p_society_id AND period_start = p_period_start AND period_end = p_period_end
    ) THEN
        RAISE EXCEPTION 'Bills for % to % have already been generated', p_period_start, p_period_end;
    END IF;

    v_cycle_name := coalesce(nullif(trim(p_cycle_name), ''), to_char(p_period_start, 'FMMonth YYYY') || ' Maintenance');

    IF NOT p_dry_run THEN
        INSERT INTO billing_cycles (society_id, cycle_name, period_start, period_end, due_date, status)
        VALUES (p_society_id, v_cycle_name, p_period_start, p_period_end, p_due_date, 'published')
        RETURNING id INTO v_cycle_id;
    END IF;

    FOR v_unit IN
        SELECT u.*, w.name AS wing_name
        FROM units u JOIN wings w ON w.id = u.wing_id
        WHERE u.society_id = p_society_id
        ORDER BY w.name, u.unit_number
    LOOP
        SELECT m.user_id INTO v_owner
        FROM society_memberships m
        WHERE m.society_id = p_society_id AND m.unit_id = v_unit.id
          AND m.is_active = true AND m.role = 'resident_owner'
        ORDER BY m.created_at
        LIMIT 1;
        v_owner := coalesce(v_owner, v_unit.current_owner_id);

        IF v_owner IS NULL THEN
            v_skipped := v_skipped || jsonb_build_object('unit_number', v_unit.unit_number, 'reason', 'No owner linked');
            CONTINUE;
        END IF;

        -- Compute totals first so flats with no applicable rule are skipped cleanly
        SELECT
            coalesce(sum(round(CASE r.calculation_type WHEN 'per_sqft' THEN r.rate * v_unit.carpet_area_sqft ELSE r.rate END, 2)), 0),
            coalesce(sum(round(round(CASE r.calculation_type WHEN 'per_sqft' THEN r.rate * v_unit.carpet_area_sqft ELSE r.rate END, 2) * r.tax_rate_percent / 100, 2)), 0)
        INTO v_subtotal, v_tax
        FROM billing_rules r
        WHERE r.society_id = p_society_id AND r.is_active = true
          AND r.calculation_type IN ('flat_per_unit', 'per_sqft')
          AND (r.applies_to_unit_type IS NULL OR r.applies_to_unit_type = '' OR r.applies_to_unit_type = v_unit.unit_type);

        IF v_subtotal <= 0 THEN
            v_skipped := v_skipped || jsonb_build_object('unit_number', v_unit.unit_number, 'reason', 'No applicable billing rule');
            CONTINUE;
        END IF;

        v_seq := v_seq + 1;
        v_total_all := v_total_all + v_subtotal + v_tax;
        IF v_seq <= 500 THEN
            v_preview := v_preview || jsonb_build_object(
                'unit_number', v_unit.unit_number, 'wing', v_unit.wing_name,
                'subtotal', v_subtotal, 'tax', v_tax, 'total', v_subtotal + v_tax
            );
        END IF;

        IF NOT p_dry_run THEN
            INSERT INTO bills (
                society_id, cycle_id, unit_id, user_id, bill_number, bill_date, due_date,
                subtotal_amount, tax_amount, total_amount, amount_paid, balance_due, status
            ) VALUES (
                p_society_id, v_cycle_id, v_unit.id, v_owner,
                'B' || to_char(p_period_start, 'YYMM') || '-' || lpad(v_seq::text, 4, '0'),
                current_date, p_due_date,
                v_subtotal, v_tax, v_subtotal + v_tax, 0, v_subtotal + v_tax, 'issued'
            )
            RETURNING id INTO v_bill_id;

            FOR v_rule IN
                SELECT * FROM billing_rules r
                WHERE r.society_id = p_society_id AND r.is_active = true
                  AND r.calculation_type IN ('flat_per_unit', 'per_sqft')
                  AND (r.applies_to_unit_type IS NULL OR r.applies_to_unit_type = '' OR r.applies_to_unit_type = v_unit.unit_type)
                ORDER BY r.created_at
            LOOP
                v_line := round(CASE v_rule.calculation_type WHEN 'per_sqft' THEN v_rule.rate * v_unit.carpet_area_sqft ELSE v_rule.rate END, 2);
                v_line_tax := round(v_line * v_rule.tax_rate_percent / 100, 2);
                INSERT INTO bill_items (bill_id, rule_id, description, quantity, unit_rate, amount, tax_rate, tax_amount, total_item_amount)
                VALUES (
                    v_bill_id, v_rule.id, v_rule.name,
                    CASE v_rule.calculation_type WHEN 'per_sqft' THEN v_unit.carpet_area_sqft ELSE 1 END,
                    v_rule.rate, v_line, v_rule.tax_rate_percent, v_line_tax, v_line + v_line_tax
                );
            END LOOP;
        END IF;
    END LOOP;

    IF NOT p_dry_run THEN
        IF v_seq = 0 THEN
            RAISE EXCEPTION 'No bills to generate: link owners to flats and check billing rules';
        END IF;
        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (p_society_id, auth.uid(), 'billing_cycle.generated', 'billing_cycle', v_cycle_id::text,
                jsonb_build_object('bills', v_seq, 'total', v_total_all, 'period_start', p_period_start));
    END IF;

    RETURN jsonb_build_object(
        'cycle_id', v_cycle_id,
        'cycle_name', v_cycle_name,
        'dry_run', p_dry_run,
        'bills', v_seq,
        'total_amount', v_total_all,
        'skipped_units', v_skipped,
        'preview', v_preview
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. VERIFY / REJECT A PAYMENT
--    Approve: issue receipt number and allocate the amount to the flat's
--    outstanding bills (the linked bill first, then oldest due first).
--    Any excess stays unallocated (advance) and is reported back.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.verify_payment(
    p_payment_id UUID,
    p_approve BOOLEAN,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_payment payments%ROWTYPE;
    v_bill RECORD;
    v_remaining NUMERIC;
    v_alloc NUMERIC;
    v_allocated NUMERIC := 0;
    v_receipt TEXT;
    v_next INT;
BEGIN
    SELECT * INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_payment.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can verify payments';
    END IF;
    IF v_payment.status <> 'pending_verification' THEN
        RAISE EXCEPTION 'Payment is already %', v_payment.status;
    END IF;

    IF NOT p_approve THEN
        IF length(trim(coalesce(p_notes, ''))) = 0 THEN
            RAISE EXCEPTION 'A reason is required to reject a payment';
        END IF;
        UPDATE payments
        SET status = 'rejected', verification_notes = trim(p_notes),
            verified_by = auth.uid(), verified_at = timezone('utc'::text, now())
        WHERE id = p_payment_id;

        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (v_payment.society_id, auth.uid(), 'payment.rejected', 'payment', p_payment_id::text,
                jsonb_build_object('reason', trim(p_notes), 'utr', v_payment.transaction_reference_utr));

        RETURN jsonb_build_object('status', 'rejected');
    END IF;

    -- Serialize receipt numbering per society
    PERFORM 1 FROM societies WHERE id = v_payment.society_id FOR UPDATE;
    SELECT count(*) + 1 INTO v_next
    FROM payments WHERE society_id = v_payment.society_id AND receipt_number IS NOT NULL;
    v_receipt := 'RCPT-' || to_char(current_date, 'YYYY') || '-' || lpad(v_next::text, 5, '0');

    v_remaining := v_payment.amount;
    FOR v_bill IN
        SELECT * FROM bills
        WHERE society_id = v_payment.society_id
          AND unit_id = v_payment.unit_id
          AND balance_due > 0
          AND status IN ('issued', 'partially_paid', 'overdue')
        ORDER BY (id = v_payment.bill_id) DESC NULLS LAST, due_date, bill_date, bill_number
        FOR UPDATE
    LOOP
        EXIT WHEN v_remaining <= 0;
        v_alloc := least(v_remaining, v_bill.balance_due);

        UPDATE bills
        SET amount_paid = amount_paid + v_alloc,
            balance_due = balance_due - v_alloc,
            status = CASE
                WHEN balance_due - v_alloc <= 0 THEN 'paid'
                WHEN status = 'overdue' THEN 'overdue'
                ELSE 'partially_paid'
            END,
            updated_at = timezone('utc'::text, now())
        WHERE id = v_bill.id;

        INSERT INTO payment_allocations (society_id, payment_id, bill_id, amount)
        VALUES (v_payment.society_id, p_payment_id, v_bill.id, v_alloc);

        v_remaining := v_remaining - v_alloc;
        v_allocated := v_allocated + v_alloc;
    END LOOP;

    UPDATE payments
    SET status = 'verified', receipt_number = v_receipt,
        verification_notes = nullif(trim(coalesce(p_notes, '')), ''),
        verified_by = auth.uid(), verified_at = timezone('utc'::text, now())
    WHERE id = p_payment_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_payment.society_id, auth.uid(), 'payment.verified', 'payment', p_payment_id::text,
            jsonb_build_object('receipt', v_receipt, 'amount', v_payment.amount,
                               'allocated', v_allocated, 'utr', v_payment.transaction_reference_utr));

    RETURN jsonb_build_object(
        'status', 'verified',
        'receipt_number', v_receipt,
        'allocated', v_allocated,
        'unallocated', v_remaining
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 4. LATE FEES
--    Bills past due with a balance become 'overdue'; the society's late fee
--    (flat ₹ or % of balance) is added once per bill.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.apply_late_fees(p_society_id UUID, p_as_of DATE DEFAULT current_date)
RETURNS JSONB AS $$
DECLARE
    v_settings society_settings%ROWTYPE;
    v_bill RECORD;
    v_fee NUMERIC;
    v_marked INT := 0;
    v_fees INT := 0;
    v_fee_total NUMERIC := 0;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can apply late fees';
    END IF;

    SELECT * INTO v_settings FROM society_settings WHERE society_id = p_society_id;

    FOR v_bill IN
        SELECT * FROM bills
        WHERE society_id = p_society_id
          AND due_date < p_as_of
          AND balance_due > 0
          AND status IN ('issued', 'partially_paid', 'overdue')
        FOR UPDATE
    LOOP
        IF v_bill.status <> 'overdue' THEN
            v_marked := v_marked + 1;
        END IF;

        v_fee := 0;
        IF v_bill.late_fee_applied_at IS NULL AND coalesce(v_settings.late_fee_type, 'none') <> 'none' THEN
            v_fee := CASE v_settings.late_fee_type
                WHEN 'flat' THEN v_settings.late_fee_amount
                ELSE round(v_bill.balance_due * v_settings.late_fee_amount / 100, 2)
            END;
        END IF;

        IF v_fee > 0 THEN
            INSERT INTO bill_items (bill_id, description, quantity, unit_rate, amount, total_item_amount)
            VALUES (v_bill.id, 'Late payment charge', 1, v_fee, v_fee, v_fee);
            v_fees := v_fees + 1;
            v_fee_total := v_fee_total + v_fee;
        END IF;

        UPDATE bills
        SET status = 'overdue',
            interest_or_late_fee = interest_or_late_fee + v_fee,
            total_amount = total_amount + v_fee,
            balance_due = balance_due + v_fee,
            late_fee_applied_at = CASE WHEN v_fee > 0 THEN timezone('utc'::text, now()) ELSE late_fee_applied_at END,
            updated_at = timezone('utc'::text, now())
        WHERE id = v_bill.id;
    END LOOP;

    IF v_marked > 0 OR v_fees > 0 THEN
        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (p_society_id, auth.uid(), 'bills.late_fees_applied', 'society', p_society_id::text,
                jsonb_build_object('marked_overdue', v_marked, 'late_fees', v_fees, 'total', v_fee_total, 'as_of', p_as_of));
    END IF;

    RETURN jsonb_build_object('marked_overdue', v_marked, 'late_fees_applied', v_fees, 'late_fee_total', v_fee_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. FUNCTION PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.generate_bills(UUID, DATE, DATE, DATE, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.verify_payment(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_late_fees(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_bills(UUID, DATE, DATE, DATE, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_payment(UUID, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_late_fees(UUID, DATE) TO authenticated;


-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 007: Double-Entry Ledger Engine & Financial Reports
--
-- Every money event posts a balanced journal automatically (no manual entry):
--   bill issued       Dr 1200 Members Receivable   Cr income/fund accounts + 2100 GST
--   late fee          Dr 1200 Members Receivable   Cr 4100 Interest on Late Payment
--   payment verified  Dr 1000 Bank / 1100 Cash      Cr 1200 Receivable (+ 2300 Advance)
--   expense paid      Dr 5xxx Expense               Cr 1000 Bank + 2200 TDS Payable
-- Ledger amounts: positive = debit, negative = credit.
-- Postings are idempotent per (event type, event id). Clients can only read.
-- Safe to re-run.
-- ============================================================================

-- Which account a billing rule credits (fund contributions are not income)
ALTER TABLE billing_rules ADD COLUMN IF NOT EXISTS account_code VARCHAR(8) NOT NULL DEFAULT '4000';
ALTER TABLE billing_rules DROP CONSTRAINT IF EXISTS chk_billing_rules_account_code;
ALTER TABLE billing_rules ADD CONSTRAINT chk_billing_rules_account_code
    CHECK (account_code IN ('4000', '4200', '3000', '3100', '3200'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_event
    ON journal_entries (society_id, reference_event_type, reference_event_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account_date ON ledger_entries (account_id, date);
CREATE INDEX IF NOT EXISTS idx_ledger_society_date ON ledger_entries (society_id, date);

-- ============================================================================
-- 1. DEFAULT CHART OF ACCOUNTS (idempotent; create_society also seeds these)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ensure_default_accounts(p_society_id UUID)
RETURNS VOID AS $$
BEGIN
    INSERT INTO accounts (society_id, code, name, type, is_system)
    SELECT p_society_id, a.code, a.name, a.type, true
    FROM (VALUES
        ('1000', 'Bank Accounts', 'asset'),
        ('1100', 'Cash in Hand', 'asset'),
        ('1200', 'Members Receivable', 'asset'),
        ('2000', 'Sundry Creditors', 'liability'),
        ('2100', 'GST Payable', 'liability'),
        ('2200', 'TDS Payable', 'liability'),
        ('2300', 'Advance Maintenance Received', 'liability'),
        ('3000', 'Sinking Fund', 'equity'),
        ('3100', 'Repair & Maintenance Fund', 'equity'),
        ('3200', 'General Reserve', 'equity'),
        ('4000', 'Maintenance Charges', 'income'),
        ('4100', 'Interest on Late Payment', 'income'),
        ('4200', 'Other Income', 'income'),
        ('5000', 'Repairs & Maintenance', 'expense'),
        ('5100', 'Security Charges', 'expense'),
        ('5200', 'Housekeeping', 'expense'),
        ('5300', 'Electricity (Common Areas)', 'expense'),
        ('5400', 'Water Charges', 'expense'),
        ('5900', 'Other Expenses', 'expense')
    ) AS a(code, name, type)
    ON CONFLICT (society_id, code) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 2. CORE POSTING FUNCTION (internal)
--    p_lines: [{ "code": "1200", "amount": 2685 }, { "code": "4000", "amount": -2325 }, ...]
-- ============================================================================
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

        SELECT id INTO v_account_id FROM accounts WHERE society_id = p_society_id AND code = v_line ->> 'code';
        IF v_account_id IS NULL THEN
            RAISE EXCEPTION 'Account % is missing for society %', v_line ->> 'code', p_society_id;
        END IF;

        SELECT coalesce(sum(amount), 0) INTO v_prev FROM ledger_entries WHERE account_id = v_account_id;

        INSERT INTO ledger_entries (society_id, account_id, journal_entry_id, date, amount, balance_after, narration)
        VALUES (p_society_id, v_account_id, v_journal_id, p_entry_date, v_amount, v_prev + v_amount,
                coalesce(v_line ->> 'narration', p_narration));
    END LOOP;

    RETURN v_journal_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. EVENT POSTERS
-- ============================================================================

-- Bill issued (excludes late fees, which post separately)
CREATE OR REPLACE FUNCTION public.ledger_post_bill(p_bill_id UUID)
RETURNS UUID AS $$
DECLARE
    v_bill bills%ROWTYPE;
    v_unit TEXT;
    v_receivable NUMERIC;
    v_items_total NUMERIC := 0;
    v_lines JSONB := '[]'::jsonb;
    v_group RECORD;
BEGIN
    SELECT * INTO v_bill FROM bills WHERE id = p_bill_id;
    IF NOT FOUND OR v_bill.status IN ('draft', 'cancelled') THEN
        RETURN NULL;
    END IF;
    SELECT unit_number INTO v_unit FROM units WHERE id = v_bill.unit_id;

    v_receivable := v_bill.total_amount - v_bill.interest_or_late_fee;
    v_lines := v_lines || jsonb_build_object('code', '1200', 'amount', v_receivable);

    FOR v_group IN
        SELECT coalesce(r.account_code, '4000') AS code, sum(i.amount) AS amount
        FROM bill_items i LEFT JOIN billing_rules r ON r.id = i.rule_id
        WHERE i.bill_id = p_bill_id
          AND NOT (i.rule_id IS NULL AND i.description = 'Late payment charge')
        GROUP BY 1
    LOOP
        v_lines := v_lines || jsonb_build_object('code', v_group.code, 'amount', -v_group.amount);
        v_items_total := v_items_total + v_group.amount;
    END LOOP;

    v_lines := v_lines || jsonb_build_object('code', '2100', 'amount', -v_bill.tax_amount);
    -- Any amount not explained by line items (e.g. bills created without items) is maintenance income
    v_lines := v_lines || jsonb_build_object('code', '4000', 'amount', -(v_receivable - v_bill.tax_amount - v_items_total));

    RETURN post_journal(
        v_bill.society_id, v_bill.bill_date, 'bill.issued', v_bill.id,
        'Bill ' || v_bill.bill_number || ' issued to flat ' || coalesce(v_unit, '?'),
        v_lines
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.ledger_post_late_fee(p_bill_id UUID, p_amount NUMERIC)
RETURNS UUID AS $$
DECLARE
    v_bill bills%ROWTYPE;
BEGIN
    SELECT * INTO v_bill FROM bills WHERE id = p_bill_id;
    IF NOT FOUND OR coalesce(p_amount, 0) <= 0 THEN
        RETURN NULL;
    END IF;
    RETURN post_journal(
        v_bill.society_id, coalesce(v_bill.late_fee_applied_at::date, current_date), 'bill.late_fee', v_bill.id,
        'Late payment charge on bill ' || v_bill.bill_number,
        jsonb_build_array(
            jsonb_build_object('code', '1200', 'amount', p_amount),
            jsonb_build_object('code', '4100', 'amount', -p_amount)
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.ledger_post_payment(p_payment_id UUID)
RETURNS UUID AS $$
DECLARE
    v_payment payments%ROWTYPE;
    v_unit TEXT;
    v_allocated NUMERIC;
BEGIN
    SELECT * INTO v_payment FROM payments WHERE id = p_payment_id;
    IF NOT FOUND OR v_payment.status <> 'verified' THEN
        RETURN NULL;
    END IF;
    SELECT unit_number INTO v_unit FROM units WHERE id = v_payment.unit_id;
    SELECT coalesce(sum(amount), 0) INTO v_allocated FROM payment_allocations WHERE payment_id = p_payment_id;

    RETURN post_journal(
        v_payment.society_id, v_payment.payment_date, 'payment.verified', v_payment.id,
        'Receipt ' || coalesce(v_payment.receipt_number, v_payment.payment_number) || ' from flat ' || coalesce(v_unit, '?')
            || ' (' || upper(v_payment.payment_method) || ' ' || v_payment.transaction_reference_utr || ')',
        jsonb_build_array(
            jsonb_build_object('code', CASE WHEN v_payment.payment_method = 'cash' THEN '1100' ELSE '1000' END, 'amount', v_payment.amount),
            jsonb_build_object('code', '1200', 'amount', -v_allocated),
            jsonb_build_object('code', '2300', 'amount', -(v_payment.amount - v_allocated))
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.expense_account_code(p_category TEXT)
RETURNS TEXT AS $$
    SELECT CASE
        WHEN p_category ~* 'secur|guard' THEN '5100'
        WHEN p_category ~* 'housekeep|clean|garden' THEN '5200'
        WHEN p_category ~* 'electric|power|light' THEN '5300'
        WHEN p_category ~* 'water' THEN '5400'
        WHEN p_category ~* 'repair|maint|lift|plumb|paint' THEN '5000'
        ELSE '5900'
    END
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.ledger_post_expense(p_expense_id UUID)
RETURNS UUID AS $$
DECLARE
    v_exp expenses%ROWTYPE;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id;
    IF NOT FOUND OR NOT (v_exp.status = 'paid' OR v_exp.payment_status = 'paid') THEN
        RETURN NULL;
    END IF;
    RETURN post_journal(
        v_exp.society_id, coalesce(v_exp.paid_date, v_exp.invoice_date, current_date), 'expense.paid', v_exp.id,
        'Expense ' || v_exp.expense_number || ': ' || v_exp.title,
        jsonb_build_array(
            jsonb_build_object('code', expense_account_code(v_exp.category), 'amount', v_exp.net_payable + v_exp.tds_amount),
            jsonb_build_object('code', '1000', 'amount', -v_exp.net_payable),
            jsonb_build_object('code', '2200', 'amount', -v_exp.tds_amount)
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 4. TRIGGERS
-- ============================================================================

-- Bills: deferred to commit so the bill's line items exist when posting
CREATE OR REPLACE FUNCTION public.trg_ledger_bill_insert()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM ledger_post_bill(NEW.id);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_ledger_bill_insert ON bills;
CREATE CONSTRAINT TRIGGER trg_ledger_bill_insert
    AFTER INSERT ON bills
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.trg_ledger_bill_insert();

CREATE OR REPLACE FUNCTION public.trg_ledger_bill_late_fee()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.interest_or_late_fee > OLD.interest_or_late_fee THEN
        PERFORM ledger_post_late_fee(NEW.id, NEW.interest_or_late_fee - OLD.interest_or_late_fee);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_ledger_bill_late_fee ON bills;
CREATE TRIGGER trg_ledger_bill_late_fee
    AFTER UPDATE OF interest_or_late_fee ON bills
    FOR EACH ROW EXECUTE FUNCTION public.trg_ledger_bill_late_fee();

CREATE OR REPLACE FUNCTION public.trg_ledger_payment_verified()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'verified' AND OLD.status IS DISTINCT FROM 'verified' THEN
        PERFORM ledger_post_payment(NEW.id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_ledger_payment_verified ON payments;
CREATE TRIGGER trg_ledger_payment_verified
    AFTER UPDATE OF status ON payments
    FOR EACH ROW EXECUTE FUNCTION public.trg_ledger_payment_verified();

CREATE OR REPLACE FUNCTION public.trg_ledger_expense_paid()
RETURNS TRIGGER AS $$
BEGIN
    IF (NEW.status = 'paid' OR NEW.payment_status = 'paid')
       AND (TG_OP = 'INSERT' OR NOT (OLD.status = 'paid' OR OLD.payment_status = 'paid')) THEN
        PERFORM ledger_post_expense(NEW.id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_ledger_expense_paid ON expenses;
CREATE TRIGGER trg_ledger_expense_paid
    AFTER INSERT OR UPDATE OF status, payment_status ON expenses
    FOR EACH ROW EXECUTE FUNCTION public.trg_ledger_expense_paid();

-- ============================================================================
-- 5. REPORTS (committee, platform admin, or professionals with view_reports/view_ledger)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.can_view_financials(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT is_platform_admin()
        OR is_society_admin(p_society_id)
        OR has_professional_permission(p_society_id, 'view_reports')
        OR has_professional_permission(p_society_id, 'view_ledger')
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.trial_balance(p_society_id UUID, p_as_of DATE DEFAULT current_date)
RETURNS TABLE (code TEXT, name TEXT, type TEXT, debit NUMERIC, credit NUMERIC) AS $$
BEGIN
    IF NOT can_view_financials(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s financial reports';
    END IF;
    RETURN QUERY
    SELECT a.code::TEXT, a.name::TEXT, a.type::TEXT,
           greatest(sum(l.amount), 0)::NUMERIC AS debit,
           greatest(-sum(l.amount), 0)::NUMERIC AS credit
    FROM accounts a
    JOIN ledger_entries l ON l.account_id = a.id AND l.date <= p_as_of
    WHERE a.society_id = p_society_id
    GROUP BY a.code, a.name, a.type
    HAVING sum(l.amount) <> 0
    ORDER BY a.code;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.income_expenditure(p_society_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (type TEXT, code TEXT, name TEXT, amount NUMERIC) AS $$
BEGIN
    IF NOT can_view_financials(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s financial reports';
    END IF;
    RETURN QUERY
    SELECT a.type::TEXT, a.code::TEXT, a.name::TEXT,
           (CASE WHEN a.type = 'income' THEN -sum(l.amount) ELSE sum(l.amount) END)::NUMERIC AS amount
    FROM accounts a
    JOIN ledger_entries l ON l.account_id = a.id AND l.date BETWEEN p_from AND p_to
    WHERE a.society_id = p_society_id AND a.type IN ('income', 'expense')
    GROUP BY a.type, a.code, a.name
    HAVING sum(l.amount) <> 0
    ORDER BY a.type DESC, a.code;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.member_dues(p_society_id UUID, p_as_of DATE DEFAULT current_date)
RETURNS TABLE (
    unit_number TEXT, wing TEXT, owner_name TEXT, owner_email TEXT,
    bills_count INT, outstanding NUMERIC, oldest_due_date DATE, days_overdue INT
) AS $$
BEGIN
    IF NOT can_view_financials(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s financial reports';
    END IF;
    RETURN QUERY
    SELECT u.unit_number::TEXT, w.name::TEXT, p.full_name::TEXT, p.email::TEXT,
           count(*)::INT, sum(b.balance_due)::NUMERIC, min(b.due_date),
           greatest(p_as_of - min(b.due_date), 0)::INT
    FROM bills b
    JOIN units u ON u.id = b.unit_id
    JOIN wings w ON w.id = u.wing_id
    LEFT JOIN profiles p ON p.id = b.user_id
    WHERE b.society_id = p_society_id
      AND b.balance_due > 0
      AND b.status IN ('issued', 'partially_paid', 'overdue')
    GROUP BY u.unit_number, w.name, p.full_name, p.email
    ORDER BY sum(b.balance_due) DESC, u.unit_number;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 6. PRIVILEGES: posting functions are internal; reports are callable
-- ============================================================================
REVOKE ALL ON FUNCTION public.post_journal(UUID, DATE, TEXT, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ledger_post_bill(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ledger_post_late_fee(UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ledger_post_payment(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ledger_post_expense(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ensure_default_accounts(UUID) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.trial_balance(UUID, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.income_expenditure(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.member_dues(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trial_balance(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.income_expenditure(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.member_dues(UUID, DATE) TO authenticated;

-- ============================================================================
-- 7. BACKFILL: post history that existed before this migration
-- ============================================================================
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT id FROM societies LOOP
        PERFORM ensure_default_accounts(r.id);
    END LOOP;
    FOR r IN SELECT id FROM bills ORDER BY created_at LOOP
        PERFORM ledger_post_bill(r.id);
    END LOOP;
    FOR r IN SELECT id, interest_or_late_fee FROM bills WHERE interest_or_late_fee > 0 ORDER BY created_at LOOP
        PERFORM ledger_post_late_fee(r.id, r.interest_or_late_fee);
    END LOOP;
    FOR r IN SELECT id FROM payments WHERE status = 'verified' ORDER BY verified_at NULLS FIRST, created_at LOOP
        PERFORM ledger_post_payment(r.id);
    END LOOP;
    FOR r IN SELECT id FROM expenses WHERE status = 'paid' OR payment_status = 'paid' ORDER BY created_at LOOP
        PERFORM ledger_post_expense(r.id);
    END LOOP;
END $$;


-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 008: Daily Operations
--   * Notices      - audience + expiry enforced by RLS, publisher stamped
--   * Complaints   - auto ticket numbers, resolved_at, comment thread
--   * Documents    - private Storage bucket "society-files" + policies
--   * Expenses     - auto numbers, net = subtotal + GST - TDS, maker-checker
--                    approval (decide_expense), mark_expense_paid -> ledger
-- Safe to re-run.
-- ============================================================================

-- Helper: does the current user hold one of these roles in the society?
CREATE OR REPLACE FUNCTION public.has_society_role(target_society_id UUID, roles TEXT[])
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM society_memberships
        WHERE society_id = target_society_id AND user_id = auth.uid()
          AND is_active = true AND role = ANY (roles)
    )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Serialized per-society sequence: next number after the highest "<PREFIX>NNNN" in p_table.p_column
CREATE OR REPLACE FUNCTION public.next_society_number(p_society_id UUID, p_table TEXT, p_column TEXT, p_prefix TEXT)
RETURNS INT AS $$
DECLARE
    v_n INT;
BEGIN
    IF p_prefix !~ '^[A-Z]+-$' THEN
        RAISE EXCEPTION 'Invalid number prefix %', p_prefix;
    END IF;
    PERFORM 1 FROM societies WHERE id = p_society_id FOR UPDATE;
    EXECUTE format(
        'SELECT coalesce(max(substring(%I FROM %L)::int), 0) + 1 FROM %I WHERE society_id = $1',
        p_column, '^' || p_prefix || '([0-9]+)$', p_table
    ) INTO v_n USING p_society_id;
    RETURN v_n;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.next_society_number(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 1. NOTICES
-- ============================================================================
DROP POLICY IF EXISTS notices_select ON notices;
CREATE POLICY notices_select ON notices
    FOR SELECT USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR (
            has_society_membership(society_id)
            AND (expires_at IS NULL OR expires_at > now())
            AND (
                target_audience = 'all'
                OR (target_audience = 'owners_only'    AND has_society_role(society_id, ARRAY['resident_owner', 'committee_member']))
                OR (target_audience = 'tenants_only'   AND has_society_role(society_id, ARRAY['resident_tenant', 'committee_member']))
                OR (target_audience = 'committee_only' AND has_society_role(society_id, ARRAY['committee_member']))
            )
        )
    );

CREATE OR REPLACE FUNCTION public.notices_stamp_publisher()
RETURNS TRIGGER AS $$
BEGIN
    IF auth.uid() IS NOT NULL THEN
        NEW.published_by := auth.uid();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_notices_stamp_publisher ON notices;
CREATE TRIGGER trg_notices_stamp_publisher
    BEFORE INSERT ON notices
    FOR EACH ROW EXECUTE FUNCTION public.notices_stamp_publisher();

-- ============================================================================
-- 2. COMPLAINTS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.complaints_assign_ticket_number()
RETURNS TRIGGER AS $$
BEGIN
    NEW.ticket_number := 'TKT-' || lpad(next_society_number(NEW.society_id, 'complaints', 'ticket_number', 'TKT-')::text, 4, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_complaints_assign_ticket_number ON complaints;
CREATE TRIGGER trg_complaints_assign_ticket_number
    BEFORE INSERT ON complaints
    FOR EACH ROW EXECUTE FUNCTION public.complaints_assign_ticket_number();

-- Runs after the resident guard (trigger names fire alphabetically)
CREATE OR REPLACE FUNCTION public.complaints_track_resolution()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IN ('resolved', 'closed') AND OLD.status NOT IN ('resolved', 'closed') THEN
        NEW.resolved_at := coalesce(NEW.resolved_at, timezone('utc'::text, now()));
    ELSIF NEW.status IN ('open', 'in_progress') THEN
        NEW.resolved_at := NULL;
    END IF;
    NEW.updated_at := timezone('utc'::text, now());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_complaints_track_resolution ON complaints;
CREATE TRIGGER trg_complaints_track_resolution
    BEFORE UPDATE ON complaints
    FOR EACH ROW EXECUTE FUNCTION public.complaints_track_resolution();

CREATE TABLE IF NOT EXISTS complaint_updates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    complaint_id UUID NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    message TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 2000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_complaint_updates_complaint ON complaint_updates(complaint_id, created_at);

ALTER TABLE complaint_updates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS complaint_updates_select ON complaint_updates;
DROP POLICY IF EXISTS complaint_updates_insert ON complaint_updates;
CREATE POLICY complaint_updates_select ON complaint_updates
    FOR SELECT USING (
        is_platform_admin()
        OR is_society_admin(society_id)
        OR EXISTS (SELECT 1 FROM complaints c WHERE c.id = complaint_updates.complaint_id AND c.user_id = auth.uid())
    );
CREATE POLICY complaint_updates_insert ON complaint_updates
    FOR INSERT WITH CHECK (
        author_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM complaints c
            WHERE c.id = complaint_updates.complaint_id
              AND c.society_id = complaint_updates.society_id
              AND (c.user_id = auth.uid() OR is_society_admin(c.society_id))
        )
    );

-- ============================================================================
-- 3. DOCUMENTS & STORAGE
--    Files live at  society-files/<society_id>/<folder>/<uuid>-<name>
--    Read access mirrors the documents / expenses table RLS of the caller.
-- ============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('society-files', 'society-files', false, 10485760)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.documents_stamp_uploader()
RETURNS TRIGGER AS $$
BEGIN
    IF auth.uid() IS NOT NULL THEN
        NEW.uploaded_by := auth.uid();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_documents_stamp_uploader ON documents;
CREATE TRIGGER trg_documents_stamp_uploader
    BEFORE INSERT ON documents
    FOR EACH ROW EXECUTE FUNCTION public.documents_stamp_uploader();

-- File path must sit inside the document's own society folder
ALTER TABLE documents DROP CONSTRAINT IF EXISTS chk_documents_path_in_society;
ALTER TABLE documents ADD CONSTRAINT chk_documents_path_in_society
    CHECK (file_url LIKE society_id::text || '/%');

DROP POLICY IF EXISTS "society files: read" ON storage.objects;
DROP POLICY IF EXISTS "society files: committee upload" ON storage.objects;
DROP POLICY IF EXISTS "society files: committee delete" ON storage.objects;

CREATE POLICY "society files: read" ON storage.objects
    FOR SELECT TO authenticated USING (
        bucket_id = 'society-files'
        AND (
            EXISTS (SELECT 1 FROM public.documents d WHERE d.file_url = storage.objects.name)
            OR EXISTS (SELECT 1 FROM public.expenses e WHERE e.document_url = storage.objects.name)
            OR public.is_society_admin(((storage.foldername(name))[1])::uuid)
        )
    );

CREATE POLICY "society files: committee upload" ON storage.objects
    FOR INSERT TO authenticated WITH CHECK (
        bucket_id = 'society-files'
        AND (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
        AND (public.is_platform_admin() OR public.is_society_admin(((storage.foldername(name))[1])::uuid))
    );

CREATE POLICY "society files: committee delete" ON storage.objects
    FOR DELETE TO authenticated USING (
        bucket_id = 'society-files'
        AND (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
        AND (public.is_platform_admin() OR public.is_society_admin(((storage.foldername(name))[1])::uuid))
    );

-- ============================================================================
-- 4. EXPENSES: numbering, amounts, maker-checker approval
-- ============================================================================
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES profiles(id);

CREATE TABLE IF NOT EXISTS expense_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    approver_id UUID NOT NULL REFERENCES profiles(id),
    decision VARCHAR(16) NOT NULL CHECK (decision IN ('approved', 'rejected')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_expense_approver UNIQUE (expense_id, approver_id)
);

ALTER TABLE expense_approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS expense_approvals_select ON expense_approvals;
CREATE POLICY expense_approvals_select ON expense_approvals
    FOR SELECT USING (
        is_platform_admin() OR is_society_admin(society_id)
        OR has_professional_permission(society_id, 'view_expenses')
    );

-- Direct client edits cannot approve, pay or alter approved amounts;
-- decide_expense / mark_expense_paid set sahvaas.expense_workflow = 'on'.
CREATE OR REPLACE FUNCTION public.expenses_guard_and_compute()
RETURNS TRIGGER AS $$
DECLARE
    v_workflow BOOLEAN := coalesce(current_setting('sahvaas.expense_workflow', true), '') = 'on';
BEGIN
    NEW.net_payable := round(NEW.subtotal + NEW.gst_amount - NEW.tds_amount, 2);
    IF NEW.subtotal < 0 OR NEW.gst_amount < 0 OR NEW.tds_amount < 0 OR NEW.net_payable < 0 THEN
        RAISE EXCEPTION 'Expense amounts cannot be negative';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF coalesce(NEW.expense_number, '') = '' THEN
            NEW.expense_number := 'EXP-' || lpad(next_society_number(NEW.society_id, 'expenses', 'expense_number', 'EXP-')::text, 4, '0');
        END IF;
        IF auth.uid() IS NOT NULL THEN
            NEW.created_by := auth.uid();
            IF NOT v_workflow THEN
                IF NEW.status NOT IN ('draft', 'pending_approval') THEN
                    NEW.status := 'pending_approval';
                END IF;
                NEW.payment_status := 'unpaid';
                NEW.approved_by := NULL;
                NEW.approved_at := NULL;
                NEW.paid_date := NULL;
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE
    IF v_workflow OR auth.uid() IS NULL THEN
        RETURN NEW;
    END IF;
    IF OLD.status = 'paid' THEN
        RAISE EXCEPTION 'Paid expenses are locked';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('draft', 'pending_approval', 'voided') THEN
        RAISE EXCEPTION 'Use the approval workflow to approve, reject or pay an expense';
    END IF;
    IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.paid_date IS DISTINCT FROM OLD.paid_date
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.expense_number IS DISTINCT FROM OLD.expense_number THEN
        RAISE EXCEPTION 'Use the approval workflow to approve, reject or pay an expense';
    END IF;
    IF OLD.status = 'approved' AND (
        NEW.subtotal <> OLD.subtotal OR NEW.gst_amount <> OLD.gst_amount OR NEW.tds_amount <> OLD.tds_amount
        OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
    ) THEN
        RAISE EXCEPTION 'Approved expenses cannot be edited; void it and create a new one';
    END IF;
    -- Sending a changed expense back for approval clears earlier approvals
    IF NEW.status = 'pending_approval' AND OLD.status <> 'pending_approval' THEN
        DELETE FROM expense_approvals WHERE expense_id = OLD.id;
    END IF;
    NEW.updated_at := timezone('utc'::text, now());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_expenses_guard_and_compute ON expenses;
CREATE TRIGGER trg_expenses_guard_and_compute
    BEFORE INSERT OR UPDATE ON expenses
    FOR EACH ROW EXECUTE FUNCTION public.expenses_guard_and_compute();

CREATE OR REPLACE FUNCTION public.decide_expense(p_expense_id UUID, p_approve BOOLEAN, p_notes TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_exp expenses%ROWTYPE;
    v_required INT;
    v_approvals INT;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_exp.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can approve expenses';
    END IF;
    IF v_exp.status <> 'pending_approval' THEN
        RAISE EXCEPTION 'Expense is %, not pending approval', v_exp.status;
    END IF;
    IF v_exp.created_by = auth.uid() THEN
        RAISE EXCEPTION 'You created this expense; another committee member must approve it';
    END IF;
    IF EXISTS (SELECT 1 FROM expense_approvals WHERE expense_id = p_expense_id AND approver_id = auth.uid()) THEN
        RAISE EXCEPTION 'You have already recorded your decision on this expense';
    END IF;
    IF NOT p_approve AND length(trim(coalesce(p_notes, ''))) = 0 THEN
        RAISE EXCEPTION 'A reason is required to reject an expense';
    END IF;

    INSERT INTO expense_approvals (society_id, expense_id, approver_id, decision, notes)
    VALUES (v_exp.society_id, p_expense_id, auth.uid(), CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, nullif(trim(coalesce(p_notes, '')), ''));

    SELECT CASE WHEN require_two_step_expense_approval THEN 2 ELSE 1 END INTO v_required
    FROM society_settings WHERE society_id = v_exp.society_id;
    v_required := coalesce(v_required, 1);

    SELECT count(*) INTO v_approvals FROM expense_approvals WHERE expense_id = p_expense_id AND decision = 'approved';

    PERFORM set_config('sahvaas.expense_workflow', 'on', true);
    IF NOT p_approve THEN
        UPDATE expenses SET status = 'rejected', updated_at = timezone('utc'::text, now()) WHERE id = p_expense_id;
    ELSIF v_approvals >= v_required THEN
        UPDATE expenses SET status = 'approved', approved_by = auth.uid(), approved_at = timezone('utc'::text, now()),
                            updated_at = timezone('utc'::text, now())
        WHERE id = p_expense_id;
    END IF;
    PERFORM set_config('sahvaas.expense_workflow', 'off', true);

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_exp.society_id, auth.uid(), CASE WHEN p_approve THEN 'expense.approved' ELSE 'expense.rejected' END,
            'expense', p_expense_id::text, jsonb_build_object('approvals', v_approvals, 'required', v_required, 'notes', p_notes));

    RETURN jsonb_build_object(
        'status', CASE WHEN NOT p_approve THEN 'rejected' WHEN v_approvals >= v_required THEN 'approved' ELSE 'pending_approval' END,
        'approvals', v_approvals,
        'required', v_required
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.mark_expense_paid(p_expense_id UUID, p_paid_date DATE DEFAULT current_date, p_reference TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_exp expenses%ROWTYPE;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_exp.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can record expense payments';
    END IF;
    IF v_exp.status <> 'approved' THEN
        RAISE EXCEPTION 'Only approved expenses can be paid (this one is %)', v_exp.status;
    END IF;

    PERFORM set_config('sahvaas.expense_workflow', 'on', true);
    UPDATE expenses
    SET status = 'paid', payment_status = 'paid', paid_date = coalesce(p_paid_date, current_date),
        payment_reference = nullif(trim(coalesce(p_reference, '')), ''), updated_at = timezone('utc'::text, now())
    WHERE id = p_expense_id;
    PERFORM set_config('sahvaas.expense_workflow', 'off', true);

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_exp.society_id, auth.uid(), 'expense.paid', 'expense', p_expense_id::text,
            jsonb_build_object('net_payable', v_exp.net_payable, 'reference', p_reference));

    RETURN jsonb_build_object('status', 'paid', 'net_payable', v_exp.net_payable);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.decide_expense(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_expense_paid(UUID, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_expense(UUID, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_expense_paid(UUID, DATE, TEXT) TO authenticated;


-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 009: Professional (CA / Auditor / GST) Portal
--   * Invite → verified-email claim → time-boxed grant with explicit permissions
--   * Revocation stamping, permission catalog enforced by CHECK constraints
--   * audit_remarks: professional observations + committee responses
--   * import_gstr2b(): GSTR-2B upload matched against expense books
--   * gst_reconciliation_detail(): portal vs books line items
-- Safe to re-run.
-- ============================================================================

-- ============================================================================
-- 1. PERMISSION CATALOG (must match keys used by RLS in 002/004/007/008)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.valid_professional_permissions(p JSONB)
RETURNS BOOLEAN AS $$
    SELECT jsonb_typeof(p) = 'array'
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(p) AS x(perm)
           WHERE perm NOT IN (
               'view_reports', 'view_ledger', 'view_bills', 'view_payments', 'view_expenses',
               'view_bank_reconciliation', 'view_documents', 'view_units', 'audit_gst', 'view_audit_logs'
           )
       )
$$ LANGUAGE sql IMMUTABLE;

ALTER TABLE society_professional_access DROP CONSTRAINT IF EXISTS chk_spa_permissions;
ALTER TABLE society_professional_access ADD CONSTRAINT chk_spa_permissions CHECK (valid_professional_permissions(permissions));

ALTER TABLE professional_invites ADD COLUMN IF NOT EXISTS access_until TIMESTAMPTZ;
ALTER TABLE professional_invites ALTER COLUMN invitation_token SET DEFAULT gen_random_uuid()::text;
ALTER TABLE professional_invites DROP CONSTRAINT IF EXISTS chk_invite_permissions;
ALTER TABLE professional_invites ADD CONSTRAINT chk_invite_permissions CHECK (valid_professional_permissions(permissions));
ALTER TABLE professional_invites DROP CONSTRAINT IF EXISTS chk_invite_role;
ALTER TABLE professional_invites ADD CONSTRAINT chk_invite_role CHECK (role IN (
    'ca', 'auditor', 'accountant', 'tax_consultant', 'gst_consultant', 'financial_consultant'
));

CREATE UNIQUE INDEX IF NOT EXISTS uq_professional_invite_pending
    ON professional_invites (society_id, lower(invited_email)) WHERE status = 'pending';

-- Stamp inviter; stamp revocation
CREATE OR REPLACE FUNCTION public.professional_invites_stamp()
RETURNS TRIGGER AS $$
BEGIN
    IF auth.uid() IS NOT NULL THEN
        NEW.invited_by := auth.uid();
    END IF;
    NEW.invited_email := lower(trim(NEW.invited_email));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_professional_invites_stamp ON professional_invites;
CREATE TRIGGER trg_professional_invites_stamp
    BEFORE INSERT ON professional_invites
    FOR EACH ROW EXECUTE FUNCTION public.professional_invites_stamp();

CREATE OR REPLACE FUNCTION public.spa_track_revocation()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'revoked' AND OLD.status <> 'revoked' THEN
        NEW.revoked_at := timezone('utc'::text, now());
    ELSIF NEW.status = 'active' THEN
        NEW.revoked_at := NULL;
        NEW.revocation_reason := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_spa_track_revocation ON society_professional_access;
CREATE TRIGGER trg_spa_track_revocation
    BEFORE UPDATE ON society_professional_access
    FOR EACH ROW EXECUTE FUNCTION public.spa_track_revocation();

-- Professionals may read the profiles of committee members of societies they serve
-- (to see who responded to remarks); committee can read professionals they granted.
CREATE OR REPLACE FUNCTION public.profile_visible_via_professional_link(p_profile_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM society_professional_access spa
        WHERE spa.professional_user_id = p_profile_id AND is_society_admin(spa.society_id)
    ) OR EXISTS (
        SELECT 1 FROM society_memberships m
        WHERE m.user_id = p_profile_id AND m.is_active = true
          AND m.role IN ('society_admin', 'secretary', 'chairman', 'treasurer')
          AND has_active_professional_grant(m.society_id)
    )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

DROP POLICY IF EXISTS profiles_professional_context ON profiles;
CREATE POLICY profiles_professional_context ON profiles
    FOR SELECT USING (profile_visible_via_professional_link(id));

-- ============================================================================
-- 2. CLAIM PROFESSIONAL INVITES (verified email only)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.claim_professional_invites()
RETURNS INT AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_email TEXT;
    v_confirmed TIMESTAMPTZ;
    v_invite professional_invites%ROWTYPE;
    v_count INT := 0;
BEGIN
    IF v_uid IS NULL THEN
        RETURN 0;
    END IF;
    SELECT email, email_confirmed_at INTO v_email, v_confirmed FROM auth.users WHERE id = v_uid;
    IF v_email IS NULL OR v_confirmed IS NULL THEN
        RETURN 0;
    END IF;

    -- Expire stale invites for this email first
    UPDATE professional_invites SET status = 'expired'
    WHERE status = 'pending' AND lower(invited_email) = lower(v_email) AND expires_at <= now();

    FOR v_invite IN
        SELECT pi.* FROM professional_invites pi
        JOIN societies s ON s.id = pi.society_id AND s.is_active = true
        WHERE pi.status = 'pending' AND lower(pi.invited_email) = lower(v_email)
        FOR UPDATE OF pi
    LOOP
        INSERT INTO society_professional_access (
            society_id, professional_user_id, role, status, permissions, granted_by, granted_at, expires_at
        ) VALUES (
            v_invite.society_id, v_uid, v_invite.role, 'active', v_invite.permissions,
            v_invite.invited_by, timezone('utc'::text, now()), v_invite.access_until
        )
        ON CONFLICT (society_id, professional_user_id) DO UPDATE SET
            role = EXCLUDED.role,
            status = 'active',
            permissions = EXCLUDED.permissions,
            granted_by = EXCLUDED.granted_by,
            granted_at = EXCLUDED.granted_at,
            expires_at = EXCLUDED.expires_at;

        UPDATE professional_invites SET status = 'accepted' WHERE id = v_invite.id;

        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (v_invite.society_id, v_uid, 'professional.access_granted', 'professional_invite', v_invite.id::text,
                jsonb_build_object('role', v_invite.role, 'permissions', v_invite.permissions, 'until', v_invite.access_until));
        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. AUDIT REMARKS
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_remarks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES profiles(id),
    module VARCHAR(32) NOT NULL DEFAULT 'general' CHECK (module IN ('general', 'billing', 'payments', 'expenses', 'gst', 'ledger', 'documents')),
    reference TEXT,
    remark TEXT NOT NULL CHECK (length(trim(remark)) BETWEEN 3 AND 4000),
    severity VARCHAR(16) NOT NULL DEFAULT 'minor' CHECK (severity IN ('info', 'minor', 'major')),
    status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'responded', 'closed')),
    response TEXT,
    responded_by UUID REFERENCES profiles(id),
    responded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_audit_remarks_society ON audit_remarks(society_id, status, created_at DESC);

ALTER TABLE audit_remarks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_remarks_select ON audit_remarks;
DROP POLICY IF EXISTS audit_remarks_insert ON audit_remarks;
DROP POLICY IF EXISTS audit_remarks_update ON audit_remarks;
CREATE POLICY audit_remarks_select ON audit_remarks
    FOR SELECT USING (is_platform_admin() OR is_society_admin(society_id) OR author_id = auth.uid());
CREATE POLICY audit_remarks_insert ON audit_remarks
    FOR INSERT WITH CHECK (author_id = auth.uid() AND has_active_professional_grant(society_id));
CREATE POLICY audit_remarks_update ON audit_remarks
    FOR UPDATE USING (is_society_admin(society_id) OR author_id = auth.uid())
    WITH CHECK (is_society_admin(society_id) OR author_id = auth.uid());

CREATE OR REPLACE FUNCTION public.audit_remarks_guard()
RETURNS TRIGGER AS $$
DECLARE
    v_admin BOOLEAN := is_platform_admin() OR is_society_admin(OLD.society_id);
    v_author BOOLEAN := OLD.author_id = auth.uid();
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN NEW;
    END IF;
    IF NEW.society_id IS DISTINCT FROM OLD.society_id OR NEW.author_id IS DISTINCT FROM OLD.author_id THEN
        RAISE EXCEPTION 'Remark ownership cannot change';
    END IF;
    -- Committee responds; only the author edits the observation itself
    IF NOT v_author AND (NEW.remark IS DISTINCT FROM OLD.remark OR NEW.reference IS DISTINCT FROM OLD.reference
                         OR NEW.module IS DISTINCT FROM OLD.module OR NEW.severity IS DISTINCT FROM OLD.severity) THEN
        RAISE EXCEPTION 'Only the professional who wrote the remark can edit it';
    END IF;
    IF NOT v_admin AND (NEW.response IS DISTINCT FROM OLD.response) THEN
        RAISE EXCEPTION 'Only the society committee can respond to a remark';
    END IF;
    IF NOT v_admin AND NEW.status = 'responded' AND OLD.status <> 'responded' THEN
        RAISE EXCEPTION 'Only the society committee can respond to a remark';
    END IF;
    IF NEW.response IS DISTINCT FROM OLD.response AND NEW.response IS NOT NULL THEN
        NEW.responded_by := auth.uid();
        NEW.responded_at := timezone('utc'::text, now());
        IF NEW.status = 'open' THEN
            NEW.status := 'responded';
        END IF;
    ELSE
        NEW.responded_by := OLD.responded_by;
        NEW.responded_at := OLD.responded_at;
    END IF;
    NEW.updated_at := timezone('utc'::text, now());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_audit_remarks_guard ON audit_remarks;
CREATE TRIGGER trg_audit_remarks_guard
    BEFORE UPDATE ON audit_remarks
    FOR EACH ROW EXECUTE FUNCTION public.audit_remarks_guard();

-- ============================================================================
-- 4. GSTR-2B IMPORT & MATCHING
-- ============================================================================
ALTER TABLE gst_2b_uploads DROP CONSTRAINT IF EXISTS gst_2b_uploads_file_format_check;
ALTER TABLE gst_2b_uploads ADD CONSTRAINT gst_2b_uploads_file_format_check CHECK (file_format IN ('json', 'excel', 'csv'));
ALTER TABLE gst_2b_invoices ADD COLUMN IF NOT EXISTS matched_expense_id UUID REFERENCES expenses(id) ON DELETE SET NULL;
ALTER TABLE gst_reconciliations ADD COLUMN IF NOT EXISTS upload_id UUID REFERENCES gst_2b_uploads(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_gst_2b_invoices_upload ON gst_2b_invoices(upload_id);

-- Invoice numbers are compared ignoring case, separators and leading zeros
CREATE OR REPLACE FUNCTION public.normalize_invoice_number(p TEXT)
RETURNS TEXT AS $$
    SELECT nullif(ltrim(upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')), '0'), '')
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.import_gstr2b(
    p_society_id UUID,
    p_return_period TEXT,
    p_file_name TEXT,
    p_format TEXT,
    p_invoices JSONB
)
RETURNS JSONB AS $$
DECLARE
    v_upload_id UUID;
    v_period_start DATE;
    v_period_end DATE;
    v_inv JSONB;
    v_idx INT := 0;
    v_gstin TEXT;
    v_taxable NUMERIC;
    v_tax NUMERIC;
    v_exp RECORD;
    v_status TEXT;
    v_exact INT := 0;
    v_partial INT := 0;
    v_missing_books INT := 0;
    v_missing_2b INT := 0;
    v_tot_taxable NUMERIC := 0;
    v_tot_igst NUMERIC := 0;
    v_tot_cgst NUMERIC := 0;
    v_tot_sgst NUMERIC := 0;
    v_itc_at_risk NUMERIC := 0;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id) OR has_professional_permission(p_society_id, 'audit_gst')) THEN
        RAISE EXCEPTION 'You need GST audit permission for this society';
    END IF;
    IF coalesce(p_return_period, '') !~ '^(0[1-9]|1[0-2])[0-9]{4}$' THEN
        RAISE EXCEPTION 'Return period must be MMYYYY, e.g. 102026';
    END IF;
    IF p_format NOT IN ('json', 'excel', 'csv') THEN
        RAISE EXCEPTION 'Unsupported file format %', p_format;
    END IF;
    IF jsonb_typeof(p_invoices) <> 'array' OR jsonb_array_length(p_invoices) = 0 THEN
        RAISE EXCEPTION 'No invoices found in the file';
    END IF;
    IF jsonb_array_length(p_invoices) > 5000 THEN
        RAISE EXCEPTION 'At most 5000 invoices per upload';
    END IF;

    v_period_start := to_date('01' || p_return_period, 'DDMMYYYY');
    v_period_end := (v_period_start + interval '1 month - 1 day')::date;

    -- Re-uploading a period replaces the previous upload
    DELETE FROM gst_2b_uploads WHERE society_id = p_society_id AND return_period = p_return_period;

    INSERT INTO gst_2b_uploads (society_id, return_period, file_name, file_format, uploaded_by, reconciliation_status)
    VALUES (p_society_id, p_return_period, left(coalesce(nullif(trim(p_file_name), ''), 'gstr2b'), 255), p_format, auth.uid(), 'in_progress')
    RETURNING id INTO v_upload_id;

    FOR v_inv IN SELECT * FROM jsonb_array_elements(p_invoices) LOOP
        v_idx := v_idx + 1;
        v_gstin := upper(trim(coalesce(v_inv ->> 'supplier_gstin', '')));
        IF v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' THEN
            RAISE EXCEPTION 'Invoice %: supplier GSTIN "%" is invalid', v_idx, v_gstin;
        END IF;
        IF normalize_invoice_number(v_inv ->> 'invoice_number') IS NULL THEN
            RAISE EXCEPTION 'Invoice %: invoice number is missing', v_idx;
        END IF;
        IF coalesce(v_inv ->> 'invoice_date', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
            RAISE EXCEPTION 'Invoice %: invoice date must be YYYY-MM-DD', v_idx;
        END IF;

        v_taxable := round(coalesce((v_inv ->> 'taxable_value')::NUMERIC, 0), 2);
        v_tax := round(coalesce((v_inv ->> 'igst')::NUMERIC, 0) + coalesce((v_inv ->> 'cgst')::NUMERIC, 0) + coalesce((v_inv ->> 'sgst')::NUMERIC, 0), 2);

        SELECT e.id, e.subtotal, e.gst_amount INTO v_exp
        FROM expenses e JOIN vendors v ON v.id = e.vendor_id
        WHERE e.society_id = p_society_id
          AND e.status NOT IN ('rejected', 'voided')
          AND upper(v.gstin) = v_gstin
          AND normalize_invoice_number(e.invoice_number) = normalize_invoice_number(v_inv ->> 'invoice_number')
        ORDER BY e.created_at
        LIMIT 1;

        IF v_exp.id IS NULL THEN
            v_status := 'missing_in_books';
            v_missing_books := v_missing_books + 1;
        ELSIF abs(v_exp.subtotal - v_taxable) <= 1 AND abs(v_exp.gst_amount - v_tax) <= 1 THEN
            v_status := 'exact_match';
            v_exact := v_exact + 1;
        ELSE
            v_status := 'partial_match';
            v_partial := v_partial + 1;
        END IF;

        INSERT INTO gst_2b_invoices (
            upload_id, society_id, supplier_gstin, supplier_trade_name, invoice_number, invoice_type, invoice_date,
            invoice_value, taxable_value, igst, cgst, sgst, itc_availability, reconciliation_match_status, matched_expense_id
        ) VALUES (
            v_upload_id, p_society_id, v_gstin,
            left(coalesce(nullif(trim(v_inv ->> 'supplier_name'), ''), v_gstin), 191),
            left(trim(v_inv ->> 'invoice_number'), 96),
            left(coalesce(nullif(v_inv ->> 'invoice_type', ''), 'B2B'), 32),
            (v_inv ->> 'invoice_date')::DATE,
            round(coalesce((v_inv ->> 'invoice_value')::NUMERIC, v_taxable + v_tax), 2),
            v_taxable,
            round(coalesce((v_inv ->> 'igst')::NUMERIC, 0), 2),
            round(coalesce((v_inv ->> 'cgst')::NUMERIC, 0), 2),
            round(coalesce((v_inv ->> 'sgst')::NUMERIC, 0), 2),
            CASE WHEN upper(coalesce(v_inv ->> 'itc_available', 'Y')) IN ('N', 'NO') THEN 'N' ELSE 'Y' END,
            v_status, v_exp.id
        );

        v_tot_taxable := v_tot_taxable + v_taxable;
        v_tot_igst := v_tot_igst + round(coalesce((v_inv ->> 'igst')::NUMERIC, 0), 2);
        v_tot_cgst := v_tot_cgst + round(coalesce((v_inv ->> 'cgst')::NUMERIC, 0), 2);
        v_tot_sgst := v_tot_sgst + round(coalesce((v_inv ->> 'sgst')::NUMERIC, 0), 2);
    END LOOP;

    -- Books invoices for the month that the supplier has not reported in 2B (ITC at risk)
    SELECT count(*), coalesce(sum(e.gst_amount), 0) INTO v_missing_2b, v_itc_at_risk
    FROM expenses e JOIN vendors v ON v.id = e.vendor_id
    WHERE e.society_id = p_society_id
      AND e.status NOT IN ('rejected', 'voided')
      AND v.gstin IS NOT NULL AND e.gst_amount > 0
      AND e.invoice_date BETWEEN v_period_start AND v_period_end
      AND NOT EXISTS (SELECT 1 FROM gst_2b_invoices g WHERE g.upload_id = v_upload_id AND g.matched_expense_id = e.id);

    UPDATE gst_2b_uploads
    SET total_invoices_found = v_idx, total_taxable_value = v_tot_taxable,
        total_igst = v_tot_igst, total_cgst = v_tot_cgst, total_sgst = v_tot_sgst,
        reconciliation_status = 'completed'
    WHERE id = v_upload_id;

    INSERT INTO gst_reconciliations (society_id, upload_id, period, total_books_invoices, total_portal_invoices, matched_count, mismatched_count)
    VALUES (p_society_id, v_upload_id, p_return_period, v_exact + v_partial + v_missing_2b, v_idx, v_exact, v_partial + v_missing_books + v_missing_2b);

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'gst.gstr2b_imported', 'gst_2b_upload', v_upload_id::text,
            jsonb_build_object('period', p_return_period, 'invoices', v_idx, 'exact', v_exact));

    RETURN jsonb_build_object(
        'upload_id', v_upload_id,
        'invoices', v_idx,
        'exact_match', v_exact,
        'partial_match', v_partial,
        'missing_in_books', v_missing_books,
        'missing_in_2b', v_missing_2b,
        'total_taxable', v_tot_taxable,
        'total_tax', v_tot_igst + v_tot_cgst + v_tot_sgst,
        'itc_at_risk', v_itc_at_risk
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.gst_reconciliation_detail(p_upload_id UUID)
RETURNS TABLE (
    side TEXT, status TEXT, supplier_gstin TEXT, supplier_name TEXT, invoice_number TEXT, invoice_date DATE,
    portal_taxable NUMERIC, portal_tax NUMERIC, books_taxable NUMERIC, books_tax NUMERIC, expense_number TEXT
) AS $$
DECLARE
    v_upload gst_2b_uploads%ROWTYPE;
    v_start DATE;
BEGIN
    SELECT * INTO v_upload FROM gst_2b_uploads WHERE id = p_upload_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Upload not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_upload.society_id) OR has_professional_permission(v_upload.society_id, 'audit_gst')) THEN
        RAISE EXCEPTION 'You need GST audit permission for this society';
    END IF;
    v_start := to_date('01' || v_upload.return_period, 'DDMMYYYY');

    RETURN QUERY
    SELECT 'portal'::TEXT, g.reconciliation_match_status::TEXT, g.supplier_gstin::TEXT, g.supplier_trade_name::TEXT,
           g.invoice_number::TEXT, g.invoice_date, g.taxable_value, (g.igst + g.cgst + g.sgst),
           e.subtotal, e.gst_amount, e.expense_number::TEXT
    FROM gst_2b_invoices g LEFT JOIN expenses e ON e.id = g.matched_expense_id
    WHERE g.upload_id = p_upload_id
    UNION ALL
    SELECT 'books'::TEXT, 'missing_in_2b'::TEXT, upper(v.gstin)::TEXT, v.name::TEXT,
           e.invoice_number::TEXT, e.invoice_date, NULL::NUMERIC, NULL::NUMERIC,
           e.subtotal, e.gst_amount, e.expense_number::TEXT
    FROM expenses e JOIN vendors v ON v.id = e.vendor_id
    WHERE e.society_id = v_upload.society_id
      AND e.status NOT IN ('rejected', 'voided')
      AND v.gstin IS NOT NULL AND e.gst_amount > 0
      AND e.invoice_date BETWEEN v_start AND (v_start + interval '1 month - 1 day')::date
      AND NOT EXISTS (SELECT 1 FROM gst_2b_invoices g2 WHERE g2.upload_id = p_upload_id AND g2.matched_expense_id = e.id)
    ORDER BY 2, 3, 5;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.claim_professional_invites() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.import_gstr2b(UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gst_reconciliation_detail(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_professional_invites() TO authenticated;
GRANT EXECUTE ON FUNCTION public.import_gstr2b(UUID, TEXT, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gst_reconciliation_detail(UUID) TO authenticated;


-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 010: Launch Readiness
--   1. Suspended societies lose access (helpers require societies.is_active)
--   2. Advance (overpayment) automatically adjusted against new bills
--   3. Opening balances for societies migrating from Tally / registers
--   4. Late fees: system runner + nightly pg_cron job (when available)
--   5. Platform-owner tools: overview, status changes, plan assignment
-- Safe to re-run.
-- ============================================================================

-- ============================================================================
-- 1. SUSPENSION ENFORCEMENT
--    Membership / committee / professional checks only pass for active
--    societies. Platform admins are unaffected and can reactivate.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.is_society_admin(target_society_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM society_memberships m
    JOIN societies s ON s.id = m.society_id AND s.is_active = true
    WHERE m.society_id = target_society_id
      AND m.user_id = auth.uid()
      AND m.is_active = true
      AND m.role IN ('society_admin', 'secretary', 'chairman', 'treasurer')
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.has_society_membership(target_society_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM society_memberships m
    JOIN societies s ON s.id = m.society_id AND s.is_active = true
    WHERE m.society_id = target_society_id
      AND m.user_id = auth.uid()
      AND m.is_active = true
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.has_professional_permission(target_society_id UUID, required_permission TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM society_professional_access spa
    JOIN societies s ON s.id = spa.society_id AND s.is_active = true
    WHERE spa.society_id = target_society_id
      AND spa.professional_user_id = auth.uid()
      AND spa.status = 'active'
      AND (spa.expires_at IS NULL OR spa.expires_at > now())
      AND spa.permissions ? required_permission
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.has_active_professional_grant(target_society_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM society_professional_access spa
    JOIN societies s ON s.id = spa.society_id AND s.is_active = true
    WHERE spa.society_id = target_society_id
      AND spa.professional_user_id = auth.uid()
      AND spa.status = 'active'
      AND (spa.expires_at IS NULL OR spa.expires_at > now())
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.has_society_role(target_society_id UUID, roles TEXT[])
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM society_memberships m
        JOIN societies s ON s.id = m.society_id AND s.is_active = true
        WHERE m.society_id = target_society_id AND m.user_id = auth.uid()
          AND m.is_active = true AND m.role = ANY (roles)
    )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 2. OPENING-BALANCE BILLS DO NOT POST INCOME
-- ============================================================================
ALTER TABLE bills ADD COLUMN IF NOT EXISTS is_opening_balance BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.ledger_post_bill(p_bill_id UUID)
RETURNS UUID AS $$
DECLARE
    v_bill bills%ROWTYPE;
    v_unit TEXT;
    v_receivable NUMERIC;
    v_items_total NUMERIC := 0;
    v_lines JSONB := '[]'::jsonb;
    v_group RECORD;
BEGIN
    SELECT * INTO v_bill FROM bills WHERE id = p_bill_id;
    -- Opening arrears are already in the opening-balance journal
    IF NOT FOUND OR v_bill.status IN ('draft', 'cancelled') OR v_bill.is_opening_balance THEN
        RETURN NULL;
    END IF;
    SELECT unit_number INTO v_unit FROM units WHERE id = v_bill.unit_id;

    v_receivable := v_bill.total_amount - v_bill.interest_or_late_fee;
    v_lines := v_lines || jsonb_build_object('code', '1200', 'amount', v_receivable);

    FOR v_group IN
        SELECT coalesce(r.account_code, '4000') AS code, sum(i.amount) AS amount
        FROM bill_items i LEFT JOIN billing_rules r ON r.id = i.rule_id
        WHERE i.bill_id = p_bill_id
          AND NOT (i.rule_id IS NULL AND i.description = 'Late payment charge')
        GROUP BY 1
    LOOP
        v_lines := v_lines || jsonb_build_object('code', v_group.code, 'amount', -v_group.amount);
        v_items_total := v_items_total + v_group.amount;
    END LOOP;

    v_lines := v_lines || jsonb_build_object('code', '2100', 'amount', -v_bill.tax_amount);
    v_lines := v_lines || jsonb_build_object('code', '4000', 'amount', -(v_receivable - v_bill.tax_amount - v_items_total));

    RETURN post_journal(
        v_bill.society_id, v_bill.bill_date, 'bill.issued', v_bill.id,
        'Bill ' || v_bill.bill_number || ' issued to flat ' || coalesce(v_unit, '?'),
        v_lines
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. ADVANCE AUTO-ADJUSTMENT
--    Unallocated amounts of the flat's verified payments settle a new bill;
--    journal: Dr 2300 Advance / Cr 1200 Receivable.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ledger_apply_advance(p_bill_id UUID)
RETURNS NUMERIC AS $$
DECLARE
    v_bill bills%ROWTYPE;
    v_pay RECORD;
    v_balance NUMERIC;
    v_alloc NUMERIC;
    v_total NUMERIC := 0;
BEGIN
    SELECT * INTO v_bill FROM bills WHERE id = p_bill_id FOR UPDATE;
    IF NOT FOUND OR v_bill.balance_due <= 0 OR v_bill.status NOT IN ('issued', 'partially_paid', 'overdue') THEN
        RETURN 0;
    END IF;
    v_balance := v_bill.balance_due;

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

CREATE OR REPLACE FUNCTION public.trg_ledger_bill_insert()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM ledger_post_bill(NEW.id);
    PERFORM ledger_apply_advance(NEW.id);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 4. OPENING BALANCES (one-time per society)
--    p_accounts:     [{ "code": "1000", "amount": 250000 }, ...]  debit +, credit −
--    p_member_dues:  [{ "unit_number": "A-101", "wing": "A", "amount": 4500 }, ...]
--    Member dues become opening bills (so residents can pay them) and the
--    1200 Receivable line; any difference goes to 3200 General Reserve.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.post_opening_balances(
    p_society_id UUID,
    p_as_of DATE,
    p_accounts JSONB,
    p_member_dues JSONB DEFAULT '[]'::jsonb
)
RETURNS JSONB AS $$
DECLARE
    v_line JSONB;
    v_lines JSONB := '[]'::jsonb;
    v_sum NUMERIC := 0;
    v_amount NUMERIC;
    v_code TEXT;
    v_dues_total NUMERIC := 0;
    v_balancing NUMERIC;
    v_cycle UUID;
    v_unit RECORD;
    v_owner UUID;
    v_seq INT := 0;
    v_bill UUID;
    v_journal UUID;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can post opening balances';
    END IF;
    IF EXISTS (SELECT 1 FROM journal_entries WHERE society_id = p_society_id AND reference_event_type = 'opening.balance') THEN
        RAISE EXCEPTION 'Opening balances have already been posted for this society';
    END IF;
    IF p_as_of IS NULL OR p_as_of > current_date THEN
        RAISE EXCEPTION 'Opening date must be today or earlier';
    END IF;
    PERFORM ensure_default_accounts(p_society_id);

    FOR v_line IN SELECT * FROM jsonb_array_elements(coalesce(p_accounts, '[]'::jsonb)) LOOP
        v_code := v_line ->> 'code';
        v_amount := round(coalesce((v_line ->> 'amount')::NUMERIC, 0), 2);
        CONTINUE WHEN v_amount = 0;
        IF v_code = '1200' THEN
            RAISE EXCEPTION 'Enter member dues flat-wise instead of a Members Receivable total';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM accounts WHERE society_id = p_society_id AND code = v_code) THEN
            RAISE EXCEPTION 'Unknown account code %', v_code;
        END IF;
        v_lines := v_lines || jsonb_build_object('code', v_code, 'amount', v_amount);
        v_sum := v_sum + v_amount;
    END LOOP;

    -- Member arrears as opening bills
    IF jsonb_array_length(coalesce(p_member_dues, '[]'::jsonb)) > 0 THEN
        INSERT INTO billing_cycles (society_id, cycle_name, period_start, period_end, due_date, status)
        VALUES (p_society_id, 'Opening balance (arrears)', p_as_of, p_as_of, p_as_of, 'published')
        RETURNING id INTO v_cycle;

        FOR v_line IN SELECT * FROM jsonb_array_elements(p_member_dues) LOOP
            v_amount := round(coalesce((v_line ->> 'amount')::NUMERIC, 0), 2);
            CONTINUE WHEN v_amount = 0;
            IF v_amount < 0 THEN
                RAISE EXCEPTION 'Flat %: enter advances received as a 2300 Advance Maintenance account line, not negative dues', v_line ->> 'unit_number';
            END IF;

            SELECT u.* INTO v_unit FROM units u JOIN wings w ON w.id = u.wing_id
            WHERE u.society_id = p_society_id
              AND u.unit_number = trim(v_line ->> 'unit_number')
              AND (coalesce(v_line ->> 'wing', '') = '' OR w.name = v_line ->> 'wing')
            LIMIT 1;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Flat % not found — import flats first', v_line ->> 'unit_number';
            END IF;

            SELECT m.user_id INTO v_owner FROM society_memberships m
            WHERE m.society_id = p_society_id AND m.unit_id = v_unit.id AND m.role = 'resident_owner' AND m.is_active = true
            ORDER BY m.created_at LIMIT 1;
            v_owner := coalesce(v_owner, v_unit.current_owner_id);
            IF v_owner IS NULL THEN
                RAISE EXCEPTION 'Flat % has no owner linked — invite the owner before posting their arrears', v_unit.unit_number;
            END IF;

            v_seq := v_seq + 1;
            INSERT INTO bills (society_id, cycle_id, unit_id, user_id, bill_number, bill_date, due_date,
                               subtotal_amount, total_amount, amount_paid, balance_due, status, is_opening_balance)
            VALUES (p_society_id, v_cycle, v_unit.id, v_owner, 'OB-' || lpad(v_seq::text, 4, '0'), p_as_of, p_as_of,
                    v_amount, v_amount, 0, v_amount, 'issued', true)
            RETURNING id INTO v_bill;
            INSERT INTO bill_items (bill_id, description, quantity, unit_rate, amount, total_item_amount)
            VALUES (v_bill, 'Opening balance (arrears as on ' || to_char(p_as_of, 'DD-Mon-YYYY') || ')', 1, v_amount, v_amount, v_amount);

            v_dues_total := v_dues_total + v_amount;
            v_owner := NULL;
        END LOOP;
        v_lines := v_lines || jsonb_build_object('code', '1200', 'amount', v_dues_total);
        v_sum := v_sum + v_dues_total;
    END IF;

    v_balancing := -v_sum;
    IF v_balancing <> 0 THEN
        v_lines := v_lines || jsonb_build_object('code', '3200', 'amount', v_balancing,
                                                 'narration', 'Opening balance difference (General Reserve)');
    END IF;

    v_journal := post_journal(p_society_id, p_as_of, 'opening.balance', p_society_id,
                              'Opening balances as on ' || to_char(p_as_of, 'DD-Mon-YYYY'), v_lines);
    IF v_journal IS NULL THEN
        RAISE EXCEPTION 'Nothing to post — enter at least one balance';
    END IF;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'ledger.opening_balances', 'society', p_society_id::text,
            jsonb_build_object('as_of', p_as_of, 'member_dues', v_dues_total, 'balancing_to_reserve', v_balancing));

    RETURN jsonb_build_object('journal_id', v_journal, 'member_dues_total', v_dues_total,
                              'opening_bills', v_seq, 'balancing_to_general_reserve', v_balancing);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. LATE FEES: shared runner, committee wrapper, nightly system job
-- ============================================================================
CREATE OR REPLACE FUNCTION public.run_late_fees(p_society_id UUID, p_as_of DATE)
RETURNS JSONB AS $$
DECLARE
    v_settings society_settings%ROWTYPE;
    v_bill RECORD;
    v_fee NUMERIC;
    v_marked INT := 0;
    v_fees INT := 0;
    v_fee_total NUMERIC := 0;
BEGIN
    SELECT * INTO v_settings FROM society_settings WHERE society_id = p_society_id;

    FOR v_bill IN
        SELECT * FROM bills
        WHERE society_id = p_society_id
          AND due_date < p_as_of
          AND balance_due > 0
          AND status IN ('issued', 'partially_paid', 'overdue')
          AND NOT is_opening_balance
        FOR UPDATE
    LOOP
        IF v_bill.status <> 'overdue' THEN
            v_marked := v_marked + 1;
        END IF;

        v_fee := 0;
        IF v_bill.late_fee_applied_at IS NULL AND coalesce(v_settings.late_fee_type, 'none') <> 'none' THEN
            v_fee := CASE v_settings.late_fee_type
                WHEN 'flat' THEN v_settings.late_fee_amount
                ELSE round(v_bill.balance_due * v_settings.late_fee_amount / 100, 2)
            END;
        END IF;

        IF v_fee > 0 THEN
            INSERT INTO bill_items (bill_id, description, quantity, unit_rate, amount, total_item_amount)
            VALUES (v_bill.id, 'Late payment charge', 1, v_fee, v_fee, v_fee);
            v_fees := v_fees + 1;
            v_fee_total := v_fee_total + v_fee;
        END IF;

        UPDATE bills
        SET status = 'overdue',
            interest_or_late_fee = interest_or_late_fee + v_fee,
            total_amount = total_amount + v_fee,
            balance_due = balance_due + v_fee,
            late_fee_applied_at = CASE WHEN v_fee > 0 THEN timezone('utc'::text, now()) ELSE late_fee_applied_at END,
            updated_at = timezone('utc'::text, now())
        WHERE id = v_bill.id;
    END LOOP;

    -- audit_logs.user_id is required; the nightly job runs without a user
    IF (v_marked > 0 OR v_fees > 0) AND auth.uid() IS NOT NULL THEN
        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (p_society_id, auth.uid(), 'bills.late_fees_applied', 'society', p_society_id::text,
                jsonb_build_object('marked_overdue', v_marked, 'late_fees', v_fees, 'total', v_fee_total, 'as_of', p_as_of));
    END IF;

    RETURN jsonb_build_object('marked_overdue', v_marked, 'late_fees_applied', v_fees, 'late_fee_total', v_fee_total);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.apply_late_fees(p_society_id UUID, p_as_of DATE DEFAULT current_date)
RETURNS JSONB AS $$
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can apply late fees';
    END IF;
    RETURN run_late_fees(p_society_id, p_as_of);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.apply_late_fees_all(p_as_of DATE DEFAULT current_date)
RETURNS INT AS $$
DECLARE
    r RECORD;
    v_count INT := 0;
BEGIN
    FOR r IN SELECT id FROM societies WHERE is_active = true LOOP
        PERFORM run_late_fees(r.id, p_as_of);
        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.run_late_fees(UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_late_fees_all(DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ledger_apply_advance(UUID) FROM PUBLIC, anon, authenticated;

-- Nightly at 00:30 IST (19:00 UTC) when pg_cron is available (Supabase: Database → Extensions)
DO $outer$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
        CREATE EXTENSION IF NOT EXISTS pg_cron;
        PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sahvaas-late-fees';
        PERFORM cron.schedule('sahvaas-late-fees', '0 19 * * *', $cron$SELECT public.apply_late_fees_all()$cron$);
    END IF;
END
$outer$;

-- ============================================================================
-- 6. PLATFORM-OWNER TOOLS
-- ============================================================================
INSERT INTO subscription_plans (name, tier_code, monthly_rate_per_unit_inr, max_units, features_included) VALUES
    ('Standalone Society', 'starter', 12, 60,
     '["Resident PWA", "UPI collections & receipts", "Double-entry ledger", "Notices & helpdesk"]'::jsonb),
    ('Multi-Wing Society', 'growth', 18, 250,
     '["Everything in Standalone", "CA & auditor portal", "GSTR-2B reconciliation", "Expense approvals"]'::jsonb),
    ('Township / Multi-Tower', 'enterprise', 25, 100000,
     '["Everything in Multi-Wing", "Priority support", "Data migration assistance"]'::jsonb)
ON CONFLICT (tier_code) DO NOTHING;

CREATE OR REPLACE FUNCTION public.platform_society_overview()
RETURNS TABLE (
    id UUID, name TEXT, slug TEXT, city TEXT, state TEXT, subscription_status TEXT, is_active BOOLEAN,
    created_at TIMESTAMPTZ, total_units INT, members INT, billed_this_month NUMERIC, collected_this_month NUMERIC,
    plan_tier TEXT, plan_period_end DATE
) AS $$
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;
    RETURN QUERY
    SELECT s.id, s.name::TEXT, s.slug::TEXT, s.city::TEXT, s.state::TEXT, s.subscription_status::TEXT, s.is_active,
           s.created_at, s.total_units,
           (SELECT count(*)::INT FROM society_memberships m WHERE m.society_id = s.id AND m.is_active),
           (SELECT coalesce(sum(b.total_amount), 0) FROM bills b WHERE b.society_id = s.id AND b.bill_date >= date_trunc('month', current_date)),
           (SELECT coalesce(sum(p.amount), 0) FROM payments p WHERE p.society_id = s.id AND p.status = 'verified' AND p.verified_at >= date_trunc('month', current_date)),
           sp.tier_code::TEXT, sub.current_period_end
    FROM societies s
    LEFT JOIN subscriptions sub ON sub.society_id = s.id
    LEFT JOIN subscription_plans sp ON sp.id = sub.plan_id
    ORDER BY s.created_at DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.platform_set_society_status(p_society_id UUID, p_status TEXT, p_reason TEXT DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
    v_old TEXT;
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;
    IF p_status NOT IN ('trial', 'active', 'suspended', 'cancelled') THEN
        RAISE EXCEPTION 'Invalid status %', p_status;
    END IF;
    IF p_status IN ('suspended', 'cancelled') AND length(trim(coalesce(p_reason, ''))) = 0 THEN
        RAISE EXCEPTION 'A reason is required to suspend or cancel a society';
    END IF;
    SELECT subscription_status INTO v_old FROM societies WHERE id = p_society_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Society not found';
    END IF;

    UPDATE societies
    SET subscription_status = p_status,
        is_active = p_status IN ('trial', 'active'),
        updated_at = timezone('utc'::text, now())
    WHERE id = p_society_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, new_value, reason)
    VALUES (p_society_id, auth.uid(), 'platform.society_status', 'society', p_society_id::text,
            jsonb_build_object('status', v_old), jsonb_build_object('status', p_status), p_reason);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.platform_assign_plan(
    p_society_id UUID, p_tier_code TEXT, p_billing_term TEXT DEFAULT 'annual', p_period_end DATE DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
    v_plan UUID;
    v_units INT;
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;
    SELECT id INTO v_plan FROM subscription_plans WHERE tier_code = p_tier_code AND is_active;
    IF v_plan IS NULL THEN
        RAISE EXCEPTION 'Unknown plan %', p_tier_code;
    END IF;
    SELECT total_units INTO v_units FROM societies WHERE id = p_society_id;

    INSERT INTO subscriptions (society_id, plan_id, billing_term, status, current_period_start, current_period_end, unit_count)
    VALUES (p_society_id, v_plan, p_billing_term, 'active', current_date,
            coalesce(p_period_end, (current_date + CASE WHEN p_billing_term = 'monthly' THEN interval '1 month' ELSE interval '1 year' END)::date),
            coalesce(v_units, 0))
    ON CONFLICT (society_id) DO UPDATE SET
        plan_id = EXCLUDED.plan_id, billing_term = EXCLUDED.billing_term, status = 'active',
        current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end,
        unit_count = EXCLUDED.unit_count;

    UPDATE societies SET subscription_status = 'active', is_active = true, updated_at = timezone('utc'::text, now())
    WHERE id = p_society_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'platform.plan_assigned', 'society', p_society_id::text,
            jsonb_build_object('tier', p_tier_code, 'term', p_billing_term));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 7. PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.post_opening_balances(UUID, DATE, JSONB, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_society_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_set_society_status(UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_assign_plan(UUID, TEXT, TEXT, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_opening_balances(UUID, DATE, JSONB, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_society_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_set_society_status(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_assign_plan(UUID, TEXT, TEXT, DATE) TO authenticated;


-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 011: Integrity & Security Fixes (AUDIT_REPORT.md → F1)
--   C2  file paths must stay inside their own society folder; storage read
--       policy also checks the folder matches the record's society
--   H1  financial records cannot be deleted by clients; corrections go
--       through cancel_bill() / void_expense() with reversal journals
--   H2  bills, bill items, billing cycles and payments change only through
--       the workflow RPCs (no direct client writes)
--   M1  committees cannot change their own subscription / activation
--   M2  bill numbers continue per month, so several cycles per month work;
--       a fully cancelled cycle can be regenerated
-- Safe to re-run.
-- ============================================================================

-- ============================================================================
-- 1. C2 — FILE PATHS TIED TO THE OWNING SOCIETY
-- ============================================================================
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS chk_expenses_document_in_society;
ALTER TABLE expenses ADD CONSTRAINT chk_expenses_document_in_society
    CHECK (document_url IS NULL OR document_url LIKE society_id::text || '/%');

ALTER TABLE notices DROP CONSTRAINT IF EXISTS chk_notices_attachment_in_society;
ALTER TABLE notices ADD CONSTRAINT chk_notices_attachment_in_society
    CHECK (attachment_url IS NULL OR attachment_url LIKE society_id::text || '/%');

-- Folder name → society id, or NULL when it is not a uuid (never throws)
CREATE OR REPLACE FUNCTION public.storage_society_id(p_name TEXT)
RETURNS UUID AS $$
    SELECT CASE
        WHEN (storage.foldername(p_name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN ((storage.foldername(p_name))[1])::uuid
    END
$$ LANGUAGE sql STABLE;

DROP POLICY IF EXISTS "society files: read" ON storage.objects;
DROP POLICY IF EXISTS "society files: committee upload" ON storage.objects;
DROP POLICY IF EXISTS "society files: committee delete" ON storage.objects;

CREATE POLICY "society files: read" ON storage.objects
    FOR SELECT TO authenticated USING (
        bucket_id = 'society-files'
        AND public.storage_society_id(name) IS NOT NULL
        AND (
            EXISTS (SELECT 1 FROM public.documents d
                    WHERE d.file_url = storage.objects.name
                      AND d.society_id = public.storage_society_id(storage.objects.name))
            OR EXISTS (SELECT 1 FROM public.expenses e
                       WHERE e.document_url = storage.objects.name
                         AND e.society_id = public.storage_society_id(storage.objects.name))
            OR public.is_society_admin(public.storage_society_id(name))
        )
    );

CREATE POLICY "society files: committee upload" ON storage.objects
    FOR INSERT TO authenticated WITH CHECK (
        bucket_id = 'society-files'
        AND public.storage_society_id(name) IS NOT NULL
        AND (public.is_platform_admin() OR public.is_society_admin(public.storage_society_id(name)))
    );

CREATE POLICY "society files: committee delete" ON storage.objects
    FOR DELETE TO authenticated USING (
        bucket_id = 'society-files'
        AND public.storage_society_id(name) IS NOT NULL
        AND (public.is_platform_admin() OR public.is_society_admin(public.storage_society_id(name)))
    );

-- ============================================================================
-- 2. H1 + H2 — NO DIRECT CLIENT WRITES TO MONEY TABLES
--    generate_bills / verify_payment / apply_late_fees / opening balances /
--    cancel_bill are SECURITY DEFINER and keep working; RLS still decides reads.
-- ============================================================================
DROP POLICY IF EXISTS bills_admin_write ON bills;
DROP POLICY IF EXISTS bill_items_admin_write ON bill_items;
DROP POLICY IF EXISTS billing_cycles_admin_write ON billing_cycles;
DROP POLICY IF EXISTS payments_admin_verify ON payments;

-- Flats: committee may add/edit, but delete only flats with no history
DROP POLICY IF EXISTS units_admin_modify ON units;
DROP POLICY IF EXISTS units_admin_insert ON units;
DROP POLICY IF EXISTS units_admin_update ON units;
DROP POLICY IF EXISTS units_admin_delete ON units;
CREATE POLICY units_admin_insert ON units
    FOR INSERT WITH CHECK (is_platform_admin() OR is_society_admin(society_id));
CREATE POLICY units_admin_update ON units
    FOR UPDATE USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));
CREATE POLICY units_admin_delete ON units
    FOR DELETE USING (
        (is_platform_admin() OR is_society_admin(society_id))
        AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.unit_id = units.id)
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.unit_id = units.id)
        AND NOT EXISTS (SELECT 1 FROM complaints c WHERE c.unit_id = units.id)
    );

-- Expenses: delete only before anything is approved or paid
DROP POLICY IF EXISTS expenses_admin_write ON expenses;
DROP POLICY IF EXISTS expenses_admin_insert ON expenses;
DROP POLICY IF EXISTS expenses_admin_update ON expenses;
DROP POLICY IF EXISTS expenses_admin_delete ON expenses;
CREATE POLICY expenses_admin_insert ON expenses
    FOR INSERT WITH CHECK (is_platform_admin() OR is_society_admin(society_id));
CREATE POLICY expenses_admin_update ON expenses
    FOR UPDATE USING (is_platform_admin() OR is_society_admin(society_id))
    WITH CHECK (is_platform_admin() OR is_society_admin(society_id));
CREATE POLICY expenses_admin_delete ON expenses
    FOR DELETE USING (
        (is_platform_admin() OR is_society_admin(society_id))
        AND status IN ('draft', 'pending_approval', 'rejected')
    );

-- Defence in depth (e.g. platform-admin mistakes): a flat / cycle with bills
-- or payments cannot be deleted at all. NO ACTION still lets a whole society cascade.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT con.conname, cl.relname AS tbl, att.attname AS col, ref.relname AS reftbl
        FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid
        JOIN pg_class ref ON ref.oid = con.confrelid
        JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
        WHERE con.contype = 'f' AND con.confdeltype = 'c'
          AND (cl.relname, att.attname) IN (('bills', 'unit_id'), ('bills', 'cycle_id'), ('payments', 'unit_id'))
    LOOP
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tbl, r.conname);
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE NO ACTION',
                       r.tbl, r.conname, r.col, r.reftbl);
    END LOOP;
END $$;

-- ============================================================================
-- 3. M1 — SUBSCRIPTION FIELDS ARE PLATFORM-CONTROLLED
-- ============================================================================
CREATE OR REPLACE FUNCTION public.societies_guard_platform_fields()
RETURNS TRIGGER AS $$
BEGIN
    -- SECURITY DEFINER RPCs run as the function owner, so only direct client edits reach this check
    IF current_user IN ('authenticated', 'anon') AND NOT public.is_platform_admin() THEN
        IF NEW.subscription_status IS DISTINCT FROM OLD.subscription_status
           OR NEW.is_active IS DISTINCT FROM OLD.is_active
           OR NEW.slug IS DISTINCT FROM OLD.slug
           OR NEW.total_units IS DISTINCT FROM OLD.total_units THEN
            RAISE EXCEPTION 'Subscription, activation, slug and unit count are managed by Sahvaas';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public; -- deliberately NOT security definer (reads current_user)

DROP TRIGGER IF EXISTS trg_societies_guard_platform_fields ON societies;
CREATE TRIGGER trg_societies_guard_platform_fields
    BEFORE UPDATE ON societies
    FOR EACH ROW EXECUTE FUNCTION public.societies_guard_platform_fields();

-- ============================================================================
-- 4. M2 — BILL NUMBERING + REGENERATING A CANCELLED CYCLE
-- ============================================================================
CREATE OR REPLACE FUNCTION public.generate_bills(
    p_society_id UUID,
    p_period_start DATE,
    p_period_end DATE,
    p_due_date DATE,
    p_cycle_name TEXT DEFAULT NULL,
    p_dry_run BOOLEAN DEFAULT false
)
RETURNS JSONB AS $$
DECLARE
    v_cycle_id UUID;
    v_existing_cycle UUID;
    v_cycle_name TEXT;
    v_unit RECORD;
    v_rule RECORD;
    v_owner UUID;
    v_bill_id UUID;
    v_seq INT := 0;
    v_base INT;
    v_prefix TEXT;
    v_line NUMERIC;
    v_line_tax NUMERIC;
    v_subtotal NUMERIC;
    v_tax NUMERIC;
    v_total_all NUMERIC := 0;
    v_skipped JSONB := '[]'::jsonb;
    v_preview JSONB := '[]'::jsonb;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can generate bills';
    END IF;
    IF p_period_end < p_period_start THEN
        RAISE EXCEPTION 'Period end must be on or after period start';
    END IF;
    IF p_due_date < p_period_start THEN
        RAISE EXCEPTION 'Due date cannot be before the billing period starts';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM billing_rules
        WHERE society_id = p_society_id AND is_active = true
          AND calculation_type IN ('flat_per_unit', 'per_sqft')
    ) THEN
        RAISE EXCEPTION 'Add at least one active billing rule (flat per unit or per sq.ft) first';
    END IF;

    SELECT id INTO v_existing_cycle FROM billing_cycles
    WHERE society_id = p_society_id AND period_start = p_period_start AND period_end = p_period_end;
    IF v_existing_cycle IS NOT NULL AND EXISTS (
        SELECT 1 FROM bills WHERE cycle_id = v_existing_cycle AND status <> 'cancelled'
    ) THEN
        RAISE EXCEPTION 'Bills for % to % have already been generated', p_period_start, p_period_end;
    END IF;

    v_cycle_name := coalesce(nullif(trim(p_cycle_name), ''), to_char(p_period_start, 'FMMonth YYYY') || ' Maintenance');

    -- Continue numbering after the highest bill of this month (supports several cycles per month)
    PERFORM 1 FROM societies WHERE id = p_society_id FOR UPDATE;
    v_prefix := 'B' || to_char(p_period_start, 'YYMM') || '-';
    SELECT coalesce(max(substring(bill_number FROM '^' || v_prefix || '([0-9]+)$')::int), 0) INTO v_base
    FROM bills WHERE society_id = p_society_id;

    IF NOT p_dry_run THEN
        IF v_existing_cycle IS NOT NULL THEN
            v_cycle_id := v_existing_cycle; -- every bill of it was cancelled: reuse
            UPDATE billing_cycles SET cycle_name = v_cycle_name, due_date = p_due_date, status = 'published'
            WHERE id = v_cycle_id;
        ELSE
            INSERT INTO billing_cycles (society_id, cycle_name, period_start, period_end, due_date, status)
            VALUES (p_society_id, v_cycle_name, p_period_start, p_period_end, p_due_date, 'published')
            RETURNING id INTO v_cycle_id;
        END IF;
    END IF;

    FOR v_unit IN
        SELECT u.*, w.name AS wing_name
        FROM units u JOIN wings w ON w.id = u.wing_id
        WHERE u.society_id = p_society_id
        ORDER BY w.name, u.unit_number
    LOOP
        SELECT m.user_id INTO v_owner
        FROM society_memberships m
        WHERE m.society_id = p_society_id AND m.unit_id = v_unit.id
          AND m.is_active = true AND m.role = 'resident_owner'
        ORDER BY m.created_at
        LIMIT 1;
        v_owner := coalesce(v_owner, v_unit.current_owner_id);

        IF v_owner IS NULL THEN
            v_skipped := v_skipped || jsonb_build_object('unit_number', v_unit.unit_number, 'reason', 'No owner linked');
            CONTINUE;
        END IF;

        SELECT
            coalesce(sum(round(CASE r.calculation_type WHEN 'per_sqft' THEN r.rate * v_unit.carpet_area_sqft ELSE r.rate END, 2)), 0),
            coalesce(sum(round(round(CASE r.calculation_type WHEN 'per_sqft' THEN r.rate * v_unit.carpet_area_sqft ELSE r.rate END, 2) * r.tax_rate_percent / 100, 2)), 0)
        INTO v_subtotal, v_tax
        FROM billing_rules r
        WHERE r.society_id = p_society_id AND r.is_active = true
          AND r.calculation_type IN ('flat_per_unit', 'per_sqft')
          AND (r.applies_to_unit_type IS NULL OR r.applies_to_unit_type = '' OR r.applies_to_unit_type = v_unit.unit_type);

        IF v_subtotal <= 0 THEN
            v_skipped := v_skipped || jsonb_build_object('unit_number', v_unit.unit_number, 'reason', 'No applicable billing rule');
            CONTINUE;
        END IF;

        v_seq := v_seq + 1;
        v_total_all := v_total_all + v_subtotal + v_tax;
        IF v_seq <= 500 THEN
            v_preview := v_preview || jsonb_build_object(
                'unit_number', v_unit.unit_number, 'wing', v_unit.wing_name,
                'subtotal', v_subtotal, 'tax', v_tax, 'total', v_subtotal + v_tax
            );
        END IF;

        IF NOT p_dry_run THEN
            INSERT INTO bills (
                society_id, cycle_id, unit_id, user_id, bill_number, bill_date, due_date,
                subtotal_amount, tax_amount, total_amount, amount_paid, balance_due, status
            ) VALUES (
                p_society_id, v_cycle_id, v_unit.id, v_owner,
                v_prefix || lpad((v_base + v_seq)::text, 4, '0'),
                current_date, p_due_date,
                v_subtotal, v_tax, v_subtotal + v_tax, 0, v_subtotal + v_tax, 'issued'
            )
            RETURNING id INTO v_bill_id;

            FOR v_rule IN
                SELECT * FROM billing_rules r
                WHERE r.society_id = p_society_id AND r.is_active = true
                  AND r.calculation_type IN ('flat_per_unit', 'per_sqft')
                  AND (r.applies_to_unit_type IS NULL OR r.applies_to_unit_type = '' OR r.applies_to_unit_type = v_unit.unit_type)
                ORDER BY r.created_at
            LOOP
                v_line := round(CASE v_rule.calculation_type WHEN 'per_sqft' THEN v_rule.rate * v_unit.carpet_area_sqft ELSE v_rule.rate END, 2);
                v_line_tax := round(v_line * v_rule.tax_rate_percent / 100, 2);
                INSERT INTO bill_items (bill_id, rule_id, description, quantity, unit_rate, amount, tax_rate, tax_amount, total_item_amount)
                VALUES (
                    v_bill_id, v_rule.id, v_rule.name,
                    CASE v_rule.calculation_type WHEN 'per_sqft' THEN v_unit.carpet_area_sqft ELSE 1 END,
                    v_rule.rate, v_line, v_rule.tax_rate_percent, v_line_tax, v_line + v_line_tax
                );
            END LOOP;
        END IF;
    END LOOP;

    IF NOT p_dry_run THEN
        IF v_seq = 0 THEN
            RAISE EXCEPTION 'No bills to generate: link owners to flats and check billing rules';
        END IF;
        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
        VALUES (p_society_id, auth.uid(), 'billing_cycle.generated', 'billing_cycle', v_cycle_id::text,
                jsonb_build_object('bills', v_seq, 'total', v_total_all, 'period_start', p_period_start));
    END IF;

    RETURN jsonb_build_object(
        'cycle_id', v_cycle_id,
        'cycle_name', v_cycle_name,
        'dry_run', p_dry_run,
        'bills', v_seq,
        'total_amount', v_total_all,
        'skipped_units', v_skipped,
        'preview', v_preview
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. H1 — CORRECTIONS WITH REVERSAL JOURNALS
-- ============================================================================

-- Post the exact opposite of an existing journal (internal)
CREATE OR REPLACE FUNCTION public.ledger_reverse(
    p_society_id UUID, p_event_type TEXT, p_event_id UUID, p_reversal_type TEXT, p_date DATE, p_narration TEXT
)
RETURNS UUID AS $$
DECLARE
    v_lines JSONB;
BEGIN
    SELECT jsonb_agg(jsonb_build_object('code', a.code, 'amount', -l.amount))
    INTO v_lines
    FROM journal_entries j
    JOIN ledger_entries l ON l.journal_entry_id = j.id
    JOIN accounts a ON a.id = l.account_id
    WHERE j.society_id = p_society_id AND j.reference_event_type = p_event_type AND j.reference_event_id = p_event_id;

    IF v_lines IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN post_journal(p_society_id, p_date, p_reversal_type, p_event_id, p_narration, v_lines);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.cancel_bill(p_bill_id UUID, p_reason TEXT)
RETURNS JSONB AS $$
DECLARE
    v_bill bills%ROWTYPE;
BEGIN
    SELECT * INTO v_bill FROM bills WHERE id = p_bill_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bill not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_bill.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can cancel bills';
    END IF;
    IF length(trim(coalesce(p_reason, ''))) = 0 THEN
        RAISE EXCEPTION 'A reason is required to cancel a bill';
    END IF;
    IF v_bill.status = 'cancelled' THEN
        RAISE EXCEPTION 'Bill is already cancelled';
    END IF;
    IF v_bill.is_opening_balance THEN
        RAISE EXCEPTION 'Opening-balance arrears cannot be cancelled here; ask your CA for a correcting entry';
    END IF;
    IF v_bill.amount_paid > 0 OR EXISTS (SELECT 1 FROM payment_allocations WHERE bill_id = p_bill_id) THEN
        RAISE EXCEPTION 'This bill already has payments against it and cannot be cancelled';
    END IF;

    UPDATE bills SET status = 'cancelled', balance_due = 0, updated_at = timezone('utc'::text, now())
    WHERE id = p_bill_id;

    PERFORM ledger_reverse(v_bill.society_id, 'bill.issued', v_bill.id, 'bill.cancelled', current_date,
                           'Bill ' || v_bill.bill_number || ' cancelled: ' || trim(p_reason));
    PERFORM ledger_reverse(v_bill.society_id, 'bill.late_fee', v_bill.id, 'bill.late_fee_cancelled', current_date,
                           'Late fee on bill ' || v_bill.bill_number || ' cancelled');

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, reason)
    VALUES (v_bill.society_id, auth.uid(), 'bill.cancelled', 'bill', p_bill_id::text,
            jsonb_build_object('bill_number', v_bill.bill_number, 'total', v_bill.total_amount, 'status', v_bill.status), trim(p_reason));

    RETURN jsonb_build_object('status', 'cancelled', 'bill_number', v_bill.bill_number);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.void_expense(p_expense_id UUID, p_reason TEXT)
RETURNS JSONB AS $$
DECLARE
    v_exp expenses%ROWTYPE;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_exp.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can void expenses';
    END IF;
    IF length(trim(coalesce(p_reason, ''))) = 0 THEN
        RAISE EXCEPTION 'A reason is required to void an expense';
    END IF;
    IF v_exp.status = 'voided' THEN
        RAISE EXCEPTION 'Expense is already voided';
    END IF;

    IF v_exp.status = 'paid' OR v_exp.payment_status = 'paid' THEN
        PERFORM ledger_reverse(v_exp.society_id, 'expense.paid', v_exp.id, 'expense.voided', current_date,
                               'Expense ' || v_exp.expense_number || ' voided: ' || trim(p_reason));
    END IF;

    PERFORM set_config('sahvaas.expense_workflow', 'on', true);
    UPDATE expenses SET status = 'voided', updated_at = timezone('utc'::text, now()) WHERE id = p_expense_id;
    PERFORM set_config('sahvaas.expense_workflow', 'off', true);

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, reason)
    VALUES (v_exp.society_id, auth.uid(), 'expense.voided', 'expense', p_expense_id::text,
            jsonb_build_object('expense_number', v_exp.expense_number, 'status', v_exp.status, 'net_payable', v_exp.net_payable), trim(p_reason));

    RETURN jsonb_build_object('status', 'voided', 'reversed', v_exp.status = 'paid' OR v_exp.payment_status = 'paid');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 6. PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.ledger_reverse(UUID, TEXT, UUID, TEXT, DATE, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_bill(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_expense(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_bill(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_expense(UUID, TEXT) TO authenticated;


-- ============================================================================
-- SAHVAAS HOUSING SOCIETY MANAGEMENT PLATFORM
-- Migration 012: Consent, Roles & Scale (AUDIT_REPORT.md → F2)
--   H3   invites are accepted or declined explicitly by the invitee
--   M6   committee_member = read-only committee access
--   M3   society_summary(): dashboard totals computed in the database
--   M7   leads: demo requests from the public contact form
--   M12  reserve_notification(): dedupe + daily cap for outbound email
-- Safe to re-run.
-- ============================================================================

-- ============================================================================
-- 1. H3 — EXPLICIT INVITE ACCEPTANCE
-- ============================================================================
ALTER TABLE member_invites DROP CONSTRAINT IF EXISTS member_invites_status_check;
ALTER TABLE member_invites ADD CONSTRAINT member_invites_status_check
    CHECK (status IN ('pending', 'accepted', 'declined', 'revoked'));

-- The verified email of the current user, or NULL
CREATE OR REPLACE FUNCTION public.current_verified_email()
RETURNS TEXT AS $$
    SELECT lower(email) FROM auth.users WHERE id = auth.uid() AND email_confirmed_at IS NOT NULL
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.current_verified_email() FROM PUBLIC, anon, authenticated;

-- Accept one member invite row for a user (internal; caller has checked email + status)
CREATE OR REPLACE FUNCTION public.accept_member_invite_row(p_invite member_invites, p_uid UUID)
RETURNS VOID AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM society_memberships
        WHERE society_id = p_invite.society_id AND user_id = p_uid
          AND unit_id IS NOT DISTINCT FROM p_invite.unit_id
    ) THEN
        UPDATE society_memberships
        SET role = p_invite.role, is_active = true, updated_at = timezone('utc'::text, now())
        WHERE society_id = p_invite.society_id AND user_id = p_uid
          AND unit_id IS NOT DISTINCT FROM p_invite.unit_id;
    ELSE
        INSERT INTO society_memberships (society_id, user_id, role, unit_id)
        VALUES (p_invite.society_id, p_uid, p_invite.role, p_invite.unit_id);
    END IF;

    IF p_invite.unit_id IS NOT NULL THEN
        IF p_invite.role = 'resident_owner' THEN
            UPDATE units SET current_owner_id = p_uid, updated_at = timezone('utc'::text, now())
            WHERE id = p_invite.unit_id;
        ELSIF p_invite.role = 'resident_tenant' THEN
            UPDATE units SET current_tenant_id = p_uid, occupancy_status = 'tenant_occupied',
                             updated_at = timezone('utc'::text, now())
            WHERE id = p_invite.unit_id;
        END IF;
    END IF;

    UPDATE member_invites
    SET status = 'accepted', accepted_user_id = p_uid, accepted_at = timezone('utc'::text, now())
    WHERE id = p_invite.id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_invite.society_id, p_uid, 'invite.accepted', 'member_invite', p_invite.id::text,
            jsonb_build_object('role', p_invite.role, 'unit_id', p_invite.unit_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.accept_member_invite_row(member_invites, UUID) FROM PUBLIC, anon, authenticated;

-- Accept one professional invite row (internal)
CREATE OR REPLACE FUNCTION public.accept_professional_invite_row(p_invite professional_invites, p_uid UUID)
RETURNS VOID AS $$
BEGIN
    INSERT INTO society_professional_access (
        society_id, professional_user_id, role, status, permissions, granted_by, granted_at, expires_at
    ) VALUES (
        p_invite.society_id, p_uid, p_invite.role, 'active', p_invite.permissions,
        p_invite.invited_by, timezone('utc'::text, now()), p_invite.access_until
    )
    ON CONFLICT (society_id, professional_user_id) DO UPDATE SET
        role = EXCLUDED.role, status = 'active', permissions = EXCLUDED.permissions,
        granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at, expires_at = EXCLUDED.expires_at;

    UPDATE professional_invites SET status = 'accepted' WHERE id = p_invite.id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_invite.society_id, p_uid, 'professional.access_granted', 'professional_invite', p_invite.id::text,
            jsonb_build_object('role', p_invite.role, 'permissions', p_invite.permissions, 'until', p_invite.access_until));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.accept_professional_invite_row(professional_invites, UUID) FROM PUBLIC, anon, authenticated;

-- Bulk accept (kept for scripts/tests; the app no longer calls these on login)
CREATE OR REPLACE FUNCTION public.claim_my_invites()
RETURNS INT AS $$
DECLARE
    v_email TEXT := current_verified_email();
    v_invite member_invites%ROWTYPE;
    v_count INT := 0;
BEGIN
    IF v_email IS NULL THEN
        RETURN 0;
    END IF;
    FOR v_invite IN
        SELECT mi.* FROM member_invites mi
        JOIN societies s ON s.id = mi.society_id AND s.is_active = true
        WHERE mi.status = 'pending' AND lower(mi.email) = v_email
        FOR UPDATE OF mi
    LOOP
        PERFORM accept_member_invite_row(v_invite, auth.uid());
        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.claim_professional_invites()
RETURNS INT AS $$
DECLARE
    v_email TEXT := current_verified_email();
    v_invite professional_invites%ROWTYPE;
    v_count INT := 0;
BEGIN
    IF v_email IS NULL THEN
        RETURN 0;
    END IF;
    UPDATE professional_invites SET status = 'expired'
    WHERE status = 'pending' AND lower(invited_email) = v_email AND expires_at <= now();
    FOR v_invite IN
        SELECT pi.* FROM professional_invites pi
        JOIN societies s ON s.id = pi.society_id AND s.is_active = true
        WHERE pi.status = 'pending' AND lower(pi.invited_email) = v_email
        FOR UPDATE OF pi
    LOOP
        PERFORM accept_professional_invite_row(v_invite, auth.uid());
        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- What the signed-in (verified) user has been invited to
CREATE OR REPLACE FUNCTION public.my_pending_invites()
RETURNS TABLE (
    kind TEXT, id UUID, society_name TEXT, society_city TEXT, role TEXT, flat TEXT,
    permissions JSONB, invited_by_name TEXT, invited_at TIMESTAMPTZ, expires_at TIMESTAMPTZ
) AS $$
DECLARE
    v_email TEXT := current_verified_email();
BEGIN
    IF v_email IS NULL THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT 'member'::TEXT, mi.id, s.name::TEXT, s.city::TEXT, mi.role::TEXT, u.unit_number::TEXT,
           NULL::JSONB, p.full_name::TEXT, mi.created_at, NULL::TIMESTAMPTZ
    FROM member_invites mi
    JOIN societies s ON s.id = mi.society_id AND s.is_active = true
    LEFT JOIN units u ON u.id = mi.unit_id
    LEFT JOIN profiles p ON p.id = mi.invited_by
    WHERE mi.status = 'pending' AND lower(mi.email) = v_email
    UNION ALL
    SELECT 'professional'::TEXT, pi.id, s.name::TEXT, s.city::TEXT, pi.role::TEXT, NULL::TEXT,
           pi.permissions, p.full_name::TEXT, pi.created_at, pi.expires_at
    FROM professional_invites pi
    JOIN societies s ON s.id = pi.society_id AND s.is_active = true
    LEFT JOIN profiles p ON p.id = pi.invited_by
    WHERE pi.status = 'pending' AND lower(pi.invited_email) = v_email AND pi.expires_at > now()
    ORDER BY 9 DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.respond_to_invite(p_kind TEXT, p_invite_id UUID, p_accept BOOLEAN)
RETURNS JSONB AS $$
DECLARE
    v_email TEXT := current_verified_email();
    v_member member_invites%ROWTYPE;
    v_pro professional_invites%ROWTYPE;
BEGIN
    IF v_email IS NULL THEN
        RAISE EXCEPTION 'Verify your email address before responding to invitations';
    END IF;

    IF p_kind = 'member' THEN
        SELECT mi.* INTO v_member FROM member_invites mi
        JOIN societies s ON s.id = mi.society_id AND s.is_active = true
        WHERE mi.id = p_invite_id AND mi.status = 'pending' AND lower(mi.email) = v_email
        FOR UPDATE OF mi;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Invitation not found or no longer pending';
        END IF;
        IF p_accept THEN
            PERFORM accept_member_invite_row(v_member, auth.uid());
        ELSE
            UPDATE member_invites SET status = 'declined' WHERE id = p_invite_id;
        END IF;
        RETURN jsonb_build_object('kind', 'member', 'society_id', v_member.society_id, 'accepted', p_accept);
    ELSIF p_kind = 'professional' THEN
        SELECT pi.* INTO v_pro FROM professional_invites pi
        JOIN societies s ON s.id = pi.society_id AND s.is_active = true
        WHERE pi.id = p_invite_id AND pi.status = 'pending' AND lower(pi.invited_email) = v_email AND pi.expires_at > now()
        FOR UPDATE OF pi;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Invitation not found or no longer pending';
        END IF;
        IF p_accept THEN
            PERFORM accept_professional_invite_row(v_pro, auth.uid());
        ELSE
            UPDATE professional_invites SET status = 'declined' WHERE id = p_invite_id;
        END IF;
        RETURN jsonb_build_object('kind', 'professional', 'society_id', v_pro.society_id, 'accepted', p_accept);
    END IF;
    RAISE EXCEPTION 'Unknown invitation type %', p_kind;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 2. M6 — committee_member: read-only committee access
-- ============================================================================
CREATE OR REPLACE FUNCTION public.is_committee_viewer(target_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT is_society_admin(target_society_id) OR has_society_role(target_society_id, ARRAY['committee_member'])
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'bills', 'billing_cycles', 'billing_rules', 'payments', 'payment_allocations', 'expenses', 'expense_approvals',
        'vendors', 'accounts', 'journal_entries', 'ledger_entries', 'funds', 'bank_accounts', 'complaints',
        'documents', 'member_invites', 'society_professional_access', 'audit_remarks', 'society_memberships', 'access_logs'
    ] LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_committee_read', t);
        EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (has_society_role(society_id, ARRAY[''committee_member'']))',
                       t || '_committee_read', t);
    END LOOP;
END $$;

DROP POLICY IF EXISTS bill_items_committee_read ON bill_items;
CREATE POLICY bill_items_committee_read ON bill_items
    FOR SELECT USING (EXISTS (SELECT 1 FROM bills b WHERE b.id = bill_items.bill_id AND has_society_role(b.society_id, ARRAY['committee_member'])));

DROP POLICY IF EXISTS complaint_updates_committee_read ON complaint_updates;
CREATE POLICY complaint_updates_committee_read ON complaint_updates
    FOR SELECT USING (has_society_role(society_id, ARRAY['committee_member']));

-- Member names for the read-only committee
DROP POLICY IF EXISTS profiles_committee_read ON profiles;
CREATE POLICY profiles_committee_read ON profiles
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM society_memberships m
            WHERE m.user_id = profiles.id AND m.is_active = true
              AND has_society_role(m.society_id, ARRAY['committee_member'])
        )
    );

CREATE OR REPLACE FUNCTION public.can_view_financials(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT is_platform_admin()
        OR is_committee_viewer(p_society_id)
        OR has_professional_permission(p_society_id, 'view_reports')
        OR has_professional_permission(p_society_id, 'view_ledger')
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. M3 — DASHBOARD SUMMARY (no 1000-row API cap)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.society_summary(p_society_id UUID)
RETURNS JSONB AS $$
BEGIN
    IF NOT (is_platform_admin() OR is_committee_viewer(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can view the summary';
    END IF;
    RETURN jsonb_build_object(
        'units', (SELECT count(*) FROM units WHERE society_id = p_society_id),
        'members', (SELECT count(*) FROM society_memberships WHERE society_id = p_society_id AND is_active),
        'billed', (SELECT coalesce(sum(total_amount), 0) FROM bills WHERE society_id = p_society_id AND status <> 'cancelled'),
        'collected', (SELECT coalesce(sum(amount_paid), 0) FROM bills WHERE society_id = p_society_id AND status <> 'cancelled'),
        'outstanding', (SELECT coalesce(sum(balance_due), 0) FROM bills WHERE society_id = p_society_id AND status IN ('issued', 'partially_paid', 'overdue')),
        'overdue_flats', (SELECT count(DISTINCT unit_id) FROM bills WHERE society_id = p_society_id AND status = 'overdue' AND balance_due > 0),
        'bills', (SELECT count(*) FROM bills WHERE society_id = p_society_id),
        'pending_payments', (SELECT count(*) FROM payments WHERE society_id = p_society_id AND status = 'pending_verification'),
        'pending_expenses', (SELECT count(*) FROM expenses WHERE society_id = p_society_id AND status = 'pending_approval'),
        'open_complaints', (SELECT count(*) FROM complaints WHERE society_id = p_society_id AND status IN ('open', 'in_progress')),
        'upi_configured', (SELECT upi_id IS NOT NULL AND upi_id <> '' FROM society_settings WHERE society_id = p_society_id)
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 4. M7 — LEADS FROM THE PUBLIC CONTACT FORM
-- ============================================================================
CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(120) NOT NULL CHECK (length(trim(name)) >= 2),
    email VARCHAR(191) NOT NULL CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    phone VARCHAR(32) NOT NULL CHECK (length(regexp_replace(phone, '[^0-9]', '', 'g')) BETWEEN 10 AND 13),
    society_name VARCHAR(191) NOT NULL CHECK (length(trim(society_name)) >= 3),
    city VARCHAR(96),
    units INT CHECK (units IS NULL OR units BETWEEN 1 AND 100000),
    message TEXT CHECK (message IS NULL OR length(message) <= 2000),
    status VARCHAR(16) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'converted', 'closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS leads_public_insert ON leads;
DROP POLICY IF EXISTS leads_platform_read ON leads;
DROP POLICY IF EXISTS leads_platform_update ON leads;
CREATE POLICY leads_public_insert ON leads FOR INSERT TO anon, authenticated WITH CHECK (status = 'new');
CREATE POLICY leads_platform_read ON leads FOR SELECT USING (is_platform_admin());
CREATE POLICY leads_platform_update ON leads FOR UPDATE USING (is_platform_admin()) WITH CHECK (is_platform_admin());

-- Basic flood guard: the same email can submit at most 3 times per day
CREATE OR REPLACE FUNCTION public.leads_rate_limit()
RETURNS TRIGGER AS $$
BEGIN
    IF (SELECT count(*) FROM leads WHERE lower(email) = lower(NEW.email) AND created_at > now() - interval '1 day') >= 3 THEN
        RAISE EXCEPTION 'We already have your request — our team will contact you shortly';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_leads_rate_limit ON leads;
CREATE TRIGGER trg_leads_rate_limit BEFORE INSERT ON leads FOR EACH ROW EXECUTE FUNCTION public.leads_rate_limit();

-- ============================================================================
-- 5. M12 — NOTIFICATION LOG: dedupe + daily cap
-- ============================================================================
CREATE TABLE IF NOT EXISTS notification_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    type VARCHAR(32) NOT NULL,
    ref_id UUID NOT NULL,
    recipients INT NOT NULL CHECK (recipients >= 0),
    sent_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_notification_log_society_day ON notification_log(society_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_log_ref ON notification_log(type, ref_id, created_at DESC);
ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_log_read ON notification_log;
CREATE POLICY notification_log_read ON notification_log FOR SELECT USING (is_platform_admin() OR is_society_admin(society_id));

-- Returns {allowed, reason}; records the send when allowed.
-- Same event (type + id) is emailed at most once per 24 h; max 2000 emails per society per day.
CREATE OR REPLACE FUNCTION public.reserve_notification(p_society_id UUID, p_type TEXT, p_ref_id UUID, p_recipients INT)
RETURNS JSONB AS $$
DECLARE
    v_today INT;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'Only the society committee can send notifications');
    END IF;
    IF p_type NOT IN ('member_invite', 'professional_invite', 'bills_issued', 'receipt') OR p_recipients < 1 THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'Invalid notification');
    END IF;
    PERFORM 1 FROM societies WHERE id = p_society_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM notification_log WHERE type = p_type AND ref_id = p_ref_id AND created_at > now() - interval '24 hours') THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'Already emailed in the last 24 hours');
    END IF;
    SELECT coalesce(sum(recipients), 0) INTO v_today FROM notification_log
    WHERE society_id = p_society_id AND created_at > now() - interval '24 hours';
    IF v_today + p_recipients > 2000 THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'Daily email limit reached for this society');
    END IF;
    INSERT INTO notification_log (society_id, type, ref_id, recipients, sent_by)
    VALUES (p_society_id, p_type, p_ref_id, p_recipients, auth.uid());
    RETURN jsonb_build_object('allowed', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 6. PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.my_pending_invites() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.respond_to_invite(TEXT, UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.society_summary(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reserve_notification(UUID, TEXT, UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_pending_invites() TO authenticated;
GRANT EXECUTE ON FUNCTION public.respond_to_invite(TEXT, UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.society_summary(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_notification(UUID, TEXT, UUID, INT) TO authenticated;


-- ============================================================================
-- 013 ACCOUNTING CORE (P8)
--   1. Chart of accounts v2: GST input, vendor advances, fixed assets,
--      accumulated depreciation, professional fees, depreciation, software
--   2. Tax rules: tds_rules (platform, dated) and expense_categories
--      (platform defaults + society additions) -> ledger head + TDS nature
--   3. Vendors: PAN from GSTIN, entity type, lower-deduction certificate
--   4. Expenses: revenue vs capital, GST claimable, TDS suggestion + override
--      reason, invoice pending / no-invoice payment vouchers, duplicate check
--   5. suggest_tds(): category -> rule -> PAN entity -> yearly vendor total
--   6. Accrual: approval posts Dr expense/asset (+GST input) / Cr creditors and
--      creates the fixed asset; unpaid approved expenses are backfilled
--   7. Vendor payments (partial, TDS once), mark_expense_paid wrapper,
--      TDS challans, attach a pending invoice
--   8. void_expense v2: reverses payments and the accrual
--   9. Fixed assets: register, opening assets, depreciation preview / post,
--      disposal, rate changes
-- ============================================================================

-- ============================================================================
-- 1. CHART OF ACCOUNTS v2
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ensure_default_accounts(p_society_id UUID)
RETURNS VOID AS $$
BEGIN
    INSERT INTO accounts (society_id, code, name, type, is_system)
    SELECT p_society_id, a.code, a.name, a.type, true
    FROM (VALUES
        ('1000', 'Bank Accounts', 'asset'),
        ('1100', 'Cash in Hand', 'asset'),
        ('1200', 'Members Receivable', 'asset'),
        ('1300', 'GST Input Credit', 'asset'),
        ('1400', 'Advances & Deposits to Vendors', 'asset'),
        ('1500', 'Plant & Machinery', 'asset'),
        ('1510', 'Electrical Installations', 'asset'),
        ('1520', 'Furniture & Fixtures', 'asset'),
        ('1530', 'Computers & Equipment', 'asset'),
        ('1540', 'CCTV & Security Equipment', 'asset'),
        ('1550', 'Building Improvements', 'asset'),
        ('1590', 'Accumulated Depreciation', 'asset'),
        ('2000', 'Sundry Creditors', 'liability'),
        ('2100', 'GST Payable', 'liability'),
        ('2200', 'TDS Payable', 'liability'),
        ('2300', 'Advance Maintenance Received', 'liability'),
        ('3000', 'Sinking Fund', 'equity'),
        ('3100', 'Repair & Maintenance Fund', 'equity'),
        ('3200', 'General Reserve', 'equity'),
        ('4000', 'Maintenance Charges', 'income'),
        ('4100', 'Interest on Late Payment', 'income'),
        ('4200', 'Other Income', 'income'),
        ('4300', 'Gain / Loss on Sale of Assets', 'income'),
        ('5000', 'Repairs & Maintenance', 'expense'),
        ('5100', 'Security Charges', 'expense'),
        ('5200', 'Housekeeping', 'expense'),
        ('5300', 'Electricity (Common Areas)', 'expense'),
        ('5400', 'Water Charges', 'expense'),
        ('5600', 'Professional & Audit Fees', 'expense'),
        ('5700', 'Property Tax', 'expense'),
        ('5800', 'Depreciation', 'expense'),
        ('5850', 'Software & Subscriptions', 'expense'),
        ('5900', 'Other Expenses', 'expense')
    ) AS a(code, name, type)
    ON CONFLICT (society_id, code) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT id FROM societies LOOP
        PERFORM ensure_default_accounts(r.id);
    END LOOP;
END
$$;

-- create_society() seeds the original 19 accounts; this tops up new ones at commit
CREATE OR REPLACE FUNCTION public.trg_society_default_accounts()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM societies WHERE id = NEW.id) THEN
        PERFORM ensure_default_accounts(NEW.id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_society_default_accounts ON societies;
CREATE CONSTRAINT TRIGGER trg_society_default_accounts
    AFTER INSERT ON societies
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.trg_society_default_accounts();

-- ============================================================================
-- 2. TAX RULES
-- ============================================================================
CREATE TABLE IF NOT EXISTS tds_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nature VARCHAR(32) NOT NULL CHECK (nature IN ('contract', 'professional', 'technical', 'rent_building', 'rent_machinery')),
    label VARCHAR(96) NOT NULL,
    section_label VARCHAR(32) NOT NULL,           -- editable: the Income-tax Act, 2025 renumbers sections
    rate_individual NUMERIC(5,2) NOT NULL CHECK (rate_individual BETWEEN 0 AND 100),
    rate_other NUMERIC(5,2) NOT NULL CHECK (rate_other BETWEEN 0 AND 100),
    single_bill_limit NUMERIC(14,2),              -- TDS when one bill is above this
    annual_limit NUMERIC(14,2),                   -- ... or the vendor's FY total is above this
    effective_from DATE NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    updated_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_tds_rule_nature_from UNIQUE (nature, effective_from)
);

-- Defaults: rates as amended by the Finance Act 2025. Confirm with a CA before go-live.
INSERT INTO tds_rules (nature, label, section_label, rate_individual, rate_other, single_bill_limit, annual_limit, effective_from) VALUES
    ('contract',       'Contract work',          '194C', 1,  2,  30000, 100000, '2025-04-01'),
    ('professional',   'Professional fees',      '194J', 10, 10, NULL,  50000,  '2025-04-01'),
    ('technical',      'Technical services',     '194J', 2,  2,  NULL,  50000,  '2025-04-01'),
    ('rent_building',  'Rent — building / hall', '194I', 10, 10, 50000, NULL,   '2025-04-01'),
    ('rent_machinery', 'Rent — machinery',       '194I', 2,  2,  50000, NULL,   '2025-04-01')
ON CONFLICT (nature, effective_from) DO NOTHING;

INSERT INTO platform_settings (key, value, description) VALUES
    ('tds_no_pan_rate', '{"rate": 20}', 'TDS rate when the vendor has no PAN (206AA)')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE tds_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tds_rules_select ON tds_rules;
DROP POLICY IF EXISTS tds_rules_platform_write ON tds_rules;
CREATE POLICY tds_rules_select ON tds_rules FOR SELECT TO authenticated USING (true);
CREATE POLICY tds_rules_platform_write ON tds_rules
    FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());

CREATE TABLE IF NOT EXISTS expense_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID REFERENCES societies(id) ON DELETE CASCADE,   -- NULL = Sahvaas default
    key VARCHAR(48) NOT NULL CHECK (key ~ '^[a-z0-9_]+$'),
    label VARCHAR(96) NOT NULL,
    account_code VARCHAR(32) NOT NULL,             -- head when booked as an expense
    asset_account_code VARCHAR(32) CHECK (asset_account_code IN ('1500', '1510', '1520', '1530', '1540', '1550')),
    asset_threshold NUMERIC(14,2),                 -- suggest "asset" at or above this amount
    tds_nature VARCHAR(32) NOT NULL DEFAULT 'none'
        CHECK (tds_nature IN ('none', 'goods', 'contract', 'professional', 'technical', 'rent_building', 'rent_machinery')),
    sort_order INT NOT NULL DEFAULT 100,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_category_key
    ON expense_categories (coalesce(society_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

INSERT INTO expense_categories (society_id, key, label, account_code, asset_account_code, asset_threshold, tds_nature, sort_order)
SELECT NULL, c.key, c.label, c.account_code, c.asset_code, c.threshold, c.nature, c.sort_order
FROM (VALUES
    ('security',      'Security',                    '5100', NULL,   NULL::numeric, 'contract',     10),
    ('housekeeping',  'Housekeeping',                '5200', NULL,   NULL,          'contract',     20),
    ('gardening',     'Gardening',                   '5200', NULL,   NULL,          'contract',     30),
    ('pest_control',  'Pest control',                '5200', NULL,   NULL,          'contract',     40),
    ('electricity',   'Electricity (common)',        '5300', NULL,   NULL,          'none',         50),
    ('water',         'Water',                       '5400', NULL,   NULL,          'none',         60),
    ('repairs',       'Repairs & maintenance',       '5000', NULL,   NULL,          'contract',     70),
    ('plumbing',      'Plumbing',                    '5000', NULL,   NULL,          'contract',     80),
    ('electrical',    'Electrical work',             '5000', '1510', 25000,         'contract',     90),
    ('painting',      'Painting',                    '5000', NULL,   NULL,          'contract',    100),
    ('lift_amc',      'Lift AMC',                    '5000', NULL,   NULL,          'contract',    110),
    ('cctv',          'CCTV / security equipment',   '5000', '1540', 25000,         'contract',    120),
    ('pump_motor',    'Pump / motor',                '5000', '1500', 25000,         'contract',    130),
    ('generator',     'Generator',                   '5000', '1500', 25000,         'contract',    140),
    ('furniture',     'Furniture',                   '5900', '1520', 25000,         'goods',       150),
    ('computers',     'Computers / equipment',       '5900', '1530', 25000,         'goods',       160),
    ('building_works','Major building works',        '5000', '1550', 25000,         'contract',    170),
    ('legal_audit',   'Legal / audit fees',          '5600', NULL,   NULL,          'professional',180),
    ('professional',  'Architect / consultant fees', '5600', NULL,   NULL,          'professional',190),
    ('property_tax',  'Property tax',                '5700', NULL,   NULL,          'none',        200),
    ('software',      'Software & subscriptions',    '5850', NULL,   NULL,          'none',        210),
    ('bank_charges',  'Bank charges',                '5900', NULL,   NULL,          'none',        220),
    ('other',         'Other',                       '5900', NULL,   NULL,          'none',        900)
) AS c(key, label, account_code, asset_code, threshold, nature, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM expense_categories e WHERE e.society_id IS NULL AND e.key = c.key);

ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS expense_categories_select ON expense_categories;
DROP POLICY IF EXISTS expense_categories_write ON expense_categories;
CREATE POLICY expense_categories_select ON expense_categories
    FOR SELECT USING (
        society_id IS NULL OR is_platform_admin() OR is_committee_viewer(society_id)
        OR has_professional_permission(society_id, 'view_expenses')
    );
CREATE POLICY expense_categories_write ON expense_categories
    FOR ALL USING (
        (society_id IS NULL AND is_platform_admin())
        OR (society_id IS NOT NULL AND (is_platform_admin() OR is_society_admin(society_id)))
    )
    WITH CHECK (
        (society_id IS NULL AND is_platform_admin())
        OR (society_id IS NOT NULL AND (is_platform_admin() OR is_society_admin(society_id)))
    );

-- A society's own category wins over the Sahvaas default with the same key
CREATE OR REPLACE FUNCTION public.resolve_expense_category(p_society_id UUID, p_key TEXT)
RETURNS expense_categories AS $$
    SELECT * FROM expense_categories
    WHERE key = p_key AND is_active AND (society_id = p_society_id OR society_id IS NULL)
    ORDER BY society_id NULLS LAST
    LIMIT 1
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. VENDORS: PAN, ENTITY TYPE, LOWER-DEDUCTION CERTIFICATE
-- ============================================================================
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS tds_override_rate NUMERIC(5,2) CHECK (tds_override_rate BETWEEN 0 AND 100);
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS tds_certificate_no VARCHAR(64);
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS tds_override_valid_till DATE;

-- PAN as given, else characters 3-12 of the GSTIN
CREATE OR REPLACE FUNCTION public.vendor_pan(p_pan TEXT, p_gstin TEXT)
RETURNS TEXT AS $$
    SELECT CASE
        WHEN upper(trim(coalesce(p_pan, ''))) ~ '^[A-Z]{5}[0-9]{4}[A-Z]$' THEN upper(trim(p_pan))
        WHEN upper(trim(coalesce(p_gstin, ''))) ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$' THEN substr(upper(trim(p_gstin)), 3, 10)
        ELSE NULL
    END
$$ LANGUAGE sql IMMUTABLE;

-- 4th letter of a PAN: P (person) and H (HUF) take the individual rate; C, F, A, T ... the other rate
CREATE OR REPLACE FUNCTION public.pan_entity(p_pan TEXT)
RETURNS TEXT AS $$
    SELECT CASE WHEN p_pan IS NULL THEN NULL WHEN substr(p_pan, 4, 1) IN ('P', 'H') THEN 'individual' ELSE 'other' END
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.vendors_normalise()
RETURNS TRIGGER AS $$
BEGIN
    NEW.gstin := nullif(upper(trim(coalesce(NEW.gstin, ''))), '');
    NEW.pan := coalesce(vendor_pan(NEW.pan, NULL), vendor_pan(NULL, NEW.gstin), nullif(upper(trim(coalesce(NEW.pan, ''))), ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_vendors_normalise ON vendors;
CREATE TRIGGER trg_vendors_normalise BEFORE INSERT OR UPDATE ON vendors
    FOR EACH ROW EXECUTE FUNCTION public.vendors_normalise();

-- ============================================================================
-- 4. EXPENSES: CLASSIFICATION, TDS, INVOICE STATUS, VOUCHERS
-- ============================================================================
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS expense_type VARCHAR(16) NOT NULL DEFAULT 'revenue'
    CHECK (expense_type IN ('revenue', 'capital'));
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS asset_account_code VARCHAR(32);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS asset_location VARCHAR(128);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS funded_from VARCHAR(16) NOT NULL DEFAULT 'general'
    CHECK (funded_from IN ('general', 'sinking_fund', 'repair_fund'));
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS gst_claimable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tds_nature VARCHAR(32);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tds_section VARCHAR(32);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tds_rate NUMERIC(5,2);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tds_rule_id UUID REFERENCES tds_rules(id);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tds_suggested NUMERIC(12,2);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tds_override_reason TEXT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS invoice_status VARCHAR(16) NOT NULL DEFAULT 'invoice'
    CHECK (invoice_status IN ('invoice', 'pending', 'none'));
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS invoice_due_by DATE;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS voucher_number VARCHAR(32);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payee_name VARCHAR(128);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payee_phone VARCHAR(32);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS extraction JSONB;       -- what the invoice reader returned (audit)
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS amount_settled NUMERIC(12,2) NOT NULL DEFAULT 0;  -- paid + TDS so far
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS tds_deducted NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_payment_status_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_payment_status_check CHECK (payment_status IN ('unpaid', 'partial', 'paid'));

-- Legacy rows that were already paid count as fully settled
UPDATE expenses SET amount_settled = subtotal + gst_amount, tds_deducted = tds_amount
WHERE (status = 'paid' OR payment_status = 'paid') AND amount_settled = 0;

ALTER TABLE society_settings ADD COLUMN IF NOT EXISTS voucher_cash_limit NUMERIC(12,2) NOT NULL DEFAULT 5000
    CHECK (voucher_cash_limit >= 0);

CREATE OR REPLACE FUNCTION public.expenses_accounting_checks()
RETURNS TRIGGER AS $$
DECLARE
    v_workflow BOOLEAN := coalesce(current_setting('sahvaas.expense_workflow', true), '') = 'on';
    v_cat expense_categories;
    v_dup TEXT;
BEGIN
    IF NEW.expense_type = 'capital' THEN
        IF NEW.asset_account_code IS NULL THEN
            v_cat := resolve_expense_category(NEW.society_id, NEW.category);
            NEW.asset_account_code := v_cat.asset_account_code;
        END IF;
        IF NEW.asset_account_code IS NULL OR NEW.asset_account_code NOT IN ('1500', '1510', '1520', '1530', '1540', '1550') THEN
            RAISE EXCEPTION 'Pick an asset type for a purchase booked as an asset';
        END IF;
    ELSE
        NEW.asset_account_code := NULL;
    END IF;

    IF (TG_OP = 'INSERT' OR NEW.tds_amount IS DISTINCT FROM OLD.tds_amount OR NEW.subtotal IS DISTINCT FROM OLD.subtotal)
       AND NEW.tds_amount > NEW.subtotal THEN
        RAISE EXCEPTION 'TDS cannot be more than the taxable amount';
    END IF;
    IF NEW.tds_suggested IS NOT NULL AND NEW.tds_amount <> NEW.tds_suggested
       AND length(trim(coalesce(NEW.tds_override_reason, ''))) = 0 THEN
        RAISE EXCEPTION 'TDS differs from the suggested ₹% — add a reason', NEW.tds_suggested;
    END IF;

    IF NEW.invoice_status = 'none' THEN
        IF length(trim(coalesce(NEW.payee_name, ''))) = 0 THEN
            RAISE EXCEPTION 'Enter who was paid — a voucher needs the payee name';
        END IF;
        IF NEW.document_url IS NULL THEN
            RAISE EXCEPTION 'Attach a photo of the work or a handwritten receipt for the voucher';
        END IF;
        IF NEW.gst_amount <> 0 THEN
            RAISE EXCEPTION 'GST can only be recorded with a tax invoice';
        END IF;
        NEW.gst_claimable := false;
        IF TG_OP = 'INSERT' AND coalesce(NEW.voucher_number, '') = '' THEN
            NEW.voucher_number := 'PV-' || lpad(next_society_number(NEW.society_id, 'expenses', 'voucher_number', 'PV-')::text, 4, '0');
        END IF;
    ELSIF NEW.invoice_status = 'pending' AND NEW.invoice_due_by IS NULL THEN
        NEW.invoice_due_by := current_date + 7;
    END IF;

    IF (TG_OP = 'INSERT' OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number)
       AND NEW.vendor_id IS NOT NULL AND length(trim(coalesce(NEW.invoice_number, ''))) > 0
       AND NEW.status NOT IN ('voided', 'rejected') THEN
        SELECT expense_number INTO v_dup FROM expenses
        WHERE society_id = NEW.society_id AND vendor_id = NEW.vendor_id
          AND lower(trim(invoice_number)) = lower(trim(NEW.invoice_number))
          AND status NOT IN ('voided', 'rejected') AND id <> NEW.id
        LIMIT 1;
        IF v_dup IS NOT NULL THEN
            RAISE EXCEPTION 'Invoice % from this vendor is already recorded as %', trim(NEW.invoice_number), v_dup;
        END IF;
    END IF;

    IF auth.uid() IS NOT NULL AND NOT v_workflow THEN
        IF TG_OP = 'INSERT' THEN
            NEW.amount_settled := 0;
            NEW.tds_deducted := 0;
        ELSE
            IF NEW.amount_settled IS DISTINCT FROM OLD.amount_settled OR NEW.tds_deducted IS DISTINCT FROM OLD.tds_deducted
               OR NEW.voucher_number IS DISTINCT FROM OLD.voucher_number THEN
                RAISE EXCEPTION 'Use the payment workflow to record payments';
            END IF;
            IF OLD.status IN ('approved', 'paid') AND (
                NEW.expense_type IS DISTINCT FROM OLD.expense_type
                OR NEW.asset_account_code IS DISTINCT FROM OLD.asset_account_code
                OR NEW.gst_claimable IS DISTINCT FROM OLD.gst_claimable
                OR NEW.category IS DISTINCT FROM OLD.category
                OR NEW.invoice_status IS DISTINCT FROM OLD.invoice_status
            ) THEN
                RAISE EXCEPTION 'Approved expenses cannot be edited; void it and create a new one';
            END IF;
        END IF;
    ELSIF TG_OP = 'INSERT' AND NEW.status = 'paid' AND NEW.amount_settled = 0 THEN
        -- Imports / seeds of already-paid bills count as fully settled
        NEW.amount_settled := NEW.subtotal + NEW.gst_amount;
        NEW.tds_deducted := NEW.tds_amount;
        NEW.payment_status := 'paid';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_expenses_accounting_checks ON expenses;
CREATE TRIGGER trg_expenses_accounting_checks
    BEFORE INSERT OR UPDATE ON expenses
    FOR EACH ROW EXECUTE FUNCTION public.expenses_accounting_checks();

-- ============================================================================
-- 5. TDS SUGGESTION
--    Returns { applies, nature, section, label, rate, amount, base, rule_id,
--              pan, entity, rate_source, reason, fy_total, single_limit, annual_limit }
--    reason: no_category | no_tds | goods | no_rule | below_limits | single_bill | annual_total
-- ============================================================================
CREATE OR REPLACE FUNCTION public.suggest_tds(
    p_society_id UUID,
    p_vendor_id UUID,
    p_category TEXT,
    p_taxable NUMERIC,
    p_invoice_date DATE DEFAULT NULL,
    p_expense_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_date DATE := coalesce(p_invoice_date, current_date);
    v_taxable NUMERIC := round(coalesce(p_taxable, 0), 2);
    v_cat expense_categories;
    v_rule tds_rules%ROWTYPE;
    v_vendor vendors%ROWTYPE;
    v_pan TEXT;
    v_entity TEXT;
    v_rate NUMERIC;
    v_rate_source TEXT;
    v_fy_start DATE;
    v_prior NUMERIC := 0;
    v_prior_untaxed NUMERIC := 0;
    v_base NUMERIC;
    v_reason TEXT := 'below_limits';
    v_applies BOOLEAN := false;
    v_amount NUMERIC := 0;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can work out TDS';
    END IF;

    v_cat := resolve_expense_category(p_society_id, p_category);
    IF v_cat.id IS NULL THEN
        RETURN jsonb_build_object('applies', false, 'amount', 0, 'rate', 0, 'nature', 'none', 'reason', 'no_category');
    END IF;
    IF v_cat.tds_nature IN ('none', 'goods') THEN
        RETURN jsonb_build_object('applies', false, 'amount', 0, 'rate', 0, 'nature', v_cat.tds_nature,
                                  'reason', CASE WHEN v_cat.tds_nature = 'goods' THEN 'goods' ELSE 'no_tds' END);
    END IF;

    SELECT * INTO v_rule FROM tds_rules
    WHERE nature = v_cat.tds_nature AND is_active AND effective_from <= v_date
    ORDER BY effective_from DESC LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('applies', false, 'amount', 0, 'rate', 0, 'nature', v_cat.tds_nature, 'reason', 'no_rule');
    END IF;

    IF p_vendor_id IS NOT NULL THEN
        SELECT * INTO v_vendor FROM vendors WHERE id = p_vendor_id AND society_id = p_society_id;
    END IF;
    v_pan := vendor_pan(v_vendor.pan, v_vendor.gstin);
    v_entity := pan_entity(v_pan);

    -- The vendor's total for the Indian financial year (April-March) of the invoice
    v_fy_start := make_date(extract(year FROM v_date)::int - CASE WHEN extract(month FROM v_date) < 4 THEN 1 ELSE 0 END, 4, 1);
    IF v_vendor.id IS NOT NULL THEN
        SELECT coalesce(sum(subtotal), 0), coalesce(sum(subtotal) FILTER (WHERE tds_amount = 0), 0)
        INTO v_prior, v_prior_untaxed
        FROM expenses
        WHERE society_id = p_society_id AND vendor_id = v_vendor.id
          AND status NOT IN ('voided', 'rejected', 'draft')
          AND coalesce(invoice_date, created_at::date) >= v_fy_start
          AND coalesce(invoice_date, created_at::date) < (v_fy_start + interval '1 year')::date
          AND (p_expense_id IS NULL OR id <> p_expense_id);
    END IF;

    v_base := v_taxable;
    IF v_rule.single_bill_limit IS NOT NULL AND v_taxable > v_rule.single_bill_limit THEN
        v_applies := true;
        v_reason := 'single_bill';
    END IF;
    IF v_rule.annual_limit IS NOT NULL AND v_prior + v_taxable > v_rule.annual_limit THEN
        IF NOT v_applies THEN
            v_reason := 'annual_total';
            -- Crossing the yearly limit: TDS also covers this year's earlier bills that had none
            v_base := v_taxable + v_prior_untaxed;
        END IF;
        v_applies := true;
    END IF;

    IF v_vendor.tds_override_rate IS NOT NULL
       AND (v_vendor.tds_override_valid_till IS NULL OR v_vendor.tds_override_valid_till >= v_date) THEN
        v_rate := v_vendor.tds_override_rate;
        v_rate_source := 'certificate';
    ELSIF v_pan IS NULL THEN
        SELECT coalesce((value ->> 'rate')::numeric, 20) INTO v_rate FROM platform_settings WHERE key = 'tds_no_pan_rate';
        v_rate := coalesce(v_rate, 20);
        v_rate_source := 'no_pan';
    ELSE
        v_rate := CASE WHEN v_entity = 'individual' THEN v_rule.rate_individual ELSE v_rule.rate_other END;
        v_rate_source := v_entity;
    END IF;

    IF v_applies THEN
        v_amount := least(round(v_base * v_rate / 100, 0), v_taxable);
    END IF;

    RETURN jsonb_build_object(
        'applies', v_applies,
        'nature', v_cat.tds_nature,
        'section', v_rule.section_label,
        'label', v_rule.label,
        'rate', CASE WHEN v_applies THEN v_rate ELSE 0 END,
        'amount', v_amount,
        'base', CASE WHEN v_applies THEN v_base ELSE 0 END,
        'rule_id', v_rule.id,
        'pan', v_pan,
        'entity', v_entity,
        'rate_source', v_rate_source,
        'reason', v_reason,
        'fy_total', v_prior + v_taxable,
        'single_limit', v_rule.single_bill_limit,
        'annual_limit', v_rule.annual_limit
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 6. ACCRUAL ON APPROVAL + FIXED ASSET CREATION
-- ============================================================================
CREATE OR REPLACE FUNCTION public.expense_debit_code(p_society_id UUID, p_category TEXT, p_type TEXT, p_asset_code TEXT)
RETURNS TEXT AS $$
    SELECT CASE
        WHEN p_type = 'capital' THEN p_asset_code
        ELSE coalesce((resolve_expense_category(p_society_id, p_category)).account_code, expense_account_code(p_category))
    END
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE TABLE IF NOT EXISTS fixed_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    asset_number VARCHAR(32) NOT NULL,
    name VARCHAR(191) NOT NULL,
    account_code VARCHAR(32) NOT NULL CHECK (account_code IN ('1500', '1510', '1520', '1530', '1540', '1550')),
    expense_id UUID UNIQUE REFERENCES expenses(id),
    vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
    put_to_use_date DATE NOT NULL,
    cost NUMERIC(14,2) NOT NULL CHECK (cost >= 0),
    opening_wdv NUMERIC(14,2) CHECK (opening_wdv >= 0),    -- assets brought in with the opening balances
    opening_as_of DATE,
    location VARCHAR(128),
    funded_from VARCHAR(16) NOT NULL DEFAULT 'general' CHECK (funded_from IN ('general', 'sinking_fund', 'repair_fund')),
    dep_method VARCHAR(8) NOT NULL DEFAULT 'wdv' CHECK (dep_method IN ('wdv', 'slm')),
    dep_rate NUMERIC(5,2) NOT NULL CHECK (dep_rate BETWEEN 0 AND 100),
    status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disposed', 'voided')),
    disposed_on DATE,
    disposal_amount NUMERIC(14,2),
    notes TEXT,
    created_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_asset_number UNIQUE (society_id, asset_number)
);
CREATE INDEX IF NOT EXISTS idx_fixed_assets_society ON fixed_assets (society_id, status);

-- Income-tax WDV rates as defaults; the committee can change a rate (logged)
CREATE OR REPLACE FUNCTION public.default_dep_rate(p_code TEXT)
RETURNS NUMERIC AS $$
    SELECT CASE p_code
        WHEN '1500' THEN 15 WHEN '1510' THEN 10 WHEN '1520' THEN 10
        WHEN '1530' THEN 40 WHEN '1540' THEN 15 WHEN '1550' THEN 10 ELSE 10
    END::numeric
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.ledger_post_expense_accrual(p_expense_id UUID)
RETURNS UUID AS $$
DECLARE
    v_exp expenses%ROWTYPE;
    v_vendor TEXT;
    v_gst_input NUMERIC;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id;
    IF NOT FOUND OR v_exp.status NOT IN ('approved', 'paid') THEN
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

CREATE OR REPLACE FUNCTION public.create_asset_for_expense(p_expense_id UUID)
RETURNS UUID AS $$
DECLARE
    v_exp expenses%ROWTYPE;
    v_id UUID;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id;
    IF NOT FOUND OR v_exp.expense_type <> 'capital' OR v_exp.status NOT IN ('approved', 'paid') THEN
        RETURN NULL;
    END IF;
    SELECT id INTO v_id FROM fixed_assets WHERE expense_id = p_expense_id;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;
    INSERT INTO fixed_assets (society_id, asset_number, name, account_code, expense_id, vendor_id, put_to_use_date,
                              cost, location, funded_from, dep_rate, created_by)
    VALUES (v_exp.society_id,
            'FA-' || lpad(next_society_number(v_exp.society_id, 'fixed_assets', 'asset_number', 'FA-')::text, 4, '0'),
            v_exp.title, v_exp.asset_account_code, v_exp.id, v_exp.vendor_id,
            coalesce(v_exp.invoice_date, v_exp.approved_at::date, current_date),
            v_exp.subtotal + v_exp.gst_amount - CASE WHEN v_exp.gst_claimable THEN v_exp.gst_amount ELSE 0 END,
            v_exp.asset_location, v_exp.funded_from, default_dep_rate(v_exp.asset_account_code), v_exp.approved_by)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.trg_expense_approved()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'approved' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'approved') THEN
        PERFORM ledger_post_expense_accrual(NEW.id);
        PERFORM create_asset_for_expense(NEW.id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_expense_approved ON expenses;
CREATE TRIGGER trg_expense_approved
    AFTER INSERT OR UPDATE OF status ON expenses
    FOR EACH ROW EXECUTE FUNCTION public.trg_expense_approved();

-- Cash-basis posting stays only for legacy rows; accrued expenses post per payment
CREATE OR REPLACE FUNCTION public.ledger_post_expense(p_expense_id UUID)
RETURNS UUID AS $$
DECLARE
    v_exp expenses%ROWTYPE;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id;
    IF NOT FOUND OR NOT (v_exp.status = 'paid' OR v_exp.payment_status = 'paid') THEN
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

-- Backfill: approved-but-unpaid expenses become payables now
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT e.id FROM expenses e
        WHERE e.status = 'approved' AND e.payment_status = 'unpaid'
          AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.society_id = e.society_id AND j.reference_event_id = e.id)
    LOOP
        PERFORM ledger_post_expense_accrual(r.id);
    END LOOP;
END
$$;

-- ============================================================================
-- 7. VENDOR PAYMENTS, TDS CHALLANS, PENDING INVOICES
-- ============================================================================
CREATE TABLE IF NOT EXISTS vendor_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    expense_id UUID NOT NULL REFERENCES expenses(id),
    payment_number VARCHAR(32) NOT NULL,
    paid_on DATE NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),          -- money that left the bank / cash
    tds_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tds_amount >= 0),
    mode VARCHAR(16) NOT NULL CHECK (mode IN ('neft', 'upi', 'cheque', 'cash')),
    reference VARCHAR(128),
    bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,
    proof_url TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'voided')),
    created_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_vendor_payment UNIQUE (society_id, payment_number),
    CONSTRAINT chk_vendor_payment_positive CHECK (amount + tds_amount > 0),
    CONSTRAINT chk_vendor_payment_proof_in_society CHECK (proof_url IS NULL OR proof_url LIKE society_id::text || '/%')
);
CREATE INDEX IF NOT EXISTS idx_vendor_payments_expense ON vendor_payments (expense_id);

CREATE TABLE IF NOT EXISTS tds_challans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    challan_number VARCHAR(64) NOT NULL,
    paid_on DATE NOT NULL,
    period_month DATE NOT NULL,                     -- first day of the month the TDS relates to
    section_label VARCHAR(32),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    reference VARCHAR(128),
    created_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_tds_challan UNIQUE (society_id, challan_number)
);

ALTER TABLE vendor_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tds_challans ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vendor_payments_select ON vendor_payments;
DROP POLICY IF EXISTS tds_challans_select ON tds_challans;
DROP POLICY IF EXISTS fixed_assets_select ON fixed_assets;
CREATE POLICY vendor_payments_select ON vendor_payments
    FOR SELECT USING (is_platform_admin() OR is_committee_viewer(society_id) OR has_professional_permission(society_id, 'view_expenses'));
CREATE POLICY tds_challans_select ON tds_challans
    FOR SELECT USING (is_platform_admin() OR is_committee_viewer(society_id) OR has_professional_permission(society_id, 'view_expenses')
                      OR has_professional_permission(society_id, 'view_ledger'));
CREATE POLICY fixed_assets_select ON fixed_assets
    FOR SELECT USING (is_platform_admin() OR is_committee_viewer(society_id) OR has_professional_permission(society_id, 'view_expenses')
                      OR can_view_financials(society_id));
-- No write policies: these tables change only through the functions below

CREATE OR REPLACE FUNCTION public.record_vendor_payment(
    p_expense_id UUID,
    p_amount NUMERIC,
    p_tds NUMERIC DEFAULT NULL,
    p_mode TEXT DEFAULT 'neft',
    p_reference TEXT DEFAULT NULL,
    p_paid_on DATE DEFAULT NULL,
    p_proof_url TEXT DEFAULT NULL,
    p_bank_account_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_exp expenses%ROWTYPE;
    v_mode TEXT := lower(trim(coalesce(p_mode, '')));
    v_paid_on DATE := coalesce(p_paid_on, current_date);
    v_amount NUMERIC := round(coalesce(p_amount, 0), 2);
    v_outstanding NUMERIC;
    v_tds_left NUMERIC;
    v_tds NUMERIC;
    v_settle NUMERIC;
    v_final BOOLEAN;
    v_limit NUMERIC;
    v_id UUID;
    v_number TEXT;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_exp.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can record expense payments';
    END IF;
    IF v_exp.status <> 'approved' THEN
        RAISE EXCEPTION 'Only approved expenses can be paid (this one is %)', v_exp.status;
    END IF;
    IF v_mode NOT IN ('neft', 'upi', 'cheque', 'cash') THEN
        RAISE EXCEPTION 'Payment mode must be NEFT, UPI, cheque or cash';
    END IF;
    IF v_amount < 0 THEN
        RAISE EXCEPTION 'Amount cannot be negative';
    END IF;
    IF v_paid_on > current_date THEN
        RAISE EXCEPTION 'Payment date cannot be in the future';
    END IF;
    IF p_bank_account_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM bank_accounts WHERE id = p_bank_account_id AND society_id = v_exp.society_id
    ) THEN
        RAISE EXCEPTION 'Bank account not found for this society';
    END IF;

    v_outstanding := v_exp.subtotal + v_exp.gst_amount - v_exp.amount_settled;
    v_tds_left := v_exp.tds_amount - v_exp.tds_deducted;
    v_tds := coalesce(round(p_tds, 2), v_tds_left);       -- default: deduct the remaining TDS now
    IF v_tds < 0 OR v_tds > v_tds_left THEN
        RAISE EXCEPTION 'TDS for this payment can be at most ₹%', v_tds_left;
    END IF;
    v_settle := v_amount + v_tds;
    IF v_settle <= 0 THEN
        RAISE EXCEPTION 'Enter the amount paid';
    END IF;
    IF v_settle > v_outstanding + 0.005 THEN
        RAISE EXCEPTION 'This is more than the ₹% still payable', v_outstanding;
    END IF;
    v_final := abs(v_settle - v_outstanding) < 0.005;
    IF v_final AND v_tds <> v_tds_left THEN
        RAISE EXCEPTION 'Deduct the remaining TDS ₹% with the final payment', v_tds_left;
    END IF;
    IF v_exp.invoice_status = 'none' AND v_mode = 'cash' THEN
        SELECT voucher_cash_limit INTO v_limit FROM society_settings WHERE society_id = v_exp.society_id;
        v_limit := coalesce(v_limit, 5000);
        IF v_amount > v_limit THEN
            RAISE EXCEPTION 'Cash payments without an invoice are limited to ₹% — pay by UPI or bank', v_limit;
        END IF;
    END IF;

    -- Safety net for rows approved outside the normal flow
    PERFORM ledger_post_expense_accrual(v_exp.id);

    v_number := 'VP-' || lpad(next_society_number(v_exp.society_id, 'vendor_payments', 'payment_number', 'VP-')::text, 4, '0');
    INSERT INTO vendor_payments (society_id, expense_id, payment_number, paid_on, amount, tds_amount, mode, reference,
                                 bank_account_id, proof_url, created_by)
    VALUES (v_exp.society_id, v_exp.id, v_number, v_paid_on, v_amount, v_tds, v_mode,
            nullif(trim(coalesce(p_reference, '')), ''), p_bank_account_id, p_proof_url, auth.uid())
    RETURNING id INTO v_id;

    PERFORM post_journal(
        v_exp.society_id, v_paid_on, 'vendor_payment.recorded', v_id,
        'Payment ' || v_number || ' for ' || coalesce(v_exp.voucher_number, v_exp.expense_number) || ' (' || upper(v_mode)
            || coalesce(' ' || nullif(trim(coalesce(p_reference, '')), ''), '') || ')',
        jsonb_build_array(
            jsonb_build_object('code', '2000', 'amount', v_settle),
            jsonb_build_object('code', CASE WHEN v_mode = 'cash' THEN '1100' ELSE '1000' END, 'amount', -v_amount),
            jsonb_build_object('code', '2200', 'amount', -v_tds)
        )
    );

    PERFORM set_config('sahvaas.expense_workflow', 'on', true);
    UPDATE expenses
    SET amount_settled = amount_settled + v_settle,
        tds_deducted = tds_deducted + v_tds,
        payment_status = CASE WHEN v_final THEN 'paid' ELSE 'partial' END,
        status = CASE WHEN v_final THEN 'paid' ELSE status END,
        paid_date = CASE WHEN v_final THEN v_paid_on ELSE paid_date END,
        payment_reference = coalesce(nullif(trim(coalesce(p_reference, '')), ''), payment_reference),
        updated_at = timezone('utc'::text, now())
    WHERE id = v_exp.id;
    PERFORM set_config('sahvaas.expense_workflow', 'off', true);

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_exp.society_id, auth.uid(), 'expense.payment_recorded', 'expense', v_exp.id::text,
            jsonb_build_object('payment_number', v_number, 'amount', v_amount, 'tds', v_tds, 'mode', v_mode,
                               'reference', p_reference, 'outstanding', v_outstanding - v_settle));

    RETURN jsonb_build_object(
        'payment_id', v_id,
        'payment_number', v_number,
        'settled', v_settle,
        'outstanding', round(v_outstanding - v_settle, 2),
        'status', CASE WHEN v_final THEN 'paid' ELSE 'partial' END
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Kept for existing callers: pays whatever is still payable in one go
CREATE OR REPLACE FUNCTION public.mark_expense_paid(p_expense_id UUID, p_paid_date DATE DEFAULT current_date, p_reference TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_exp expenses%ROWTYPE;
    v_tds_left NUMERIC;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_exp.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can record expense payments';
    END IF;
    v_tds_left := v_exp.tds_amount - v_exp.tds_deducted;
    PERFORM record_vendor_payment(p_expense_id,
                                  v_exp.subtotal + v_exp.gst_amount - v_exp.amount_settled - v_tds_left,
                                  v_tds_left, 'neft', p_reference, coalesce(p_paid_date, current_date));
    RETURN jsonb_build_object('status', 'paid', 'net_payable', v_exp.net_payable);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.record_tds_challan(
    p_society_id UUID,
    p_challan_number TEXT,
    p_amount NUMERIC,
    p_paid_on DATE,
    p_period_month DATE,
    p_section TEXT DEFAULT NULL,
    p_reference TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_payable NUMERIC;
    v_amount NUMERIC := round(coalesce(p_amount, 0), 2);
    v_id UUID;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can record TDS deposits';
    END IF;
    IF length(trim(coalesce(p_challan_number, ''))) = 0 THEN
        RAISE EXCEPTION 'Challan number is required';
    END IF;
    IF v_amount <= 0 THEN
        RAISE EXCEPTION 'Enter the amount deposited';
    END IF;
    IF p_paid_on IS NULL OR p_paid_on > current_date THEN
        RAISE EXCEPTION 'Deposit date must be today or earlier';
    END IF;

    SELECT -coalesce(sum(l.amount), 0) INTO v_payable
    FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
    WHERE l.society_id = p_society_id AND a.code = '2200';
    IF v_amount > v_payable + 0.005 THEN
        RAISE EXCEPTION 'Only ₹% of TDS is waiting to be deposited', v_payable;
    END IF;

    INSERT INTO tds_challans (society_id, challan_number, paid_on, period_month, section_label, amount, reference, created_by)
    VALUES (p_society_id, trim(p_challan_number), p_paid_on, date_trunc('month', coalesce(p_period_month, p_paid_on))::date,
            nullif(trim(coalesce(p_section, '')), ''), v_amount, nullif(trim(coalesce(p_reference, '')), ''), auth.uid())
    RETURNING id INTO v_id;

    PERFORM post_journal(p_society_id, p_paid_on, 'tds.deposited', v_id,
                         'TDS deposited, challan ' || trim(p_challan_number),
                         jsonb_build_array(
                             jsonb_build_object('code', '2200', 'amount', v_amount),
                             jsonb_build_object('code', '1000', 'amount', -v_amount)
                         ));

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'tds.deposited', 'tds_challan', v_id::text,
            jsonb_build_object('challan', trim(p_challan_number), 'amount', v_amount));

    RETURN jsonb_build_object('id', v_id, 'remaining', round(v_payable - v_amount, 2));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- "Invoice comes later": attach it once it arrives (allowed even after payment)
CREATE OR REPLACE FUNCTION public.attach_expense_invoice(
    p_expense_id UUID, p_document_url TEXT, p_invoice_number TEXT DEFAULT NULL, p_invoice_date DATE DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_exp expenses%ROWTYPE;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_exp.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can attach invoices';
    END IF;
    IF v_exp.invoice_status <> 'pending' THEN
        RAISE EXCEPTION 'This expense is not waiting for an invoice';
    END IF;
    IF p_document_url IS NULL OR p_document_url NOT LIKE v_exp.society_id::text || '/%' THEN
        RAISE EXCEPTION 'Upload the invoice file first';
    END IF;

    PERFORM set_config('sahvaas.expense_workflow', 'on', true);
    UPDATE expenses
    SET document_url = p_document_url,
        invoice_number = coalesce(nullif(trim(coalesce(p_invoice_number, '')), ''), invoice_number),
        invoice_date = coalesce(p_invoice_date, invoice_date),
        invoice_status = 'invoice',
        updated_at = timezone('utc'::text, now())
    WHERE id = p_expense_id;
    PERFORM set_config('sahvaas.expense_workflow', 'off', true);

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_exp.society_id, auth.uid(), 'expense.invoice_attached', 'expense', p_expense_id::text,
            jsonb_build_object('invoice_number', p_invoice_number, 'document', p_document_url));
    RETURN jsonb_build_object('status', 'attached');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 8. VOID v2: reverse payments, then the accrual (or the legacy cash entry)
-- ============================================================================
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
-- 9. FIXED ASSETS: OPENING ASSETS, DEPRECIATION, DISPOSAL
-- ============================================================================
CREATE TABLE IF NOT EXISTS depreciation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    fy_start DATE NOT NULL,
    fy_end DATE NOT NULL,
    total NUMERIC(14,2) NOT NULL,
    posted_by UUID REFERENCES profiles(id),
    posted_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT uq_society_depreciation_fy UNIQUE (society_id, fy_end)
);

CREATE TABLE IF NOT EXISTS depreciation_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES depreciation_runs(id) ON DELETE CASCADE,
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    asset_id UUID NOT NULL REFERENCES fixed_assets(id),
    opening_wdv NUMERIC(14,2) NOT NULL,
    additions NUMERIC(14,2) NOT NULL,
    rate NUMERIC(5,2) NOT NULL,
    half_rate BOOLEAN NOT NULL,
    amount NUMERIC(14,2) NOT NULL,
    closing_wdv NUMERIC(14,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_depreciation_lines_asset ON depreciation_lines (asset_id);

ALTER TABLE depreciation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE depreciation_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS depreciation_runs_select ON depreciation_runs;
DROP POLICY IF EXISTS depreciation_lines_select ON depreciation_lines;
CREATE POLICY depreciation_runs_select ON depreciation_runs
    FOR SELECT USING (is_platform_admin() OR is_committee_viewer(society_id) OR can_view_financials(society_id)
                      OR has_professional_permission(society_id, 'view_expenses'));
CREATE POLICY depreciation_lines_select ON depreciation_lines
    FOR SELECT USING (is_platform_admin() OR is_committee_viewer(society_id) OR can_view_financials(society_id)
                      OR has_professional_permission(society_id, 'view_expenses'));

-- Existing assets: their value must already be in the opening balances (no journal here)
CREATE OR REPLACE FUNCTION public.add_existing_asset(
    p_society_id UUID,
    p_name TEXT,
    p_account_code TEXT,
    p_put_to_use DATE,
    p_cost NUMERIC,
    p_wdv NUMERIC,
    p_as_of DATE,
    p_rate NUMERIC DEFAULT NULL,
    p_location TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_id UUID;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can add assets';
    END IF;
    IF length(trim(coalesce(p_name, ''))) < 2 THEN
        RAISE EXCEPTION 'Enter the asset name';
    END IF;
    IF p_account_code NOT IN ('1500', '1510', '1520', '1530', '1540', '1550') THEN
        RAISE EXCEPTION 'Pick an asset type';
    END IF;
    IF coalesce(p_wdv, -1) < 0 OR coalesce(p_cost, -1) < p_wdv THEN
        RAISE EXCEPTION 'Written-down value must be between 0 and the original cost';
    END IF;
    IF p_put_to_use IS NULL OR p_as_of IS NULL OR p_put_to_use > p_as_of THEN
        RAISE EXCEPTION 'Purchase date must be on or before the opening date';
    END IF;

    INSERT INTO fixed_assets (society_id, asset_number, name, account_code, put_to_use_date, cost, opening_wdv, opening_as_of,
                              location, dep_rate, created_by)
    VALUES (p_society_id,
            'FA-' || lpad(next_society_number(p_society_id, 'fixed_assets', 'asset_number', 'FA-')::text, 4, '0'),
            trim(p_name), p_account_code, p_put_to_use, round(p_cost, 2), round(p_wdv, 2), p_as_of,
            nullif(trim(coalesce(p_location, '')), ''), coalesce(p_rate, default_dep_rate(p_account_code)), auth.uid())
    RETURNING id INTO v_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'asset.added_existing', 'fixed_asset', v_id::text,
            jsonb_build_object('name', trim(p_name), 'cost', p_cost, 'wdv', p_wdv, 'as_of', p_as_of));
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.update_asset(
    p_asset_id UUID, p_name TEXT, p_location TEXT, p_dep_rate NUMERIC, p_dep_method TEXT, p_reason TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_asset fixed_assets%ROWTYPE;
BEGIN
    SELECT * INTO v_asset FROM fixed_assets WHERE id = p_asset_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Asset not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_asset.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can change assets';
    END IF;
    IF v_asset.status <> 'active' THEN
        RAISE EXCEPTION 'Asset % is %', v_asset.asset_number, v_asset.status;
    END IF;
    IF p_dep_rate IS NULL OR p_dep_rate < 0 OR p_dep_rate > 100 THEN
        RAISE EXCEPTION 'Depreciation rate must be between 0 and 100';
    END IF;
    IF coalesce(p_dep_method, '') NOT IN ('wdv', 'slm') THEN
        RAISE EXCEPTION 'Method must be WDV or SLM';
    END IF;
    IF (p_dep_rate <> v_asset.dep_rate OR p_dep_method <> v_asset.dep_method) AND length(trim(coalesce(p_reason, ''))) = 0 THEN
        RAISE EXCEPTION 'Give a reason for changing the depreciation rate or method';
    END IF;

    UPDATE fixed_assets
    SET name = coalesce(nullif(trim(coalesce(p_name, '')), ''), name),
        location = nullif(trim(coalesce(p_location, '')), ''),
        dep_rate = p_dep_rate, dep_method = p_dep_method,
        updated_at = timezone('utc'::text, now())
    WHERE id = p_asset_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, old_value, new_value, reason)
    VALUES (v_asset.society_id, auth.uid(), 'asset.updated', 'fixed_asset', p_asset_id::text,
            jsonb_build_object('rate', v_asset.dep_rate, 'method', v_asset.dep_method, 'name', v_asset.name),
            jsonb_build_object('rate', p_dep_rate, 'method', p_dep_method, 'name', p_name), nullif(trim(coalesce(p_reason, '')), ''));
    RETURN jsonb_build_object('status', 'updated');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- WDV at the start of the year, additions during it, depreciation for it.
-- Additions used for less than 180 days in the year get half the rate.
CREATE OR REPLACE FUNCTION public.preview_depreciation(p_society_id UUID, p_fy_end DATE)
RETURNS TABLE (
    asset_id UUID, asset_number TEXT, name TEXT, account_code TEXT, put_to_use_date DATE,
    opening_wdv NUMERIC, additions NUMERIC, rate NUMERIC, half_rate BOOLEAN, depreciation NUMERIC, closing_wdv NUMERIC
) AS $$
DECLARE
    v_start DATE;
BEGIN
    IF NOT (is_platform_admin() OR can_view_financials(p_society_id) OR has_professional_permission(p_society_id, 'view_expenses')) THEN
        RAISE EXCEPTION 'You do not have access to this society''s assets';
    END IF;
    IF p_fy_end IS NULL OR extract(month FROM p_fy_end) <> 3 OR extract(day FROM p_fy_end) <> 31 THEN
        RAISE EXCEPTION 'A financial year ends on 31 March';
    END IF;
    v_start := (p_fy_end - interval '1 year' + interval '1 day')::date;

    RETURN QUERY
    WITH acc AS (
        SELECT l.asset_id AS id, sum(l.amount) AS dep
        FROM depreciation_lines l JOIN depreciation_runs r ON r.id = l.run_id
        WHERE r.society_id = p_society_id AND r.fy_end < v_start
        GROUP BY l.asset_id
    ), base AS (
        SELECT a.*, coalesce(acc.dep, 0) AS acc_dep,
               (a.opening_as_of IS NULL AND a.put_to_use_date >= v_start) AS is_addition
        FROM fixed_assets a LEFT JOIN acc ON acc.id = a.id
        WHERE a.society_id = p_society_id AND a.status = 'active' AND a.put_to_use_date <= p_fy_end
    ), calc AS (
        SELECT b.*,
               CASE WHEN b.is_addition THEN 0 ELSE greatest(coalesce(b.opening_wdv, b.cost) - b.acc_dep, 0) END AS wdv_open,
               CASE WHEN b.is_addition THEN b.cost ELSE 0 END AS adds,
               (b.is_addition AND (p_fy_end - b.put_to_use_date + 1) < 180) AS half
        FROM base b
    ), dep AS (
        SELECT c.*,
               least(c.wdv_open + c.adds,
                     round(CASE WHEN c.dep_method = 'slm' THEN coalesce(c.opening_wdv, c.cost) ELSE c.wdv_open + c.adds END
                           * c.dep_rate / 100 * CASE WHEN c.half THEN 0.5 ELSE 1 END, 0)) AS amount
        FROM calc c
    )
    SELECT d.id, d.asset_number::text, d.name::text, d.account_code::text, d.put_to_use_date,
           d.wdv_open, d.adds, d.dep_rate, d.half, d.amount, d.wdv_open + d.adds - d.amount
    FROM dep d
    ORDER BY d.asset_number;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.post_depreciation(p_society_id UUID, p_fy_end DATE)
RETURNS JSONB AS $$
DECLARE
    v_run UUID;
    v_total NUMERIC;
    v_count INT;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can post depreciation';
    END IF;
    IF p_fy_end IS NULL OR extract(month FROM p_fy_end) <> 3 OR extract(day FROM p_fy_end) <> 31 THEN
        RAISE EXCEPTION 'A financial year ends on 31 March';
    END IF;
    IF current_date < p_fy_end - 30 THEN
        RAISE EXCEPTION 'Depreciation for the year ending % can be posted from %', to_char(p_fy_end, 'DD Mon YYYY'),
            to_char(p_fy_end - 30, 'DD Mon YYYY');
    END IF;
    IF EXISTS (SELECT 1 FROM depreciation_runs WHERE society_id = p_society_id AND fy_end = p_fy_end) THEN
        RAISE EXCEPTION 'Depreciation for the year ending % is already posted', to_char(p_fy_end, 'DD Mon YYYY');
    END IF;

    SELECT coalesce(sum(depreciation), 0), count(*) FILTER (WHERE depreciation > 0) INTO v_total, v_count
    FROM preview_depreciation(p_society_id, p_fy_end);
    IF v_total <= 0 THEN
        RAISE EXCEPTION 'Nothing to depreciate for this year';
    END IF;

    INSERT INTO depreciation_runs (society_id, fy_start, fy_end, total, posted_by)
    VALUES (p_society_id, (p_fy_end - interval '1 year' + interval '1 day')::date, p_fy_end, v_total, auth.uid())
    RETURNING id INTO v_run;

    INSERT INTO depreciation_lines (run_id, society_id, asset_id, opening_wdv, additions, rate, half_rate, amount, closing_wdv)
    SELECT v_run, p_society_id, p.asset_id, p.opening_wdv, p.additions, p.rate, p.half_rate, p.depreciation, p.closing_wdv
    FROM preview_depreciation(p_society_id, p_fy_end) p
    WHERE p.depreciation > 0;

    PERFORM post_journal(p_society_id, p_fy_end, 'depreciation.run', v_run,
                         'Depreciation for FY ' || extract(year FROM p_fy_end - interval '1 year') || '-' || to_char(p_fy_end, 'YY'),
                         jsonb_build_array(
                             jsonb_build_object('code', '5800', 'amount', v_total),
                             jsonb_build_object('code', '1590', 'amount', -v_total)
                         ));

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'depreciation.posted', 'depreciation_run', v_run::text,
            jsonb_build_object('fy_end', p_fy_end, 'total', v_total, 'assets', v_count));
    RETURN jsonb_build_object('run_id', v_run, 'total', v_total, 'assets', v_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Sale or scrap: remove the asset at its book value, gain / loss to 4300
CREATE OR REPLACE FUNCTION public.dispose_asset(
    p_asset_id UUID, p_disposed_on DATE, p_sale_amount NUMERIC DEFAULT 0, p_mode TEXT DEFAULT 'bank', p_reason TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_asset fixed_assets%ROWTYPE;
    v_sale NUMERIC := round(coalesce(p_sale_amount, 0), 2);
    v_carrying NUMERIC;
    v_acc NUMERIC;
    v_gain NUMERIC;
BEGIN
    SELECT * INTO v_asset FROM fixed_assets WHERE id = p_asset_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Asset not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_asset.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can dispose of assets';
    END IF;
    IF v_asset.status <> 'active' THEN
        RAISE EXCEPTION 'Asset % is %', v_asset.asset_number, v_asset.status;
    END IF;
    IF p_disposed_on IS NULL OR p_disposed_on > current_date OR p_disposed_on < v_asset.put_to_use_date THEN
        RAISE EXCEPTION 'Disposal date must be between the purchase date and today';
    END IF;
    IF v_sale < 0 THEN
        RAISE EXCEPTION 'Sale amount cannot be negative';
    END IF;
    IF coalesce(p_mode, '') NOT IN ('bank', 'cash') THEN
        RAISE EXCEPTION 'Money received must be bank or cash';
    END IF;
    IF length(trim(coalesce(p_reason, ''))) = 0 THEN
        RAISE EXCEPTION 'Give a reason (e.g. sold as scrap)';
    END IF;

    -- The asset account holds the cost (bought here) or the opening WDV (brought in)
    v_carrying := coalesce(v_asset.opening_wdv, v_asset.cost);
    SELECT coalesce(sum(amount), 0) INTO v_acc FROM depreciation_lines WHERE asset_id = p_asset_id;
    v_gain := v_sale - (v_carrying - v_acc);

    PERFORM post_journal(v_asset.society_id, p_disposed_on, 'asset.disposed', v_asset.id,
                         'Asset ' || v_asset.asset_number || ' ' || v_asset.name || ' disposed: ' || trim(p_reason),
                         jsonb_build_array(
                             jsonb_build_object('code', CASE WHEN p_mode = 'cash' THEN '1100' ELSE '1000' END, 'amount', v_sale),
                             jsonb_build_object('code', '1590', 'amount', v_acc),
                             jsonb_build_object('code', v_asset.account_code, 'amount', -v_carrying),
                             jsonb_build_object('code', '4300', 'amount', -v_gain)
                         ));

    UPDATE fixed_assets
    SET status = 'disposed', disposed_on = p_disposed_on, disposal_amount = v_sale, updated_at = timezone('utc'::text, now())
    WHERE id = p_asset_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value, reason)
    VALUES (v_asset.society_id, auth.uid(), 'asset.disposed', 'fixed_asset', p_asset_id::text,
            jsonb_build_object('sale', v_sale, 'book_value', v_carrying - v_acc, 'gain', v_gain), trim(p_reason));
    RETURN jsonb_build_object('book_value', v_carrying - v_acc, 'gain', v_gain);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 10. PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.ensure_default_accounts(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_society_default_accounts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_expense_category(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.expense_debit_code(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ledger_post_expense_accrual(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_asset_for_expense(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_expense_approved() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ledger_post_expense(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expenses_accounting_checks() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.suggest_tds(UUID, UUID, TEXT, NUMERIC, DATE, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_vendor_payment(UUID, NUMERIC, NUMERIC, TEXT, TEXT, DATE, TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_expense_paid(UUID, DATE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_tds_challan(UUID, TEXT, NUMERIC, DATE, DATE, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.attach_expense_invoice(UUID, TEXT, TEXT, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_expense(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.add_existing_asset(UUID, TEXT, TEXT, DATE, NUMERIC, NUMERIC, DATE, NUMERIC, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_asset(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.preview_depreciation(UUID, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.post_depreciation(UUID, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dispose_asset(UUID, DATE, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.resolve_expense_category(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.suggest_tds(UUID, UUID, TEXT, NUMERIC, DATE, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_vendor_payment(UUID, NUMERIC, NUMERIC, TEXT, TEXT, DATE, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_expense_paid(UUID, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_tds_challan(UUID, TEXT, NUMERIC, DATE, DATE, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attach_expense_invoice(UUID, TEXT, TEXT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_expense(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_existing_asset(UUID, TEXT, TEXT, DATE, NUMERIC, NUMERIC, DATE, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_asset(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_depreciation(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.post_depreciation(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispose_asset(UUID, DATE, NUMERIC, TEXT, TEXT) TO authenticated;


-- ============================================================================
-- 014 CA WORKSPACE (P9)
--   1. Financial-year helpers and FY lock (after audit): manual postings into a
--      locked year are refused; system events are moved to the first open day
--   2. Last year's audited figures (comparatives for year 1 on Sahvaas)
--   3. Comparative I&E and Balance Sheet, Receipts & Payments, account ledger,
--      payables ageing, TDS register, GST summary
--   4. CA adjustment proposals -> committee approval -> journal
--      (plain journals, or "capitalise this expense" which also creates the asset)
-- ============================================================================

-- ============================================================================
-- 1. FINANCIAL YEAR HELPERS + LOCK
-- ============================================================================
-- 31 March that ends the Indian financial year containing p_date
CREATE OR REPLACE FUNCTION public.fy_end_of(p_date DATE)
RETURNS DATE AS $$
    SELECT make_date(extract(year FROM p_date)::int + CASE WHEN extract(month FROM p_date) >= 4 THEN 1 ELSE 0 END, 3, 31)
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.fy_start_of(p_date DATE)
RETURNS DATE AS $$
    SELECT (fy_end_of(p_date) - interval '1 year' + interval '1 day')::date
$$ LANGUAGE sql IMMUTABLE;

CREATE TABLE IF NOT EXISTS financial_year_locks (
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    fy_end DATE NOT NULL CHECK (extract(month FROM fy_end) = 3 AND extract(day FROM fy_end) = 31),
    locked_by UUID REFERENCES profiles(id),
    locked_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    note TEXT,
    PRIMARY KEY (society_id, fy_end)
);
ALTER TABLE financial_year_locks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS financial_year_locks_select ON financial_year_locks;
CREATE POLICY financial_year_locks_select ON financial_year_locks
    FOR SELECT USING (can_view_financials(society_id) OR has_professional_permission(society_id, 'view_expenses'));

CREATE OR REPLACE FUNCTION public.books_locked_until(p_society_id UUID)
RETURNS DATE AS $$
    SELECT max(fy_end) FROM financial_year_locks WHERE society_id = p_society_id
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Manual entries (adjustments, opening balances, depreciation) cannot go into a locked year.
-- Everything else that arrives late (a receipt, a bill payment, a vendor bill dated last year)
-- is posted on the first day of the open year, with the original date kept in the narration.
CREATE OR REPLACE FUNCTION public.trg_journal_respect_lock()
RETURNS TRIGGER AS $$
DECLARE
    v_lock DATE := books_locked_until(NEW.society_id);
BEGIN
    IF v_lock IS NOT NULL AND NEW.entry_date <= v_lock THEN
        IF NEW.reference_event_type IN ('adjustment.approved', 'opening.balance', 'depreciation.run') THEN
            RAISE EXCEPTION 'The books up to % are locked after audit — date this entry on or after %',
                to_char(v_lock, 'DD Mon YYYY'), to_char(v_lock + 1, 'DD Mon YYYY');
        END IF;
        NEW.narration := NEW.narration || ' [dated ' || to_char(NEW.entry_date, 'DD-Mon-YYYY') || '; that year is locked]';
        NEW.entry_date := v_lock + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_journal_respect_lock ON journal_entries;
CREATE TRIGGER trg_journal_respect_lock BEFORE INSERT ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION public.trg_journal_respect_lock();

-- Ledger lines always carry their journal's (possibly moved) date
CREATE OR REPLACE FUNCTION public.trg_ledger_entry_date()
RETURNS TRIGGER AS $$
BEGIN
    SELECT entry_date INTO NEW.date FROM journal_entries WHERE id = NEW.journal_entry_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_ledger_entry_date ON ledger_entries;
CREATE TRIGGER trg_ledger_entry_date BEFORE INSERT ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION public.trg_ledger_entry_date();

-- ============================================================================
-- 2. LAST YEAR'S AUDITED FIGURES (comparatives)
--    Same sign as the ledger: debit positive, credit negative.
-- ============================================================================
CREATE TABLE IF NOT EXISTS prior_year_balances (
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    fy_end DATE NOT NULL CHECK (extract(month FROM fy_end) = 3 AND extract(day FROM fy_end) = 31),
    account_code VARCHAR(32) NOT NULL,
    amount NUMERIC(14,2) NOT NULL,
    entered_by UUID REFERENCES profiles(id),
    entered_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    PRIMARY KEY (society_id, fy_end, account_code)
);
ALTER TABLE prior_year_balances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prior_year_balances_select ON prior_year_balances;
CREATE POLICY prior_year_balances_select ON prior_year_balances FOR SELECT USING (can_view_financials(society_id));

-- Replaces the whole set for that year. Committee or a CA with report access may enter them.
CREATE OR REPLACE FUNCTION public.save_prior_year_balances(p_society_id UUID, p_fy_end DATE, p_lines JSONB)
RETURNS JSONB AS $$
DECLARE
    v_line JSONB;
    v_code TEXT;
    v_amount NUMERIC;
    v_count INT := 0;
    v_sum NUMERIC := 0;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id) OR has_professional_permission(p_society_id, 'view_reports')) THEN
        RAISE EXCEPTION 'Only the committee or the society''s CA can enter last year''s figures';
    END IF;
    IF p_fy_end IS NULL OR extract(month FROM p_fy_end) <> 3 OR extract(day FROM p_fy_end) <> 31 OR p_fy_end >= current_date THEN
        RAISE EXCEPTION 'Choose a financial year that has ended (31 March)';
    END IF;

    DELETE FROM prior_year_balances WHERE society_id = p_society_id AND fy_end = p_fy_end;
    FOR v_line IN SELECT * FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) LOOP
        v_code := v_line ->> 'code';
        v_amount := round(coalesce((v_line ->> 'amount')::numeric, 0), 2);
        CONTINUE WHEN v_amount = 0;
        IF NOT EXISTS (SELECT 1 FROM accounts WHERE society_id = p_society_id AND code = v_code) THEN
            RAISE EXCEPTION 'Unknown account code %', v_code;
        END IF;
        INSERT INTO prior_year_balances (society_id, fy_end, account_code, amount, entered_by)
        VALUES (p_society_id, p_fy_end, v_code, v_amount, auth.uid());
        v_count := v_count + 1;
        v_sum := v_sum + v_amount;
    END LOOP;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'reports.prior_year_saved', 'society', p_society_id::text,
            jsonb_build_object('fy_end', p_fy_end, 'lines', v_count, 'difference', v_sum));
    RETURN jsonb_build_object('lines', v_count, 'difference', v_sum);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 3. REPORTS
-- ============================================================================

-- Current period vs the whole previous financial year (audited figures if entered, else the books)
CREATE OR REPLACE FUNCTION public.income_expenditure_compare(p_society_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (type TEXT, code TEXT, name TEXT, current NUMERIC, previous NUMERIC, previous_source TEXT) AS $$
DECLARE
    v_prev_end DATE;
    v_audited BOOLEAN;
BEGIN
    IF NOT can_view_financials(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s financial reports';
    END IF;
    v_prev_end := fy_start_of(p_from) - 1;
    v_audited := EXISTS (SELECT 1 FROM prior_year_balances WHERE society_id = p_society_id AND fy_end = v_prev_end);

    RETURN QUERY
    WITH cur AS (
        SELECT l.account_id, sum(l.amount) AS amt FROM ledger_entries l
        WHERE l.society_id = p_society_id AND l.date BETWEEN p_from AND p_to GROUP BY 1
    ), prev_books AS (
        SELECT l.account_id, sum(l.amount) AS amt FROM ledger_entries l
        WHERE l.society_id = p_society_id AND l.date BETWEEN fy_start_of(v_prev_end) AND v_prev_end GROUP BY 1
    ), prev AS (
        SELECT a.id AS account_id, p.amount AS amt FROM prior_year_balances p
        JOIN accounts a ON a.society_id = p.society_id AND a.code = p.account_code
        WHERE v_audited AND p.society_id = p_society_id AND p.fy_end = v_prev_end
        UNION ALL
        SELECT account_id, amt FROM prev_books WHERE NOT v_audited
    )
    SELECT a.type::text, a.code::text, a.name::text,
           (CASE WHEN a.type = 'income' THEN -1 ELSE 1 END * coalesce(c.amt, 0))::numeric,
           (CASE WHEN a.type = 'income' THEN -1 ELSE 1 END * coalesce(pv.amt, 0))::numeric,
           CASE WHEN v_audited THEN 'audited' ELSE 'books' END
    FROM accounts a
    LEFT JOIN cur c ON c.account_id = a.id
    LEFT JOIN prev pv ON pv.account_id = a.id
    WHERE a.society_id = p_society_id AND a.type IN ('income', 'expense')
      AND (coalesce(c.amt, 0) <> 0 OR coalesce(pv.amt, 0) <> 0)
    ORDER BY a.type DESC, a.code;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Balances (debit positive) as at p_as_of and as at the previous year end
CREATE OR REPLACE FUNCTION public.balance_sheet_compare(p_society_id UUID, p_as_of DATE DEFAULT current_date)
RETURNS TABLE (type TEXT, code TEXT, name TEXT, current NUMERIC, previous NUMERIC, previous_source TEXT, previous_as_of DATE) AS $$
DECLARE
    v_prev_end DATE;
    v_audited BOOLEAN;
BEGIN
    IF NOT can_view_financials(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s financial reports';
    END IF;
    v_prev_end := fy_start_of(p_as_of) - 1;
    v_audited := EXISTS (SELECT 1 FROM prior_year_balances WHERE society_id = p_society_id AND fy_end = v_prev_end);

    RETURN QUERY
    WITH cur AS (
        SELECT l.account_id, sum(l.amount) AS amt FROM ledger_entries l
        WHERE l.society_id = p_society_id AND l.date <= p_as_of GROUP BY 1
    ), prev AS (
        SELECT a.id AS account_id, p.amount AS amt FROM prior_year_balances p
        JOIN accounts a ON a.society_id = p.society_id AND a.code = p.account_code
        WHERE v_audited AND p.society_id = p_society_id AND p.fy_end = v_prev_end
        UNION ALL
        SELECT l.account_id, sum(l.amount) FROM ledger_entries l
        WHERE NOT v_audited AND l.society_id = p_society_id AND l.date <= v_prev_end GROUP BY 1
    )
    SELECT a.type::text, a.code::text, a.name::text, coalesce(c.amt, 0)::numeric, coalesce(pv.amt, 0)::numeric,
           CASE WHEN v_audited THEN 'audited' ELSE 'books' END, v_prev_end
    FROM accounts a
    LEFT JOIN cur c ON c.account_id = a.id
    LEFT JOIN prev pv ON pv.account_id = a.id
    WHERE a.society_id = p_society_id AND (coalesce(c.amt, 0) <> 0 OR coalesce(pv.amt, 0) <> 0)
    ORDER BY a.code;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Cash-basis summary: bank + cash movements, each journal's counter-accounts sharing it pro rata
CREATE OR REPLACE FUNCTION public.receipts_payments(p_society_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (section TEXT, code TEXT, name TEXT, amount NUMERIC) AS $$
BEGIN
    IF NOT can_view_financials(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s financial reports';
    END IF;
    RETURN QUERY
    WITH cash AS (
        SELECT ac.id FROM accounts ac WHERE ac.society_id = p_society_id AND ac.code IN ('1000', '1100')
    ), lines AS (
        SELECT l.journal_entry_id AS jid, l.account_id, l.amount AS amt, l.account_id IN (SELECT c.id FROM cash c) AS is_cash
        FROM ledger_entries l
        WHERE l.society_id = p_society_id AND l.date BETWEEN p_from AND p_to
    ), per AS (
        SELECT ln.jid,
               coalesce(sum(ln.amt) FILTER (WHERE ln.is_cash), 0) AS cash_net,
               coalesce(-sum(ln.amt) FILTER (WHERE NOT ln.is_cash AND ln.amt < 0), 0) AS credits,
               coalesce(sum(ln.amt) FILTER (WHERE NOT ln.is_cash AND ln.amt > 0), 0) AS debits
        FROM lines ln GROUP BY ln.jid
    ), alloc AS (
        SELECT 'receipt'::text AS sec, ln.account_id, -ln.amt * p.cash_net / p.credits AS share
        FROM lines ln JOIN per p ON p.jid = ln.jid
        WHERE NOT ln.is_cash AND ln.amt < 0 AND p.cash_net > 0 AND p.credits > 0
        UNION ALL
        SELECT 'payment', ln.account_id, ln.amt * -p.cash_net / p.debits
        FROM lines ln JOIN per p ON p.jid = ln.jid
        WHERE NOT ln.is_cash AND ln.amt > 0 AND p.cash_net < 0 AND p.debits > 0
    ), opening AS (
        SELECT coalesce(sum(l.amount), 0) AS bal FROM ledger_entries l
        WHERE l.society_id = p_society_id AND l.date < p_from AND l.account_id IN (SELECT c.id FROM cash c)
    ), closing AS (
        SELECT coalesce(sum(l.amount), 0) AS bal FROM ledger_entries l
        WHERE l.society_id = p_society_id AND l.date <= p_to AND l.account_id IN (SELECT c.id FROM cash c)
    ), result AS (
        SELECT 'opening'::text AS sec, NULL::text AS acode, 'Opening bank & cash'::text AS aname, (SELECT o.bal FROM opening o) AS val, 0 AS ord
        UNION ALL
        SELECT x.sec, a.code::text, a.name::text, round(sum(x.share), 2), CASE x.sec WHEN 'receipt' THEN 1 ELSE 2 END
        FROM alloc x JOIN accounts a ON a.id = x.account_id
        GROUP BY x.sec, a.code, a.name
        UNION ALL
        SELECT 'closing', NULL, 'Closing bank & cash', (SELECT cl.bal FROM closing cl), 3
    )
    SELECT r.sec, r.acode, r.aname, r.val FROM result r ORDER BY r.ord, r.acode;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- One account's entries with a running balance (debit positive); first row is the opening balance
CREATE OR REPLACE FUNCTION public.account_ledger(p_society_id UUID, p_code TEXT, p_from DATE, p_to DATE)
RETURNS TABLE (entry_date DATE, entry_number TEXT, narration TEXT, debit NUMERIC, credit NUMERIC, balance NUMERIC) AS $$
DECLARE
    v_account UUID;
    v_opening NUMERIC;
BEGIN
    IF NOT can_view_financials(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s financial reports';
    END IF;
    SELECT id INTO v_account FROM accounts WHERE society_id = p_society_id AND code = p_code;
    IF v_account IS NULL THEN
        RAISE EXCEPTION 'Unknown account %', p_code;
    END IF;
    SELECT coalesce(sum(amount), 0) INTO v_opening FROM ledger_entries WHERE account_id = v_account AND date < p_from;

    RETURN QUERY
    SELECT p_from, NULL::text, 'Opening balance'::text, NULL::numeric, NULL::numeric, v_opening
    UNION ALL
    SELECT x.date, x.entry_number, x.narration, x.debit, x.credit, x.balance FROM (
        SELECT l.date, j.entry_number::text AS entry_number, l.narration::text AS narration,
               greatest(l.amount, 0) AS debit, greatest(-l.amount, 0) AS credit,
               v_opening + sum(l.amount) OVER (ORDER BY l.date, j.entry_number, l.id) AS balance
        FROM ledger_entries l JOIN journal_entries j ON j.id = l.journal_entry_id
        WHERE l.account_id = v_account AND l.date BETWEEN p_from AND p_to
    ) x
    ORDER BY 1, 2 NULLS FIRST;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.can_view_expenses(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT is_platform_admin() OR is_committee_viewer(p_society_id) OR has_professional_permission(p_society_id, 'view_expenses')
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.payables_ageing(p_society_id UUID, p_as_of DATE DEFAULT current_date)
RETURNS TABLE (expense_id UUID, expense_number TEXT, payee TEXT, title TEXT, bill_date DATE, outstanding NUMERIC, days INT, bucket TEXT) AS $$
BEGIN
    IF NOT can_view_expenses(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s expenses';
    END IF;
    RETURN QUERY
    SELECT e.id, coalesce(e.voucher_number, e.expense_number)::text, coalesce(v.name, e.payee_name, '—')::text, e.title::text,
           coalesce(e.invoice_date, e.approved_at::date, e.created_at::date) AS d,
           (e.subtotal + e.gst_amount - e.amount_settled)::numeric,
           (p_as_of - coalesce(e.invoice_date, e.approved_at::date, e.created_at::date))::int,
           CASE
               WHEN p_as_of - coalesce(e.invoice_date, e.approved_at::date, e.created_at::date) <= 30 THEN '0-30'
               WHEN p_as_of - coalesce(e.invoice_date, e.approved_at::date, e.created_at::date) <= 60 THEN '31-60'
               WHEN p_as_of - coalesce(e.invoice_date, e.approved_at::date, e.created_at::date) <= 90 THEN '61-90'
               ELSE '90+'
           END
    FROM expenses e LEFT JOIN vendors v ON v.id = e.vendor_id
    WHERE e.society_id = p_society_id AND e.status = 'approved' AND e.subtotal + e.gst_amount - e.amount_settled > 0
    ORDER BY d;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- TDS deducted per payment (plus older bills paid in one go before vendor payments existed)
CREATE OR REPLACE FUNCTION public.tds_register(p_society_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (paid_on DATE, reference TEXT, expense_number TEXT, vendor TEXT, pan TEXT, entity TEXT,
               section TEXT, rate NUMERIC, taxable NUMERIC, amount_paid NUMERIC, tds NUMERIC) AS $$
BEGIN
    IF NOT (can_view_expenses(p_society_id) OR can_view_financials(p_society_id)) THEN
        RAISE EXCEPTION 'You do not have access to this society''s expenses';
    END IF;
    RETURN QUERY
    SELECT vp.paid_on, vp.payment_number::text, e.expense_number::text, coalesce(v.name, e.payee_name)::text,
           vendor_pan(v.pan, v.gstin), pan_entity(vendor_pan(v.pan, v.gstin)), e.tds_section::text, e.tds_rate,
           e.subtotal, vp.amount, vp.tds_amount
    FROM vendor_payments vp JOIN expenses e ON e.id = vp.expense_id LEFT JOIN vendors v ON v.id = e.vendor_id
    WHERE vp.society_id = p_society_id AND vp.status = 'recorded' AND vp.tds_amount > 0 AND vp.paid_on BETWEEN p_from AND p_to
    UNION ALL
    SELECT e.paid_date, coalesce(e.payment_reference, '—')::text, e.expense_number::text, coalesce(v.name, e.payee_name)::text,
           vendor_pan(v.pan, v.gstin), pan_entity(vendor_pan(v.pan, v.gstin)), e.tds_section::text, e.tds_rate,
           e.subtotal, e.net_payable, e.tds_amount
    FROM expenses e LEFT JOIN vendors v ON v.id = e.vendor_id
    WHERE e.society_id = p_society_id AND e.status = 'paid' AND e.tds_amount > 0 AND e.paid_date BETWEEN p_from AND p_to
      AND NOT EXISTS (SELECT 1 FROM vendor_payments vp WHERE vp.expense_id = e.id)
    ORDER BY 1, 2;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.gst_summary(p_society_id UUID, p_from DATE, p_to DATE)
RETURNS JSONB AS $$
DECLARE
    v_output NUMERIC;
    v_input NUMERIC;
    v_blocked NUMERIC;
BEGIN
    IF NOT can_view_financials(p_society_id) THEN
        RAISE EXCEPTION 'You do not have access to this society''s financial reports';
    END IF;
    SELECT -coalesce(sum(l.amount), 0) INTO v_output
    FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
    WHERE l.society_id = p_society_id AND a.code = '2100' AND l.date BETWEEN p_from AND p_to;
    SELECT coalesce(sum(l.amount), 0) INTO v_input
    FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
    WHERE l.society_id = p_society_id AND a.code = '1300' AND l.date BETWEEN p_from AND p_to;
    SELECT coalesce(sum(gst_amount), 0) INTO v_blocked FROM expenses
    WHERE society_id = p_society_id AND status IN ('approved', 'paid') AND NOT gst_claimable AND gst_amount > 0
      AND coalesce(invoice_date, approved_at::date) BETWEEN p_from AND p_to;
    RETURN jsonb_build_object('output_gst', v_output, 'input_claimed', v_input, 'input_not_claimed', v_blocked,
                              'net_payable', v_output - v_input);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 4. CA ADJUSTMENT PROPOSALS
-- ============================================================================
CREATE TABLE IF NOT EXISTS adjustment_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    proposal_number VARCHAR(32) NOT NULL,
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('journal', 'capitalise')),
    entry_date DATE NOT NULL,
    reason TEXT NOT NULL CHECK (length(trim(reason)) >= 5),
    lines JSONB NOT NULL,                       -- [{code, amount}] debit positive
    expense_id UUID REFERENCES expenses(id),    -- capitalise: the bill to move into assets
    asset_account_code VARCHAR(32),
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    proposed_by UUID NOT NULL REFERENCES profiles(id),
    proposed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    decided_by UUID REFERENCES profiles(id),
    decided_at TIMESTAMPTZ,
    decision_note TEXT,
    journal_id UUID REFERENCES journal_entries(id),
    CONSTRAINT uq_society_proposal_number UNIQUE (society_id, proposal_number)
);
CREATE INDEX IF NOT EXISTS idx_adjustment_proposals_society ON adjustment_proposals (society_id, status);

ALTER TABLE adjustment_proposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS adjustment_proposals_select ON adjustment_proposals;
CREATE POLICY adjustment_proposals_select ON adjustment_proposals FOR SELECT USING (can_view_financials(society_id));

CREATE OR REPLACE FUNCTION public.can_propose_adjustment(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT is_society_admin(p_society_id)
        OR has_professional_permission(p_society_id, 'view_ledger')
        OR has_professional_permission(p_society_id, 'view_reports')
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Accounts tied to a sub-ledger (members, vendors, advances, asset register) change only
-- through their own workflows, so plain adjustments cannot touch them.
CREATE OR REPLACE FUNCTION public.adjustment_blocked_code(p_code TEXT)
RETURNS BOOLEAN AS $$
    SELECT p_code IN ('1200', '2000', '2300', '1500', '1510', '1520', '1530', '1540', '1550', '1590')
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.validate_adjustment_lines(p_society_id UUID, p_lines JSONB)
RETURNS JSONB AS $$
DECLARE
    v_line JSONB;
    v_out JSONB := '[]'::jsonb;
    v_amount NUMERIC;
    v_code TEXT;
    v_sum NUMERIC := 0;
BEGIN
    IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 2 OR jsonb_array_length(p_lines) > 20 THEN
        RAISE EXCEPTION 'An adjustment needs 2 to 20 lines';
    END IF;
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        v_code := v_line ->> 'code';
        v_amount := round(coalesce((v_line ->> 'amount')::numeric, 0), 2);
        IF v_amount = 0 THEN
            RAISE EXCEPTION 'Every line needs a debit or credit amount';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM accounts WHERE society_id = p_society_id AND code = v_code) THEN
            RAISE EXCEPTION 'Unknown account %', v_code;
        END IF;
        IF adjustment_blocked_code(v_code) THEN
            RAISE EXCEPTION 'Account % is kept by its own register (members, vendors, advances or assets) — adjust it there', v_code;
        END IF;
        v_out := v_out || jsonb_build_object('code', v_code, 'amount', v_amount);
        v_sum := v_sum + v_amount;
    END LOOP;
    IF v_sum <> 0 THEN
        RAISE EXCEPTION 'Debits and credits must be equal (difference ₹%)', v_sum;
    END IF;
    RETURN v_out;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.check_adjustment_date(p_society_id UUID, p_date DATE)
RETURNS VOID AS $$
DECLARE
    v_lock DATE := books_locked_until(p_society_id);
BEGIN
    IF p_date IS NULL OR p_date > current_date THEN
        RAISE EXCEPTION 'Adjustment date must be today or earlier';
    END IF;
    IF v_lock IS NOT NULL AND p_date <= v_lock THEN
        RAISE EXCEPTION 'The books up to % are locked after audit', to_char(v_lock, 'DD Mon YYYY');
    END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.propose_adjustment(p_society_id UUID, p_entry_date DATE, p_reason TEXT, p_lines JSONB)
RETURNS JSONB AS $$
DECLARE
    v_lines JSONB;
    v_id UUID;
    v_number TEXT;
BEGIN
    IF NOT can_propose_adjustment(p_society_id) THEN
        RAISE EXCEPTION 'Only the committee or the society''s CA can propose adjustments';
    END IF;
    IF length(trim(coalesce(p_reason, ''))) < 5 THEN
        RAISE EXCEPTION 'Explain the adjustment (at least a few words)';
    END IF;
    PERFORM check_adjustment_date(p_society_id, p_entry_date);
    v_lines := validate_adjustment_lines(p_society_id, p_lines);

    v_number := 'AP-' || lpad(next_society_number(p_society_id, 'adjustment_proposals', 'proposal_number', 'AP-')::text, 4, '0');
    INSERT INTO adjustment_proposals (society_id, proposal_number, kind, entry_date, reason, lines, proposed_by)
    VALUES (p_society_id, v_number, 'journal', p_entry_date, trim(p_reason), v_lines, auth.uid())
    RETURNING id INTO v_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'adjustment.proposed', 'adjustment_proposal', v_id::text,
            jsonb_build_object('number', v_number, 'lines', v_lines, 'reason', trim(p_reason)));
    RETURN jsonb_build_object('id', v_id, 'proposal_number', v_number);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- "This repair should have been an asset": Dr asset / Cr the head it was booked to, and on
-- approval the bill becomes a capital purchase in the asset register.
CREATE OR REPLACE FUNCTION public.propose_capitalisation(p_expense_id UUID, p_asset_account_code TEXT, p_reason TEXT, p_entry_date DATE DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_exp expenses%ROWTYPE;
    v_amount NUMERIC;
    v_head TEXT;
    v_date DATE;
    v_id UUID;
    v_number TEXT;
    v_lines JSONB;
BEGIN
    SELECT * INTO v_exp FROM expenses WHERE id = p_expense_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;
    IF NOT can_propose_adjustment(v_exp.society_id) THEN
        RAISE EXCEPTION 'Only the committee or the society''s CA can propose adjustments';
    END IF;
    IF v_exp.status NOT IN ('approved', 'paid') OR v_exp.expense_type <> 'revenue' THEN
        RAISE EXCEPTION 'Only an approved or paid regular expense can be moved to assets';
    END IF;
    IF p_asset_account_code NOT IN ('1500', '1510', '1520', '1530', '1540', '1550') THEN
        RAISE EXCEPTION 'Pick an asset type';
    END IF;
    IF length(trim(coalesce(p_reason, ''))) < 5 THEN
        RAISE EXCEPTION 'Explain the adjustment (at least a few words)';
    END IF;
    IF EXISTS (SELECT 1 FROM adjustment_proposals WHERE expense_id = p_expense_id AND status = 'pending') THEN
        RAISE EXCEPTION 'There is already a pending proposal for this expense';
    END IF;

    v_date := coalesce(p_entry_date, current_date);
    PERFORM check_adjustment_date(v_exp.society_id, v_date);
    v_amount := v_exp.subtotal + v_exp.gst_amount - CASE WHEN v_exp.gst_claimable THEN v_exp.gst_amount ELSE 0 END;
    v_head := expense_debit_code(v_exp.society_id, v_exp.category, 'revenue', NULL);
    v_lines := jsonb_build_array(
        jsonb_build_object('code', p_asset_account_code, 'amount', v_amount),
        jsonb_build_object('code', v_head, 'amount', -v_amount)
    );

    v_number := 'AP-' || lpad(next_society_number(v_exp.society_id, 'adjustment_proposals', 'proposal_number', 'AP-')::text, 4, '0');
    INSERT INTO adjustment_proposals (society_id, proposal_number, kind, entry_date, reason, lines, expense_id, asset_account_code, proposed_by)
    VALUES (v_exp.society_id, v_number, 'capitalise', v_date, trim(p_reason), v_lines, v_exp.id, p_asset_account_code, auth.uid())
    RETURNING id INTO v_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_exp.society_id, auth.uid(), 'adjustment.proposed', 'adjustment_proposal', v_id::text,
            jsonb_build_object('number', v_number, 'capitalise', v_exp.expense_number, 'amount', v_amount));
    RETURN jsonb_build_object('id', v_id, 'proposal_number', v_number, 'amount', v_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.decide_adjustment(p_proposal_id UUID, p_approve BOOLEAN, p_note TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_p adjustment_proposals%ROWTYPE;
    v_exp expenses%ROWTYPE;
    v_journal UUID;
    v_who TEXT;
BEGIN
    SELECT * INTO v_p FROM adjustment_proposals WHERE id = p_proposal_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Proposal not found';
    END IF;
    IF NOT (is_platform_admin() OR is_society_admin(v_p.society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can approve adjustments';
    END IF;
    IF v_p.status <> 'pending' THEN
        RAISE EXCEPTION 'This proposal is already %', v_p.status;
    END IF;
    IF v_p.proposed_by = auth.uid() THEN
        RAISE EXCEPTION 'You proposed this adjustment; another committee member must decide';
    END IF;
    IF NOT p_approve AND length(trim(coalesce(p_note, ''))) = 0 THEN
        RAISE EXCEPTION 'Give a reason for rejecting';
    END IF;

    IF p_approve THEN
        IF v_p.kind = 'capitalise' THEN
            SELECT * INTO v_exp FROM expenses WHERE id = v_p.expense_id FOR UPDATE;
            IF v_exp.status NOT IN ('approved', 'paid') OR v_exp.expense_type <> 'revenue' THEN
                RAISE EXCEPTION 'The expense has changed since this proposal (now %) — ask for a new proposal', v_exp.status;
            END IF;
        END IF;
        SELECT full_name INTO v_who FROM profiles WHERE id = v_p.proposed_by;
        v_journal := post_journal(v_p.society_id, v_p.entry_date, 'adjustment.approved', v_p.id,
                                  v_p.proposal_number || ' (' || coalesce(v_who, 'CA') || '): ' || v_p.reason, v_p.lines);
        IF v_p.kind = 'capitalise' THEN
            PERFORM set_config('sahvaas.expense_workflow', 'on', true);
            UPDATE expenses SET expense_type = 'capital', asset_account_code = v_p.asset_account_code,
                                updated_at = timezone('utc'::text, now())
            WHERE id = v_exp.id;
            PERFORM set_config('sahvaas.expense_workflow', 'off', true);
            PERFORM create_asset_for_expense(v_exp.id);
        END IF;
    END IF;

    UPDATE adjustment_proposals
    SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
        decided_by = auth.uid(), decided_at = timezone('utc'::text, now()),
        decision_note = nullif(trim(coalesce(p_note, '')), ''), journal_id = v_journal
    WHERE id = p_proposal_id;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value, reason)
    VALUES (v_p.society_id, auth.uid(), CASE WHEN p_approve THEN 'adjustment.approved' ELSE 'adjustment.rejected' END,
            'adjustment_proposal', p_proposal_id::text, jsonb_build_object('number', v_p.proposal_number, 'journal', v_journal),
            nullif(trim(coalesce(p_note, '')), ''));
    RETURN jsonb_build_object('status', CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, 'journal_id', v_journal);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.withdraw_adjustment(p_proposal_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_p adjustment_proposals%ROWTYPE;
BEGIN
    SELECT * INTO v_p FROM adjustment_proposals WHERE id = p_proposal_id FOR UPDATE;
    IF NOT FOUND OR v_p.proposed_by <> auth.uid() THEN
        RAISE EXCEPTION 'Proposal not found';
    END IF;
    IF v_p.status <> 'pending' THEN
        RAISE EXCEPTION 'This proposal is already %', v_p.status;
    END IF;
    UPDATE adjustment_proposals SET status = 'withdrawn', decided_at = timezone('utc'::text, now()) WHERE id = p_proposal_id;
    RETURN jsonb_build_object('status', 'withdrawn');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.lock_financial_year(p_society_id UUID, p_fy_end DATE, p_note TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_pending INT;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can lock a financial year';
    END IF;
    IF p_fy_end IS NULL OR extract(month FROM p_fy_end) <> 3 OR extract(day FROM p_fy_end) <> 31 OR p_fy_end >= current_date THEN
        RAISE EXCEPTION 'Only a financial year that has ended (31 March) can be locked';
    END IF;
    IF EXISTS (SELECT 1 FROM financial_year_locks WHERE society_id = p_society_id AND fy_end >= p_fy_end) THEN
        RAISE EXCEPTION 'This year is already locked';
    END IF;
    SELECT count(*) INTO v_pending FROM adjustment_proposals
    WHERE society_id = p_society_id AND status = 'pending' AND entry_date <= p_fy_end;
    IF v_pending > 0 THEN
        RAISE EXCEPTION 'Decide the % pending adjustment(s) for this year first', v_pending;
    END IF;

    INSERT INTO financial_year_locks (society_id, fy_end, locked_by, note)
    VALUES (p_society_id, p_fy_end, auth.uid(), nullif(trim(coalesce(p_note, '')), ''));
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'books.year_locked', 'society', p_society_id::text,
            jsonb_build_object('fy_end', p_fy_end, 'note', p_note));
    RETURN jsonb_build_object('locked_until', p_fy_end);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Unlocking an audited year is a support action for the platform owner only
CREATE OR REPLACE FUNCTION public.unlock_financial_year(p_society_id UUID, p_fy_end DATE, p_reason TEXT)
RETURNS JSONB AS $$
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Only Sahvaas support can unlock an audited year';
    END IF;
    IF length(trim(coalesce(p_reason, ''))) = 0 THEN
        RAISE EXCEPTION 'A reason is required';
    END IF;
    DELETE FROM financial_year_locks WHERE society_id = p_society_id AND fy_end >= p_fy_end;
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value, reason)
    VALUES (p_society_id, auth.uid(), 'books.year_unlocked', 'society', p_society_id::text,
            jsonb_build_object('fy_end', p_fy_end), trim(p_reason));
    RETURN jsonb_build_object('unlocked_from', p_fy_end);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.books_locked_until(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.trg_journal_respect_lock() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_ledger_entry_date() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_adjustment_lines(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_adjustment_date(UUID, DATE) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.save_prior_year_balances(UUID, DATE, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.income_expenditure_compare(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.balance_sheet_compare(UUID, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.receipts_payments(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.account_ledger(UUID, TEXT, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_view_expenses(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.payables_ageing(UUID, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tds_register(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gst_summary(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_propose_adjustment(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.propose_adjustment(UUID, DATE, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.propose_capitalisation(UUID, TEXT, TEXT, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decide_adjustment(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.withdraw_adjustment(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lock_financial_year(UUID, DATE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unlock_financial_year(UUID, DATE, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.books_locked_until(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_prior_year_balances(UUID, DATE, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.income_expenditure_compare(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.balance_sheet_compare(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receipts_payments(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.account_ledger(UUID, TEXT, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_view_expenses(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payables_ageing(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tds_register(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gst_summary(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_propose_adjustment(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.propose_adjustment(UUID, DATE, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.propose_capitalisation(UUID, TEXT, TEXT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_adjustment(UUID, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_adjustment(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lock_financial_year(UUID, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_financial_year(UUID, DATE, TEXT) TO authenticated;


-- ============================================================================
-- 015 SAAS BILLING (P11)
--   1. Plans Free / Basic / Pro with feature keys; billing settings; gateway secret
--   2. Every society starts on a 30-day trial (all features)
--   3. Per-society price override (custom rate, % discount, free months, excluded flats)
--   4. Quotes and GST invoices (SV-YYYY-NNNN, Indian financial-year series)
--   5. choose_plan: new / upgrade (prorated) / scheduled downgrade
--   6. Payments: platform NEFT mark-paid, gateway (Razorpay) via a shared secret;
--      on payment the plan starts and a draft bill lands in the society's books
--   7. Daily lifecycle: trial end -> Free, renewal invoices, grace, downgrade to Free
--   8. Entitlements: society_has_feature(); CA portal, asset register, GSTR-2B and
--      TDS register follow the plan (data is never deleted)
-- ============================================================================

-- ============================================================================
-- 1. PLANS, SETTINGS, SECRETS
-- ============================================================================
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS feature_keys TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS show_ads BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS storage_mb INT NOT NULL DEFAULT 500;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 100;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE subscription_plans DROP CONSTRAINT IF EXISTS chk_plan_feature_keys;
ALTER TABLE subscription_plans ADD CONSTRAINT chk_plan_feature_keys CHECK (
    feature_keys <@ ARRAY['ca_portal', 'asset_register', 'gst_recon', 'tds_register', 'bank_match', 'tally_export']::text[]
);

UPDATE subscription_plans SET is_active = false WHERE tier_code IN ('starter', 'growth', 'enterprise');
INSERT INTO subscription_plans (name, tier_code, monthly_rate_per_unit_inr, max_units, features_included, feature_keys, show_ads, storage_mb, sort_order, description) VALUES
    ('Free', 'free', 0, 100000,
     '["Billing & UPI collection", "Receipts", "Notices & tickets", "Double-entry books"]'::jsonb,
     '{}', true, 500, 10, 'Everything to run the society. Residents see a few local offers.'),
    ('Basic', 'basic', 10, 100000,
     '["Everything in Free", "No ads", "CA & auditor portal", "Asset register & depreciation"]'::jsonb,
     '{ca_portal,asset_register}', false, 5120, 20, 'For societies that work with a CA.'),
    ('Pro', 'pro', 18, 100000,
     '["Everything in Basic", "GSTR-2B reconciliation", "TDS register", "Bank statement match", "Tally export"]'::jsonb,
     '{ca_portal,asset_register,gst_recon,tds_register,bank_match,tally_export}', false, 25600, 30, 'For GST-registered and larger societies.')
ON CONFLICT (tier_code) DO NOTHING;

INSERT INTO platform_settings (key, value, description) VALUES
    ('billing', jsonb_build_object(
        'annual_months', 10, 'min_billable_flats', 20, 'trial_days', 30, 'due_days', 15, 'downgrade_days', 30,
        'renew_days_before', 15, 'gst_rate', 18, 'sac', '9983',
        'seller_name', 'Sahvaas', 'seller_gstin', '', 'seller_address', '', 'seller_state', 'Maharashtra', 'seller_phone', '0000000000',
        'bank_name', '', 'bank_account', '', 'bank_ifsc', '', 'bank_upi', ''
     ), 'SaaS pricing rules, GST and payment details shown on invoices')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.billing_setting(p_key TEXT)
RETURNS TEXT AS $$
    SELECT value ->> p_key FROM platform_settings WHERE key = 'billing'
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Hashes only; no policies, so nothing outside SECURITY DEFINER functions can read it
CREATE TABLE IF NOT EXISTS platform_secrets (
    key VARCHAR(64) PRIMARY KEY,
    value_sha256 TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
ALTER TABLE platform_secrets ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.sha256_hex(p_text TEXT)
RETURNS TEXT AS $$
    SELECT encode(sha256(convert_to(p_text, 'UTF8')), 'hex')
$$ LANGUAGE sql IMMUTABLE;

-- The same random value goes into Vercel as SAHVAAS_GATEWAY_SECRET
CREATE OR REPLACE FUNCTION public.platform_set_gateway_secret(p_secret TEXT)
RETURNS VOID AS $$
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;
    IF length(coalesce(p_secret, '')) < 32 THEN
        RAISE EXCEPTION 'Use a random secret of at least 32 characters';
    END IF;
    INSERT INTO platform_secrets (key, value_sha256) VALUES ('gateway', sha256_hex(p_secret))
    ON CONFLICT (key) DO UPDATE SET value_sha256 = EXCLUDED.value_sha256, updated_at = timezone('utc'::text, now());
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id)
    VALUES (NULL, auth.uid(), 'platform.gateway_secret_set', 'platform', 'gateway');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 2. SUBSCRIPTIONS: TRIAL FOR EVERY SOCIETY
-- ============================================================================
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS next_plan_id UUID REFERENCES subscription_plans(id);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_ends_on DATE;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now());
ALTER TABLE subscriptions ALTER COLUMN current_period_end DROP NOT NULL; -- Free has no end

CREATE OR REPLACE FUNCTION public.plan_id_of(p_code TEXT)
RETURNS UUID AS $$
    SELECT id FROM subscription_plans WHERE tier_code = p_code
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.start_trial(p_society_id UUID)
RETURNS VOID AS $$
DECLARE
    v_days INT := coalesce(billing_setting('trial_days')::int, 30);
BEGIN
    INSERT INTO subscriptions (society_id, plan_id, billing_term, status, current_period_start, current_period_end, trial_ends_on, unit_count)
    VALUES (p_society_id, plan_id_of('pro'), 'annual', 'trial', current_date, current_date + v_days - 1, current_date + v_days - 1, 0)
    ON CONFLICT (society_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.trg_society_start_trial()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM start_trial(NEW.id);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_society_start_trial ON societies;
CREATE TRIGGER trg_society_start_trial AFTER INSERT ON societies
    FOR EACH ROW EXECUTE FUNCTION public.trg_society_start_trial();

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT s.id FROM societies s WHERE NOT EXISTS (SELECT 1 FROM subscriptions x WHERE x.society_id = s.id) LOOP
        PERFORM start_trial(r.id);
    END LOOP;
END
$$;

-- ============================================================================
-- 3. PRICE OVERRIDES (platform admin)
-- ============================================================================
CREATE TABLE IF NOT EXISTS society_pricing_overrides (
    society_id UUID PRIMARY KEY REFERENCES societies(id) ON DELETE CASCADE,
    custom_rate NUMERIC(8,2) CHECK (custom_rate >= 0),
    discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
    free_months INT NOT NULL DEFAULT 0 CHECK (free_months BETWEEN 0 AND 24),
    excluded_units INT NOT NULL DEFAULT 0 CHECK (excluded_units >= 0),
    valid_till DATE,
    reason TEXT NOT NULL CHECK (length(trim(reason)) >= 3),
    updated_by UUID REFERENCES profiles(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
ALTER TABLE society_pricing_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS society_pricing_overrides_admin ON society_pricing_overrides;
CREATE POLICY society_pricing_overrides_admin ON society_pricing_overrides
    FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());

-- ============================================================================
-- 4. QUOTES AND INVOICES
-- ============================================================================
-- Price for one billing period (or p_months of it, for prorated upgrades)
CREATE OR REPLACE FUNCTION public.subscription_quote(p_society_id UUID, p_plan_code TEXT, p_term TEXT, p_months NUMERIC DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_plan subscription_plans%ROWTYPE;
    v_ovr society_pricing_overrides%ROWTYPE;
    v_units INT;
    v_billable INT;
    v_rate NUMERIC;
    v_annual NUMERIC := coalesce(billing_setting('annual_months')::numeric, 10);
    v_min INT := coalesce(billing_setting('min_billable_flats')::int, 20);
    v_gst_rate NUMERIC := coalesce(billing_setting('gst_rate')::numeric, 18);
    v_months NUMERIC;
    v_gross NUMERIC;
    v_discount NUMERIC;
    v_taxable NUMERIC;
    v_gst NUMERIC;
BEGIN
    IF NOT (is_platform_admin() OR is_committee_viewer(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can see Sahvaas pricing';
    END IF;
    IF p_term NOT IN ('monthly', 'annual') THEN
        RAISE EXCEPTION 'Billing must be monthly or annual';
    END IF;
    SELECT * INTO v_plan FROM subscription_plans WHERE tier_code = p_plan_code AND is_active;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown plan %', p_plan_code;
    END IF;
    SELECT * INTO v_ovr FROM society_pricing_overrides
    WHERE society_id = p_society_id AND (valid_till IS NULL OR valid_till >= current_date);

    SELECT count(*) INTO v_units FROM units WHERE society_id = p_society_id;
    v_units := greatest(v_units - coalesce(v_ovr.excluded_units, 0), 0);
    v_rate := CASE WHEN v_plan.monthly_rate_per_unit_inr = 0 THEN 0 ELSE coalesce(v_ovr.custom_rate, v_plan.monthly_rate_per_unit_inr) END;
    v_billable := CASE WHEN v_rate = 0 THEN v_units ELSE greatest(v_units, v_min) END;
    -- Annual billing charges `annual_months` (e.g. 10) for 12 months of use
    v_months := coalesce(p_months, 1) * CASE WHEN p_term = 'annual' THEN v_annual / CASE WHEN p_months IS NULL THEN 1 ELSE 12 END ELSE 1 END;
    v_gross := round(v_billable * v_rate * v_months, 2);
    v_discount := round(v_gross * coalesce(v_ovr.discount_percent, 0) / 100, 2);
    v_taxable := v_gross - v_discount;
    v_gst := round(v_taxable * v_gst_rate / 100, 2);

    RETURN jsonb_build_object(
        'plan_code', v_plan.tier_code, 'plan_name', v_plan.name, 'term', p_term,
        'units', v_units, 'billable_units', v_billable, 'min_billable', v_min, 'rate', v_rate,
        'months_charged', v_months, 'period_months', CASE WHEN p_term = 'annual' THEN 12 ELSE 1 END,
        'gross', v_gross, 'discount', v_discount, 'discount_percent', coalesce(v_ovr.discount_percent, 0),
        'taxable', v_taxable, 'gst_rate', v_gst_rate, 'gst', v_gst, 'total', v_taxable + v_gst,
        'monthly_equivalent', round(v_taxable / CASE WHEN p_months IS NOT NULL THEN greatest(p_months, 1)
                                                      WHEN p_term = 'annual' THEN 12 ELSE 1 END, 2),
        'savings_vs_monthly', CASE WHEN p_term = 'annual' AND p_months IS NULL THEN round(v_billable * v_rate * (12 - v_annual), 2) ELSE 0 END,
        'free_months', coalesce(v_ovr.free_months, 0)
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE TABLE IF NOT EXISTS platform_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number VARCHAR(32) NOT NULL UNIQUE,
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES subscription_plans(id),
    plan_code VARCHAR(32) NOT NULL,
    billing_term VARCHAR(16) NOT NULL CHECK (billing_term IN ('monthly', 'annual')),
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('new', 'renewal', 'upgrade')),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    billable_units INT NOT NULL,
    rate NUMERIC(8,2) NOT NULL,
    months_charged NUMERIC(6,2) NOT NULL,
    gross NUMERIC(12,2) NOT NULL,
    discount NUMERIC(12,2) NOT NULL DEFAULT 0,
    taxable NUMERIC(12,2) NOT NULL,
    gst_rate NUMERIC(5,2) NOT NULL,
    gst_amount NUMERIC(12,2) NOT NULL,
    total NUMERIC(12,2) NOT NULL,
    seller JSONB NOT NULL,     -- name, GSTIN, address, SAC at issue time
    bill_to JSONB NOT NULL,    -- society name, address, GSTIN at issue time
    status VARCHAR(16) NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'paid', 'void')),
    issued_on DATE NOT NULL DEFAULT current_date,
    due_on DATE NOT NULL,
    paid_on DATE,
    payment_method VARCHAR(16) CHECK (payment_method IN ('gateway', 'neft', 'complimentary')),
    payment_reference VARCHAR(128),
    gateway_order_id VARCHAR(64),
    gateway_payment_id VARCHAR(64) UNIQUE,
    created_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_platform_invoices_society ON platform_invoices (society_id, status);
ALTER TABLE platform_invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_invoices_select ON platform_invoices;
CREATE POLICY platform_invoices_select ON platform_invoices
    FOR SELECT USING (is_platform_admin() OR is_committee_viewer(society_id));

-- One series per Indian financial year: SV-2026-0001 ... (FY starting April 2026)
CREATE OR REPLACE FUNCTION public.platform_next_invoice_number(p_date DATE)
RETURNS TEXT AS $$
DECLARE
    v_prefix TEXT := 'SV-' || extract(year FROM fy_start_of(p_date))::int || '-';
    v_n INT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('sahvaas.platform_invoice_number'));
    SELECT coalesce(max(substring(invoice_number FROM length(v_prefix) + 1)::int), 0) + 1 INTO v_n
    FROM platform_invoices WHERE invoice_number LIKE v_prefix || '%';
    RETURN v_prefix || lpad(v_n::text, 4, '0');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.create_platform_invoice(
    p_society_id UUID, p_quote JSONB, p_kind TEXT, p_period_start DATE, p_period_end DATE, p_issued_on DATE DEFAULT current_date
)
RETURNS UUID AS $$
DECLARE
    v_soc societies%ROWTYPE;
    v_id UUID;
BEGIN
    SELECT * INTO v_soc FROM societies WHERE id = p_society_id;
    INSERT INTO platform_invoices (
        invoice_number, society_id, plan_id, plan_code, billing_term, kind, period_start, period_end,
        billable_units, rate, months_charged, gross, discount, taxable, gst_rate, gst_amount, total,
        seller, bill_to, issued_on, due_on, created_by
    ) VALUES (
        platform_next_invoice_number(p_issued_on), p_society_id, plan_id_of(p_quote ->> 'plan_code'), p_quote ->> 'plan_code',
        p_quote ->> 'term', p_kind, p_period_start, p_period_end,
        (p_quote ->> 'billable_units')::int, (p_quote ->> 'rate')::numeric, (p_quote ->> 'months_charged')::numeric,
        (p_quote ->> 'gross')::numeric, (p_quote ->> 'discount')::numeric, (p_quote ->> 'taxable')::numeric,
        (p_quote ->> 'gst_rate')::numeric, (p_quote ->> 'gst')::numeric, (p_quote ->> 'total')::numeric,
        jsonb_build_object('name', billing_setting('seller_name'), 'gstin', billing_setting('seller_gstin'),
                           'address', billing_setting('seller_address'), 'state', billing_setting('seller_state'), 'sac', billing_setting('sac')),
        jsonb_build_object('name', v_soc.name, 'gstin', v_soc.gstin, 'state', v_soc.state,
                           'address', concat_ws(', ', v_soc.address_line1, v_soc.address_line2, v_soc.city, v_soc.pincode)),
        p_issued_on, p_issued_on + coalesce(billing_setting('due_days')::int, 15), auth.uid()
    ) RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 5. CHOOSING A PLAN
-- ============================================================================
CREATE OR REPLACE FUNCTION public.choose_plan(p_society_id UUID, p_plan_code TEXT, p_term TEXT DEFAULT 'annual')
RETURNS JSONB AS $$
DECLARE
    v_sub subscriptions%ROWTYPE;
    v_cur subscription_plans%ROWTYPE;
    v_new subscription_plans%ROWTYPE;
    v_quote JSONB;
    v_cur_quote JSONB;
    v_in_trial BOOLEAN;
    v_paid_period BOOLEAN;
    v_start DATE;
    v_end DATE;
    v_months NUMERIC;
    v_invoice UUID;
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can change the Sahvaas plan';
    END IF;
    SELECT * INTO v_new FROM subscription_plans WHERE tier_code = p_plan_code AND is_active;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown plan %', p_plan_code;
    END IF;
    PERFORM start_trial(p_society_id);
    SELECT * INTO v_sub FROM subscriptions WHERE society_id = p_society_id FOR UPDATE;
    SELECT * INTO v_cur FROM subscription_plans WHERE id = v_sub.plan_id;

    v_in_trial := v_sub.trial_ends_on >= current_date AND (v_sub.status = 'trial' OR v_sub.current_period_start > current_date);
    v_paid_period := NOT v_in_trial AND v_sub.status IN ('active', 'past_due') AND v_cur.monthly_rate_per_unit_inr > 0
                     AND v_sub.current_period_end >= current_date;

    -- A new choice replaces any unpaid new / upgrade invoice
    UPDATE platform_invoices SET status = 'void'
    WHERE society_id = p_society_id AND status = 'issued' AND kind IN ('new', 'upgrade');

    IF v_new.monthly_rate_per_unit_inr = 0 THEN
        IF v_paid_period THEN
            UPDATE subscriptions SET next_plan_id = v_new.id, updated_at = timezone('utc'::text, now()) WHERE society_id = p_society_id;
            RETURN jsonb_build_object('scheduled', true, 'plan_code', v_new.tier_code, 'effective_on', v_sub.current_period_end + 1);
        END IF;
        UPDATE subscriptions
        SET plan_id = v_new.id, status = 'active', current_period_start = greatest(current_date, coalesce(v_sub.trial_ends_on + 1, current_date)),
            current_period_end = NULL, next_plan_id = NULL, updated_at = timezone('utc'::text, now())
        WHERE society_id = p_society_id;
        -- Trial features still run until the trial date; the society is now on a chosen plan
        UPDATE societies SET subscription_status = 'active' WHERE id = p_society_id AND subscription_status = 'trial';
        RETURN jsonb_build_object('scheduled', false, 'plan_code', 'free');
    END IF;

    IF v_paid_period AND v_cur.id = v_new.id THEN
        RAISE EXCEPTION 'You are already on %; the renewal invoice comes before % ends', v_cur.name, v_sub.current_period_end;
    END IF;

    IF v_paid_period AND v_new.monthly_rate_per_unit_inr < v_cur.monthly_rate_per_unit_inr THEN
        UPDATE subscriptions SET next_plan_id = v_new.id, updated_at = timezone('utc'::text, now()) WHERE society_id = p_society_id;
        RETURN jsonb_build_object('scheduled', true, 'plan_code', v_new.tier_code, 'effective_on', v_sub.current_period_end + 1);
    END IF;

    IF v_paid_period THEN
        -- Upgrade now: pay only the difference for the whole months left in the period
        v_months := least(ceil((v_sub.current_period_end - current_date + 1) / 30.0),
                          CASE WHEN v_sub.billing_term = 'annual' THEN 12 ELSE 1 END);
        v_quote := subscription_quote(p_society_id, v_new.tier_code, v_sub.billing_term, v_months);
        v_cur_quote := subscription_quote(p_society_id, v_cur.tier_code, v_sub.billing_term, v_months);
        v_quote := v_quote || jsonb_build_object(
            'rate', (v_quote ->> 'rate')::numeric - (v_cur_quote ->> 'rate')::numeric,
            'gross', (v_quote ->> 'gross')::numeric - (v_cur_quote ->> 'gross')::numeric,
            'discount', (v_quote ->> 'discount')::numeric - (v_cur_quote ->> 'discount')::numeric,
            'taxable', (v_quote ->> 'taxable')::numeric - (v_cur_quote ->> 'taxable')::numeric,
            'gst', (v_quote ->> 'gst')::numeric - (v_cur_quote ->> 'gst')::numeric,
            'total', (v_quote ->> 'total')::numeric - (v_cur_quote ->> 'total')::numeric
        );
        v_invoice := create_platform_invoice(p_society_id, v_quote, 'upgrade', current_date, v_sub.current_period_end);
    ELSE
        v_quote := subscription_quote(p_society_id, v_new.tier_code, p_term);
        v_start := CASE WHEN v_in_trial THEN v_sub.trial_ends_on + 1 ELSE current_date END;
        v_end := (v_start + make_interval(months => CASE WHEN p_term = 'annual' THEN 12 ELSE 1 END
                                                   + coalesce((v_quote ->> 'free_months')::int, 0)) - interval '1 day')::date;
        v_invoice := create_platform_invoice(p_society_id, v_quote, 'new', v_start, v_end);
    END IF;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (p_society_id, auth.uid(), 'billing.plan_chosen', 'platform_invoice', v_invoice::text,
            jsonb_build_object('plan', v_new.tier_code, 'term', p_term));
    RETURN (SELECT jsonb_build_object('scheduled', false, 'invoice_id', i.id, 'invoice_number', i.invoice_number, 'total', i.total,
                                      'kind', i.kind, 'period_start', i.period_start, 'period_end', i.period_end, 'due_on', i.due_on)
            FROM platform_invoices i WHERE i.id = v_invoice);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 6. PAYMENTS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.apply_platform_invoice_payment(
    p_invoice_id UUID, p_method TEXT, p_reference TEXT, p_paid_on DATE, p_gateway_payment_id TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_inv platform_invoices%ROWTYPE;
    v_vendor UUID;
BEGIN
    SELECT * INTO v_inv FROM platform_invoices WHERE id = p_invoice_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice not found';
    END IF;
    IF v_inv.status = 'paid' THEN
        RETURN jsonb_build_object('status', 'paid', 'already', true);
    END IF;

    UPDATE platform_invoices
    SET status = 'paid', paid_on = coalesce(p_paid_on, current_date), payment_method = p_method,
        payment_reference = nullif(trim(coalesce(p_reference, '')), ''), gateway_payment_id = p_gateway_payment_id
    WHERE id = p_invoice_id;

    IF v_inv.kind = 'upgrade' THEN
        UPDATE subscriptions SET plan_id = v_inv.plan_id, next_plan_id = NULL, updated_at = timezone('utc'::text, now())
        WHERE society_id = v_inv.society_id;
    ELSE
        UPDATE subscriptions
        SET plan_id = v_inv.plan_id, billing_term = v_inv.billing_term, status = 'active',
            current_period_start = v_inv.period_start, current_period_end = v_inv.period_end,
            next_plan_id = NULL, unit_count = v_inv.billable_units, updated_at = timezone('utc'::text, now())
        WHERE society_id = v_inv.society_id;
    END IF;
    UPDATE societies SET subscription_status = 'active', updated_at = timezone('utc'::text, now())
    WHERE id = v_inv.society_id AND subscription_status = 'trial';

    -- The society pays Sahvaas from its own funds: a draft bill for the committee to approve
    SELECT id INTO v_vendor FROM vendors WHERE society_id = v_inv.society_id AND lower(name) = lower(v_inv.seller ->> 'name') LIMIT 1;
    IF v_vendor IS NULL THEN
        INSERT INTO vendors (society_id, name, phone, gstin, category)
        VALUES (v_inv.society_id, coalesce(v_inv.seller ->> 'name', 'Sahvaas'), coalesce(billing_setting('seller_phone'), '0000000000'),
                nullif(v_inv.seller ->> 'gstin', ''), 'other')
        RETURNING id INTO v_vendor;
    END IF;
    INSERT INTO expenses (society_id, vendor_id, category, title, invoice_number, invoice_date, subtotal, gst_amount, tds_amount, status)
    VALUES (v_inv.society_id, v_vendor, 'software',
            'Sahvaas ' || initcap(v_inv.plan_code) || ' plan · ' || to_char(v_inv.period_start, 'DD Mon YYYY') || ' – ' || to_char(v_inv.period_end, 'DD Mon YYYY'),
            v_inv.invoice_number, v_inv.issued_on, v_inv.taxable, v_inv.gst_amount, 0, 'pending_approval');

    -- Gateway webhooks have no user; the invoice itself records method and payment id
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    SELECT v_inv.society_id, auth.uid(), 'billing.invoice_paid', 'platform_invoice', p_invoice_id::text,
           jsonb_build_object('number', v_inv.invoice_number, 'total', v_inv.total, 'method', p_method, 'reference', p_reference)
    WHERE auth.uid() IS NOT NULL;
    RETURN jsonb_build_object('status', 'paid', 'already', false, 'invoice_number', v_inv.invoice_number);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.platform_mark_invoice_paid(p_invoice_id UUID, p_reference TEXT, p_paid_on DATE DEFAULT current_date)
RETURNS JSONB AS $$
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;
    IF length(trim(coalesce(p_reference, ''))) = 0 THEN
        RAISE EXCEPTION 'Enter the bank UTR / reference';
    END IF;
    RETURN apply_platform_invoice_payment(p_invoice_id, 'neft', p_reference, p_paid_on);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Committee: remember the gateway order created for an invoice (server route)
CREATE OR REPLACE FUNCTION public.attach_gateway_order(p_invoice_id UUID, p_order_id TEXT)
RETURNS VOID AS $$
DECLARE
    v_inv platform_invoices%ROWTYPE;
BEGIN
    SELECT * INTO v_inv FROM platform_invoices WHERE id = p_invoice_id FOR UPDATE;
    IF NOT FOUND OR NOT (is_platform_admin() OR is_society_admin(v_inv.society_id)) THEN
        RAISE EXCEPTION 'Invoice not found';
    END IF;
    IF v_inv.status <> 'issued' THEN
        RAISE EXCEPTION 'This invoice is %', v_inv.status;
    END IF;
    UPDATE platform_invoices SET gateway_order_id = p_order_id WHERE id = p_invoice_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Called by the Sahvaas server after it has verified the gateway's signature.
-- Works without a user session (webhooks); guarded by the shared gateway secret.
CREATE OR REPLACE FUNCTION public.gateway_record_payment(
    p_secret TEXT, p_invoice_id UUID, p_order_id TEXT, p_payment_id TEXT, p_amount_paise BIGINT
)
RETURNS JSONB AS $$
DECLARE
    v_hash TEXT;
    v_inv platform_invoices%ROWTYPE;
BEGIN
    SELECT value_sha256 INTO v_hash FROM platform_secrets WHERE key = 'gateway';
    IF v_hash IS NULL OR sha256_hex(coalesce(p_secret, '')) <> v_hash THEN
        RAISE EXCEPTION 'Not authorised';
    END IF;
    SELECT * INTO v_inv FROM platform_invoices WHERE id = p_invoice_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice not found';
    END IF;
    IF v_inv.gateway_payment_id = p_payment_id THEN
        RETURN jsonb_build_object('status', 'paid', 'already', true);
    END IF;
    IF v_inv.gateway_order_id IS NOT NULL AND v_inv.gateway_order_id <> p_order_id THEN
        RAISE EXCEPTION 'Order does not match this invoice';
    END IF;
    IF p_amount_paise <> round(v_inv.total * 100) THEN
        RAISE EXCEPTION 'Amount % paise does not match invoice total', p_amount_paise;
    END IF;
    RETURN apply_platform_invoice_payment(p_invoice_id, 'gateway', p_payment_id, current_date, p_payment_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 7. DAILY LIFECYCLE
-- ============================================================================
CREATE OR REPLACE FUNCTION public.run_subscription_lifecycle(p_today DATE DEFAULT current_date)
RETURNS JSONB AS $$
DECLARE
    r RECORD;
    v_free UUID := plan_id_of('free');
    v_renew_before INT := coalesce(billing_setting('renew_days_before')::int, 15);
    v_downgrade_days INT := coalesce(billing_setting('downgrade_days')::int, 30);
    v_trials INT := 0;
    v_switched INT := 0;
    v_renewals INT := 0;
    v_grace INT := 0;
    v_downgraded INT := 0;
    v_quote JSONB;
    v_start DATE;
BEGIN
    IF auth.uid() IS NOT NULL AND NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;

    -- a) Trial over without a paid plan -> Free
    FOR r IN SELECT * FROM subscriptions WHERE status = 'trial' AND trial_ends_on < p_today LOOP
        UPDATE subscriptions SET plan_id = v_free, status = 'active', current_period_start = r.trial_ends_on + 1,
                                 current_period_end = NULL, next_plan_id = NULL, updated_at = timezone('utc'::text, now())
        WHERE society_id = r.society_id;
        UPDATE societies SET subscription_status = 'active' WHERE id = r.society_id AND subscription_status = 'trial';
        INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id)
        SELECT r.society_id, auth.uid(), 'billing.trial_ended', 'society', r.society_id::text WHERE auth.uid() IS NOT NULL;
        v_trials := v_trials + 1;
    END LOOP;

    -- b) Scheduled switch to Free at the end of a paid period
    FOR r IN SELECT * FROM subscriptions WHERE next_plan_id = v_free AND current_period_end < p_today LOOP
        UPDATE subscriptions SET plan_id = v_free, current_period_start = r.current_period_end + 1, current_period_end = NULL,
                                 next_plan_id = NULL, status = 'active', updated_at = timezone('utc'::text, now())
        WHERE society_id = r.society_id;
        v_switched := v_switched + 1;
    END LOOP;

    -- c) Renewal invoice `renew_days_before` days before a paid period ends
    FOR r IN
        SELECT s.*, coalesce(np.tier_code, p.tier_code) AS renew_code
        FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
        LEFT JOIN subscription_plans np ON np.id = s.next_plan_id
        WHERE s.status IN ('active', 'past_due') AND s.auto_renew AND p.monthly_rate_per_unit_inr > 0
          AND s.current_period_end IS NOT NULL AND s.current_period_end - p_today <= v_renew_before
          AND coalesce(np.monthly_rate_per_unit_inr, 1) > 0
          AND NOT EXISTS (SELECT 1 FROM platform_invoices i WHERE i.society_id = s.society_id AND i.status IN ('issued', 'paid')
                          AND i.kind IN ('new', 'renewal') AND i.period_start = s.current_period_end + 1)
    LOOP
        v_quote := subscription_quote(r.society_id, r.renew_code, r.billing_term) - 'free_months';
        v_start := r.current_period_end + 1;
        PERFORM create_platform_invoice(r.society_id, v_quote, 'renewal', v_start,
            (v_start + make_interval(months => CASE WHEN r.billing_term = 'annual' THEN 12 ELSE 1 END) - interval '1 day')::date, p_today);
        v_renewals := v_renewals + 1;
    END LOOP;

    -- d) Period over and renewal unpaid: grace (past_due), then Free after `downgrade_days` from the invoice
    FOR r IN
        SELECT s.society_id, s.status, i.issued_on
        FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
        JOIN platform_invoices i ON i.society_id = s.society_id AND i.status = 'issued' AND i.kind = 'renewal'
                                 AND i.period_start = s.current_period_end + 1
        WHERE p.monthly_rate_per_unit_inr > 0 AND s.current_period_end < p_today
    LOOP
        IF p_today > r.issued_on + v_downgrade_days THEN
            UPDATE subscriptions SET plan_id = v_free, status = 'active', current_period_start = p_today, current_period_end = NULL,
                                     next_plan_id = NULL, updated_at = timezone('utc'::text, now())
            WHERE society_id = r.society_id;
            INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id)
            SELECT r.society_id, auth.uid(), 'billing.moved_to_free', 'society', r.society_id::text WHERE auth.uid() IS NOT NULL;
            v_downgraded := v_downgraded + 1;
        ELSIF r.status <> 'past_due' THEN
            UPDATE subscriptions SET status = 'past_due', updated_at = timezone('utc'::text, now()) WHERE society_id = r.society_id;
            v_grace := v_grace + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('trials_ended', v_trials, 'switched_to_free', v_switched, 'renewal_invoices', v_renewals,
                              'in_grace', v_grace, 'moved_to_free', v_downgraded);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DO $outer$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
        CREATE EXTENSION IF NOT EXISTS pg_cron;
        PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sahvaas-subscriptions';
        PERFORM cron.schedule('sahvaas-subscriptions', '30 19 * * *', $cron$SELECT public.run_subscription_lifecycle()$cron$);
    END IF;
END
$outer$;

-- ============================================================================
-- 8. ENTITLEMENTS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.society_in_trial(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT coalesce((SELECT s.trial_ends_on >= current_date AND (s.status = 'trial' OR s.current_period_start > current_date)
                     FROM subscriptions s WHERE s.society_id = p_society_id), false)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.society_has_feature(p_society_id UUID, p_key TEXT)
RETURNS BOOLEAN AS $$
    SELECT society_in_trial(p_society_id) OR coalesce((
        SELECT p_key = ANY(p.feature_keys) FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
        WHERE s.society_id = p_society_id
    ), false)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Plan summary for the committee screens
CREATE OR REPLACE FUNCTION public.society_plan(p_society_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_sub subscriptions%ROWTYPE;
    v_plan subscription_plans%ROWTYPE;
    v_next TEXT;
    v_trial BOOLEAN;
    v_inv platform_invoices%ROWTYPE;
    v_all TEXT[] := ARRAY['ca_portal', 'asset_register', 'gst_recon', 'tds_register', 'bank_match', 'tally_export'];
BEGIN
    IF NOT (is_platform_admin() OR is_committee_viewer(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can see the Sahvaas plan';
    END IF;
    SELECT * INTO v_sub FROM subscriptions WHERE society_id = p_society_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    SELECT * INTO v_plan FROM subscription_plans WHERE id = v_sub.plan_id;
    SELECT tier_code INTO v_next FROM subscription_plans WHERE id = v_sub.next_plan_id;
    v_trial := society_in_trial(p_society_id);
    SELECT * INTO v_inv FROM platform_invoices WHERE society_id = p_society_id AND status = 'issued' ORDER BY issued_on DESC LIMIT 1;

    RETURN jsonb_build_object(
        'plan_code', CASE WHEN v_trial AND v_sub.status = 'trial' THEN 'trial' ELSE v_plan.tier_code END,
        'paid_plan_code', v_plan.tier_code,
        'plan_name', CASE WHEN v_trial AND v_sub.status = 'trial' THEN 'Free trial' ELSE v_plan.name END,
        'status', v_sub.status, 'in_trial', v_trial, 'trial_ends_on', v_sub.trial_ends_on,
        'term', v_sub.billing_term, 'period_start', v_sub.current_period_start, 'period_end', v_sub.current_period_end,
        'next_plan_code', v_next,
        'features', CASE WHEN v_trial THEN v_all ELSE v_plan.feature_keys END,
        'show_ads', NOT v_trial AND v_plan.show_ads,
        'open_invoice', CASE WHEN v_inv.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', v_inv.id, 'invoice_number', v_inv.invoice_number, 'total', v_inv.total, 'kind', v_inv.kind,
            'issued_on', v_inv.issued_on, 'due_on', v_inv.due_on, 'period_start', v_inv.period_start, 'period_end', v_inv.period_end,
            'overdue', v_inv.due_on < current_date,
            'moves_to_free_on', CASE WHEN v_inv.kind = 'renewal' THEN v_inv.issued_on + coalesce(billing_setting('downgrade_days')::int, 30) + 1 END
        ) END
    );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- CA portal follows the plan: grants stay, but give no access on Free
CREATE OR REPLACE FUNCTION public.has_professional_permission(target_society_id UUID, required_permission TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN society_has_feature(target_society_id, 'ca_portal') AND EXISTS (
    SELECT 1 FROM society_professional_access spa
    JOIN societies s ON s.id = spa.society_id AND s.is_active = true
    WHERE spa.society_id = target_society_id
      AND spa.professional_user_id = auth.uid()
      AND spa.status = 'active'
      AND (spa.expires_at IS NULL OR spa.expires_at > now())
      AND spa.permissions ? required_permission
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.require_feature(p_society_id UUID, p_key TEXT, p_label TEXT)
RETURNS VOID AS $$
BEGIN
    IF NOT society_has_feature(p_society_id, p_key) THEN
        RAISE EXCEPTION '% is part of the % plan — upgrade under Plan & Billing', p_label,
            CASE WHEN p_key IN ('ca_portal', 'asset_register') THEN 'Basic and Pro' ELSE 'Pro' END;
    END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.trg_feature_ca_invite()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM require_feature(NEW.society_id, 'ca_portal', 'CA & auditor access');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_feature_ca_invite ON professional_invites;
CREATE TRIGGER trg_feature_ca_invite BEFORE INSERT ON professional_invites
    FOR EACH ROW EXECUTE FUNCTION public.trg_feature_ca_invite();

-- Bills booked as assets still create register rows on any plan (the books stay right);
-- adding old assets, depreciation, disposal and rate changes need the asset register
CREATE OR REPLACE FUNCTION public.trg_feature_asset_register()
RETURNS TRIGGER AS $$
BEGIN
    -- Nested IFs: PL/pgSQL may evaluate every operand, and depreciation_runs has no opening_as_of
    IF TG_TABLE_NAME = 'depreciation_runs' THEN
        PERFORM require_feature(NEW.society_id, 'asset_register', 'The asset register');
    ELSIF TG_OP = 'INSERT' THEN
        IF NEW.opening_as_of IS NOT NULL THEN
            PERFORM require_feature(NEW.society_id, 'asset_register', 'The asset register');
        END IF;
    ELSIF NEW.status = 'disposed' OR NEW.dep_rate IS DISTINCT FROM OLD.dep_rate OR NEW.dep_method IS DISTINCT FROM OLD.dep_method THEN
        PERFORM require_feature(NEW.society_id, 'asset_register', 'The asset register');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_feature_asset_register ON fixed_assets;
CREATE TRIGGER trg_feature_asset_register BEFORE INSERT OR UPDATE ON fixed_assets
    FOR EACH ROW EXECUTE FUNCTION public.trg_feature_asset_register();
DROP TRIGGER IF EXISTS trg_feature_asset_register ON depreciation_runs;
CREATE TRIGGER trg_feature_asset_register BEFORE INSERT ON depreciation_runs
    FOR EACH ROW EXECUTE FUNCTION public.trg_feature_asset_register();

CREATE OR REPLACE FUNCTION public.trg_feature_gst_recon()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM require_feature(NEW.society_id, 'gst_recon', 'GSTR-2B reconciliation');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_feature_gst_recon ON gst_2b_uploads;
CREATE TRIGGER trg_feature_gst_recon BEFORE INSERT ON gst_2b_uploads
    FOR EACH ROW EXECUTE FUNCTION public.trg_feature_gst_recon();

-- TDS register (014) behind the Pro plan
CREATE OR REPLACE FUNCTION public.tds_register(p_society_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (paid_on DATE, reference TEXT, expense_number TEXT, vendor TEXT, pan TEXT, entity TEXT,
               section TEXT, rate NUMERIC, taxable NUMERIC, amount_paid NUMERIC, tds NUMERIC) AS $$
BEGIN
    IF NOT (can_view_expenses(p_society_id) OR can_view_financials(p_society_id)) THEN
        RAISE EXCEPTION 'You do not have access to this society''s expenses';
    END IF;
    PERFORM require_feature(p_society_id, 'tds_register', 'The TDS register');
    RETURN QUERY
    SELECT vp.paid_on, vp.payment_number::text, e.expense_number::text, coalesce(v.name, e.payee_name)::text,
           vendor_pan(v.pan, v.gstin), pan_entity(vendor_pan(v.pan, v.gstin)), e.tds_section::text, e.tds_rate,
           e.subtotal, vp.amount, vp.tds_amount
    FROM vendor_payments vp JOIN expenses e ON e.id = vp.expense_id LEFT JOIN vendors v ON v.id = e.vendor_id
    WHERE vp.society_id = p_society_id AND vp.status = 'recorded' AND vp.tds_amount > 0 AND vp.paid_on BETWEEN p_from AND p_to
    UNION ALL
    SELECT e.paid_date, coalesce(e.payment_reference, '—')::text, e.expense_number::text, coalesce(v.name, e.payee_name)::text,
           vendor_pan(v.pan, v.gstin), pan_entity(vendor_pan(v.pan, v.gstin)), e.tds_section::text, e.tds_rate,
           e.subtotal, e.net_payable, e.tds_amount
    FROM expenses e LEFT JOIN vendors v ON v.id = e.vendor_id
    WHERE e.society_id = p_society_id AND e.status = 'paid' AND e.tds_amount > 0 AND e.paid_date BETWEEN p_from AND p_to
      AND NOT EXISTS (SELECT 1 FROM vendor_payments vp WHERE vp.expense_id = e.id)
    ORDER BY 1, 2;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 9. PLATFORM OWNER: BILLING OVERVIEW AND OVERRIDES
-- ============================================================================
CREATE OR REPLACE FUNCTION public.platform_billing_overview()
RETURNS TABLE (
    society_id UUID, name TEXT, city TEXT, units INT, plan_code TEXT, status TEXT, in_trial BOOLEAN, trial_ends_on DATE,
    term TEXT, period_end DATE, next_plan_code TEXT, monthly_value NUMERIC, open_invoice_total NUMERIC, open_invoice_due DATE,
    has_override BOOLEAN
) AS $$
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;
    RETURN QUERY
    SELECT s.id, s.name::text, s.city::text, (SELECT count(*)::int FROM units u WHERE u.society_id = s.id),
           p.tier_code::text, sub.status::text, society_in_trial(s.id), sub.trial_ends_on, sub.billing_term::text,
           sub.current_period_end, np.tier_code::text,
           -- Booked value: paid plans count even if they start after the trial
           CASE WHEN p.monthly_rate_per_unit_inr > 0 AND sub.status IN ('active', 'past_due')
                THEN (subscription_quote(s.id, p.tier_code, sub.billing_term) ->> 'monthly_equivalent')::numeric ELSE 0 END,
           (SELECT sum(i.total) FROM platform_invoices i WHERE i.society_id = s.id AND i.status = 'issued'),
           (SELECT min(i.due_on) FROM platform_invoices i WHERE i.society_id = s.id AND i.status = 'issued'),
           EXISTS (SELECT 1 FROM society_pricing_overrides o WHERE o.society_id = s.id)
    FROM societies s
    JOIN subscriptions sub ON sub.society_id = s.id
    JOIN subscription_plans p ON p.id = sub.plan_id
    LEFT JOIN subscription_plans np ON np.id = sub.next_plan_id
    ORDER BY s.created_at DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.platform_set_pricing_override(
    p_society_id UUID, p_custom_rate NUMERIC, p_discount_percent NUMERIC, p_free_months INT, p_excluded_units INT,
    p_valid_till DATE, p_reason TEXT
)
RETURNS VOID AS $$
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;
    INSERT INTO society_pricing_overrides (society_id, custom_rate, discount_percent, free_months, excluded_units, valid_till, reason, updated_by)
    VALUES (p_society_id, p_custom_rate, coalesce(p_discount_percent, 0), coalesce(p_free_months, 0), coalesce(p_excluded_units, 0),
            p_valid_till, trim(coalesce(p_reason, '')), auth.uid())
    ON CONFLICT (society_id) DO UPDATE SET
        custom_rate = EXCLUDED.custom_rate, discount_percent = EXCLUDED.discount_percent, free_months = EXCLUDED.free_months,
        excluded_units = EXCLUDED.excluded_units, valid_till = EXCLUDED.valid_till, reason = EXCLUDED.reason,
        updated_by = EXCLUDED.updated_by, updated_at = timezone('utc'::text, now());
    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value, reason)
    VALUES (p_society_id, auth.uid(), 'platform.pricing_override', 'society', p_society_id::text,
            jsonb_build_object('rate', p_custom_rate, 'discount', p_discount_percent, 'free_months', p_free_months,
                               'excluded_units', p_excluded_units, 'valid_till', p_valid_till), trim(coalesce(p_reason, '')));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- 10. PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.billing_setting(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.start_trial(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_society_start_trial() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.platform_next_invoice_number(DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_platform_invoice(UUID, JSONB, TEXT, DATE, DATE, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_platform_invoice_payment(UUID, TEXT, TEXT, DATE, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_feature_ca_invite() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_feature_asset_register() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_feature_gst_recon() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.platform_set_gateway_secret(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.subscription_quote(UUID, TEXT, TEXT, NUMERIC) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.choose_plan(UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_mark_invoice_paid(UUID, TEXT, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.attach_gateway_order(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gateway_record_payment(TEXT, UUID, TEXT, TEXT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.run_subscription_lifecycle(DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.society_plan(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_billing_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_set_pricing_override(UUID, NUMERIC, NUMERIC, INT, INT, DATE, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.billing_setting(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_set_gateway_secret(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_quote(UUID, TEXT, TEXT, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.choose_plan(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_mark_invoice_paid(UUID, TEXT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attach_gateway_order(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gateway_record_payment(TEXT, UUID, TEXT, TEXT, BIGINT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_subscription_lifecycle(DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.society_plan(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.society_in_trial(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.society_has_feature(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_billing_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_set_pricing_override(UUID, NUMERIC, NUMERIC, INT, INT, DATE, TEXT) TO authenticated;


-- ============================================================================
-- 016 SPONSORED CARDS ON THE FREE PLAN (P12)
--   * ad_campaigns: local sponsors (and Sahvaas house cards), targeting by city /
--     pincode, dates, placements, fixed monthly price — platform admin only
--   * Shown only to residents (owner / tenant) of societies on a plan with ads,
--     never during the trial, never to the committee, never on money screens
--     (the app only has slots on the home feed and the notices list)
--   * ad_daily_stats: per campaign, society, day and placement — no user ids
--   * Public storage bucket "ad-creatives" for sponsor images
-- ============================================================================

CREATE TABLE IF NOT EXISTS ad_campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sponsor_name VARCHAR(128) NOT NULL,
    title VARCHAR(80) NOT NULL,
    body VARCHAR(160),
    image_path TEXT CHECK (image_path IS NULL OR (image_path !~ '\.\.' AND image_path ~ '^[a-z0-9/_.-]+$')),
    cta_label VARCHAR(32),
    cta_url TEXT CHECK (cta_url IS NULL OR cta_url ~ '^(https://[^\s]+|tel:\+?[0-9]{6,15})$'),
    cities TEXT[] NOT NULL DEFAULT '{}',
    pincodes TEXT[] NOT NULL DEFAULT '{}',
    placements TEXT[] NOT NULL DEFAULT '{home_feed}'
        CHECK (cardinality(placements) > 0 AND placements <@ ARRAY['home_feed', 'notices']::text[]),
    starts_on DATE NOT NULL,
    ends_on DATE NOT NULL,
    monthly_price NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (monthly_price >= 0),
    is_house BOOLEAN NOT NULL DEFAULT false,      -- Sahvaas's own cards (fill empty slots)
    priority INT NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'paused', 'ended')),
    notes TEXT,
    created_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT chk_ad_dates CHECK (ends_on >= starts_on)
);

CREATE TABLE IF NOT EXISTS ad_daily_stats (
    campaign_id UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    placement VARCHAR(16) NOT NULL,
    impressions INT NOT NULL DEFAULT 0,
    clicks INT NOT NULL DEFAULT 0,
    PRIMARY KEY (campaign_id, society_id, day, placement)
);

ALTER TABLE ad_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_daily_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ad_campaigns_admin ON ad_campaigns;
DROP POLICY IF EXISTS ad_daily_stats_admin ON ad_daily_stats;
CREATE POLICY ad_campaigns_admin ON ad_campaigns FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());
CREATE POLICY ad_daily_stats_admin ON ad_daily_stats FOR SELECT USING (is_platform_admin());

-- Targeting is matched case-insensitively on city and exactly on pincode
CREATE OR REPLACE FUNCTION public.ad_campaigns_normalise()
RETURNS TRIGGER AS $$
BEGIN
    NEW.cities := coalesce(ARRAY(SELECT DISTINCT lower(trim(c)) FROM unnest(NEW.cities) c WHERE trim(c) <> ''), '{}');
    NEW.pincodes := coalesce(ARRAY(SELECT DISTINCT trim(p) FROM unnest(NEW.pincodes) p WHERE trim(p) <> ''), '{}');
    IF EXISTS (SELECT 1 FROM unnest(NEW.pincodes) p WHERE p !~ '^[0-9]{6}$') THEN
        RAISE EXCEPTION 'Pincodes must have 6 digits';
    END IF;
    NEW.updated_at := timezone('utc'::text, now());
    IF TG_OP = 'INSERT' AND auth.uid() IS NOT NULL THEN
        NEW.created_by := auth.uid();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;
DROP TRIGGER IF EXISTS trg_ad_campaigns_normalise ON ad_campaigns;
CREATE TRIGGER trg_ad_campaigns_normalise BEFORE INSERT OR UPDATE ON ad_campaigns
    FOR EACH ROW EXECUTE FUNCTION public.ad_campaigns_normalise();

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('ad-creatives', 'ad-creatives', true, 2097152)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "ad creatives: admin write" ON storage.objects;
DROP POLICY IF EXISTS "ad creatives: admin delete" ON storage.objects;
CREATE POLICY "ad creatives: admin write" ON storage.objects
    FOR INSERT TO authenticated WITH CHECK (bucket_id = 'ad-creatives' AND public.is_platform_admin());
CREATE POLICY "ad creatives: admin delete" ON storage.objects
    FOR DELETE TO authenticated USING (bucket_id = 'ad-creatives' AND public.is_platform_admin());

-- ----------------------------------------------------------------------------
-- Eligibility
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.society_shows_ads(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT coalesce((
        SELECT s.is_active AND p.show_ads AND NOT society_in_trial(s.id)
        FROM societies s
        JOIN subscriptions sub ON sub.society_id = s.id
        JOIN subscription_plans p ON p.id = sub.plan_id
        WHERE s.id = p_society_id
    ), false)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.is_resident_member(p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM society_memberships m
        WHERE m.society_id = p_society_id AND m.user_id = auth.uid() AND m.is_active
          AND m.role IN ('resident_owner', 'resident_tenant')
    )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- No cities and no pincodes = everywhere; otherwise the society's city OR pincode must be listed
CREATE OR REPLACE FUNCTION public.ad_targets_society(p_cities TEXT[], p_pincodes TEXT[], p_society_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM societies s WHERE s.id = p_society_id AND (
            (cardinality(p_cities) = 0 AND cardinality(p_pincodes) = 0)
            OR lower(trim(s.city)) = ANY(p_cities)
            OR trim(s.pincode) = ANY(p_pincodes)
        )
    )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.ad_matches_society(p_campaign ad_campaigns, p_society_id UUID, p_on DATE DEFAULT current_date)
RETURNS BOOLEAN AS $$
    SELECT p_campaign.status = 'live' AND p_on BETWEEN p_campaign.starts_on AND p_campaign.ends_on
       AND ad_targets_society(p_campaign.cities, p_campaign.pincodes, p_society_id)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Up to two cards for this resident's society and slot: sponsors first, house cards fill in
CREATE OR REPLACE FUNCTION public.ads_for_me(p_society_id UUID, p_placement TEXT)
RETURNS TABLE (id UUID, sponsor_name TEXT, title TEXT, body TEXT, image_path TEXT, cta_label TEXT, cta_url TEXT, is_house BOOLEAN) AS $$
BEGIN
    IF NOT is_resident_member(p_society_id) OR NOT society_shows_ads(p_society_id) THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT c.id, c.sponsor_name::text, c.title::text, c.body::text, c.image_path, c.cta_label::text, c.cta_url, c.is_house
    FROM ad_campaigns c
    WHERE p_placement = ANY(c.placements) AND ad_matches_society(c, p_society_id)
    ORDER BY c.is_house, c.priority DESC, random()
    LIMIT 2;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public;

-- Counts only. Ineligible calls are ignored rather than raising (ad blockers, stale tabs).
CREATE OR REPLACE FUNCTION public.record_ad_event(p_campaign_id UUID, p_society_id UUID, p_placement TEXT, p_kind TEXT)
RETURNS BOOLEAN AS $$
DECLARE
    v_c ad_campaigns%ROWTYPE;
BEGIN
    IF p_kind NOT IN ('impression', 'click') THEN
        RETURN false;
    END IF;
    SELECT * INTO v_c FROM ad_campaigns WHERE id = p_campaign_id;
    IF NOT FOUND OR NOT (p_placement = ANY(v_c.placements)) OR NOT ad_matches_society(v_c, p_society_id)
       OR NOT is_resident_member(p_society_id) OR NOT society_shows_ads(p_society_id) THEN
        RETURN false;
    END IF;
    INSERT INTO ad_daily_stats (campaign_id, society_id, day, placement, impressions, clicks)
    VALUES (p_campaign_id, p_society_id, current_date, p_placement,
            CASE WHEN p_kind = 'impression' THEN 1 ELSE 0 END, CASE WHEN p_kind = 'click' THEN 1 ELSE 0 END)
    ON CONFLICT (campaign_id, society_id, day, placement) DO UPDATE SET
        impressions = ad_daily_stats.impressions + EXCLUDED.impressions,
        clicks = ad_daily_stats.clicks + EXCLUDED.clicks;
    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- Platform owner
-- ----------------------------------------------------------------------------
-- Societies (and flats) the campaign's targeting covers right now (works for drafts too)
CREATE OR REPLACE FUNCTION public.ad_reach(p_campaign_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_c ad_campaigns%ROWTYPE;
    v_societies INT;
    v_flats INT;
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;
    SELECT * INTO v_c FROM ad_campaigns WHERE id = p_campaign_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Campaign not found';
    END IF;
    SELECT count(*), coalesce(sum((SELECT count(*) FROM units u WHERE u.society_id = s.id)), 0)
    INTO v_societies, v_flats
    FROM societies s
    WHERE society_shows_ads(s.id) AND ad_targets_society(v_c.cities, v_c.pincodes, s.id);
    RETURN jsonb_build_object('societies', v_societies, 'flats', v_flats);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.platform_ad_report(p_from DATE, p_to DATE)
RETURNS TABLE (campaign_id UUID, impressions BIGINT, clicks BIGINT, societies BIGINT) AS $$
BEGIN
    IF NOT is_platform_admin() THEN
        RAISE EXCEPTION 'Platform admin only';
    END IF;
    RETURN QUERY
    SELECT st.campaign_id, sum(st.impressions)::bigint, sum(st.clicks)::bigint, count(DISTINCT st.society_id)::bigint
    FROM ad_daily_stats st
    WHERE st.day BETWEEN p_from AND p_to
    GROUP BY st.campaign_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.ad_campaigns_normalise() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.society_shows_ads(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_resident_member(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ad_targets_society(TEXT[], TEXT[], UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ad_matches_society(ad_campaigns, UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ads_for_me(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_ad_event(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ad_reach(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_ad_report(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.society_shows_ads(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ads_for_me(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_ad_event(UUID, UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ad_reach(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_ad_report(DATE, DATE) TO authenticated;


-- ============================================================================
-- 017 BANK STATEMENT MATCH (P10, Pro plan)
--   1. Statement imports (parsed CSV rows from the browser), duplicate-safe
--   2. Auto-match: credits -> resident payments by UTR; debits -> vendor payments
--      by reference, TDS challans by amount + "TDS"; otherwise a suggestion by
--      amount and date
--   3. Committee actions: verify all matched, record an unknown credit as a flat's
--      payment, link / unlink / ignore, summary
--   Statement lines change only through these functions.
-- ============================================================================

CREATE TABLE IF NOT EXISTS bank_statement_imports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    society_id UUID NOT NULL REFERENCES societies(id) ON DELETE CASCADE,
    bank_account_id UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
    file_name VARCHAR(191),
    bank_format VARCHAR(32),
    period_from DATE,
    period_to DATE,
    rows_total INT NOT NULL DEFAULT 0,
    rows_new INT NOT NULL DEFAULT 0,
    rows_duplicate INT NOT NULL DEFAULT 0,
    matched INT NOT NULL DEFAULT 0,
    suggested INT NOT NULL DEFAULT 0,
    uploaded_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS import_id UUID REFERENCES bank_statement_imports(id) ON DELETE SET NULL;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS line_hash TEXT;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS line_no INT;           -- position in the (chronological) upload
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS match_kind VARCHAR(16)
    CHECK (match_kind IN ('payment', 'vendor_payment', 'tds_challan', 'ignored'));
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS match_method VARCHAR(16)
    CHECK (match_method IN ('utr', 'reference', 'amount_date', 'manual', 'recorded'));
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS reconciled_vendor_payment_id UUID REFERENCES vendor_payments(id) ON DELETE SET NULL;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS reconciled_challan_id UUID REFERENCES tds_challans(id) ON DELETE SET NULL;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS suggested_kind VARCHAR(16) CHECK (suggested_kind IN ('payment', 'vendor_payment'));
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS suggested_id UUID;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS matched_by UUID REFERENCES profiles(id);
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS matched_at TIMESTAMPTZ;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS match_note TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_line_hash ON bank_transactions (bank_account_id, line_hash) WHERE line_hash IS NOT NULL;
-- One statement line per payment / vendor payment / challan
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_line_payment ON bank_transactions (reconciled_payment_id) WHERE reconciled_payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_line_vendor_payment ON bank_transactions (reconciled_vendor_payment_id) WHERE reconciled_vendor_payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_line_challan ON bank_transactions (reconciled_challan_id) WHERE reconciled_challan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bank_lines_open ON bank_transactions (society_id, transaction_date) WHERE match_kind IS NULL;

ALTER TABLE bank_statement_imports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_statement_imports_select ON bank_statement_imports;
CREATE POLICY bank_statement_imports_select ON bank_statement_imports FOR SELECT USING (
    is_platform_admin() OR is_committee_viewer(society_id) OR has_professional_permission(society_id, 'view_bank_reconciliation'));

DROP POLICY IF EXISTS bank_transactions_admin_write ON bank_transactions;
DROP POLICY IF EXISTS bank_transactions_select ON bank_transactions;
CREATE POLICY bank_transactions_select ON bank_transactions FOR SELECT USING (
    is_platform_admin() OR is_committee_viewer(society_id) OR has_professional_permission(society_id, 'view_bank_reconciliation'));

-- ============================================================================
-- MATCHING
-- ============================================================================
CREATE OR REPLACE FUNCTION public.bank_line_text(p_line bank_transactions)
RETURNS TEXT AS $$
    SELECT upper(coalesce(p_line.description, '') || ' ' || coalesce(p_line.reference_number, ''))
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.match_bank_lines(p_society_id UUID)
RETURNS JSONB AS $$
DECLARE
    r bank_transactions%ROWTYPE;
    v_text TEXT;
    v_id UUID;
    v_n INT;
    v_matched INT := 0;
    v_suggested INT := 0;
BEGIN
    FOR r IN SELECT * FROM bank_transactions WHERE society_id = p_society_id AND match_kind IS NULL ORDER BY transaction_date LOOP
        v_text := bank_line_text(r);
        v_id := NULL;

        IF r.type = 'credit' THEN
            -- Resident payment whose UTR appears in the narration
            SELECT p.id INTO v_id FROM payments p
            WHERE p.society_id = p_society_id AND p.status IN ('pending_verification', 'verified')
              AND abs(p.amount - r.amount) < 0.01 AND length(p.transaction_reference_utr) >= 6
              AND position(upper(p.transaction_reference_utr) IN v_text) > 0
              AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.reconciled_payment_id = p.id)
            ORDER BY p.payment_date LIMIT 1;
            IF v_id IS NOT NULL THEN
                UPDATE bank_transactions SET match_kind = 'payment', match_method = 'utr', reconciled_payment_id = v_id,
                       is_reconciled = true, matched_at = timezone('utc'::text, now()), suggested_kind = NULL, suggested_id = NULL
                WHERE id = r.id;
                v_matched := v_matched + 1;
                CONTINUE;
            END IF;
            -- Otherwise: one payment of the same amount within 3 days -> suggestion
            SELECT count(*), min(p.id::text)::uuid INTO v_n, v_id FROM payments p
            WHERE p.society_id = p_society_id AND p.status IN ('pending_verification', 'verified')
              AND abs(p.amount - r.amount) < 0.01 AND abs(p.payment_date - r.transaction_date) <= 3
              AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.reconciled_payment_id = p.id);
            IF v_n = 1 THEN
                UPDATE bank_transactions SET suggested_kind = 'payment', suggested_id = v_id WHERE id = r.id;
                v_suggested := v_suggested + 1;
            END IF;
        ELSE
            -- Vendor payment whose UTR / cheque reference appears in the narration
            SELECT vp.id INTO v_id FROM vendor_payments vp
            WHERE vp.society_id = p_society_id AND vp.status = 'recorded' AND abs(vp.amount - r.amount) < 0.01
              AND length(coalesce(vp.reference, '')) >= 6 AND position(upper(vp.reference) IN v_text) > 0
              AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.reconciled_vendor_payment_id = vp.id)
            ORDER BY vp.paid_on LIMIT 1;
            IF v_id IS NOT NULL THEN
                UPDATE bank_transactions SET match_kind = 'vendor_payment', match_method = 'reference', reconciled_vendor_payment_id = v_id,
                       is_reconciled = true, matched_at = timezone('utc'::text, now()), suggested_kind = NULL, suggested_id = NULL
                WHERE id = r.id;
                v_matched := v_matched + 1;
                CONTINUE;
            END IF;
            -- TDS deposit: same amount, near the date, narration names the challan or TDS
            SELECT c.id INTO v_id FROM tds_challans c
            WHERE c.society_id = p_society_id AND abs(c.amount - r.amount) < 0.01 AND abs(c.paid_on - r.transaction_date) <= 7
              AND (position(upper(c.challan_number) IN v_text) > 0 OR v_text ~ '(TDS|ITNS|CBDT|INCOME TAX|OLTAS)')
              AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.reconciled_challan_id = c.id)
            ORDER BY c.paid_on LIMIT 1;
            IF v_id IS NOT NULL THEN
                UPDATE bank_transactions SET match_kind = 'tds_challan', match_method = 'reference', reconciled_challan_id = v_id,
                       is_reconciled = true, matched_at = timezone('utc'::text, now()), suggested_kind = NULL, suggested_id = NULL
                WHERE id = r.id;
                v_matched := v_matched + 1;
                CONTINUE;
            END IF;
            SELECT count(*), min(vp.id::text)::uuid INTO v_n, v_id FROM vendor_payments vp
            WHERE vp.society_id = p_society_id AND vp.status = 'recorded' AND abs(vp.amount - r.amount) < 0.01
              AND abs(vp.paid_on - r.transaction_date) <= 5
              AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.reconciled_vendor_payment_id = vp.id);
            IF v_n = 1 THEN
                UPDATE bank_transactions SET suggested_kind = 'vendor_payment', suggested_id = v_id WHERE id = r.id;
                v_suggested := v_suggested + 1;
            END IF;
        END IF;
    END LOOP;
    RETURN jsonb_build_object('matched', v_matched, 'suggested', v_suggested);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- IMPORT (rows oldest first; the browser reverses newest-first statements)
--   p_rows: [{ "date": "2026-10-14", "value_date": null, "description": "...",
--              "reference": "...", "debit": 0, "credit": 4170, "balance": 12345.67 }]
-- ============================================================================
CREATE OR REPLACE FUNCTION public.import_bank_statement(p_bank_account_id UUID, p_file_name TEXT, p_format TEXT, p_rows JSONB)
RETURNS JSONB AS $$
DECLARE
    v_acc bank_accounts%ROWTYPE;
    v_import UUID;
    v_row JSONB;
    v_date DATE;
    v_debit NUMERIC;
    v_credit NUMERIC;
    v_desc TEXT;
    v_ref TEXT;
    v_balance NUMERIC;
    v_key TEXT;
    v_seen JSONB := '{}'::jsonb;
    v_occ INT;
    v_total INT := 0;
    v_new INT := 0;
    v_from DATE;
    v_to DATE;
    v_last_balance NUMERIC;
    v_match JSONB;
BEGIN
    SELECT * INTO v_acc FROM bank_accounts WHERE id = p_bank_account_id;
    IF NOT FOUND OR NOT (is_platform_admin() OR is_society_admin(v_acc.society_id)) THEN
        RAISE EXCEPTION 'Bank account not found';
    END IF;
    PERFORM require_feature(v_acc.society_id, 'bank_match', 'Bank statement match');
    IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
        RAISE EXCEPTION 'The statement has no transactions';
    END IF;
    IF jsonb_array_length(p_rows) > 5000 THEN
        RAISE EXCEPTION 'Upload at most 5,000 lines at a time (split the statement by month)';
    END IF;

    INSERT INTO bank_statement_imports (society_id, bank_account_id, file_name, bank_format, uploaded_by)
    VALUES (v_acc.society_id, v_acc.id, left(p_file_name, 191), left(p_format, 32), auth.uid())
    RETURNING id INTO v_import;

    FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
        v_date := (v_row ->> 'date')::date;
        v_debit := round(coalesce((v_row ->> 'debit')::numeric, 0), 2);
        v_credit := round(coalesce((v_row ->> 'credit')::numeric, 0), 2);
        v_desc := left(trim(coalesce(v_row ->> 'description', '')), 500);
        v_ref := nullif(left(trim(coalesce(v_row ->> 'reference', '')), 128), '');
        v_balance := (v_row ->> 'balance')::numeric;
        IF v_date IS NULL OR (v_debit = 0) = (v_credit = 0) OR v_debit < 0 OR v_credit < 0 THEN
            RAISE EXCEPTION 'Line % needs a date and exactly one of debit or credit', v_total + 1;
        END IF;
        v_total := v_total + 1;
        v_from := least(coalesce(v_from, v_date), v_date);
        v_to := greatest(coalesce(v_to, v_date), v_date);
        IF v_balance IS NOT NULL AND v_date >= v_to THEN
            v_last_balance := v_balance;
        END IF;

        -- Same line in a re-uploaded file gets the same hash; identical lines on a day are told apart by order
        v_key := concat_ws('|', v_date, CASE WHEN v_debit > 0 THEN 'D' ELSE 'C' END, greatest(v_debit, v_credit), lower(v_desc), coalesce(v_ref, ''), coalesce(v_balance::text, ''));
        v_occ := coalesce((v_seen ->> v_key)::int, 0) + 1;
        v_seen := v_seen || jsonb_build_object(v_key, v_occ);

        INSERT INTO bank_transactions (society_id, bank_account_id, transaction_date, value_date, description, reference_number,
                                       type, amount, running_balance, import_id, line_hash, line_no)
        VALUES (v_acc.society_id, v_acc.id, v_date, coalesce((v_row ->> 'value_date')::date, v_date), v_desc, v_ref,
                CASE WHEN v_debit > 0 THEN 'debit' ELSE 'credit' END, greatest(v_debit, v_credit), v_balance, v_import,
                sha256_hex(v_acc.id::text || '|' || v_key || '|' || v_occ), v_total)
        ON CONFLICT (bank_account_id, line_hash) WHERE line_hash IS NOT NULL DO NOTHING;
        IF FOUND THEN
            v_new := v_new + 1;
        END IF;
    END LOOP;

    IF v_last_balance IS NOT NULL THEN
        UPDATE bank_accounts SET current_balance = v_last_balance WHERE id = v_acc.id;
    END IF;
    v_match := match_bank_lines(v_acc.society_id);

    UPDATE bank_statement_imports
    SET period_from = v_from, period_to = v_to, rows_total = v_total, rows_new = v_new, rows_duplicate = v_total - v_new,
        matched = (v_match ->> 'matched')::int, suggested = (v_match ->> 'suggested')::int
    WHERE id = v_import;

    INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (v_acc.society_id, auth.uid(), 'bank.statement_imported', 'bank_statement_import', v_import::text,
            jsonb_build_object('file', p_file_name, 'lines', v_total, 'new', v_new, 'matched', v_match ->> 'matched'));
    RETURN jsonb_build_object('import_id', v_import, 'rows', v_total, 'new', v_new, 'duplicates', v_total - v_new,
                              'matched', (v_match ->> 'matched')::int, 'suggested', (v_match ->> 'suggested')::int,
                              'from', v_from, 'to', v_to);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- COMMITTEE ACTIONS
-- ============================================================================
CREATE OR REPLACE FUNCTION public.bank_line_for_update(p_line_id UUID)
RETURNS bank_transactions AS $$
DECLARE
    v_line bank_transactions%ROWTYPE;
BEGIN
    SELECT * INTO v_line FROM bank_transactions WHERE id = p_line_id FOR UPDATE;
    IF NOT FOUND OR NOT (is_platform_admin() OR is_society_admin(v_line.society_id)) THEN
        RAISE EXCEPTION 'Statement line not found';
    END IF;
    RETURN v_line;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.link_bank_line(p_line_id UUID, p_kind TEXT, p_target_id UUID, p_note TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    v_line bank_transactions;
    v_amount NUMERIC;
BEGIN
    v_line := bank_line_for_update(p_line_id);
    IF v_line.match_kind IS NOT NULL THEN
        RAISE EXCEPTION 'This line is already matched — unlink it first';
    END IF;
    IF p_kind = 'payment' THEN
        IF v_line.type <> 'credit' THEN RAISE EXCEPTION 'A resident payment matches money coming in'; END IF;
        SELECT amount INTO v_amount FROM payments WHERE id = p_target_id AND society_id = v_line.society_id
          AND status IN ('pending_verification', 'verified');
    ELSIF p_kind = 'vendor_payment' THEN
        IF v_line.type <> 'debit' THEN RAISE EXCEPTION 'A vendor payment matches money going out'; END IF;
        SELECT amount INTO v_amount FROM vendor_payments WHERE id = p_target_id AND society_id = v_line.society_id AND status = 'recorded';
    ELSIF p_kind = 'tds_challan' THEN
        IF v_line.type <> 'debit' THEN RAISE EXCEPTION 'A TDS deposit matches money going out'; END IF;
        SELECT amount INTO v_amount FROM tds_challans WHERE id = p_target_id AND society_id = v_line.society_id;
    ELSE
        RAISE EXCEPTION 'Unknown match type %', p_kind;
    END IF;
    IF v_amount IS NULL THEN
        RAISE EXCEPTION 'That record was not found';
    END IF;
    IF abs(v_amount - v_line.amount) >= 0.01 THEN
        RAISE EXCEPTION 'Amounts differ (₹% in the bank, ₹% in the books)', v_line.amount, v_amount;
    END IF;

    UPDATE bank_transactions
    SET match_kind = p_kind, match_method = 'manual', is_reconciled = true,
        reconciled_payment_id = CASE WHEN p_kind = 'payment' THEN p_target_id END,
        reconciled_vendor_payment_id = CASE WHEN p_kind = 'vendor_payment' THEN p_target_id END,
        reconciled_challan_id = CASE WHEN p_kind = 'tds_challan' THEN p_target_id END,
        suggested_kind = NULL, suggested_id = NULL, matched_by = auth.uid(), matched_at = timezone('utc'::text, now()),
        match_note = nullif(trim(coalesce(p_note, '')), '')
    WHERE id = p_line_id;
    RETURN jsonb_build_object('status', 'matched');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.confirm_bank_suggestion(p_line_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_line bank_transactions;
BEGIN
    v_line := bank_line_for_update(p_line_id);
    IF v_line.suggested_id IS NULL THEN
        RAISE EXCEPTION 'No suggestion on this line';
    END IF;
    RETURN link_bank_line(p_line_id, v_line.suggested_kind, v_line.suggested_id, 'Suggested match confirmed');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.ignore_bank_line(p_line_id UUID, p_note TEXT)
RETURNS JSONB AS $$
BEGIN
    PERFORM bank_line_for_update(p_line_id);
    IF length(trim(coalesce(p_note, ''))) < 3 THEN
        RAISE EXCEPTION 'Say why (e.g. bank interest, transfer between our accounts)';
    END IF;
    UPDATE bank_transactions SET match_kind = 'ignored', match_method = 'manual', is_reconciled = true, suggested_kind = NULL,
           suggested_id = NULL, matched_by = auth.uid(), matched_at = timezone('utc'::text, now()), match_note = trim(p_note)
    WHERE id = p_line_id;
    RETURN jsonb_build_object('status', 'ignored');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.unlink_bank_line(p_line_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_line bank_transactions;
BEGIN
    v_line := bank_line_for_update(p_line_id);
    IF v_line.match_method = 'recorded' THEN
        RAISE EXCEPTION 'This payment was recorded from the statement; void or reject it in Payments instead';
    END IF;
    UPDATE bank_transactions SET match_kind = NULL, match_method = NULL, is_reconciled = false, reconciled_payment_id = NULL,
           reconciled_vendor_payment_id = NULL, reconciled_challan_id = NULL, matched_by = NULL, matched_at = NULL, match_note = NULL
    WHERE id = p_line_id;
    RETURN jsonb_build_object('status', 'open');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Resident UTRs found in the statement: verify them all (receipts are issued as usual)
CREATE OR REPLACE FUNCTION public.verify_matched_payments(p_society_id UUID)
RETURNS JSONB AS $$
DECLARE
    r RECORD;
    v_ids UUID[] := '{}';
BEGIN
    IF NOT (is_platform_admin() OR is_society_admin(p_society_id)) THEN
        RAISE EXCEPTION 'Only the society committee can verify payments';
    END IF;
    FOR r IN
        SELECT p.id, b.transaction_date FROM bank_transactions b JOIN payments p ON p.id = b.reconciled_payment_id
        WHERE b.society_id = p_society_id AND p.status = 'pending_verification'
        ORDER BY b.transaction_date
    LOOP
        PERFORM verify_payment(r.id, true, 'Found in bank statement of ' || to_char(r.transaction_date, 'DD Mon YYYY'));
        v_ids := v_ids || r.id;
    END LOOP;
    RETURN jsonb_build_object('verified', cardinality(v_ids), 'payment_ids', to_jsonb(v_ids));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Money came in without a UTR submission: record it as that flat's payment and verify it
CREATE OR REPLACE FUNCTION public.record_bank_receipt(p_line_id UUID, p_unit_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_line bank_transactions;
    v_unit units%ROWTYPE;
    v_owner UUID;
    v_utr TEXT;
    v_payment UUID;
    v_result JSONB;
BEGIN
    v_line := bank_line_for_update(p_line_id);
    IF v_line.type <> 'credit' OR v_line.match_kind IS NOT NULL THEN
        RAISE EXCEPTION 'Only an unmatched credit can be recorded as a payment';
    END IF;
    SELECT * INTO v_unit FROM units WHERE id = p_unit_id AND society_id = v_line.society_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Flat not found';
    END IF;
    SELECT m.user_id INTO v_owner FROM society_memberships m
    WHERE m.society_id = v_line.society_id AND m.unit_id = p_unit_id AND m.role = 'resident_owner' AND m.is_active
    ORDER BY m.created_at LIMIT 1;
    v_owner := coalesce(v_owner, v_unit.current_owner_id);
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Flat % has no owner linked yet — invite the owner first', v_unit.unit_number;
    END IF;

    v_utr := coalesce(substring(bank_line_text(v_line) FROM '([0-9]{12})'), v_line.reference_number, 'BANK-' || left(v_line.id::text, 8));
    INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, payment_method, transaction_reference_utr,
                          payment_date, status, bank_account_id)
    VALUES (v_line.society_id, p_unit_id, v_owner, 'BNK-' || to_char(v_line.transaction_date, 'YYYYMMDD') || '-' || left(md5(v_line.id::text), 6),
            v_line.amount, CASE WHEN bank_line_text(v_line) ~ 'UPI' THEN 'upi' ELSE 'neft_rtgs' END, v_utr,
            v_line.transaction_date, 'pending_verification', v_line.bank_account_id)
    RETURNING id INTO v_payment;
    v_result := verify_payment(v_payment, true, 'Received in bank; recorded by the committee from the statement');

    UPDATE bank_transactions
    SET match_kind = 'payment', match_method = 'recorded', is_reconciled = true, reconciled_payment_id = v_payment,
        suggested_kind = NULL, suggested_id = NULL, matched_by = auth.uid(), matched_at = timezone('utc'::text, now()),
        match_note = 'Recorded for flat ' || v_unit.unit_number
    WHERE id = p_line_id;
    RETURN v_result || jsonb_build_object('payment_id', v_payment);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.bank_reconciliation_summary(p_bank_account_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_acc bank_accounts%ROWTYPE;
    v_book NUMERIC;
    v_statement NUMERIC;
    v_statement_date DATE;
BEGIN
    SELECT * INTO v_acc FROM bank_accounts WHERE id = p_bank_account_id;
    IF NOT FOUND OR NOT (is_platform_admin() OR is_committee_viewer(v_acc.society_id)
                         OR has_professional_permission(v_acc.society_id, 'view_bank_reconciliation')) THEN
        RAISE EXCEPTION 'Bank account not found';
    END IF;
    SELECT running_balance, transaction_date INTO v_statement, v_statement_date FROM bank_transactions
    WHERE bank_account_id = p_bank_account_id AND running_balance IS NOT NULL
    ORDER BY transaction_date DESC, created_at DESC, line_no DESC NULLS LAST LIMIT 1;
    SELECT coalesce(sum(l.amount), 0) INTO v_book FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
    WHERE l.society_id = v_acc.society_id AND a.code = '1000' AND (v_statement_date IS NULL OR l.date <= v_statement_date);

    RETURN (SELECT jsonb_build_object(
        'statement_balance', v_statement, 'statement_date', v_statement_date, 'book_balance', v_book,
        'lines', count(*),
        'matched', count(*) FILTER (WHERE match_kind IN ('payment', 'vendor_payment', 'tds_challan')),
        'ignored', count(*) FILTER (WHERE match_kind = 'ignored'),
        'suggested', count(*) FILTER (WHERE match_kind IS NULL AND suggested_id IS NOT NULL),
        'open_credits', count(*) FILTER (WHERE match_kind IS NULL AND type = 'credit'),
        'open_credit_total', coalesce(sum(amount) FILTER (WHERE match_kind IS NULL AND type = 'credit'), 0),
        'open_debits', count(*) FILTER (WHERE match_kind IS NULL AND type = 'debit'),
        'open_debit_total', coalesce(sum(amount) FILTER (WHERE match_kind IS NULL AND type = 'debit'), 0),
        'ready_to_verify', (SELECT count(*) FROM bank_transactions b JOIN payments p ON p.id = b.reconciled_payment_id
                            WHERE b.bank_account_id = p_bank_account_id AND p.status = 'pending_verification')
    ) FROM bank_transactions WHERE bank_account_id = p_bank_account_id);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- PRIVILEGES
-- ============================================================================
REVOKE ALL ON FUNCTION public.match_bank_lines(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bank_line_for_update(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.import_bank_statement(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.link_bank_line(UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.confirm_bank_suggestion(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ignore_bank_line(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unlink_bank_line(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.verify_matched_payments(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_bank_receipt(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_reconciliation_summary(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_bank_statement(UUID, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.link_bank_line(UUID, TEXT, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_bank_suggestion(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ignore_bank_line(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlink_bank_line(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_matched_payments(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_bank_receipt(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_summary(UUID) TO authenticated;
