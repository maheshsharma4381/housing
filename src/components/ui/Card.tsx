import React from 'react';
import { cn } from './cn';

/** White surface with a thin border and a soft shadow. */
export const Card: React.FC<React.HTMLAttributes<HTMLElement> & { as?: 'section' | 'div' | 'article' }> = ({ as: Tag = 'section', className, ...rest }) => (
  <Tag className={cn('bg-surface border border-border rounded-xl shadow-card', className)} {...rest} />
);

/** Card title row: title, optional description, actions on the right. */
export const CardHeader: React.FC<{ title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string }> = ({
  title, description, actions, className,
}) => (
  <div className={cn('flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5 py-4 border-b border-border', className)}>
    <div className="min-w-0">
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      {description && <p className="text-[13px] text-fg-muted mt-0.5">{description}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
);

export const CardBody: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...rest }) => (
  <div className={cn('p-4 sm:p-5', className)} {...rest} />
);

export const CardFooter: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...rest }) => (
  <div className={cn('flex flex-wrap justify-end gap-2 px-4 sm:px-5 py-4 border-t border-border', className)} {...rest} />
);
