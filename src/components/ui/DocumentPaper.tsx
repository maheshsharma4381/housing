import React from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Button } from './Button';
import { cn } from './cn';

/*
 * Printable documents (bill, receipt): a screen toolbar, then white A4 paper with a letterhead
 * (brief section 8.7). Paper uses fixed Tailwind slate colours so it prints the same whatever theme the app is in.
 */

/** Page around the paper: back button and actions on screen, nothing but the paper in print. */
export const DocumentPage: React.FC<{ actions?: React.ReactNode; children: React.ReactNode }> = ({ actions, children }) => (
  <div className="min-h-screen bg-canvas print:bg-white py-6 sm:py-10 px-3 sm:px-4 print:p-0">
    <div className="max-w-[820px] mx-auto space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Button variant="ghost" size="sm" onClick={() => window.history.back()} leftIcon={<ArrowLeft className="w-4 h-4" />}>Back</Button>
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      </div>
      {children}
    </div>
  </div>
);

/** Loading and error states for a document, in the same frame. */
export const DocumentState: React.FC<{ loading?: string; error?: string | null; onBack?: () => void; children?: React.ReactNode }> = ({ loading, error, onBack, children }) => (
  <div className="min-h-screen bg-canvas flex items-center justify-center p-4">
    <div className="max-w-sm w-full p-6 rounded-xl bg-surface border border-border shadow-card text-center text-sm text-fg-muted space-y-3">
      {loading && <div className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin text-brand" aria-hidden="true" /> {loading}</div>}
      {error && <p className="text-fg">{error}</p>}
      {children}
      {onBack && <Button variant="link" onClick={onBack}>Go back</Button>}
    </div>
  </div>
);

/** White A4 sheet. */
export const Paper: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <article className={cn(
    'bg-white text-slate-900 rounded-xl border border-slate-200 shadow-[0_12px_24px_-6px_rgba(16,24,40,.12)]',
    'p-6 sm:p-10 space-y-7 text-[13px] leading-5 tabular-nums',
    'print:rounded-none print:border-0 print:shadow-none print:p-0',
    className,
  )}>
    {children}
  </article>
);

/** Society name, registration and address on the left; the document's title and number on the right. */
export const Letterhead: React.FC<{
  society: string; registration?: string | null; address?: string | null;
  title: string; number: string; date?: string; titleTone?: 'default' | 'danger';
}> = ({ society, registration, address, title, number, date, titleTone = 'default' }) => (
  <header className="flex flex-col sm:flex-row sm:items-start justify-between gap-5 pb-6 border-b-2 border-slate-900">
    <div className="space-y-1 min-w-0">
      <h1 className="text-xl font-semibold tracking-tight text-slate-900">{society}</h1>
      {registration && <div className="text-xs text-slate-500">Reg. No. {registration}</div>}
      {address && <div className="text-xs text-slate-500 max-w-sm">{address}</div>}
    </div>
    <div className="sm:text-right shrink-0">
      <div className={cn('text-xs font-semibold tracking-[0.12em]', titleTone === 'danger' ? 'text-rose-600' : 'text-slate-500')}>{title}</div>
      <div className="mt-1 text-lg font-semibold font-mono text-slate-900">{number}</div>
      {date && <div className="text-xs text-slate-500">{date}</div>}
    </div>
  </header>
);

/** Label / value pairs in two columns. */
export const DocFacts: React.FC<{ rows: [string, React.ReactNode][] }> = ({ rows }) => (
  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-2.5">
    {rows.map(([label, value]) => (
      <div key={label} className="flex justify-between gap-4 border-b border-slate-100 pb-2">
        <dt className="text-slate-500">{label}</dt>
        <dd className="font-medium text-slate-900 text-right">{value}</dd>
      </div>
    ))}
  </dl>
);
