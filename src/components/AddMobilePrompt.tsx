'use client';

import React, { useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase/client';
import { toE164, PHONE_LOGIN_ON } from '../lib/phone-login';
import { Loader2, X } from 'lucide-react';

const APP_PATHS = ['/society', '/resident', '/professional', '/platform'];
const DISMISSED = 'sahvaas.addMobile.dismissed';

/**
 * An account made with email adds its mobile once (3C), so a mobile login reaches the same account
 * instead of making an empty one. Supabase sends the code to the new number (phone_change).
 */
export const AddMobilePrompt: React.FC = () => {
  const { user, refreshUserData } = useAuth();
  const pathname = usePathname() ?? '';
  const [hidden, setHidden] = useState(() => typeof window !== 'undefined' && window.localStorage.getItem(DISMISSED) === '1');
  const [mobile, setMobile] = useState('');
  const [phone, setPhone] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!PHONE_LOGIN_ON || hidden || !user?.email || user.phone || !supabase || !APP_PATHS.some(p => pathname.startsWith(p))) return null;

  const dismiss = () => {
    window.localStorage.setItem(DISMISSED, '1');
    setHidden(true);
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const e164 = toE164(mobile);
    if (!e164 || !supabase) return setError('Enter a valid mobile number');
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.updateUser({ phone: e164 });
    setBusy(false);
    if (err) return setError(err.message);
    setPhone(e164);
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || !phone) return;
    setBusy(true);
    const { error: err } = await supabase.auth.verifyOtp({ phone, token: code.trim(), type: 'phone_change' });
    setBusy(false);
    if (err) return setError('That code is wrong or has expired — check it or ask for a new one');
    await refreshUserData();
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 p-3 sm:p-4">
      <form onSubmit={phone ? verify : send} className="max-w-md mx-auto p-4 rounded-2xl bg-slate-900 border border-emerald-500/40 shadow-2xl space-y-2 text-xs">
        <div className="flex items-start justify-between gap-2">
          <div className="font-bold text-white text-sm">Add your mobile number</div>
          <button type="button" onClick={dismiss} aria-label="Not now" className="text-slate-500 hover:text-white cursor-pointer"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-slate-400">Then you can log in with a code on WhatsApp, and your society can reach you.</p>
        {error && <p className="text-rose-300">{error}</p>}
        <div className="flex gap-2">
          {phone ? (
            <input autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="6-digit code" className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-emerald-500 font-mono tracking-widest" />
          ) : (
            <input inputMode="tel" value={mobile} onChange={e => setMobile(e.target.value)} placeholder="98765 43210"
              className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-emerald-500" />
          )}
          <button type="submit" disabled={busy} className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold cursor-pointer disabled:opacity-50 flex items-center gap-1.5">
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} {phone ? 'Confirm' : 'Send code'}
          </button>
        </div>
      </form>
    </div>
  );
};
