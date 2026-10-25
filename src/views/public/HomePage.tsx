import React from 'react';
import { Link } from '../../router/RouterContext';
import { 
  Smartphone, 
  Building2, 
  ShieldCheck, 
  Briefcase, 
  CheckCircle2, 
  ArrowRight, 
  Receipt, 
  FileSpreadsheet, 
  QrCode, 
  Lock,
  Layers,
  Users,
  Clock,
  Sparkles
} from 'lucide-react';

export const HomePage: React.FC = () => {
  return (
    <div className="bg-slate-950 text-slate-100 min-h-screen">
      {/* Hero Section */}
      <section className="relative overflow-hidden pt-12 pb-20 sm:pt-20 sm:pb-28 border-b border-slate-800/80">
        <div className="absolute inset-0 bg-radial from-sky-900/20 via-slate-950/80 to-slate-950 pointer-events-none" />
        
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="text-center max-w-3xl mx-auto space-y-6">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-sky-500/10 border border-sky-500/30 text-sky-400 text-xs font-semibold">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Multi-Tenant Housing Society OS</span>
            </div>

            <h1 className="text-3xl sm:text-5xl lg:text-6xl font-black text-white tracking-tight leading-tight">
              Run Your Society from Your Phone.
              <span className="block text-transparent bg-clip-text bg-gradient-to-r from-sky-400 via-sky-300 to-indigo-400">
                Accounting Stays Automated in the Backend.
              </span>
            </h1>

            <p className="text-sm sm:text-base text-slate-300 max-w-2xl mx-auto leading-relaxed">
              Sahvaas is not a complex accounting software clone. It is an operations platform built 
              for Secretaries, Chairmen, and Treasurers to manage approvals, payments, and notices on mobile — while financial ledgers, audit trails, and tax reconciliations maintain themselves.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-4">
              <Link
                href="/login"
                className="w-full sm:w-auto px-6 py-3.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs sm:text-sm shadow-lg shadow-sky-600/30 flex items-center justify-center gap-2 transition"
              >
                <span>Access Society Workspace</span>
                <ArrowRight className="w-4 h-4" />
              </Link>

              <Link
                href="/contact"
                className="w-full sm:w-auto px-6 py-3.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 transition"
              >
                <span>Book a Guided Demo</span>
              </Link>
            </div>

            {/* Trust Badges */}
            <div className="pt-8 flex flex-wrap items-center justify-center gap-6 text-xs text-slate-400">
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span>Model Bye-laws Ready</span>
              </div>
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span>Zero Accounting Jargon</span>
              </div>
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span>Granular CA & Auditor Portal</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* The 3 Core Experiences Section */}
      <section className="py-16 sm:py-24 border-b border-slate-800/80 bg-slate-900/40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-2xl mx-auto mb-12">
            <span className="text-xs font-bold uppercase tracking-wider text-sky-400">
              Unified Platform
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-white mt-1">
              Purpose-Built Portals for Every Stakeholder
            </h2>
            <p className="text-xs sm:text-sm text-slate-400 mt-2">
              No confused roles. A secretary manages operations, a CA audits financial ledgers, and a resident pays dues seamlessly.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Society Mobile PWA */}
            <div className="p-6 sm:p-8 rounded-2xl bg-slate-900 border border-slate-800 space-y-4 hover:border-sky-500/40 transition">
              <div className="w-12 h-12 rounded-xl bg-sky-500/10 text-sky-400 flex items-center justify-center">
                <Smartphone className="w-6 h-6" />
              </div>
              <h3 className="text-lg font-bold text-white">Society Committee PWA</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Secretary, Chairman, and Treasurer run daily operations on mobile. Approve vendor invoices, generate maintenance bills, post circulars, and reconcile payments.
              </p>
              <ul className="text-xs text-slate-300 space-y-2 pt-2 border-t border-slate-800">
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span>Two-step expense approvals</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span>Official UPI QR collection tracking</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span>Flats & member occupancy registry</span>
                </li>
              </ul>
              <Link href="/societies" className="inline-flex items-center gap-1.5 text-xs text-sky-400 font-semibold pt-2 hover:underline">
                Explore Society PWA <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>

            {/* CA & Auditor Portal */}
            <div className="p-6 sm:p-8 rounded-2xl bg-slate-900 border border-slate-800 space-y-4 hover:border-amber-500/40 transition">
              <div className="w-12 h-12 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center">
                <Briefcase className="w-6 h-6" />
              </div>
              <h3 className="text-lg font-bold text-white">Professional Web Portal</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                For Statutory Auditors, CAs, and Tax Consultants. Audit society double-entry ledgers and reconcile GSTR-2B offline without compromising resident privacy.
              </p>
              <ul className="text-xs text-slate-300 space-y-2 pt-2 border-t border-slate-800">
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>GSTR-2B Excel/JSON reconciliation</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>Automated double-entry journals & ledger</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>Granular scope (personal data blocked)</span>
                </li>
              </ul>
              <Link href="/accountants" className="inline-flex items-center gap-1.5 text-xs text-amber-400 font-semibold pt-2 hover:underline">
                Explore CA Portal <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>

            {/* Resident Mobile App */}
            <div className="p-6 sm:p-8 rounded-2xl bg-slate-900 border border-slate-800 space-y-4 hover:border-emerald-500/40 transition">
              <div className="w-12 h-12 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
                <Building2 className="w-6 h-6" />
              </div>
              <h3 className="text-lg font-bold text-white">Resident Self-Service</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Owners and tenants receive automated maintenance bills, pay directly via UPI, download official payment receipts, and raise maintenance tickets.
              </p>
              <ul className="text-xs text-slate-300 space-y-2 pt-2 border-t border-slate-800">
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Flat bill & outstanding balance</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Instant receipt download</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Helpdesk complaints & notice board</span>
                </li>
              </ul>
              <Link href="/features" className="inline-flex items-center gap-1.5 text-xs text-emerald-400 font-semibold pt-2 hover:underline">
                View Resident Features <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Security & Multi-Tenancy Guarantee */}
      <section className="py-16 sm:py-24 border-b border-slate-800/80">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="bg-gradient-to-br from-slate-900 to-slate-950 border border-slate-800 rounded-3xl p-8 sm:p-12">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
              <div className="space-y-4">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-semibold">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Security & Multi-Tenant Isolation</span>
                </div>
                <h2 className="text-2xl sm:text-3xl font-extrabold text-white">
                  Cross-Society Data Contamination is Impossible
                </h2>
                <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
                  Every single query is protected by PostgreSQL Row Level Security (RLS). Society A can never access Society B. 
                  Residents cannot view another flat&apos;s records. CAs can only review modules explicitly approved by society committees.
                </p>
                <div className="pt-2">
                  <Link
                    href="/security"
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold border border-slate-700 transition"
                  >
                    Read Security Whitepaper <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                  <div className="font-bold text-white text-sm">Supabase RLS</div>
                  <div className="text-slate-400">Database-enforced policies on all tables.</div>
                </div>
                <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                  <div className="font-bold text-white text-sm">No GST Passwords</div>
                  <div className="text-slate-400">Zero scraping; clean GSTR-2B offline file matching.</div>
                </div>
                <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                  <div className="font-bold text-white text-sm">Audit Trails</div>
                  <div className="text-slate-400">Immutable logging of approvals and edits.</div>
                </div>
                <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                  <div className="font-bold text-white text-sm">Deterministic</div>
                  <div className="text-slate-400">Double-entry financials strictly non-AI generated.</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Call to Action Banner */}
      <section className="py-16 sm:py-20 text-center">
        <div className="max-w-4xl mx-auto px-4 space-y-6">
          <h2 className="text-2xl sm:text-4xl font-extrabold text-white">
            Ready to Modernize Your Housing Society?
          </h2>
          <p className="text-xs sm:text-sm text-slate-400 max-w-xl mx-auto">
            Get started in under 15 minutes. Import member flats, set maintenance rules, and give your committee peace of mind.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
            <Link
              href="/contact"
              className="px-6 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs sm:text-sm shadow-md"
            >
              Request a Consultation
            </Link>
            <Link
              href="/pricing"
              className="px-6 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 font-semibold text-xs sm:text-sm"
            >
              View Pricing Tiers
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
};
