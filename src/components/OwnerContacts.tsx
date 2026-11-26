'use client';

import React, { useMemo, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { normalizeMobile, parseOwnerPaste, formatMobile, type OwnerContactRow } from '../lib/mobile';
import { Banner } from './Banner';
import { Loader2, ClipboardPaste } from 'lucide-react';

const inputClass = 'w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand';

const saveRows = async (societyId: string, rows: OwnerContactRow[]) => {
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
    <div className="p-3 rounded-xl bg-canvas border border-border space-y-2">
      <Banner tone="error">{error}</Banner>
      <input className={inputClass} placeholder="Owner name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
      <input className={inputClass} placeholder="Owner mobile" inputMode="tel" value={form.mobile} onChange={e => setForm(f => ({ ...f, mobile: e.target.value }))} />
      <p className="text-fg-subtle">When this mobile logs in through your joining link, it joins this flat as the owner.</p>
      <button onClick={save} disabled={busy} className="px-3 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold cursor-pointer disabled:opacity-50 flex items-center gap-1.5">
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
    <div className="p-5 rounded-xl bg-surface border border-border space-y-3 text-xs">
      <p className="text-fg-muted">
        Copy three columns from Excel — <strong className="text-fg">flat number, owner name, mobile</strong> — and paste them here.
        An empty cell leaves what is saved for that flat as it is.
      </p>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>
      <textarea
        rows={6}
        value={text}
        onChange={e => { setText(e.target.value); setNotice(null); }}
        placeholder={'A-101\tAsha Rao\t98765 43210\nA-102\tRavi Kumar\t98111 22222'}
        className="w-full bg-surface border border-border-strong rounded-lg p-3 font-mono text-xs text-fg outline-none focus:border-brand"
      />
      {parsed && (
        <div className="space-y-1 text-fg">
          <div><strong className="text-fg">{parsed.rows.length}</strong> flats matched</div>
          {parsed.unknownFlats.length > 0 && (
            <div className="text-warning">Not a flat in this society: {parsed.unknownFlats.join(', ')}</div>
          )}
          {parsed.badMobiles.length > 0 && (
            <div className="text-danger">Mobile not valid (skipped): {parsed.badMobiles.join('; ')}</div>
          )}
        </div>
      )}
      <button
        onClick={save}
        disabled={busy || !parsed || parsed.rows.length === 0}
        className="w-full py-2.5 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardPaste className="w-4 h-4" />}
        <span>Save owners</span>
      </button>
    </div>
  );
};
