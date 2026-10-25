import type { ProfessionalRole } from '../types/database';

/** Must match valid_professional_permissions() in 009_professional.sql and the RLS checks. */
export const PROFESSIONAL_PERMISSIONS = [
  { key: 'view_reports', label: 'Financial reports', hint: 'I&E, balance sheet, trial balance, dues' },
  { key: 'view_ledger', label: 'Ledger & journals', hint: 'Every double-entry posting' },
  { key: 'view_expenses', label: 'Expenses & vendors', hint: 'Vendor bills, approvals, TDS' },
  { key: 'audit_gst', label: 'GST (GSTR-2B)', hint: 'Upload 2B and reconcile ITC' },
  { key: 'view_bills', label: 'Maintenance bills', hint: 'Member-wise bills' },
  { key: 'view_payments', label: 'Payments & receipts', hint: 'UTRs and receipts' },
  { key: 'view_bank_reconciliation', label: 'Bank accounts', hint: 'Bank balances and statements' },
  { key: 'view_documents', label: 'Documents vault', hint: 'Bye-laws, minutes, audit reports' },
  { key: 'view_units', label: 'Flats register', hint: 'Units and occupancy' },
  { key: 'view_audit_logs', label: 'Audit trail', hint: 'Who changed what' },
] as const;

export type ProfessionalPermission = (typeof PROFESSIONAL_PERMISSIONS)[number]['key'];

export const PROFESSIONAL_ROLES: { value: ProfessionalRole; label: string }[] = [
  { value: 'ca', label: 'Chartered Accountant' },
  { value: 'auditor', label: 'Statutory Auditor' },
  { value: 'accountant', label: 'Accountant / Bookkeeper' },
  { value: 'gst_consultant', label: 'GST Consultant' },
  { value: 'tax_consultant', label: 'Tax Consultant' },
  { value: 'financial_consultant', label: 'Financial Consultant' },
];

/** Sensible defaults per role; the committee can still tick/untick. */
export const ROLE_PRESETS: Record<ProfessionalRole, ProfessionalPermission[]> = {
  ca: ['view_reports', 'view_ledger', 'view_expenses', 'audit_gst', 'view_bills', 'view_payments', 'view_documents'],
  auditor: ['view_reports', 'view_ledger', 'view_expenses', 'view_bills', 'view_payments', 'view_bank_reconciliation', 'view_documents', 'view_units', 'view_audit_logs'],
  accountant: ['view_reports', 'view_ledger', 'view_expenses', 'view_bills', 'view_payments'],
  gst_consultant: ['audit_gst', 'view_expenses'],
  tax_consultant: ['view_reports', 'view_expenses'],
  financial_consultant: ['view_reports'],
};

export const permissionLabel = (key: string) => PROFESSIONAL_PERMISSIONS.find(p => p.key === key)?.label ?? key;
export const roleLabel = (role: string) => PROFESSIONAL_ROLES.find(r => r.value === role)?.label ?? role;
