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
import { Briefcase, UserPlus, Loader2, XCircle, Eye, Save } from 'lucide-react';

interface InviteRow { id: string; invited_email: string; role: string; permissions: string[]; expires_at: string; access_until: string | null; status: string }
interface GrantRow {
  id: string; professional_user_id: string; role: string; status: string; permissions: string[];
  granted_at: string; expires_at: string | null; revoked_at: string | null;
  profiles: { full_name: string; email: string } | null;
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
        .select('id, professional_user_id, role, status, permissions, granted_at, expires_at, revoked_at, profiles:professional_user_id (full_name, email)')
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
    setBusy('invite');
    const { data: created, error: insErr } = await supabase.from('professional_invites').insert({
      society_id: societyId,
      invited_email: email.trim().toLowerCase(),
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
    const emailed = await notify('professional_invite', created.id);
    setBusy(null);
    setError(null);
    setNotice(`Invite saved.${describeNotify(emailed, 'person')} ${email.trim()} signs up at Sahvaas with this email, verifies it and accepts the invitation (valid 30 days).`);
    setEmail('');
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
      reason = window.prompt(`Reason for revoking ${g.profiles?.full_name ?? 'this professional'}'s access?`, 'Engagement completed');
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
  const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500';

  return (
    <div className="space-y-6 text-xs">
      <div>
        <h2 className="text-lg font-bold text-white">CA & Auditor Access</h2>
        <p className="text-slate-400">Give your CA read-only access to exactly what they need, for a fixed period. Resident contact details and complaints are never shared.</p>
      </div>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      <form onSubmit={invite} className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
        <div className="font-bold text-white text-sm flex items-center gap-2"><UserPlus className="w-4 h-4 text-amber-400" /> Invite a Professional</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input required type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="ca@firm.in" className={inputClass} />
          <select value={role} onChange={e => { const r = e.target.value as ProfessionalRole; setRole(r); setPerms(ROLE_PRESETS[r]); }} className={inputClass}>
            {PROFESSIONAL_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <label className="flex items-center gap-2 text-slate-400">
            <span className="shrink-0">Access until</span>
            <input type="date" value={accessUntil} onChange={e => setAccessUntil(e.target.value)} className={inputClass} />
          </label>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {PROFESSIONAL_PERMISSIONS.map(p => (
            <label key={p.key} className="flex items-start gap-2 p-2 rounded-lg hover:bg-slate-800/50 cursor-pointer">
              <input type="checkbox" checked={perms.includes(p.key)} onChange={() => setPerms(togglePerm(perms, p.key) as ProfessionalPermission[])} className="mt-0.5" />
              <span><span className="text-white">{p.label}</span> <span className="text-slate-500">— {p.hint}</span></span>
            </label>
          ))}
        </div>
        <button type="submit" disabled={busy === 'invite'} className="w-full py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
          {busy === 'invite' ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />} Save Invite
        </button>
      </form>

      {invites.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-semibold text-slate-400 uppercase tracking-wider text-[11px]">Pending Invites</h3>
          {invites.map(i => (
            <div key={i.id} className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold text-white truncate">{i.invited_email}</div>
                <div className="text-slate-400">{roleLabel(i.role)} • {i.permissions.length} permissions • invite expires {new Date(i.expires_at).toLocaleDateString('en-IN')}</div>
              </div>
              <button onClick={() => cancelInvite(i.id)} className="flex items-center gap-1 text-rose-400 hover:text-rose-300 cursor-pointer shrink-0"><XCircle className="w-3.5 h-3.5" /> Cancel</button>
            </div>
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h3 className="font-semibold text-slate-400 uppercase tracking-wider text-[11px]">Access Grants</h3>
        {grants.length === 0 ? (
          <EmptyState icon={Briefcase} title="No Professionals Yet" description="Invite your CA or statutory auditor above." />
        ) : grants.map(g => {
          const draft = editing[g.id];
          const active = g.status === 'active' && !isExpired(g);
          return (
            <div key={g.id} className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-bold text-white">{g.profiles?.full_name ?? 'Professional'} <span className="text-slate-500 font-normal">• {g.profiles?.email}</span></div>
                  <div className="text-slate-400">
                    {roleLabel(g.role)} • since {new Date(g.granted_at).toLocaleDateString('en-IN')}
                    {g.expires_at && ` • until ${new Date(g.expires_at).toLocaleDateString('en-IN')}`}
                  </div>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold shrink-0 ${active ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}>
                  {g.status === 'active' && isExpired(g) ? 'expired' : g.status}
                </span>
              </div>

              {draft ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                  {PROFESSIONAL_PERMISSIONS.map(p => (
                    <label key={p.key} className="flex items-center gap-2 text-slate-300 cursor-pointer">
                      <input type="checkbox" checked={draft.includes(p.key)} onChange={() => setEditing({ ...editing, [g.id]: togglePerm(draft, p.key) })} />
                      {p.label}
                    </label>
                  ))}
                </div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {g.permissions.map(p => <span key={p} className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 text-[10px]">{permissionLabel(p)}</span>)}
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                {draft ? (
                  <button onClick={() => savePermissions(g)} disabled={busy !== null} className="flex items-center gap-1 text-sky-400 hover:underline cursor-pointer"><Save className="w-3.5 h-3.5" /> Save permissions</button>
                ) : (
                  <button onClick={() => setEditing({ ...editing, [g.id]: g.permissions })} className="text-sky-400 hover:underline cursor-pointer">Edit permissions</button>
                )}
                {g.status === 'active'
                  ? <button onClick={() => setStatus(g, 'revoked')} disabled={busy !== null} className="text-rose-400 hover:underline cursor-pointer">Revoke access</button>
                  : <button onClick={() => setStatus(g, 'active')} disabled={busy !== null} className="text-emerald-400 hover:underline cursor-pointer">Restore access</button>}
              </div>
            </div>
          );
        })}
      </section>

      <RemarksPanel societyId={societyId} currentUserId={currentUserId} mode="committee" />

      <section className="space-y-2">
        <h3 className="font-semibold text-slate-400 uppercase tracking-wider text-[11px] flex items-center gap-1.5"><Eye className="w-3.5 h-3.5" /> Recent Professional Activity</h3>
        {logs.length === 0 ? (
          <p className="text-slate-500">No activity recorded yet.</p>
        ) : (
          <div className="rounded-2xl bg-slate-900 border border-slate-800 divide-y divide-slate-800">
            {logs.map(l => (
              <div key={l.id} className="p-2.5 flex justify-between gap-3 text-slate-300">
                <span>{nameOf(l.professional_user_id)} {l.action_performed} <strong className="text-white">{l.module_accessed.replace('_', ' ')}</strong></span>
                <span className="text-slate-500 shrink-0">{new Date(l.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
