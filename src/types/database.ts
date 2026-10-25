/**
 * Database Entity Types & Multi-Tenant Schema Definitions
 * Housing Society Management & Operations Platform (Sahvaas)
 */

export type PlatformRole = 'super_admin' | 'platform_support' | 'billing_admin';

export type SocietyRole = 
  | 'society_admin'
  | 'secretary'
  | 'chairman'
  | 'treasurer'
  | 'committee_member'
  | 'resident_owner'
  | 'resident_tenant';

export type ProfessionalRole = 
  | 'ca'
  | 'auditor'
  | 'accountant'
  | 'tax_consultant'
  | 'gst_consultant'
  | 'financial_consultant';

export type ProfessionalAccessStatus = 'pending' | 'active' | 'expired' | 'revoked';

export type UnitOccupancyStatus = 'owner_occupied' | 'tenant_occupied' | 'vacant' | 'under_renovation';

export type BillStatus = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'overdue' | 'cancelled';

export type PaymentStatus = 'pending_verification' | 'verified' | 'rejected' | 'refunded';

export type ExpenseStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'paid' | 'voided';

export type ComplaintStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type ComplaintPriority = 'low' | 'medium' | 'high' | 'urgent';

/* =========================================================
 * 1. PLATFORM ENTITIES
 * ========================================================= */
