// Tally Prime / ERP 9 import file: ledger masters + journal vouchers.
// Tally's convention: a debit line has ISDEEMEDPOSITIVE=Yes and a negative AMOUNT.

export interface TallyLedger { code: string; name: string; type: string }
export interface TallyJournal {
  entry_number: string;
  entry_date: string; // YYYY-MM-DD
  narration: string;
  lines: { code: string; amount: number }[]; // debit positive (Sahvaas ledger sign)
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Closest standard Tally group for a Sahvaas account. */
export function tallyGroup(code: string, type: string): string {
  if (code === '1000') return 'Bank Accounts';
  if (code === '1100') return 'Cash-in-Hand';
  if (code === '1200') return 'Sundry Debtors';
  if (/^15\d\d$/.test(code)) return 'Fixed Assets';
  if (code === '2000') return 'Sundry Creditors';
  if (code === '2100' || code === '2200') return 'Duties & Taxes';
  if (type === 'asset') return 'Current Assets';
  if (type === 'liability') return 'Current Liabilities';
  if (type === 'equity') return 'Reserves & Surplus';
  if (type === 'income') return 'Indirect Incomes';
  return 'Indirect Expenses';
}

export function buildTallyXml(company: string, ledgers: TallyLedger[], journals: TallyJournal[]): string {
  const nameOf = new Map(ledgers.map(l => [l.code, l.name]));
  const used = new Set(journals.flatMap(j => j.lines.map(l => l.code)));

  const masters = ledgers.filter(l => used.has(l.code)).map(l =>
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(l.name)}" ACTION="Create"><NAME>${esc(l.name)}</NAME>` +
    `<PARENT>${esc(tallyGroup(l.code, l.type))}</PARENT></LEDGER></TALLYMESSAGE>`);

  const vouchers = journals.map(j => {
    const entries = j.lines.filter(l => Math.round(l.amount * 100) !== 0).map(l => {
      const debit = l.amount > 0;
      const amount = (debit ? -Math.abs(l.amount) : Math.abs(l.amount)).toFixed(2);
      return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(nameOf.get(l.code) ?? l.code)}</LEDGERNAME>` +
        `<ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${amount}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
    }).join('');
    return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Journal" ACTION="Create">` +
      `<DATE>${j.entry_date.replace(/-/g, '')}</DATE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>` +
      `<VOUCHERNUMBER>${esc(j.entry_number)}</VOUCHERNUMBER><NARRATION>${esc(j.narration)}</NARRATION>${entries}</VOUCHER></TALLYMESSAGE>`;
  });

  return '<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>' +
    `<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>` +
    `<REQUESTDATA>\n${[...masters, ...vouchers].join('\n')}\n</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n`;
}
