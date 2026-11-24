'use client';
// Phase 11D: the seller applies to transfer the flat to a buyer. The committee checks the papers, bills the fees and approves.
import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import { transferDraftError, type TransferDraft } from '../lib/transfer';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

export const TransferForm: React.FC<{ unitId: string; flatLabel: string; onDone: () => void; onCancel: () => void }> = ({ unitId, flatLabel, onDone, onCancel }) => {
  const [d, setD] = useState<TransferDraft>({ buyer_name: '', buyer_mobile: '', buyer_email: '', deed_date: '', deed_number: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const problem = transferDraftError(d, today());
    if (problem) return setError(problem);
    if (!supabase) return;
    setBusy(true); setError(null);
    const { error: err } = await supabase.rpc('create_transfer_request', { p_unit_id: unitId, p_details: d });
    setBusy(false);
    if (err) return setError(err.message);
    onDone();
  };
  const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500';

  return (
    <div className="p-4 rounded-2xl bg-slate-900 border border-sky-500/40 space-y-2 text-xs">
      <div className="font-bold text-white text-sm">Transfer flat {flatLabel} to a buyer</div>
      <p className="text-slate-400">The committee approves the transfer once the documents are in, the original share certificate is handed over and the flat has no dues. The buyer then joins with their mobile number.</p>
      <Banner tone="error">{error}</Banner>
      <input value={d.buyer_name} onChange={e => setD({ ...d, buyer_name: e.target.value })} maxLength={120} placeholder="Buyer's full name (as on the sale deed)" className={inputClass} />
      <div className="grid sm:grid-cols-2 gap-2">
        <input value={d.buyer_mobile} onChange={e => setD({ ...d, buyer_mobile: e.target.value })} maxLength={20} inputMode="tel" placeholder="Buyer's mobile" className={inputClass} />
        <input value={d.buyer_email} onChange={e => setD({ ...d, buyer_email: e.target.value })} maxLength={160} type="email" placeholder="Buyer's email (optional)" className={inputClass} />
      </div>
      <div className="grid sm:grid-cols-2 gap-2">
        <label className="text-slate-400">Sale deed date<input type="date" value={d.deed_date} max={today()} onChange={e => setD({ ...d, deed_date: e.target.value })} className={`${inputClass} mt-1`} /></label>
        <label className="text-slate-400">Registration No. (optional)<input value={d.deed_number} onChange={e => setD({ ...d, deed_number: e.target.value })} maxLength={40} placeholder="As on the Index II" className={`${inputClass} mt-1`} /></label>
      </div>
      <div className="flex gap-2">
        <button onClick={submit} disabled={busy} className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold disabled:opacity-50 cursor-pointer">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send to the committee'}</button>
        <button onClick={onCancel} className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 cursor-pointer">Cancel</button>
      </div>
    </div>
  );
};
