import React from 'react';
import { Link } from '../../router/RouterContext';
import { 
  CreditCard, 
  Receipt, 
  FileSpreadsheet, 
  Smartphone, 
  ShieldCheck, 
  Users, 
  Landmark, 
  MessageSquare,
  QrCode,
  FileCheck2,
  CheckCircle2,
  ArrowRight
} from 'lucide-react';

export const FeaturesPage: React.FC = () => {
  const featureList = [
    {
      icon: Smartphone,
      title: 'Mobile-First Society Operations',
      desc: 'Committee members can approve bills, verify bank credits, post circulars, and review member requests directly from iOS or Android via PWA without booting up a desktop.',
    },
    {
      icon: Receipt,
      title: 'Two-Step Expense Approvals',
      desc: 'Enforce statutory dual-signing workflows. Secretary reviews vendor invoices and Treasurer approves disbursement before payment execution.',
    },
    {
      icon: CreditCard,
      title: 'Automated Maintenance Billing',
      desc: 'Configurable billing cycles based on flat rates or carpet area sq.ft. Automated calculation of sinking fund, repair fund, and non-occupancy charges.',
    },
    {
      icon: QrCode,
      title: 'Direct UPI & Bank QR Collections',
      desc: 'No expensive payment gateway markups. Residents scan official society UPI QR codes and enter transaction reference UTRs for 1-click treasurer reconciliation.',
    },
    {
      icon: Landmark,
      title: 'Automated Double-Entry Backend',
      desc: 'Real-world events automatically post to general ledgers in the background. Committee members never have to manually enter debits, credits, or journal entries.',
    },
    {
      icon: FileSpreadsheet,
      title: 'GSTR-2B Offline Reconciliation',
      desc: 'Statutory compliance made effortless. Download GSTR-2B JSON/Excel from the GST portal, upload to Sahvaas, and instantly spot missing supplier credits.',
    },
    {
      icon: ShieldCheck,
      title: 'Granular Professional Delegation',
      desc: 'Invite your CA, auditor, or accountant with customized time-bound permissions. Statutory auditors review ledgers while resident personal data stays hidden.',
    },
    {
      icon: MessageSquare,
      title: 'Ticketing & Notice Broadcasts',
      desc: 'Replace chaotic WhatsApp groups. Residents raise structured plumbing, electrical, or parking tickets and receive verified official society circulars.',
    },
  ];

  return (
    <div className="bg-slate-950 text-slate-100 min-h-screen py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-12">
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <span className="text-xs font-bold uppercase tracking-wider text-sky-400">
            Platform Capabilities
          </span>
          <h1 className="text-3xl sm:text-5xl font-black text-white tracking-tight">
            Designed for Housing Society Realities
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
            Every feature is engineered to simplify committee governance, ensure complete transparency for residents, and empower chartered accountants with deterministic audit trails.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {featureList.map((f, i) => {
            const Icon = f.icon;
            return (
              <div key={i} className="p-6 rounded-2xl bg-slate-900 border border-slate-800 space-y-3 hover:border-sky-500/40 transition">
                <div className="w-10 h-10 rounded-xl bg-sky-500/10 text-sky-400 flex items-center justify-center">
                  <Icon className="w-5 h-5" />
                </div>
                <h3 className="font-bold text-white text-base">{f.title}</h3>
                <p className="text-xs text-slate-400 leading-relaxed">{f.desc}</p>
              </div>
            );
          })}
        </div>

        {/* Feature Comparison Box */}
        <div className="p-8 rounded-3xl bg-slate-900/60 border border-slate-800 space-y-6 max-w-4xl mx-auto">
          <h3 className="text-xl font-bold text-white text-center">
            How Sahvaas Differs From Traditional Accounting Software
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="p-4 rounded-xl bg-slate-950 border border-slate-800/80 space-y-2">
              <span className="font-bold text-rose-400 uppercase tracking-wider text-[10px]">Traditional Tally / ERP</span>
              <ul className="space-y-1.5 text-slate-400">
                <li>• Requires manual journal entries and ledger postings</li>
                <li>• Desktop-locked software inaccessible to mobile committee</li>
                <li>• Hard to navigate for non-accountant residents</li>
                <li>• Full access or no access (privacy risks for members)</li>
              </ul>
            </div>

            <div className="p-4 rounded-xl bg-sky-950/40 border border-sky-800/60 space-y-2">
              <span className="font-bold text-sky-400 uppercase tracking-wider text-[10px]">Sahvaas Operating System</span>
              <ul className="space-y-1.5 text-slate-200">
                <li>✓ Real-world events trigger automatic double-entry ledgers</li>
                <li>✓ Full mobile PWA optimized for Secretary and Treasurer</li>
                <li>✓ Clean terminology: Outstanding, Bills, Receipts</li>
                <li>✓ Granular RLS: CAs review financials without seeing member private info</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="text-center pt-6">
          <Link
            href="/contact"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs shadow-md transition"
          >
            <span>Schedule a Demo for Your Committee</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
};
