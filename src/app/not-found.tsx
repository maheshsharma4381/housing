'use client';

import { PublicHeader } from '../components/PublicHeader';
import { PublicFooter } from '../components/PublicFooter';
import { Link } from '../router/RouterContext';
import { AlertCircle, Home } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="flex-1 flex flex-col min-h-screen bg-canvas text-fg">
      <PublicHeader />
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-surface border border-border rounded-2xl p-8 text-center space-y-4 shadow-card">
          <div className="w-14 h-14 rounded-xl bg-brand-soft border border-brand/20 text-brand mx-auto flex items-center justify-center">
            <AlertCircle className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-semibold text-fg tracking-tight">Page Not Found</h1>
          <p className="text-xs text-fg-muted leading-relaxed">
            The page you requested does not exist or may have moved. Please check the URL or return to the home page.
          </p>
          <div className="pt-2">
            <Link
              href="/"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-brand hover:bg-brand-hover text-on-brand text-xs font-semibold shadow-card transition"
            >
              <Home className="w-4 h-4" />
              <span>Back to Homepage</span>
            </Link>
          </div>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
