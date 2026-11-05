// Indian financial year (1 April – 31 March) for statements.

/** A local calendar date as YYYY-MM-DD (not UTC: in India, toISOString is yesterday until 05:30). */
export const localIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** "This year" runs from 1 April to today; "Last year" is the whole previous April to March. */
export function fyRange(which: 'this' | 'last', today: Date = new Date()): { from: string; to: string } {
  const startYear = (today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1) - (which === 'last' ? 1 : 0);
  const end = `${startYear + 1}-03-31`;
  const now = localIso(today);
  return { from: `${startYear}-04-01`, to: which === 'this' && now < end ? now : end };
}
