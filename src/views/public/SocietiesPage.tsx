import React from 'react';
import { Link } from '../../router/RouterContext';
import { 
  Building2, 
  Smartphone, 
  CheckCircle2, 
  ArrowRight, 
  Receipt, 
  Users, 
  FileText, 
  ShieldCheck,
  QrCode
} from 'lucide-react';

export const SocietiesPage: React.FC = () => {
  return (
    <div className="bg-slate-950 text-slate-100 min-h-screen py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-16">
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <span className="text-xs font-bold uppercase tracking-wider text-sky-400">
            For Managing Committees
          </span>
          <h1 className="text-3xl sm:text-5xl font-black text-white tracking-tight">
            Built for Secretaries, Chairmen & Treasurers
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
            Eliminate endless WhatsApp threads, paper register entries, and friction over dues. 
            Run housing society administration comfortably from your mobile phone.
          </p>
        </div>

        {/* Roles breakdown */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="p-6 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
            <div className="w-10 h-10 rounded-xl bg-sky-500/10 text-sky-400 flex items-center justify-center font-bold">
              1
            </div>
            <h3 className="font-bold text-white text-base">The Secretary</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Maintain flat occupancy records, manage owner vs tenant rosters, publish official society notices with read receipts, and monitor helpdesk tickets.
            </p>
            <ul className="text-xs text-slate-300 space-y-1.5 pt-2 border-t border-slate-800">
              <li>✓ Manage wings, floors & units</li>
              <li>✓ Issue NOC requests & AGM circulars</li>
              <li>✓ Review incoming vendor quotes</li>
            </ul>
          </div>

          <div className="p-6 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
            <div className="w-10 h-10 rounded-xl bg-sky-500/10 text-sky-400 flex items-center justify-center font-bold">
              2
            </div>
            <h3 className="font-bold text-white text-base">The Treasurer</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Generate monthly maintenance cycles in 1 click. Verify resident UPI reference UTRs, approve vendor invoices, and track bank account balances.
            </p>
            <ul className="text-xs text-slate-300 space-y-1.5 pt-2 border-t border-slate-800">
              <li>✓ 1-Click monthly billing cycles</li>
              <li>✓ UPI payment UTR verification</li>
              <li>✓ Bank account statement matching</li>
            </ul>
          </div>

          <div className="p-6 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
            <div className="w-10 h-10 rounded-xl bg-sky-500/10 text-sky-400 flex items-center justify-center font-bold">
              3
            </div>
            <h3 className="font-bold text-white text-base">The Chairman</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Oversee high-level governance, review sinking fund reserves, grant authorized CA audit access, and maintain immutable compliance audit trails.
            </p>
            <ul className="text-xs text-slate-300 space-y-1.5 pt-2 border-t border-slate-800">
              <li>✓ Executive dashboard overview</li>
              <li>✓ Sinking & repair fund oversight</li>
              <li>✓ Committee resolution archives</li>
            </ul>
          </div>
        </div>

        {/* Real-world Operations Flow */}
        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-8 sm:p-12 space-y-6">
          <h3 className="text-xl font-bold text-white">The Sahvaas Operations Workflow</h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
            <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
              <span className="font-mono text-[10px] text-sky-400 font-bold">STEP 01</span>
              <div className="font-bold text-white">Bill Issued</div>
              <div className="text-slate-400">Automated maintenance bill generated on the 1st of every month.</div>
            </div>
            <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
              <span className="font-mono text-[10px] text-sky-400 font-bold">STEP 02</span>
              <div className="font-bold text-white">Resident Pays UPI</div>
              <div className="text-slate-400">Member scans society bank QR and enters the 12-digit UTR on mobile.</div>
            </div>
            <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
              <span className="font-mono text-[10px] text-sky-400 font-bold">STEP 03</span>
              <div className="font-bold text-white">Bank Credit Match</div>
              <div className="text-slate-400">Treasurer matches bank credit line; official numbered receipt auto-issues.</div>
            </div>
            <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
              <span className="font-mono text-[10px] text-sky-400 font-bold">STEP 04</span>
              <div className="font-bold text-white">Ledger Updates</div>
              <div className="text-slate-400">Double-entry ledger posts automatically in backend without accounting staff.</div>
            </div>
          </div>
        </div>

        <div className="text-center">
          <Link
            href="/contact"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs shadow-md transition"
          >
            <span>Onboard Your Society</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
};
