'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { ASSET_TYPES } from '../lib/tds';
import { Banner } from './Banner';
import { EmptyState } from './EmptyState';
import { CheckCircle2, Loader2, Plus, Scale, Trash2, XCircle } from 'lucide-react';

interface Account { code: string; name: string; type: string }
interface Proposal {
  id: string;
  proposal_number: string;
  kind: 'journal' | 'capitalise';
  entry_date: string;
  reason: string;
  lines: { code: string; amount: number }[];
  expense_id: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  proposed_by: string;
  proposed_at: string;
  decision_note: string | null;
  proposer: { full_name: string } | null;
  decider: { full_name: string } | null;
}
interface RevenueExpense { id: string; expense_number: string; title: string; subtotal: number; gst_amount: number; gst_claimable: boolean; invoice_date: string | null }

// Mirrors adjustment_blocked_code() in 014: sub-ledger accounts change only through their own screens
const BLOCKED = new Set(['1200', '2000', '2300', '1500', '1510', '1520', '1530', '1540', '1550', '1590']);
const STATUS: Record<Proposal['status'], string> = {
  pending: 'bg-amber-500/10 text-amber-300', approved: 'bg-emerald-500/10 text-emerald-300',
  rejected: 'bg-rose-500/10 text-rose-300', withdrawn: 'bg-slate-800 text-slate-400',
};

const today = () => new Date().toISOString().slice(0, 10);
const emptyLine = () => ({ code: '', debit: 0, credit: 0 });

interface AdjustmentsPanelProps {
  societyId: string;
  currentUserId?: string;
  /** committee: approve / reject other people's proposals */
  canDecide: boolean;
  /** CA with ledger / report access, or the committee */
  canPropose: boolean;
}

