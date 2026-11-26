import React from 'react';
import { Link } from '../router/RouterContext';
import { ShieldCheck } from 'lucide-react';
import { Logo } from './ui/Logo';

export const PublicFooter: React.FC = () => {
  return (
    <footer className="bg-canvas border-t border-border text-fg-muted text-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8">
          {/* Brand Col */}
          <div className="col-span-2 space-y-4">
            <div className="flex items-center gap-2.5">
              <Logo size={32} />
            </div>
            <p className="text-fg-muted text-xs max-w-sm leading-relaxed">
              Bills, UPI payments, notices and complaints for housing societies, with books your CA can trust. 
              Run daily operations on your mobile phone while financial ledgers, bank matches, and statutory records maintain automatically.
            </p>
            <div className="flex items-center gap-2 text-xs text-fg-subtle">
              <ShieldCheck className="w-4 h-4 text-success" />
              <span>Multi-Tenant Architecture • Enforced PostgreSQL RLS</span>
            </div>
          </div>

          {/* Product */}
          <div className="space-y-3">
            <h4 className="text-fg font-semibold text-xs">Product</h4>
            <ul className="space-y-2">
              <li><Link href="/features" className="hover:text-fg transition">Features Overview</Link></li>
              <li><Link href="/societies" className="hover:text-fg transition">Society Secretary PWA</Link></li>
              <li><Link href="/accountants" className="hover:text-fg transition">CA & Auditor Portal</Link></li>
              <li><Link href="/security" className="hover:text-fg transition">Security Architecture</Link></li>
              <li><Link href="/pricing" className="hover:text-fg transition">Pricing Plans</Link></li>
            </ul>
          </div>

          {/* Compliance & Audit */}
          <div className="space-y-3">
            <h4 className="text-fg font-semibold text-xs">Statutory & Audit</h4>
            <ul className="space-y-2">
              <li><span className="text-fg-subtle">Model Bye-laws Compliant</span></li>
              <li><span className="text-fg-subtle">GSTR-2B Matching Engine</span></li>
              <li><span className="text-fg-subtle">Double-Entry Ledger Audit</span></li>
              <li><span className="text-fg-subtle">Two-Step Voucher Approvals</span></li>
              <li><span className="text-fg-subtle">Bank Statement Auto-Match</span></li>
            </ul>
          </div>

          {/* Company & Support */}
          <div className="space-y-3">
            <h4 className="text-fg font-semibold text-xs">Company</h4>
            <ul className="space-y-2">
              <li><Link href="/contact" className="hover:text-fg transition">Contact Us</Link></li>
              <li><Link href="/login" className="hover:text-fg transition">Customer Sign In</Link></li>
              <li><span className="text-fg-subtle">Privacy Policy</span></li>
              <li><span className="text-fg-subtle">Terms of Service</span></li>
            </ul>
          </div>
        </div>

        <div className="mt-12 pt-6 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-fg-subtle">
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
