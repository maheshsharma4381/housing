'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { signed, sideTotal, type OpeningBalance, type Side } from '../lib/opening-balance';
import { EMPTY_CHART, type Chart } from '../lib/chart';
import { Banner } from './Banner';
import { BookOpen, Check, Loader2, Undo2 } from 'lucide-react';

const n = (v: unknown) => Number(v ?? 0) || 0;
const showDate = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/**
 * The committee's side of the opening balance (026): read what the CA submitted, then approve it
 * (it reaches the books) or send it back with a reason.
 */
export const OpeningBalanceReview: React.FC<{ societyId: string; canDecide: boolean; onDecided?: () => void }> = ({ societyId, canDecide, onDecided }) => {
  const [ob, setOb] = useState<OpeningBalance | null>(null);
  const [chart, setChart] = useState<Chart>(EMPTY_CHART);
  const [reason, setReason] = useState('');
  const [sendingBack, setSendingBack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [oRes, cRes] = await Promise.all([
      supabase.rpc('opening_balance', { p_society_id: societyId }),
      supabase.rpc('chart_of_accounts', { p_society_id: societyId }),
    ]);
    if (oRes.error) setError(oRes.error.message);
    else setOb(oRes.data as OpeningBalance);
    setChart((cRes.data as Chart | null) ?? EMPTY_CHART);
  }, [societyId]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (approve: boolean) => {
    if (!supabase) return;
    if (approve && !window.confirm('Approve the opening balance? It goes into the books and flat-wise dues become bills the owners can pay.')) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc('decide_opening_balance', {
      p_society_id: societyId, p_approve: approve, p_note: approve ? null : reason,
    });
    setBusy(false);
    if (err) return setError(err.message);
    setReason('');
    setSendingBack(false);
    await load();
    onDecided?.();
  };

  const ledgerLabel = (code: string, label?: string) => label ?? chart.ledgers.find(l => l.code === code)?.name ?? code;
  const sideList = (side: Side, title: string) => {
    const lines = (ob?.audited_lines ?? []).filter(l => l.side === side);
    return (
      <div className="space-y-1">
        <div className="font-semibold text-slate-300">{title}</div>
        {lines.map((l, i) => (
          <div key={`${l.code}-${i}`} className="flex justify-between gap-2">
            <span className="text-slate-300">{ledgerLabel(l.code, l.label)}</span>
            <span className="text-white">{formatINR(signed(side, n(l.amount)))}</span>
          </div>
        ))}
        <div className="flex justify-between border-t border-slate-800 pt-1 font-semibold text-white">
          <span>Total</span><span>{formatINR(sideTotal(ob?.audited_lines ?? [], side))}</span>
        </div>
      </div>
    );
  };

  const flatName = (id: string) => ob?.flats.find(f => f.unit_id === id);
  const vendorName = (id: string) => ob?.vendors.find(v => v.vendor_id === id)?.name ?? '—';

  return (
    <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3 text-xs">
      <h3 className="font-semibold text-white flex items-center gap-2"><BookOpen className="w-4 h-4 text-sky-400" /> Opening balance</h3>
      <Banner tone="error">{error}</Banner>
      {!ob ? (
        <div className="flex items-center gap-2 text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : ob.status === 'approved' ? (
        <p className="text-emerald-300">Approved on {showDate(ob.decided_at)}.</p>
      ) : ob.status !== 'submitted' ? (
        <p className="text-slate-400">Your CA has not submitted the opening balance yet.</p>
      ) : (
        <>
          <p className="text-slate-400">
            Prepared by {ob.prepared_by_name ?? 'your CA'}, submitted {showDate(ob.submitted_at)}.
            Audited balance sheet as on {showDate(ob.audited_as_of)}; society started using Sahvaas on {showDate(ob.live_on)}.
          </p>
          <div className="grid gap-6 lg:grid-cols-2">
            {sideList('liabilities', 'Liabilities & funds')}
            {sideList('assets', 'Assets')}
          </div>

          {ob.catchup_lines.length > 0 && (
            <div className="space-y-1">
              <div className="font-semibold text-slate-300">Catch-up entry</div>
              <table className="w-full">
                <thead className="text-slate-500 text-left"><tr><th>Ledger</th><th className="text-right">Debit</th><th className="text-right">Credit</th></tr></thead>
                <tbody>
                  {ob.catchup_lines.map((l, i) => (
                    <tr key={`${l.code}-${i}`}>
                      <td className="text-slate-300">{ledgerLabel(l.code)}</td>
                      <td className="text-right text-white">{n(l.amount) > 0 ? formatINR(n(l.amount)) : ''}</td>
                      <td className="text-right text-white">{n(l.amount) < 0 ? formatINR(-n(l.amount)) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {ob.flat_lines.length > 0 && (
            <div className="space-y-1">
              <div className="font-semibold text-slate-300">Flat-wise on {showDate(ob.live_on)}</div>
              <table className="w-full">
                <thead className="text-slate-500 text-left"><tr><th>Flat</th><th>Owner</th><th className="text-right">Dues</th><th className="text-right">Advance</th></tr></thead>
                <tbody className="divide-y divide-slate-800">
                  {ob.flat_lines.map(l => (
                    <tr key={l.unit_id}>
                      <td className="py-1 text-white">{flatName(l.unit_id)?.name ?? '—'}</td>
                      <td className="py-1 text-slate-400">{flatName(l.unit_id)?.owner_name ?? '—'}</td>
                      <td className="py-1 text-right text-white">{n(l.amount) > 0 ? formatINR(n(l.amount)) : ''}</td>
                      <td className="py-1 text-right text-white">{n(l.amount) < 0 ? formatINR(-n(l.amount)) : ''}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="font-semibold text-white">
                  <tr><td colSpan={2} className="pt-1">Total</td><td className="pt-1 text-right">{formatINR(n(ob.checks.dues_entered))}</td><td className="pt-1 text-right">{formatINR(n(ob.checks.advance_entered))}</td></tr>
                </tfoot>
              </table>
            </div>
          )}

          {ob.vendor_lines.length > 0 && (
            <div className="space-y-1">
              <div className="font-semibold text-slate-300">Vendor payables on {showDate(ob.live_on)}</div>
              {ob.vendor_lines.map(l => (
                <div key={l.vendor_id} className="flex justify-between"><span className="text-slate-300">{vendorName(l.vendor_id)}</span><span className="text-white">{formatINR(n(l.amount))}</span></div>
              ))}
            </div>
          )}

          {canDecide ? (
            <div className="space-y-2">
              {sendingBack && (
                <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} placeholder="What should the CA correct?"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-white outline-none focus:border-sky-500" />
              )}
              <div className="flex flex-wrap gap-2">
                <button onClick={() => decide(true)} disabled={busy} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer disabled:opacity-50">
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Approve
                </button>
                <button onClick={() => (sendingBack ? decide(false) : setSendingBack(true))} disabled={busy || (sendingBack && reason.trim() === '')}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white cursor-pointer disabled:opacity-50">
                  <Undo2 className="w-3.5 h-3.5" /> Send back
                </button>
              </div>
            </div>
          ) : (
            <p className="text-slate-500">A secretary, chairman or treasurer approves this.</p>
          )}
        </>
      )}
    </section>
  );
};
