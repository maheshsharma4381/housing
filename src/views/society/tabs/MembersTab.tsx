'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase/client';
import { EmptyState } from '../../../components/EmptyState';
import { MemberInvite, SocietyRole, Unit } from '../../../types/database';
import { inviteText, whatsappLink } from '../../../lib/messages';
import { describeNotify, notify } from '../../../lib/notify';
import { Users, UserPlus, Mail, AlertCircle, CheckCircle2, Loader2, XCircle, MessageCircle } from 'lucide-react';

const ROLE_OPTIONS: { value: SocietyRole; label: string }[] = [
  { value: 'resident_owner', label: 'Resident (Owner)' },
  { value: 'resident_tenant', label: 'Resident (Tenant)' },
  { value: 'committee_member', label: 'Committee Member' },
  { value: 'treasurer', label: 'Treasurer' },
  { value: 'secretary', label: 'Secretary' },
  { value: 'chairman', label: 'Chairman' },
  { value: 'society_admin', label: 'Society Admin' },
];

const roleLabel = (role: string) => ROLE_OPTIONS.find(r => r.value === role)?.label ?? role;

interface MemberRow {
  id: string;
  role: SocietyRole;
  unit_id: string | null;
  user_id: string;
  is_active: boolean;
  profiles: { full_name: string; email: string; phone?: string | null } | null;
}

interface MembersTabProps {
  societyId: string;
  societyName?: string;
  currentUserId?: string;
  units: Unit[];
}

