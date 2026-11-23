'use client';
// Phase 11B: register a tenant (or renew a tenancy) for a flat. Goes to the committee as a request.
import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import { tenancyDraftError, type TenancyDraft } from '../lib/tenancy';

export const TenancyForm: React.FC<{
  unitId: string; flatLabel: string; renews?: { id: string; tenant_name: string; tenant_mobile: string; tenant_email: string | null; occupants: number; end_date: string } | null;
  onDone: () => void; onCancel: () => void;
}> = ({ unitId, flatLabel, renews, onDone, onCancel }) => {
  const next = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
  const [d, setD] = useState<TenancyDraft>(() => renews
    ? { tenant_name: renews.tenant_name, tenant_mobile: renews.tenant_mobile, tenant_email: renews.tenant_email ?? '', occupants: renews.occupants,
        start_date: next(renews.end_date), end_date: '', police_ref: '' }
    : { tenant_name: '', tenant_mobile: '', tenant_email: '', occupants: 1, start_date: '', end_date: '', police_ref: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500';

  const submit = async () => {
    const problem = tenancyDraftError(d);
    if (problem) return setError(problem);
    if (!supabase) return;
    setBusy(true); setError(null);
    const { error: err } = await supabase.rpc('create_tenancy_request', { p_unit_id: unitId, p_details: { ...d, renews_id: renews?.id ?? null } });
    setBusy(false);
    if (err) return setError(err.message);
    onDone();
  };

  return (
    <div className="p-4 rounded-2xl bg-slate-900 border border-sky-500/40 space-y-2 text-xs">
      <div className="font-bold text-white text-sm">{renews ? `Renew the tenancy of flat ${flatLabel}` : `Register a tenant for flat ${flatLabel}`}</div>
      <Banner tone="error">{error}</Banner>
      <input value={d.tenant_name} onChange={e => setD({ ...d, tenant_name: e.target.value })} maxLength={80} placeholder="Tenant's name" className={inputClass} />
      <div className="grid grid-cols-2 gap-2">
        <input value={d.tenant_mobile} onChange={e => setD({ ...d, tenant_mobile: e.target.value })} inputMode="tel" placeholder="Tenant's mobile" readOnly={!!renews}
          title={renews ? 'A renewal is for the same tenant. To change the tenant, end this tenancy and register the new one.' : undefined} className={inputClass} />
        <input value={d.tenant_email} onChange={e => setD({ ...d, tenant_email: e.target.value })} type="email" placeholder="Email (optional)" className={inputClass} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <label className="text-slate-400">Agreement from<input type="date" value={d.start_date} onChange={e => setD({ ...d, start_date: e.target.value })} className={`${inputClass} mt-1`} /></label>
        <label className="text-slate-400">to<input type="date" value={d.end_date} onChange={e => setD({ ...d, end_date: e.target.value })} className={`${inputClass} mt-1`} /></label>
        <label className="text-slate-400">People living there<input type="number" min={1} max={20} value={d.occupants} onChange={e => setD({ ...d, occupants: Number(e.target.value) })} className={`${inputClass} mt-1`} /></label>
      </div>
      <input value={d.police_ref} onChange={e => setD({ ...d, police_ref: e.target.value })} maxLength={60} placeholder="Police intimation reference (optional)" className={inputClass} />
      <p className="text-slate-400">After sending, add the agreement, the police papers and the tenant&apos;s ID on the request. The tenant gets an invite once the committee approves.</p>
      <div className="flex gap-2">
        <button onClick={submit} disabled={busy} className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold disabled:opacity-50 cursor-pointer">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send to the committee'}</button>
        <button onClick={onCancel} className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 cursor-pointer">Cancel</button>
      </div>
    </div>
  );
};
