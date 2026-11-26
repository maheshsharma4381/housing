'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase/client';
import { formatINR } from '../../../lib/inr';
import { describeNotify, notify } from '../../../lib/notify';
import { EmptyState } from '../../../components/EmptyState';
import { RuleFlats } from '../../../components/RuleFlats';
import { Bill, BillingRule, BillStatus, GenerateBillsResult, Unit } from '../../../types/database';
import { CreditCard, Plus, Trash2, CheckCircle2, Eye, Send, Clock, Power, Check, Search } from 'lucide-react';
import { Banner } from '../../../components/Banner';
import { PageHeader } from '../../../components/ui/PageHeader';
import { StatCard } from '../../../components/ui/StatCard';
import { Card, CardHeader, CardFooter } from '../../../components/ui/Card';
import { Button, IconButton } from '../../../components/ui/Button';
import { Badge, type BadgeTone } from '../../../components/ui/Badge';
import { Field, fieldClass } from '../../../components/ui/Field';
import { cn } from '../../../components/ui/cn';
import { confirmDialog, promptDialog, toast } from '../../../components/ui/feedback';

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

// A charge credits any active income or fund ledger (trg_billing_rule_account in 021); fund
// contributions go to the fund, not to income. Shown until the society's chart loads.
interface CreditAccount { code: string; label: string }
const DEFAULT_CREDIT_ACCOUNTS: CreditAccount[] = [
  { code: '4000', label: 'Maintenance Charges' },
  { code: '4200', label: 'Other Income' },
  { code: '3000', label: 'Sinking Fund' },
  { code: '3100', label: 'Repair & Maintenance Fund' },
  { code: '3200', label: 'General Reserve' },
];
interface ChartLedgerRow { code: string; name: string; nature: string; is_active: boolean }

