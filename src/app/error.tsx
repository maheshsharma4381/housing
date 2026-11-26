'use client';

import React, { useEffect } from 'react';
import { PublicHeader } from '../components/PublicHeader';
import { PublicFooter } from '../components/PublicFooter';
import { AlertTriangle, RotateCcw, Home } from 'lucide-react';
import { Link } from '../router/RouterContext';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Unhandled application error:', error);
  }, [error]);

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-canvas text-fg">
      <PublicHeader />
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-surface border border-border rounded-2xl p-8 text-center space-y-4 shadow-card">
          <div className="w-14 h-14 rounded-xl bg-danger-soft border border-danger/20 text-danger mx-auto flex items-center justify-center">
            <AlertTriangle className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-semibold text-fg tracking-tight">Something Went Wrong</h1>
          <p className="text-xs text-fg-muted leading-relaxed">
            An unexpected error occurred while rendering this page. You can attempt to retry the operation or return to the dashboard.
          </p>
          <div className="pt-2 flex items-center justify-center gap-3">
            <button
              onClick={() => reset()}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-surface-muted hover:bg-border text-fg text-xs font-semibold border border-border-strong transition cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Try Again</span>
            </button>
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-brand hover:bg-brand-hover text-on-brand text-xs font-semibold shadow-card transition"
            >
              <Home className="w-3.5 h-3.5" />
              <span>Back Home</span>
            </Link>
          </div>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
