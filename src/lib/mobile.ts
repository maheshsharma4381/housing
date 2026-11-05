// Mobiles in the same shape as the database's normalize_mobile (031): digits with the country code.

/**
 * A number typed with + or 00 already carries its country code (+65 9123 4567 stays Singaporean).
 * Otherwise: 10 Indian digits get 91; a leading 0 is dropped; fewer than 10 digits is not a mobile.
 */
export function normalizeMobile(input: string | null | undefined): string | null {
  const raw = (input ?? '').trimStart();
  if (/^(\+|00)/.test(raw)) {
    const intl = raw.replace(/^00/, '').replace(/\D/g, '');
    // "+91 0 98765 43210": the trunk 0 many people type after the country code
    if (/^910\d{10}$/.test(intl)) return `91${intl.slice(3)}`;
    return intl.length >= 8 && intl.length <= 15 ? intl : null;
  }
  const d = raw.replace(/\D/g, '');
  if (d.length < 10) return null;
  if (d.length === 10) return `91${d}`;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
  return d;
}

/** "+91 98765 43210" for display; anything else as stored. */
export function formatMobile(stored: string | null | undefined): string {
  if (!stored) return '';
  if (stored.length === 12 && stored.startsWith('91')) return `+91 ${stored.slice(2, 7)} ${stored.slice(7)}`;
  return `+${stored}`;
}

/**
 * A profile's phone for display. Supabase stores a login's phone as international digits (919876543210,
 * 6591234567), so more than 10 digits, or a leading +, already carries the country; 10 digits are Indian.
 */
function phoneText(phone: string | null | undefined): string {
  const raw = (phone ?? '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') || digits.length > 10) return formatMobile(digits);
  const n = normalizeMobile(raw);
  return n ? formatMobile(n) : raw;
}

type Contact = { email?: string | null; phone?: string | null } | null | undefined;

/** How to reach a person, in one piece: the email, else the mobile (accounts made by mobile have no email). */
export function contactText(p: Contact): string {
  return p?.email?.trim() || phoneText(p?.phone);
}

/** Email and mobile together ("asha@x.in · +91 98765 43210"), whichever exist. */
export function contactLine(p: Contact): string {
  return [p?.email?.trim(), phoneText(p?.phone)].filter(Boolean).join(' · ');
}

/** A key that is left out is not changed (a paste with no mobile column keeps the saved mobiles). */
export interface OwnerContactRow { unit_id: string; name?: string; mobile?: string }

/**
 * Lines copied from Excel: flat number, owner name, mobile — separated by tabs or commas.
 * A header line or a flat the society does not have is reported, never guessed.
 */
export function parseOwnerPaste(text: string, units: { id: string; unit_number: string }[]) {
  const byNumber = new Map(units.map(u => [u.unit_number.trim().toLowerCase(), u.id]));
  const rows: OwnerContactRow[] = [];
  const unknownFlats: string[] = [];
  const badMobiles: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = (line.includes('\t') ? line.split('\t') : line.split(',')).map(c => c.trim());
    const [flat = '', name = '', mobileRaw = ''] = cells;
    const unitId = byNumber.get(flat.toLowerCase());
    if (!unitId) {
      if (!/^(flat|unit)/i.test(flat)) unknownFlats.push(flat);
      continue;
    }
    const mobile = mobileRaw ? normalizeMobile(mobileRaw) : undefined;
    if (mobile === null) {
      badMobiles.push(`${flat}: ${mobileRaw}`);
      continue;
    }
    const row: OwnerContactRow = { unit_id: unitId };
    if (name) row.name = name;
    if (mobile) row.mobile = mobile;
    rows.push(row);
  }
  return { rows, unknownFlats, badMobiles };
}
