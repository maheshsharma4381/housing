'use client';

import React, { useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase/client';
import { Loader2 } from 'lucide-react';

const APP_PATHS = ['/society', '/resident', '/onboarding', '/professional', '/platform'];

/** A mobile login starts as "Member" (032): ask once for the name the committee and receipts will show. */
export const NamePrompt: React.FC = () => {
  const { user, profile, refreshUserData } = useAuth();
  const pathname = usePathname() ?? '';
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user || !supabase || profile?.full_name !== 'Member' || !APP_PATHS.some(p => pathname.startsWith(p))) return null;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || name.trim().length < 2) return setError('Enter your name');
    setBusy(true);
    const { error: err } = await supabase.from('profiles').update({ full_name: name.trim() }).eq('id', user.id);
    setBusy(false);
    if (err) return setError(err.message);
    await refreshUserData();
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 p-3 sm:p-4">
      <form onSubmit={save} className="max-w-md mx-auto p-4 rounded-2xl bg-slate-900 border border-sky-500/40 shadow-2xl space-y-2 text-xs">
        <div className="font-bold text-white text-sm">What is your name?</div>
        <p className="text-slate-400">Your committee sees it on bills, receipts and requests.</p>
        {error && <p className="text-rose-300">{error}</p>}
        <div className="flex gap-2">
          <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Your full name"
            className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500" />
          <button type="submit" disabled={busy} className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer disabled:opacity-50 flex items-center gap-1.5">
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save
          </button>
        </div>
      </form>
    </div>
  );
};
