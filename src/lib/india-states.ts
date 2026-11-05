// States and union territories of India with their GST state codes (the first two digits of a GSTIN).
// Used to pick a society's state from a list, and to tell CGST + SGST from IGST on Sahvaas's invoices
// even for states typed freely before the list existed ("MH", "maharashtra ", "Orissa").

export const INDIAN_STATES: { code: string; name: string }[] = [
  { code: '35', name: 'Andaman and Nicobar Islands' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '18', name: 'Assam' },
  { code: '10', name: 'Bihar' },
  { code: '04', name: 'Chandigarh' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '07', name: 'Delhi' },
  { code: '30', name: 'Goa' },
  { code: '24', name: 'Gujarat' },
  { code: '06', name: 'Haryana' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '20', name: 'Jharkhand' },
  { code: '29', name: 'Karnataka' },
  { code: '32', name: 'Kerala' },
  { code: '38', name: 'Ladakh' },
  { code: '31', name: 'Lakshadweep' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '27', name: 'Maharashtra' },
  { code: '14', name: 'Manipur' },
  { code: '17', name: 'Meghalaya' },
  { code: '15', name: 'Mizoram' },
  { code: '13', name: 'Nagaland' },
  { code: '21', name: 'Odisha' },
  { code: '34', name: 'Puducherry' },
  { code: '03', name: 'Punjab' },
  { code: '08', name: 'Rajasthan' },
  { code: '11', name: 'Sikkim' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '36', name: 'Telangana' },
  { code: '16', name: 'Tripura' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '05', name: 'Uttarakhand' },
  { code: '19', name: 'West Bengal' },
];

// Old names, short forms and the two-letter codes people type
const ALIASES: Record<string, string> = {
  orissa: '21', pondicherry: '34', uttaranchal: '05', 'nct of delhi': '07', 'new delhi': '07',
  'dadra and nagar haveli': '26', 'daman and diu': '26', 'andaman and nicobar': '35',
  an: '35', ap: '37', ar: '12', as: '18', br: '10', ch: '04', cg: '22', ct: '22', dn: '26', dd: '26', dl: '07',
  ga: '30', gj: '24', hr: '06', hp: '02', jk: '01', jh: '20', ka: '29', kl: '32', la: '38', ld: '31', mp: '23',
  mh: '27', mn: '14', ml: '17', mz: '15', nl: '13', od: '21', or: '21', py: '34', pb: '03', rj: '08', sk: '11',
  tn: '33', ts: '36', tg: '36', tr: '16', up: '09', uk: '05', ut: '05', wb: '19',
};

const simplify = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const BY_NAME = new Map(INDIAN_STATES.map(s => [simplify(s.name), s.code]));

/** The GST state code ("27") for a state name, an old name, a two-letter code or a GSTIN; null when it names no state. */
export function stateCode(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  const gstin = /^(\d{2})[A-Z]{5}\d{4}[A-Z]/i.exec(raw);
  if (gstin) return INDIAN_STATES.some(s => s.code === gstin[1]) ? gstin[1] : null;
  const key = simplify(raw);
  return BY_NAME.get(key) ?? ALIASES[key] ?? null;
}

/** The state's name as the list spells it ("orissa" → "Odisha"); null when it names no state. */
export function canonicalState(input: string | null | undefined): string | null {
  const code = stateCode(input);
  return INDIAN_STATES.find(s => s.code === code)?.name ?? null;
}
