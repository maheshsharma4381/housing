// The secretary's menu (spec 9.3): Home and Approvals, then Money, Society and Settings.
// The accounting screens live in the CA login, and in an "Accounts" group only for a committee
// member who is the society's Accountant (Phase 2D).

export type SocietyTab = 'home' | 'approvals' | 'members' | 'flats' | 'billing' | 'payments' | 'expenses' | 'documents' | 'notices'
  | 'complaints' | 'professionals' | 'reports' | 'settings' | 'plan'
  | 'ledgers' | 'billtypes' | 'opening' | 'assets' | 'bank' | 'audit';

export type NavGroup = 'top' | 'money' | 'society' | 'settings' | 'accounts';
export interface NavItem { id: SocietyTab; label: string; group: NavGroup }

export const GROUP_LABELS: Record<NavGroup, string> = { top: '', money: 'Money', society: 'Society', settings: 'Settings', accounts: 'Accounts' };

const MAIN: NavItem[] = [
  { id: 'home', label: 'Home', group: 'top' },
  { id: 'approvals', label: 'Approvals', group: 'top' },
  { id: 'billing', label: 'Maintenance bills', group: 'money' },
  { id: 'payments', label: 'Payments received', group: 'money' },
  { id: 'expenses', label: 'Vendor bills', group: 'money' },
  { id: 'reports', label: 'Reports', group: 'money' },
  // flats, members and owner change on one screen
  { id: 'flats', label: 'Flats & residents', group: 'society' },
  { id: 'notices', label: 'Notices', group: 'society' },
  { id: 'complaints', label: 'Complaints', group: 'society' },
  { id: 'documents', label: 'Documents', group: 'society' },
  { id: 'settings', label: 'Society settings', group: 'settings' },
  { id: 'professionals', label: 'CA & auditor', group: 'settings' },
  { id: 'plan', label: 'Plan & billing', group: 'settings' },
];

const ACCOUNTS: NavItem[] = [
  { id: 'ledgers', label: 'Groups & Ledgers', group: 'accounts' },
  { id: 'billtypes', label: 'Bill Types', group: 'accounts' },
  { id: 'opening', label: 'Opening Balance', group: 'accounts' },
  { id: 'assets', label: 'Fixed Assets', group: 'accounts' },
  { id: 'bank', label: 'Bank Reconciliation', group: 'accounts' },
  { id: 'audit', label: 'Audit & Year Close', group: 'accounts' },
];

/** Phone: Home · Bills · Payments · Complaints, then More */
export const PHONE_BAR: SocietyTab[] = ['home', 'billing', 'payments', 'complaints'];

export function societyNav({ isAccountant }: { isAccountant: boolean }): NavItem[] {
  return isAccountant ? [...MAIN, ...ACCOUNTS] : MAIN;
}

const ALIASES: Record<string, SocietyTab> = { members: 'flats', bills: 'billing', units: 'flats', vendor_bills: 'expenses' };

/** A link (old tab id, notification link, ?tab=) to the screen that shows it; anything unknown is Home. */
export function societyTabFor(link: string | null | undefined): SocietyTab {
  if (!link) return 'home';
  if (ALIASES[link]) return ALIASES[link];
  return [...MAIN, ...ACCOUNTS].some(i => i.id === link) ? (link as SocietyTab) : 'home';
}
