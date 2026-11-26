'use client';

import React, { useEffect, useState } from 'react';
import { Link } from '../../router/RouterContext';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase/client';
import { Banner } from '../../components/Banner';
import { Loader2, CheckCircle2, Clock } from 'lucide-react';

type JoinResult = { status: 'joined' | 'requested'; society_name: string; flat: string | null };
/** Where this person stands with the society before they fill anything in */
type JoinStatus = { status: 'member' | 'pending' | 'rejected' | 'none'; society_name: string; note?: string | null };

const inputClass = 'w-full bg-surface border border-border-strong rounded-lg px-3 py-2.5 text-fg outline-none focus:border-brand';

/** /join/<code>: the society's one joining link (031). */
export const JoinPage: React.FC<{ code: string }> = ({ code }) => {
  const { user, isAuthenticated, isLoading, refreshUserData, getRedirectPath } = useAuth();
  const [form, setForm] = useState({
    name: (user?.user_metadata?.full_name as string | undefined) ?? '',
    mobile: user?.phone ?? '',
    flat: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JoinResult | null>(null);
  const [status, setStatus] = useState<JoinStatus | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [askAgain, setAskAgain] = useState(false);
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

  useEffect(() => {
    // after the account has loaded (a mobile login has claimed its flats by then)
    if (!supabase || !isAuthenticated || isLoading) return;
    supabase.rpc('join_status', { p_code: code }).then(({ data, error: err }) => {
      if (err) setLinkError(err.message);
      else setStatus(data as JoinStatus);
    });
  }, [code, isAuthenticated, isLoading]);

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
    <div className="bg-canvas min-h-screen flex items-center justify-center p-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <Link href="/" className="inline-flex items-center gap-2">
            <div className="w-10 h-10 rounded-xl bg-brand flex items-center justify-center text-on-brand font-semibold text-lg">S</div>
            <span className="font-semibold text-2xl text-fg tracking-tight">Sahvaas</span>
          </Link>
          <h1 className="text-xl font-semibold text-fg mt-2">Join your society</h1>
        </div>

        <div className="bg-surface border border-border rounded-2xl p-6 sm:p-8 text-xs space-y-4">
          {isLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-brand" /></div>
          ) : result?.status === 'joined' ? (
            <div className="space-y-3 text-center">
              <CheckCircle2 className="w-10 h-10 text-success mx-auto" />
              <p className="text-fg text-sm">You have joined {result.society_name} — Flat {result.flat}.</p>
              <Link href="/resident" className="inline-block px-4 py-2.5 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold">Go to my flat</Link>
            </div>
          ) : result?.status === 'requested' ? (
            <div className="space-y-3 text-center">
              <Clock className="w-10 h-10 text-warning mx-auto" />
              <p className="text-fg text-sm">
                Your request has gone to the {result.society_name} committee. You will get a notification when they approve it.
              </p>
            </div>
          ) : linkError ? (
            <Banner tone="error">{linkError}</Banner>
          ) : status?.status === 'member' ? (
            <div className="space-y-3 text-center">
              <CheckCircle2 className="w-10 h-10 text-success mx-auto" />
              <p className="text-fg text-sm">You are already a member of {status.society_name}.</p>
              <Link href={getRedirectPath()} className="inline-block px-4 py-2.5 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold">Open Sahvaas</Link>
            </div>
          ) : status?.status === 'pending' ? (
            <div className="space-y-3 text-center">
              <Clock className="w-10 h-10 text-warning mx-auto" />
              <p className="text-fg text-sm">
                Your request has gone to the {status.society_name} committee. You will get a notification when they approve it.
              </p>
            </div>
          ) : status?.status === 'rejected' && !askAgain ? (
            <div className="space-y-3 text-center">
              <p className="text-fg text-sm">The {status.society_name} committee did not approve your request.</p>
              {status.note && <p className="text-fg">Reason: {status.note}</p>}
              <button onClick={() => setAskAgain(true)} className="px-4 py-2.5 rounded-lg bg-surface-muted hover:bg-border text-fg font-semibold cursor-pointer">
                Ask again
              </button>
            </div>
          ) : !isAuthenticated ? (
            <div className="space-y-3 text-center">
              <p className="text-fg">Your society&apos;s committee shared this link. Log in, or create an account, to join.</p>
              <Link href={`/login?returnUrl=${back}`} className="block w-full py-2.5 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold">Log in to join</Link>
              <Link href={`/signup?returnUrl=${back}`} className="block text-brand hover:underline">New here? Create an account</Link>
            </div>
          ) : (
            <form onSubmit={join} className="space-y-3">
              <Banner tone="error">{error}</Banner>
              <label className="block space-y-1">
                <span className="text-fg-muted">Your name</span>
                <input className={inputClass} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
              </label>
              <label className="block space-y-1">
                <span className="text-fg-muted">Your mobile</span>
                <input className={inputClass} inputMode="tel" value={form.mobile} onChange={e => setForm(f => ({ ...f, mobile: e.target.value }))} />
              </label>
              <label className="block space-y-1">
                <span className="text-fg-muted">Your flat (e.g. A-101)</span>
                <input className={inputClass} value={form.flat} onChange={e => setForm(f => ({ ...f, flat: e.target.value }))} />
              </label>
              <button type="submit" disabled={busy} className="w-full py-2.5 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
                {busy && <Loader2 className="w-4 h-4 animate-spin" />} Join
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
