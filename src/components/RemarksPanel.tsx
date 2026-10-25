'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import { EmptyState } from './EmptyState';
import { ShieldCheck, Send, Loader2, CheckCircle2 } from 'lucide-react';

interface Remark {
  id: string;
  author_id: string;
  module: string;
  reference: string | null;
  remark: string;
  severity: 'info' | 'minor' | 'major';
  status: 'open' | 'responded' | 'closed';
  response: string | null;
  responded_at: string | null;
  created_at: string;
  author: { full_name: string } | null;
}

const MODULES = ['general', 'billing', 'payments', 'expenses', 'gst', 'ledger', 'documents'];
const SEVERITY_STYLES = { info: 'text-slate-400', minor: 'text-amber-300', major: 'text-rose-400 font-bold' };
const STATUS_STYLES = { open: 'bg-amber-500/10 text-amber-300', responded: 'bg-sky-500/10 text-sky-300', closed: 'bg-emerald-500/10 text-emerald-300' };

interface RemarksPanelProps {
  societyId: string;
  currentUserId?: string;
  /** professional: writes remarks and closes them; committee: responds */
  mode: 'professional' | 'committee';
}

export const RemarksPanel: React.FC<RemarksPanelProps> = ({ societyId, currentUserId, mode }) => {
  const [remarks, setRemarks] = useState<Remark[]>([]);
  const [loading, setLoading] = useState(true);
  const [module, setModule] = useState('general');
  const [severity, setSeverity] = useState<Remark['severity']>('minor');
  const [reference, setReference] = useState('');
  const [text, setText] = useState('');
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const { data, error: loadErr } = await supabase
      .from('audit_remarks')
      .select('*, author:author_id (full_name)')
      .eq('society_id', societyId)
      .order('created_at', { ascending: false });
    if (loadErr) setError(loadErr.message);
    setRemarks(((data ?? []) as unknown) as Remark[]);
    setLoading(false);
  }, [societyId]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || !currentUserId || text.trim().length < 3) return;
    setBusy('new');
    const { error: insErr } = await supabase.from('audit_remarks').insert({
      society_id: societyId,
      author_id: currentUserId,
      module,
      severity,
      reference: reference.trim() || null,
      remark: text.trim(),
    });
    setBusy(null);
    if (insErr) return setError(insErr.message);
    setText('');
    setReference('');
    setError(null);
    load();
  };

  const update = async (r: Remark, patch: Partial<Pick<Remark, 'response' | 'status'>>) => {
    if (!supabase) return;
    setBusy(r.id);
    const { error: updErr } = await supabase.from('audit_remarks').update(patch).eq('id', r.id);
    setBusy(null);
    if (updErr) return setError(updErr.message);
    setError(null);
    load();
  };

  const inputClass = 'bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500';
  const openCount = remarks.filter(r => r.status === 'open').length;

  return (
    <div className="space-y-4 text-xs">
      <div>
        <h2 className="text-lg font-bold text-white flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-emerald-400" /> Audit Remarks</h2>
        <p className="text-slate-400">
          {mode === 'professional'
            ? 'Record observations for the committee. They respond here; close a remark once satisfied.'
            : `Observations from your CA / auditor. ${openCount} awaiting your response.`}
        </p>
      </div>
      <Banner tone="error">{error}</Banner>

      {mode === 'professional' && (
        <form onSubmit={add} className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <select value={module} onChange={e => setModule(e.target.value)} className={inputClass}>
              {MODULES.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <select value={severity} onChange={e => setSeverity(e.target.value as Remark['severity'])} className={inputClass}>
              <option value="info">Info</option><option value="minor">Minor</option><option value="major">Major</option>
            </select>
            <input value={reference} onChange={e => setReference(e.target.value)} placeholder="Ref (EXP-0004, bill no…)" className={inputClass} />
          </div>
          <textarea rows={3} value={text} onChange={e => setText(e.target.value)} placeholder="Observation, e.g. Lift AMC invoice lacks a signed work order" className={`w-full ${inputClass}`} />
          <button type="submit" disabled={busy === 'new' || text.trim().length < 3} className="w-full py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
            {busy === 'new' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Add Remark
          </button>
        </form>
      )}

      {remarks.length === 0 && !loading ? (
        <EmptyState icon={ShieldCheck} title="No Remarks" description={mode === 'professional' ? 'Your observations will appear here.' : 'Your auditor has not raised any observations.'} />
      ) : (
        remarks.map(r => (
          <div key={r.id} className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap gap-2 text-[11px] text-slate-400">
                  <span className="uppercase">{r.module}</span>
                  {r.reference && <span className="font-mono">• {r.reference}</span>}
                  <span className={SEVERITY_STYLES[r.severity]}>• {r.severity}</span>
                  <span>• {r.author?.full_name ?? 'Professional'} • {new Date(r.created_at).toLocaleDateString('en-IN')}</span>
                </div>
                <p className="text-slate-200 whitespace-pre-line mt-1">{r.remark}</p>
              </div>
              <span className={`px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold shrink-0 ${STATUS_STYLES[r.status]}`}>{r.status}</span>
            </div>

            {r.response && (
              <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-300">
                <strong className="text-sky-300">Committee:</strong> {r.response}
              </div>
            )}

            {mode === 'committee' && r.status !== 'closed' && (
              <div className="flex gap-2">
                <input
                  value={responses[r.id] ?? ''}
                  onChange={e => setResponses({ ...responses, [r.id]: e.target.value })}
                  placeholder={r.response ? 'Update response…' : 'Respond…'}
                  className={`flex-1 ${inputClass}`}
                />
                <button
                  onClick={() => update(r, { response: (responses[r.id] ?? '').trim() })}
                  disabled={busy !== null || !(responses[r.id] ?? '').trim()}
                  className="px-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            )}
            {mode === 'professional' && r.author_id === currentUserId && r.status !== 'closed' && (
              <button onClick={() => update(r, { status: 'closed' })} disabled={busy !== null} className="flex items-center gap-1 text-emerald-400 hover:underline cursor-pointer disabled:opacity-50">
                <CheckCircle2 className="w-3.5 h-3.5" /> Close remark
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
};
