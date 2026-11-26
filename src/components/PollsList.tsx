'use client';
// Phase 10: the society's polls, newest open ones first; the committee also gets the "New poll" form.
import React, { useCallback, useEffect, useState } from 'react';
import { Plus, X, Loader2, Vote } from 'lucide-react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import { EmptyState } from './EmptyState';
import { PollCard, type PollRow } from './PollCard';
import { cleanOptions, pollDraftError } from '../lib/polls';

const localInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const defaultClose = () => { const d = new Date(Date.now() + 3 * 86400_000); d.setHours(20, 0, 0, 0); return localInput(d); };

export const PollsList: React.FC<{ societyId: string; isCommittee: boolean; canManage: boolean }> = ({ societyId, isCommittee, canManage }) => {
  const [polls, setPolls] = useState<PollRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [question, setQuestion] = useState('');
  const [details, setDetails] = useState('');
  const [options, setOptions] = useState(['Yes', 'No']);
  const [closes, setCloses] = useState(defaultClose);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data } = await supabase.from('polls').select('id, question, details, options, closes_at, closed_at, created_at')
      .eq('society_id', societyId).order('created_at', { ascending: false }).limit(100);
    setPolls((data as PollRow[]) ?? []);
    setLoading(false);
  }, [societyId]);

  useEffect(() => { void load(); }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    const closesAt = new Date(closes);
    const problem = pollDraftError({ question, details, options, closesAt }, new Date());
    if (problem) return setError(problem);
    setSaving(true);
    setError(null);
    const { error: err } = await supabase.rpc('create_poll', {
      p_society_id: societyId, p_question: question.trim(), p_details: details.trim(),
      p_options: cleanOptions(options), p_closes_at: closesAt.toISOString(),
    });
    setSaving(false);
    if (err) return setError(err.message);
    setQuestion(''); setDetails(''); setOptions(['Yes', 'No']); setCloses(defaultClose());
    setDone('Poll opened. Owners have been told.');
    void load();
  };

  const isOpen = (p: PollRow) => !p.closed_at && new Date(p.closes_at) > new Date();
  const sorted = [...polls].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)));
  const inputClass = 'w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand';

  return (
    <div className="space-y-4 text-sm">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-fg">Polls</h2>
        <p className="text-fg-muted">Ask owners before the AGM. One vote per flat.</p>
      </div>

      {canManage && (
        <form onSubmit={create} className="p-5 rounded-xl bg-surface border border-border space-y-3">
          <Banner tone="error">{error}</Banner>
          <Banner tone="success">{done}</Banner>
          <input value={question} onChange={e => setQuestion(e.target.value)} maxLength={200} placeholder="Question, e.g. Repair the lift for Rs 4 lakh?" className={inputClass} />
          <textarea rows={2} value={details} onChange={e => setDetails(e.target.value)} maxLength={1000} placeholder="Details (optional)" className={inputClass} />
          <div className="space-y-1.5">
            {options.map((o, i) => (
              <div key={i} className="flex gap-2">
                <input value={o} maxLength={80} onChange={e => setOptions(os => os.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Option ${i + 1}`} className={inputClass} />
                {options.length > 2 && (
                  <button type="button" onClick={() => setOptions(os => os.filter((_, j) => j !== i))} title="Remove option" className="text-fg-subtle hover:text-danger cursor-pointer"><X className="w-4 h-4" /></button>
                )}
              </div>
            ))}
            {options.length < 6 && (
              <button type="button" onClick={() => setOptions(os => [...os, ''])} className="flex items-center gap-1 text-brand cursor-pointer"><Plus className="w-4 h-4" /> Add option</button>
            )}
          </div>
          <label className="block text-fg">Closes on
            <input type="datetime-local" value={closes} onChange={e => setCloses(e.target.value)} className={`${inputClass} mt-1`} />
          </label>
          <button type="submit" disabled={saving} className="w-full py-2.5 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Vote className="w-4 h-4" />} Open poll
          </button>
        </form>
      )}

      {!loading && sorted.length === 0 && (
        <EmptyState icon={Vote} title="No polls yet" description={canManage ? 'Open a poll to hear owners before the AGM.' : 'The committee has not opened a poll yet.'} />
      )}
      {sorted.map(p => <PollCard key={p.id} poll={p} isCommittee={isCommittee} canManage={canManage} onChanged={load} />)}
    </div>
  );
};
