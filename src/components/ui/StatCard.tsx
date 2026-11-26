import React from 'react';
import { cn } from './cn';

/** A KPI: label, big value, a line under it; clickable when onClick is given. */
export const StatCard: React.FC<{
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  onClick?: () => void;
  className?: string;
}> = ({ label, value, sub, tone = 'default', onClick, className }) => {
  const valueTone = tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : 'text-fg';
  const body = (
    <>
      <span className="text-[13px] text-fg-muted">{label}</span>
      <span className={cn('text-2xl sm:text-[28px] leading-9 font-semibold tracking-tight tabular-nums', valueTone)}>{value}</span>
      {sub && <span className="text-[13px] text-fg-subtle">{sub}</span>}
    </>
  );
  const cls = cn('flex flex-col gap-1 p-4 sm:p-5 text-left bg-surface border border-border rounded-xl shadow-card', className);
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(cls, 'cursor-pointer transition duration-150 hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand')}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
};
