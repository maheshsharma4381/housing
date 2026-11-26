import React from 'react';
import { cn } from './cn';

/** The Sahvaas mark: a roof over a home on the brand blue. */
export const LogoMark: React.FC<{ size?: number; className?: string }> = ({ size = 28, className }) => (
  <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" className={cn('shrink-0', className)}>
    <rect width="512" height="512" rx="112" fill="#2563EB" />
    <path d="M128 266 256 150l128 116M174 238v124h164V238" fill="none" stroke="#FFFFFF" strokeWidth="36" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Mark + "Sahvaas" wordmark. */
export const Logo: React.FC<{ size?: number; className?: string }> = ({ size = 28, className }) => (
  <span className={cn('inline-flex items-center gap-2.5', className)}>
    <LogoMark size={size} />
    <span className="text-[17px] font-semibold tracking-tight text-fg">Sahvaas</span>
  </span>
);
