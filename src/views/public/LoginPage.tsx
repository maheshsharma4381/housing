'use client';

import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter, Link } from '../../router/RouterContext';
import { useAuth } from '../../context/AuthContext';
import { safeInternalPath } from '../../lib/safe-redirect';
import { MobileOtpLogin } from '../../components/MobileOtpLogin';

// Mobile + WhatsApp code login (3C) once the Send SMS hook is set up; email stays as the fallback
const PHONE_LOGIN = process.env.NEXT_PUBLIC_PHONE_LOGIN === '1';
import { Mail, Lock, ArrowRight, AlertCircle, Loader2 } from 'lucide-react';
import { Logo } from '../../components/ui/Logo';
import { AuthLayout } from '../../components/ui/AuthLayout';

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
  const [useEmail, setUseEmail] = useState(!PHONE_LOGIN);

  // Parse returnUrl from query params if present
  const returnUrl = safeInternalPath(searchParams.get('returnUrl'));

  useEffect(() => {
    // Wait until the account has loaded, or a fresh login is sent to "Register your society"
    if (isAuthenticated && !isLoading) {
      const destination = returnUrl || getRedirectPath();
      navigate(destination, { replace: true });
    }
  }, [isAuthenticated, isLoading, navigate, returnUrl, getRedirectPath]);

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
    <AuthLayout>
    <div className="min-h-screen lg:min-h-0 flex items-center justify-center p-4 py-12">
      <div className="w-full max-w-md space-y-6">
        {/* Brand header */}
        <div className="text-center space-y-2">
          <Link href="/" className="inline-flex items-center gap-2 group">
            <Logo size={32} />
          </Link>
          <h1 className="text-xl font-semibold text-fg mt-2">Sign in</h1>
          <p className="text-xs text-fg-muted">
            Welcome back. Sign in to your society.
          </p>
        </div>

        {/* Supabase unconfigured warning banner */}
        {!isSupabaseConfigured && (
          <div className="p-4 rounded-xl bg-warning-soft border border-warning/30 text-warning text-xs space-y-1">
            <div className="font-semibold flex items-center gap-1.5">
              <AlertCircle className="w-4 h-4 text-warning shrink-0" />
              <span>Supabase Connection Key Required</span>
            </div>
            <p className="text-fg leading-relaxed text-xs">
              Set <code className="bg-surface px-1 py-0.5 rounded text-warning">NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
              <code className="bg-surface px-1 py-0.5 rounded text-warning">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in your environment to authenticate live accounts.
            </p>
          </div>
        )}

        {/* Login Card */}
        <div className="bg-surface border border-border rounded-2xl p-6 sm:p-8 shadow-card text-xs space-y-5">
          {authError && (
            <div className="p-3.5 rounded-xl bg-danger-soft border border-danger/30 text-danger text-xs flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-fg">Authentication Failed</span>
                <p className="mt-0.5 text-danger">{authError}</p>
              </div>
            </div>
          )}

          {!useEmail ? (
            <div className="space-y-4">
              <MobileOtpLogin onSignedIn={(path) => navigate(returnUrl || path, { replace: true })} />
              <button type="button" onClick={() => setUseEmail(true)} className="w-full text-center text-fg-muted hover:text-fg cursor-pointer">
                Use email instead
              </button>
            </div>
          ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-fg-muted mb-1.5 font-medium">Official Email Address</label>
              <div className="relative">
                <Mail className="w-4 h-4 absolute left-3 top-2.5 text-fg-subtle" />
                <input
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="name@society.in"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-surface border border-border-strong focus:border-brand rounded-lg pl-9 pr-3 py-2.5 text-fg outline-none transition"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-fg-muted font-medium">Password</label>
                <Link
                  href="/forgot-password"
                  className="text-xs text-brand hover:text-brand transition"
                >
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <Lock className="w-4 h-4 absolute left-3 top-2.5 text-fg-subtle" />
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  placeholder="••••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-surface border border-border-strong focus:border-brand rounded-lg pl-9 pr-3 py-2.5 text-fg outline-none transition"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting || isLoading}
              className="w-full mt-2 py-3 rounded-xl bg-brand hover:bg-brand-hover text-on-brand font-semibold text-xs flex items-center justify-center gap-2 shadow-card transition cursor-pointer disabled:opacity-50"
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
            {PHONE_LOGIN && (
              <button type="button" onClick={() => setUseEmail(false)} className="w-full text-center text-fg-muted hover:text-fg cursor-pointer">
                Log in with mobile instead
              </button>
            )}
          </form>
          )}

          {/* Info note */}
          <div className="pt-4 border-t border-border text-xs text-fg-muted text-center space-y-1">
            <p>
              Your role (Secretary, Treasurer, Resident, CA) is determined by verified server-side memberships after sign-in.
            </p>
          </div>
        </div>

        <div className="text-center text-xs text-fg-subtle">
          New to Sahvaas?{' '}
          <Link href={returnUrl ? `/signup?returnUrl=${encodeURIComponent(returnUrl)}` : '/signup'} className="text-brand hover:underline">
            Create an account
          </Link>
        </div>

        <div className="text-center text-xs text-fg-subtle">
          Need assistance?{' '}
          <Link href="/contact" className="text-brand hover:underline">
            Contact Support
          </Link>
        </div>
      </div>
    </div>
    </AuthLayout>
  );
};
