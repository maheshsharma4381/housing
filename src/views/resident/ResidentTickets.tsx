'use client';

import React, { useState } from 'react';
import { supabase } from '../../lib/supabase/client';
import { Banner } from '../../components/Banner';
import { EmptyState } from '../../components/EmptyState';
import { ComplaintThread } from '../../components/ComplaintThread';
import { Complaint } from '../../types/database';
import { MessageSquare, Plus, X, Loader2, Send, ChevronDown, ChevronUp } from 'lucide-react';

const CATEGORIES: { value: Complaint['category']; label: string }[] = [
  { value: 'plumbing', label: 'Plumbing / Leakage' },
  { value: 'electricity', label: 'Electrical' },
  { value: 'lift', label: 'Lift' },
  { value: 'security', label: 'Security' },
  { value: 'cleanliness', label: 'Cleanliness' },
  { value: 'parking', label: 'Parking' },
  { value: 'noise', label: 'Noise / Neighbours' },
  { value: 'other', label: 'Other' },
];

interface ResidentTicketsProps {
  societyId: string;
  unitId: string | null;
  userId?: string;
  complaints: Complaint[];
  loading: boolean;
  onChanged: () => void;
}

export const ResidentTickets: React.FC<ResidentTicketsProps> = ({ societyId, unitId, userId, complaints, loading, onChanged }) => {
  const [showForm, setShowForm] = useState(false);
  const [category, setCategory] = useState<Complaint['category']>('plumbing');
  const [priority, setPriority] = useState<Complaint['priority']>('medium');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || !userId) return;
    if (!unitId) return setError('Your membership is not linked to a flat yet. Ask the secretary to link it.');
    if (title.trim().length < 3 || description.trim().length < 5) return setError('Describe the issue in a few words.');
    setSaving(true);
    setError(null);
    const { data, error: insErr } = await supabase
      .from('complaints')
      .insert({
        society_id: societyId,
        unit_id: unitId,
        user_id: userId,
        ticket_number: '', // assigned by the database
        category,
        priority,
        title: title.trim(),
        description: description.trim(),
      })
      .select('ticket_number')
      .single();
    setSaving(false);
    if (insErr) return setError(insErr.message);
    setNotice(`Ticket ${data.ticket_number} raised. The committee will update you here.`);
    setTitle('');
    setDescription('');
    setShowForm(false);
    onChanged();
  };

  const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500';

  return (
    <div className="space-y-4 text-xs">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-white">My Helpdesk Tickets</h2>
        <button onClick={() => setShowForm(v => !v)} className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer">
          {showForm ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
          <span>{showForm ? 'Close' : 'New Ticket'}</span>
        </button>
      </div>
      <Banner tone="success">{notice}</Banner>

      {showForm && (
        <form onSubmit={submit} className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
          <Banner tone="error">{error}</Banner>
          <div className="grid grid-cols-2 gap-2">
            <select value={category} onChange={e => setCategory(e.target.value as Complaint['category'])} className={inputClass}>
              {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <select value={priority} onChange={e => setPriority(e.target.value as Complaint['priority'])} className={inputClass}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
          <input value={title} onChange={e => setTitle(e.target.value)} maxLength={191} placeholder="Short title, e.g. Water leaking from ceiling" className={inputClass} />
          <textarea rows={4} value={description} onChange={e => setDescription(e.target.value)} placeholder="Details: where, since when, best time to visit…" className={inputClass} />
          <button type="submit" disabled={saving} className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Raise Ticket
          </button>
        </form>
      )}

      {complaints.length === 0 && !loading ? (
        <EmptyState icon={MessageSquare} title="No Tickets Yet" description="Raise a ticket for plumbing, electrical, lift or parking issues." />
      ) : (
        complaints.map(c => (
          <div key={c.id} className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
            <button onClick={() => setOpenId(openId === c.id ? null : c.id)} className="w-full flex items-center justify-between gap-2 text-left cursor-pointer">
              <div className="min-w-0">
                <div className="font-mono text-[11px] text-slate-400">{c.ticket_number} • {new Date(c.created_at).toLocaleDateString('en-IN')}</div>
                <h4 className="font-bold text-white text-sm truncate">{c.title}</h4>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold ${
                  c.status === 'resolved' || c.status === 'closed' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'
                }`}>{c.status.replace('_', ' ')}</span>
                {openId === c.id ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
              </div>
            </button>
            {openId === c.id && <ComplaintThread complaint={c} currentUserId={userId} canManage={false} onChanged={onChanged} />}
          </div>
        ))
      )}
    </div>
  );
};
