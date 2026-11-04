'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { useAuth } from '../context/AuthContext';
import { toE164, resendWait } from '../lib/phone-login';
import { Banner } from './Banner';
import { Loader2, MessageCircle, ArrowRight, Smartphone } from 'lucide-react';

const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-white outline-none focus:border-sky-500 text-sm';

/**
 * Log in with a mobile number and a one-time code (3C). Supabase sends the code through our Send SMS hook
 * (WhatsApp first, SMS backup). A new number gets an account; AuthContext loads it on SIGNED_IN.
 */
export const MobileOtpLogin: React.FC<{ onSignedIn?: (redirectPath: string) => void }> = ({ onSignedIn }) => {
  const { verifyOtp } = useAuth();
  const [mobile, setMobile] = useState('');
  const [phone, setPhone] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sentAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [sentAt]);

  const wait = resendWait(sentAt, now);

  const send = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!supabase) return;
    const e164 = toE164(mobile);
    if (!e164) return setError('Enter a valid mobile number');
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({ phone: e164 });
    setBusy(false);
    if (err) return setError(err.message);
    setPhone(e164);
    setSentAt(Date.now());
    setNow(Date.now());
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || !phone) return;
    setBusy(true);
    setError(null);
    const { error: err, redirectPath } = await verifyOtp(phone, code.trim());
    setBusy(false);
    if (err) return setError(err.message.toLowerCase().includes('expired') || err.message.toLowerCase().includes('invalid')
      ? 'That code is wrong or has expired — check it or ask for a new one'
      : err.message);
    onSignedIn?.(redirectPath ?? '/');
  };

  if (!phone) {
    return (
      <form onSubmit={send} className="space-y-4">
        <Banner tone="error">{error}</Banner>
        <label className="block space-y-1.5">
          <span className="text-slate-300 font-medium flex items-center gap-1.5"><Smartphone className="w-3.5 h-3.5" /> Your mobile number</span>
          <input className={inputClass} inputMode="tel" autoComplete="tel" placeholder="98765 43210" value={mobile} onChange={e => setMobile(e.target.value)} required />
        </label>
        <button type="submit" disabled={busy} className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageCircle className="w-4 h-4" />}
          <span>Send code on WhatsApp</span>
        </button>
        <p className="text-slate-500 text-center">Numbers outside India: type the country code, e.g. +65. They get the code on WhatsApp only.</p>
        <p className="text-slate-500 text-center">Already use Sahvaas with email? Log in with email first and add your mobile, so you keep one account.</p>
      </form>
    );
  }

  return (
    <form onSubmit={verify} className="space-y-4">
      <Banner tone="error">{error}</Banner>
      <p className="text-slate-300">We sent a code to <strong className="text-white">{phone}</strong>.</p>
      <label className="block space-y-1.5">
        <span className="text-slate-300 font-medium">Enter the 6-digit code</span>
        <input
          className={`${inputClass} tracking-[0.4em] text-center font-mono`}
          inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, ''))} required autoFocus
        />
      </label>
      <button type="submit" disabled={busy || code.length < 6} className="w-full py-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
        <span>Log in</span>
      </button>
      <div className="flex justify-between">
        <button type="button" onClick={() => { setPhone(null); setCode(''); setError(null); }} className="text-slate-400 hover:text-white cursor-pointer">Change number</button>
        <button type="button" onClick={() => send()} disabled={wait > 0 || busy} className="text-sky-400 hover:underline cursor-pointer disabled:text-slate-500 disabled:no-underline">
          {wait > 0 ? `Resend code in ${wait}s` : 'Resend code'}
        </button>
      </div>
    </form>
  );
};
