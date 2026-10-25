'use client';

import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter, Link } from '../../router/RouterContext';
import { useAuth } from '../../context/AuthContext';
import { safeInternalPath } from '../../lib/safe-redirect';
import { 
  KeyRound, 
  Mail, 
  Lock, 
  ArrowRight, 
  AlertCircle, 
  Loader2, 
  ShieldCheck, 
  Building2 
} from 'lucide-react';

export const LoginPage: React.FC = () => {
  const { 
    login, 
    isLoading, 
    authError, 
    clearAuthError, 
    isAuthenticated, 
    getRedirectPath,
    isSupabaseConfigured 
  } = useAuth();
  const { navigate } = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Parse returnUrl from query params if present
  const returnUrl = safeInternalPath(searchParams.get('returnUrl'));

  useEffect(() => {
    if (isAuthenticated) {
      const destination = returnUrl || getRedirectPath();
      navigate(destination, { replace: true });
    }
  }, [isAuthenticated, navigate, returnUrl, getRedirectPath]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearAuthError();
    setSubmitting(true);

    const { error, redirectPath } = await login(email, password);
    setSubmitting(false);

    if (!error && redirectPath) {
      const target = returnUrl || redirectPath;
      navigate(target, { replace: true });
    }
  };

  return (
    <div className="bg-slate-950 min-h-screen flex items-center justify-center p-4 py-12">
      <div className="w-full max-w-md space-y-6">
        {/* Brand header */}
        <div className="text-center space-y-2">
          <Link href="/" className="inline-flex items-center gap-2 group">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-sky-500 to-sky-700 flex items-center justify-center text-white font-black text-lg shadow-lg shadow-sky-600/30 group-hover:scale-105 transition">
              S
            </div>
            <span className="font-bold text-2xl text-white tracking-tight">Sahvaas</span>
          </Link>
          <h1 className="text-xl font-bold text-white mt-2">Sign In to Your Workspace</h1>
          <p className="text-xs text-slate-400">
            Authenticated via Supabase Auth • Strict PostgreSQL Row Level Security
          </p>
        </div>

        {/* Supabase unconfigured warning banner */}
        {!isSupabaseConfigured && (
          <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs space-y-1">
            <div className="font-bold flex items-center gap-1.5">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
              <span>Supabase Connection Key Required</span>
            </div>
            <p className="text-slate-300 leading-relaxed text-[11px]">
              Set <code className="bg-slate-900 px-1 py-0.5 rounded text-amber-300">NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
              <code className="bg-slate-900 px-1 py-0.5 rounded text-amber-300">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in your environment to authenticate live accounts.
            </p>
          </div>
        )}

        {/* Login Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-2xl text-xs space-y-5">
          {authError && (
            <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-white">Authentication Failed</span>
                <p className="mt-0.5 text-rose-300">{authError}</p>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-slate-400 mb-1.5 font-medium">Official Email Address</label>
              <div className="relative">
                <Mail className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
                <input
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="name@society.in"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 focus:border-sky-500 rounded-xl pl-9 pr-3 py-2.5 text-white outline-none transition"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-slate-400 font-medium">Password</label>
                <Link
                  href="/forgot-password"
                  className="text-[11px] text-sky-400 hover:text-sky-300 transition"
                >
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <Lock className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  placeholder="••••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 focus:border-sky-500 rounded-xl pl-9 pr-3 py-2.5 text-white outline-none transition"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting || isLoading}
              className="w-full mt-2 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-sky-600/30 transition cursor-pointer disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Verifying Credentials...</span>
                </>
              ) : (
                <>
                  <span>Sign In</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          {/* Info note */}
          <div className="pt-4 border-t border-slate-800 text-[11px] text-slate-400 text-center space-y-1">
            <p>
              Your role (Secretary, Treasurer, Resident, CA) is determined by verified server-side memberships after sign-in.
            </p>
          </div>
        </div>

        <div className="text-center text-xs text-slate-500">
          New to Sahvaas?{' '}
          <Link href="/signup" className="text-sky-400 hover:underline">
            Create an account
          </Link>
        </div>

        <div className="text-center text-xs text-slate-500">
          Need assistance?{' '}
          <Link href="/contact" className="text-sky-400 hover:underline">
            Contact Support
          </Link>
        </div>
      </div>
    </div>
  );
};
