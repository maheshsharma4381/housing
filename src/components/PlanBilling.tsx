'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { daysUntil, payInvoiceOnline } from '../lib/billing';
import { Banner } from './Banner';
import { InvoiceView } from './InvoiceView';
import { PlanQuote, PlatformInvoice, SocietyPlan, SubscriptionPlan } from '../types/database';
import { CreditCard, Loader2, Printer, Sparkles, X } from 'lucide-react';

interface BankDetails { bank_name?: string; bank_account?: string; bank_ifsc?: string; bank_upi?: string; seller_name?: string }

const d = (iso: string | null | undefined) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

/** Committee screen: trial / plan status, choose a plan, pay Sahvaas invoices. */
export const PlanBilling: React.FC<{ societyId: string; canManage: boolean; onPlanChanged?: () => void }> = ({ societyId, canManage, onPlanChanged }) => {
  const [plan, setPlan] = useState<SocietyPlan | null>(null);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [quotes, setQuotes] = useState<Record<string, PlanQuote>>({});
  const [term, setTerm] = useState<'annual' | 'monthly'>('annual');
  const [invoices, setInvoices] = useState<PlatformInvoice[]>([]);
  const [bank, setBank] = useState<BankDetails>({});
  const [viewing, setViewing] = useState<PlatformInvoice | null>(null);
  const [showBank, setShowBank] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [pRes, plRes, iRes, sRes] = await Promise.all([
      supabase.rpc('society_plan', { p_society_id: societyId }),
      supabase.from('subscription_plans').select('*').eq('is_active', true).order('sort_order'),
      supabase.from('platform_invoices').select('*').eq('society_id', societyId).order('issued_on', { ascending: false }).limit(50),
      supabase.from('platform_settings').select('value').eq('key', 'billing').maybeSingle(),
    ]);
    if (pRes.error) setError(pRes.error.message);
    setPlan(pRes.data as SocietyPlan | null);
    setPlans((plRes.data ?? []) as SubscriptionPlan[]);
    setInvoices((iRes.data ?? []) as PlatformInvoice[]);
    setBank((sRes.data?.value ?? {}) as BankDetails);
  }, [societyId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!supabase || plans.length === 0) return;
    const client = supabase;
    Promise.all(plans.map(p => client.rpc('subscription_quote', { p_society_id: societyId, p_plan_code: p.tier_code, p_term: term })))
      .then(results => setQuotes(Object.fromEntries(results.map((r, i) => [plans[i].tier_code, r.data as PlanQuote]))));
  }, [plans, term, societyId]);

  const refresh = (msg: string) => {
    setError(null);
    setNotice(msg);
    load();
    onPlanChanged?.();
  };

  const choose = async (code: string) => {
    if (!supabase) return;
    if (code === 'free' && !window.confirm('Switch to the Free plan? Residents will see a few local offers and the CA portal / asset register will be locked. No data is deleted.')) return;
    setBusy(code);
    const { data, error: rpcErr } = await supabase.rpc('choose_plan', { p_society_id: societyId, p_plan_code: code, p_term: term });
    setBusy(null);
    if (rpcErr) return setError(rpcErr.message);
    const r = data as { scheduled: boolean; effective_on?: string; invoice_number?: string; total?: number };
    refresh(r.scheduled ? `You will move to ${code} on ${d(r.effective_on)}, when the current period ends.`
      : r.invoice_number ? `Invoice ${r.invoice_number} for ${formatINR(r.total)} is ready — pay it below.` : 'You are on the Free plan.');
  };

  const pay = async (inv: PlatformInvoice) => {
    setBusy(inv.id);
    setError(null);
    try {
      const r = await payInvoiceOnline(inv.id);
      if (r.kind === 'not_configured') setShowBank(true);
      else if (r.kind === 'paid') refresh(`Thank you — ${inv.invoice_number} is paid. A draft bill was added to your books for approval.`);
      else if (r.kind === 'pending') refresh(r.message);
      else if (r.kind === 'error') setError(r.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const open = invoices.find(i => i.status === 'issued');
  const trialLeft = daysUntil(plan?.trial_ends_on);
  const currentPaid = plan && !plan.in_trial ? plan.paid_plan_code : null;

  return (
    <div className="space-y-5 text-xs">
      <div>
        <h2 className="text-lg font-bold text-white flex items-center gap-2"><CreditCard className="w-4 h-4 text-sky-400" /> Sahvaas plan & billing</h2>
        <p className="text-slate-400">Priced per flat per month. Yearly billing charges 10 months for 12. Nothing is charged automatically.</p>
      </div>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      {plan && (
        <section className={`p-4 rounded-2xl border ${plan.status === 'past_due' ? 'bg-rose-500/10 border-rose-500/40' : plan.in_trial ? 'bg-sky-950 border-sky-800' : 'bg-slate-900 border-slate-800'}`}>
          {plan.in_trial && plan.plan_code === 'trial' && (
            <><div className="text-sky-300 font-bold uppercase tracking-wider text-[10px]">Free trial · all features</div>
              <div className="text-xl font-extrabold text-white">{trialLeft} day{trialLeft === 1 ? '' : 's'} left</div>
              <div className="text-sky-200">Ends {d(plan.trial_ends_on)}. Pick a plan any time — the paid period starts after the trial.</div></>
          )}
          {plan.in_trial && plan.plan_code !== 'trial' && (
            <><div className="text-xl font-extrabold text-white">{plan.plan_name}{plan.period_start ? ` from ${d(plan.period_start)}` : ''}</div>
              <div className="text-sky-200">Your trial (all features) continues until {d(plan.trial_ends_on)}.</div></>
          )}
          {!plan.in_trial && (
            <><div className="text-xl font-extrabold text-white">{plan.plan_name}</div>
              <div className="text-slate-300">
                {plan.paid_plan_code === 'free' ? 'Residents see a few local offers. Upgrade to remove them and unlock the CA portal.'
                  : `${plan.term === 'annual' ? 'Yearly' : 'Monthly'} · paid till ${d(plan.period_end)}`}
                {plan.next_plan_code && ` · moves to ${plan.next_plan_code} after ${d(plan.period_end)}`}
              </div>
              {plan.status === 'past_due' && <div className="text-rose-200 font-semibold mt-1">Renewal unpaid — moves to Free on {d(plan.open_invoice?.moves_to_free_on)}. Everything keeps working until then.</div>}</>
          )}
        </section>
      )}

      {open && (
        <section className="p-4 rounded-2xl bg-slate-900 border border-amber-700 space-y-3">
          <div className="flex flex-wrap justify-between gap-2">
            <div>
              <div className="font-bold text-white">{open.invoice_number} · {formatINR(open.total)}</div>
              <div className="text-slate-400">{open.kind === 'renewal' ? 'Renewal' : open.kind === 'upgrade' ? 'Upgrade (prorated)' : 'New plan'} · {d(open.period_start)} – {d(open.period_end)} · due {d(open.due_on)}</div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setViewing(open)} className="px-3 py-2 rounded-xl bg-slate-800 text-slate-200 cursor-pointer">View invoice</button>
              {canManage && (
                <button onClick={() => pay(open)} disabled={busy !== null} className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold cursor-pointer disabled:opacity-50 flex items-center gap-1">
                  {busy === open.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : `Pay ${formatINR(open.total)}`}
                </button>
              )}
            </div>
          </div>
          <div className="text-slate-500">Pay from the society&apos;s account (UPI / card / netbanking). Or <button onClick={() => setShowBank(s => !s)} className="text-sky-400 hover:underline cursor-pointer">pay by bank transfer</button>.</div>
          {showBank && (
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1 text-slate-300">
              {bank.bank_account ? (
                <>
                  <div>Account name: <strong className="text-white">{bank.seller_name || 'Sahvaas'}</strong></div>
                  <div>Bank: {bank.bank_name} · A/c <span className="font-mono">{bank.bank_account}</span> · IFSC <span className="font-mono">{bank.bank_ifsc}</span></div>
                  {bank.bank_upi && <div>UPI: <span className="font-mono">{bank.bank_upi}</span></div>}
                  <div className="text-slate-500">Put {open.invoice_number} in the remarks. The plan starts once Sahvaas confirms the transfer (usually 1 working day).</div>
                </>
              ) : <div>Bank details will be shared by Sahvaas support. Reply to the invoice email with the UTR after paying.</div>}
            </div>
          )}
        </section>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="font-bold text-white">Plans</div>
        <div role="radiogroup" className="flex gap-1 p-1 rounded-xl bg-slate-900 border border-slate-800">
          {([['annual', 'Yearly · 2 months free'], ['monthly', 'Monthly']] as const).map(([t, label]) => (
            <button key={t} role="radio" aria-checked={term === t} onClick={() => setTerm(t)}
              className={`px-3 py-1.5 rounded-lg font-semibold cursor-pointer ${term === t ? 'bg-slate-700 text-white' : 'text-slate-400'}`}>{label}</button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {plans.map(p => {
          const qt = quotes[p.tier_code];
          const current = currentPaid === p.tier_code;
          return (
            <div key={p.id} className={`p-4 rounded-2xl border flex flex-col gap-2 ${current ? 'border-sky-500 bg-sky-950/40' : 'border-slate-800 bg-slate-900'}`}>
              <div className="flex justify-between items-baseline">
                <div className="text-base font-extrabold text-white">{p.name}</div>
                <div className="text-slate-400">{Number(p.monthly_rate_per_unit_inr) ? `${formatINR(qt?.rate ?? p.monthly_rate_per_unit_inr)} / flat / month` : 'Free'}</div>
              </div>
              {p.description && <div className="text-slate-400">{p.description}</div>}
              <ul className="space-y-1 text-slate-300 flex-1">
                {(p.features_included ?? []).map(f => <li key={f}>✓ {f}</li>)}
                {p.show_ads && <li className="text-amber-300">• Residents see local offers</li>}
              </ul>
              {qt && Number(qt.total) > 0 && (
                <div className="p-2 rounded-xl bg-slate-950 text-slate-300">
                  {qt.billable_units} flats{qt.billable_units > qt.units ? ` (minimum ${qt.min_billable})` : ''} × {formatINR(qt.rate)} × {qt.months_charged} = {formatINR(qt.gross)}
                  {Number(qt.discount) > 0 && <> − {formatINR(qt.discount)} discount</>} + GST {formatINR(qt.gst)}
                  <div className="text-white font-bold">{formatINR(qt.total)} {term === 'annual' ? 'a year' : 'a month'}</div>
                  {Number(qt.savings_vs_monthly) > 0 && <div className="text-emerald-300">Saves {formatINR(qt.savings_vs_monthly)} vs monthly</div>}
                  {qt.free_months > 0 && <div className="text-emerald-300">+ {qt.free_months} free months on your first plan</div>}
                </div>
              )}
              {canManage && (
                <button onClick={() => choose(p.tier_code)} disabled={busy !== null || (current && p.tier_code !== 'free')}
                  className={`py-2 rounded-xl font-bold cursor-pointer disabled:opacity-50 ${p.tier_code === 'free' ? 'bg-slate-800 text-slate-200' : 'bg-sky-600 hover:bg-sky-500 text-white'}`}>
                  {busy === p.tier_code ? <Loader2 className="w-3.5 h-3.5 animate-spin mx-auto" /> : current ? 'Current plan' : p.tier_code === 'free' ? 'Switch to Free' : `Choose ${p.name}`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {invoices.length > 0 && (
        <section className="space-y-2">
          <div className="font-bold text-white">Invoices</div>
          <div className="rounded-2xl bg-slate-900 border border-slate-800 divide-y divide-slate-800">
            {invoices.map(i => (
              <button key={i.id} onClick={() => setViewing(i)} className="w-full p-3 flex justify-between gap-3 text-left hover:bg-slate-800/50 cursor-pointer">
                <span><span className="font-mono text-white">{i.invoice_number}</span> <span className="text-slate-400">· {i.plan_code} · {d(i.period_start)} – {d(i.period_end)}</span></span>
                <span className="text-right"><span className="text-white font-semibold">{formatINR(i.total)}</span> <span className={`ml-2 text-[10px] font-bold uppercase ${i.status === 'paid' ? 'text-emerald-300' : i.status === 'void' ? 'text-slate-500' : 'text-amber-300'}`}>{i.status}</span></span>
              </button>
            ))}
          </div>
        </section>
      )}

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

/** Shown in place of a module the current plan does not include. */
export const FeatureGate: React.FC<{ plan: SocietyPlan | null; feature: string; label: string; planName: string; onUpgrade: () => void; children: React.ReactNode }> =
  ({ plan, feature, label, planName, onUpgrade, children }) => {
    if (!plan || plan.features.includes(feature as SocietyPlan['features'][number])) return <>{children}</>;
    return (
      <div className="max-w-lg mx-auto mt-8 p-6 rounded-3xl bg-slate-900 border border-slate-800 text-center space-y-3 text-xs">
        <div className="w-12 h-12 mx-auto rounded-2xl bg-amber-500/10 flex items-center justify-center"><Sparkles className="w-6 h-6 text-amber-300" /></div>
        <div className="text-lg font-bold text-white">{label} is on {planName}</div>
        <p className="text-slate-400">You are on the {plan.plan_name} plan. Anything recorded earlier is kept and comes back as soon as you upgrade.</p>
        <button onClick={onUpgrade} className="px-5 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold cursor-pointer">See plans</button>
      </div>
    );
  };
