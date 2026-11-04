'use client';

import React, { useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import { Loader2 } from 'lucide-react';

/**
 * Which flats a charge applies to (033): all flats, or only the chosen ones (parking, for example).
 * A chosen-flats charge bills no flat until flats are chosen.
 */
export const RuleFlats: React.FC<{
  ruleId: string; selected: boolean; units: { id: string; unit_number: string }[]; canManage: boolean; onChanged: () => void;
}> = ({ ruleId, selected, units, canManage, onChanged }) => {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openPicker = async () => {
    if (!supabase) return;
    setError(null);
    const { data, error: err } = await supabase.from('billing_rule_units').select('unit_id').eq('rule_id', ruleId);
    if (err) return setError(err.message);
    setChosen(new Set((data ?? []).map(r => r.unit_id as string)));
    setOpen(true);
  };

  const save = async () => {
    if (!supabase) return;
    setBusy(true);
    const { error: err } = await supabase.rpc('set_rule_flats', { p_rule_id: ruleId, p_unit_ids: [...chosen] });
    setBusy(false);
    if (err) return setError(err.message);
    setOpen(false);
    onChanged();
  };

  const allFlats = async () => {
    if (!supabase) return;
    const { error: err } = await supabase.from('billing_rules').update({ applies_to_selected: false }).eq('id', ruleId);
    if (err) return setError(err.message);
    onChanged();
  };

  const sorted = [...units].sort((a, b) => a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true }));

  return (
    <div className="space-y-2">
      <div className="text-slate-400">
        Charged to: <strong className="text-white">{selected ? 'chosen flats' : 'all flats'}</strong>
        {canManage && (
          <>
            {' · '}
            <button onClick={openPicker} className="text-sky-400 hover:underline cursor-pointer">Choose flats</button>
            {selected && <>{' · '}<button onClick={allFlats} className="text-sky-400 hover:underline cursor-pointer">All flats</button></>}
          </>
        )}
      </div>
      <Banner tone="error">{error}</Banner>
      {open && (
        <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 max-h-48 overflow-y-auto">
            {sorted.map(u => (
              <label key={u.id} className="flex items-center gap-1.5 text-slate-300">
                <input
                  type="checkbox" checked={chosen.has(u.id)}
                  onChange={() => setChosen(s => { const n = new Set(s); if (n.has(u.id)) n.delete(u.id); else n.add(u.id); return n; })}
                />
                {u.unit_number}
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={busy} className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer disabled:opacity-50 flex items-center gap-1.5">
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Charge {chosen.size} flats
            </button>
            <button onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 cursor-pointer">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
};
