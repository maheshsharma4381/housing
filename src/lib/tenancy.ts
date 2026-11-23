// Tenant registration (Phase 11B)
import { normalizeMobile } from './mobile.ts';

export type TenancyState = 'active' | 'ending' | 'expired' | 'ended' | 'renewed';

export const TENANCY_STATE_LABELS: Record<TenancyState, string> = {
  active: 'Active', ending: 'Ends soon', expired: 'Agreement expired', ended: 'Ended', renewed: 'Renewed',
};

const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMonths = (iso: string, n: number) => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, d)); return t.toISOString().slice(0, 10); };

/** `today` as YYYY-MM-DD. Ends soon = 30 days or fewer left. */
export function tenancyState(t: { status: string; start_date: string; end_date: string }, today: string): TenancyState {
  if (t.status === 'ended') return 'ended';
  if (t.status === 'renewed') return 'renewed';
  if (t.end_date < today) return 'expired';
  return t.end_date <= addDays(today, 30) ? 'ending' : 'active';
}

export interface TenancyDraft {
  tenant_name: string; tenant_mobile: string; tenant_email: string; occupants: number;
  start_date: string; end_date: string; police_ref: string;
}

/** The checks create_tenancy_request makes, with the same messages */
export function tenancyDraftError(d: TenancyDraft): string | null {
  const name = d.tenant_name.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80) return "Enter the tenant's name (2 to 80 characters)";
  if (!normalizeMobile(d.tenant_mobile)) return 'Enter a valid mobile number';
  const email = d.tenant_email.trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'Enter a valid email address';
  if (!Number.isInteger(d.occupants) || d.occupants < 1 || d.occupants > 20) return 'Number of people living there: 1 to 20';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(d.end_date)
      || d.end_date <= d.start_date || d.end_date > addMonths(d.start_date, 60)) {
    return 'The agreement must end after it starts, within 60 months';
  }
  if (d.police_ref.trim().length > 60) return 'The police reference can be up to 60 characters';
  return null;
}
