'use client';
// Phase 11C: shifting charges, refundable deposits and allowed hours.
import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import { SHIFTING_WARNING } from '../lib/shifting';

const FIELDS = [
  ['move_in_charge', 'Moving in: charge (not refundable)'], ['move_in_deposit', 'Moving in: refundable deposit'],
  ['move_out_charge', 'Moving out: charge (not refundable)'], ['move_out_deposit', 'Moving out: refundable deposit'],
] as const;

export const ShiftingSettings: React.FC<{ societyId: string }> = ({ societyId }) => {
  const [v, setV] = useState<Record<string, string>>({ move_in_charge: '0', move_in_deposit: '0', move_out_charge: '0', move_out_deposit: '0', shifting_from: '08:00', shifting_to: '20:00' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    void supabase.from('society_settings').select('move_in_charge, move_in_deposit, move_out_charge, move_out_deposit, shifting_from, shifting_to')
      .eq('society_id', societyId).maybeSingle().then(({ data }) => {
        if (!data) return;
        const d = data as Record<string, string | number>;
        setV({ move_in_charge: String(d.move_in_charge), move_in_deposit: String(d.move_in_deposit), move_out_charge: String(d.move_out_charge),
          move_out_deposit: String(d.move_out_deposit), shifting_from: String(d.shifting_from).slice(0, 5), shifting_to: String(d.shifting_to).slice(0, 5) });
      });
  }, [societyId]);

  const save = async () => {
    if (!supabase) return;
    setBusy(true); setError(null); setDone(null);
    const { error: err } = await supabase.rpc('set_shifting_settings', {
      p_society_id: societyId,
      p_settings: { ...Object.fromEntries(FIELDS.map(([k]) => [k, Number(v[k] || 0)])), shifting_from: v.shifting_from, shifting_to: v.shifting_to },
    });
    setBusy(false);
    if (err) return setError(err.message);
    setDone('Shifting settings saved. They apply to bookings approved from now.');
  };

  return (
    <div className="p-4 rounded-xl bg-surface border border-border space-y-2 text-xs">
      <div className="font-semibold text-fg">Shifting charges and hours</div>
      <Banner tone="info">{SHIFTING_WARNING}</Banner>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{done}</Banner>
      <div className="grid sm:grid-cols-2 gap-2">
        {FIELDS.map(([k, label]) => (
          <label key={k} className="text-fg-muted">{label} (₹)
            <input type="number" min={0} max={100000} value={v[k]} onChange={e => setV({ ...v, [k]: e.target.value })} className="w-full mt-1 bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg" />
          </label>
        ))}
        <label className="text-fg-muted">Shifting allowed from<input type="time" value={v.shifting_from} onChange={e => setV({ ...v, shifting_from: e.target.value })} className="w-full mt-1 bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg" /></label>
        <label className="text-fg-muted">until<input type="time" value={v.shifting_to} onChange={e => setV({ ...v, shifting_to: e.target.value })} className="w-full mt-1 bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg" /></label>
      </div>
      <p className="text-fg-muted">The refundable deposit is kept in the ledger &ldquo;Deposits received&rdquo; until it is refunded; any amount kept goes to &ldquo;Damage recovery&rdquo;.</p>
      <button onClick={save} disabled={busy} className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold disabled:opacity-50 cursor-pointer">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}</button>
    </div>
  );
};
