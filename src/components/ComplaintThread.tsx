'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import { Complaint, ComplaintStatus } from '../types/database';
import { Send, Loader2, Save } from 'lucide-react';

interface UpdateRow {
  id: string;
  message: string;
  created_at: string;
  author_id: string;
  profiles: { full_name: string } | null;
}

export interface CommitteeOption {
  user_id: string;
  name: string;
}

interface ComplaintThreadProps {
  complaint: Complaint;
  currentUserId?: string;
  /** Committee view: can change status, assignee and resolution notes */
  canManage: boolean;
  committee?: CommitteeOption[];
  onChanged: () => void;
}

const STATUSES: ComplaintStatus[] = ['open', 'in_progress', 'resolved', 'closed'];

export const ComplaintThread: React.FC<ComplaintThreadProps> = ({ complaint, currentUserId, canManage, committee = [], onChanged }) => {
  const [updates, setUpdates] = useState<UpdateRow[]>([]);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<ComplaintStatus>(complaint.status);
  const [assignedTo, setAssignedTo] = useState(complaint.assigned_to ?? '');
  const [resolution, setResolution] = useState(complaint.resolution_notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data, error: loadErr } = await supabase
      .from('complaint_updates')
      .select('id, message, created_at, author_id, profiles:author_id (full_name)')
      .eq('complaint_id', complaint.id)
      .order('created_at');
    if (loadErr) setError(loadErr.message);
    setUpdates(((data ?? []) as unknown) as UpdateRow[]);
  }, [complaint.id]);

  useEffect(() => {
    load();
  }, [load]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || !currentUserId || !message.trim()) return;
    setSending(true);
    const { error: insErr } = await supabase.from('complaint_updates').insert({
      society_id: complaint.society_id,
      complaint_id: complaint.id,
      author_id: currentUserId,
      message: message.trim(),
    });
    setSending(false);
    if (insErr) return setError(insErr.message);
    setMessage('');
    load();
  };

  const saveWorkflow = async () => {
    if (!supabase) return;
    if ((status === 'resolved' || status === 'closed') && !resolution.trim()) {
      setError('Add resolution notes before marking the ticket resolved.');
      return;
    }
    setSaving(true);
    setError(null);
    const { error: updErr } = await supabase
      .from('complaints')
      .update({ status, assigned_to: assignedTo || null, resolution_notes: resolution.trim() || null })
      .eq('id', complaint.id);
    setSaving(false);
    if (updErr) return setError(updErr.message);
    onChanged();
  };

  const inputClass = 'bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500';

  return (
    <div className="space-y-3 text-xs pt-3 border-t border-slate-800">
      <p className="text-slate-300 whitespace-pre-line">{complaint.description}</p>
      {complaint.resolution_notes && !canManage && (
        <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20 text-emerald-300">
          <strong>Resolution:</strong> {complaint.resolution_notes}
        </div>
      )}
      <Banner tone="error">{error}</Banner>

      {updates.length > 0 && (
        <div className="space-y-2">
          {updates.map(u => (
            <div key={u.id} className={`p-2.5 rounded-xl max-w-[85%] ${u.author_id === currentUserId ? 'ml-auto bg-sky-600/20 text-sky-100' : 'bg-slate-800 text-slate-200'}`}>
              <div className="text-[10px] text-slate-400 mb-0.5">
                {u.author_id === currentUserId ? 'You' : u.profiles?.full_name ?? 'Society office'} • {new Date(u.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
              </div>
              {u.message}
            </div>
          ))}
        </div>
      )}

      {complaint.status !== 'closed' && (
        <form onSubmit={send} className="flex gap-2">
          <input value={message} onChange={e => setMessage(e.target.value)} maxLength={2000} placeholder="Add an update…" className={`flex-1 ${inputClass}`} />
          <button type="submit" disabled={sending || !message.trim()} className="px-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white cursor-pointer disabled:opacity-50">
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </form>
      )}

      {canManage && (
        <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <select value={status} onChange={e => setStatus(e.target.value as ComplaintStatus)} className={inputClass}>
              {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
            <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)} className={inputClass}>
              <option value="">Unassigned</option>
              {committee.map(c => <option key={c.user_id} value={c.user_id}>{c.name}</option>)}
            </select>
          </div>
          <input value={resolution} onChange={e => setResolution(e.target.value)} placeholder="Resolution notes (shown to the resident)" className={`w-full ${inputClass}`} />
          <button onClick={saveWorkflow} disabled={saving} className="w-full py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save Ticket
          </button>
        </div>
      )}
    </div>
  );
};
