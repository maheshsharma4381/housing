'use client';

import React, { useEffect, useState } from 'react';
import { useRouter, Link } from '../../router/RouterContext';
import { useAuth } from '../../context/AuthContext';
import { Mail, Lock, User, ArrowRight, AlertCircle, Loader2, CheckCircle2 } from 'lucide-react';

export const SignupPage: React.FC = () => {
  const { signUp, isAuthenticated, getRedirectPath, authError, clearAuthError, isSupabaseConfigured } = useAuth();
  const { navigate } = useRouter();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [verifyEmailSent, setVerifyEmailSent] = useState(false);

  useEffect(() => {
    if (isAuthenticated) {
      navigate(getRedirectPath(), { replace: true });
    }
  }, [isAuthenticated, navigate, getRedirectPath]);

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
    const { error, message } = await signUp(email, password, fullName);
    setSubmitting(false);

    // With email confirmation enabled, Supabase returns no session: ask user to verify
    if (!error && message?.toLowerCase().includes('verify')) {
      setVerifyEmailSent(true);
    }
  };

  const errorText = validationError || authError;

  return (
    <div className="bg-slate-950 min-h-screen flex items-center justify-center p-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <Link href="/" className="inline-flex items-center gap-2">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-sky-500 to-sky-700 flex items-center justify-center text-white font-black text-lg shadow-lg shadow-sky-600/30">
              S
            </div>
            <span className="font-bold text-2xl text-white tracking-tight">Sahvaas</span>
          </Link>
          <h1 className="text-xl font-bold text-white mt-2">Create Your Account</h1>
          <p className="text-xs text-slate-400">
            Register your society or accept an invite from your committee.
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-2xl text-xs space-y-5">
          {!isSupabaseConfigured && (
            <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300">
              Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.
            </div>
          )}

          {verifyEmailSent ? (
            <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 space-y-2 text-center">
              <CheckCircle2 className="w-6 h-6 text-emerald-400 mx-auto" />
              <div className="font-bold text-white text-sm">Check Your Inbox</div>
              <p className="text-slate-300">
                We sent a verification link to <strong className="text-white">{email}</strong>. After verifying, sign in to
                register your society. If your committee invited you, you&apos;ll see the invitation to accept.
              </p>
              <Link href="/login" className="inline-block pt-2 text-sky-400 font-semibold hover:underline">
                Go to Sign In
              </Link>
            </div>
          ) : (
            <>
              {errorText && (
                <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
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
                  className="w-full mt-2 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-sky-600/30 transition cursor-pointer disabled:opacity-50"
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

        <div className="text-center text-xs text-slate-500">
          Already have an account?{' '}
          <Link href="/login" className="text-sky-400 hover:underline">
            Sign In
          </Link>
        </div>
      </div>
    </div>
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
    <label className="block text-slate-400 mb-1.5 font-medium">{label}</label>
    <div className="relative">
      <Icon className="w-4 h-4 absolute left-3 top-2.5 text-slate-500" />
      <input
        type={type}
        required
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-slate-950 border border-slate-700 focus:border-sky-500 rounded-xl pl-9 pr-3 py-2.5 text-white outline-none transition"
      />
    </div>
  </div>
);
