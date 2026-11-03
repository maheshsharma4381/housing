// Tally Prime / ERP 9 import file: group masters, ledger masters + journal vouchers.
// Tally's convention: a debit line has ISDEEMEDPOSITIVE=Yes and a negative AMOUNT.
// Members' dues and Sundry Creditors lines go to one party ledger per flat / vendor (party_lines(), 025).
import type { Chart, ChartGroup } from './chart';

/** One row of party_lines(): the flat or vendor a Members Receivable / Sundry Creditors line belongs to. */
export interface PartyLine { ledger_entry_id: string; kind: 'flat' | 'vendor'; key: string; name: string; amount: number }

export interface TallyLine { code: string; amount: number; party?: string } // debit positive (Sahvaas ledger sign)

export interface TallyJournal {
  entry_number: string;
  entry_date: string; // YYYY-MM-DD
  narration: string;
  lines: TallyLine[];
}

/** Replaces each ledger line that has party rows with one line per party (same code, the party's amount). */
export function splitPartyLines(lines: { id: string; code: string; amount: number }[], parties: PartyLine[]): TallyLine[] {
  const byEntry = new Map<string, PartyLine[]>();
  for (const p of parties) byEntry.set(p.ledger_entry_id, [...(byEntry.get(p.ledger_entry_id) ?? []), p]);
  return lines.flatMap(l => {
    const own = byEntry.get(l.id);
    return own?.length
      ? own.map(p => ({ code: l.code, amount: Number(p.amount), party: p.name }))
      : [{ code: l.code, amount: l.amount }];
  });
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
  const nonZero = journals.flatMap(j => j.lines.filter(l => Math.round(l.amount * 100) !== 0));
  const used = new Set(nonZero.filter(l => !l.party).map(l => l.code));
  const ledgers = chart.ledgers.filter(l => used.has(l.code));

  // Party ledgers: named after the flat / vendor; a name that is also a ledger or group in the chart
  // gets " (Party)" so every export names the party the same way. Parent: the control ledger's group.
  const chartNames = new Set([...chart.ledgers.map(l => l.name), ...chart.groups.map(g => g.name)].map(n => n.toLowerCase()));
  const partyName = (name: string) => (chartNames.has(name.toLowerCase()) ? `${name} (Party)` : name);
  const parties = new Map<string, string>(); // Tally name -> control ledger code
  for (const l of nonZero) if (l.party && !parties.has(partyName(l.party))) parties.set(partyName(l.party), l.code);
  const partyControls = chart.ledgers.filter(l => [...parties.values()].includes(l.code));

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
  [...ledgers, ...partyControls].forEach(l => addChain(l.group_id));

  const groupMasters = groups.map(g =>
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><GROUP NAME="${esc(g.name)}" ACTION="Create"><NAME>${esc(g.name)}</NAME>` +
    `<PARENT>${esc(g.parent_id ? tallyParentName(chart, g.parent_id) : 'Suspense A/c')}</PARENT></GROUP></TALLYMESSAGE>`);

  const master = (name: string, parent: string) =>
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(name)}" ACTION="Create"><NAME>${esc(name)}</NAME>` +
    `<PARENT>${esc(parent)}</PARENT></LEDGER></TALLYMESSAGE>`;
  const ledgerMasters = [
    ...ledgers.map(l => master(l.name, tallyParentName(chart, l.group_id))),
    ...[...parties].map(([name, code]) => {
      const control = ledgerOf.get(code);
      return master(name, control ? tallyParentName(chart, control.group_id) : 'Suspense A/c');
    }),
  ];

  const vouchers = journals.map(j => {
    const entries = j.lines.filter(l => Math.round(l.amount * 100) !== 0).map(l => {
      const debit = l.amount > 0;
      const amount = (debit ? -Math.abs(l.amount) : Math.abs(l.amount)).toFixed(2);
      const name = l.party ? partyName(l.party) : ledgerOf.get(l.code)?.name ?? l.code;
      return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(name)}</LEDGERNAME>` +
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
