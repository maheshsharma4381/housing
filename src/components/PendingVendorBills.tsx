'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { Banner } from './Banner';
import { Receipt, Loader2 } from 'lucide-react';

interface Row { id: string; expense_number: string; title: string; payee_name: string | null; subtotal: number; gst_amount: number; created_by: string | null; invoice_date: string | null }

/**
 * Vendor bills waiting for approval, in Approvals (spec 9.3). Same rules as Vendor bills (decide_expense):
 * the maker cannot approve their own bill unless they are the society's only committee member.
 */
export const PendingVendorBills: React.FC<{ societyId: string; currentUserId?: string; canDecide: boolean; onDecided?: () => void }> = ({ societyId, currentUserId, canDecide, onDecided }) => {
  const [rows, setRows] = useState<Row[]>([]);
  const [sole, setSole] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [r, s] = await Promise.all([
      supabase.from('expenses').select('id, expense_number, title, payee_name, subtotal, gst_amount, created_by, invoice_date')
        .eq('society_id', societyId).eq('status', 'pending_approval').order('created_at'),
      supabase.rpc('sole_committee_admin', { p_society_id: societyId }),
    ]);
    setRows((r.data ?? []) as Row[]);
    setSole(s.data === true);
  }, [societyId]);
  useEffect(() => { load(); }, [load]);

  const decide = async (row: Row, approve: boolean) => {
    if (!supabase) return;
    if (!approve && !reasons[row.id]?.trim()) return setError('Give a reason for rejecting');
    setBusy(row.id);
    setError(null);
    const { error: err } = await supabase.rpc('decide_expense', { p_expense_id: row.id, p_approve: approve, p_notes: approve ? null : reasons[row.id] });
    setBusy(null);
    if (err) return setError(err.message);
    await load();
    onDecided?.();
  };

  if (rows.length === 0 && !error) return null;
  return (
    <section className="space-y-3 text-xs">
      <h2 className="text-lg font-bold text-white flex items-center gap-2"><Receipt className="w-5 h-5 text-amber-400" /> Vendor bills to approve</h2>
      <Banner tone="error">{error}</Banner>
      {rows.map(r => {
        const mine = r.created_by === currentUserId;
        const can = canDecide && (!mine || sole);
        return (
          <div key={r.id} className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold text-white">{r.title} <span className="font-mono text-slate-500">· {r.expense_number}</span></span>
              <strong className="text-white">{formatINR(Number(r.subtotal) + Number(r.gst_amount))}</strong>
            </div>
            <div className="text-slate-400">{r.payee_name ?? 'Vendor'}{r.invoice_date ? ` · invoice ${r.invoice_date}` : ''}</div>
            {can ? (
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => decide(r, true)} disabled={busy === r.id} className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold cursor-pointer disabled:opacity-50 flex items-center gap-1.5">
                  {busy === r.id && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Approve{mine ? ' (self-approved)' : ''}
                </button>
                <input className="flex-1 min-w-[10rem] bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white" placeholder="Reason to reject"
                  value={reasons[r.id] ?? ''} onChange={e => setReasons({ ...reasons, [r.id]: e.target.value })} />
                <button onClick={() => decide(r, false)} disabled={busy === r.id} className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-rose-300 font-semibold cursor-pointer">Reject</button>
              </div>
            ) : (
              <p className="text-slate-500">{mine ? 'You recorded this bill — another committee member approves it.' : 'Waiting for a committee member to approve.'}</p>
            )}
          </div>
        );
      })}
    </section>
  );
};
