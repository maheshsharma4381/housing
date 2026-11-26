'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { parseBankStatement, ParsedStatement } from '../lib/bank-statement';
import { notify } from '../lib/notify';
import { type BankLedger, defaultBankId, fetchBankLedgers } from '../lib/banks';
import { Banner } from './Banner';
import { EmptyState } from './EmptyState';
import { ArrowDownLeft, ArrowUpRight, CheckCircle2, EyeOff, FileUp, Landmark, Link2, Loader2, Plus, Sparkles, Unlink } from 'lucide-react';

interface BankAccount { id: string; bank_name: string; account_number: string; ifsc_code: string; branch_name: string; is_primary: boolean; current_balance: number; ledger_id: string }
interface Line {
  id: string;
  transaction_date: string;
  description: string;
  reference_number: string | null;
  type: 'credit' | 'debit';
  amount: number;
  running_balance: number | null;
  match_kind: 'payment' | 'vendor_payment' | 'tds_challan' | 'ignored' | null;
  match_method: string | null;
  match_note: string | null;
  suggested_kind: 'payment' | 'vendor_payment' | null;
  suggested_id: string | null;
  payment: { payment_number: string; status: string; transaction_reference_utr: string; unit: { unit_number: string } | null } | null;
  vendor_payment: { payment_number: string; expense: { title: string } | null } | null;
  challan: { challan_number: string } | null;
}
interface Candidate { kind: 'payment' | 'vendor_payment' | 'tds_challan'; id: string; amount: number; date: string; label: string }
interface Summary {
  statement_balance: number | null; statement_date: string | null; book_balance: number; lines: number; matched: number; ignored: number;
  suggested: number; open_credits: number; open_credit_total: number; open_debits: number; open_debit_total: number; ready_to_verify: number;
}

type Filter = 'open' | 'suggested' | 'matched' | 'ignored' | 'all';
type Action = { lineId: string; kind: 'link' | 'record' | 'ignore'; value: string };

const ACCOUNT_BLANK = { bank_name: '', account_number: '', ifsc_code: '', branch_name: '', ledger_id: '' };
const fmtDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

interface BankReconciliationProps {
  societyId: string;
  /** import statements and match lines: the committee, the CA or the Accountant */
  canManage: boolean;
  /** verify residents' payments (and record a credit as a payment): the committee only; defaults to canManage */
  canVerify?: boolean;
}