export const AdjustmentsPanel: React.FC<AdjustmentsPanelProps> = ({ societyId, currentUserId, canDecide, canPropose }) => {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [expenses, setExpenses] = useState<RevenueExpense[]>([]);
  const [kind, setKind] = useState<'journal' | 'capitalise'>('journal');
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState([emptyLine(), emptyLine()]);
  const [cap, setCap] = useState({ expenseId: '', asset: '1500' });
  const [deciding, setDeciding] = useState<{ id: string; note: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [pRes, aRes, eRes] = await Promise.all([
      supabase.from('adjustment_proposals').select('*, proposer:proposed_by (full_name), decider:decided_by (full_name)')
        .eq('society_id', societyId).order('proposed_at', { ascending: false }).limit(200),
      supabase.from('accounts').select('code, name, type').eq('society_id', societyId).order('code'),
      supabase.from('expenses').select('id, expense_number, title, subtotal, gst_amount, gst_claimable, invoice_date')
        .eq('society_id', societyId).eq('expense_type', 'revenue').in('status', ['approved', 'paid'])
        .order('created_at', { ascending: false }).limit(300),
    ]);
    if (pRes.error) setError(pRes.error.message);
    setProposals((pRes.data ?? []) as unknown as Proposal[]);
    setAccounts((aRes.data ?? []) as Account[]);
    setExpenses((eRes.data ?? []) as RevenueExpense[]);
  }, [societyId]);

  useEffect(() => {
    load();
  }, [load]);

  const typeOf = useMemo(() => new Map(accounts.map(a => [a.code, a.type])), [accounts]);
  const nameOf = useMemo(() => new Map(accounts.map(a => [a.code, a.name])), [accounts]);
  // Debiting an expense (or reversing income) lowers the surplus
  const surplusEffect = (ls: { code: string; amount: number }[]) =>
    -ls.filter(l => ['income', 'expense'].includes(typeOf.get(l.code) ?? '')).reduce((s, l) => s + Number(l.amount), 0);

  const signedLines = lines.filter(l => l.code && (l.debit || l.credit)).map(l => ({ code: l.code, amount: Number(l.debit) - Number(l.credit) }));
  const dr = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const cr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  const capExpense = expenses.find(e => e.id === cap.expenseId);
  const capAmount = capExpense ? Number(capExpense.subtotal) + Number(capExpense.gst_amount) - (capExpense.gst_claimable ? Number(capExpense.gst_amount) : 0) : 0;

  const done = (msg: string) => {
    setError(null);
    setNotice(msg);
    load();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    setBusy('propose');
    const { data, error: rpcErr } = kind === 'journal'
      ? await supabase.rpc('propose_adjustment', { p_society_id: societyId, p_entry_date: date, p_reason: reason, p_lines: signedLines })
      : await supabase.rpc('propose_capitalisation', { p_expense_id: cap.expenseId, p_asset_account_code: cap.asset, p_reason: reason, p_entry_date: date });
    setBusy(null);
    if (rpcErr) return setError(rpcErr.message);
    setReason('');
    setLines([emptyLine(), emptyLine()]);
    setCap({ expenseId: '', asset: '1500' });
    done(`${(data as { proposal_number: string }).proposal_number} sent to the committee. Nothing is posted until they approve.`);
  };

  const decide = async (p: Proposal, approve: boolean) => {
    if (!supabase) return;
    setBusy(p.id);
    const { error: rpcErr } = await supabase.rpc('decide_adjustment', { p_proposal_id: p.id, p_approve: approve, p_note: deciding?.id === p.id ? deciding.note || null : null });
    setBusy(null);
    if (rpcErr) return setError(rpcErr.message);
    setDeciding(null);
    done(approve ? `${p.proposal_number} approved and posted to the books.` : `${p.proposal_number} rejected.`);
  };

  const withdraw = async (p: Proposal) => {
    if (!supabase) return;
    const { error: rpcErr } = await supabase.rpc('withdraw_adjustment', { p_proposal_id: p.id });
    if (rpcErr) return setError(rpcErr.message);
    done(`${p.proposal_number} withdrawn.`);
  };

  const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-violet-500';
  const pending = proposals.filter(p => p.status === 'pending');

  return (
    <div className="space-y-5 text-xs">
      <div>
        <h2 className="text-lg font-bold text-white flex items-center gap-2"><Scale className="w-4 h-4 text-violet-300" /> Adjustments</h2>
        <p className="text-slate-400">The CA never changes the books directly: an adjustment is proposed with a reason, and a committee member (not the proposer) approves it. Approved entries are posted with both names.</p>
      </div>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      {canPropose && (
        <form onSubmit={submit} className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-bold text-white">Propose an adjustment</div>
            <div role="radiogroup" className="flex gap-1 p-1 rounded-xl bg-slate-950 border border-slate-800">
              {([['journal', 'Journal entry'], ['capitalise', 'Move an expense to assets']] as const).map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
                  className={`px-3 py-1.5 rounded-lg font-semibold cursor-pointer ${kind === k ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'}`}>{label}</button>
              ))}
            </div>
          </div>

          {kind === 'journal' ? (
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_110px_110px_32px] gap-2">
                  <select value={l.code} onChange={e => setLines(ls => ls.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))} className={inputClass}>
                    <option value="">Account…</option>
                    {accounts.filter(a => !BLOCKED.has(a.code)).map(a => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                  </select>
                  <input type="number" min={0} step="0.01" placeholder="Debit" value={l.debit || ''} onChange={e => setLines(ls => ls.map((x, j) => (j === i ? { ...x, debit: Number(e.target.value), credit: 0 } : x)))} className={inputClass} />
                  <input type="number" min={0} step="0.01" placeholder="Credit" value={l.credit || ''} onChange={e => setLines(ls => ls.map((x, j) => (j === i ? { ...x, credit: Number(e.target.value), debit: 0 } : x)))} className={inputClass} />
                  <button type="button" onClick={() => setLines(ls => (ls.length > 2 ? ls.filter((_, j) => j !== i) : ls))} className="text-slate-500 hover:text-rose-300 cursor-pointer" aria-label="Remove line"><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" onClick={() => setLines(ls => [...ls, emptyLine()])} className="flex items-center gap-1 text-violet-300 hover:underline cursor-pointer"><Plus className="w-3.5 h-3.5" /> Add line</button>
                <span className={Math.abs(dr - cr) < 0.005 && dr > 0 ? 'text-emerald-300' : 'text-amber-300'}>
                  Dr {formatINR(dr)} · Cr {formatINR(cr)}{Math.abs(dr - cr) >= 0.005 && ` · difference ${formatINR(Math.abs(dr - cr))}`}
                  {signedLines.length > 0 && ` · surplus ${surplusEffect(signedLines) >= 0 ? '+' : '−'}${formatINR(Math.abs(surplusEffect(signedLines)))}`}
                </span>
              </div>
              <p className="text-slate-500">Members, vendors, advances and fixed-asset accounts are changed through their own screens, so they are not listed here.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <select value={cap.expenseId} onChange={e => setCap({ ...cap, expenseId: e.target.value })} className={`sm:col-span-2 ${inputClass}`}>
                <option value="">Bill booked as an expense…</option>
                {expenses.map(e => <option key={e.id} value={e.id}>{e.expense_number} · {e.title} · {formatINR(Number(e.subtotal) + Number(e.gst_amount))}</option>)}
              </select>
              <select value={cap.asset} onChange={e => setCap({ ...cap, asset: e.target.value })} className={inputClass}>
                {ASSET_TYPES.map(a => <option key={a.code} value={a.code}>{a.label}</option>)}
              </select>
              {capExpense && <div className="sm:col-span-3 text-violet-200">Dr {nameOf.get(cap.asset)} {formatINR(capAmount)} · Cr the expense head · surplus +{formatINR(capAmount)} · on approval the bill joins the asset register.</div>}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-2">
            <input type="date" max={today()} value={date} onChange={e => setDate(e.target.value)} className={inputClass} />
            <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason the committee will read (required)" className={inputClass} />
          </div>
          <button type="submit" disabled={busy !== null || reason.trim().length < 5 || (kind === 'journal' ? (Math.abs(dr - cr) >= 0.005 || dr <= 0) : !cap.expenseId)}
            className="w-full py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-bold cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2">
            {busy === 'propose' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scale className="w-4 h-4" />} Send to committee for approval
          </button>
        </form>
      )}

      {canDecide && pending.length > 0 && <div className="font-bold text-amber-300">{pending.length} waiting for your decision</div>}

      {proposals.length === 0 ? (
        <EmptyState icon={Scale} title="No adjustments yet" description="Proposals from the CA (or the committee) appear here with their reason and effect." />
      ) : (
        <div className="space-y-2">
          {proposals.map(p => {
            const mine = p.proposed_by === currentUserId;
            const effect = surplusEffect(p.lines);
            return (
              <div key={p.id} className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-mono text-slate-400">{p.proposal_number} · {p.entry_date} · {p.kind === 'capitalise' ? 'move expense to assets' : 'journal'}</div>
                    <div className="font-bold text-white text-sm">{p.reason}</div>
                    <div className="text-slate-500">by {mine ? 'you' : p.proposer?.full_name ?? 'CA'} · {new Date(p.proposed_at).toLocaleDateString('en-IN')}</div>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold ${STATUS[p.status]}`}>{p.status}</span>
                </div>
                <table className="w-full text-slate-300">
                  <tbody>
                    {[...p.lines].sort((a, b) => b.amount - a.amount).map((l, i) => (
                      <tr key={i}>
                        <td className={l.amount < 0 ? 'pl-6' : ''}>{l.amount > 0 ? 'Dr' : 'Cr'} {l.code} · {nameOf.get(l.code) ?? ''}</td>
                        <td className="text-right w-28">{l.amount > 0 ? formatINR(l.amount) : ''}</td>
                        <td className="text-right w-28">{l.amount < 0 ? formatINR(-l.amount) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="text-violet-200">Effect on this year&apos;s surplus: {effect >= 0 ? '+' : '−'}{formatINR(Math.abs(effect))}{p.kind === 'capitalise' && ' · asset added to the register'}</div>
                {p.decision_note && <div className="text-slate-400">{p.decider?.full_name ?? 'Committee'}: “{p.decision_note}”</div>}

                {p.status === 'pending' && (
                  <div className="flex flex-wrap items-center gap-2">
                    {canDecide && !mine && (
                      <>
                        <button onClick={() => decide(p, true)} disabled={busy !== null} className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold cursor-pointer disabled:opacity-50">
                          {busy === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Approve & post
                        </button>
                        <button onClick={() => setDeciding(deciding?.id === p.id ? null : { id: p.id, note: '' })} className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-slate-800 text-rose-300 font-semibold cursor-pointer">
                          <XCircle className="w-3.5 h-3.5" /> Reject
                        </button>
                      </>
                    )}
                    {canDecide && mine && <span className="text-slate-500">Another committee member must decide your proposal</span>}
                    {mine && <button onClick={() => withdraw(p)} className="text-slate-500 hover:text-rose-300 cursor-pointer">Withdraw</button>}
                  </div>
                )}
                {deciding?.id === p.id && (
                  <div className="flex gap-2">
                    <input autoFocus value={deciding.note} onChange={e => setDeciding({ id: p.id, note: e.target.value })} placeholder="Reason (the CA sees it)" className={`flex-1 ${inputClass}`} />
                    <button onClick={() => decide(p, false)} disabled={!deciding.note.trim() || busy !== null} className="px-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold cursor-pointer disabled:opacity-50">Confirm</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
