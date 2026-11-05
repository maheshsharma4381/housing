'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { openSocietyFile } from '../lib/storage';
import { Banner } from './Banner';
import { Receipt, Loader2, Paperclip } from 'lucide-react';

interface Row {
  id: string; expense_number: string; title: string; payee_name: string | null; subtotal: number; gst_amount: number;
  tds_amount: number; net_payable: number; created_by: string | null; invoice_date: string | null; document_url: string | null;
  vendors: { name: string } | { name: string }[] | null;
}
interface Approval { expense_id: string; approver_id: string; decision: string; profiles: { full_name: string } | { full_name: string }[] | null }

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

/**
 * Vendor bills waiting for approval, in Approvals (spec 9.3). Same rules as Vendor bills (decide_expense):
 * the maker cannot approve their own bill unless they are the society's only committee member, and with
 * two-step approval a second member approves after the first.
 */
export const PendingVendorBills: React.FC<{ societyId: string; currentUserId?: string; canDecide: boolean; onDecided?: () => void }> = ({ societyId, currentUserId, canDecide, onDecided }) => {
  const [rows, setRows] = useState<Row[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [sole, setSole] = useState(false);
  const [twoStep, setTwoStep] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [r, a, s, st] = await Promise.all([
      supabase.from('expenses')
        .select('id, expense_number, title, payee_name, subtotal, gst_amount, tds_amount, net_payable, created_by, invoice_date, document_url, vendors:vendor_id (name)')
        .eq('society_id', societyId).eq('status', 'pending_approval').order('created_at'),
      supabase.from('expense_approvals').select('expense_id, approver_id, decision, profiles:approver_id (full_name)').eq('society_id', societyId),
      supabase.rpc('sole_committee_admin', { p_society_id: societyId }),
      supabase.from('society_settings').select('require_two_step_expense_approval').eq('society_id', societyId).maybeSingle(),
    ]);
    setRows((r.data ?? []) as Row[]);
    setApprovals((a.data ?? []) as Approval[]);
    setSole(s.data === true);
    setTwoStep(Boolean(st.data?.require_two_step_expense_approval));
  }, [societyId]);
  useEffect(() => { load(); }, [load]);

  const required = twoStep && !sole ? 2 : 1;

  const decide = async (row: Row, approve: boolean) => {
    if (!supabase) return;
    if (!approve && !reasons[row.id]?.trim()) return setError('Give a reason for rejecting');
    setBusy(row.id);
    setError(null);
    setNotice(null);
    const { data, error: err } = await supabase.rpc('decide_expense', { p_expense_id: row.id, p_approve: approve, p_notes: approve ? null : reasons[row.id] });
    setBusy(null);
    if (err) return setError(err.message);
    const res = data as { status: string; approvals: number; required: number };
    setNotice(res.status === 'pending_approval'
      ? `${row.expense_number}: your approval is recorded (${res.approvals}/${res.required}) — waiting for a second committee member.`
      : `${row.expense_number} ${res.status}.`);
    await load();
    onDecided?.();
  };

  const openFile = async (path: string) => {
    try {
      await openSocietyFile(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (rows.length === 0 && !error && !notice) return null;
  return (
    <section className="space-y-3 text-xs">
      <h2 className="text-lg font-bold text-white flex items-center gap-2"><Receipt className="w-5 h-5 text-amber-400" /> Vendor bills to approve</h2>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>
      {rows.map(r => {
        const mine = r.created_by === currentUserId;
        const approvedBy = approvals.filter(a => a.expense_id === r.id && a.decision === 'approved');
        const iDecided = approvals.some(a => a.expense_id === r.id && a.approver_id === currentUserId);
        const can = canDecide && (!mine || sole) && !iDecided;
        const vendor = one(r.vendors)?.name ?? r.payee_name ?? 'Vendor';
        return (
          <div key={r.id} className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold text-white">{vendor} · {r.title} <span className="font-mono text-slate-500">· {r.expense_number}</span></span>
              <strong className="text-white">{formatINR(Number(r.subtotal) + Number(r.gst_amount))}</strong>
            </div>
            <div className="text-slate-400 flex flex-wrap items-center gap-x-3 gap-y-1">
              {r.invoice_date && <span>Invoice {r.invoice_date}</span>}
              {Number(r.tds_amount) > 0 && <span>− TDS {formatINR(r.tds_amount)} · net {formatINR(r.net_payable)}</span>}
              {r.document_url && (
                <button onClick={() => openFile(r.document_url!)} className="flex items-center gap-1 text-sky-400 hover:underline cursor-pointer">
                  <Paperclip className="w-3.5 h-3.5" /> Invoice
                </button>
              )}
              {approvedBy.length > 0 && (
                <span className="text-emerald-300">
                  Approved by {approvedBy.map(a => one(a.profiles)?.full_name ?? 'a member').join(', ')} ({approvedBy.length}/{required})
                </span>
              )}
            </div>
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
              <p className="text-slate-500">
                {iDecided ? 'You have recorded your decision — waiting for another committee member.'
                  : mine ? 'You recorded this bill — another committee member approves it.'
                  : 'Waiting for a committee member to approve.'}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
};
