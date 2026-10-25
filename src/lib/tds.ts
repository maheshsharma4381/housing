import type { AssetAccountCode, ExpenseCategory, TdsSuggestion } from '../types/database';

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const ASSET_TYPES: { code: AssetAccountCode; label: string; rate: number }[] = [
  { code: '1500', label: 'Plant & machinery (pump, generator, lift)', rate: 15 },
  { code: '1510', label: 'Electrical installations', rate: 10 },
  { code: '1520', label: 'Furniture & fixtures', rate: 10 },
  { code: '1530', label: 'Computers & equipment', rate: 40 },
  { code: '1540', label: 'CCTV & security equipment', rate: 15 },
  { code: '1550', label: 'Building improvements', rate: 10 },
];

export const assetTypeLabel = (code?: string | null) => ASSET_TYPES.find(a => a.code === code)?.label ?? code ?? '';

/** GSTIN check digit (mod-36, alternating weights 1 and 2). */
export function gstinCheckDigitOk(gstin: string): boolean {
  const g = gstin.trim().toUpperCase();
  if (!GSTIN_RE.test(g)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_CHARS.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36] === g[14];
}

export const isGstinFormat = (gstin?: string | null) => !!gstin && GSTIN_RE.test(gstin.trim().toUpperCase());

/** PAN as given, else characters 3-12 of the GSTIN (mirrors vendor_pan() in 013). */
export function vendorPan(pan?: string | null, gstin?: string | null): string | null {
  const p = (pan ?? '').trim().toUpperCase();
  if (PAN_RE.test(p)) return p;
  const g = (gstin ?? '').trim().toUpperCase();
  return GSTIN_RE.test(g) ? g.slice(2, 12) : null;
}

/** 4th letter of a PAN: P (person) / H (HUF) take the individual TDS rate. */
export function panEntity(pan?: string | null): 'individual' | 'other' | null {
  if (!pan) return null;
  return ['P', 'H'].includes(pan[3]) ? 'individual' : 'other';
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** One-line explanation of suggest_tds() for the bill form. */
export function explainTds(s: TdsSuggestion): string {
  switch (s.reason) {
    case 'no_category': return 'Pick a category to work out TDS.';
    case 'no_tds': return 'No TDS for this kind of payment.';
    case 'goods': return 'Purchase of goods — no TDS.';
    case 'no_rule': return 'No TDS rule is set for this payment type yet (ask the Sahvaas admin).';
    case 'below_limits': {
      const limits = [
        s.single_limit ? `one bill above ${inr(s.single_limit)}` : '',
        s.annual_limit ? `this vendor's yearly total above ${inr(s.annual_limit)} (now ${inr(s.fy_total ?? 0)})` : '',
      ].filter(Boolean).join(' or ');
      return `${s.label ?? 'TDS'}${s.section ? ` (${s.section})` : ''}: below the limits — TDS starts at ${limits}.`;
    }
  }
  const who = s.rate_source === 'certificate' ? 'lower-deduction certificate'
    : s.rate_source === 'no_pan' ? 'no PAN on record'
    : s.rate_source === 'individual' ? 'vendor is an individual / HUF'
    : 'vendor is a company / firm';
  const why = s.reason === 'single_bill'
    ? `single bill above ${inr(s.single_limit ?? 0)}`
    : `yearly total ${inr(s.fy_total ?? 0)} crossed ${inr(s.annual_limit ?? 0)}, so earlier bills of the year are included`;
  return `${s.label} (${s.section}) · ${who} · ${s.rate}% on ${inr(s.base ?? 0)} — ${why}.`;
}

/** Should this bill be suggested as an asset? */
export function suggestsAsset(cat: Pick<ExpenseCategory, 'asset_account_code' | 'asset_threshold'> | undefined, amount: number): boolean {
  return !!cat?.asset_account_code && cat.asset_threshold != null && amount >= Number(cat.asset_threshold);
}

/** Indian financial year that ends on or after `d`, as its 31 March date (YYYY-03-31). */
export function fyEndFor(d: Date = new Date()): string {
  const y = d.getMonth() >= 3 ? d.getFullYear() + 1 : d.getFullYear();
  return `${y}-03-31`;
}

export const fyLabel = (fyEnd: string) => {
  const y = Number(fyEnd.slice(0, 4));
  return `FY ${y - 1}-${String(y).slice(2)}`;
};
