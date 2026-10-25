import React from 'react';
import { Link } from '../router/RouterContext';
import { ShieldCheck, Lock, Building2 } from 'lucide-react';

export const PublicFooter: React.FC = () => {
  return (
    <footer className="bg-slate-950 border-t border-slate-800 text-slate-400 text-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8">
          {/* Brand Col */}
          <div className="col-span-2 space-y-4">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-sky-500 to-sky-700 flex items-center justify-center text-white font-bold text-sm">
                S
              </div>
              <span className="font-bold text-base text-white">Sahvaas</span>
            </div>
            <p className="text-slate-400 text-xs max-w-sm leading-relaxed">
              The modern, operations-first management platform for cooperative housing societies and gated communities. 
              Run daily operations on your mobile phone while financial ledgers, bank matches, and statutory records maintain automatically.
            </p>
            <div className="flex items-center gap-2 text-[11px] text-slate-500">
              <ShieldCheck className="w-4 h-4 text-emerald-500" />
              <span>Multi-Tenant Architecture • Enforced PostgreSQL RLS</span>
            </div>
          </div>

          {/* Product */}
          <div className="space-y-3">
            <h4 className="text-white font-semibold text-xs uppercase tracking-wider">Product</h4>
            <ul className="space-y-2">
              <li><Link href="/features" className="hover:text-white transition">Features Overview</Link></li>
              <li><Link href="/societies" className="hover:text-white transition">Society Secretary PWA</Link></li>
              <li><Link href="/accountants" className="hover:text-white transition">CA & Auditor Portal</Link></li>
              <li><Link href="/security" className="hover:text-white transition">Security Architecture</Link></li>
              <li><Link href="/pricing" className="hover:text-white transition">Pricing Plans</Link></li>
            </ul>
          </div>

          {/* Compliance & Audit */}
          <div className="space-y-3">
            <h4 className="text-white font-semibold text-xs uppercase tracking-wider">Statutory & Audit</h4>
            <ul className="space-y-2">
              <li><span className="text-slate-500">Model Bye-laws Compliant</span></li>
              <li><span className="text-slate-500">GSTR-2B Matching Engine</span></li>
              <li><span className="text-slate-500">Double-Entry Ledger Audit</span></li>
              <li><span className="text-slate-500">Two-Step Voucher Approvals</span></li>
              <li><span className="text-slate-500">Bank Statement Auto-Match</span></li>
            </ul>
          </div>

          {/* Company & Support */}
          <div className="space-y-3">
            <h4 className="text-white font-semibold text-xs uppercase tracking-wider">Company</h4>
            <ul className="space-y-2">
              <li><Link href="/contact" className="hover:text-white transition">Contact Us</Link></li>
              <li><Link href="/login" className="hover:text-white transition">Customer Sign In</Link></li>
              <li><span className="text-slate-500">Privacy Policy</span></li>
              <li><span className="text-slate-500">Terms of Service</span></li>
            </ul>
          </div>
        </div>

        <div className="mt-12 pt-6 border-t border-slate-900 flex flex-col sm:flex-row items-center justify-between gap-4 text-[11px] text-slate-500">
          <div>
            &copy; {new Date().getFullYear()} Sahvaas Technologies Pvt. Ltd. All rights reserved.
          </div>
          <div className="flex items-center gap-4">
            <span>Server Location: Mumbai, India</span>
            <span>•</span>
            <span>No GST Portal Passwords Stored</span>
          </div>
        </div>
      </div>
    </footer>
  );
};