const fmtDate = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

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
  const [creditAccounts, setCreditAccounts] = useState<CreditAccount[]>(DEFAULT_CREDIT_ACCOUNTS);
  const creditLabel = (code: string) => creditAccounts.find(a => a.code === code)?.label ?? code;

  const today = new Date();
  const [month, setMonth] = useState(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`);
  const [dueDay, setDueDay] = useState(10);
  const [preview, setPreview] = useState<GenerateBillsResult | null>(null);
  const [working, setWorking] = useState<'preview' | 'generate' | 'late' | null>(null);

  const [statusFilter, setStatusFilter] = useState<BillStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // success goes to a toast; errors stay on the page
  const setNotice = (msg: string | null) => { if (msg) toast.success(msg); };

  const unitNumber = (id: string) => units.find(u => u.id === id)?.unit_number ?? '—';
  const unitTypes = useMemo(() => [...new Set(units.map(u => u.unit_type))].sort(), [units]);

  const loadRules = useCallback(async () => {
    if (!supabase) return;
    const [rRes, sRes, cRes] = await Promise.all([
      // 042: system rules only carry the ledger of one-off charges (shifting); they are not maintenance charges
      supabase.from('billing_rules').select('*').eq('society_id', societyId).eq('is_system', false).order('created_at'),
      supabase.from('society_settings').select('due_day_of_month').eq('society_id', societyId).maybeSingle(),
      supabase.rpc('chart_of_accounts', { p_society_id: societyId }),
    ]);
    setRules((rRes.data ?? []) as BillingRule[]);
    const ledgers = (cRes.data as { ledgers?: ChartLedgerRow[] } | null)?.ledgers ?? [];
    const credit = ledgers.filter(l => l.is_active && (l.nature === 'income' || l.nature === 'equity'))
      .sort((a, b) => (a.nature === b.nature ? a.code.localeCompare(b.code) : a.nature === 'income' ? -1 : 1))
      .map(l => ({ code: l.code, label: l.name }));
    if (credit.length) setCreditAccounts(credit);
    if (sRes.data?.due_day_of_month) setDueDay(sRes.data.due_day_of_month);
  }, [societyId]);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  const showError = (msg: string) => setError(msg);

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
    setShowAdd(false);
    toast.success('Charge added. It is included from the next bills you issue.');
    loadRules();
  };

  const toggleRule = async (rule: BillingRule) => {
    if (!supabase) return;
    const { error: updErr } = await supabase.from('billing_rules').update({ is_active: !rule.is_active }).eq('id', rule.id);
    if (updErr) return showError(updErr.message);
    loadRules();
  };

  const toggleMunicipal = async (rule: BillingRule) => {
    if (!supabase) return;
    const { error: updErr } = await supabase.from('billing_rules').update({ is_municipal_tax: !rule.is_municipal_tax }).eq('id', rule.id);
    if (updErr) showError(updErr.message);
    loadRules();
  };

  const deleteRule = async (rule: BillingRule) => {
    if (!supabase || !(await confirmDialog({ title: `Delete the charge "${rule.name}"?`, body: 'Bills already issued are not affected. Future bills will not include it.', confirmText: 'Delete charge', tone: 'danger' }))) return;
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
    const reason = await promptDialog({
      title: `Cancel bill ${b.bill_number} for flat ${unitNumber(b.unit_id)}?`,
      body: 'The bill is cancelled and its ledger entry is reversed.',
      label: 'Reason', defaultValue: 'Wrong amount', minLength: 3, confirmText: 'Cancel bill', cancelText: 'Keep bill', tone: 'danger',
    });
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

  const activeRules = rules.filter(r => r.is_active);
  const ruleLine = (r: BillingRule) => [
    r.calculation_type === 'per_sqft' ? `${formatINR(r.rate)} per sq.ft carpet` : `${formatINR(r.rate)} per flat`,
    Number(r.tax_rate_percent) > 0 ? `${r.tax_rate_percent}% GST` : 'no GST',
    r.applies_to_unit_type ? `${r.applies_to_unit_type} only` : null,
  ].filter(Boolean).join(' · ');

  const q = search.trim().toLowerCase();
  const shownBills = filteredBills.filter(b => !q || unitNumber(b.unit_id).toLowerCase().includes(q) || b.bill_number.toLowerCase().includes(q));
  const countOf = (st: BillStatus) => bills.filter(b => b.status === st).length;
  const filters: { id: BillStatus | 'all'; label: string; n: number }[] = [
    { id: 'all', label: 'All', n: bills.length },
    { id: 'issued', label: 'Due', n: countOf('issued') },
    { id: 'partially_paid', label: 'Part paid', n: countOf('partially_paid') },
    { id: 'overdue', label: 'Overdue', n: countOf('overdue') },
    { id: 'paid', label: 'Paid', n: countOf('paid') },
  ];
  const canCancel = (b: Bill) => Number(b.amount_paid) === 0 && !b.is_opening_balance && (b.status === 'issued' || b.status === 'overdue');
  const step = preview ? 2 : 1;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Maintenance bills"
        description="Set the charges once, then issue every month's bills in one go."
        actions={
          <Button variant="secondary" onClick={applyLateFees} loading={working === 'late'} leftIcon={<Clock className="w-4 h-4" />}
            title="Mark bills past their due date as overdue and add the late fee from Society settings">
            Apply late fees
          </Button>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <StatCard label="Total billed" value={formatINR(totals.billed)} sub={`${bills.filter(b => b.status !== 'cancelled').length} bills`} />
        <StatCard label="Collected" value={formatINR(totals.collected)} tone="success" />
        <StatCard label="Outstanding" value={formatINR(totals.due)} tone={totals.due > 0 ? 'warning' : 'default'} />
      </div>

      <Banner tone="error">{error}</Banner>

      <div className="grid gap-4 lg:grid-cols-5 items-start">
        {/* Issue bills: month → check → issue (brief J2) */}
        <Card className="lg:col-span-3">
          <div className="px-4 sm:px-5 py-4 border-b border-border space-y-3">
            <h2 className="text-base font-semibold">Issue monthly bills</h2>
            <ol aria-label="Steps" className="flex items-center gap-2 text-[13px]">
              {['Month', 'Check', 'Issue'].map((label, i) => {
                const n = i + 1;
                const done = n < step;
                const current = n === step;
                return (
                  <React.Fragment key={label}>
                    {i > 0 && <li aria-hidden="true" className="w-6 h-px bg-border-strong" />}
                    <li aria-current={current ? 'step' : undefined} className={cn('flex items-center gap-1.5 font-medium', done ? 'text-success' : current ? 'text-brand-ink' : 'text-fg-subtle')}>
                      <span className={cn('w-5 h-5 rounded-full flex items-center justify-center text-xs',
                        done ? 'bg-success-soft' : current ? 'bg-brand text-on-brand' : 'bg-surface-muted')}>
                        {done ? <Check className="w-3 h-3" /> : n}
                      </span>
                      {label}
                    </li>
                  </React.Fragment>
                );
              })}
            </ol>
          </div>
          <div className="p-4 sm:p-5 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Billing month">
                <input type="month" value={month} onChange={e => { setMonth(e.target.value); setPreview(null); }} className={fieldClass} />
              </Field>
              <Field label="Due on day" hint="Of the same month, 1 to 28">
                <input type="number" inputMode="numeric" min={1} max={28} value={dueDay} onChange={e => { setDueDay(Number(e.target.value)); setPreview(null); }} className={fieldClass} />
              </Field>
            </div>

            {activeRules.length === 0 && (
              <div className="p-3 rounded-lg bg-warning-soft text-warning text-[13px]">Add at least one active charge to issue bills.</div>
            )}

            {preview && (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-3 p-4 rounded-xl bg-canvas border border-border">
                  <div><div className="text-xs text-fg-muted">Bills</div><div className="text-xl font-semibold tabular-nums">{preview.bills}</div></div>
                  <div><div className="text-xs text-fg-muted">Period</div><div className="text-sm font-semibold mt-1">{preview.cycle_name}</div></div>
                  <div><div className="text-xs text-fg-muted">Total</div><div className="text-xl font-semibold tabular-nums">{formatINR(preview.total_amount)}</div></div>
                </div>
                {preview.skipped_units.length > 0 ? (
                  <div className="p-3 rounded-lg bg-warning-soft text-warning text-[13px] space-y-1">
                    <div className="font-semibold">{preview.skipped_units.length} flats get no bill</div>
                    <div>
                      {preview.skipped_units.slice(0, 20).map(s => `${s.unit_number} (${s.reason})`).join(', ')}
                      {preview.skipped_units.length > 20 && '…'}
                    </div>
                    <div className="text-fg-muted">Invite the owner of each flat in Flats &amp; residents to bill them.</div>
                  </div>
                ) : (
                  <p className="flex items-center gap-2 text-[13px] text-success"><CheckCircle2 className="w-4 h-4" aria-hidden="true" /> Every flat gets a bill. No flat is left out.</p>
                )}
                <details className="rounded-lg border border-border">
                  <summary className="px-3 py-2 text-[13px] font-medium text-fg-muted cursor-pointer">See flat-wise amounts</summary>
                  <div className="max-h-56 overflow-y-auto border-t border-border">
                    <table className="w-full text-left text-[13px]">
                      <thead className="bg-surface-muted text-fg-muted sticky top-0">
                        <tr><th className="px-3 py-2 font-medium">Flat</th><th className="px-3 py-2 font-medium text-right">Charges</th><th className="px-3 py-2 font-medium text-right">GST</th><th className="px-3 py-2 font-medium text-right">Total</th></tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {preview.preview.map(p => (
                          <tr key={`${p.wing}-${p.unit_number}`}>
                            <td className="px-3 py-2 font-medium">{p.unit_number}</td>
                            <td className="px-3 py-2 text-right">{formatINR(p.subtotal)}</td>
                            <td className="px-3 py-2 text-right">{formatINR(p.tax)}</td>
                            <td className="px-3 py-2 text-right font-semibold">{formatINR(p.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
                <p className="text-[13px] text-fg-muted">Residents see the bills at once and get a notification.</p>
              </div>
            )}
          </div>
          <CardFooter>
            {preview ? (
              <>
                <Button variant="secondary" onClick={() => setPreview(null)}>Change month</Button>
                <Button onClick={() => runGenerate(false)} loading={working === 'generate'} disabled={working !== null || preview.bills === 0} leftIcon={<Send className="w-4 h-4" />}>
                  Issue {preview.bills} bills
                </Button>
              </>
            ) : (
              <Button onClick={() => runGenerate(true)} loading={working === 'preview'} disabled={working !== null || activeRules.length === 0} leftIcon={<Eye className="w-4 h-4" />}>
                Check the bills
              </Button>
            )}
          </CardFooter>
        </Card>

        {/* Charges (billing rules) */}
        <Card className="lg:col-span-2">
          <CardHeader title="Charges" description="What every flat pays each month"
            actions={<Button variant="secondary" size="sm" onClick={() => setShowAdd(v => !v)} leftIcon={showAdd ? undefined : <Plus className="w-4 h-4" />}>{showAdd ? 'Close' : 'Add charge'}</Button>} />
          {rules.length === 0 && !showAdd && (
            <p className="px-5 py-6 text-fg-muted">No charges yet. Add the monthly maintenance charge to start billing.</p>
          )}
          <ul className="divide-y divide-border">
            {rules.map(r => (
              <li key={r.id} className={cn('px-4 sm:px-5 py-4 space-y-2', !r.is_active && 'opacity-60')}>
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-fg">{r.name}</div>
                    <div className="text-[13px] text-fg-muted">{ruleLine(r)}</div>
                    <div className="text-xs text-fg-subtle">Goes to: {creditLabel(r.account_code)}</div>
                  </div>
                  <Badge tone={r.is_active ? 'success' : 'neutral'}>{r.is_active ? 'Active' : 'Paused'}</Badge>
                  <IconButton variant="ghost" size="sm" label={r.is_active ? `Pause ${r.name}` : `Activate ${r.name}`} onClick={() => toggleRule(r)} className="w-8 h-8">
                    <Power className="w-4 h-4" />
                  </IconButton>
                  <IconButton variant="ghost" size="sm" label={`Delete ${r.name}`} onClick={() => deleteRule(r)} className="w-8 h-8 text-danger hover:text-danger">
                    <Trash2 className="w-4 h-4" />
                  </IconButton>
                </div>
                <RuleFlats ruleId={r.id} selected={!!r.applies_to_selected} units={units} canManage onChanged={loadRules} />
                {/* 041: municipal taxes are left out of non-occupancy charges */}
                <label className="flex items-center gap-2 text-[13px] text-fg-muted cursor-pointer">
                  <input type="checkbox" checked={!!r.is_municipal_tax} onChange={() => toggleMunicipal(r)} className="w-4 h-4 accent-brand" />
                  Municipal tax (no non-occupancy charge on this)
                </label>
              </li>
            ))}
          </ul>

          {showAdd && (
            <form onSubmit={addRule} className="px-4 sm:px-5 py-4 border-t border-border space-y-3">
              <Field label="Charge name">
                <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="Maintenance charges" className={fieldClass} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Basis">
                  <select value={draft.calculation_type} onChange={e => setDraft({ ...draft, calculation_type: e.target.value as RuleDraft['calculation_type'] })} className={fieldClass}>
                    <option value="flat_per_unit">Per flat</option>
                    <option value="per_sqft">Per sq.ft</option>
                  </select>
                </Field>
                <Field label="Rate (₹)">
                  <input type="number" inputMode="decimal" min={0} step="0.01" value={draft.rate || ''} onChange={e => setDraft({ ...draft, rate: Number(e.target.value) })} className={cn(fieldClass, 'text-right tabular-nums')} />
                </Field>
              </div>
              <details className="group" open={draft.tax_rate_percent > 0 || !!draft.applies_to_unit_type || draft.account_code !== '4000'}>
                <summary className="text-[13px] font-medium text-brand cursor-pointer">More options: GST, flat type, ledger</summary>
                <div className="grid grid-cols-2 gap-3 pt-3">
                  <Field label="GST %">
                    <select value={draft.tax_rate_percent} onChange={e => setDraft({ ...draft, tax_rate_percent: Number(e.target.value) })} className={fieldClass}>
                      <option value={0}>0%</option>
                      <option value={18}>18%</option>
                    </select>
                  </Field>
                  <Field label="Flat type">
                    <select value={draft.applies_to_unit_type ?? ''} onChange={e => setDraft({ ...draft, applies_to_unit_type: e.target.value })} className={fieldClass}>
                      <option value="">All flats</option>
                      {unitTypes.map(t => <option key={t} value={t}>{t} only</option>)}
                    </select>
                  </Field>
                  <Field label="Credit to" className="col-span-2">
                    <select value={draft.account_code} onChange={e => setDraft({ ...draft, account_code: e.target.value })} className={fieldClass}>
                      {creditAccounts.map(a => <option key={a.code} value={a.code}>{a.label}</option>)}
                    </select>
                  </Field>
                  <p className="col-span-2 text-xs text-fg-subtle">
                    GST applies only if your society is GST-registered and a member&apos;s monthly contribution exceeds ₹7,500. Confirm with your CA.
                  </p>
                </div>
              </details>
              <Button type="submit" loading={savingRule} className="w-full" leftIcon={<Plus className="w-4 h-4" />}>Add charge</Button>
            </form>
          )}
        </Card>
      </div>

      {/* Bills */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5 py-4 border-b border-border">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-base font-semibold">Bills</h2>
            <div role="tablist" aria-label="Filter bills by status" className="flex flex-wrap gap-1 p-1 rounded-lg bg-surface-muted">
              {filters.map(f => (
                <button key={f.id} role="tab" aria-selected={statusFilter === f.id} onClick={() => setStatusFilter(f.id)}
                  className={cn('h-8 px-2.5 rounded-md text-[13px] font-medium cursor-pointer transition duration-150',
                    statusFilter === f.id ? 'bg-surface text-fg shadow-card' : 'text-fg-muted hover:text-fg')}>
                  {f.label} <span className="tabular-nums text-fg-subtle">{f.n}</span>
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 h-9 w-full sm:w-56 px-3 rounded-lg border border-border-strong text-fg-subtle focus-within:border-brand">
            <Search className="w-4 h-4" aria-hidden="true" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search flat or bill no." aria-label="Search bills"
              className="flex-1 min-w-0 bg-transparent outline-none text-base sm:text-sm text-fg" />
          </label>
        </div>

        {shownBills.length === 0 && !loading ? (
          <EmptyState bare icon={CreditCard}
            title={bills.length === 0 ? 'No bills yet' : 'No bills match'}
            description={bills.length === 0 ? "Add a charge, then issue this month's bills above." : 'Try another status or flat number.'} />
        ) : (
          <>
            {/* phones: one card per bill */}
            <ul className="md:hidden divide-y divide-border">
              {shownBills.map(b => (
                <li key={b.id} className="px-4 py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold">{unitNumber(b.unit_id)}</div>
                    <a href={`/bill/${b.id}`} className="text-[13px] text-brand">{b.bill_number}</a>
                    <div className="text-[13px] text-fg-muted">Due {fmtDate(b.due_date)}</div>
                  </div>
                  <div className="text-right space-y-1">
                    <div className="font-semibold tabular-nums">{formatINR(b.balance_due)}</div>
                    <BillBadge status={b.status} />
                    {canCancel(b) && <button onClick={() => cancelBill(b)} disabled={working !== null} className="block ml-auto text-[13px] text-danger cursor-pointer disabled:opacity-50">Cancel bill</button>}
                  </div>
                </li>
              ))}
            </ul>
            {/* laptop: a table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-surface-muted text-fg-muted text-xs">
                  <tr>
                    <th scope="col" className="px-5 py-2.5 font-medium">Flat</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Bill no.</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Due</th>
                    <th scope="col" className="px-3 py-2.5 font-medium text-right">Billed</th>
                    <th scope="col" className="px-3 py-2.5 font-medium text-right">Balance</th>
                    <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                    <th scope="col" className="px-5 py-2.5"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {shownBills.map(b => (
                    <tr key={b.id} className="hover:bg-canvas">
                      <td className="px-5 py-3 font-semibold">{unitNumber(b.unit_id)}</td>
                      <td className="px-3 py-3"><a href={`/bill/${b.id}`} className="text-brand hover:underline">{b.bill_number}</a></td>
                      <td className="px-3 py-3 text-fg-muted whitespace-nowrap">{fmtDate(b.due_date)}</td>
                      <td className="px-3 py-3 text-right text-fg-muted">
                        {formatINR(b.total_amount)}
                        {Number(b.interest_or_late_fee) > 0 && <div className="text-xs text-fg-subtle">incl. late fee {formatINR(b.interest_or_late_fee)}</div>}
                      </td>
                      <td className="px-3 py-3 text-right font-semibold">{formatINR(b.balance_due)}</td>
                      <td className="px-3 py-3"><BillBadge status={b.status} /></td>
                      <td className="px-5 py-3 text-right">
                        {canCancel(b) && <Button variant="ghost" size="sm" className="text-danger hover:text-danger" onClick={() => cancelBill(b)} disabled={working !== null}>Cancel bill</Button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border bg-surface-muted">
                    <td colSpan={4} className="px-5 py-3 text-[13px] text-fg-muted">{shownBills.length} of {bills.length} bills</td>
                    <td className="px-3 py-3 text-right font-semibold">{formatINR(shownBills.filter(b => b.status !== 'cancelled').reduce((t, b) => t + Number(b.balance_due), 0))}</td>
                    <td colSpan={2} className="px-5 py-3 text-[13px] text-fg-muted">balance shown</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
};

const BILL_BADGE: Record<BillStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  issued: { label: 'Due', tone: 'warning' },
  partially_paid: { label: 'Part paid', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
  overdue: { label: 'Overdue', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};
const BillBadge: React.FC<{ status: BillStatus }> = ({ status }) => <Badge tone={BILL_BADGE[status].tone} dot>{BILL_BADGE[status].label}</Badge>;
