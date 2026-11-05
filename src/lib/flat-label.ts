// Flats in a list. Setup names flats with their wing ("A-101"), but a CSV import can have "101" in wing A
// and "101" in wing B: those need the wing to be told apart (and a key that does not collide).

export interface FlatRef { wing: string | null; unit_number: string }

export const flatKey = (r: FlatRef) => `${r.wing ?? ''}|${r.unit_number}`;

/** "A-101", "A101", "A 101" already carry wing A; a numeric wing only counts with a separator ("1-101"). */
function carriesWing(r: FlatRef): boolean {
  const wing = (r.wing ?? '').trim().toLowerCase();
  const n = r.unit_number.trim().toLowerCase();
  if (!wing || !n.startsWith(wing) || n.length === wing.length) return false;
  const next = n[wing.length];
  return /[-\s/]/.test(next) || (/^[a-z]+$/.test(wing) && /\d/.test(next));
}

/** One label per row: the number, with its wing added only where the same number is in two or more wings. */
export function flatLabels(rows: FlatRef[]): string[] {
  const wingsOf = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = wingsOf.get(r.unit_number) ?? new Set<string>();
    set.add(r.wing ?? '');
    wingsOf.set(r.unit_number, set);
  }
  return rows.map(r => ((wingsOf.get(r.unit_number)?.size ?? 0) > 1 && r.wing && !carriesWing(r) ? `${r.wing}-${r.unit_number}` : r.unit_number));
}