export interface PlatformAdmin {
  id: string;
  user_id: string;
  role: PlatformRole;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PlatformSetting {
  id: string;
  key: string;
  value: Record<string, unknown>;
  description?: string;
  updated_at: string;
}

export interface PlatformFeature {
  id: string;
  feature_key: string;
  name: string;
  description: string;
  is_globally_enabled: boolean;
  min_plan_tier: string;
  created_at: string;
}

export interface SupportAccessSession {
  id: string;
  platform_admin_id: string;
  society_id: string;
  reason: string;
  started_at: string;
  expires_at: string;
  is_revoked: boolean;
}

/* =========================================================
 * 2. SOCIETY HIERARCHY
 * ========================================================= */
export interface Society {
  id: string;
  name: string;
  slug: string;
  registration_number?: string;
  gstin?: string;
  address_line1: string;
  address_line2?: string;
  city: string;
  state: string;
  pincode: string;
  total_units: number;
  contact_email: string;
  contact_phone: string;
  is_active: boolean;
  subscription_status: 'trial' | 'active' | 'suspended' | 'cancelled';
  created_at: string;
  updated_at: string;
}

export interface SocietySetting {
  id: string;
  society_id: string;
  due_day_of_month: number;
  late_fee_type: 'flat' | 'percentage' | 'none';
  late_fee_amount: number;
  currency: string;
  upi_id?: string;
  upi_payee_name?: string;
  qr_code_url?: string;
  fiscal_year_start_month: number;
  require_two_step_expense_approval: boolean;
  created_at: string;
  updated_at: string;
}

export interface Building {
  id: string;
  society_id: string;
  name: string;
  code: string;
  total_floors: number;
  created_at: string;
}

export interface Wing {
  id: string;
  society_id: string;
  building_id: string;
  name: string;
  created_at: string;
}

export interface Floor {
  id: string;
  society_id: string;
  wing_id: string;
  floor_number: number;
  created_at: string;
}

export interface Unit {
  id: string;
  society_id: string;
  building_id: string;
  wing_id: string;
  floor_id?: string;
  unit_number: string;
  unit_type: '1BHK' | '2BHK' | '3BHK' | '4BHK' | 'Penthouse' | 'Shop' | 'Office';
  carpet_area_sqft: number;
  super_builtup_sqft?: number;
  occupancy_status: UnitOccupancyStatus;
  current_owner_id?: string;
  current_tenant_id?: string;
  created_at: string;
  updated_at: string;
}

export interface ParkingSlot {
  id: string;
  society_id: string;
  slot_number: string;
  slot_type: 'covered_4w' | 'open_4w' | '2w' | 'ev';
  assigned_unit_id?: string;
  created_at: string;
}

/* =========================================================
 * 3. USERS, MEMBERSHIPS & PERMISSIONS
 * ========================================================= */
export interface Profile {
  id: string; // matches auth.users.id
  full_name: string;
  email: string;
  phone?: string;
  avatar_url?: string;
  is_platform_admin: boolean;
  created_at: string;
  updated_at: string;
}

export interface SocietyMembership {
  id: string;
  society_id: string;
  user_id: string;
  role: SocietyRole;
  unit_id?: string;
  is_primary_contact: boolean;
  is_active: boolean;
  joined_date: string;
  created_at: string;
  updated_at: string;
}

export type MemberInviteStatus = 'pending' | 'accepted' | 'revoked';

export interface MemberInvite {
  id: string;
  society_id: string;
  email: string;
  full_name?: string;
  role: SocietyRole;
  unit_id?: string | null;
  invited_by: string;
  status: MemberInviteStatus;
  accepted_user_id?: string | null;
  accepted_at?: string | null;
  created_at: string;
}

/** Row shape accepted by the bulk_upsert_units RPC */
export interface UnitImportRow {
  building?: string;
  wing?: string;
  floor?: number | null;
  unit_number: string;
  unit_type?: string;
  carpet_area_sqft?: number;
  occupancy_status?: UnitOccupancyStatus;
}

export interface Permission {
  id: string;
  key: string;
  name: string;
  module: 'finances' | 'billing' | 'members' | 'operations' | 'documents' | 'gst' | 'settings';
  description: string;
}

export interface RolePermission {
  role: SocietyRole | ProfessionalRole;
  permission_key: string;
}

export interface FamilyMember {
  id: string;
  society_id: string;
  unit_id: string;
  primary_user_id: string;
  full_name: string;
  relationship: string;
  phone?: string;
  is_emergency_contact: boolean;
  created_at: string;
}

export interface Vehicle {
  id: string;
  society_id: string;
  unit_id: string;
  user_id: string;
  vehicle_type: '2_wheeler' | '4_wheeler' | 'commercial';
  registration_number: string;
  parking_slot_id?: string;
  tag_rfid?: string;
  created_at: string;
}

/* =========================================================
 * 4. PROFESSIONALS ACCESS MODEL
 * ========================================================= */
export interface ProfessionalProfile {
  id: string;
  user_id: string;
  firm_name: string;
  profession: ProfessionalRole;
  membership_number?: string; // ICAI / ICWAI / Bar Council #
  gstin?: string;
  verified: boolean;
  created_at: string;
}

export interface SocietyProfessionalAccess {
  id: string;
  society_id: string;
  professional_user_id: string;
  role: ProfessionalRole;
  status: ProfessionalAccessStatus;
  permissions: string[]; // e.g., ['view_reports', 'view_ledger', 'reconcile_bank', 'audit_gst']
  granted_by: string; // society_admin user_id
  granted_at: string;
  expires_at?: string;
  revoked_at?: string;
  revocation_reason?: string;
  notes?: string;
}

export interface ProfessionalInvite {
  id: string;
  society_id: string;
  invited_email: string;
  role: ProfessionalRole;
  permissions: string[];
  invited_by: string;
  invitation_token: string;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  expires_at: string;
  created_at: string;
}

export interface AccessLog {
  id: string;
  society_id: string;
  professional_user_id: string;
  module_accessed: string;
  action_performed: string;
  ip_address?: string;
  created_at: string;
}

/* =========================================================
 * 5. BILLING & PAYMENTS
 * ========================================================= */
export interface BillingRule {
  id: string;
  society_id: string;
  name: string;
  description?: string;
  calculation_type: 'flat_per_unit' | 'per_sqft' | 'metered' | 'manual';
  rate: number;
  applies_to_unit_type?: string;
  tax_rate_percent: number;
  hsn_sac_code?: string;
  /** Account credited when billed (DB check: 4000 | 4200 | 3000 | 3100 | 3200) */
  account_code: '4000' | '4200' | '3000' | '3100' | '3200';
  is_active: boolean;
  created_at: string;
}

export interface BillingCycle {
  id: string;
  society_id: string;
  cycle_name: string; // e.g., "October 2026 Maintenance"
  period_start: string;
  period_end: string;
  due_date: string;
  status: 'draft' | 'generated' | 'published';
  created_at: string;
}

export interface Bill {
  id: string;
  society_id: string;
  cycle_id: string;
  unit_id: string;
  user_id: string;
  bill_number: string;
  bill_date: string;
  due_date: string;
  subtotal_amount: number;
  tax_amount: number;
  interest_or_late_fee: number;
  total_amount: number;
  amount_paid: number;
  balance_due: number;
  status: BillStatus;
  late_fee_applied_at?: string | null;
  /** Arrears carried in from before Sahvaas (posted via opening balances, not as income) */
  is_opening_balance?: boolean;
  created_at: string;
  updated_at: string;
}

export interface PaymentAllocation {
  id: string;
  society_id: string;
  payment_id: string;
  bill_id: string;
  amount: number;
  created_at: string;
}

/** Response of the generate_bills RPC */
export interface GenerateBillsResult {
  cycle_id: string | null;
  cycle_name: string;
  dry_run: boolean;
  bills: number;
  total_amount: number;
  skipped_units: { unit_number: string; reason: string }[];
  preview: { unit_number: string; wing: string; subtotal: number; tax: number; total: number }[];
}

export interface BillItem {
  id: string;
  bill_id: string;
  rule_id?: string;
  description: string;
  quantity: number;
  unit_rate: number;
  amount: number;
  tax_rate: number;
  tax_amount: number;
  total_item_amount: number;
}

export interface BankAccount {
  id: string;
  society_id: string;
  bank_name: string;
  account_number: string;
  ifsc_code: string;
  branch_name: string;
  account_type: 'current' | 'savings' | 'fd';
  opening_balance: number;
  current_balance: number;
  is_primary: boolean;
  created_at: string;
}

export interface Payment {
  id: string;
  society_id: string;
  unit_id: string;
  user_id: string;
  bill_id?: string;
  payment_number: string;
  amount: number;
  payment_method: 'upi' | 'neft_rtgs' | 'cheque' | 'cash';
  transaction_reference_utr: string;
  payment_date: string;
  status: PaymentStatus;
  bank_account_id?: string;
  verification_notes?: string;
  verified_by?: string;
  verified_at?: string;
  receipt_number?: string;
  receipt_url?: string;
  created_at: string;
}

export interface BankTransaction {
  id: string;
  society_id: string;
  bank_account_id: string;
  transaction_date: string;
  value_date: string;
  description: string;
  reference_number?: string;
  type: 'credit' | 'debit';
  amount: number;
  running_balance?: number;
  is_reconciled: boolean;
  reconciled_payment_id?: string;
  reconciled_expense_id?: string;
  created_at: string;
}

/* =========================================================
 * 6. EXPENSES & VENDORS
 * ========================================================= */
export interface Vendor {
  id: string;
  society_id: string;
  name: string;
  category: 'security' | 'housekeeping' | 'lift_amc' | 'generator' | 'gardening' | 'electrical' | 'plumbing' | 'legal_audit' | 'other';
  contact_person?: string;
  phone: string;
  email?: string;
  gstin?: string;
  pan?: string;
  bank_name?: string;
  account_number?: string;
  ifsc?: string;
  tds_override_rate?: number | null;
  tds_certificate_no?: string | null;
  tds_override_valid_till?: string | null;
  created_at: string;
}

export type TdsNature = 'none' | 'goods' | 'contract' | 'professional' | 'technical' | 'rent_building' | 'rent_machinery';
export type AssetAccountCode = '1500' | '1510' | '1520' | '1530' | '1540' | '1550';

export interface ExpenseCategory {
  id: string;
  society_id: string | null; // null = Sahvaas default
  key: string;
  label: string;
  account_code: string;
  asset_account_code: AssetAccountCode | null;
  asset_threshold: number | null;
  tds_nature: TdsNature;
  sort_order: number;
  is_active: boolean;
}

export interface TdsRule {
  id: string;
  nature: Exclude<TdsNature, 'none' | 'goods'>;
  label: string;
  section_label: string;
  rate_individual: number;
  rate_other: number;
  single_bill_limit: number | null;
  annual_limit: number | null;
  effective_from: string;
  is_active: boolean;
}

/** Result of suggest_tds() (013). */
export interface TdsSuggestion {
  applies: boolean;
  nature: TdsNature;
  section?: string;
  label?: string;
  rate: number;
  amount: number;
  base?: number;
  rule_id?: string;
  pan?: string | null;
  entity?: 'individual' | 'other' | null;
  rate_source?: 'individual' | 'other' | 'no_pan' | 'certificate';
  reason: 'no_category' | 'no_tds' | 'goods' | 'no_rule' | 'below_limits' | 'single_bill' | 'annual_total';
  fy_total?: number;
  single_limit?: number | null;
  annual_limit?: number | null;
}

export interface VendorPayment {
  id: string;
  society_id: string;
  expense_id: string;
  payment_number: string;
  paid_on: string;
  amount: number;
  tds_amount: number;
  mode: 'neft' | 'upi' | 'cheque' | 'cash';
  reference?: string | null;
  proof_url?: string | null;
  status: 'recorded' | 'voided';
  created_at: string;
}

export interface FixedAsset {
  id: string;
  society_id: string;
  asset_number: string;
  name: string;
  account_code: AssetAccountCode;
  expense_id?: string | null;
  vendor_id?: string | null;
  put_to_use_date: string;
  cost: number;
  opening_wdv?: number | null;
  opening_as_of?: string | null;
  location?: string | null;
  funded_from: 'general' | 'sinking_fund' | 'repair_fund';
  dep_method: 'wdv' | 'slm';
  dep_rate: number;
  status: 'active' | 'disposed' | 'voided';
  disposed_on?: string | null;
  disposal_amount?: number | null;
  created_at: string;
}

export interface DepreciationPreviewRow {
  asset_id: string;
  asset_number: string;
  name: string;
  account_code: AssetAccountCode;
  put_to_use_date: string;
  opening_wdv: number;
  additions: number;
  rate: number;
  half_rate: boolean;
  depreciation: number;
  closing_wdv: number;
}

export interface Expense {
  id: string;
  society_id: string;
  vendor_id?: string;
  expense_number: string;
  category: string;
  title: string;
  description?: string;
  invoice_number?: string;
  invoice_date?: string;
  subtotal: number;
  gst_amount: number;
  tds_amount: number;
  net_payable: number;
  status: ExpenseStatus;
  payment_status: 'unpaid' | 'partial' | 'paid';
  approved_by?: string;
  approved_at?: string;
  paid_date?: string;
  payment_reference?: string;
  document_url?: string;
  created_by?: string | null;
  // 013 accounting
  expense_type: 'revenue' | 'capital';
  asset_account_code?: AssetAccountCode | null;
  asset_location?: string | null;
  funded_from: 'general' | 'sinking_fund' | 'repair_fund';
  gst_claimable: boolean;
  tds_nature?: TdsNature | null;
  tds_section?: string | null;
  tds_rate?: number | null;
  tds_rule_id?: string | null;
  tds_suggested?: number | null;
  tds_override_reason?: string | null;
  invoice_status: 'invoice' | 'pending' | 'none';
  invoice_due_by?: string | null;
  voucher_number?: string | null;
  payee_name?: string | null;
  payee_phone?: string | null;
  extraction?: Record<string, unknown> | null;
  amount_settled: number;
  tds_deducted: number;
  created_at: string;
  updated_at: string;
}

export interface ExpenseApproval {
  id: string;
  society_id: string;
  expense_id: string;
  approver_id: string;
  decision: 'approved' | 'rejected';
  notes?: string | null;
  created_at: string;
}

/* =========================================================
 * 7. FINANCIAL ENGINE (AUTOMATED BEHIND REAL-WORLD EVENTS)
 * ========================================================= */
export interface Account {
  id: string;
  society_id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  parent_id?: string;
  is_system: boolean;
  created_at: string;
}

export interface JournalEntry {
  id: string;
  society_id: string;
  entry_number: string;
  entry_date: string;
  reference_event_type: 'bill_generated' | 'payment_verified' | 'expense_approved' | 'expense_paid' | 'fund_transfer';
  reference_event_id: string;
  narration: string;
  is_posted: boolean;
  created_at: string;
}

export interface LedgerEntry {
  id: string;
  society_id: string;
  account_id: string;
  journal_entry_id: string;
  date: string;
  amount: number; // positive = debit, negative = credit
  balance_after: number;
  narration: string;
  created_at: string;
}

export interface Fund {
  id: string;
  society_id: string;
  name: string; // e.g. "Sinking Fund", "Repair Fund", "Reserve Fund"
  purpose: string;
  target_balance?: number;
  current_balance: number;
  bank_account_id?: string;
  created_at: string;
}

/* =========================================================
 * 8. GST (MVP WORKFLOW: GSTR-2B EXCEL/JSON UPLOAD & RECONCILIATION)
 * ========================================================= */
export interface GSTProfile {
  id: string;
  society_id: string;
  gstin: string;
  legal_name: string;
  trade_name: string;
  filing_frequency: 'monthly' | 'quarterly';
  is_composition: boolean;
  created_at: string;
}

export interface GST2BUpload {
  id: string;
  society_id: string;
  return_period: string; // e.g., "102026"
  file_name: string;
  file_format: 'json' | 'excel';
  uploaded_by: string;
  uploaded_at: string;
  total_invoices_found: number;
  total_taxable_value: number;
  total_igst: number;
  total_cgst: number;
  total_sgst: number;
  reconciliation_status: 'pending' | 'in_progress' | 'completed';
}

export interface GST2BInvoice {
  id: string;
  upload_id: string;
  society_id: string;
  supplier_gstin: string;
  supplier_trade_name: string;
  invoice_number: string;
  invoice_type: string;
  invoice_date: string;
  invoice_value: number;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  itc_availability: 'Y' | 'N';
  reconciliation_match_status: 'exact_match' | 'partial_match' | 'missing_in_books' | 'missing_in_2b';
}

export interface GSTReconciliation {
  id: string;
  society_id: string;
  period: string;
  total_books_invoices: number;
  total_portal_invoices: number;
  matched_count: number;
  mismatched_count: number;
  reviewed_by?: string;
  reviewed_at?: string;
  review_notes?: string;
  created_at: string;
}

/* =========================================================
 * 9. NOTICES, COMPLAINTS & COMMUNITY
 * ========================================================= */
export interface Notice {
  id: string;
  society_id: string;
  title: string;
  content: string;
  category: 'general' | 'agm_egm' | 'maintenance' | 'water_power' | 'emergency';
  is_pinned: boolean;
  published_by: string;
  published_at: string;
  expires_at?: string;
  attachment_url?: string;
  target_audience: 'all' | 'owners_only' | 'tenants_only' | 'committee_only';
}

export interface Complaint {
  id: string;
  society_id: string;
  unit_id: string;
  user_id: string;
  ticket_number: string;
  category: 'plumbing' | 'electricity' | 'lift' | 'security' | 'cleanliness' | 'parking' | 'noise' | 'other';
  title: string;
  description: string;
  priority: ComplaintPriority;
  status: ComplaintStatus;
  assigned_to?: string;
  resolved_at?: string;
  resolution_notes?: string;
  created_at: string;
  updated_at: string;
}

export interface ComplaintUpdate {
  id: string;
  society_id: string;
  complaint_id: string;
  author_id: string;
  message: string;
  created_at: string;
}

export interface Document {
  id: string;
  society_id: string;
  category: 'bylaws' | 'conveyance' | 'audit_reports' | 'agm_minutes' | 'insurance' | 'noc_forms' | 'financials';
  title: string;
  description?: string;
  file_url: string;
  file_size_kb: number;
  uploaded_by: string;
  is_restricted_to_committee: boolean;
  created_at: string;
}

/* =========================================================
 * 10. AUDIT LOGS, SUBSCRIPTIONS & PLATFORM USAGE
 * ========================================================= */
export interface AuditLog {
  id: string;
  society_id?: string;
  user_id: string;
  user_name?: string;
  action: string;
  entity_type: string;
  entity_id: string;
  old_value?: Record<string, unknown>;
  new_value?: Record<string, unknown>;
  reason?: string;
  ip_address?: string;
  timestamp: string;
}

export type PlanFeature = 'ca_portal' | 'asset_register' | 'gst_recon' | 'tds_register' | 'bank_match' | 'tally_export';

export interface SubscriptionPlan {
  id: string;
  name: string;
  tier_code: 'free' | 'basic' | 'pro' | 'starter' | 'growth' | 'enterprise';
  monthly_rate_per_unit_inr: number;
  max_units: number;
  features_included: string[];
  feature_keys: PlanFeature[];
  show_ads: boolean;
  storage_mb: number;
  sort_order: number;
  description: string | null;
  is_active: boolean;
}

export interface Subscription {
  id: string;
  society_id: string;
  plan_id: string;
  billing_term: 'monthly' | 'annual';
  status: 'trial' | 'active' | 'past_due' | 'suspended';
  current_period_start: string;
  current_period_end: string | null;
  trial_ends_on: string | null;
  next_plan_id: string | null;
  unit_count: number;
  auto_renew: boolean;
}

/** society_plan() (015) */
export interface SocietyPlan {
  plan_code: 'trial' | 'free' | 'basic' | 'pro';
  paid_plan_code: string;
  plan_name: string;
  status: Subscription['status'];
  in_trial: boolean;
  trial_ends_on: string | null;
  term: 'monthly' | 'annual';
  period_start: string | null;
  period_end: string | null;
  next_plan_code: string | null;
  features: PlanFeature[];
  show_ads: boolean;
  open_invoice: {
    id: string; invoice_number: string; total: number; kind: 'new' | 'renewal' | 'upgrade';
    issued_on: string; due_on: string; period_start: string; period_end: string; overdue: boolean; moves_to_free_on: string | null;
  } | null;
}

/** subscription_quote() (015) */
export interface PlanQuote {
  plan_code: string; plan_name: string; term: 'monthly' | 'annual';
  units: number; billable_units: number; min_billable: number; rate: number; months_charged: number; period_months: number;
  gross: number; discount: number; discount_percent: number; taxable: number; gst_rate: number; gst: number; total: number;
  monthly_equivalent: number; savings_vs_monthly: number; free_months: number;
}

export interface PlatformInvoice {
  id: string;
  invoice_number: string;
  society_id: string;
  plan_code: string;
  billing_term: 'monthly' | 'annual';
  kind: 'new' | 'renewal' | 'upgrade';
  period_start: string;
  period_end: string;
  billable_units: number;
  rate: number;
  months_charged: number;
  gross: number;
  discount: number;
  taxable: number;
  gst_rate: number;
  gst_amount: number;
  total: number;
  seller: { name?: string; gstin?: string; address?: string; state?: string; sac?: string };
  bill_to: { name?: string; gstin?: string | null; address?: string; state?: string };
  status: 'issued' | 'paid' | 'void';
  issued_on: string;
  due_on: string;
  paid_on: string | null;
  payment_method: 'gateway' | 'neft' | 'complimentary' | null;
  payment_reference: string | null;
}

export interface UsageMetric {
  id: string;
  society_id: string;
  metric_month: string;
  active_members_count: number;
  bills_issued: number;
  payments_processed: number;
  storage_bytes_used: number;
  ai_tokens_consumed: number;
  api_requests_count: number;
  updated_at: string;
}
