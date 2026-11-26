'use client';
// Phase 11C: book a move-in or move-out for a flat. The committee approves it and the charges are billed to the flat.
import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import { shiftingDraftError, type ShiftingDraft } from '../lib/shifting';
import { formatINR } from '../lib/inr';

interface Settings { move_in_charge: number; move_in_deposit: number; move_out_charge: number; move_out_deposit: number; shifting_from: string; shifting_to: string }
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

export const ShiftingForm: React.FC<{ societyId: string; unitId: string; flatLabel: string; onDone: () => void; onCancel: () => void }> = ({ societyId, unitId, flatLabel, onDone, onCancel }) => {
  const [s, setS] = useState<Settings | null>(null);
  const [d, setD] = useState<ShiftingDraft>({ direction: 'in', date: today(), time: '10:00', vehicle: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    void supabase.from('society_settings').select('move_in_charge, move_in_deposit, move_out_charge, move_out_deposit, shifting_from, shifting_to')
      .eq('society_id', societyId).maybeSingle().then(({ data }) => setS((data as Settings) ?? null));
  }, [societyId]);

  const from = (s?.shifting_from ?? '08:00').slice(0, 5);
  const to = (s?.shifting_to ?? '20:00').slice(0, 5);
  const charge = Number((d.direction === 'in' ? s?.move_in_charge : s?.move_out_charge) ?? 0);
  const deposit = Number((d.direction === 'in' ? s?.move_in_deposit : s?.move_out_deposit) ?? 0);

  const submit = async () => {
    const problem = shiftingDraftError(d, today(), from, to);
    if (problem) return setError(problem);
    if (!supabase) return;
    setBusy(true); setError(null);
    const { error: err } = await supabase.rpc('create_shifting_request', { p_unit_id: unitId, p_details: d });
    setBusy(false);
    if (err) return setError(err.message);
    onDone();
  };
  const inputClass = 'w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand';

  return (
    <div className="p-4 rounded-xl bg-surface border border-brand/40 space-y-2 text-xs">
      <div className="font-semibold text-fg text-sm">Book shifting for flat {flatLabel}</div>
      <Banner tone="error">{error}</Banner>
      <div className="flex gap-3 text-fg">
        <label className="flex items-center gap-1"><input type="radio" checked={d.direction === 'in'} onChange={() => setD({ ...d, direction: 'in' })} /> Moving in</label>
        <label className="flex items-center gap-1"><input type="radio" checked={d.direction === 'out'} onChange={() => setD({ ...d, direction: 'out' })} /> Moving out</label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-fg-muted">Date<input type="date" value={d.date} onChange={e => setD({ ...d, date: e.target.value })} className={`${inputClass} mt-1`} /></label>
        <label className="text-fg-muted">Time ({from}–{to})<input type="time" value={d.time} onChange={e => setD({ ...d, time: e.target.value })} className={`${inputClass} mt-1`} /></label>
      </div>
      <input value={d.vehicle} onChange={e => setD({ ...d, vehicle: e.target.value })} maxLength={80} placeholder="Vehicle (optional), e.g. Tempo MH12 AB 1234" className={inputClass} />
      <div className="text-fg">
        {charge > 0 || deposit > 0
          ? <>On approval the flat is billed {charge > 0 ? `${formatINR(charge)} shifting charges` : ''}{charge > 0 && deposit > 0 ? ' and ' : ''}{deposit > 0 ? `${formatINR(deposit)} refundable deposit` : ''}.</>
          : 'The society does not charge for shifting.'}
      </div>
      <div className="flex gap-2">
        <button onClick={submit} disabled={busy} className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold disabled:opacity-50 cursor-pointer">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send to the committee'}</button>
        <button onClick={onCancel} className="px-4 py-2 rounded-lg bg-surface-muted text-fg cursor-pointer">Cancel</button>
      </div>
    </div>
  );
};
