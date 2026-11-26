'use client';

import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { SetupWizard } from '../setup/SetupWizard';
import { LogOut, MailCheck } from 'lucide-react';

/** A login with no society yet (spec 9.1): register the society in a few short steps, or join one through its link. */
export const OnboardingPage: React.FC = () => {
  const { societyMemberships, logout } = useAuth();
  // Someone who already runs a society can still register another one here
  const runsOne = societyMemberships.some(m => ['secretary', 'chairman', 'treasurer', 'society_admin'].includes(m.role));
  const [another, setAnother] = useState(false);

  return (
    <div className="min-h-screen bg-canvas text-fg py-10 px-4">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold text-fg tracking-tight">Set up your society</h1>
            <p className="text-xs text-fg-muted">A few short steps, then your first bills. 30-day free trial, no card required.</p>
          </div>
          <button
            onClick={() => logout()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface border border-border text-xs text-fg hover:text-danger cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>

        {societyMemberships.length === 0 && (
          <div className="p-4 rounded-xl bg-surface border border-border text-xs text-fg flex items-start gap-3">
            <MailCheck className="w-5 h-5 text-success shrink-0" />
            <div>
              <div className="font-semibold text-fg">Are you a resident?</div>
              <p className="text-fg-muted mt-0.5">
                You don&apos;t need to register. Open the joining link your secretary shared in the society&apos;s WhatsApp group,
                or accept the invitation shown at the top of this page.
              </p>
            </div>
          </div>
        )}

        {runsOne && !another && (
          <button onClick={() => setAnother(true)} className="text-xs text-brand hover:underline cursor-pointer">Register another society instead</button>
        )}
        <SetupWizard startNew={another} />
      </div>
    </div>
  );
};
