'use client';

import React, { useState } from 'react';
import { useRouter, Link } from '../../router/RouterContext';
import { useAuth } from '../../context/AuthContext';
import { Lock, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { Logo } from '../../components/ui/Logo';
import { AuthLayout } from '../../components/ui/AuthLayout';

export const ResetPasswordPage: React.FC = () => {
  const { resetPassword, authError, clearAuthError } = useAuth();
  const { navigate } = useRouter();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearAuthError();
    setValidationError(null);

    if (password.length < 8) {
      setValidationError('Password must be at least 8 characters long.');
      return;
    }

    if (password !== confirmPassword) {
      setValidationError('Passwords do not match.');
      return;
    }

    setLoading(true);
    const { error } = await resetPassword(password);
    setLoading(false);

    if (!error) {
      setSuccess(true);
      setTimeout(() => {
        navigate('/login', { replace: true });
      }, 2000);
    }
  };

  return (
    <AuthLayout>
    <div className="min-h-screen lg:min-h-0 flex items-center justify-center p-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <Link href="/" className="inline-flex items-center gap-2">
            <Logo size={32} />
          </Link>
          <h1 className="text-xl font-semibold text-fg mt-2">Set a new password</h1>
          <p className="text-xs text-fg-muted">
            Create a secure new password for your society account.
          </p>
        </div>

        <div className="bg-surface border border-border rounded-2xl p-6 sm:p-8 shadow-card text-xs space-y-5">
          {(authError || validationError) && (
            <div className="p-3.5 rounded-xl bg-danger-soft border border-danger/30 text-danger text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
              <span>{validationError || authError}</span>
            </div>
          )}

          {success ? (
            <div className="p-4 rounded-xl bg-success-soft border border-success/30 text-success space-y-2 text-center">
              <CheckCircle2 className="w-6 h-6 text-success mx-auto" />
              <div className="font-semibold text-fg text-sm">Password Updated!</div>
              <p className="text-fg text-xs">
                Your password has been changed. Redirecting you to sign in...
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-fg-muted mb-1.5 font-medium">New Password</label>
                <div className="relative">
                  <Lock className="w-4 h-4 absolute left-3 top-2.5 text-fg-subtle" />
                  <input
                    type="password"
                    required
                    placeholder="Min 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-surface border border-border-strong focus:border-brand rounded-lg pl-9 pr-3 py-2.5 text-fg outline-none transition"
                  />
                </div>
              </div>

              <div>
                <label className="block text-fg-muted mb-1.5 font-medium">Confirm New Password</label>
                <div className="relative">
                  <Lock className="w-4 h-4 absolute left-3 top-2.5 text-fg-subtle" />
                  <input
                    type="password"
                    required
                    placeholder="Re-enter password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full bg-surface border border-border-strong focus:border-brand rounded-lg pl-9 pr-3 py-2.5 text-fg outline-none transition"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 rounded-xl bg-brand hover:bg-brand-hover text-on-brand font-semibold text-xs flex items-center justify-center gap-2 shadow-card transition cursor-pointer disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Updating Password...</span>
                  </>
                ) : (
                  <span>Save New Password</span>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
    </AuthLayout>
  );
};
