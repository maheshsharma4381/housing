// Mobiles in the same shape as the database's normalize_mobile (031): digits with the country code.

/** 10 Indian digits get 91; a leading + or 0 is dropped; fewer than 10 digits is not a mobile. */
export function normalizeMobile(input: string | null | undefined): string | null {
  const d = (input ?? '').replace(/\D/g, '');
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

export interface OwnerContactRow { unit_id: string; name: string; mobile: string }

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
    const mobile = mobileRaw ? normalizeMobile(mobileRaw) : '';
    if (mobile === null) {
      badMobiles.push(`${flat}: ${mobileRaw}`);
      continue;
    }
    rows.push({ unit_id: unitId, name, mobile });
  }
  return { rows, unknownFlats, badMobiles };
}
