'use client';
// Phase 11B: a list of tenancies with their state, and ending one. Used by the committee (all flats) and owners (their flats).
import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Home } from 'lucide-react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import { EmptyState } from './EmptyState';
import { tenancyState, TENANCY_STATE_LABELS } from '../lib/tenancy';
import { formatMobile } from '../lib/mobile';

export interface TenancyRow {
  id: string; unit_id: string; tenant_name: string; tenant_mobile: string; tenant_email: string | null; occupants: number;
  start_date: string; end_date: string; status: string; ended_on: string | null; police_ref: string | null;
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const TONE: Record<string, string> = { active: 'text-emerald-300', ending: 'text-amber-300', expired: 'text-rose-300', ended: 'text-slate-500', renewed: 'text-slate-500' };

export const Tenancies: React.FC<{
  societyId: string; unitIds?: string[]; labels: Record<string, string>; canEnd: boolean; showPast: boolean;
  onRenew?: (t: TenancyRow) => void; refreshKey?: number;
}> = ({ societyId, unitIds, labels, canEnd, showPast, onRenew, refreshKey }) => {
  const [rows, setRows] = useState<TenancyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unitKey = (unitIds ?? []).join(',');

  const load = useCallback(async () => {
    if (!supabase) return;
    let query = supabase.from('tenancies').select('*').eq('society_id', societyId).order('end_date');
    if (unitKey) query = query.in('unit_id', unitKey.split(','));
    if (!showPast) query = query.eq('status', 'active');
    const { data } = await query.limit(500);
    setRows((data as TenancyRow[]) ?? []);
    setLoading(false);
  }, [societyId, unitKey, showPast]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const end = async (t: TenancyRow) => {
    if (!supabase || !window.confirm(`End the tenancy of ${t.tenant_name}? The tenant loses access to flat ${labels[t.unit_id] ?? ''} in Sahvaas.`)) return;
    setBusy(t.id); setError(null);
    const { error: err } = await supabase.rpc('end_tenancy', { p_tenancy_id: t.id, p_end_date: null });
    setBusy(null);
    if (err) return setError(err.message);
    void load();
  };

  if (loading) return <Loader2 className="w-4 h-4 animate-spin text-slate-500" />;
  if (rows.length === 0) return <EmptyState icon={Home} title="No tenants" description="Registered tenants appear here with their agreement dates." />;
  const now = today();
  return (
    <div className="space-y-2 text-xs">
      <Banner tone="error">{error}</Banner>
      {rows.map(t => {
        const state = tenancyState(t, now);
        return (
          <div key={t.id} className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="text-white font-semibold">Flat {labels[t.unit_id] ?? ''} · {t.tenant_name}</div>
              <div className="text-slate-400">{formatMobile(t.tenant_mobile)}{t.tenant_email ? ` · ${t.tenant_email}` : ''} · {t.occupants} {t.occupants === 1 ? 'person' : 'people'}</div>
              <div className="text-slate-400">Agreement {t.start_date} to {t.end_date}{t.ended_on ? ` · ended ${t.ended_on}` : ''}{t.police_ref ? ` · police ref ${t.police_ref}` : ''}</div>
            </div>
            <div className="text-right space-y-1">
              <div className={`font-semibold ${TONE[state]}`}>{TENANCY_STATE_LABELS[state]}</div>
              {t.status === 'active' && (
                <div className="flex gap-3 justify-end">
                  {onRenew && <button onClick={() => onRenew(t)} className="text-sky-300 cursor-pointer">Renew</button>}
                  {canEnd && <button onClick={() => end(t)} disabled={busy !== null} className="text-rose-300 cursor-pointer">{busy === t.id ? 'Ending…' : 'Tenant moved out'}</button>}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
