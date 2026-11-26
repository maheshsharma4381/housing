import React from 'react';
import { Link } from '../../router/RouterContext';
import {
  ShieldCheck,
  Lock,
  Database,
  FileKey,
  EyeOff,
  ArrowRight,
} from 'lucide-react';

export const SecurityPage: React.FC = () => {
  return (
    <div className="bg-canvas text-fg min-h-screen py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-16">
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-success-soft text-success border border-success/30 text-xs font-semibold">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Bank-Grade Data Architecture</span>
          </div>
          <h1 className="text-3xl sm:text-5xl font-semibold text-fg tracking-tight">
            Security & Tenant Isolation
          </h1>
          <p className="text-xs sm:text-sm text-fg-muted leading-relaxed">
            Housing society management involves sensitive resident contact details, bank statements, and financial audits. 
            Security is not an afterthought or frontend filter — it is strictly enforced in the database kernel.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-5xl mx-auto">
          <div className="p-6 rounded-xl bg-surface border border-border space-y-3">
            <div className="w-10 h-10 rounded-xl bg-success-soft text-success flex items-center justify-center">
              <Database className="w-5 h-5" />
            </div>
            <h3 className="font-semibold text-fg text-base">Row Level Security (RLS) on Every Table</h3>
            <p className="text-xs text-fg-muted leading-relaxed">
              Every database entity is governed by PostgreSQL Row Level Security. Even if an attacker manipulates API requests, the database rejects queries outside the authenticated user&apos;s active society membership.
            </p>
          </div>

          <div className="p-6 rounded-xl bg-surface border border-border space-y-3">
            <div className="w-10 h-10 rounded-xl bg-success-soft text-success flex items-center justify-center">
              <EyeOff className="w-5 h-5" />
            </div>
            <h3 className="font-semibold text-fg text-base">Strict Member Privacy Isolation</h3>
            <p className="text-xs text-fg-muted leading-relaxed">
              Residents can only read and query their own flat&apos;s maintenance bills, payment allocations, and private helpdesk tickets. They cannot access other owners&apos; phone numbers or dues records.
            </p>
          </div>

          <div className="p-6 rounded-xl bg-surface border border-border space-y-3">
            <div className="w-10 h-10 rounded-xl bg-success-soft text-success flex items-center justify-center">
              <FileKey className="w-5 h-5" />
            </div>
            <h3 className="font-semibold text-fg text-base">Zero Password & Secret Key Exposure</h3>
            <p className="text-xs text-fg-muted leading-relaxed">
              We never ask for or store government GST portal passwords or banking internet passwords. 
              Backend service-role secrets and private API keys remain strictly isolated on server proxies.
            </p>
          </div>

          <div className="p-6 rounded-xl bg-surface border border-border space-y-3">
            <div className="w-10 h-10 rounded-xl bg-success-soft text-success flex items-center justify-center">
              <Lock className="w-5 h-5" />
            </div>
            <h3 className="font-semibold text-fg text-base">Deterministic Financial Calculations</h3>
            <p className="text-xs text-fg-muted leading-relaxed">
              AI never calculates financial totals, tax balances or ledger postings. It only reads an uploaded vendor invoice to pre-fill a form
              that a committee member checks. All balances are deterministic, reproducible and verifiable by statutory auditors.
            </p>
          </div>

          <div className="p-6 rounded-xl bg-surface border border-border space-y-3 md:col-span-2">
            <div className="w-10 h-10 rounded-xl bg-success-soft text-success flex items-center justify-center">
              <EyeOff className="w-5 h-5" />
            </div>
            <h3 className="font-semibold text-fg text-base">Local Offers on the Free Plan — No Tracking</h3>
            <p className="text-xs text-fg-muted leading-relaxed">
              Societies on the free plan show residents up to one clearly labelled local offer on the home feed or notice board — never on
              payments, bills, receipts, financial reports, committee or CA screens, and never during the trial or on a paid plan.
              Offers are chosen only by the society&apos;s city or pincode. Advertisers receive no names, flats, phone numbers or dues —
              only how many times a card was seen and tapped, counted per society per day without recording who saw it.
            </p>
          </div>
        </div>

        <div className="text-center pt-4">
          <Link
            href="/contact"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-brand hover:bg-brand-hover text-on-brand font-semibold text-xs shadow-card transition"
          >
            <span>Request Security Audit Documentation</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
};
