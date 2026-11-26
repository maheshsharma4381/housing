import React from 'react';
import { cn } from './cn';

/** One look for inputs and selects: 40px, strong border, brand focus ring; 16px text on phones (no iOS zoom). */
export const fieldClass = cn(
  'w-full h-10 rounded-lg border border-border-strong bg-surface px-3 text-base sm:text-sm text-fg',
  'outline-none transition duration-150 focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:bg-surface-muted disabled:text-fg-subtle',
);

/** Label above the control, optional tag, hint and error under it. The control goes inside as children. */
export const Field: React.FC<{
  label: string;
  optional?: boolean;
  hint?: string;
  error?: string | null;
  className?: string;
  children: React.ReactNode;
}> = ({ label, optional, hint, error, className, children }) => (
  <label className={cn('block space-y-1.5', className)}>
    <span className="block text-xs font-medium text-fg-muted">
      {label}{optional && <span className="font-normal text-fg-subtle"> (optional)</span>}
    </span>
    {children}
    {error ? <span className="block text-xs text-danger">{error}</span> : hint ? <span className="block text-xs text-fg-subtle">{hint}</span> : null}
  </label>
);
