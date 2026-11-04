'use client';

import React, { useEffect, useState } from 'react';
import { Link } from '../../router/RouterContext';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase/client';
import { Banner } from '../../components/Banner';
import { Loader2, CheckCircle2, Clock } from 'lucide-react';

type JoinResult = { status: 'joined' | 'requested'; society_name: string; flat: string | null };

const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-white outline-none focus:border-sky-500';

/** /join/<code>: the society's one joining link (031). */
export const JoinPage: React.FC<{ code: string }> = ({ code }) => {
  const { user, isAuthenticated, isLoading, refreshUserData } = useAuth();
  const [form, setForm] = useState({
    name: (user?.user_metadata?.full_name as string | undefined) ?? '',
    mobile: user?.phone ?? '',
    flat: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JoinResult | null>(null);
  const back = encodeURIComponent(`/join/${code}`);

  // The login finishes after the first render: fill in what the account already knows
  useEffect(() => {
    if (!user) return;
    setForm(f => ({
      ...f,
      name: f.name || ((user.user_metadata?.full_name as string | undefined) ?? ''),
      mobile: f.mobile || (user.phone ?? ''),
    }));
  }, [user]);

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase.rpc('join_society', {
      p_code: code, p_name: form.name, p_mobile: form.mobile || null, p_flat_hint: form.flat || null,
    });
    setBusy(false);
    if (err) return setError(err.message);
    const r = data as JoinResult;
    setResult(r);
    // A new membership: reload so the resident portal opens
    if (r.status === 'joined') await refreshUserData();
  };

  return (
    <div className="bg-slate-950 min-h-screen flex items-center justify-center p-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <Link href="/" className="inline-flex items-center gap-2">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-sky-500 to-sky-700 flex items-center justify-center text-white font-black text-lg">S</div>
            <span className="font-bold text-2xl text-white tracking-tight">Sahvaas</span>
          </Link>
          <h1 className="text-xl font-bold text-white mt-2">Join your society</h1>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 text-xs space-y-4">
          {isLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-sky-400" /></div>
          ) : result?.status === 'joined' ? (
            <div className="space-y-3 text-center">
              <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto" />
              <p className="text-white text-sm">You have joined {result.society_name} — Flat {result.flat}.</p>
              <Link href="/resident" className="inline-block px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold">Go to my flat</Link>
            </div>
          ) : result?.status === 'requested' ? (
            <div className="space-y-3 text-center">
              <Clock className="w-10 h-10 text-amber-400 mx-auto" />
              <p className="text-white text-sm">
                Your request has gone to the {result.society_name} committee. You will get a notification when they approve it.
              </p>
            </div>
          ) : !isAuthenticated ? (
            <div className="space-y-3 text-center">
              <p className="text-slate-300">Your society&apos;s committee shared this link. Log in, or create an account, to join.</p>
              <Link href={`/login?returnUrl=${back}`} className="block w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold">Log in to join</Link>
              <Link href={`/signup?returnUrl=${back}`} className="block text-sky-400 hover:underline">New here? Create an account</Link>
            </div>
          ) : (
            <form onSubmit={join} className="space-y-3">
              <Banner tone="error">{error}</Banner>
              <label className="block space-y-1">
                <span className="text-slate-400">Your name</span>
                <input className={inputClass} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
              </label>
              <label className="block space-y-1">
                <span className="text-slate-400">Your mobile</span>
                <input className={inputClass} inputMode="tel" value={form.mobile} onChange={e => setForm(f => ({ ...f, mobile: e.target.value }))} />
              </label>
              <label className="block space-y-1">
                <span className="text-slate-400">Your flat (e.g. A-101)</span>
                <input className={inputClass} value={form.flat} onChange={e => setForm(f => ({ ...f, flat: e.target.value }))} />
              </label>
              <button type="submit" disabled={busy} className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
                {busy && <Loader2 className="w-4 h-4 animate-spin" />} Join
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
