import React from 'react';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';

const TONES = {
  error: { Icon: AlertCircle, cls: 'bg-danger-soft border-danger/20 text-danger', role: 'alert' },
  success: { Icon: CheckCircle2, cls: 'bg-success-soft border-success/20 text-success', role: 'status' },
  info: { Icon: Info, cls: 'bg-info-soft border-info/20 text-info', role: 'status' },
} as const;

/** Inline status message used by dashboard forms. Renders nothing when `children` is empty. */
export const Banner: React.FC<{ tone: keyof typeof TONES; children?: React.ReactNode }> = ({ tone, children }) => {
  if (!children) return null;
  const { Icon, cls, role } = TONES[tone];
  return (
    <div role={role} className={`p-3 rounded-xl border text-[13px] leading-5 flex items-start gap-2 ${cls}`}>
      <Icon className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
};
