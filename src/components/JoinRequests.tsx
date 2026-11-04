'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatMobile } from '../lib/mobile';
import { Banner } from './Banner';
import { UserPlus, Loader2 } from 'lucide-react';

interface JoinRequestRow {
  id: string;
  full_name: string;
  mobile: string | null;
  flat_hint: string | null;
  created_at: string;
}

const inputClass = 'bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500';

const RequestCard: React.FC<{
  r: JoinRequestRow; units: { id: string; unit_number: string }[]; canDecide: boolean; onDone: (msg: string) => void;
}> = ({ r, units, canDecide, onDone }) => {
  const guess = units.find(u => u.unit_number.trim().toLowerCase() === (r.flat_hint ?? '').trim().toLowerCase());
  const [unitId, setUnitId] = useState(guess?.id ?? '');
  const [role, setRole] = useState<'resident_owner' | 'resident_tenant'>('resident_owner');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (approve: boolean) => {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc('decide_join_request', {
      p_request_id: r.id, p_approve: approve, p_unit_id: approve ? unitId || null : null,
      p_role: role, p_note: approve ? null : reason,
    });
    setBusy(false);
    if (err) return setError(err.message);
    onDone(approve ? `${r.full_name} has joined.` : `${r.full_name}'s request was rejected.`);
  };

  return (
    <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-bold text-white text-sm">{r.full_name}</span>
        <span className="text-slate-500">{new Date(r.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
      </div>
      <div className="text-slate-400">
        {r.mobile && <>Mobile: <strong className="text-white">{formatMobile(r.mobile)}</strong> · </>}
        Says flat: <strong className="text-white">{r.flat_hint || '—'}</strong>
      </div>
      <Banner tone="error">{error}</Banner>
      {canDecide && !rejecting && (
        <div className="flex flex-wrap items-center gap-2">
          <select className={inputClass} value={unitId} onChange={e => setUnitId(e.target.value)} aria-label="Flat">
            <option value="">Choose the flat</option>
            {[...units]
              .sort((a, b) => a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true }))
              .map(u => <option key={u.id} value={u.id}>{u.unit_number}</option>)}
          </select>
          <select className={inputClass} value={role} onChange={e => setRole(e.target.value as typeof role)} aria-label="Role">
            <option value="resident_owner">Owner</option>
            <option value="resident_tenant">Tenant</option>
          </select>
          <button onClick={() => decide(true)} disabled={busy || !unitId} className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold cursor-pointer disabled:opacity-50 flex items-center gap-1.5">
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Approve
          </button>
          <button onClick={() => setRejecting(true)} className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-rose-300 font-semibold cursor-pointer">Reject</button>
        </div>
      )}
      {canDecide && rejecting && (
        <div className="flex flex-wrap items-center gap-2">
          <input className={`${inputClass} flex-1 min-w-[12rem]`} placeholder="Reason (they will see it)" value={reason} onChange={e => setReason(e.target.value)} />
          <button onClick={() => decide(false)} disabled={busy || !reason.trim()} className="px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold cursor-pointer disabled:opacity-50">Reject</button>
          <button onClick={() => setRejecting(false)} className="px-3 py-2 rounded-xl bg-slate-800 text-slate-300 cursor-pointer">Cancel</button>
        </div>
      )}
    </div>
  );
};

/** People who opened the joining link without a matching owner mobile (031). */
export const JoinRequests: React.FC<{
  societyId: string; units: { id: string; unit_number: string }[]; canDecide: boolean; onDecided?: () => void;
}> = ({ societyId, units, canDecide, onDecided }) => {
  const [rows, setRows] = useState<JoinRequestRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data, error: err } = await supabase
      .from('join_requests')
      .select('id, full_name, mobile, flat_hint, created_at')
      .eq('society_id', societyId)
      .eq('status', 'pending')
      .order('created_at');
    if (err) setError(err.message);
    else setRows((data ?? []) as JoinRequestRow[]);
  }, [societyId]);

  useEffect(() => {
    load();
  }, [load]);

  if (rows.length === 0 && !error && !notice) return null;

  return (
    <section className="space-y-3 text-xs">
      <h2 className="text-lg font-bold text-white flex items-center gap-2"><UserPlus className="w-5 h-5 text-sky-400" /> Join requests</h2>
      <p className="text-slate-400">They opened your joining link, but their mobile did not match a flat&apos;s owner. Check who they are before you approve.</p>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>
      {rows.map(r => (
        <RequestCard key={r.id} r={r} units={units} canDecide={canDecide} onDone={(msg) => { setNotice(msg); load(); onDecided?.(); }} />
      ))}
    </section>
  );
};
