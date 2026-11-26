import React from 'react';
import { cn } from './cn';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';

const TONES: Record<BadgeTone, { cls: string; dot: string }> = {
  neutral: { cls: 'bg-surface-muted text-fg-muted', dot: 'bg-fg-subtle' },
  success: { cls: 'bg-success-soft text-success', dot: 'bg-success-solid' },
  warning: { cls: 'bg-warning-soft text-warning', dot: 'bg-warning-solid' },
  danger: { cls: 'bg-danger-soft text-danger', dot: 'bg-danger-solid' },
  info: { cls: 'bg-info-soft text-info', dot: 'bg-info' },
  brand: { cls: 'bg-brand-soft text-brand-ink', dot: 'bg-brand' },
};

/** Small label with a tone; optional dot. */
export const Badge: React.FC<{ tone?: BadgeTone; dot?: boolean; className?: string; children: React.ReactNode }> = ({ tone = 'neutral', dot, className, children }) => (
  <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-xs font-medium whitespace-nowrap', TONES[tone].cls, className)}>
    {dot && <span className={cn('w-1.5 h-1.5 rounded-full', TONES[tone].dot)} aria-hidden="true" />}
    {children}
  </span>
);

const STATUS_TONES: Record<string, BadgeTone> = {
  paid: 'success', verified: 'success', approved: 'success', active: 'success', resolved: 'success', collected: 'success',
  pending: 'warning', submitted: 'warning', partially_paid: 'warning', partial: 'warning', due: 'warning', due_soon: 'warning',
  in_review: 'warning', in_progress: 'warning', trial: 'warning', pending_approval: 'warning', unpaid: 'warning',
  overdue: 'danger', rejected: 'danger', failed: 'danger', past_due: 'danger', suspended: 'danger',
  draft: 'neutral', cancelled: 'neutral', closed: 'neutral', inactive: 'neutral', void: 'neutral',
  open: 'info', new: 'info', info: 'info',
};

/** The tone for a status word, from the one mapping used everywhere (brief section 5). */
export function statusTone(status: string): BadgeTone {
  return STATUS_TONES[status.toLowerCase().replace(/[\s-]+/g, '_')] ?? 'neutral';
}

/** A status with its tone and text; never colour alone. */
export const StatusBadge: React.FC<{ status: string; label?: string; className?: string }> = ({ status, label, className }) => {
  const text = label ?? status.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
  return <Badge tone={statusTone(status)} dot className={className}>{text}</Badge>;
};
