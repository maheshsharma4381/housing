'use client';

import React, { useMemo, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { normalizeMobile, parseOwnerPaste, formatMobile } from '../lib/mobile';
import { Banner } from './Banner';
import { Loader2, ClipboardPaste } from 'lucide-react';

const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500';

const saveRows = async (societyId: string, rows: { unit_id: string; name: string; mobile: string }[]) => {
  if (!supabase) return { error: 'Not connected', count: 0 };
  const { data, error } = await supabase.rpc('set_flat_owner_contacts', { p_society_id: societyId, p_rows: rows });
  return { error: error?.message ?? null, count: Number(data ?? 0) };
};

/** One flat's expected owner (031): the joining link lets this mobile in as the flat's owner. */
export const OwnerContactEdit: React.FC<{
  societyId: string; unitId: string; name?: string | null; mobile?: string | null; onDone: () => void;
}> = ({ societyId, unitId, name, mobile, onDone }) => {
  const [form, setForm] = useState({ name: name ?? '', mobile: mobile ? formatMobile(mobile) : '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (form.mobile.trim() && !normalizeMobile(form.mobile)) return setError(`Mobile ${form.mobile} is not a valid number`);
    setBusy(true);
    setError(null);
    const r = await saveRows(societyId, [{ unit_id: unitId, name: form.name, mobile: form.mobile }]);
    setBusy(false);
    if (r.error) return setError(r.error);
    onDone();
  };

  return (
    <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
      <Banner tone="error">{error}</Banner>
      <input className={inputClass} placeholder="Owner name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
      <input className={inputClass} placeholder="Owner mobile" inputMode="tel" value={form.mobile} onChange={e => setForm(f => ({ ...f, mobile: e.target.value }))} />
      <p className="text-slate-500">When this mobile logs in through your joining link, it joins this flat as the owner.</p>
      <button onClick={save} disabled={busy} className="px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer disabled:opacity-50 flex items-center gap-1.5">
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save
      </button>
    </div>
  );
};

/** "Paste owners from Excel": flat number, owner name, mobile on each line. */
export const OwnerPaste: React.FC<{
  societyId: string; units: { id: string; unit_number: string }[]; onDone: () => void;
}> = ({ societyId, units, onDone }) => {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const parsed = useMemo(() => (text.trim() ? parseOwnerPaste(text, units) : null), [text, units]);

  const save = async () => {
    if (!parsed || parsed.rows.length === 0) return;
    setBusy(true);
    setError(null);
    const r = await saveRows(societyId, parsed.rows);
    setBusy(false);
    if (r.error) return setError(r.error);
    setNotice(`Saved owners for ${r.count} flats.`);
    setText('');
    onDone();
  };

  return (
    <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-3 text-xs">
      <p className="text-slate-400">
        Copy three columns from Excel — <strong className="text-white">flat number, owner name, mobile</strong> — and paste them here.
      </p>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>
      <textarea
        rows={6}
        value={text}
        onChange={e => { setText(e.target.value); setNotice(null); }}
        placeholder={'A-101\tAsha Rao\t98765 43210\nA-102\tRavi Kumar\t98111 22222'}
        className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 font-mono text-[11px] text-white outline-none focus:border-sky-500"
      />
      {parsed && (
        <div className="space-y-1 text-slate-300">
          <div><strong className="text-white">{parsed.rows.length}</strong> flats matched</div>
          {parsed.unknownFlats.length > 0 && (
            <div className="text-amber-300">Not a flat in this society: {parsed.unknownFlats.join(', ')}</div>
          )}
          {parsed.badMobiles.length > 0 && (
            <div className="text-rose-300">Mobile not valid (skipped): {parsed.badMobiles.join('; ')}</div>
          )}
        </div>
      )}
      <button
        onClick={save}
        disabled={busy || !parsed || parsed.rows.length === 0}
        className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardPaste className="w-4 h-4" />}
        <span>Save owners</span>
      </button>
    </div>
  );
};
