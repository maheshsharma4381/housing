'use client';
// Phase 10: who has seen a notice. Loads on demand so a long notice board makes no calls until asked.
import React, { useState } from 'react';
import { Eye, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase/client';
import { flatLabels } from '../lib/flat-label';

interface Summary { seen: number; total: number; not_seen: { name: string; wing: string | null; unit_number: string | null }[] }

export const NoticeSeen: React.FC<{ noticeId: string }> = ({ noticeId }) => {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (open) return setOpen(false);
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase.rpc('notice_read_summary', { p_notice_id: noticeId });
    setBusy(false);
    if (err) return setError(err.message);
    setSummary(data as Summary);
    setOpen(true);
  };

  const people = summary?.not_seen ?? [];
  const labels = flatLabels(people.filter(p => p.unit_number).map(p => ({ wing: p.wing, unit_number: p.unit_number as string })));
  let li = 0;

  return (
    <div className="pt-1">
      <button onClick={load} className="flex items-center gap-1.5 text-xs text-fg-muted hover:text-brand cursor-pointer">
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
        {summary ? `Seen by ${summary.seen} of ${summary.total}` : 'Who has seen it'}
      </button>
      {error && <div className="text-danger text-xs">{error}</div>}
      {open && summary && (
        people.length === 0
          ? <div className="text-success text-xs mt-1">{summary.total === 0 ? 'Nobody outside the committee is in this notice’s audience.' : 'Everyone has seen it.'}</div>
          : (
            <div className="mt-1.5 p-2.5 rounded-xl bg-canvas border border-border">
              <div className="text-xs font-semibold text-fg mb-1">Not seen yet</div>
              <ul className="space-y-0.5 text-xs text-fg-muted">
                {people.map((p, i) => (
                  <li key={i}>{p.name}{p.unit_number ? ` · Flat ${labels[li++]}` : ''}</li>
                ))}
              </ul>
            </div>
          )
      )}
    </div>
  );
};
