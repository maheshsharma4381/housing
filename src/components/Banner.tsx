import React from 'react';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';

const TONES = {
  error: { Icon: AlertCircle, cls: 'bg-rose-500/10 border-rose-500/30 text-rose-300' },
  success: { Icon: CheckCircle2, cls: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' },
  info: { Icon: Info, cls: 'bg-sky-500/10 border-sky-500/30 text-sky-200' },
};

/** Inline status message used by dashboard forms. Renders nothing when `children` is empty. */
export const Banner: React.FC<{ tone: keyof typeof TONES; children?: React.ReactNode }> = ({ tone, children }) => {
  if (!children) return null;
  const { Icon, cls } = TONES[tone];
  return (
    <div className={`p-3 rounded-xl border text-xs flex items-start gap-2 ${cls}`}>
      <Icon className="w-4 h-4 shrink-0 mt-0.5" />
      <span>{children}</span>
    </div>
  );
};
