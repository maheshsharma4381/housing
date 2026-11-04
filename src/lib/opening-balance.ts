// Opening balance (026): the CA enters the audited balance sheet, a catch-up entry and flat-wise /
// vendor-wise balances at go-live. Amounts are stored debit positive, credit negative.

export type Side = 'liabilities' | 'assets';
export type OpeningStatus = 'none' | 'draft' | 'submitted' | 'approved';

export interface AuditedLine { code: string; amount: number; side: Side; label?: string }
export interface CatchupLine { code: string; amount: number }
export interface FlatLine { unit_id: string; amount: number }
export interface VendorLine { vendor_id: string; amount: number }

export interface OpeningChecks {
  audited_difference: number;
  catchup_difference: number;
  dues_expected: number;
  dues_entered: number;
  advance_expected: number;
  advance_entered: number;
  creditors_expected: number;
  vendors_entered: number;
}

/** What opening_balance(society) returns */
export interface OpeningBalance {
  status: OpeningStatus;
  audited_as_of: string | null;
  live_on: string | null;
  audited_lines: AuditedLine[];
  catchup_lines: CatchupLine[];
  flat_lines: FlatLine[];
  vendor_lines: VendorLine[];
  decision_note: string | null;
  prepared_by_name: string | null;
  submitted_by_name: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  checks: OpeningChecks;
  flats: { unit_id: string; name: string; owner_name: string | null }[];
  vendors: { vendor_id: string; name: string }[];
}

/** A starting line: an existing ledger (code), a ledger to create in a group (groupKey), or a pick from a group */
export interface TemplateLine { side: Side; label: string; code?: string; groupKey?: string; pickFrom?: 'fixed_assets' | 'bank_accounts' }

// The standard Maharashtra co-operative housing society balance sheet, in printed order
export const OPENING_TEMPLATE: TemplateLine[] = [
  { side: 'liabilities', label: 'Share Capital', groupKey: 'capital_funds' },
  { side: 'liabilities', label: 'Reserve Fund', code: '3200' },
  { side: 'liabilities', label: 'Sinking Fund', code: '3000' },
  { side: 'liabilities', label: 'Repair Fund', code: '3100' },
  { side: 'liabilities', label: 'Building Fund', groupKey: 'capital_funds' },
  { side: 'liabilities', label: 'Income & Expenditure Account', groupKey: 'capital_funds' },
  { side: 'liabilities', label: 'Sundry Creditors', code: '2000' },
  { side: 'liabilities', label: 'Advance maintenance received', code: '2300' },
  { side: 'liabilities', label: 'Deposits from members', groupKey: 'current_liabilities' },
  { side: 'liabilities', label: 'GST payable', code: '2100' },
  { side: 'liabilities', label: 'TDS payable', code: '2200' },
  { side: 'assets', label: 'Fixed assets (net of depreciation)', pickFrom: 'fixed_assets' },
  { side: 'assets', label: 'Fixed deposits', groupKey: 'investments' },
  { side: 'assets', label: 'Bank', pickFrom: 'bank_accounts' },
  { side: 'assets', label: 'Cash in hand', code: '1100' },
  { side: 'assets', label: "Members' dues", code: '1200' },
  { side: 'assets', label: 'MSEB / water deposits', groupKey: 'loans_advances' },
  { side: 'assets', label: 'Interest accrued on FDs', groupKey: 'current_assets' },
  { side: 'assets', label: 'TDS receivable', groupKey: 'loans_advances' },
  { side: 'assets', label: 'Advances to vendors', code: '1400' },
];

/** The amount as stored: a liability is a credit (negative). Its own inverse. */
export function signed(side: Side, amount: number): number {
  return side === 'liabilities' ? 0 - amount : amount;
}

/** A side's total as printed on the balance sheet */
export function sideTotal(lines: AuditedLine[], side: Side): number {
  return lines.filter(l => l.side === side).reduce((s, l) => s + signed(side, Number(l.amount)), 0);
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The last `count` 31 Marches strictly before `today`, newest first */
export function fyEnds(today: Date, count = 3): string[] {
  const todayIso = iso(today);
  let year = today.getFullYear();
  if (`${year}-03-31` >= todayIso) year -= 1;
  return Array.from({ length: count }, (_, i) => `${year - i}-03-31`);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const parse = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const human = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

/** "Catch-up from 1 Apr 2026 to 30 Sep 2026", or null when there are no days between the audit and go-live */
export function catchupLabel(auditedAsOf: string, liveOn: string): string | null {
  const from = parse(auditedAsOf);
  from.setDate(from.getDate() + 1);
  const to = parse(liveOn);
  to.setDate(to.getDate() - 1);
  if (to < from) return null;
  return `Catch-up from ${human(from)} to ${human(to)}`;
}
