'use client';
// Phase 11B: the committee's tenant settings — the documents asked for, and non-occupancy charges.
import React, { useEffect, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import type { ChecklistItem } from '../lib/requests';

export const TenancySettings: React.FC<{ societyId: string }> = ({ societyId }) => {
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [pct, setPct] = useState('0');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    void supabase.from('request_checklists').select('checklist').eq('society_id', societyId).eq('kind', 'tenancy').maybeSingle()
      .then(({ data }) => setItems(((data as { checklist: ChecklistItem[] } | null)?.checklist) ?? []));
    void supabase.from('society_settings').select('non_occupancy_percent').eq('society_id', societyId).maybeSingle()
      .then(({ data }) => setPct(String((data as { non_occupancy_percent: number } | null)?.non_occupancy_percent ?? 0)));
  }, [societyId]);

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key); setError(null); setDone(null);
    try { setDone(await fn()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  };
  const saveList = () => run('list', async () => {
    if (!supabase) return '';
    const { data, error: err } = await supabase.rpc('save_request_checklist', { p_society_id: societyId, p_kind: 'tenancy', p_checklist: items.filter(i => i.label.trim()) });
    if (err) throw new Error(err.message);
    setItems(data as ChecklistItem[]);
    return 'Tenant documents saved. New registrations ask for this list.';
  });
  const savePct = () => run('pct', async () => {
    if (!supabase) return '';
    const { error: err } = await supabase.rpc('set_non_occupancy_percent', { p_society_id: societyId, p_percent: Number(pct) });
    if (err) throw new Error(err.message);
    return Number(pct) > 0 ? `Let flats get ${pct}% non-occupancy charges from the next bills.` : 'Non-occupancy charges are off.';
  });
  const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500';

  return (
    <div className="space-y-4 text-xs">
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{done}</Banner>
      <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
        <div className="font-bold text-white">Documents for a tenant registration</div>
        {items.map((c, i) => (
          <div key={i} className="flex gap-2 items-center">
            <input value={c.label} maxLength={120} onChange={e => setItems(items.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} className={inputClass} />
            <label className="flex items-center gap-1 text-slate-300 shrink-0"><input type="checkbox" checked={c.required} onChange={e => setItems(items.map((x, j) => j === i ? { ...x, required: e.target.checked } : x))} /> Required</label>
            <button onClick={() => setItems(items.filter((_, j) => j !== i))} className="text-slate-500 hover:text-rose-300 cursor-pointer">Remove</button>
          </div>
        ))}
        {items.length < 10 && <button onClick={() => setItems([...items, { key: '', label: '', required: false }])} className="flex items-center gap-1 text-sky-300 cursor-pointer"><Plus className="w-4 h-4" /> Add a document</button>}
        <button onClick={saveList} disabled={busy !== null} className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold disabled:opacity-50 cursor-pointer">{busy === 'list' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save list'}</button>
      </div>
      <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
        <div className="font-bold text-white">Non-occupancy charges</div>
        <p className="text-slate-400">Added to the bill of a let flat, as a % of its service charges: charges credited to Maintenance Charges and not ticked as municipal tax (sinking fund, repair fund and parking are left out). The law allows at most 10%; 0 means off. Charge only what your general body has passed.</p>
        <div className="flex gap-2 items-center">
          <input type="number" min={0} max={10} step={0.5} value={pct} onChange={e => setPct(e.target.value)} className="w-24 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white" />
          <span className="text-slate-300">%</span>
          <button onClick={savePct} disabled={busy !== null} className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold disabled:opacity-50 cursor-pointer">{busy === 'pct' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}</button>
        </div>
      </div>
    </div>
  );
};
