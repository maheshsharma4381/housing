import { parseCsv } from './unit-csv.ts';

/** Row shape accepted by the import_gstr2b RPC (009). */
export interface Gstr2bInvoice {
  supplier_gstin: string;
  supplier_name: string;
  invoice_number: string;
  invoice_date: string; // YYYY-MM-DD
  invoice_type: string;
  invoice_value: number;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  itc_available: 'Y' | 'N';
}

export interface Gstr2bParseResult {
  gstin?: string;
  returnPeriod?: string; // MMYYYY
  invoices: Gstr2bInvoice[];
  /** Sections present in the file that are not reconciled yet (credit notes, amendments) */
  skipped: Record<string, number>;
  errors: string[];
}

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** Accepts DD-MM-YYYY, DD/MM/YYYY, DD-MMM-YYYY and YYYY-MM-DD; returns YYYY-MM-DD or null. */
export function toIsoDate(value: string): string | null {
  const v = value.trim();
  let y: string, m: string, d: string;
  let match = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    [, y, m, d] = match;
  } else if ((match = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) {
    [, d, m, y] = match;
  } else if ((match = v.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2,4})$/))) {
    d = match[1];
    m = MONTHS[match[2].toLowerCase()];
    y = match[3].length === 2 ? `20${match[3]}` : match[3];
    if (!m) return null;
  } else {
    return null;
  }
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}

// ----- Official GSTR-2B JSON (GST portal "Download JSON") -----

interface JsonItem { txval?: number; igst?: number; cgst?: number; sgst?: number }
interface JsonInvoice extends JsonItem { inum?: string; dt?: string; val?: number; typ?: string; itcavl?: string; items?: JsonItem[] }
interface JsonSupplier { ctin?: string; trdnm?: string; inv?: JsonInvoice[] }

export function parseGstr2bJson(text: string): Gstr2bParseResult {
  const result: Gstr2bParseResult = { invoices: [], skipped: {}, errors: [] };
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { ...result, errors: ['This is not a valid JSON file.'] };
  }
  const data = (root.data ?? root) as Record<string, unknown>;
  const docdata = data.docdata as Record<string, unknown> | undefined;
  if (!docdata || typeof docdata !== 'object') {
    return { ...result, errors: ['No "docdata" section found — download the GSTR-2B JSON from the GST portal.'] };
  }
  if (typeof data.gstin === 'string') result.gstin = data.gstin;
  if (typeof data.rtnprd === 'string' && /^\d{6}$/.test(data.rtnprd)) result.returnPeriod = data.rtnprd;

  for (const [section, rows] of Object.entries(docdata)) {
    if (section !== 'b2b' && Array.isArray(rows) && rows.length > 0) result.skipped[section] = rows.length;
  }

  const suppliers = (docdata.b2b ?? []) as JsonSupplier[];
  suppliers.forEach((s, si) => {
    const gstin = String(s.ctin ?? '').trim().toUpperCase();
    (s.inv ?? []).forEach((inv, ii) => {
      const where = `Supplier ${si + 1} (${gstin || 'no GSTIN'}), invoice ${ii + 1}`;
      const date = toIsoDate(String(inv.dt ?? ''));
      if (!GSTIN_PATTERN.test(gstin)) return void result.errors.push(`${where}: invalid supplier GSTIN.`);
      if (!inv.inum) return void result.errors.push(`${where}: missing invoice number.`);
      if (!date) return void result.errors.push(`${where}: invalid date "${inv.dt}".`);
      const parts: JsonItem[] = inv.items?.length ? inv.items : [inv];
      const sum = (k: keyof JsonItem) => round2(parts.reduce((acc, p) => acc + num(p[k]), 0));
      const taxable = sum('txval');
      const igst = sum('igst');
      const cgst = sum('cgst');
      const sgst = sum('sgst');
      result.invoices.push({
        supplier_gstin: gstin,
        supplier_name: String(s.trdnm ?? '').trim(),
        invoice_number: String(inv.inum).trim(),
        invoice_date: date,
        invoice_type: inv.typ === 'R' || !inv.typ ? 'B2B' : String(inv.typ),
        invoice_value: inv.val !== undefined ? round2(num(inv.val)) : round2(taxable + igst + cgst + sgst),
        taxable_value: taxable,
        igst,
        cgst,
        sgst,
        itc_available: String(inv.itcavl ?? 'Y').toUpperCase().startsWith('N') ? 'N' : 'Y',
      });
    });
  });

  if (result.invoices.length === 0 && result.errors.length === 0) result.errors.push('No B2B invoices found in this file.');
  return result;
}

