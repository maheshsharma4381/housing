'use client';
// Phase 11D: the transfer fee and premium the committee bills on a sale, and whether shifting must be booked first.
import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import { TRANSFER_WARNING, transferFeeError } from '../lib/transfer';

export const TransferSettings: React.FC<{ societyId: string }> = ({ societyId }) => {
  const [v, setV] = useState({ transfer_fee: '500', transfer_premium: '0', shifting_required: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    void supabase.from('society_settings').select('transfer_fee, transfer_premium, shifting_required').eq('society_id', societyId).maybeSingle()
      .then(({ data }) => {
        const d = data as { transfer_fee: number; transfer_premium: number; shifting_required: boolean } | null;
        if (d) setV({ transfer_fee: String(d.transfer_fee), transfer_premium: String(d.transfer_premium), shifting_required: d.shifting_required });
      });
  }, [societyId]);

  const save = async () => {
    const fee = Number(v.transfer_fee || 0);
    const premium = Number(v.transfer_premium || 0);
    const problem = transferFeeError(fee, premium);
    if (problem) return setError(problem);
    if (!supabase) return;
    setBusy(true); setError(null); setDone(null);
    const { error: err } = await supabase.rpc('set_transfer_settings', {
      p_society_id: societyId, p_settings: { transfer_fee: fee, transfer_premium: premium, shifting_required: v.shifting_required },
    });
    setBusy(false);
    if (err) return setError(err.message);
    setDone('Saved. The fees are filled in when you bill a sale; you can change them for each one.');
  };
  const inputClass = 'w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white';

  return (
    <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2 text-xs">
      <div className="font-bold text-white">Sale and transfer</div>
      <Banner tone="info">{TRANSFER_WARNING}</Banner>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{done}</Banner>
      <div className="grid sm:grid-cols-2 gap-2">
        <label className="text-slate-400">Transfer fee (₹)<input type="number" min={0} max={100000} value={v.transfer_fee} onChange={e => setV({ ...v, transfer_fee: e.target.value })} className={inputClass} /></label>
        <label className="text-slate-400">Transfer premium (₹, at most 25,000)<input type="number" min={0} max={25000} value={v.transfer_premium} onChange={e => setV({ ...v, transfer_premium: e.target.value })} className={inputClass} /></label>
      </div>
      <p className="text-slate-400">Fees go to the ledgers &ldquo;Transfer fees&rdquo; and &ldquo;Transfer premium&rdquo;. A sale is approved only when the flat has no dues.</p>
      <label className="flex items-center gap-1.5 text-slate-300">
        <input type="checkbox" checked={v.shifting_required} onChange={e => setV({ ...v, shifting_required: e.target.checked })} />
        Require a shifting booking first: moving in before a tenant is approved, moving out before a sale is approved
      </label>
      <button onClick={save} disabled={busy} className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold disabled:opacity-50 cursor-pointer">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}</button>
    </div>
  );
};
