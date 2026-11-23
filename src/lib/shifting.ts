// Shifting (Phase 11C)
export const DIRECTION_LABELS: Record<string, string> = { in: 'Moving in', out: 'Moving out' };
export const DEPOSIT_LABELS: Record<string, string> = { none: 'No deposit', held: 'Deposit held', refunded: 'Deposit refunded', cancelled: 'Bill cancelled' };
export const SHIFTING_WARNING = 'Charge only what your bye-laws or a general body resolution allow.';

const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const hhmm = (t: string) => t.slice(0, 5);

export interface ShiftingDraft { direction: string; date: string; time: string; vehicle: string }

/** The checks create_shifting_request makes, with the same messages (`today`, `from`, `to` as YYYY-MM-DD / HH:MM) */
export function shiftingDraftError(d: ShiftingDraft, today: string, from: string, to: string): string | null {
  if (d.direction !== 'in' && d.direction !== 'out') return 'Choose moving in or moving out';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || d.date < today || d.date > addDays(today, 90)) return 'Choose a date from today up to 90 days ahead';
  if (!/^\d{2}:\d{2}/.test(d.time) || hhmm(d.time) < hhmm(from) || hhmm(d.time) > hhmm(to)) return `Shifting is allowed between ${hhmm(from)} and ${hhmm(to)}`;
  if (d.vehicle.trim().replace(/\s+/g, ' ').length > 80) return 'Vehicle details can be up to 80 characters';
  return null;
}

export function refundSplit(deposit: number, kept: number): { refund: number; kept: number; error: string | null } {
  if (!(kept >= 0) || kept > deposit) return { refund: deposit, kept: 0, error: 'The amount kept can be at most the deposit' };
  return { refund: Math.round((deposit - kept) * 100) / 100, kept, error: null };
}
