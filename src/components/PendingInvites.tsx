'use client';

import React, { useState } from 'react';
import { useAuth, PendingInvite } from '../context/AuthContext';
import { useRouter } from '../router/RouterContext';
import { permissionLabel, roleLabel as professionalRoleLabel } from '../lib/professional-permissions';
import { MailOpen, Check, X, Loader2 } from 'lucide-react';

const MEMBER_ROLES: Record<string, string> = {
  resident_owner: 'Resident (Owner)',
  resident_tenant: 'Resident (Tenant)',
  committee_member: 'Committee Member',
  treasurer: 'Treasurer',
  secretary: 'Secretary',
  chairman: 'Chairman',
  society_admin: 'Society Admin',
};

/** Invitations are never auto-accepted: the invitee confirms each one here. */
export const PendingInvites: React.FC = () => {
  const { pendingInvites, respondToInvite, getRedirectPath } = useAuth();
  const { navigate } = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (pendingInvites.length === 0) return null;

  const respond = async (inv: PendingInvite, accept: boolean) => {
    if (!accept && !window.confirm(`Decline the invitation from ${inv.society_name}?`)) return;
    setBusy(inv.id);
    setError(null);
    const { error: err } = await respondToInvite(inv, accept);
    setBusy(null);
    if (err) return setError(err);
    if (accept) navigate(inv.kind === 'professional' ? '/professional' : getRedirectPath());
  };

  return (
    <div className="max-w-3xl mx-auto px-4 pt-4">
      <div className="p-4 rounded-2xl bg-sky-500/5 border border-sky-500/30 space-y-3 text-xs">
        <div className="flex items-center gap-2 font-bold text-sky-300 text-sm">
          <MailOpen className="w-4 h-4" /> You have {pendingInvites.length} invitation{pendingInvites.length > 1 ? 's' : ''}
        </div>
        {error && <div className="text-rose-300">{error}</div>}
        {pendingInvites.map(inv => (
          <div key={inv.id} className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold text-white">
                {inv.society_name}{inv.society_city ? `, ${inv.society_city}` : ''}
              </div>
              <div className="text-slate-400">
                {inv.kind === 'professional' ? professionalRoleLabel(inv.role) : MEMBER_ROLES[inv.role] ?? inv.role}
                {inv.flat && ` • Flat ${inv.flat}`}
                {inv.invited_by_name && ` • invited by ${inv.invited_by_name}`}
              </div>
              {inv.permissions && inv.permissions.length > 0 && (
                <div className="text-slate-500 mt-0.5">Access: {inv.permissions.map(permissionLabel).join(', ')}</div>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => respond(inv, true)} disabled={busy !== null}
                className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold cursor-pointer disabled:opacity-50">
                {busy === inv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Accept
              </button>
              <button onClick={() => respond(inv, false)} disabled={busy !== null}
                className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold cursor-pointer disabled:opacity-50">
                <X className="w-3.5 h-3.5" /> Decline
              </button>
            </div>
          </div>
        ))}
        <p className="text-slate-500">Only accept invitations from societies you belong to. Accepting shares your name, email and phone with that committee.</p>
      </div>
    </div>
  );
};
