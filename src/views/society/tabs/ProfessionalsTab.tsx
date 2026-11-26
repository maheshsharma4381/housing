'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase/client';
import {
  PROFESSIONAL_PERMISSIONS, PROFESSIONAL_ROLES, ROLE_PRESETS, ProfessionalPermission, permissionLabel, roleLabel,
} from '../../../lib/professional-permissions';
import { Banner } from '../../../components/Banner';
import { EmptyState } from '../../../components/EmptyState';
import { RemarksPanel } from '../../../components/RemarksPanel';
import { ProfessionalRole } from '../../../types/database';
import { describeNotify, notify } from '../../../lib/notify';
import { normalizeMobile, formatMobile, contactText } from '../../../lib/mobile';
import { Briefcase, UserPlus, Loader2, XCircle, Eye, Save } from 'lucide-react';
import { PHONE_LOGIN_ON } from '../../../lib/phone-login';
import { promptDialog } from '../../../components/ui/feedback';

interface InviteRow { id: string; invited_email: string | null; invited_mobile: string | null; role: string; permissions: string[]; expires_at: string; access_until: string | null; status: string }
interface GrantRow {
  id: string; professional_user_id: string; role: string; status: string; permissions: string[];
  granted_at: string; expires_at: string | null; revoked_at: string | null;
  profiles: { full_name: string; email: string | null; phone?: string | null } | null;
}
interface LogRow { id: string; professional_user_id: string; module_accessed: string; action_performed: string; created_at: string }

interface ProfessionalsTabProps {
  societyId: string;
  currentUserId?: string;
}

