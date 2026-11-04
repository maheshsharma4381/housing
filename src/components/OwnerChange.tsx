'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { describeNotify, notify } from '../lib/notify';
import { Banner } from './Banner';
import { Loader2, UserRoundCog } from 'lucide-react';

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500';

/**
 * Owner change (029): the old owner loses the flat, the new owner is invited, and the flat keeps its ledger.
 * Any dues stay with the flat; the new owner pays them once they join.
 */
export const OwnerChange: React.FC<{ societyId: string; unitId: string; unitLabel: string; onDone: () => void }> = ({ unitId, unitLabel, onDone }) => {
  const [balance, setBalance] = useState<{ dues: number; advance: number } | null>(null);
  const [form, setForm] = useState({ name: '', mobile: '', email: '', date: todayIso() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.rpc('flat_balance', { p_unit_id: unitId }).then(({ data, error: err }) => {
      if (err) setError(err.message);
      else setBalance({ dues: Number((data as { dues: number }).dues), advance: Number((data as { advance: number }).advance) });
    });
  }, [unitId]);

  const save = async () => {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase.rpc('transfer_flat_owner', {
      p_unit_id: unitId, p_new_owner_name: form.name, p_new_owner_email: form.email.trim() || null,
      p_new_owner_mobile: form.mobile || null, p_transfer_date: form.date,
    });
    if (err) {
      setBusy(false);
      return setError(err.message);
    }
    // Email the invite, as Members does (an owner named by mobile alone logs in with it instead)
    const emailed = form.email.trim() ? await notify('member_invite', (data as { invite_id: string }).invite_id) : null;
    setBusy(false);
    setNotice(form.email.trim()
      ? `Owner change recorded. Invite saved for ${form.email}.${describeNotify(emailed, 'person')}`
      : `Owner change recorded. ${form.name} logs in with ${form.mobile} and joins the flat.`);
    onDone();
  };

  return (
    <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
      <div className="font-semibold text-white flex items-center gap-1.5"><UserRoundCog className="w-3.5 h-3.5 text-sky-400" /> Owner change</div>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>
      {balance && balance.dues > 0 && (
        <div className="px-3 py-2 rounded-xl bg-amber-500/10 text-amber-200">
          {unitLabel} has {formatINR(balance.dues)} due. Usually the old owner clears dues before selling; if not, the dues stay with the flat and the new owner pays them.
        </div>
      )}
      {balance && balance.advance > 0 && (
        <div className="px-3 py-2 rounded-xl bg-sky-500/10 text-sky-200">{unitLabel} has {formatINR(balance.advance)} paid in advance; it stays with the flat.</div>
      )}
      {!notice && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="space-y-1"><span className="text-slate-400">New owner&apos;s name</span>
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className={inputClass} /></label>
          <label className="space-y-1"><span className="text-slate-400">Mobile (they log in with it)</span>
            <input inputMode="tel" value={form.mobile} onChange={e => setForm({ ...form, mobile: e.target.value })} className={inputClass} /></label>
          <label className="space-y-1"><span className="text-slate-400">Email (optional)</span>
            <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} className={inputClass} /></label>
          <label className="space-y-1"><span className="text-slate-400">Transfer date</span>
            <input type="date" max={todayIso()} value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className={inputClass} /></label>
          <button onClick={save} disabled={busy || form.name.trim().length < 2 || (!form.mobile.trim() && !form.email.includes('@')) || !form.date}
            className="sm:col-span-2 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer disabled:opacity-50">
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Record owner change
          </button>
        </div>
      )}
    </div>
  );
};
