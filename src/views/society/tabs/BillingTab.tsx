'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase/client';
import { formatINR } from '../../../lib/inr';
import { describeNotify, notify } from '../../../lib/notify';
import { EmptyState } from '../../../components/EmptyState';
import { Bill, BillingRule, BillStatus, GenerateBillsResult, Unit } from '../../../types/database';
import {
  CreditCard, Plus, Trash2, AlertCircle, CheckCircle2, Loader2, Eye, Send, Clock, Power,
} from 'lucide-react';

interface BillingTabProps {
  societyId: string;
  bills: Bill[];
  /** Society-wide totals from society_summary() (lists are capped, totals are not) */
  totalsOverride?: { billed: number; collected: number; due: number } | null;
  units: Unit[];
  loading: boolean;
  onChanged: () => void;
}

type RuleDraft = Pick<BillingRule, 'name' | 'calculation_type' | 'rate' | 'tax_rate_percent' | 'applies_to_unit_type' | 'account_code'>;

const EMPTY_RULE: RuleDraft = { name: '', calculation_type: 'flat_per_unit', rate: 0, tax_rate_percent: 0, applies_to_unit_type: '', account_code: '4000' };

// Fund contributions are credited to the fund, not to income (must match chk_billing_rules_account_code)
const CREDIT_ACCOUNTS: { code: BillingRule['account_code']; label: string }[] = [
  { code: '4000', label: 'Maintenance income' },
  { code: '3000', label: 'Sinking fund' },
  { code: '3100', label: 'Repair fund' },
  { code: '3200', label: 'General reserve' },
  { code: '4200', label: 'Other income' },
];
const creditLabel = (code: string) => CREDIT_ACCOUNTS.find(a => a.code === code)?.label ?? code;

const STATUS_STYLES: Record<BillStatus, string> = {
  draft: 'bg-slate-800 text-slate-300',
  issued: 'bg-sky-500/10 text-sky-300',
  partially_paid: 'bg-amber-500/10 text-amber-300',
  paid: 'bg-emerald-500/10 text-emerald-300',
  overdue: 'bg-rose-500/10 text-rose-300',
  cancelled: 'bg-slate-800 text-slate-500',
};

function monthBounds(month: string) {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start, end: `${month}-${String(lastDay).padStart(2, '0')}` };
}

