// Tally Prime / ERP 9 import file: group masters, ledger masters + journal vouchers.
// Tally's convention: a debit line has ISDEEMEDPOSITIVE=Yes and a negative AMOUNT.
import type { Chart, ChartGroup } from './chart';

export interface TallyJournal {
  entry_number: string;
  entry_date: string; // YYYY-MM-DD
  narration: string;
  lines: { code: string; amount: number }[]; // debit positive (Sahvaas ledger sign)
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Sahvaas system groups → Tally's built-in groups. Other groups are created in Tally under their own name. */
const TALLY_GROUP: Record<string, string> = {
  capital_funds: 'Reserves & Surplus',
  current_liabilities: 'Current Liabilities',
  sundry_creditors: 'Sundry Creditors',
  duties_taxes: 'Duties & Taxes',
  fixed_assets: 'Fixed Assets',
  investments: 'Investments',
  current_assets: 'Current Assets',
  bank_accounts: 'Bank Accounts',
  cash_in_hand: 'Cash-in-Hand',
  members_dues: 'Sundry Debtors',
  loans_advances: 'Loans & Advances (Asset)',
  income: 'Indirect Incomes',
  expenses: 'Indirect Expenses',
};

const builtIn = (g: ChartGroup) => (g.system_key ? TALLY_GROUP[g.system_key] : undefined);

/** The Tally group a ledger or group placed in `groupId` goes under. */
export function tallyParentName(chart: Chart, groupId: string): string {
  const g = chart.groups.find(x => x.id === groupId);
  if (!g) return 'Suspense A/c';
  return builtIn(g) ?? g.name;
}

export function buildTallyXml(company: string, chart: Chart, journals: TallyJournal[]): string {
  const ledgerOf = new Map(chart.ledgers.map(l => [l.code, l]));
  const groupById = new Map(chart.groups.map(g => [g.id, g]));
  const used = new Set(journals.flatMap(j => j.lines.filter(l => Math.round(l.amount * 100) !== 0).map(l => l.code)));
  const ledgers = chart.ledgers.filter(l => used.has(l.code));

  // Groups Tally does not have: each used ledger's chain up to a built-in group, parents first
  const groups: ChartGroup[] = [];
  const seen = new Set<string>();
  const addChain = (id: string | null) => {
    const g = id ? groupById.get(id) : undefined;
    if (!g || builtIn(g) || seen.has(g.id)) return;
    seen.add(g.id);
    addChain(g.parent_id);
    groups.push(g);
  };
  ledgers.forEach(l => addChain(l.group_id));

  const groupMasters = groups.map(g =>
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><GROUP NAME="${esc(g.name)}" ACTION="Create"><NAME>${esc(g.name)}</NAME>` +
    `<PARENT>${esc(g.parent_id ? tallyParentName(chart, g.parent_id) : 'Suspense A/c')}</PARENT></GROUP></TALLYMESSAGE>`);

  const ledgerMasters = ledgers.map(l =>
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(l.name)}" ACTION="Create"><NAME>${esc(l.name)}</NAME>` +
    `<PARENT>${esc(tallyParentName(chart, l.group_id))}</PARENT></LEDGER></TALLYMESSAGE>`);

  const vouchers = journals.map(j => {
    const entries = j.lines.filter(l => Math.round(l.amount * 100) !== 0).map(l => {
      const debit = l.amount > 0;
      const amount = (debit ? -Math.abs(l.amount) : Math.abs(l.amount)).toFixed(2);
      return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(ledgerOf.get(l.code)?.name ?? l.code)}</LEDGERNAME>` +
        `<ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${amount}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
    }).join('');
    return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Journal" ACTION="Create">` +
      `<DATE>${j.entry_date.replace(/-/g, '')}</DATE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>` +
      `<VOUCHERNUMBER>${esc(j.entry_number)}</VOUCHERNUMBER><NARRATION>${esc(j.narration)}</NARRATION>${entries}</VOUCHER></TALLYMESSAGE>`;
  });

  return '<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>' +
    `<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>` +
    `<REQUESTDATA>\n${[...groupMasters, ...ledgerMasters, ...vouchers].join('\n')}\n</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n`;
}
