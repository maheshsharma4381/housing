import React from 'react';
import { CheckCircle2 } from 'lucide-react';

/** Sign-in pages: the form on the left, a short brand panel on the right from laptop width (brief section 9). */
export const AuthLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="min-h-screen grid lg:grid-cols-2 bg-canvas">
    {children}
    <aside className="hidden lg:flex flex-col justify-center gap-8 bg-brand text-on-brand px-14 xl:px-20">
      <div className="space-y-3 max-w-md">
        <h2 className="text-3xl font-semibold tracking-tight leading-tight">Your society’s bills, payments and notices in one place</h2>
        <p className="text-on-brand/80 leading-relaxed">The committee, every flat and your CA, each seeing only what is theirs.</p>
      </div>
      <ul className="space-y-3 max-w-md">
        {['Bills for every flat in three steps', 'Residents pay by UPI in one tap', 'Books and reports your CA can trust'].map(t => (
          <li key={t} className="flex items-center gap-3"><CheckCircle2 className="w-5 h-5 shrink-0" aria-hidden="true" />{t}</li>
        ))}
      </ul>
    </aside>
  </div>
);
