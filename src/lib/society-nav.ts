// The secretary's menu (Phase 2D): the accounting screens live in the CA login, and in an
// "Accounts" group only for a committee member who is the society's Accountant.

export type SocietyTab = 'home' | 'approvals' | 'members' | 'flats' | 'billing' | 'payments' | 'expenses' | 'documents' | 'notices'
  | 'complaints' | 'professionals' | 'reports' | 'settings' | 'plan'
  | 'ledgers' | 'billtypes' | 'opening' | 'assets' | 'bank' | 'audit';

export interface NavItem { id: SocietyTab; label: string; group: 'main' | 'accounts' }

const MAIN: NavItem[] = [
  { id: 'home', label: 'Operations Feed', group: 'main' },
  { id: 'approvals', label: 'Approvals', group: 'main' },
  { id: 'flats', label: 'Flats & Units', group: 'main' },
  { id: 'members', label: 'Members & Residents', group: 'main' },
  { id: 'billing', label: 'Maintenance Billing', group: 'main' },
  { id: 'payments', label: 'Payment Verifications', group: 'main' },
  { id: 'expenses', label: 'Expenses & Payables', group: 'main' },
  { id: 'documents', label: 'Documents Vault', group: 'main' },
  { id: 'notices', label: 'Notice Board', group: 'main' },
  { id: 'complaints', label: 'Helpdesk Complaints', group: 'main' },
  { id: 'professionals', label: 'CA & Auditor Access', group: 'main' },
  { id: 'reports', label: 'Financial Reports', group: 'main' },
  { id: 'settings', label: 'Society Rules', group: 'main' },
  { id: 'plan', label: 'Sahvaas Plan & Billing', group: 'main' },
];

const ACCOUNTS: NavItem[] = [
  { id: 'ledgers', label: 'Groups & Ledgers', group: 'accounts' },
  { id: 'billtypes', label: 'Bill Types', group: 'accounts' },
  { id: 'opening', label: 'Opening Balance', group: 'accounts' },
  { id: 'assets', label: 'Fixed Assets', group: 'accounts' },
  { id: 'bank', label: 'Bank Reconciliation', group: 'accounts' },
  { id: 'audit', label: 'Audit & Year Close', group: 'accounts' },
];

export function societyNav({ isAccountant }: { isAccountant: boolean }): NavItem[] {
  return isAccountant ? [...MAIN, ...ACCOUNTS] : MAIN;
}
