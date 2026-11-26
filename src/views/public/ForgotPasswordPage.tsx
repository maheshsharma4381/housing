'use client';

import React, { useState } from 'react';
import { Link } from '../../router/RouterContext';
import { useAuth } from '../../context/AuthContext';
import { Mail, ArrowLeft, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { Logo } from '../../components/ui/Logo';
import { AuthLayout } from '../../components/ui/AuthLayout';

export const ForgotPasswordPage: React.FC = () => {
  const { forgotPassword, authError, clearAuthError } = useAuth();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sentMessage, setSentMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearAuthError();
    setLoading(true);

    const { error, message } = await forgotPassword(email);
    setLoading(false);

    if (!error) {
      setSentMessage(message || 'Password reset email sent. Please check your inbox.');
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
          <h1 className="text-xl font-semibold text-fg mt-2">Reset your password</h1>
          <p className="text-xs text-fg-muted">
            Enter your registered email and we&apos;ll send a secure password reset link.
          </p>
        </div>

        <div className="bg-surface border border-border rounded-2xl p-6 sm:p-8 shadow-card text-xs space-y-5">
          {authError && (
            <div className="p-3.5 rounded-xl bg-danger-soft border border-danger/30 text-danger text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
              <span>{authError}</span>
            </div>
          )}

          {sentMessage ? (
            <div className="p-4 rounded-xl bg-success-soft border border-success/30 text-success space-y-3">
              <div className="flex items-center gap-2 font-semibold text-fg">
                <CheckCircle2 className="w-4 h-4 text-success" />
                <span>Link Dispatched</span>
              </div>
              <p className="text-fg text-xs leading-relaxed">{sentMessage}</p>
              <Link
                href="/login"
                className="inline-block pt-2 text-xs text-brand font-semibold hover:underline"
              >
                Return to Login
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-fg-muted mb-1.5 font-medium">Registered Email Address</label>
                <div className="relative">
                  <Mail className="w-4 h-4 absolute left-3 top-2.5 text-fg-subtle" />
                  <input
                    type="email"
                    required
                    placeholder="name@society.in"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
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
                    <span>Sending Reset Link...</span>
                  </>
                ) : (
                  <span>Send Reset Email</span>
                )}
              </button>

              <div className="text-center pt-2">
                <Link
                  href="/login"
                  className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Back to Sign In</span>
                </Link>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
    </AuthLayout>
  );
};
