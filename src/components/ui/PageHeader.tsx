import React from 'react';
import { cn } from './cn';

/** Page title, a short description, and the page's actions (primary last). */
export const PageHeader: React.FC<{ title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string }> = ({
  title, description, actions, className,
}) => (
  <div className={cn('flex flex-wrap items-end justify-between gap-4', className)}>
    <div className="min-w-0">
      <h1 className="text-2xl leading-8 font-semibold tracking-tight text-fg">{title}</h1>
      {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
);
