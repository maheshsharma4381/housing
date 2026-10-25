'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { fyLabel } from '../lib/tds';
import { Banner } from './Banner';
import { History, Loader2, Save } from 'lucide-react';

interface Account { code: string; name: string; type: string }
type Entry = { debit: number; credit: number };

const TYPE_ORDER = ['asset', 'liability', 'equity', 'income', 'expense'];
const TYPE_LABEL: Record<string, string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Funds & reserves', income: 'Income', expense: 'Expenditure' };

/** Last financial year that has ended, as its 31 March. */
function lastEndedFy(d = new Date()) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-03-31`;
}

/**
 * Last year's audited trial balance, typed in once so the reports can show comparatives
 * for the first year on Sahvaas. Does not post anything to the books.
 */
export const PriorYearEditor: React.FC<{ societyId: string; canEdit: boolean }> = ({ societyId, canEdit }) => {
  const latest = lastEndedFy();
  const [fyEnd, setFyEnd] = useState(latest);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [busy, setBusy] = useState<'load' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    setBusy('load');
    const [aRes, pRes] = await Promise.all([
      supabase.from('accounts').select('code, name, type').eq('society_id', societyId).order('code'),
      supabase.from('prior_year_balances').select('account_code, amount').eq('society_id', societyId).eq('fy_end', fyEnd),
    ]);
    setBusy(null);
    if (aRes.error) return setError(aRes.error.message);
    setAccounts((aRes.data ?? []) as Account[]);
    const next: Record<string, Entry> = {};
    for (const r of pRes.data ?? []) {
      const amt = Number(r.amount);
      next[r.account_code] = { debit: amt > 0 ? amt : 0, credit: amt < 0 ? -amt : 0 };
    }
    setEntries(next);
  }, [societyId, fyEnd]);

  useEffect(() => {
    load();
  }, [load]);

  const set = (code: string, side: keyof Entry, value: number) =>
    setEntries(e => ({ ...e, [code]: { debit: 0, credit: 0, ...e[code], [side]: value, ...(value ? { [side === 'debit' ? 'credit' : 'debit']: 0 } : {}) } }));

  const totals = Object.values(entries).reduce((t, e) => ({ dr: t.dr + (e.debit || 0), cr: t.cr + (e.credit || 0) }), { dr: 0, cr: 0 });
  const diff = totals.dr - totals.cr;

  const save = async () => {
    if (!supabase) return;
    setBusy('save');
    const lines = Object.entries(entries).map(([code, e]) => ({ code, amount: (e.debit || 0) - (e.credit || 0) })).filter(l => l.amount !== 0);
    const { error: rpcErr } = await supabase.rpc('save_prior_year_balances', { p_society_id: societyId, p_fy_end: fyEnd, p_lines: lines });
    setBusy(null);
    if (rpcErr) return setError(rpcErr.message);
    setError(null);
    setNotice(`Saved ${lines.length} figures for ${fyLabel(fyEnd)}. Reports now show them as the previous-year column.`);
  };

  const inputClass = 'w-28 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-right text-white outline-none focus:border-sky-500 disabled:opacity-60';

  return (
    <div className="space-y-4 text-xs">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2"><History className="w-4 h-4 text-sky-400" /> Last year&apos;s audited figures</h2>
          <p className="text-slate-400">Type the closing trial balance from last year&apos;s audited accounts. Used only for the comparative column — nothing is posted to the books.</p>
        </div>
        <select value={fyEnd} onChange={e => setFyEnd(e.target.value)} className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white">
          {[latest, `${Number(latest.slice(0, 4)) - 1}-03-31`].map(f => <option key={f} value={f}>{fyLabel(f)}</option>)}
        </select>
      </div>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      {busy === 'load' ? <Loader2 className="w-5 h-5 text-sky-400 animate-spin" /> : (
        <div className="rounded-2xl bg-slate-900 border border-slate-800 overflow-x-auto">
          <table className="w-full text-left min-w-[520px]">
            <thead className="bg-slate-950 text-slate-400"><tr><th className="p-2">Account</th><th className="p-2 text-right">Debit</th><th className="p-2 text-right">Credit</th></tr></thead>
            <tbody className="text-slate-300">
              {TYPE_ORDER.map(type => (
                <React.Fragment key={type}>
                  <tr><td colSpan={3} className="px-2 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">{TYPE_LABEL[type]}</td></tr>
                  {accounts.filter(a => a.type === type).map(a => (
                    <tr key={a.code} className="border-t border-slate-800/60">
                      <td className="p-2"><span className="font-mono text-slate-500 mr-2">{a.code}</span>{a.name}</td>
                      <td className="p-2 text-right"><input type="number" min={0} step="0.01" disabled={!canEdit} value={entries[a.code]?.debit || ''} onChange={e => set(a.code, 'debit', Number(e.target.value))} className={inputClass} /></td>
                      <td className="p-2 text-right"><input type="number" min={0} step="0.01" disabled={!canEdit} value={entries[a.code]?.credit || ''} onChange={e => set(a.code, 'credit', Number(e.target.value))} className={inputClass} /></td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
            <tfoot className="border-t border-slate-700 font-bold text-white">
              <tr><td className="p-2">Total</td><td className="p-2 text-right">{formatINR(totals.dr)}</td><td className="p-2 text-right">{formatINR(totals.cr)}</td></tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={Math.abs(diff) < 0.005 ? 'text-emerald-300' : 'text-amber-300'}>
          {Math.abs(diff) < 0.005 ? '✓ Debits equal credits' : `Debits and credits differ by ${formatINR(Math.abs(diff))} — fine if you only entered Income & Expenditure`}
        </span>
        {canEdit && (
          <button onClick={save} disabled={busy !== null} className="flex items-center gap-1 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer disabled:opacity-50">
            {busy === 'save' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save {fyLabel(fyEnd)}
          </button>
        )}
      </div>
    </div>
  );
};
