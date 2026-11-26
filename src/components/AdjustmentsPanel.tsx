'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { fetchBankLedgers, type BankLedger } from '../lib/banks';
import { formatINR } from '../lib/inr';
import { Banner } from './Banner';
import { EmptyState } from './EmptyState';
import { CheckCircle2, Loader2, Plus, Scale, Trash2, XCircle } from 'lucide-react';

interface Account { code: string; name: string; type: string; is_active: boolean; adjustable: boolean }
interface ChartLedgerRow { code: string; name: string; nature: string; is_active: boolean; adjustable: boolean }
type MoveType = 'payment' | 'vendor_payment' | 'tds_challan';
interface MoveEntry { id: string; number: string; date: string; amount: number; bankId: string }

interface Proposal {
  id: string;
  proposal_number: string;
  kind: 'journal' | 'capitalise' | 'year_lock' | 'bank_move';
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

const STATUS: Record<Proposal['status'], string> = {
  pending: 'bg-warning-soft text-warning', approved: 'bg-success-soft text-success',
  rejected: 'bg-danger-soft text-danger', withdrawn: 'bg-surface-muted text-fg-muted',
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
  const [kind, setKind] = useState<'journal' | 'capitalise' | 'bank_move'>('journal');
  // Moving a receipt, vendor payment or TDS challan booked to the wrong bank (028)
  const [move, setMove] = useState<{ type: MoveType; entryId: string; toId: string }>({ type: 'payment', entryId: '', toId: '' });
  const [moveEntries, setMoveEntries] = useState<MoveEntry[]>([]);
  const [banks, setBanks] = useState<BankLedger[]>([]);
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState([emptyLine(), emptyLine()]);
  const [cap, setCap] = useState({ expenseId: '', asset: '' });
  // Asset types are the society's fixed-asset ledgers (028)
  const [assetTypes, setAssetTypes] = useState<{ code: string; name: string }[]>([]);
  const [deciding, setDeciding] = useState<{ id: string; note: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [pRes, aRes, eRes, tRes] = await Promise.all([
      supabase.from('adjustment_proposals').select('*, proposer:proposed_by (full_name), decider:decided_by (full_name)')
        .eq('society_id', societyId).order('proposed_at', { ascending: false }).limit(200),
      supabase.rpc('chart_of_accounts', { p_society_id: societyId }),
      supabase.from('expenses').select('id, expense_number, title, subtotal, gst_amount, gst_claimable, invoice_date')
        .eq('society_id', societyId).eq('expense_type', 'revenue').in('status', ['approved', 'paid'])
        .order('created_at', { ascending: false }).limit(300),
      supabase.rpc('asset_ledgers', { p_society_id: societyId }),
    ]);
    if (pRes.error) setError(pRes.error.message);
    setProposals((pRes.data ?? []) as unknown as Proposal[]);
    // Ledgers kept by their own register (members, vendors, advances, fixed assets) come back with adjustable = false
    const ledgers = ((aRes.data as { ledgers?: ChartLedgerRow[] } | null)?.ledgers ?? []);
    setAccounts(ledgers.map(l => ({ code: l.code, name: l.name, type: l.nature, is_active: l.is_active, adjustable: l.adjustable })));
    setExpenses((eRes.data ?? []) as RevenueExpense[]);
    const types = (tRes.data ?? []) as { code: string; name: string }[];
    setAssetTypes(types);
    setCap(c => (c.asset ? c : { ...c, asset: types[0]?.code ?? '' }));
  }, [societyId]);

  useEffect(() => {
    load();
  }, [load]);

  // Entries that can move: the latest 100 of the chosen type that are in a bank
  useEffect(() => {
    if (!supabase || kind !== 'bank_move') return;
    const client = supabase;
    fetchBankLedgers(client, societyId).then(setBanks).catch(() => setBanks([]));
    const query = move.type === 'payment'
      ? client.from('payments').select('id, payment_number, payment_date, amount, bank_ledger_id').eq('society_id', societyId)
          .eq('status', 'verified').neq('payment_method', 'cash').not('bank_ledger_id', 'is', null).order('payment_date', { ascending: false }).limit(100)
      : move.type === 'vendor_payment'
        ? client.from('vendor_payments').select('id, payment_number, paid_on, amount, bank_ledger_id').eq('society_id', societyId)
            .eq('status', 'recorded').neq('mode', 'cash').not('bank_ledger_id', 'is', null).order('paid_on', { ascending: false }).limit(100)
        : client.from('tds_challans').select('id, challan_number, paid_on, amount, bank_ledger_id').eq('society_id', societyId)
            .not('bank_ledger_id', 'is', null).order('paid_on', { ascending: false }).limit(100);
    query.then(({ data }) => setMoveEntries(((data ?? []) as Record<string, unknown>[]).map(r => ({
      id: String(r.id),
      number: String(r.payment_number ?? r.challan_number ?? ''),
      date: String(r.payment_date ?? r.paid_on ?? ''),
      amount: Number(r.amount),
      bankId: String(r.bank_ledger_id),
    }))));
  }, [kind, move.type, societyId]);
  const moveEntry = moveEntries.find(m => m.id === move.entryId);
  const bankName = (id: string) => banks.find(b => b.id === id)?.name ?? 'bank';

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
      : kind === 'bank_move'
        ? await supabase.rpc('propose_bank_move', { p_society_id: societyId, p_entity_type: move.type, p_entity_id: move.entryId, p_to_ledger_id: move.toId, p_reason: reason })
        : await supabase.rpc('propose_capitalisation', { p_expense_id: cap.expenseId, p_asset_account_code: cap.asset, p_reason: reason, p_entry_date: date });
    setBusy(null);
    if (rpcErr) return setError(rpcErr.message);
    setReason('');
    setLines([emptyLine(), emptyLine()]);
    setCap({ expenseId: '', asset: assetTypes[0]?.code ?? '' });
    const number = (data as { proposal_number: string }).proposal_number;
    if (kind === 'bank_move') {
      setMove(m => ({ ...m, entryId: '', toId: '' }));
      done(`Sent to the committee for approval as ${number}.`);
    } else {
      done(`${number} sent to the committee. Nothing is posted until they approve.`);
    }
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

