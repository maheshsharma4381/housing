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
const SEVERITY_STYLES = { info: 'text-fg-muted', minor: 'text-warning', major: 'text-danger font-semibold' };
const STATUS_STYLES = { open: 'bg-warning-soft text-warning', responded: 'bg-brand-soft text-brand', closed: 'bg-success-soft text-success' };

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

  const inputClass = 'bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand';
  const openCount = remarks.filter(r => r.status === 'open').length;

  return (
    <div className="space-y-4 text-xs">
      <div>
        <h2 className="text-lg font-semibold text-fg flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-success" /> Audit Remarks</h2>
        <p className="text-fg-muted">
          {mode === 'professional'
            ? 'Record observations for the committee. They respond here; close a remark once satisfied.'
            : `Observations from your CA / auditor. ${openCount} awaiting your response.`}
        </p>
      </div>
      <Banner tone="error">{error}</Banner>

      {mode === 'professional' && (
        <form onSubmit={add} className="p-4 rounded-xl bg-surface border border-border space-y-2">
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
          <button type="submit" disabled={busy === 'new' || text.trim().length < 3} className="w-full py-2 rounded-lg bg-warning-solid hover:bg-warning-solid text-on-brand font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
            {busy === 'new' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Add Remark
          </button>
        </form>
      )}

      {remarks.length === 0 && !loading ? (
        <EmptyState icon={ShieldCheck} title="No Remarks" description={mode === 'professional' ? 'Your observations will appear here.' : 'Your auditor has not raised any observations.'} />
      ) : (
        remarks.map(r => (
          <div key={r.id} className="p-4 rounded-xl bg-surface border border-border space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap gap-2 text-xs text-fg-muted">
                  <span className="uppercase">{r.module}</span>
                  {r.reference && <span className="font-mono">• {r.reference}</span>}
                  <span className={SEVERITY_STYLES[r.severity]}>• {r.severity}</span>
                  <span>• {r.author?.full_name ?? 'Professional'} • {new Date(r.created_at).toLocaleDateString('en-IN')}</span>
                </div>
                <p className="text-fg whitespace-pre-line mt-1">{r.remark}</p>
              </div>
              <span className={`px-2 py-0.5 rounded-full text-xs uppercase font-semibold shrink-0 ${STATUS_STYLES[r.status]}`}>{r.status}</span>
            </div>

            {r.response && (
              <div className="p-2.5 rounded-xl bg-canvas border border-border text-fg">
                <strong className="text-brand">Committee:</strong> {r.response}
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
                  className="px-3 rounded-xl bg-brand hover:bg-brand-hover text-on-brand font-semibold cursor-pointer disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            )}
            {mode === 'professional' && r.author_id === currentUserId && r.status !== 'closed' && (
              <button onClick={() => update(r, { status: 'closed' })} disabled={busy !== null} className="flex items-center gap-1 text-success hover:underline cursor-pointer disabled:opacity-50">
                <CheckCircle2 className="w-3.5 h-3.5" /> Close remark
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
};