export const MembersTab: React.FC<MembersTabProps> = ({ societyId, societyName, currentUserId, units }) => {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invites, setInvites] = useState<MemberInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<SocietyRole>('resident_owner');
  const [unitId, setUnitId] = useState('');
  const [sending, setSending] = useState(false);

  const unitLabel = (id: string | null | undefined) => units.find(u => u.id === id)?.unit_number ?? '—';
  const isResidentRole = role === 'resident_owner' || role === 'resident_tenant';

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const [mRes, iRes] = await Promise.all([
      supabase
        .from('society_memberships')
        .select('id, role, unit_id, user_id, is_active, profiles:user_id (full_name, email, phone)')
        .eq('society_id', societyId)
        .eq('is_active', true),
      supabase
        .from('member_invites')
        .select('*')
        .eq('society_id', societyId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false }),
    ]);
    setMembers(((mRes.data ?? []) as unknown) as MemberRow[]);
    setInvites((iRes.data ?? []) as MemberInvite[]);
    if (mRes.error || iRes.error) setError((mRes.error ?? iRes.error)!.message);
    setLoading(false);
  }, [societyId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || !currentUserId) return;
    setError(null);
    setNotice(null);

    if (isResidentRole && !unitId) {
      setError('Select the flat this resident belongs to.');
      return;
    }

    setSending(true);
    const { data: created, error: insertError } = await supabase.from('member_invites').insert({
      society_id: societyId,
      email: email.trim().toLowerCase(),
      full_name: fullName.trim() || null,
      role,
      unit_id: unitId || null,
      invited_by: currentUserId,
    }).select('id').single();

    if (insertError) {
      setSending(false);
      setError(
        insertError.code === '23505'
          ? 'This email already has a pending invite for that flat.'
          : insertError.message
      );
      return;
    }

    const emailed = await notify('member_invite', created.id);
    setSending(false);
    setNotice(
      `Invite saved for ${email.trim()}.${describeNotify(emailed, 'person')} ` +
        'They sign up at Sahvaas with this email, verify it and tap Accept on the invitation. Use "WhatsApp" below to send them the link.'
    );
    setEmail('');
    setFullName('');
    setUnitId('');
    load();
  };

  const revokeInvite = async (id: string) => {
    if (!supabase) return;
    const { error: updErr } = await supabase.from('member_invites').update({ status: 'revoked' }).eq('id', id);
    if (updErr) setError(updErr.message);
    load();
  };

  const deactivateMember = async (m: MemberRow) => {
    if (!supabase) return;
    if (!window.confirm(`Remove ${m.profiles?.full_name ?? 'this member'} from the society?`)) return;
    const { error: updErr } = await supabase.from('society_memberships').update({ is_active: false }).eq('id', m.id);
    if (updErr) setError(updErr.message);
    load();
  };

  const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500';

  return (
    <div className="space-y-6 text-xs">
      <div>
        <h2 className="text-lg font-bold text-white">Members & Residents</h2>
        <p className="text-slate-400">{members.length} active members • {invites.length} pending invites</p>
      </div>

      {/* Invite form */}
      <form onSubmit={handleInvite} className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
        <div className="flex items-center gap-2 text-sm font-bold text-white">
          <UserPlus className="w-4 h-4 text-sky-400" />
          <span>Invite a Member</span>
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{notice}</span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="block text-slate-400 font-medium">Email *</span>
            <input required type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="resident@gmail.com" className={inputClass} />
          </label>
          <label className="space-y-1">
            <span className="block text-slate-400 font-medium">Name</span>
            <input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Optional" className={inputClass} />
          </label>
          <label className="space-y-1">
            <span className="block text-slate-400 font-medium">Role *</span>
            <select value={role} onChange={e => setRole(e.target.value as SocietyRole)} className={inputClass}>
              {ROLE_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-slate-400 font-medium">Flat {isResidentRole ? '*' : '(optional)'}</span>
            <select value={unitId} onChange={e => setUnitId(e.target.value)} className={inputClass}>
              <option value="">{units.length === 0 ? 'Import flats first' : 'Select flat'}</option>
              {[...units]
                .sort((a, b) => a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true }))
                .map(u => <option key={u.id} value={u.id}>{u.unit_number}</option>)}
            </select>
          </label>
        </div>

        <button
          type="submit"
          disabled={sending}
          className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
          <span>{sending ? 'Saving…' : 'Save Invite'}</span>
        </button>
      </form>

      {/* Pending invites */}
      {invites.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-semibold text-slate-400 uppercase tracking-wider text-[11px]">Pending Invites</h3>
          {invites.map(inv => (
            <div key={inv.id} className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold text-white truncate">{inv.full_name || inv.email}</div>
                <div className="text-slate-400 truncate">{inv.email} • {roleLabel(inv.role)} • Flat {unitLabel(inv.unit_id)}</div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <a
                  href={whatsappLink(inviteText({
                    societyName: societyName ?? 'Our society',
                    inviteeName: inv.full_name,
                    role: roleLabel(inv.role),
                    email: inv.email,
                    flat: inv.unit_id ? unitLabel(inv.unit_id) : null,
                    appUrl: typeof window !== 'undefined' ? window.location.origin : '',
                  }))}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-emerald-400 hover:text-emerald-300"
                >
                  <MessageCircle className="w-3.5 h-3.5" /> WhatsApp
                </a>
                <button onClick={() => revokeInvite(inv.id)} className="flex items-center gap-1 text-rose-400 hover:text-rose-300 cursor-pointer">
                  <XCircle className="w-3.5 h-3.5" /> Revoke
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Members */}
      <div className="space-y-2">
        <h3 className="font-semibold text-slate-400 uppercase tracking-wider text-[11px]">Active Members</h3>
        {members.length === 0 && !loading ? (
          <EmptyState icon={Users} title="No Members Yet" description="Invite residents and committee members using the form above." />
        ) : (
          <div className="rounded-2xl bg-slate-900 border border-slate-800 divide-y divide-slate-800">
            {members.map(m => (
              <div key={m.id} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-white truncate">{m.profiles?.full_name ?? 'Unknown'}</div>
                  <div className="text-slate-400 truncate">{m.profiles?.email} {m.profiles?.phone ? `• ${m.profiles.phone}` : ''}</div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-sky-500/10 text-sky-300">{roleLabel(m.role)}</span>
                  <span className="text-slate-400 w-14 text-right">{m.unit_id ? unitLabel(m.unit_id) : '—'}</span>
                  {m.user_id !== currentUserId && (
                    <button onClick={() => deactivateMember(m)} className="text-slate-500 hover:text-rose-400 cursor-pointer" title="Remove member">
                      <XCircle className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