  const inputClass = 'w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand';
  const pending = proposals.filter(p => p.status === 'pending');

  return (
    <div className="space-y-5 text-xs">
      <div>
        <h2 className="text-lg font-semibold text-fg flex items-center gap-2"><Scale className="w-4 h-4 text-brand-ink" /> Adjustments</h2>
        <p className="text-fg-muted">The CA never changes the books directly: an adjustment is proposed with a reason, and a committee member (not the proposer) approves it. Approved entries are posted with both names.</p>
      </div>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      {canPropose && (
        <form onSubmit={submit} className="p-4 rounded-xl bg-surface border border-border space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold text-fg">Propose an adjustment</div>
            <div role="radiogroup" className="flex gap-1 p-1 rounded-xl bg-canvas border border-border">
              {([['journal', 'Journal entry'], ['capitalise', 'Move an expense to assets'], ['bank_move', 'Move to another bank']] as const).map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
                  className={`px-3 py-1.5 rounded-lg font-semibold cursor-pointer ${kind === k ? 'bg-brand text-on-brand' : 'text-fg-muted hover:text-fg'}`}>{label}</button>
              ))}
            </div>
          </div>

          {kind === 'journal' ? (
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_110px_110px_32px] gap-2">
                  <select value={l.code} onChange={e => setLines(ls => ls.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))} className={inputClass}>
                    <option value="">Account…</option>
                    {accounts.filter(a => a.is_active && a.adjustable).map(a => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                  </select>
                  <input type="number" min={0} step="0.01" placeholder="Debit" value={l.debit || ''} onChange={e => setLines(ls => ls.map((x, j) => (j === i ? { ...x, debit: Number(e.target.value), credit: 0 } : x)))} className={inputClass} />
                  <input type="number" min={0} step="0.01" placeholder="Credit" value={l.credit || ''} onChange={e => setLines(ls => ls.map((x, j) => (j === i ? { ...x, credit: Number(e.target.value), debit: 0 } : x)))} className={inputClass} />
                  <button type="button" onClick={() => setLines(ls => (ls.length > 2 ? ls.filter((_, j) => j !== i) : ls))} className="text-fg-subtle hover:text-danger cursor-pointer" aria-label="Remove line"><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" onClick={() => setLines(ls => [...ls, emptyLine()])} className="flex items-center gap-1 text-brand-ink hover:underline cursor-pointer"><Plus className="w-3.5 h-3.5" /> Add line</button>
                <span className={Math.abs(dr - cr) < 0.005 && dr > 0 ? 'text-success' : 'text-warning'}>
                  Dr {formatINR(dr)} · Cr {formatINR(cr)}{Math.abs(dr - cr) >= 0.005 && ` · difference ${formatINR(Math.abs(dr - cr))}`}
                  {signedLines.length > 0 && ` · surplus ${surplusEffect(signedLines) >= 0 ? '+' : '−'}${formatINR(Math.abs(surplusEffect(signedLines)))}`}
                </span>
              </div>
              <p className="text-fg-subtle">Members, vendors, advances and fixed-asset accounts are changed through their own screens, so they are not listed here.</p>
            </div>
          ) : kind === 'bank_move' ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <select value={move.type} onChange={e => setMove({ type: e.target.value as MoveType, entryId: '', toId: '' })} className={inputClass}>
                <option value="payment">Receipt</option>
                <option value="vendor_payment">Vendor payment</option>
                <option value="tds_challan">TDS challan</option>
              </select>
              <select value={move.entryId} onChange={e => setMove({ ...move, entryId: e.target.value, toId: '' })} className={`sm:col-span-2 ${inputClass}`}>
                <option value="">Entry…</option>
                {moveEntries.map(m => <option key={m.id} value={m.id}>{m.number} · {m.date} · {formatINR(m.amount)} · in {bankName(m.bankId)}</option>)}
              </select>
              <select value={move.toId} onChange={e => setMove({ ...move, toId: e.target.value })} className={inputClass} disabled={!moveEntry}>
                <option value="">Move to…</option>
                {banks.filter(b => b.id !== moveEntry?.bankId).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              {moveEntry && <div className="sm:col-span-2 text-brand-ink">Dated {moveEntry.date}, as the entry. On approval the entry is in the new bank and both bank ledgers are corrected.</div>}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <select value={cap.expenseId} onChange={e => setCap({ ...cap, expenseId: e.target.value })} className={`sm:col-span-2 ${inputClass}`}>
                <option value="">Bill booked as an expense…</option>
                {expenses.map(e => <option key={e.id} value={e.id}>{e.expense_number} · {e.title} · {formatINR(Number(e.subtotal) + Number(e.gst_amount))}</option>)}
              </select>
              <select value={cap.asset} onChange={e => setCap({ ...cap, asset: e.target.value })} className={inputClass}>
                {assetTypes.map(a => <option key={a.code} value={a.code}>{a.name}</option>)}
              </select>
              {capExpense && <div className="sm:col-span-3 text-brand-ink">Dr {nameOf.get(cap.asset)} {formatINR(capAmount)} · Cr the expense head · surplus +{formatINR(capAmount)} · on approval the bill joins the asset register.</div>}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-2">
            {kind === 'bank_move'
              ? <div className="text-fg-subtle self-center">Dated as the entry</div>
              : <input type="date" max={today()} value={date} onChange={e => setDate(e.target.value)} className={inputClass} />}
            <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason the committee will read (required)" className={inputClass} />
          </div>
          <button type="submit" disabled={busy !== null || reason.trim().length < 5 || (kind === 'journal' ? (Math.abs(dr - cr) >= 0.005 || dr <= 0) : kind === 'bank_move' ? !move.entryId || !move.toId : !cap.expenseId)}
            className="w-full py-2.5 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2">
            {busy === 'propose' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scale className="w-4 h-4" />} Send to committee for approval
          </button>
        </form>
      )}

      {canDecide && pending.length > 0 && <div className="font-semibold text-warning">{pending.length} waiting for your decision</div>}

      {proposals.length === 0 ? (
        <EmptyState icon={Scale} title="No adjustments yet" description="Proposals from the CA (or the committee) appear here with their reason and effect." />
      ) : (
        <div className="space-y-2">
          {proposals.map(p => {
            const mine = p.proposed_by === currentUserId;
            const effect = surplusEffect(p.lines);
            return (
              <div key={p.id} className="p-4 rounded-xl bg-surface border border-border space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-mono text-fg-muted">{p.proposal_number} · {p.kind === 'year_lock' ? `lock the books up to ${new Date(`${p.entry_date}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}` : `${p.entry_date} · ${p.kind === 'capitalise' ? 'move expense to assets' : p.kind === 'bank_move' ? 'move to another bank' : 'journal'}`}</div>
                    <div className="font-semibold text-fg text-sm">{p.reason}</div>
                    <div className="text-fg-subtle">by {mine ? 'you' : p.proposer?.full_name ?? 'CA'} · {new Date(p.proposed_at).toLocaleDateString('en-IN')}</div>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-xs uppercase font-semibold ${STATUS[p.status]}`}>{p.status}</span>
                </div>
                {p.kind !== 'year_lock' && (
                <table className="w-full text-fg">
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
                )}
                {p.kind !== 'year_lock' && (
                  <div className="text-brand-ink">Effect on this year&apos;s surplus: {effect >= 0 ? '+' : '−'}{formatINR(Math.abs(effect))}{p.kind === 'capitalise' && ' · asset added to the register'}</div>
                )}
                {p.decision_note && <div className="text-fg-muted">{p.decider?.full_name ?? 'Committee'}: “{p.decision_note}”</div>}

                {p.status === 'pending' && (
                  <div className="flex flex-wrap items-center gap-2">
                    {canDecide && !mine && (
                      <>
                        <button onClick={() => decide(p, true)} disabled={busy !== null} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-success hover:bg-success/90 text-on-brand font-semibold cursor-pointer disabled:opacity-50">
                          {busy === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Approve & post
                        </button>
                        <button onClick={() => setDeciding(deciding?.id === p.id ? null : { id: p.id, note: '' })} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-muted text-danger font-semibold cursor-pointer">
                          <XCircle className="w-3.5 h-3.5" /> Reject
                        </button>
                      </>
                    )}
                    {canDecide && mine && <span className="text-fg-subtle">Another committee member must decide your proposal</span>}
                    {mine && <button onClick={() => withdraw(p)} className="text-fg-subtle hover:text-danger cursor-pointer">Withdraw</button>}
                  </div>
                )}
                {deciding?.id === p.id && (
                  <div className="flex gap-2">
                    <input autoFocus value={deciding.note} onChange={e => setDeciding({ id: p.id, note: e.target.value })} placeholder="Reason (the CA sees it)" className={`flex-1 ${inputClass}`} />
                    <button onClick={() => decide(p, false)} disabled={!deciding.note.trim() || busy !== null} className="px-3 rounded-xl bg-danger-solid hover:bg-danger text-on-brand font-semibold cursor-pointer disabled:opacity-50">Confirm</button>
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
