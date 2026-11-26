'use client';
// Phase 10: one poll. Owners vote per flat; the committee sees live counts and which flats voted (never how);
// residents see counts after the poll closes.
import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Download, Lock, Trash2, CheckCircle2 } from 'lucide-react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import { flatLabels } from '../lib/flat-label';
import { POLL_FOOTNOTE, pollResultCsv } from '../lib/polls';
import { downloadCsv } from '../lib/csv-export';
import { confirmDialog } from './ui/feedback';

export interface PollRow {
  id: string; question: string; details: string | null; options: string[]; closes_at: string; closed_at: string | null; created_at: string;
}
interface MyFlat { unit_id: string; wing: string | null; unit_number: string; choice: number | null }
interface PollView { open: boolean; my_flats: MyFlat[]; counts: number[] | null; voted: number; eligible: number }
interface FlatStatus { wing: string | null; unit_number: string; voted: boolean }

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export const PollCard: React.FC<{ poll: PollRow; isCommittee: boolean; canManage: boolean; onChanged: () => void }> = ({ poll, isCommittee, canManage, onChanged }) => {
  const [view, setView] = useState<PollView | null>(null);
  const [flats, setFlats] = useState<FlatStatus[] | null>(null);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data, error: err } = await supabase.rpc('poll_view', { p_poll_id: poll.id });
    if (err) return setError(err.message);
    setView(data as PollView);
    if (isCommittee) {
      const { data: f } = await supabase.rpc('poll_flats', { p_poll_id: poll.id });
      setFlats((f as FlatStatus[]) ?? []);
    }
  }, [poll.id, isCommittee]);

  useEffect(() => { void load(); }, [load]);

  const act = async (key: string, fn: () => PromiseLike<{ error: { message: string } | null }>, after?: () => void) => {
    setBusy(key);
    setError(null);
    const { error: err } = await fn();
    setBusy(null);
    if (err) return setError(err.message);
    after?.();
    await load();
  };

  const vote = (unitId: string) => {
    const choice = picked[unitId];
    if (choice === undefined || !supabase) return;
    const client = supabase;
    void act(`vote-${unitId}`, () => client.rpc('cast_poll_vote', { p_poll_id: poll.id, p_unit_id: unitId, p_option_index: choice }));
  };
  const close = async () => {
    if (!supabase || !(await confirmDialog({ title: 'Close this poll now?', body: 'Nobody can vote after this.', confirmText: 'Close poll' }))) return;
    const client = supabase;
    void act('close', () => client.rpc('close_poll', { p_poll_id: poll.id }), onChanged);
  };
  const remove = async () => {
    if (!supabase || !(await confirmDialog({ title: 'Delete this poll?', body: 'Its votes are deleted too. This cannot be undone.', confirmText: 'Delete poll', tone: 'danger' }))) return;
    const client = supabase;
    void act('delete', () => client.rpc('delete_poll', { p_poll_id: poll.id }), onChanged);
  };

  const flatLabelList = flats ? flatLabels(flats) : [];
  const myLabels = view ? flatLabels(view.my_flats) : [];
  const download = () => {
    if (!view?.counts || !flats) return;
    const csv = pollResultCsv(poll, view.counts, flats.map((f, i) => ({ label: flatLabelList[i], voted: f.voted })));
    downloadCsv(`poll-${poll.created_at.slice(0, 10)}.csv`, csv);
  };

  const total = view?.counts?.reduce((a, b) => a + b, 0) ?? 0;
  const open = view?.open ?? false;

  return (
    <div className="p-4 rounded-xl bg-surface border border-border space-y-3 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-fg-muted">
            {open ? `Open · closes ${when(poll.closes_at)}` : `Closed ${when(poll.closed_at ?? poll.closes_at)}`}
          </div>
          <h4 className="font-semibold text-fg text-sm">{poll.question}</h4>
          {poll.details && <p className="text-fg whitespace-pre-line mt-1">{poll.details}</p>}
        </div>
        {canManage && (
          <div className="flex items-center gap-2 shrink-0">
            {open && (
              <button onClick={close} disabled={busy !== null} title="Close now" className="flex items-center gap-1 text-fg hover:text-warning cursor-pointer">
                <Lock className="w-4 h-4" /> Close now
              </button>
            )}
            {view && view.voted === 0 && (
              <button onClick={remove} disabled={busy !== null} title="Delete" className="text-fg-subtle hover:text-danger cursor-pointer">
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
      </div>

      <Banner tone="error">{error}</Banner>
      {!view && !error && <Loader2 className="w-4 h-4 animate-spin text-fg-subtle" />}

      {view?.counts && (
        <div className="space-y-1.5">
          {poll.options.map((o, i) => {
            const n = view.counts?.[i] ?? 0;
            const pct = total ? Math.round((n / total) * 100) : 0;
            return (
              <div key={i}>
                <div className="flex justify-between text-fg"><span>{o}</span><span className="font-mono">{n}</span></div>
                <div className="h-2 rounded-full bg-surface-muted overflow-hidden"><div className="h-full bg-brand" style={{ width: `${pct}%` }} /></div>
              </div>
            );
          })}
        </div>
      )}

      {view && (
        <div className="text-fg-muted">Voted: {view.voted} of {view.eligible} flats</div>
      )}

      {view && view.my_flats.map((f, i) => (
        <div key={f.unit_id} className="p-3 rounded-xl bg-canvas border border-border space-y-2">
          <div className="font-semibold text-fg">
            Flat {myLabels[i]}
            {f.choice !== null && <span className="ml-2 text-success font-normal"><CheckCircle2 className="inline w-3.5 h-3.5" /> Your flat chose “{poll.options[f.choice]}”</span>}
          </div>
          {open && (
            <>
              <div className="grid gap-1.5">
                {poll.options.map((o, oi) => (
                  <label key={oi} className="flex items-center gap-2 text-fg cursor-pointer">
                    <input type="radio" name={`${poll.id}-${f.unit_id}`} checked={(picked[f.unit_id] ?? f.choice) === oi}
                      onChange={() => setPicked(p => ({ ...p, [f.unit_id]: oi }))} />
                    {o}
                  </label>
                ))}
              </div>
              <button onClick={() => vote(f.unit_id)} disabled={picked[f.unit_id] === undefined || busy !== null}
                className="px-3 py-1.5 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold disabled:opacity-50 cursor-pointer">
                {busy === `vote-${f.unit_id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : f.choice === null ? 'Vote' : 'Change vote'}
              </button>
            </>
          )}
        </div>
      ))}

      {view && !isCommittee && view.my_flats.length === 0 && open && (
        <div className="text-fg-muted">Only owners vote. One vote per flat.</div>
      )}

      {isCommittee && flats && (
        <details className="text-fg-muted">
          <summary className="cursor-pointer">Flats not voted ({flats.filter(f => !f.voted).length})</summary>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {flats.map((f, i) => !f.voted && <span key={i} className="px-2 py-0.5 rounded bg-surface-muted">{flatLabelList[i]}</span>)}
          </div>
        </details>
      )}

      {isCommittee && view?.counts && flats && (
        <button onClick={download} className="flex items-center gap-1.5 text-brand hover:text-brand-ink cursor-pointer">
          <Download className="w-4 h-4" /> Download result
        </button>
      )}

      <p className="text-xs text-fg-subtle">{POLL_FOOTNOTE}</p>
    </div>
  );
};
