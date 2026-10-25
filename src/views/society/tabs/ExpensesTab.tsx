'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase/client';
import { formatINR } from '../../../lib/inr';
import { deleteSocietyFile, openSocietyFile, uploadSocietyFile } from '../../../lib/storage';
import { assetTypeLabel } from '../../../lib/tds';
import { Banner } from '../../../components/Banner';
import { EmptyState } from '../../../components/EmptyState';
import { ExpenseBillForm } from './ExpenseBillForm';
import { Expense, ExpenseCategory, ExpenseStatus, Vendor, VendorPayment } from '../../../types/database';
import { Receipt, Loader2, CheckCircle2, XCircle, Banknote, Paperclip, ChevronDown, ChevronUp, Landmark, FileWarning } from 'lucide-react';

const STATUS_STYLES: Record<ExpenseStatus, string> = {
  draft: 'bg-slate-800 text-slate-300',
  pending_approval: 'bg-amber-500/10 text-amber-300',
  approved: 'bg-sky-500/10 text-sky-300',
  rejected: 'bg-rose-500/10 text-rose-300',
  paid: 'bg-emerald-500/10 text-emerald-300',
  voided: 'bg-slate-800 text-slate-500',
};

type Filter = 'all' | 'approval' | 'to_pay' | 'invoice_pending' | 'paid';

interface ApprovalRow {
  expense_id: string;
  approver_id: string;
  decision: 'approved' | 'rejected';
  notes: string | null;
  profiles: { full_name: string } | null;
}

interface PaymentDraft { id: string; amount: number; tds: number; mode: VendorPayment['mode']; reference: string; date: string; proof: File | null }

interface ExpensesTabProps {
  societyId: string;
  currentUserId?: string;
  expenses: Expense[];
  onChanged: () => void;
}

const today = () => new Date().toISOString().slice(0, 10);
const gross = (e: Expense) => Number(e.subtotal) + Number(e.gst_amount);
const outstanding = (e: Expense) => Math.max(gross(e) - Number(e.amount_settled ?? 0), 0);
const tdsLeft = (e: Expense) => Math.max(Number(e.tds_amount) - Number(e.tds_deducted ?? 0), 0);

/** Platform defaults plus the society's own categories (a society row overrides the same key). */
function mergeCategories(rows: ExpenseCategory[]): ExpenseCategory[] {
  const byKey = new Map<string, ExpenseCategory>();
  for (const c of rows) if (!byKey.has(c.key) || c.society_id) byKey.set(c.key, c);
  return [...byKey.values()].sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label));
}

