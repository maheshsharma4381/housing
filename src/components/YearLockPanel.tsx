'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { fyLabel } from '../lib/tds';
import { Banner } from './Banner';
import { Lock, Loader2 } from 'lucide-react';

interface YearLock { fy_end: string; locked_at: string; note: string | null }

/** After the audit, lock the year so nothing can be posted into it any more. */
export const YearLockPanel: React.FC<{ societyId: string; canLock: boolean }> = ({ societyId, canLock }) => {
  const now = new Date();
  const lastEnded = `${now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1}-03-31`;
  const [locks, setLocks] = useState<YearLock[]>([]);
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data } = await supabase.from('financial_year_locks').select('fy_end, locked_at, note').eq('society_id', societyId).order('fy_end', { ascending: false });
    setLocks((data ?? []) as YearLock[]);
  }, [societyId]);

  useEffect(() => {
    load();
  }, [load]);

  const lockedUntil = locks[0]?.fy_end;
  const canLockLast = canLock && (!lockedUntil || lockedUntil < lastEnded);

  const lock = async () => {
    if (!supabase) return;
    setBusy(true);
    const { error: rpcErr } = await supabase.rpc('lock_financial_year', { p_society_id: societyId, p_fy_end: lastEnded, p_note: note || null });
    setBusy(false);
    setConfirming(false);
    if (rpcErr) return setError(rpcErr.message);
    setError(null);
    setNotice(`${fyLabel(lastEnded)} is locked. Late receipts or bills dated in it will be posted on 1 April.`);
    load();
  };

  return (
    <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-3 text-xs">
      <div className="font-bold text-white flex items-center gap-2"><Lock className="w-4 h-4 text-amber-300" /> Year-end lock</div>
      <p className="text-slate-400">Lock a financial year once the CA has finished the audit. Adjustments, opening balances and depreciation can no longer be dated in it; anything else that arrives late is posted on the first day of the open year. Only Sahvaas support can unlock.</p>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>
      {locks.length > 0 && (
        <ul className="space-y-1 text-slate-300">
          {locks.map(l => <li key={l.fy_end}>🔒 {fyLabel(l.fy_end)} locked on {new Date(l.locked_at).toLocaleDateString('en-IN')}{l.note ? ` — ${l.note}` : ''}</li>)}
        </ul>
      )}
      {canLockLast && (confirming ? (
        <div className="flex flex-wrap gap-2">
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="Note, e.g. audited by CA Priya Iyer on 12 Sep" className="flex-1 min-w-[220px] bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-amber-500" />
          <button onClick={lock} disabled={busy} className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-semibold cursor-pointer disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : `Lock ${fyLabel(lastEnded)} for good`}
          </button>
          <button onClick={() => setConfirming(false)} className="px-3 rounded-xl bg-slate-800 text-slate-300 cursor-pointer">Cancel</button>
        </div>
      ) : (
        <button onClick={() => setConfirming(true)} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-amber-300 font-semibold cursor-pointer">Lock {fyLabel(lastEnded)}…</button>
      ))}
    </div>
  );
};