export const ProfessionalsTab: React.FC<ProfessionalsTabProps> = ({ societyId, currentUserId }) => {
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [role, setRole] = useState<ProfessionalRole>('ca');
  const [perms, setPerms] = useState<ProfessionalPermission[]>(ROLE_PRESETS.ca);
  const [accessUntil, setAccessUntil] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 6);
    return d.toISOString().slice(0, 10);
  });
  const [editing, setEditing] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [iRes, gRes, lRes] = await Promise.all([
      supabase.from('professional_invites').select('*').eq('society_id', societyId).eq('status', 'pending').order('created_at', { ascending: false }),
      supabase.from('society_professional_access')
        .select('id, professional_user_id, role, status, permissions, granted_at, expires_at, revoked_at, profiles:professional_user_id (full_name, email, phone)')
        .eq('society_id', societyId).order('granted_at', { ascending: false }),
      supabase.from('access_logs').select('*').eq('society_id', societyId).order('created_at', { ascending: false }).limit(30),
    ]);
    setInvites((iRes.data ?? []) as InviteRow[]);
    setGrants(((gRes.data ?? []) as unknown) as GrantRow[]);
    setLogs((lRes.data ?? []) as LogRow[]);
    const err = iRes.error ?? gRes.error ?? lRes.error;
    if (err) setError(err.message);
  }, [societyId]);

  useEffect(() => {
    load();
  }, [load]);

  const togglePerm = (list: string[], key: string) => (list.includes(key) ? list.filter(p => p !== key) : [...list, key]);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || !currentUserId) return;
    if (perms.length === 0) return setError('Select at least one permission.');
    const mobileDigits = mobile.trim() ? normalizeMobile(mobile) : null;
    if (mobile.trim() && !mobileDigits) return setError(`Mobile ${mobile} is not a valid number`);
    if (!mobileDigits && !email.trim()) return setError('Enter their mobile or email — they log in with it.');
    if (!PHONE_LOGIN_ON && !email.trim()) return setError('Enter their email — logging in with a mobile is not switched on yet.');
    setBusy('invite');
    const { data: created, error: insErr } = await supabase.from('professional_invites').insert({
      society_id: societyId,
      invited_email: email.trim().toLowerCase() || null,
      invited_mobile: mobileDigits,
      role,
      permissions: perms,
      invited_by: currentUserId,
      expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      access_until: accessUntil ? `${accessUntil}T23:59:59+05:30` : null,
    }).select('id').single();
    if (insErr) {
      setBusy(null);
      return setError(insErr.code === '23505' ? 'This email already has a pending invite.' : insErr.message);
    }
    const emailed = email.trim() ? await notify('professional_invite', created.id) : null;
    setBusy(null);
    setError(null);
    setNotice(mobileDigits && PHONE_LOGIN_ON
      ? `Invite saved. ${formatMobile(mobileDigits)} logs in at Sahvaas with this mobile and accepts the invitation (valid 30 days).`
      : `Invite saved.${describeNotify(emailed, 'person')} ${email.trim()} signs up at Sahvaas with this email, verifies it and accepts the invitation (valid 30 days).`);
    setEmail('');
    setMobile('');
    load();
  };

  const cancelInvite = async (id: string) => {
    if (!supabase) return;
    const { error: delErr } = await supabase.from('professional_invites').delete().eq('id', id);
    if (delErr) setError(delErr.message);
    load();
  };

  const savePermissions = async (g: GrantRow) => {
    if (!supabase) return;
    const next = editing[g.id];
    if (!next?.length) return setError('A grant needs at least one permission — revoke it instead.');
    setBusy(g.id);
    const { error: updErr } = await supabase.from('society_professional_access').update({ permissions: next }).eq('id', g.id);
    setBusy(null);
    if (updErr) return setError(updErr.message);
    setEditing(prev => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== g.id)));
    setNotice('Permissions updated — effective immediately.');
    load();
  };

  const setStatus = async (g: GrantRow, status: 'active' | 'revoked') => {
    if (!supabase) return;
    let reason: string | null = null;
    if (status === 'revoked') {
      reason = await promptDialog({ title: `Revoke ${g.profiles?.full_name ?? 'this professional'}'s access?`, body: 'They can no longer open this society.', label: 'Reason', defaultValue: 'Engagement completed', confirmText: 'Revoke access', tone: 'danger' });
      if (reason === null) return;
    }
    setBusy(g.id);
    const { error: updErr } = await supabase.from('society_professional_access').update({ status, revocation_reason: reason }).eq('id', g.id);
    setBusy(null);
    if (updErr) return setError(updErr.message);
    setNotice(status === 'revoked' ? 'Access revoked.' : 'Access restored.');
    load();
  };

  const nameOf = (userId: string) => grants.find(g => g.professional_user_id === userId)?.profiles?.full_name ?? 'Professional';
  const isExpired = (g: GrantRow) => Boolean(g.expires_at && new Date(g.expires_at) < new Date());
  const inputClass = 'w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand';

  return (
    <div className="space-y-6 text-sm">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-fg">CA &amp; auditor</h2>
        <p className="text-fg-muted">Give your CA read-only access to exactly what they need, for a fixed period. Resident contact details and complaints are never shared.</p>
      </div>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      <form onSubmit={invite} className="p-5 rounded-xl bg-surface border border-border space-y-3">
        <div className="font-semibold text-fg text-sm flex items-center gap-2"><UserPlus className="w-4 h-4 text-warning" /> Invite a Professional</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input inputMode="tel" value={mobile} onChange={e => setMobile(e.target.value)} placeholder="Mobile, e.g. 98765 43210" aria-label="Mobile" className={inputClass} />
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder={mobile.trim() && PHONE_LOGIN_ON ? 'Email (optional)' : 'ca@firm.in'} aria-label="Email" className={inputClass} />
          <select value={role} onChange={e => { const r = e.target.value as ProfessionalRole; setRole(r); setPerms(ROLE_PRESETS[r]); }} className={inputClass}>
            {PROFESSIONAL_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <label className="flex items-center gap-2 text-fg-muted">
            <span className="shrink-0">Access until</span>
            <input type="date" value={accessUntil} onChange={e => setAccessUntil(e.target.value)} className={inputClass} />
          </label>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {PROFESSIONAL_PERMISSIONS.map(p => (
            <label key={p.key} className="flex items-start gap-2 p-2 rounded-lg hover:bg-surface-muted/50 cursor-pointer">
              <input type="checkbox" checked={perms.includes(p.key)} onChange={() => setPerms(togglePerm(perms, p.key) as ProfessionalPermission[])} className="mt-0.5" />
              <span><span className="text-fg">{p.label}</span> <span className="text-fg-subtle">— {p.hint}</span></span>
            </label>
          ))}
        </div>
        <button type="submit" disabled={busy === 'invite'} className="w-full py-2.5 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
          {busy === 'invite' ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />} Save Invite
        </button>
      </form>

      {invites.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-semibold text-fg-muted text-xs">Pending Invites</h3>
          {invites.map(i => (
            <div key={i.id} className="p-3 rounded-xl bg-surface border border-border flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold text-fg truncate">{[i.invited_mobile ? formatMobile(i.invited_mobile) : null, i.invited_email].filter(Boolean).join(' · ')}</div>
                <div className="text-fg-muted">{roleLabel(i.role)} • {i.permissions.length} permissions • invite expires {new Date(i.expires_at).toLocaleDateString('en-IN')}</div>
              </div>
              <button onClick={() => cancelInvite(i.id)} className="flex items-center gap-1 text-danger hover:text-danger cursor-pointer shrink-0"><XCircle className="w-3.5 h-3.5" /> Cancel</button>
            </div>
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h3 className="font-semibold text-fg-muted text-xs">Access Grants</h3>
        {grants.length === 0 ? (
          <EmptyState icon={Briefcase} title="No Professionals Yet" description="Invite your CA or statutory auditor above." />
        ) : grants.map(g => {
          const draft = editing[g.id];
          const active = g.status === 'active' && !isExpired(g);
          return (
            <div key={g.id} className="p-4 rounded-xl bg-surface border border-border space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-fg">{g.profiles?.full_name ?? 'Professional'} {contactText(g.profiles) && <span className="text-fg-subtle font-normal">• {contactText(g.profiles)}</span>}</div>
                  <div className="text-fg-muted">
                    {roleLabel(g.role)} • since {new Date(g.granted_at).toLocaleDateString('en-IN')}
                    {g.expires_at && ` • until ${new Date(g.expires_at).toLocaleDateString('en-IN')}`}
                  </div>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-xs uppercase font-semibold shrink-0 ${active ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`}>
                  {g.status === 'active' && isExpired(g) ? 'expired' : g.status}
                </span>
              </div>

              {draft ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                  {PROFESSIONAL_PERMISSIONS.map(p => (
                    <label key={p.key} className="flex items-center gap-2 text-fg cursor-pointer">
                      <input type="checkbox" checked={draft.includes(p.key)} onChange={() => setEditing({ ...editing, [g.id]: togglePerm(draft, p.key) })} />
                      {p.label}
                    </label>
                  ))}
                </div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {g.permissions.map(p => <span key={p} className="px-2 py-0.5 rounded-full bg-surface-muted text-fg text-xs">{permissionLabel(p)}</span>)}
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                {draft ? (
                  <button onClick={() => savePermissions(g)} disabled={busy !== null} className="flex items-center gap-1 text-brand hover:underline cursor-pointer"><Save className="w-3.5 h-3.5" /> Save permissions</button>
                ) : (
                  <button onClick={() => setEditing({ ...editing, [g.id]: g.permissions })} className="text-brand hover:underline cursor-pointer">Edit permissions</button>
                )}
                {g.status === 'active'
                  ? <button onClick={() => setStatus(g, 'revoked')} disabled={busy !== null} className="text-danger hover:underline cursor-pointer">Revoke access</button>
                  : <button onClick={() => setStatus(g, 'active')} disabled={busy !== null} className="text-success hover:underline cursor-pointer">Restore access</button>}
              </div>
            </div>
          );
        })}
      </section>

      <RemarksPanel societyId={societyId} currentUserId={currentUserId} mode="committee" />

      <section className="space-y-2">
        <h3 className="font-semibold text-fg-muted text-xs flex items-center gap-1.5"><Eye className="w-3.5 h-3.5" /> Recent Professional Activity</h3>
        {logs.length === 0 ? (
          <p className="text-fg-subtle">No activity recorded yet.</p>
        ) : (
          <div className="rounded-xl bg-surface border border-border divide-y divide-border">
            {logs.map(l => (
              <div key={l.id} className="p-2.5 flex justify-between gap-3 text-fg">
                <span>{nameOf(l.professional_user_id)} {l.action_performed} <strong className="text-fg">{l.module_accessed.replace('_', ' ')}</strong></span>
                <span className="text-fg-subtle shrink-0">{new Date(l.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
