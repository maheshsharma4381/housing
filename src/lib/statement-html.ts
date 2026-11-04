// A flat owner's statement as a page of its own, to print or save as PDF (Phase 2F).
import { formatINR } from './inr.ts';

export interface StatementLine { date: string; entry_number: string; narration: string; debit: number | null; credit: number | null; balance: number }
export interface PrintableStatement { name: string; opening: number; closing: number; lines: StatementLine[] }

const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (v: unknown) => esc(formatINR(Number(v ?? 0)));

export function statementHtml({ title, openingLabel, statement }: { title: string; openingLabel: string; statement: PrintableStatement }): string {
  const rows = statement.lines.map(l => `<tr><td>${esc(l.date)}</td><td>${esc(l.entry_number)}</td><td>${esc(l.narration)}</td>`
    + `<td class="n">${l.debit ? money(l.debit) : ''}</td><td class="n">${l.credit ? money(l.credit) : ''}</td><td class="n">${money(l.balance)}</td></tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;color:#111;margin:24px}h1{font-size:18px}table{width:100%;border-collapse:collapse;font-size:12px}
th,td{border-bottom:1px solid #ddd;padding:6px;text-align:left}td.n,th.n{text-align:right}tr.b td{font-weight:600}</style></head>
<body><h1>${esc(title)}</h1><table><thead><tr><th>Date</th><th>Entry</th><th>Narration</th><th class="n">Debit</th><th class="n">Credit</th><th class="n">Balance</th></tr></thead>
<tbody><tr class="b"><td colspan="5">${esc(openingLabel)}</td><td class="n">${money(statement.opening)}</td></tr>${rows}
<tr class="b"><td colspan="5">Closing balance</td><td class="n">${money(statement.closing)}</td></tr></tbody></table>
<script>window.print()</script></body></html>`;
}
