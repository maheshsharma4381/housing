import React from 'react';
import { Link } from '../../router/RouterContext';
import { 
  Briefcase, 
  FileSpreadsheet, 
  ShieldCheck, 
  Lock, 
  CheckCircle2, 
  ArrowRight, 
  Landmark, 
  FileCheck2,
  FolderLock
} from 'lucide-react';

export const AccountantsPage: React.FC = () => {
  return (
    <div className="bg-slate-950 text-slate-100 min-h-screen py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-16">
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <span className="text-xs font-bold uppercase tracking-wider text-amber-400">
            For Practicing Professionals
          </span>
          <h1 className="text-3xl sm:text-5xl font-black text-white tracking-tight">
            Designed for Statutory Auditors, CAs & GST Consultants
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
            Stop chasing society secretaries for physical voucher files and bank passbooks. 
            Access a clean, dedicated web portal with verified double-entry ledgers, vendor TDS deductions, and GSTR-2B reconciliation.
          </p>
        </div>

        {/* Pillars for CAs */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="p-6 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center">
              <FileSpreadsheet className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-white text-base">GSTR-2B Reconciliation Engine</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Upload monthly GSTR-2B Excel or JSON files directly from the GST portal. Sahvaas compares invoice numbers, supplier GSTINs, and tax values against recorded vendor bills in seconds.
            </p>
            <div className="text-[11px] text-amber-300 font-mono pt-2 border-t border-slate-800">
              ✓ Identifies missing ITC before filing deadline
            </div>
          </div>

          <div className="p-6 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center">
              <Landmark className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-white text-base">Automated General Ledger & Vouchers</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Review balance sheets, profit & loss, sinking fund reserves, and vendor payments with attached original invoice scans. Verify TDS 194C deductions with clear calculation trails.
            </p>
            <div className="text-[11px] text-amber-300 font-mono pt-2 border-t border-slate-800">
              ✓ Dual-step committee approval signatures logged
            </div>
          </div>

          <div className="p-6 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center">
              <Lock className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-white text-base">Granular Permissions & Privacy</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Societies configure explicit permissions. You only see modules relevant to your statutory audit or tax advisory mandate. Resident personal contact details and complaints are locked out.
            </p>
            <div className="text-[11px] text-amber-300 font-mono pt-2 border-t border-slate-800">
              ✓ Database-level RLS policy isolation
            </div>
          </div>
        </div>

        {/* GST MVP Architecture Note */}
        <div className="p-8 rounded-3xl bg-slate-900 border border-slate-800 max-w-4xl mx-auto space-y-4">
          <div className="flex items-center gap-2.5 text-amber-400 text-xs font-semibold uppercase tracking-wider">
            <ShieldCheck className="w-4 h-4" />
            <span>Zero Password Storage Architecture</span>
          </div>
          <h3 className="text-xl font-bold text-white">How Sahvaas Handles GST Safely</h3>
          <p className="text-xs text-slate-300 leading-relaxed">
            Unlike legacy software that asks users to store sensitive government GST portal passwords on third-party servers, 
            Sahvaas uses an offline reconciliation engine:
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs pt-2">
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
              <div className="font-bold text-white">1. Portal Download</div>
              <div className="text-slate-400 mt-0.5">Download official GSTR-2B JSON or Excel from gst.gov.in securely.</div>
            </div>
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
              <div className="font-bold text-white">2. Upload & Match</div>
              <div className="text-slate-400 mt-0.5">Engine matches supplier GSTIN, invoice #, and taxable values against society books.</div>
            </div>
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
              <div className="font-bold text-white">3. Review & Hold</div>
              <div className="text-slate-400 mt-0.5">CA flags missing supplier invoices and holds ITC with full audit documentation.</div>
            </div>
          </div>
        </div>

        <div className="text-center">
          <Link
            href="/contact"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs shadow-md transition"
          >
            <span>Partner with Sahvaas as a CA</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
};