export const BillingTab: React.FC<BillingTabProps> = ({ societyId, bills, totalsOverride, units, loading, onChanged }) => {
  const [rules, setRules] = useState<BillingRule[]>([]);
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_RULE);
  const [savingRule, setSavingRule] = useState(false);

  const today = new Date();
  const [month, setMonth] = useState(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`);
  const [dueDay, setDueDay] = useState(10);
  const [preview, setPreview] = useState<GenerateBillsResult | null>(null);
  const [working, setWorking] = useState<'preview' | 'generate' | 'late' | null>(null);

  const [statusFilter, setStatusFilter] = useState<BillStatus | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const unitNumber = (id: string) => units.find(u => u.id === id)?.unit_number ?? '—';
  const unitTypes = useMemo(() => [...new Set(units.map(u => u.unit_type))].sort(), [units]);

  const loadRules = useCallback(async () => {
    if (!supabase) return;
    const [rRes, sRes] = await Promise.all([
      supabase.from('billing_rules').select('*').eq('society_id', societyId).order('created_at'),
      supabase.from('society_settings').select('due_day_of_month').eq('society_id', societyId).maybeSingle(),
    ]);
    setRules((rRes.data ?? []) as BillingRule[]);
    if (sRes.data?.due_day_of_month) setDueDay(sRes.data.due_day_of_month);
  }, [societyId]);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  const showError = (msg: string) => {
    setNotice(null);
    setError(msg);
  };

  // ----- Rules -----
  const addRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    if (!draft.name.trim() || draft.rate <= 0) {
      showError('Enter a rule name and a rate greater than 0.');
      return;
    }
    setSavingRule(true);
    const { error: insErr } = await supabase.from('billing_rules').insert({
      society_id: societyId,
      name: draft.name.trim(),
      calculation_type: draft.calculation_type,
      rate: draft.rate,
      tax_rate_percent: draft.tax_rate_percent,
      applies_to_unit_type: draft.applies_to_unit_type || null,
      account_code: draft.account_code,
    });
    setSavingRule(false);
    if (insErr) return showError(insErr.message);
    setDraft(EMPTY_RULE);
    setError(null);
    loadRules();
  };

  const toggleRule = async (rule: BillingRule) => {
    if (!supabase) return;
    const { error: updErr } = await supabase.from('billing_rules').update({ is_active: !rule.is_active }).eq('id', rule.id);
    if (updErr) return showError(updErr.message);
    loadRules();
  };

  const deleteRule = async (rule: BillingRule) => {
    if (!supabase || !window.confirm(`Delete rule "${rule.name}"? Existing bills are not affected.`)) return;
    const { error: delErr } = await supabase.from('billing_rules').delete().eq('id', rule.id);
    if (delErr) return showError(delErr.message);
    loadRules();
  };

  // ----- Generate -----
  const runGenerate = async (dryRun: boolean) => {
    if (!supabase) return;
    const { start, end } = monthBounds(month);
    const due = `${month}-${String(Math.min(Math.max(dueDay, 1), 28)).padStart(2, '0')}`;
    setWorking(dryRun ? 'preview' : 'generate');
    setError(null);
    const { data, error: rpcErr } = await supabase.rpc('generate_bills', {
      p_society_id: societyId,
      p_period_start: start,
      p_period_end: end,
      p_due_date: due,
      p_cycle_name: null,
      p_dry_run: dryRun,
    });
    setWorking(null);
    if (rpcErr) {
      setPreview(null);
      return showError(rpcErr.message);
    }
    const result = data as GenerateBillsResult;
    if (dryRun) {
      setPreview(result);
      setNotice(null);
    } else {
      setPreview(null);
      const emailed = result.cycle_id ? await notify('bills_issued', result.cycle_id) : null;
      setNotice(
        `${result.cycle_name}: ${result.bills} bills issued for ${formatINR(result.total_amount)}. Residents can see and pay them now.` +
          (emailed ? describeNotify(emailed, 'owner') : '')
      );
      onChanged();
    }
  };

  const applyLateFees = async () => {
    if (!supabase) return;
    setWorking('late');
    const { data, error: rpcErr } = await supabase.rpc('apply_late_fees', { p_society_id: societyId });
    setWorking(null);
    if (rpcErr) return showError(rpcErr.message);
    const r = data as { marked_overdue: number; late_fees_applied: number; late_fee_total: number };
    setError(null);
    setNotice(
      r.marked_overdue === 0 && r.late_fees_applied === 0
        ? 'No bills are past their due date.'
        : `${r.marked_overdue} bills marked overdue, late fee added to ${r.late_fees_applied} bills (${formatINR(r.late_fee_total)}).`
    );
    onChanged();
  };

  // Wrong bill? Cancel it (reverses the ledger entry); bills with payments cannot be cancelled
  const cancelBill = async (b: Bill) => {
    if (!supabase) return;
    const reason = window.prompt(`Cancel bill ${b.bill_number} for flat ${unitNumber(b.unit_id)}? Enter the reason:`, 'Wrong amount');
    if (!reason?.trim()) return;
    setWorking('late');
    const { error: rpcErr } = await supabase.rpc('cancel_bill', { p_bill_id: b.id, p_reason: reason.trim() });
    setWorking(null);
    if (rpcErr) return showError(rpcErr.message);
    setError(null);
    setNotice(`Bill ${b.bill_number} cancelled and reversed in the ledger. You can issue a corrected bill for the same period.`);
    onChanged();
  };

  // ----- Bills summary -----
  const filteredBills = statusFilter === 'all' ? bills : bills.filter(b => b.status === statusFilter);
  const listTotals = bills.filter(b => b.status !== 'cancelled').reduce(
    (acc, b) => ({ billed: acc.billed + Number(b.total_amount), collected: acc.collected + Number(b.amount_paid), due: acc.due + Number(b.balance_due) }),
    { billed: 0, collected: 0, due: 0 }
  );
  const totals = totalsOverride ?? listTotals;

  const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500';
  const activeRules = rules.filter(r => r.is_active);

  return (
    <div className="space-y-6 text-xs">
      <div>
        <h2 className="text-lg font-bold text-white">Maintenance Billing</h2>
        <p className="text-slate-400">Set charges once, then issue every month&apos;s bills in one click.</p>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> <span>{notice}</span>
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Total Billed', value: totals.billed, cls: 'text-white' },
          { label: 'Collected', value: totals.collected, cls: 'text-emerald-400' },
          { label: 'Outstanding', value: totals.due, cls: 'text-amber-400' },
        ].map(s => (
          <div key={s.label} className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
            <div className="text-slate-400">{s.label}</div>
            <div className={`text-base font-bold ${s.cls}`}>{formatINR(s.value)}</div>
          </div>
        ))}
      </div>

      {/* Rules */}
      <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
        <div className="font-bold text-white text-sm">1. Charges (Billing Rules)</div>
        {rules.length > 0 && (
          <div className="divide-y divide-slate-800 rounded-xl border border-slate-800">
            {rules.map(r => (
              <div key={r.id} className={`p-3 flex items-center justify-between gap-3 ${r.is_active ? '' : 'opacity-50'}`}>
                <div className="min-w-0">
                  <div className="font-semibold text-white truncate">{r.name}</div>
                  <div className="text-slate-400">
                    {r.calculation_type === 'per_sqft' ? `${formatINR(r.rate)} / sq.ft carpet` : `${formatINR(r.rate)} per flat`}
                    {Number(r.tax_rate_percent) > 0 && ` + ${r.tax_rate_percent}% GST`}
                    {r.applies_to_unit_type && ` • only ${r.applies_to_unit_type}`}
                    {` • → ${creditLabel(r.account_code)}`}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button onClick={() => toggleRule(r)} title={r.is_active ? 'Pause rule' : 'Activate rule'} className="text-slate-400 hover:text-sky-300 cursor-pointer">
                    <Power className="w-4 h-4" />
                  </button>
                  <button onClick={() => deleteRule(r)} title="Delete rule" className="text-slate-500 hover:text-rose-400 cursor-pointer">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={addRule} className="grid grid-cols-2 sm:grid-cols-7 gap-2 items-end">
          <label className="col-span-2 space-y-1">
            <span className="block text-slate-400">Charge name</span>
            <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="Maintenance charges" className={inputClass} />
          </label>
          <label className="space-y-1">
            <span className="block text-slate-400">Basis</span>
            <select value={draft.calculation_type} onChange={e => setDraft({ ...draft, calculation_type: e.target.value as RuleDraft['calculation_type'] })} className={inputClass}>
              <option value="flat_per_unit">Per flat</option>
              <option value="per_sqft">Per sq.ft</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-slate-400">Rate (₹)</span>
            <input type="number" min={0} step="0.01" value={draft.rate || ''} onChange={e => setDraft({ ...draft, rate: Number(e.target.value) })} className={inputClass} />
          </label>
          <label className="space-y-1">
            <span className="block text-slate-400">GST %</span>
            <select value={draft.tax_rate_percent} onChange={e => setDraft({ ...draft, tax_rate_percent: Number(e.target.value) })} className={inputClass}>
              <option value={0}>0%</option>
              <option value={18}>18%</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-slate-400">Flat type</span>
            <select value={draft.applies_to_unit_type ?? ''} onChange={e => setDraft({ ...draft, applies_to_unit_type: e.target.value })} className={inputClass}>
              <option value="">All flats</option>
              {unitTypes.map(t => <option key={t} value={t}>{t} only</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-slate-400">Credit to</span>
            <select value={draft.account_code} onChange={e => setDraft({ ...draft, account_code: e.target.value as RuleDraft['account_code'] })} className={inputClass}>
              {CREDIT_ACCOUNTS.map(a => <option key={a.code} value={a.code}>{a.label}</option>)}
            </select>
          </label>
          <button type="submit" disabled={savingRule} className="col-span-2 sm:col-span-7 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50">
            {savingRule ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            <span>Add Charge</span>
          </button>
        </form>
        <p className="text-[11px] text-slate-500">
          GST applies only if your society is GST-registered and a member&apos;s monthly contribution exceeds ₹7,500 — confirm with your CA.
        </p>
      </section>

      {/* Generate */}
      <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
        <div className="font-bold text-white text-sm">2. Issue Monthly Bills</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
          <label className="space-y-1">
            <span className="block text-slate-400">Billing month</span>
            <input type="month" value={month} onChange={e => { setMonth(e.target.value); setPreview(null); }} className={inputClass} />
          </label>
          <label className="space-y-1">
            <span className="block text-slate-400">Due on day</span>
            <input type="number" min={1} max={28} value={dueDay} onChange={e => { setDueDay(Number(e.target.value)); setPreview(null); }} className={inputClass} />
          </label>
          <button
            onClick={() => runGenerate(true)}
            disabled={working !== null || activeRules.length === 0}
            className="py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            {working === 'preview' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
            <span>Preview</span>
          </button>
          <button
            onClick={() => runGenerate(false)}
            disabled={working !== null || !preview || preview.bills === 0}
            className="py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            {working === 'generate' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            <span>Issue Bills</span>
          </button>
        </div>
        {activeRules.length === 0 && <p className="text-amber-300">Add at least one active charge above to issue bills.</p>}

        {preview && (
          <div className="space-y-2">
            <div className="text-slate-300">
              <strong className="text-white">{preview.cycle_name}</strong>: {preview.bills} bills totalling{' '}
              <strong className="text-white">{formatINR(preview.total_amount)}</strong>
            </div>
            {preview.skipped_units.length > 0 && (
              <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/20 text-amber-300">
                {preview.skipped_units.length} flats skipped (no bill):{' '}
                {preview.skipped_units.slice(0, 20).map(s => `${s.unit_number} (${s.reason})`).join(', ')}
                {preview.skipped_units.length > 20 && '…'}
                <div className="text-slate-400 mt-1">Invite the owner of each flat in Members to bill them.</div>
              </div>
            )}
            <div className="max-h-56 overflow-y-auto rounded-xl border border-slate-800">
              <table className="w-full text-left">
                <thead className="bg-slate-950 text-slate-400 sticky top-0">
                  <tr><th className="p-2">Flat</th><th className="p-2 text-right">Charges</th><th className="p-2 text-right">GST</th><th className="p-2 text-right">Total</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-800 text-slate-300">
                  {preview.preview.map(p => (
                    <tr key={`${p.wing}-${p.unit_number}`}>
                      <td className="p-2 text-white">{p.unit_number}</td>
                      <td className="p-2 text-right">{formatINR(p.subtotal)}</td>
                      <td className="p-2 text-right">{formatINR(p.tax)}</td>
                      <td className="p-2 text-right font-semibold text-white">{formatINR(p.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Bills */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-bold text-white text-sm">3. Bills</div>
          <div className="flex items-center gap-2">
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as BillStatus | 'all')} className="bg-slate-900 border border-slate-700 rounded-xl px-2 py-1.5 text-white">
              <option value="all">All statuses</option>
              {(['issued', 'partially_paid', 'overdue', 'paid'] as BillStatus[]).map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
            <button
              onClick={applyLateFees}
              disabled={working !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-700 hover:border-rose-500 text-slate-200 cursor-pointer disabled:opacity-50"
              title="Mark bills past due date as overdue and add the late fee from Society Rules"
            >
              {working === 'late' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clock className="w-3.5 h-3.5" />}
              <span>Apply Late Fees</span>
            </button>
          </div>
        </div>

        {filteredBills.length === 0 && !loading ? (
          <EmptyState icon={CreditCard} title="No Bills Yet" description="Add charges and issue this month's bills above." />
        ) : (
          <div className="rounded-2xl bg-slate-900 border border-slate-800 divide-y divide-slate-800">
            {filteredBills.map(b => (
              <div key={b.id} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-white">Flat {unitNumber(b.unit_id)} <span className="font-mono text-slate-500">• {b.bill_number}</span></div>
                  <div className="text-slate-400">Due {b.due_date} • Billed {formatINR(b.total_amount)}{Number(b.interest_or_late_fee) > 0 && ` (incl. late fee ${formatINR(b.interest_or_late_fee)})`}</div>
                </div>
                <div className="text-right shrink-0 space-y-1">
                  <div className="font-bold text-white">{formatINR(b.balance_due)}</div>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold ${STATUS_STYLES[b.status]}`}>{b.status.replace('_', ' ')}</span>
                  {Number(b.amount_paid) === 0 && !b.is_opening_balance && (b.status === 'issued' || b.status === 'overdue') && (
                    <button onClick={() => cancelBill(b)} disabled={working !== null} className="block ml-auto text-[11px] text-rose-400 hover:underline cursor-pointer disabled:opacity-50">
                      Cancel bill
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
