import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-on-brand hover:bg-brand-hover shadow-card',
  secondary: 'bg-surface text-fg border border-border-strong hover:bg-surface-muted shadow-card',
  ghost: 'text-fg-muted hover:bg-surface-muted hover:text-fg',
  danger: 'bg-danger-solid text-on-brand hover:bg-danger shadow-card',
  link: 'text-brand hover:text-brand-hover underline-offset-4 hover:underline px-0',
};
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-[13px] gap-1.5',
  md: 'h-10 px-4 text-sm gap-2 [@media(pointer:coarse)]:h-11',
  lg: 'h-12 px-5 text-[15px] gap-2',
};

/** Class names for a button look, for links and labels that act as buttons. */
export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', className?: string): string {
  return cn(
    'inline-flex items-center justify-center rounded-lg font-semibold whitespace-nowrap transition duration-150 ease-out cursor-pointer',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50 disabled:cursor-not-allowed',
    VARIANTS[variant],
    variant === 'link' ? 'h-auto' : SIZES[size],
    className,
  );
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** shows a spinner, disables the button and keeps its width */
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

/** Primary, secondary, ghost, danger or link button (brief section 6). */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, leftIcon, rightIcon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={buttonClass(variant, size, className)} {...rest}>
      {loading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
});

/** Icon-only button; the label is read out and shown as a tooltip. */
export const IconButton = React.forwardRef<HTMLButtonElement, Omit<ButtonProps, 'leftIcon' | 'rightIcon'> & { label: string }>(function IconButton(
  { label, variant = 'secondary', className, children, ...rest },
  ref,
) {
  return (
    <Button ref={ref} variant={variant} aria-label={label} title={label} className={cn('w-10 px-0 [@media(pointer:coarse)]:w-11', className)} {...rest}>
      {children}
    </Button>
  );
});