export const ExpensesTab: React.FC<ExpensesTabProps> = ({ societyId, currentUserId, expenses, onChanged }) => {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [payments, setPayments] = useState<VendorPayment[]>([]);
  const [challansTotal, setChallansTotal] = useState(0);
  const [requiredApprovals, setRequiredApprovals] = useState(1);
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; reason: string } | null>(null);
  const [paying, setPaying] = useState<PaymentDraft | null>(null);
  const [challan, setChallan] = useState<{ number: string; amount: number; date: string; month: string; section: string } | null>(null);
  const [attaching, setAttaching] = useState<{ id: string; file: File | null; invoiceNumber: string; date: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [vRes, cRes, aRes, pRes, tRes, sRes] = await Promise.all([
      supabase.from('vendors').select('*').eq('society_id', societyId).order('name'),
      supabase.from('expense_categories').select('*').eq('is_active', true),
      supabase.from('expense_approvals').select('expense_id, approver_id, decision, notes, profiles:approver_id (full_name)').eq('society_id', societyId),
      supabase.from('vendor_payments').select('*').eq('society_id', societyId).order('paid_on', { ascending: false }),
      supabase.from('tds_challans').select('amount').eq('society_id', societyId),
      supabase.from('society_settings').select('require_two_step_expense_approval').eq('society_id', societyId).maybeSingle(),
    ]);
    setVendors((vRes.data ?? []) as Vendor[]);
    setCategories(mergeCategories((cRes.data ?? []) as ExpenseCategory[]));
    setApprovals(((aRes.data ?? []) as unknown) as ApprovalRow[]);
    setPayments((pRes.data ?? []) as VendorPayment[]);
    setChallansTotal((tRes.data ?? []).reduce((s, r) => s + Number(r.amount), 0));
    setRequiredApprovals(sRes.data?.require_two_step_expense_approval ? 2 : 1);
  }, [societyId]);

  useEffect(() => {
    load();
  }, [load, expenses]);

  const done = (msg: string) => {
    setError(null);
    setNotice(msg);
    load();
    onChanged();
  };

  const live = expenses.filter(e => e.status !== 'voided' && e.status !== 'rejected');
  const payables = live.filter(e => e.status === 'approved');
  const payableTotal = payables.reduce((s, e) => s + outstanding(e), 0);
  const tdsPayable = Math.max(live.reduce((s, e) => s + Number(e.tds_deducted ?? 0), 0) - challansTotal, 0);
  const invoicePending = live.filter(e => e.invoice_status === 'pending');

  const shown = useMemo(() => expenses.filter(e => {
    if (filter === 'approval') return e.status === 'pending_approval';
    if (filter === 'to_pay') return e.status === 'approved';
    if (filter === 'invoice_pending') return e.invoice_status === 'pending' && e.status !== 'voided';
    if (filter === 'paid') return e.status === 'paid';
    return true;
  }), [expenses, filter]);

  const decide = async (exp: Expense, approve: boolean, reason?: string) => {
    if (!supabase) return;
    setBusy(exp.id);
    const { data, error: rpcErr } = await supabase.rpc('decide_expense', { p_expense_id: exp.id, p_approve: approve, p_notes: reason ?? null });
    setBusy(null);
    if (rpcErr) return setError(rpcErr.message);
    const r = data as { status: string; approvals: number; required: number };
    setRejecting(null);
    done(
      r.status === 'approved'
        ? `${exp.expense_number} approved — ${exp.expense_type === 'capital' ? 'added to the asset register and ' : ''}now payable.`
        : r.status === 'rejected' ? `${exp.expense_number} rejected.`
        : `Approval recorded (${r.approvals}/${r.required}).`
    );
  };

  const startPayment = (exp: Expense) => {
    if (paying?.id === exp.id) return setPaying(null);
    const tds = tdsLeft(exp);
    setPaying({ id: exp.id, amount: outstanding(exp) - tds, tds, mode: 'neft', reference: '', date: today(), proof: null });
  };

  const recordPayment = async (exp: Expense) => {
    if (!supabase || !paying) return;
    setBusy(exp.id);
    let proofPath: string | null = null;
    try {
      if (paying.proof) proofPath = await uploadSocietyFile(societyId, 'expenses', paying.proof);
      const { data, error: rpcErr } = await supabase.rpc('record_vendor_payment', {
        p_expense_id: exp.id, p_amount: paying.amount, p_tds: paying.tds, p_mode: paying.mode,
        p_reference: paying.reference || null, p_paid_on: paying.date, p_proof_url: proofPath,
      });
      if (rpcErr) throw new Error(rpcErr.message);
      const r = data as { payment_number: string; outstanding: number; status: string };
      setPaying(null);
      done(r.status === 'paid'
        ? `${r.payment_number} recorded — ${exp.expense_number} fully paid.`
        : `${r.payment_number} recorded — ${formatINR(r.outstanding)} still payable.`);
    } catch (err) {
      if (proofPath) await deleteSocietyFile(proofPath);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const recordChallan = async () => {
    if (!supabase || !challan) return;
    setBusy('challan');
    const { error: rpcErr } = await supabase.rpc('record_tds_challan', {
      p_society_id: societyId, p_challan_number: challan.number, p_amount: challan.amount, p_paid_on: challan.date,
      p_period_month: `${challan.month}-01`, p_section: challan.section || null,
    });
    setBusy(null);
    if (rpcErr) return setError(rpcErr.message);
    setChallan(null);
    done('TDS deposit recorded.');
  };

  const attachInvoice = async (exp: Expense) => {
    if (!supabase || !attaching?.file) return;
    setBusy(exp.id);
    let path: string | null = null;
    try {
      path = await uploadSocietyFile(societyId, 'expenses', attaching.file);
      const { error: rpcErr } = await supabase.rpc('attach_expense_invoice', {
        p_expense_id: exp.id, p_document_url: path, p_invoice_number: attaching.invoiceNumber || null, p_invoice_date: attaching.date || null,
      });
      if (rpcErr) throw new Error(rpcErr.message);
      setAttaching(null);
      done(`Invoice attached to ${exp.expense_number}.`);
    } catch (err) {
      if (path) await deleteSocietyFile(path);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  // Records are never deleted once approved/paid; voiding keeps the audit trail and reverses the books
  const voidExpense = async (exp: Expense) => {
    if (!supabase) return;
    const paidSomething = Number(exp.amount_settled) > 0;
    const reason = window.prompt(
      `Void ${exp.expense_number}?${paidSomething ? ' Recorded payments and the ledger entries will be reversed.' : ''} Enter the reason:`,
      'Duplicate entry'
    );
    if (!reason?.trim()) return;
    setBusy(exp.id);
    const { error: rpcErr } = await supabase.rpc('void_expense', { p_expense_id: exp.id, p_reason: reason.trim() });
    setBusy(null);
    if (rpcErr) return setError(rpcErr.message);
    done(`${exp.expense_number} voided and reversed in the ledger.`);
  };

  const openFile = async (path: string) => {
    try {
      await openSocietyFile(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const vendorName = (id?: string) => vendors.find(v => v.id === id)?.name;
  const approvalsFor = (id: string) => approvals.filter(a => a.expense_id === id);
  const paymentsFor = (id: string) => payments.filter(p => p.expense_id === id);
  const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500';

  return (
    <div className="space-y-6 text-xs">
      <div>
        <h2 className="text-lg font-bold text-white">Expenses & Payables</h2>
        <p className="text-slate-400">
          Upload the vendor&apos;s invoice and we fill the bill. Whoever records a bill cannot approve it ({requiredApprovals === 2 ? 'two approvals' : 'one approval'} needed).
          Approval books it as payable (or as an asset); payments are recorded as you pay from the society&apos;s bank.
        </p>
      </div>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <button onClick={() => setFilter('to_pay')} className="p-4 rounded-2xl bg-slate-900 border border-slate-800 text-left cursor-pointer hover:border-sky-700">
          <div className="text-slate-400">Society owes vendors</div>
          <div className="text-xl font-bold text-white">{formatINR(payableTotal)}</div>
          <div className="text-slate-500">{payables.length} approved bill{payables.length === 1 ? '' : 's'}</div>
        </button>
        <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
          <div className="text-slate-400">TDS to deposit</div>
          <div className="text-xl font-bold text-white">{formatINR(tdsPayable)}</div>
          <button onClick={() => setChallan(challan ? null : { number: '', amount: tdsPayable, date: today(), month: today().slice(0, 7), section: '' })}
            className="mt-1 text-sky-400 hover:underline cursor-pointer">Record challan (due by the 7th of next month)</button>
        </div>
        <button onClick={() => setFilter('invoice_pending')} className="p-4 rounded-2xl bg-slate-900 border border-slate-800 text-left cursor-pointer hover:border-amber-700">
          <div className="text-slate-400">Invoices still to collect</div>
          <div className={`text-xl font-bold ${invoicePending.length ? 'text-amber-300' : 'text-white'}`}>{invoicePending.length}</div>
          <div className="text-slate-500">Bills recorded with “invoice comes later”</div>
        </button>
      </div>

      {challan && (
        <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
          <label className="col-span-2 space-y-1"><span className="text-slate-400">Challan no. (CIN)</span>
            <input value={challan.number} onChange={e => setChallan({ ...challan, number: e.target.value })} className={inputClass} /></label>
          <label className="space-y-1"><span className="text-slate-400">Amount</span>
            <input type="number" min={0} value={challan.amount || ''} onChange={e => setChallan({ ...challan, amount: Number(e.target.value) })} className={inputClass} /></label>
          <label className="space-y-1"><span className="text-slate-400">Paid on</span>
            <input type="date" value={challan.date} onChange={e => setChallan({ ...challan, date: e.target.value })} className={inputClass} /></label>
          <label className="space-y-1"><span className="text-slate-400">For month</span>
            <input type="month" value={challan.month} onChange={e => setChallan({ ...challan, month: e.target.value })} className={inputClass} /></label>
          <button onClick={recordChallan} disabled={!challan.number.trim() || challan.amount <= 0 || busy !== null}
            className="py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1">
            <Landmark className="w-3.5 h-3.5" /> Save
          </button>
        </div>
      )}

      <ExpenseBillForm
        societyId={societyId}
        vendors={vendors}
        categories={categories}
        requiredApprovals={requiredApprovals}
        onVendorsChanged={load}
        onCreated={done}
      />

      <div className="flex flex-wrap gap-1.5">
        {([['all', 'All'], ['approval', 'Needs approval'], ['to_pay', 'To pay'], ['invoice_pending', 'Invoice pending'], ['paid', 'Paid']] as [Filter, string][]).map(([f, label]) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full font-semibold cursor-pointer ${filter === f ? 'bg-sky-600 text-white' : 'bg-slate-900 border border-slate-800 text-slate-300'}`}>{label}</button>
        ))}
      </div>

      {shown.length === 0 ? (
        <EmptyState icon={Receipt} title={expenses.length ? 'Nothing here' : 'No Expenses Logged'} description="Upload a vendor invoice above to record a bill." />
      ) : (
        <div className="space-y-2">
          {shown.map(exp => {
            const list = approvalsFor(exp.id);
            const approvedCount = list.filter(a => a.decision === 'approved').length;
            const iDecided = list.some(a => a.approver_id === currentUserId);
            const iCreated = exp.created_by === currentUserId;
            const canDecide = exp.status === 'pending_approval' && !iCreated && !iDecided;
            const due = outstanding(exp);
            const vps = paymentsFor(exp.id);
            const settledPct = gross(exp) > 0 ? Math.min(100, (Number(exp.amount_settled) / gross(exp)) * 100) : 0;
            return (
              <div key={exp.id} className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] text-slate-400 font-mono">
                      {exp.voucher_number ? `${exp.voucher_number} · ` : ''}{exp.expense_number} • {categories.find(c => c.key === exp.category)?.label ?? exp.category}
                      {vendorName(exp.vendor_id) && ` • ${vendorName(exp.vendor_id)}`}{exp.payee_name && ` • paid to ${exp.payee_name}`}
                    </div>
                    <div className="font-bold text-white text-sm truncate flex items-center gap-2">
                      {exp.title}
                      {exp.expense_type === 'capital' && <span className="px-1.5 py-px rounded-full text-[9px] font-bold uppercase bg-sky-500/15 text-sky-300" title={assetTypeLabel(exp.asset_account_code)}>Asset</span>}
                      {exp.invoice_status === 'pending' && <span className="px-1.5 py-px rounded-full text-[9px] font-bold uppercase bg-amber-500/15 text-amber-300">Invoice pending</span>}
                      {exp.invoice_status === 'none' && <span className="px-1.5 py-px rounded-full text-[9px] font-bold uppercase bg-slate-800 text-slate-300">No invoice</span>}
                    </div>
                    <div className="text-slate-400">
                      {formatINR(exp.subtotal)} + GST {formatINR(exp.gst_amount)} − TDS {formatINR(exp.tds_amount)}{exp.tds_section && ` (${exp.tds_section} ${exp.tds_rate}%)`}
                      {exp.invoice_number && ` • Inv ${exp.invoice_number}`}
                      {exp.tds_override_reason && <span className="text-amber-300"> • TDS changed: {exp.tds_override_reason}</span>}
                    </div>
                  </div>
                  <div className="text-right shrink-0 space-y-1">
                    <div className="font-bold text-white">{formatINR(exp.net_payable)}</div>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold ${STATUS_STYLES[exp.status]}`}>
                      {exp.payment_status === 'partial' && exp.status === 'approved' ? 'part paid' : exp.status.replace('_', ' ')}
                    </span>
                  </div>
                </div>

                {(exp.status === 'approved' || exp.status === 'paid') && Number(exp.amount_settled) > 0 && (
                  <div className="space-y-1">
                    <div className="h-1.5 rounded-full bg-slate-800"><div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${settledPct}%` }} /></div>
                    <div className="text-slate-500">
                      {vps.filter(p => p.status === 'recorded').map(p => `${p.payment_number} ${formatINR(p.amount)}${Number(p.tds_amount) ? ` + TDS ${formatINR(p.tds_amount)}` : ''} (${p.mode.toUpperCase()} ${p.paid_on})`).join(' · ')}
                      {due > 0 && <span className="text-amber-300"> · {formatINR(due)} still payable</span>}
                    </div>
                  </div>
                )}

                {list.length > 0 && (
                  <div className="text-slate-400">
                    {list.map(a => (
                      <span key={a.approver_id} className={`mr-3 ${a.decision === 'approved' ? 'text-emerald-300' : 'text-rose-300'}`}>
                        {a.decision === 'approved' ? '✓' : '✗'} {a.profiles?.full_name ?? 'Committee'}{a.notes ? `: ${a.notes}` : ''}
                      </span>
                    ))}
                    {exp.status === 'pending_approval' && <span>({approvedCount}/{requiredApprovals})</span>}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {exp.document_url && (
                    <button onClick={() => openFile(exp.document_url!)} className="flex items-center gap-1 text-sky-400 hover:underline cursor-pointer">
                      <Paperclip className="w-3.5 h-3.5" /> {exp.invoice_status === 'none' ? 'Proof' : 'Invoice'}
                    </button>
                  )}
                  {exp.status === 'pending_approval' && iCreated && <span className="text-slate-500">Waiting for another committee member</span>}
                  {canDecide && (
                    <>
                      <button onClick={() => decide(exp, true)} disabled={busy !== null} className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold cursor-pointer disabled:opacity-50">
                        {busy === exp.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Approve
                      </button>
                      <button onClick={() => setRejecting(rejecting?.id === exp.id ? null : { id: exp.id, reason: '' })} className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-slate-800 text-rose-300 font-semibold cursor-pointer">
                        <XCircle className="w-3.5 h-3.5" /> Reject {rejecting?.id === exp.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      </button>
                    </>
                  )}
                  {exp.status === 'approved' && (
                    <button onClick={() => startPayment(exp)} className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer">
                      <Banknote className="w-3.5 h-3.5" /> Record payment
                    </button>
                  )}
                  {exp.invoice_status === 'pending' && exp.status !== 'voided' && (
                    <button onClick={() => setAttaching(attaching?.id === exp.id ? null : { id: exp.id, file: null, invoiceNumber: '', date: '' })}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-slate-800 text-amber-300 font-semibold cursor-pointer">
                      <FileWarning className="w-3.5 h-3.5" /> Attach invoice{exp.invoice_due_by ? ` (due ${exp.invoice_due_by})` : ''}
                    </button>
                  )}
                  {(exp.status === 'approved' || exp.status === 'paid') && (
                    <button onClick={() => voidExpense(exp)} disabled={busy !== null} className="text-slate-500 hover:text-rose-400 cursor-pointer disabled:opacity-50" title="Void and reverse the ledger entries">
                      Void
                    </button>
                  )}
                </div>

                {rejecting?.id === exp.id && (
                  <div className="flex gap-2">
                    <input autoFocus value={rejecting.reason} onChange={e => setRejecting({ id: exp.id, reason: e.target.value })} placeholder="Reason, e.g. quotation too high" className={`flex-1 ${inputClass}`} />
                    <button onClick={() => decide(exp, false, rejecting.reason)} disabled={!rejecting.reason.trim() || busy !== null} className="px-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold cursor-pointer disabled:opacity-50">Confirm</button>
                  </div>
                )}

                {paying?.id === exp.id && (
                  <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                    <div className="text-slate-400">Pay from the society&apos;s bank first, then record it here. Partial payments are fine.</div>
                    <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
                      <label className="space-y-1"><span className="text-slate-400">Paid now (₹)</span>
                        <input type="number" min={0} step="0.01" value={paying.amount || ''} onChange={e => setPaying({ ...paying, amount: Number(e.target.value) })} className={inputClass} /></label>
                      <label className="space-y-1"><span className="text-slate-400">TDS deducted (₹)</span>
                        <input type="number" min={0} step="1" max={tdsLeft(exp)} value={paying.tds || ''} onChange={e => setPaying({ ...paying, tds: Number(e.target.value) })} className={inputClass} /></label>
                      <label className="space-y-1"><span className="text-slate-400">Mode</span>
                        <select value={paying.mode} onChange={e => setPaying({ ...paying, mode: e.target.value as PaymentDraft['mode'] })} className={inputClass}>
                          <option value="neft">NEFT / RTGS</option><option value="upi">UPI</option><option value="cheque">Cheque</option><option value="cash">Cash</option>
                        </select></label>
                      <label className="space-y-1"><span className="text-slate-400">UTR / cheque no.</span>
                        <input value={paying.reference} onChange={e => setPaying({ ...paying, reference: e.target.value })} className={inputClass} /></label>
                      <label className="space-y-1"><span className="text-slate-400">Paid on</span>
                        <input type="date" max={today()} value={paying.date} onChange={e => setPaying({ ...paying, date: e.target.value })} className={inputClass} /></label>
                      <label className="space-y-1"><span className="text-slate-400">Proof (optional)</span>
                        <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" onChange={e => setPaying({ ...paying, proof: e.target.files?.[0] ?? null })}
                          className="w-full text-slate-300 file:mr-2 file:px-2 file:py-1.5 file:rounded-lg file:border-0 file:bg-slate-800 file:text-slate-200" /></label>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-slate-300">
                        Settles {formatINR(paying.amount + paying.tds)} of {formatINR(due)}
                        {due - paying.amount - paying.tds > 0.005 && <> · {formatINR(due - paying.amount - paying.tds)} left</>}
                      </span>
                      <button onClick={() => recordPayment(exp)} disabled={busy !== null || paying.amount + paying.tds <= 0}
                        className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold cursor-pointer disabled:opacity-50">
                        {busy === exp.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save payment'}
                      </button>
                    </div>
                  </div>
                )}

                {attaching?.id === exp.id && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
                    <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" onChange={e => setAttaching({ ...attaching, file: e.target.files?.[0] ?? null })}
                      className="col-span-2 sm:col-span-1 text-slate-300 file:mr-2 file:px-2 file:py-1.5 file:rounded-lg file:border-0 file:bg-slate-800 file:text-slate-200" />
                    <input value={attaching.invoiceNumber} onChange={e => setAttaching({ ...attaching, invoiceNumber: e.target.value })} placeholder="Invoice no." className={inputClass} />
                    <input type="date" value={attaching.date} onChange={e => setAttaching({ ...attaching, date: e.target.value })} className={inputClass} />
                    <button onClick={() => attachInvoice(exp)} disabled={!attaching.file || busy !== null} className="py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer disabled:opacity-50">Attach</button>
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
