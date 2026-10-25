import { parseCsv } from './unit-csv.ts';
import { parseInvoiceDate } from './invoice-extract.ts';

/** One statement line, oldest first, as import_bank_statement expects it. */
export interface StatementRow {
  date: string;
  value_date: string | null;
  description: string;
  reference: string | null;
  debit: number;
  credit: number;
  balance: number | null;
}

export interface ParsedStatement {
  format: string;
  rows: StatementRow[];
  skipped: number;
  warnings: string[];
}

type Column = 'date' | 'valueDate' | 'description' | 'reference' | 'debit' | 'credit' | 'amount' | 'drcr' | 'balance';

// Header names (lower case, letters and digits only) used by SBI, HDFC, ICICI, Axis, Kotak and most others
const ALIASES: [Column, string[]][] = [
  ['valueDate', ['valuedate', 'valuedt']],
  ['date', ['txndate', 'transactiondate', 'trandate', 'postingdate', 'date', 'dt']],
  ['description', ['narration', 'description', 'particulars', 'transactionremarks', 'transactiondetails', 'remarks', 'details']],
  ['reference', ['chqrefno', 'refnochequeno', 'chequerefno', 'refchqno', 'chqno', 'chequeno', 'chequenumber', 'referenceno', 'refno', 'utrno', 'utr', 'transactionid', 'tranid']],
  ['debit', ['withdrawalamt', 'withdrawalamount', 'withdrawals', 'withdrawal', 'debitamount', 'debit', 'dr']],
  ['credit', ['depositamt', 'depositamount', 'deposits', 'deposit', 'creditamount', 'credit', 'cr']],
  ['drcr', ['drcr', 'crdr', 'debitcredit', 'transactiontype', 'type']],
  ['amount', ['transactionamount', 'amount']],
  ['balance', ['closingbalance', 'runningbalance', 'availablebalance', 'balance', 'bal']],
];

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function mapHeader(cells: string[]): Partial<Record<Column, number>> | null {
  const map: Partial<Record<Column, number>> = {};
  const used = new Set<number>();
  // Exact names first, then names with a suffix such as "Withdrawal Amount (INR)"
  for (const exact of [true, false]) {
    for (const [col, names] of ALIASES) {
      if (map[col] !== undefined) continue;
      const i = cells.findIndex((c, idx) => !used.has(idx) && names.some((n) => {
        const k = key(c);
        return exact ? k === n : n.length >= 4 && k.startsWith(n);
      }));
      if (i >= 0) {
        map[col] = i;
        used.add(i);
      }
    }
  }
  if (map.date === undefined && map.valueDate !== undefined) {
    map.date = map.valueDate;
    delete map.valueDate;
  }
  const hasMoney = (map.debit !== undefined && map.credit !== undefined) || map.amount !== undefined;
  return map.date !== undefined && map.description !== undefined && hasMoney ? map : null;
}

function guessFormat(header: string[]): string {
  const h = header.map(key).join(' ');
  if (h.includes('narration') && h.includes('chqrefno') && h.includes('withdrawalamt')) return 'hdfc';
  if (h.includes('refnochequeno') || (h.includes('txndate') && h.includes('description'))) return 'sbi';
  if (h.includes('transactionremarks') || h.includes('withdrawalamountinr')) return 'icici';
  if (h.includes('particulars') && h.includes('chqno')) return 'axis';
  if (h.includes('drcr') || h.includes('chequerefno')) return 'kotak';
  return 'generic';
}

/** "1,00,000.00", "5,000.00 Dr", "(500.00)", "-" -> signed number (Dr / brackets negative); blank -> null. */
export function parseStatementAmount(raw: string | undefined): number | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (!s || s === '-' || s === '--') return null;
  let sign = 1;
  if (/\bdr\.?$/i.test(s)) { sign = -1; s = s.replace(/\s*dr\.?$/i, ''); }
  s = s.replace(/\s*cr\.?$/i, '');
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (s.startsWith('-')) { sign = -sign; s = s.slice(1); }
  s = s.replace(/[₹,\s]|rs\.?|inr/gi, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return sign * Math.round(Number(s) * 100) / 100;
}

/** Statement dates, with or without a time: "14/10/2026", "14-Oct-26", "2026-10-14 10:22:01". */
export function parseStatementDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/\s+/g, ' ');
  return parseInvoiceDate(s) ?? parseInvoiceDate(s.split(' ')[0]) ?? parseInvoiceDate(s.split(' ').slice(0, 3).join(' '));
}

function splitRows(text: string): string[][] {
  const head = text.split(/\r?\n/, 30).join('\n');
  if ((head.match(/\t/g) ?? []).length > (head.match(/,/g) ?? []).length) {
    return text.split(/\r?\n/).map((l) => l.split('\t'));
  }
  return parseCsv(text);
}

export function parseBankStatement(text: string): ParsedStatement {
  const all = splitRows(text.replace(/^﻿/, '')).map((r) => r.map((c) => c.trim()));
  const headerAt = all.slice(0, 40).findIndex((r) => mapHeader(r) !== null);
  if (headerAt < 0) {
    throw new Error('Could not find the column headings (Date, Narration / Description, Withdrawal / Deposit or Amount). Download the statement as CSV from net banking and try again.');
  }
  const header = all[headerAt];
  const map = mapHeader(header)!;
  const cell = (r: string[], c: Column) => (map[c] === undefined ? undefined : r[map[c]!]);
  const warnings: string[] = [];
  const rows: StatementRow[] = [];
  let skipped = 0;

  for (const r of all.slice(headerAt + 1)) {
    if (r.every((c) => !c)) continue;
    const date = parseStatementDate(cell(r, 'date'));
    if (!date) {
      skipped++; // opening / closing balance lines, page footers
      continue;
    }
    let debit = 0;
    let credit = 0;
    if (map.debit !== undefined && map.credit !== undefined) {
      debit = Math.abs(parseStatementAmount(cell(r, 'debit')) ?? 0);
      credit = Math.abs(parseStatementAmount(cell(r, 'credit')) ?? 0);
    } else {
      const amount = parseStatementAmount(cell(r, 'amount')) ?? 0;
      const drcr = key(cell(r, 'drcr') ?? '');
      const isDebit = drcr ? drcr.startsWith('d') || drcr === 'withdrawal' : amount < 0;
      if (isDebit) debit = Math.abs(amount);
      else credit = Math.abs(amount);
    }
    if ((debit > 0) === (credit > 0)) {
      skipped++;
      warnings.push(`Skipped the ${date} line "${(cell(r, 'description') ?? '').slice(0, 40)}" — it has no single debit or credit amount.`);
      continue;
    }
    const balance = parseStatementAmount(cell(r, 'balance'));
    rows.push({
      date,
      value_date: parseStatementDate(cell(r, 'valueDate')),
      description: (cell(r, 'description') ?? '').replace(/\s+/g, ' ').slice(0, 500),
      reference: (cell(r, 'reference') ?? '').replace(/^[0\-\s]+$/, '').trim() || null,
      debit,
      credit,
      balance: balance == null ? null : balance,
    });
  }

  if (rows.length > 1 && rows[0].date > rows[rows.length - 1].date) rows.reverse();
  if (rows.length === 0) warnings.push('No transactions were found below the headings.');
  return { format: guessFormat(header), rows, skipped, warnings };
}
