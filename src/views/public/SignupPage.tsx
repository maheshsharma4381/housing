'use client';

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { safeInternalPath } from '../../lib/safe-redirect';
import { MobileOtpLogin } from '../../components/MobileOtpLogin';

const PHONE_LOGIN = process.env.NEXT_PUBLIC_PHONE_LOGIN === '1';
import { useRouter, Link } from '../../router/RouterContext';
import { useAuth } from '../../context/AuthContext';
import { Mail, Lock, User, ArrowRight, AlertCircle, Loader2, CheckCircle2 } from 'lucide-react';
import { Logo } from '../../components/ui/Logo';
import { AuthLayout } from '../../components/ui/AuthLayout';

export const SignupPage: React.FC = () => {
  const { signUp, isAuthenticated, isLoading, getRedirectPath, authError, clearAuthError, isSupabaseConfigured } = useAuth();
  const { navigate } = useRouter();
  // e.g. a joining link: come back to it after signing up
  const returnUrl = safeInternalPath(useSearchParams().get('returnUrl'));
  const loginHref = returnUrl ? `/login?returnUrl=${encodeURIComponent(returnUrl)}` : '/login';

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [verifyEmailSent, setVerifyEmailSent] = useState(false);
  // A mobile login makes the account on first use (3C); email signup stays as the fallback
  const [useEmail, setUseEmail] = useState(!PHONE_LOGIN);

  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      navigate(returnUrl || getRedirectPath(), { replace: true });
    }
  }, [isAuthenticated, isLoading, navigate, getRedirectPath, returnUrl]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearAuthError();
    setValidationError(null);

    if (fullName.trim().length < 2) {
      setValidationError('Please enter your full name.');
      return;
    }
    if (password.length < 8) {
      setValidationError('Password must be at least 8 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setValidationError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    const { error, message } = await signUp(email, password, fullName, returnUrl);
    setSubmitting(false);

    // With email confirmation enabled, Supabase returns no session: ask user to verify
    if (!error && message?.toLowerCase().includes('verify')) {
      setVerifyEmailSent(true);
    }
  };

  const errorText = validationError || authError;

  return (
    <AuthLayout>
    <div className="min-h-screen lg:min-h-0 flex items-center justify-center p-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <Link href="/" className="inline-flex items-center gap-2">
            <Logo size={32} />
          </Link>
          <h1 className="text-xl font-semibold text-fg mt-2">Create your account</h1>
          <p className="text-xs text-fg-muted">
            Register your society or accept an invite from your committee.
          </p>
        </div>

        <div className="bg-surface border border-border rounded-2xl p-6 sm:p-8 shadow-card text-xs space-y-5">
          {!isSupabaseConfigured && (
            <div className="p-3.5 rounded-xl bg-warning-soft border border-warning/30 text-warning">
              Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.
            </div>
          )}

          {verifyEmailSent ? (
            <div className="p-4 rounded-xl bg-success-soft border border-success/30 text-success space-y-2 text-center">
              <CheckCircle2 className="w-6 h-6 text-success mx-auto" />
              <div className="font-semibold text-fg text-sm">Check Your Inbox</div>
              <p className="text-fg">
                We sent a verification link to <strong className="text-fg">{email}</strong>. After verifying, sign in to
                register your society. If your committee invited you, you&apos;ll see the invitation to accept.
              </p>
              <Link href={loginHref} className="inline-block pt-2 text-brand font-semibold hover:underline">
                Go to Sign In
              </Link>
            </div>
          ) : !useEmail ? (
            <div className="space-y-4">
              <p className="text-fg-muted">Enter your mobile number. A new number gets an account when you log in.</p>
              <MobileOtpLogin onSignedIn={(path) => navigate(returnUrl || path, { replace: true })} />
              <button type="button" onClick={() => setUseEmail(true)} className="w-full text-center text-fg-muted hover:text-fg cursor-pointer">
                Use email instead
              </button>
            </div>
          ) : (
            <>
              {errorText && (
                <div className="p-3.5 rounded-xl bg-danger-soft border border-danger/30 text-danger flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                  <span>{errorText}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <Field icon={User} label="Full Name" type="text" autoComplete="name" placeholder="e.g. Vikram Joshi" value={fullName} onChange={setFullName} />
                <Field icon={Mail} label="Email Address" type="email" autoComplete="email" placeholder="name@society.in" value={email} onChange={setEmail} />
                <Field icon={Lock} label="Password" type="password" autoComplete="new-password" placeholder="Min 8 characters" value={password} onChange={setPassword} />
                <Field icon={Lock} label="Confirm Password" type="password" autoComplete="new-password" placeholder="Re-enter password" value={confirmPassword} onChange={setConfirmPassword} />

                <button
                  type="submit"
                  disabled={submitting || !isSupabaseConfigured}
                  className="w-full mt-2 py-3 rounded-xl bg-brand hover:bg-brand-hover text-on-brand font-semibold text-xs flex items-center justify-center gap-2 shadow-card transition cursor-pointer disabled:opacity-50"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Creating Account...</span>
                    </>
                  ) : (
                    <>
                      <span>Create Account</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </form>
            </>
          )}
        </div>

        <div className="text-center text-xs text-fg-subtle">
          Already have an account?{' '}
          <Link href={loginHref} className="text-brand hover:underline">
            Sign In
          </Link>
        </div>
      </div>
    </div>
    </AuthLayout>
  );
};

interface FieldProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  type: string;
  autoComplete: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}

const Field: React.FC<FieldProps> = ({ icon: Icon, label, type, autoComplete, placeholder, value, onChange }) => (
  <div>
    <label className="block text-fg-muted mb-1.5 font-medium">{label}</label>
    <div className="relative">
      <Icon className="w-4 h-4 absolute left-3 top-2.5 text-fg-subtle" />
      <input
        type={type}
        required
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-surface border border-border-strong focus:border-brand rounded-lg pl-9 pr-3 py-2.5 text-fg outline-none transition"
      />
    </div>
  </div>
);