export const BankReconciliation: React.FC<BankReconciliationProps> = ({ societyId, canManage, canVerify = canManage }) => {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [accountId, setAccountId] = useState('');
  const [newAccount, setNewAccount] = useState<typeof ACCOUNT_BLANK | null>(null);
  const [banks, setBanks] = useState<BankLedger[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [units, setUnits] = useState<{ id: string; unit_number: string }[]>([]);
  const [filter, setFilter] = useState<Filter>('open');
  const [file, setFile] = useState<{ name: string; parsed: ParsedStatement } | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadAccounts = useCallback(async () => {
    if (!supabase) return;
    const [aRes, uRes] = await Promise.all([
      supabase.from('bank_accounts').select('id, bank_name, account_number, ifsc_code, branch_name, is_primary, current_balance, ledger_id')
        .eq('society_id', societyId).order('is_primary', { ascending: false }).order('created_at'),
      supabase.from('units').select('id, unit_number').eq('society_id', societyId).order('unit_number'),
    ]);
    if (aRes.error) setError(aRes.error.message);
    const list = (aRes.data ?? []) as BankAccount[];
    setAccounts(list);
    setUnits(uRes.data ?? []);
    setBanks(await fetchBankLedgers(supabase, societyId).catch(() => []));
    setAccountId(id => (list.some(a => a.id === id) ? id : list[0]?.id ?? ''));
    setLoading(false);
  }, [societyId]);

  const loadLines = useCallback(async () => {
    if (!supabase || !accountId) return;
    const [sRes, lRes, pRes, vRes, cRes] = await Promise.all([
      supabase.rpc('bank_reconciliation_summary', { p_bank_account_id: accountId }),
      supabase.from('bank_transactions')
        .select(`id, transaction_date, description, reference_number, type, amount, running_balance, match_kind, match_method, match_note,
                 suggested_kind, suggested_id,
                 payment:reconciled_payment_id (payment_number, status, transaction_reference_utr, unit:unit_id (unit_number)),
                 vendor_payment:reconciled_vendor_payment_id (payment_number, expense:expense_id (title)),
                 challan:reconciled_challan_id (challan_number)`)
        .eq('bank_account_id', accountId).order('transaction_date', { ascending: false }).order('line_no', { ascending: false }).limit(500),
      supabase.from('payments').select('id, payment_number, amount, payment_date, transaction_reference_utr, unit:unit_id (unit_number)')
        .eq('society_id', societyId).in('status', ['pending_verification', 'verified']).order('payment_date', { ascending: false }).limit(1000),
      supabase.from('vendor_payments').select('id, payment_number, amount, paid_on, reference, expense:expense_id (title)')
        .eq('society_id', societyId).eq('status', 'recorded').order('paid_on', { ascending: false }).limit(500),
      supabase.from('tds_challans').select('id, challan_number, amount, paid_on').eq('society_id', societyId).order('paid_on', { ascending: false }).limit(200),
    ]);
    if (sRes.error) setError(sRes.error.message);
    else setSummary(sRes.data as Summary);
    setLines((lRes.data ?? []) as unknown as Line[]);
    type P = { id: string; payment_number: string; amount: number; payment_date: string; transaction_reference_utr: string; unit: { unit_number: string } | null };
    type V = { id: string; payment_number: string; amount: number; paid_on: string; reference: string | null; expense: { title: string } | null };
    type C = { id: string; challan_number: string; amount: number; paid_on: string };
    setCandidates([
      ...((pRes.data ?? []) as unknown as P[]).map(p => ({ kind: 'payment' as const, id: p.id, amount: Number(p.amount), date: p.payment_date,
        label: `Flat ${p.unit?.unit_number ?? '—'} · ${p.payment_number} · UTR ${p.transaction_reference_utr}` })),
      ...((vRes.data ?? []) as unknown as V[]).map(v => ({ kind: 'vendor_payment' as const, id: v.id, amount: Number(v.amount), date: v.paid_on,
        label: `${v.payment_number} · ${v.expense?.title ?? 'Vendor'}${v.reference ? ` · ${v.reference}` : ''}` })),
      ...((cRes.data ?? []) as C[]).map(c => ({ kind: 'tds_challan' as const, id: c.id, amount: Number(c.amount), date: c.paid_on,
        label: `TDS challan ${c.challan_number}` })),
    ]);
  }, [accountId, societyId]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);
  useEffect(() => {
    loadLines();
  }, [loadLines]);

  const candidateById = useMemo(() => new Map(candidates.map(c => [c.id, c])), [candidates]);
  const shown = lines.filter(l => {
    if (filter === 'open') return !l.match_kind;
    if (filter === 'suggested') return !l.match_kind && l.suggested_id;
    if (filter === 'matched') return l.match_kind && l.match_kind !== 'ignored';
    if (filter === 'ignored') return l.match_kind === 'ignored';
    return true;
  });

  const done = (msg: string) => {
    setError(null);
    setNotice(msg);
    setAction(null);
    loadLines();
  };
  const rpc = async (key: string, fn: string, args: Record<string, unknown>) => {
    if (!supabase) return null;
    setBusy(key);
    const { data, error: rpcErr } = await supabase.rpc(fn, args);
    setBusy(null);
    if (rpcErr) {
      setError(rpcErr.message);
      return null;
    }
    return data;
  };

  const addAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || !newAccount) return;
    setBusy('account');
    const { data, error: insErr } = await supabase.from('bank_accounts').insert({
      society_id: societyId, ...newAccount, ifsc_code: newAccount.ifsc_code.toUpperCase().trim(), is_primary: accounts.length === 0,
      ledger_id: newAccount.ledger_id || null,
    }).select('id').single();
    setBusy(null);
    if (insErr) return setError(insErr.message);
    setNewAccount(null);
    setAccountId(data.id);
    await loadAccounts();
    setNotice('Bank account added. Now upload its statement.');
  };

  const pickFile = async (f: File | undefined) => {
    setFile(null);
    setError(null);
    if (!f) return;
    if (!/\.(csv|txt)$/i.test(f.name)) {
      return setError('Upload the statement as CSV. In Excel: File → Save As → CSV, or choose "CSV" when downloading from net banking.');
    }
    try {
      setFile({ name: f.name, parsed: parseBankStatement(await f.text()) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const importFile = async () => {
    if (!file) return;
    const r = await rpc('import', 'import_bank_statement', {
      p_bank_account_id: accountId, p_file_name: file.name, p_format: file.parsed.format, p_rows: file.parsed.rows,
    }) as { rows: number; new: number; duplicates: number; matched: number; suggested: number } | null;
    if (!r) return;
    setFile(null);
    setFilter('open');
    done(`${r.new} new line${r.new === 1 ? '' : 's'} imported` + (r.duplicates ? `, ${r.duplicates} already uploaded earlier` : '') +
      `. ${r.matched} matched automatically, ${r.suggested} suggested for you to confirm.`);
    loadAccounts();
  };

  // One at a time so a large batch stays inside the email provider's rate limit
  const sendReceipts = async (ids: string[]) => {
    let sent = 0;
    for (const id of ids) sent += (await notify('receipt', id)).sent > 0 ? 1 : 0;
    return sent;
  };

  const verifyAll = async () => {
    const r = await rpc('verify', 'verify_matched_payments', { p_society_id: societyId }) as { verified: number; payment_ids: string[] } | null;
    if (!r) return;
    const sent = await sendReceipts(r.payment_ids);
    done(`${r.verified} payment${r.verified === 1 ? '' : 's'} verified from the bank statement; receipts issued${sent ? ` (${sent} emailed)` : ''}.`);
  };

  const submitAction = async (l: Line) => {
    if (!action) return;
    if (action.kind === 'ignore') {
      if (await rpc(l.id, 'ignore_bank_line', { p_line_id: l.id, p_note: action.value })) done('Line marked as not needing a match.');
    } else if (action.kind === 'record') {
      const r = await rpc(l.id, 'record_bank_receipt', { p_line_id: l.id, p_unit_id: action.value }) as { receipt_number?: string; payment_id: string; status?: string } | null;
      if (!r) return;
      const flat = units.find(u => u.id === action.value)?.unit_number;
      if (r.status === 'pending_verification') {
        done(`${formatINR(l.amount)} recorded for flat ${flat}. The committee verifies it in Payments.`);
      } else {
        await sendReceipts([r.payment_id]);
        done(`${formatINR(l.amount)} recorded for flat ${flat}. Receipt ${r.receipt_number}.`);
      }
    } else {
      const c = candidateById.get(action.value);
      if (c && await rpc(l.id, 'link_bank_line', { p_line_id: l.id, p_kind: c.kind, p_target_id: c.id, p_note: null })) done(`Matched with ${c.label}.`);
    }
  };

  const matchedLabel = (l: Line) => {
    if (l.match_kind === 'payment' && l.payment) {
      return `Flat ${l.payment.unit?.unit_number ?? '—'} · ${l.payment.payment_number}${l.payment.status === 'pending_verification' ? ' · waiting to verify' : ' · verified'}`;
    }
    if (l.match_kind === 'vendor_payment' && l.vendor_payment) return `${l.vendor_payment.payment_number} · ${l.vendor_payment.expense?.title ?? 'Vendor payment'}`;
    if (l.match_kind === 'tds_challan' && l.challan) return `TDS challan ${l.challan.challan_number}`;
    if (l.match_kind === 'ignored') return l.match_note ?? 'No match needed';
    return null;
  };

  const inputClass = 'w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand';
  const account = accounts.find(a => a.id === accountId);
  const bankName = (id: string) => banks.find(b => b.id === id)?.name ?? 'Bank';
  // A new statement account most likely belongs to a bank ledger no other account uses yet
  const unusedBank = () => banks.find(b => !accounts.some(a => a.ledger_id === b.id))?.id ?? defaultBankId(banks, 'receipt') ?? '';
  // Point this statement account at another bank ledger (refused while its matched lines are in another bank)
  const repoint = async (ledgerId: string) => {
    if (!supabase || !account || ledgerId === account.ledger_id) return;
    setBusy('account');
    setError(null);
    const { error: upErr } = await supabase.from('bank_accounts').update({ ledger_id: ledgerId }).eq('id', account.id);
    setBusy(null);
    if (upErr) return setError(upErr.message);
    setNotice(`${account.bank_name} ··${account.account_number.slice(-4)} is now in the books as ${bankName(ledgerId)}.`);
    await loadAccounts();
    loadLines();
  };
  const difference = summary?.statement_balance != null ? Number(summary.statement_balance) - Number(summary.book_balance) : null;

  if (loading) return <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-fg-subtle" /></div>;

  return (
    <div className="space-y-5 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-fg flex items-center gap-2"><Landmark className="w-4 h-4 text-brand" /> Bank statement match</h2>
          <p className="text-fg-muted max-w-2xl">
            Upload the bank statement CSV. Resident UTRs, vendor payments and TDS deposits are matched automatically; you confirm the rest.
            Verified payments issue receipts as usual. Nothing is posted to the books from the statement itself.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {accounts.length > 1 && (
            <select value={accountId} onChange={e => setAccountId(e.target.value)} className={`${inputClass} w-auto`}>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.bank_name} ··{a.account_number.slice(-4)} · {bankName(a.ledger_id)}</option>)}
            </select>
          )}
          {account && (canManage && banks.length > 1 ? (
            <label className="flex items-center gap-1 text-fg-muted">
              In the books as
              <select value={account.ledger_id} disabled={busy !== null} onChange={e => repoint(e.target.value)} className={`${inputClass} w-auto`}>
                {banks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          ) : (
            <span className="text-fg-muted">In the books as {bankName(account.ledger_id)}</span>
          ))}
          {canManage && !newAccount && (
            <button onClick={() => setNewAccount({ ...ACCOUNT_BLANK, ledger_id: unusedBank() })} className="flex items-center gap-1 px-3 py-2 rounded-lg bg-surface-muted hover:bg-border text-fg font-semibold cursor-pointer">
              <Plus className="w-3.5 h-3.5" /> Bank account
            </button>
          )}
        </div>
      </div>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      {newAccount && (
        <form onSubmit={addAccount} className="p-4 rounded-xl bg-surface border border-border grid grid-cols-1 sm:grid-cols-4 gap-2">
          <input required value={newAccount.bank_name} onChange={e => setNewAccount({ ...newAccount, bank_name: e.target.value })} placeholder="Bank (e.g. HDFC Bank)" className={inputClass} />
          <input required value={newAccount.account_number} onChange={e => setNewAccount({ ...newAccount, account_number: e.target.value.replace(/\s/g, '') })} placeholder="Account number" inputMode="numeric" className={inputClass} />
          <input required value={newAccount.ifsc_code} onChange={e => setNewAccount({ ...newAccount, ifsc_code: e.target.value })} placeholder="IFSC" pattern="[A-Za-z]{4}0[A-Za-z0-9]{6}" title="11 characters, e.g. HDFC0001234" className={inputClass} />
          <input required value={newAccount.branch_name} onChange={e => setNewAccount({ ...newAccount, branch_name: e.target.value })} placeholder="Branch" className={inputClass} />
          {banks.length > 1 && (
            <label className="sm:col-span-4 flex items-center gap-2 text-fg-muted">
              Bank in the books
              <select value={newAccount.ledger_id} onChange={e => setNewAccount({ ...newAccount, ledger_id: e.target.value })} className={`${inputClass} w-auto`}>
                {banks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          )}
          <div className="sm:col-span-4 flex justify-end gap-2">
            <button type="button" onClick={() => setNewAccount(null)} className="px-3 py-2 text-fg-muted hover:text-fg cursor-pointer">Cancel</button>
            <button type="submit" disabled={busy === 'account'} className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold cursor-pointer disabled:opacity-50">Save account</button>
          </div>
        </form>
      )}

      {!account ? (
        !newAccount && <EmptyState icon={Landmark} title="No bank account yet" description="Add the society's bank account, then upload its statement to match payments." />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="p-4 rounded-xl bg-surface border border-border">
              <div className="text-fg-muted">Bank statement balance</div>
              <div className="text-lg font-semibold text-fg">{summary?.statement_balance != null ? formatINR(summary.statement_balance) : '—'}</div>
              <div className="text-fg-subtle">{summary?.statement_date ? `as on ${fmtDate(summary.statement_date)}` : 'upload a statement'}</div>
            </div>
            <div className="p-4 rounded-xl bg-surface border border-border">
              <div className="text-fg-muted">Books (Bank Accounts)</div>
              <div className="text-lg font-semibold text-fg">{summary ? formatINR(summary.book_balance) : '—'}</div>
              <div className={difference == null ? 'text-fg-subtle' : Math.abs(difference) < 0.01 ? 'text-success' : 'text-warning'}>
                {difference == null ? 'same date as the statement' : Math.abs(difference) < 0.01 ? 'agrees with the bank' : `differs by ${formatINR(Math.abs(difference))}`}
              </div>
            </div>
            <div className="p-4 rounded-xl bg-surface border border-border">
              <div className="text-fg-muted">Money in, not matched</div>
              <div className="text-lg font-semibold text-success">{formatINR(summary?.open_credit_total ?? 0)}</div>
              <div className="text-fg-subtle">{summary?.open_credits ?? 0} line{summary?.open_credits === 1 ? '' : 's'}</div>
            </div>
            <div className="p-4 rounded-xl bg-surface border border-border">
              <div className="text-fg-muted">Money out, not matched</div>
              <div className="text-lg font-semibold text-danger">{formatINR(summary?.open_debit_total ?? 0)}</div>
              <div className="text-fg-subtle">{summary?.open_debits ?? 0} line{summary?.open_debits === 1 ? '' : 's'}</div>
            </div>
          </div>
          {difference != null && Math.abs(difference) >= 0.01 && (
            <p className="text-fg-subtle">
              A difference is normal while lines are open: bank charges and interest not yet booked, cheques issued but not cleared, or payments still waiting to be verified.
              The books combine all the society&apos;s bank accounts.
            </p>
          )}

          {canVerify && Number(summary?.ready_to_verify) > 0 && (
            <div className="p-4 rounded-xl bg-success-soft border border-success/30 flex flex-wrap items-center justify-between gap-3">
              <div className="text-success">
                <span className="font-semibold">{summary!.ready_to_verify} resident payment{summary!.ready_to_verify === 1 ? '' : 's'}</span> found in the bank with the same UTR and amount.
              </div>
              <button onClick={verifyAll} disabled={busy !== null} className="flex items-center gap-1 px-4 py-2 rounded-lg bg-success hover:bg-success/90 text-on-brand font-semibold cursor-pointer disabled:opacity-50">
                {busy === 'verify' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Verify all {summary!.ready_to_verify}
              </button>
            </div>
          )}

          {canManage && (
            <div className="p-4 rounded-xl bg-surface border border-dashed border-border-strong space-y-3">
              <label className="flex flex-wrap items-center gap-3 cursor-pointer">
                <span className="flex items-center gap-1 px-3 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold"><FileUp className="w-3.5 h-3.5" /> Upload statement</span>
                <span className="text-fg-muted">CSV from net banking — SBI, HDFC, ICICI, Axis, Kotak and most others. Re-uploading the same lines is safe.</span>
                <input type="file" accept=".csv,.txt,text/csv" className="hidden" onChange={e => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
              </label>
              {file && (
                <div className="space-y-2">
                  <div className="text-fg">
                    <span className="font-semibold">{file.name}</span> · {file.parsed.format.toUpperCase()} layout · {file.parsed.rows.length} lines
                    {file.parsed.rows.length > 0 && ` · ${fmtDate(file.parsed.rows[0].date)} – ${fmtDate(file.parsed.rows[file.parsed.rows.length - 1].date)}`}
                    {' · in '}{formatINR(file.parsed.rows.reduce((s, r) => s + r.credit, 0))}{' · out '}{formatINR(file.parsed.rows.reduce((s, r) => s + r.debit, 0))}
                  </div>
                  {file.parsed.warnings.slice(0, 5).map((w, i) => <div key={i} className="text-warning">{w}</div>)}
                  <table className="w-full text-fg">
                    <tbody>
                      {file.parsed.rows.slice(0, 5).map((r, i) => (
                        <tr key={i} className="border-t border-border">
                          <td className="py-1 pr-2 whitespace-nowrap">{fmtDate(r.date)}</td>
                          <td className="py-1 pr-2 truncate max-w-xs">{r.description}</td>
                          <td className="py-1 text-right text-danger">{r.debit ? formatINR(r.debit) : ''}</td>
                          <td className="py-1 text-right text-success">{r.credit ? formatINR(r.credit) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setFile(null)} className="px-3 py-2 text-fg-muted hover:text-fg cursor-pointer">Cancel</button>
                    <button onClick={importFile} disabled={busy !== null || file.parsed.rows.length === 0} className="flex items-center gap-1 px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold cursor-pointer disabled:opacity-50">
                      {busy === 'import' && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Import {file.parsed.rows.length} lines & match
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div role="tablist" className="flex flex-wrap gap-1 p-1 rounded-xl bg-surface border border-border w-fit">
            {([
              ['open', `Open (${(summary?.open_credits ?? 0) + (summary?.open_debits ?? 0)})`],
              ['suggested', `Suggested (${summary?.suggested ?? 0})`],
              ['matched', `Matched (${summary?.matched ?? 0})`],
              ['ignored', `No match needed (${summary?.ignored ?? 0})`],
              ['all', 'All'],
            ] as const).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}
                className={`px-3 py-1.5 rounded-lg font-semibold cursor-pointer ${filter === k ? 'bg-brand text-on-brand' : 'text-fg-muted hover:text-fg'}`}>{label}</button>
            ))}
          </div>

          {shown.length === 0 ? (
            <EmptyState icon={Landmark} title={lines.length === 0 ? 'No statement uploaded yet' : 'Nothing here'}
              description={lines.length === 0 ? 'Upload a CSV statement to see its lines and matches.' : 'Every line in this view is taken care of.'} />
          ) : (
            <div className="space-y-2">
              {shown.map(l => {
                const suggestion = l.suggested_id ? candidateById.get(l.suggested_id) : undefined;
                const label = matchedLabel(l);
                const options = candidates.filter(c => Math.abs(c.amount - Number(l.amount)) < 0.01 && (l.type === 'credit' ? c.kind === 'payment' : c.kind !== 'payment'));
                const acting = action?.lineId === l.id ? action : null;
                return (
                  <div key={l.id} className={`p-3 rounded-xl bg-surface border ${l.match_kind ? 'border-border' : suggestion ? 'border-brand/30' : 'border-warning/20'} space-y-2`}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex items-start gap-2">
                        {l.type === 'credit' ? <ArrowDownLeft className="w-4 h-4 text-success shrink-0" /> : <ArrowUpRight className="w-4 h-4 text-danger shrink-0" />}
                        <div className="min-w-0">
                          <div className="text-fg break-words">{l.description}</div>
                          <div className="text-fg-subtle">{fmtDate(l.transaction_date)}{l.reference_number && ` · ref ${l.reference_number}`}</div>
                        </div>
                      </div>
                      <div className={`font-semibold text-sm ${l.type === 'credit' ? 'text-success' : 'text-danger'}`}>{l.type === 'credit' ? '+' : '−'}{formatINR(l.amount)}</div>
                    </div>

                    {label && (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className={l.match_kind === 'ignored' ? 'text-fg-muted' : 'text-success'}>
                          {l.match_kind === 'ignored' ? <EyeOff className="w-3.5 h-3.5 inline mr-1" /> : <CheckCircle2 className="w-3.5 h-3.5 inline mr-1" />}
                          {label}{l.match_method && l.match_method !== 'manual' && l.match_kind !== 'ignored' && ` · ${l.match_method === 'recorded' ? 'recorded from statement' : `auto (${l.match_method === 'utr' ? 'UTR' : 'reference'})`}`}
                        </span>
                        {canManage && l.match_method !== 'recorded' && (
                          <button onClick={async () => { if (await rpc(l.id, 'unlink_bank_line', { p_line_id: l.id })) done('Line reopened.'); }} disabled={busy !== null}
                            className="flex items-center gap-1 text-fg-subtle hover:text-danger cursor-pointer"><Unlink className="w-3.5 h-3.5" /> Unlink</button>
                        )}
                      </div>
                    )}

                    {!l.match_kind && canManage && (
                      <div className="flex flex-wrap items-center gap-2">
                        {suggestion && (
                          <button onClick={async () => { if (await rpc(l.id, 'confirm_bank_suggestion', { p_line_id: l.id })) done(`Matched with ${suggestion.label}.`); }} disabled={busy !== null}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold cursor-pointer disabled:opacity-50">
                            {busy === l.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} Same as {suggestion.label}
                          </button>
                        )}
                        {options.length > 0 && (
                          <button onClick={() => setAction(acting?.kind === 'link' ? null : { lineId: l.id, kind: 'link', value: '' })} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-muted text-fg font-semibold cursor-pointer">
                            <Link2 className="w-3.5 h-3.5" /> Match with…
                          </button>
                        )}
                        {l.type === 'credit' && (
                          <button onClick={() => setAction(acting?.kind === 'record' ? null : { lineId: l.id, kind: 'record', value: '' })} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-muted text-success font-semibold cursor-pointer">
                            <Plus className="w-3.5 h-3.5" /> Record as a flat&apos;s payment
                          </button>
                        )}
                        <button onClick={() => setAction(acting?.kind === 'ignore' ? null : { lineId: l.id, kind: 'ignore', value: '' })} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-muted text-fg-muted font-semibold cursor-pointer">
                          <EyeOff className="w-3.5 h-3.5" /> No match needed
                        </button>
                        {!suggestion && options.length === 0 && l.type === 'debit' && (
                          <span className="text-fg-subtle">No vendor payment or TDS challan of {formatINR(l.amount)} — record it in Expenses first, or mark it (e.g. bank charges).</span>
                        )}
                      </div>
                    )}

                    {acting && (
                      <div className="flex flex-col sm:flex-row gap-2">
                        {acting.kind === 'link' && (
                          <select autoFocus value={acting.value} onChange={e => setAction({ ...acting, value: e.target.value })} className={`flex-1 ${inputClass}`}>
                            <option value="">Choose the matching entry ({formatINR(l.amount)})…</option>
                            {options.map(c => <option key={c.id} value={c.id}>{fmtDate(c.date)} · {c.label}</option>)}
                          </select>
                        )}
                        {acting.kind === 'record' && (
                          <select autoFocus value={acting.value} onChange={e => setAction({ ...acting, value: e.target.value })} className={`flex-1 ${inputClass}`}>
                            <option value="">Which flat paid {formatINR(l.amount)}?</option>
                            {units.map(u => <option key={u.id} value={u.id}>Flat {u.unit_number}</option>)}
                          </select>
                        )}
                        {acting.kind === 'ignore' && (
                          <input autoFocus value={acting.value} onChange={e => setAction({ ...acting, value: e.target.value })}
                            placeholder="Why? e.g. bank charges, interest, transfer between our accounts" className={`flex-1 ${inputClass}`} />
                        )}
                        <button onClick={() => submitAction(l)} disabled={busy !== null || (acting.kind === 'ignore' ? acting.value.trim().length < 3 : !acting.value)}
                          className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1">
                          {busy === l.id && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                          {acting.kind === 'record' ? 'Record & verify' : 'Save'}
                        </button>
                      </div>
                    )}
                    {acting?.kind === 'record' && (
                      <p className="text-fg-subtle">Creates a verified payment for the flat&apos;s owner dated {fmtDate(l.transaction_date)}, settles the oldest dues and issues a receipt.</p>
                    )}
                  </div>
                );
              })}
              {lines.length === 500 && <p className="text-fg-subtle">Showing the latest 500 lines.</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
};
