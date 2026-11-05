// The setup wizard's decisions (spec 9.1), kept out of the screen so they can be tested.

export type SetupStep = 'society' | 'flats' | 'maintenance' | 'upi' | 'owners' | 'done';
export interface SetupStatus {
  steps: string[]; flats: number; rules: number; upi: boolean; owners_entered: number; joined_owners: number; bills: number;
}

/** Resume at the first step not yet done — whether it was done in the wizard or elsewhere (Excel, Settings, Billing). */
export function nextSetupStep(s: SetupStatus): SetupStep {
  const done = new Set(s.steps);
  if (s.bills > 0) return 'done';
  if (s.flats === 0) return 'flats';
  if (s.rules === 0) return 'maintenance';
  if (!s.upi && !done.has('upi') && !done.has('upi_skipped')) return 'upi';
  if (s.owners_entered === 0 && s.joined_owners === 0 && !done.has('owners') && !done.has('owners_skipped')) return 'owners';
  return 'done';
}

/**
 * The step "Back" returns to. The society cannot be registered again once it exists, so neither Society nor
 * Flats has a step before it; going back to Flats shows the flats already made, with Continue.
 */
export function previousSetupStep(step: SetupStep): SetupStep | null {
  const back: Partial<Record<SetupStep, SetupStep>> = { maintenance: 'flats', upi: 'maintenance', owners: 'upi', done: 'owners' };
  return back[step] ?? null;
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The first bills cover this month. They fall due on the society's due day, but never in less than a week:
 * a bill issued on the 11th with due day 10 would be overdue (and charged a late fee) that very night.
 */
export function firstBillDates(today: Date, dueDay: number): { start: string; end: string; due: string } {
  const y = today.getFullYear();
  const m = today.getMonth();
  const day = Math.min(Math.max(dueDay, 1), 28);
  const weekAway = new Date(y, m, today.getDate() + 7);
  const thisMonth = new Date(y, m, day);
  const due = thisMonth >= weekAway ? thisMonth : new Date(y, m + 1, day);
  return { start: iso(new Date(y, m, 1)), end: iso(new Date(y, m + 1, 0)), due: iso(due) };
}

// UPI VPA: handle@psp (palmheights@icici) — an email address is not one, and payments to it fail
const UPI_ID_PATTERN = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/;
export const isValidUpiId = (upi: string) => UPI_ID_PATTERN.test(upi.trim());
