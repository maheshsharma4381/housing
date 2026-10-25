'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { FEATURES } from '../lib/billing';
import { Banner } from './Banner';
import { InvoiceView } from './InvoiceView';
import { PlatformInvoice, SubscriptionPlan } from '../types/database';
import { KeyRound, Loader2, Play, Printer, Save, X } from 'lucide-react';

interface Row {
  society_id: string; name: string; city: string; units: number; plan_code: string; status: string; in_trial: boolean;
  trial_ends_on: string | null; term: string; period_end: string | null; next_plan_code: string | null;
  monthly_value: number; open_invoice_total: number | null; open_invoice_due: string | null; has_override: boolean;
}
interface Override { custom_rate: string; discount_percent: string; free_months: string; excluded_units: string; valid_till: string; reason: string }
type Settings = Record<string, string | number>;

const today = () => new Date().toISOString().slice(0, 10);
const SETTING_FIELDS: { key: string; label: string; numeric?: boolean }[] = [
  { key: 'annual_months', label: 'Yearly plan charges (months)', numeric: true },
  { key: 'min_billable_flats', label: 'Minimum billable flats', numeric: true },
  { key: 'trial_days', label: 'Free trial (days)', numeric: true },
  { key: 'due_days', label: 'Invoice due after (days)', numeric: true },
  { key: 'renew_days_before', label: 'Renewal invoice before period end (days)', numeric: true },
  { key: 'downgrade_days', label: 'Move to Free after invoice (days)', numeric: true },
  { key: 'gst_rate', label: 'GST %', numeric: true },
  { key: 'sac', label: 'SAC code (confirm with CA)' },
  { key: 'seller_name', label: 'Legal name on invoice' },
  { key: 'seller_gstin', label: 'Sahvaas GSTIN' },
  { key: 'seller_state', label: 'State (for CGST/SGST vs IGST)' },
  { key: 'seller_address', label: 'Address on invoice' },
  { key: 'bank_name', label: 'Bank name (for NEFT)' },
  { key: 'bank_account', label: 'Account number' },
  { key: 'bank_ifsc', label: 'IFSC' },
  { key: 'bank_upi', label: 'UPI ID' },
];