// ----- CSV (B2B sheet of the portal Excel saved as CSV, or a simple template) -----

type Field = 'gstin' | 'name' | 'number' | 'date' | 'value' | 'taxable' | 'igst' | 'cgst' | 'sgst' | 'itc';
const CSV_ALIASES: Record<string, Field> = {
  gstin: 'gstin', supplier_gstin: 'gstin', gstin_of_supplier: 'gstin', ctin: 'gstin',
  trade_name: 'name', supplier_name: 'name', trade_legal_name: 'name', trdnm: 'name',
  invoice_number: 'number', invoice_no: 'number', inum: 'number',
  invoice_date: 'date', date: 'date', dt: 'date',
  invoice_value: 'value', value: 'value',
  taxable_value: 'taxable', taxable: 'taxable', txval: 'taxable',
  igst: 'igst', integrated_tax: 'igst',
  cgst: 'cgst', central_tax: 'cgst',
  sgst: 'sgst', state_ut_tax: 'sgst', sgst_utgst: 'sgst', state_tax: 'sgst',
  itc: 'itc', itc_availability: 'itc', itc_available: 'itc',
};
const keyOf = (h: string) => h.trim().toLowerCase().replace(/\(.*?\)|₹/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export const GSTR2B_CSV_TEMPLATE =
  'gstin,trade_name,invoice_number,invoice_date,invoice_value,taxable_value,igst,cgst,sgst,itc_availability\n' +
  '27AAPFU0939F1ZV,Guard Co,SG/2026/0045,05-10-2026,11800,10000,0,900,900,Y\n';

export function parseGstr2bCsv(text: string): Gstr2bParseResult {
  const result: Gstr2bParseResult = { invoices: [], skipped: {}, errors: [] };
  const table = parseCsv(text.replace(/^﻿/, ''));
  // The portal sheet has title rows above the header; find the row naming the GSTIN column
  const headerIdx = table.findIndex(row => row.some(c => CSV_ALIASES[keyOf(c)] === 'gstin'));
  if (headerIdx < 0) return { ...result, errors: ['Could not find a GSTIN column header.'] };
  const cols = table[headerIdx].map(h => CSV_ALIASES[keyOf(h)]);
  for (const required of ['number', 'date', 'taxable'] as Field[]) {
    if (!cols.includes(required)) result.errors.push(`Missing column: ${required === 'number' ? 'invoice number' : required === 'date' ? 'invoice date' : 'taxable value'}.`);
  }
  if (result.errors.length) return result;

  table.slice(headerIdx + 1).forEach((cells, i) => {
    const line = headerIdx + i + 2;
    const get = (f: Field) => {
      const idx = cols.indexOf(f);
      return idx >= 0 ? (cells[idx] ?? '').trim() : '';
    };
    const gstin = get('gstin').toUpperCase();
    if (!gstin && !get('number')) return; // blank/footer row
    const date = toIsoDate(get('date'));
    if (!GSTIN_PATTERN.test(gstin)) return void result.errors.push(`Line ${line}: invalid GSTIN "${gstin}".`);
    if (!get('number')) return void result.errors.push(`Line ${line}: missing invoice number.`);
    if (!date) return void result.errors.push(`Line ${line}: invalid date "${get('date')}".`);
    const taxable = round2(num(get('taxable')));
    const igst = round2(num(get('igst')));
    const cgst = round2(num(get('cgst')));
    const sgst = round2(num(get('sgst')));
    result.invoices.push({
      supplier_gstin: gstin,
      supplier_name: get('name'),
      invoice_number: get('number'),
      invoice_date: date,
      invoice_type: 'B2B',
      invoice_value: get('value') ? round2(num(get('value'))) : round2(taxable + igst + cgst + sgst),
      taxable_value: taxable,
      igst,
      cgst,
      sgst,
      itc_available: get('itc').toUpperCase().startsWith('N') ? 'N' : 'Y',
    });
  });
  if (result.invoices.length === 0 && result.errors.length === 0) result.errors.push('No invoice rows found.');
  return result;
}
