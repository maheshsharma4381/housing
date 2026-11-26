import React from 'react';
import { LucideIcon, Inbox } from 'lucide-react';
import { Button } from './ui/Button';
import { cn } from './ui/cn';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description: string;
  actionText?: string;
  onAction?: () => void;
  /** inside a Card: no box of its own */
  bare?: boolean;
}

/** Why it is empty, and the next step (brief section 6). */
export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon = Inbox,
  title,
  description,
  actionText,
  onAction,
  bare = false,
}) => {
  return (
    <div className={cn('px-6 py-10 text-center flex flex-col items-center', !bare && 'rounded-xl bg-surface border border-border shadow-card max-w-md mx-auto my-6')}>
      <div className="w-12 h-12 rounded-full bg-surface-muted text-fg-muted flex items-center justify-center mb-3">
        <Icon className="w-[22px] h-[22px]" aria-hidden="true" />
      </div>
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      <p className="mt-1 text-sm text-fg-muted leading-relaxed max-w-sm">{description}</p>
      {actionText && onAction && (
        <Button className="mt-4" onClick={onAction}>{actionText}</Button>
      )}
    </div>
  );
};
