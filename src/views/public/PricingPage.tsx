'use client';

import React, { useEffect, useState } from 'react';
import { Link } from '../../router/RouterContext';
import { supabase } from '../../lib/supabase/client';
import { CheckCircle2 } from 'lucide-react';

interface PublicPlan { tier_code: string; name: string; monthly_rate_per_unit_inr: number; features_included: string[]; description: string | null; show_ads: boolean }

// Shown until the live plans load (and if the database is unreachable); the admin's prices win
const FALLBACK: PublicPlan[] = [
  { tier_code: 'free', name: 'Free', monthly_rate_per_unit_inr: 0, show_ads: true, description: 'Everything to run the society. Residents see a few local offers.',
    features_included: ['Billing & UPI collection', 'Receipts', 'Notices & tickets', 'Double-entry books'] },
  { tier_code: 'basic', name: 'Basic', monthly_rate_per_unit_inr: 10, show_ads: false, description: 'For societies that work with a CA.',
    features_included: ['Everything in Free', 'No ads', 'CA & auditor portal', 'Asset register & depreciation'] },
  { tier_code: 'pro', name: 'Pro', monthly_rate_per_unit_inr: 18, show_ads: false, description: 'For GST-registered and larger societies.',
    features_included: ['Everything in Basic', 'GSTR-2B reconciliation', 'TDS register', 'Bank statement match', 'Tally export'] },
];

export const PricingPage: React.FC = () => {
  const [plans, setPlans] = useState<PublicPlan[]>(FALLBACK);

  useEffect(() => {
    if (!supabase) return;
    supabase.from('subscription_plans').select('tier_code, name, monthly_rate_per_unit_inr, features_included, description, show_ads')
      .eq('is_active', true).order('sort_order')
      .then(({ data }) => {
        const live = (data ?? []) as PublicPlan[];
        if (live.length) setPlans(live);
      });
  }, []);

  return (
    <div className="bg-slate-950 text-slate-100 min-h-screen py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-12">
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <span className="text-xs font-bold uppercase tracking-wider text-sky-400">Simple & Transparent</span>
          <h1 className="text-3xl sm:text-5xl font-black text-white tracking-tight">Free to start. Pay per flat when you need more.</h1>
          <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
            Every society gets a 30-day trial with all features. No setup fee, no per-user fee and no charge on residents&apos; UPI payments —
            money goes straight to the society&apos;s own account.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {plans.map(p => {
            const highlight = p.tier_code === 'basic';
            const rate = Number(p.monthly_rate_per_unit_inr);
            return (
              <div key={p.tier_code} className={`p-8 rounded-3xl space-y-6 flex flex-col justify-between relative ${highlight ? 'bg-gradient-to-b from-slate-900 to-slate-950 border-2 border-sky-500 shadow-2xl shadow-sky-950/50' : 'bg-slate-900 border border-slate-800'}`}>
                {highlight && (
                  <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-sky-500 text-slate-950 font-bold text-[10px] uppercase tracking-wider">Most societies</div>
                )}
                <div className="space-y-4">
                  <div>
                    <h3 className="text-xl font-bold text-white">{p.name}</h3>
                    {p.description && <p className="text-xs text-slate-400 mt-1">{p.description}</p>}
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-extrabold text-white">{rate ? `₹${rate}` : '₹0'}</span>
                    <span className="text-xs text-slate-400">{rate ? '/ flat / month + GST' : 'forever'}</span>
                  </div>
                  <ul className="text-xs text-slate-300 space-y-2.5 pt-4 border-t border-slate-800">
                    {(p.features_included ?? []).map(f => (
                      <li key={f} className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-sky-400 shrink-0" /><span>{f}</span></li>
                    ))}
                  </ul>
                </div>
                <Link href="/signup" className={`w-full py-2.5 rounded-xl font-semibold text-xs text-center block transition ${highlight ? 'bg-sky-600 hover:bg-sky-500 text-white shadow-md' : 'bg-slate-800 hover:bg-slate-700 text-white'}`}>
                  Start the 30-day trial
                </Link>
              </div>
            );
          })}
        </div>

        <div className="max-w-3xl mx-auto text-center text-xs text-slate-400 space-y-1">
          <p>Yearly billing charges 10 months for 12. Paid plans bill a minimum of 20 flats. GST at 18% is added on the invoice.</p>
          <p>If a renewal isn&apos;t paid, the society simply moves to Free — nothing is deleted, and paying brings everything back.</p>
          <p><Link href="/contact" className="text-sky-400 hover:underline">Large township or special requirements? Talk to us.</Link></p>
        </div>
      </div>
    </div>
  );
};
