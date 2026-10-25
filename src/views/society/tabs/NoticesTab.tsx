'use client';

import React, { useState } from 'react';
import { supabase } from '../../../lib/supabase/client';
import { Banner } from '../../../components/Banner';
import { EmptyState } from '../../../components/EmptyState';
import { Notice } from '../../../types/database';
import { FileText, Pin, PinOff, Trash2, Send, Loader2 } from 'lucide-react';

const CATEGORIES: { value: Notice['category']; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'maintenance', label: 'Maintenance work' },
  { value: 'water_power', label: 'Water / Power' },
  { value: 'agm_egm', label: 'AGM / EGM' },
  { value: 'emergency', label: 'Emergency' },
];

const AUDIENCES: { value: Notice['target_audience']; label: string }[] = [
  { value: 'all', label: 'Everyone' },
  { value: 'owners_only', label: 'Owners only' },
  { value: 'tenants_only', label: 'Tenants only' },
  { value: 'committee_only', label: 'Committee only' },
];

const EXPIRY_OPTIONS = [
  { days: 0, label: 'Never expires' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

interface NoticesTabProps {
  societyId: string;
  currentUserId?: string;
  notices: Notice[];
  onChanged: () => void;
}

export const NoticesTab: React.FC<NoticesTabProps> = ({ societyId, currentUserId, notices, onChanged }) => {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState<Notice['category']>('general');
  const [audience, setAudience] = useState<Notice['target_audience']>('all');
  const [expiryDays, setExpiryDays] = useState(0);
  const [pinned, setPinned] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const publish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || !currentUserId) return;
    if (title.trim().length < 3 || content.trim().length < 3) {
      setError('Add a title and the notice text.');
      return;
    }
    setSaving(true);
    setError(null);
    const { error: insErr } = await supabase.from('notices').insert({
      society_id: societyId,
      title: title.trim(),
      content: content.trim(),
      category,
      target_audience: audience,
      is_pinned: pinned,
      expires_at: expiryDays ? new Date(Date.now() + expiryDays * 86_400_000).toISOString() : null,
      published_by: currentUserId,
    });
    setSaving(false);
    if (insErr) return setError(insErr.message);
    setTitle('');
    setContent('');
    setPinned(false);
    setNotice('Notice published. Members see it on their dashboard right away.');
    onChanged();
  };

  const togglePin = async (n: Notice) => {
    if (!supabase) return;
    const { error: updErr } = await supabase.from('notices').update({ is_pinned: !n.is_pinned }).eq('id', n.id);
    if (updErr) setError(updErr.message);
    onChanged();
  };

  const remove = async (n: Notice) => {
    if (!supabase || !window.confirm(`Delete notice "${n.title}"?`)) return;
    const { error: delErr } = await supabase.from('notices').delete().eq('id', n.id);
    if (delErr) setError(delErr.message);
    onChanged();
  };

  const sorted = [...notices].sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || b.published_at.localeCompare(a.published_at));
  const isExpired = (n: Notice) => Boolean(n.expires_at && new Date(n.expires_at) < new Date());
  const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500';

  return (
    <div className="space-y-6 text-xs">
      <div>
        <h2 className="text-lg font-bold text-white">Notice Board</h2>
        <p className="text-slate-400">Official circulars replace WhatsApp forwards — members see only notices meant for them.</p>
      </div>

      <form onSubmit={publish} className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
        <Banner tone="error">{error}</Banner>
        <Banner tone="success">{notice}</Banner>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title, e.g. Water supply interruption on Sunday" className={inputClass} />
        <textarea rows={4} value={content} onChange={e => setContent(e.target.value)} placeholder="Notice text" className={inputClass} />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <select value={category} onChange={e => setCategory(e.target.value as Notice['category'])} className={inputClass}>
            {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <select value={audience} onChange={e => setAudience(e.target.value as Notice['target_audience'])} className={inputClass}>
            {AUDIENCES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
          <select value={expiryDays} onChange={e => setExpiryDays(Number(e.target.value))} className={inputClass}>
            {EXPIRY_OPTIONS.map(o => <option key={o.days} value={o.days}>{o.label}</option>)}
          </select>
          <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
            <input type="checkbox" checked={pinned} onChange={e => setPinned(e.target.checked)} /> Pin to top
          </label>
        </div>
        <button type="submit" disabled={saving} className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Publish Notice
        </button>
      </form>

      {sorted.length === 0 ? (
        <EmptyState icon={FileText} title="No Notices Yet" description="Publish circulars or AGM announcements for members." />
      ) : (
        <div className="space-y-2">
          {sorted.map(n => (
            <div key={n.id} className={`p-4 rounded-2xl bg-slate-900 border space-y-1.5 ${n.is_pinned ? 'border-sky-500/40' : 'border-slate-800'} ${isExpired(n) ? 'opacity-50' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                    <span className="font-semibold text-sky-400">{CATEGORIES.find(c => c.value === n.category)?.label}</span>
                    <span>• {AUDIENCES.find(a => a.value === n.target_audience)?.label}</span>
                    <span>• {new Date(n.published_at).toLocaleDateString('en-IN')}</span>
                    {isExpired(n) && <span className="text-rose-300">• expired</span>}
                  </div>
                  <h4 className="font-bold text-white text-sm">{n.title}</h4>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => togglePin(n)} title={n.is_pinned ? 'Unpin' : 'Pin'} className="text-slate-400 hover:text-sky-300 cursor-pointer">
                    {n.is_pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
                  </button>
                  <button onClick={() => remove(n)} title="Delete" className="text-slate-500 hover:text-rose-400 cursor-pointer">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <p className="text-slate-300 whitespace-pre-line">{n.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