/** Platform owner: prices, plan features, billing rules, per-society overrides, invoices and revenue. */
export const BillingConsole: React.FC = () => {
  const [rows, setRows] = useState<Row[]>([]);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [settings, setSettings] = useState<Settings>({});
  const [invoices, setInvoices] = useState<PlatformInvoice[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [override, setOverride] = useState<Override | null>(null);
  const [paidRef, setPaidRef] = useState<Record<string, string>>({});
  const [viewing, setViewing] = useState<PlatformInvoice | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [oRes, pRes, sRes, iRes] = await Promise.all([
      supabase.rpc('platform_billing_overview'),
      supabase.from('subscription_plans').select('*').order('sort_order'),
      supabase.from('platform_settings').select('value').eq('key', 'billing').maybeSingle(),
      supabase.from('platform_invoices').select('*').order('issued_on', { ascending: false }).limit(300),
    ]);
    if (oRes.error) setError(oRes.error.message);
    setRows((oRes.data ?? []) as Row[]);
    setPlans(((pRes.data ?? []) as SubscriptionPlan[]).filter(p => ['free', 'basic', 'pro'].includes(p.tier_code)));
    setSettings((sRes.data?.value ?? {}) as Settings);
    setInvoices((iRes.data ?? []) as PlatformInvoice[]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const done = (msg: string) => {
    setError(null);
    setNotice(msg);
    load();
  };
  const run = async (key: string, fn: () => PromiseLike<{ error: { message: string } | null }>, msg: string) => {
    setBusy(key);
    const { error: err } = await fn();
    setBusy(null);
    if (err) return setError(err.message);
    done(msg);
  };

  const editPlan = (id: string, patch: Partial<SubscriptionPlan>) => setPlans(ps => ps.map(p => (p.id === id ? { ...p, ...patch } : p)));
  const savePlans = () => run('plans', async () => {
    for (const p of plans) {
      const { error: err } = await supabase!.from('subscription_plans').update({
        monthly_rate_per_unit_inr: p.monthly_rate_per_unit_inr, feature_keys: p.feature_keys, show_ads: p.show_ads,
        storage_mb: p.storage_mb, description: p.description, is_active: p.is_active,
      }).eq('id', p.id);
      if (err) return { error: err };
    }
    return { error: null };
  }, 'Plans saved. New quotes and invoices use them; issued invoices do not change.');

  const saveSettings = () => run('settings', () => supabase!.from('platform_settings').update({ value: settings }).eq('key', 'billing'), 'Billing settings saved.');

  const generateSecret = () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    setSecret(Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''));
  };

  const startOverride = async (r: Row) => {
    if (open === r.society_id) return setOpen(null);
    setOpen(r.society_id);
    const { data } = await supabase!.from('society_pricing_overrides').select('*').eq('society_id', r.society_id).maybeSingle();
    setOverride({
      custom_rate: data?.custom_rate?.toString() ?? '', discount_percent: data?.discount_percent?.toString() ?? '0',
      free_months: data?.free_months?.toString() ?? '0', excluded_units: data?.excluded_units?.toString() ?? '0',
      valid_till: data?.valid_till ?? '', reason: data?.reason ?? '',
    });
  };

  const saveOverride = (sid: string) => override && run(`ovr-${sid}`, () => supabase!.rpc('platform_set_pricing_override', {
    p_society_id: sid, p_custom_rate: override.custom_rate === '' ? null : Number(override.custom_rate),
    p_discount_percent: Number(override.discount_percent || 0), p_free_months: Number(override.free_months || 0),
    p_excluded_units: Number(override.excluded_units || 0), p_valid_till: override.valid_till || null, p_reason: override.reason,
  }), 'Price override saved — it applies to the next quote / invoice.');

  const removeOverride = (sid: string) => run(`ovr-${sid}`, () => supabase!.from('society_pricing_overrides').delete().eq('society_id', sid), 'Override removed.');

  const mrr = rows.reduce((s, r) => s + Number(r.monthly_value || 0), 0);
  const overdue = invoices.filter(i => i.status === 'issued' && i.due_on < today());
  const kpis: [string, string, string?][] = [
    ['MRR (booked)', formatINR(mrr)],
    ['ARR', formatINR(mrr * 12)],
    ['Paying societies', String(rows.filter(r => Number(r.monthly_value) > 0).length), `${rows.filter(r => Number(r.monthly_value) > 0).reduce((s, r) => s + r.units, 0)} flats`],
    ['On trial', String(rows.filter(r => r.in_trial && r.status === 'trial').length)],
    ['On Free (ads)', String(rows.filter(r => r.plan_code === 'free' && !r.in_trial).length)],
    ['Overdue invoices', String(overdue.length), formatINR(overdue.reduce((s, i) => s + Number(i.total), 0))],
  ];
  const cell = 'bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-white outline-none focus:border-purple-500';

  return (
    <div className="space-y-6 text-xs">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">Billing</h2>
          <p className="text-slate-400">Per-flat SaaS pricing. The daily job (01:00 IST) ends trials, sends renewal invoices and moves unpaid societies to Free.</p>
        </div>
        <button onClick={() => run('lifecycle', () => supabase!.rpc('run_subscription_lifecycle'), 'Lifecycle job ran.')} disabled={busy !== null}
          className="flex items-center gap-1 px-3 py-2 rounded-xl bg-slate-800 text-slate-200 cursor-pointer disabled:opacity-50">
          {busy === 'lifecycle' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Run daily job now
        </button>
      </div>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {kpis.map(([label, value, sub]) => (
          <div key={label} className="p-3 rounded-2xl bg-slate-950 border border-slate-800">
            <div className="text-slate-400">{label}</div><div className="text-lg font-bold text-white">{value}</div>{sub && <div className="text-slate-500">{sub}</div>}
          </div>
        ))}
      </div>

      <section className="bg-slate-950 border border-slate-800 rounded-2xl overflow-x-auto">
        <div className="p-3 font-bold text-white border-b border-slate-800">Societies</div>
        <table className="w-full min-w-[860px] text-left">
          <thead className="text-slate-400"><tr><th className="p-2">Society</th><th className="p-2">Flats</th><th className="p-2">Plan</th><th className="p-2">Status</th><th className="p-2">Until</th><th className="p-2 text-right">₹ / month</th><th className="p-2 text-right">Open invoice</th><th className="p-2" /></tr></thead>
          <tbody className="divide-y divide-slate-800 text-slate-200">
            {rows.map(r => (
              <React.Fragment key={r.society_id}>
                <tr>
                  <td className="p-2"><div className="font-semibold text-white">{r.name}</div><div className="text-slate-500">{r.city}{r.has_override && ' · custom price'}</div></td>
                  <td className="p-2">{r.units}</td>
                  <td className="p-2">{r.in_trial && r.status === 'trial' ? 'Trial' : r.plan_code}{r.next_plan_code && <span className="text-slate-500"> → {r.next_plan_code}</span>}</td>
                  <td className="p-2"><span className={r.status === 'past_due' ? 'text-rose-300' : r.plan_code === 'free' ? 'text-amber-300' : 'text-emerald-300'}>{r.status}</span></td>
                  <td className="p-2 text-slate-400">{r.in_trial ? `trial till ${r.trial_ends_on}` : r.period_end ?? '—'}</td>
                  <td className="p-2 text-right">{Number(r.monthly_value) ? formatINR(r.monthly_value) : '—'}</td>
                  <td className="p-2 text-right">{r.open_invoice_total ? <span className={r.open_invoice_due && r.open_invoice_due < today() ? 'text-rose-300' : ''}>{formatINR(r.open_invoice_total)} · due {r.open_invoice_due}</span> : '—'}</td>
                  <td className="p-2 text-right"><button onClick={() => startOverride(r)} className="text-purple-300 hover:underline cursor-pointer">{open === r.society_id ? 'Close' : 'Price & invoices'}</button></td>
                </tr>
                {open === r.society_id && override && (
                  <tr className="bg-slate-900/60">
                    <td colSpan={8} className="p-3 space-y-3">
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="space-y-1"><span className="block text-slate-400">₹ / flat (blank = plan price)</span><input value={override.custom_rate} onChange={e => setOverride({ ...override, custom_rate: e.target.value })} className={`w-28 ${cell}`} /></label>
                        <label className="space-y-1"><span className="block text-slate-400">Discount %</span><input value={override.discount_percent} onChange={e => setOverride({ ...override, discount_percent: e.target.value })} className={`w-20 ${cell}`} /></label>
                        <label className="space-y-1"><span className="block text-slate-400">Free months (first plan)</span><input value={override.free_months} onChange={e => setOverride({ ...override, free_months: e.target.value })} className={`w-20 ${cell}`} /></label>
                        <label className="space-y-1"><span className="block text-slate-400">Flats not billable</span><input value={override.excluded_units} onChange={e => setOverride({ ...override, excluded_units: e.target.value })} className={`w-20 ${cell}`} /></label>
                        <label className="space-y-1"><span className="block text-slate-400">Valid till</span><input type="date" value={override.valid_till} onChange={e => setOverride({ ...override, valid_till: e.target.value })} className={cell} /></label>
                        <label className="space-y-1 flex-1 min-w-[200px]"><span className="block text-slate-400">Reason (internal)</span><input value={override.reason} onChange={e => setOverride({ ...override, reason: e.target.value })} className={`w-full ${cell}`} /></label>
                        <button onClick={() => saveOverride(r.society_id)} disabled={busy !== null || override.reason.trim().length < 3} className="px-3 py-1.5 rounded-lg bg-purple-600 text-white cursor-pointer disabled:opacity-50">Save price</button>
                        {r.has_override && <button onClick={() => removeOverride(r.society_id)} className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 cursor-pointer">Remove</button>}
                      </div>
                      <div className="space-y-1">
                        {invoices.filter(i => i.society_id === r.society_id).map(i => (
                          <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 p-2 rounded-lg bg-slate-950">
                            <button onClick={() => setViewing(i)} className="text-left cursor-pointer"><span className="font-mono text-white">{i.invoice_number}</span> <span className="text-slate-400">· {i.kind} · {i.plan_code} · {formatINR(i.total)} · {i.status}{i.paid_on ? ` ${i.paid_on} (${i.payment_method})` : ` · due ${i.due_on}`}</span></button>
                            {i.status === 'issued' && (
                              <span className="flex gap-1">
                                <input value={paidRef[i.id] ?? ''} onChange={e => setPaidRef({ ...paidRef, [i.id]: e.target.value })} placeholder="Bank UTR" className={`w-36 ${cell}`} />
                                <button onClick={() => run(i.id, () => supabase!.rpc('platform_mark_invoice_paid', { p_invoice_id: i.id, p_reference: paidRef[i.id] ?? '', p_paid_on: today() }), `${i.invoice_number} marked paid.`)}
                                  disabled={busy !== null || !(paidRef[i.id] ?? '').trim()} className="px-3 py-1 rounded-lg bg-emerald-600 text-white cursor-pointer disabled:opacity-50">Mark NEFT paid</button>
                              </span>
                            )}
                          </div>
                        ))}
                        {invoices.every(i => i.society_id !== r.society_id) && <div className="text-slate-500">No invoices yet.</div>}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </section>

      <section className="bg-slate-950 border border-slate-800 rounded-2xl overflow-x-auto">
        <div className="p-3 font-bold text-white border-b border-slate-800">Plans & features</div>
        <table className="w-full min-w-[760px] text-left">
          <thead className="text-slate-400"><tr><th className="p-2">Plan</th><th className="p-2">₹ / flat / month</th>{FEATURES.map(f => <th key={f.key} className="p-2">{f.label}</th>)}<th className="p-2">Ads</th><th className="p-2">Storage MB</th><th className="p-2">On</th></tr></thead>
          <tbody className="divide-y divide-slate-800 text-slate-200">
            {plans.map(p => (
              <tr key={p.id}>
                <td className="p-2 font-bold text-white">{p.name}</td>
                <td className="p-2"><input type="number" min={0} step="0.5" value={p.monthly_rate_per_unit_inr} disabled={p.tier_code === 'free'} onChange={e => editPlan(p.id, { monthly_rate_per_unit_inr: Number(e.target.value) })} className={`w-20 ${cell}`} /></td>
                {FEATURES.map(f => (
                  <td key={f.key} className="p-2 text-center"><input type="checkbox" className="accent-purple-500" checked={p.feature_keys.includes(f.key)}
                    onChange={e => editPlan(p.id, { feature_keys: e.target.checked ? [...p.feature_keys, f.key] : p.feature_keys.filter(k => k !== f.key) })} /></td>
                ))}
                <td className="p-2 text-center"><input type="checkbox" className="accent-purple-500" checked={p.show_ads} onChange={e => editPlan(p.id, { show_ads: e.target.checked })} /></td>
                <td className="p-2"><input type="number" min={0} value={p.storage_mb} onChange={e => editPlan(p.id, { storage_mb: Number(e.target.value) })} className={`w-20 ${cell}`} /></td>
                <td className="p-2 text-center"><input type="checkbox" className="accent-purple-500" checked={p.is_active} onChange={e => editPlan(p.id, { is_active: e.target.checked })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="p-3 border-t border-slate-800 flex justify-end">
          <button onClick={savePlans} disabled={busy !== null} className="flex items-center gap-1 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold cursor-pointer disabled:opacity-50"><Save className="w-3.5 h-3.5" /> Save plans</button>
        </div>
      </section>

      <section className="bg-slate-950 border border-slate-800 rounded-2xl p-3 space-y-3">
        <div className="font-bold text-white">Billing rules & invoice details</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {SETTING_FIELDS.map(f => (
            <label key={f.key} className="space-y-1"><span className="block text-slate-400">{f.label}</span>
              <input type={f.numeric ? 'number' : 'text'} value={settings[f.key] ?? ''} className={`w-full ${cell}`}
                onChange={e => setSettings({ ...settings, [f.key]: f.numeric ? Number(e.target.value) : e.target.value })} /></label>
          ))}
        </div>
        <div className="flex justify-end">
          <button onClick={saveSettings} disabled={busy !== null} className="flex items-center gap-1 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold cursor-pointer disabled:opacity-50"><Save className="w-3.5 h-3.5" /> Save settings</button>
        </div>
      </section>

      <section className="bg-slate-950 border border-slate-800 rounded-2xl p-3 space-y-2">
        <div className="font-bold text-white flex items-center gap-2"><KeyRound className="w-4 h-4 text-purple-300" /> Online payments (Razorpay)</div>
        <p className="text-slate-400">Vercel needs <span className="font-mono">RAZORPAY_KEY_ID</span>, <span className="font-mono">RAZORPAY_KEY_SECRET</span>, <span className="font-mono">RAZORPAY_WEBHOOK_SECRET</span> and <span className="font-mono">SAHVAAS_GATEWAY_SECRET</span>. Save the same gateway secret here — only its hash is stored. Webhook URL: <span className="font-mono">/api/billing/webhook</span> (events payment.captured, order.paid).</p>
        <div className="flex flex-wrap gap-2">
          <input value={secret} onChange={e => setSecret(e.target.value)} placeholder="Gateway secret (32+ characters)" className={`flex-1 min-w-[260px] font-mono ${cell}`} />
          <button onClick={generateSecret} className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 cursor-pointer">Generate</button>
          <button onClick={() => run('secret', () => supabase!.rpc('platform_set_gateway_secret', { p_secret: secret }), 'Gateway secret saved. Put the same value in Vercel as SAHVAAS_GATEWAY_SECRET.')}
            disabled={busy !== null || secret.length < 32} className="px-3 py-1.5 rounded-lg bg-purple-600 text-white cursor-pointer disabled:opacity-50">Save secret</button>
        </div>
      </section>

      {viewing && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 flex items-start justify-center p-4 overflow-y-auto print:static print:bg-white print:p-0" role="dialog" aria-label="Invoice">
          <div className="w-full max-w-2xl space-y-2">
            <div className="flex justify-end gap-2 print:hidden">
              <button onClick={() => window.print()} className="flex items-center gap-1 px-3 py-2 rounded-xl bg-slate-800 text-slate-200 cursor-pointer"><Printer className="w-3.5 h-3.5" /> Print / PDF</button>
              <button onClick={() => setViewing(null)} className="p-2 rounded-xl bg-slate-800 text-slate-200 cursor-pointer" aria-label="Close"><X className="w-4 h-4" /></button>
            </div>
            <InvoiceView invoice={viewing} />
          </div>
        </div>
      )}
    </div>
  );
};
