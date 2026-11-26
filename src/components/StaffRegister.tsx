'use client';
// Phase 10: the society's staff register. The committee sees and manages everyone; a resident adds and edits
// their own staff, and sees the rest of the register without mobiles, notes or ID proofs.
import React, { useCallback, useEffect, useState } from 'react';
import { IdCard, Loader2, Plus, ShieldCheck, UserRound, Upload, Unlink, FileText } from 'lucide-react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import { EmptyState } from './EmptyState';
import { flatLabels } from '../lib/flat-label';
import { formatMobile } from '../lib/mobile';
import { STAFF_KINDS, staffKindLabel, type StaffKind, type StaffRow } from '../lib/staff';
import { staffFileUrl, uploadStaffFile } from '../lib/staff-files';
import { promptDialog } from './ui/feedback';

interface UnitOption { id: string; label: string }
interface Draft { id: string | null; name: string; kind: StaffKind; mobile: string; units: string[] }
const EMPTY: Draft = { id: null, name: '', kind: 'maid', mobile: '', units: [] };

const Photo: React.FC<{ path: string | null }> = ({ path }) => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { let live = true; if (path) void staffFileUrl(path).then(u => { if (live) setUrl(u); }); return () => { live = false; }; }, [path]);
  if (!path || !url) return <div className="w-12 h-12 rounded-xl bg-surface-muted flex items-center justify-center shrink-0"><UserRound className="w-6 h-6 text-fg-subtle" /></div>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" className="w-12 h-12 rounded-xl object-cover shrink-0" />;
};

export const StaffRegister: React.FC<{ societyId: string; isCommittee: boolean; canManage: boolean; myUnitIds: string[] }> = ({ societyId, isCommittee, canManage, myUnitIds }) => {
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [units, setUnits] = useState<UnitOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [{ data, error: err }, { data: u }] = await Promise.all([
      supabase.rpc('staff_list', { p_society_id: societyId }),
      supabase.from('units').select('id, unit_number, wings(name)').eq('society_id', societyId).order('unit_number'),
    ]);
    if (err) setError(err.message);
    setRows((data as StaffRow[]) ?? []);
    const list = ((u ?? []) as unknown as { id: string; unit_number: string; wings: { name: string } | null }[])
      .map(x => ({ id: x.id, wing: x.wings?.name ?? null, unit_number: x.unit_number }));
    const labels = flatLabels(list);
    setUnits(list.map((x, i) => ({ id: x.id, label: labels[i] })));
    setLoading(false);
  }, [societyId]);

  useEffect(() => { void load(); }, [load]);

  const unitLabel = (id: string) => units.find(u => u.id === id)?.label ?? '';
  const choosable = canManage ? units : units.filter(u => myUnitIds.includes(u.id));
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(null); setDone(null);
    try { await fn(); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    if (!supabase) throw new Error('Supabase is not configured');
    const { data, error: err } = await supabase.rpc(name, args);
    if (err) throw new Error(err.message);
    return data;
  };

  const save = () => draft && run('save', async () => {
    if (!canManage && draft.units.length === 0) throw new Error('Choose your flat');
    const id = await rpc('save_staff', {
      p_society_id: societyId, p_id: draft.id, p_name: draft.name, p_kind: draft.kind,
      p_mobile: draft.mobile.trim() || null, p_unit_ids: draft.units,
    }) as string;
    const linked = !draft.id && rows.some(r => r.id === id);
    setDraft(null);
    setDone(linked ? 'Already in the register — linked to your flat' : 'Saved.');
  });

  const upload = (row: StaffRow, kind: 'photo' | 'id', file: File | undefined) => file && run(`${kind}-${row.id}`, async () => {
    await uploadStaffFile(societyId, row.id, kind, file);
    setDone(kind === 'photo' ? 'Photo saved.' : 'ID proof saved. Only the committee can see it.');
  });

  const openFile = async (path: string) => {
    const tab = window.open('', '_blank');
    const url = await staffFileUrl(path, 120);
    if (url && tab) tab.location.href = url; else tab?.close();
  };

  const mine = rows.filter(r => r.mine);
  const others = isCommittee ? rows : rows.filter(r => !r.mine);
  const inputClass = 'w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand';

  const card = (r: StaffRow) => (
    <div key={r.id} className={`p-3 rounded-xl bg-surface border border-border flex gap-3 ${r.active ? '' : 'opacity-50'}`}>
      <Photo path={r.photo_path} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-fg text-sm">{r.name}</span>
          <span className="text-fg-muted">{staffKindLabel(r.kind)}</span>
          {r.police_verified && <span className="flex items-center gap-1 text-success"><ShieldCheck className="w-3.5 h-3.5" /> Police verified</span>}
          {!r.active && <span className="text-danger">Removed</span>}
        </div>
        {r.mobile && <a href={`tel:+${r.mobile}`} className="text-brand">{formatMobile(r.mobile)}</a>}
        {r.flats.length > 0 && <div className="text-fg-muted">Works in: {r.flats.map(f => unitLabel(f.unit_id) || f.unit_number).join(', ')}</div>}
        {isCommittee && r.notes && <div className="text-fg-muted">Note: {r.notes}</div>}
        <div className="flex flex-wrap gap-3 pt-1">
          {r.can_edit && r.active && (
            <button onClick={() => setDraft({ id: r.id, name: r.name, kind: r.kind, mobile: r.mobile ?? '', units: r.flats.map(f => f.unit_id) })} className="text-brand cursor-pointer">Edit</button>
          )}
          {r.can_edit && r.active && (
            <label className="flex items-center gap-1 text-brand cursor-pointer">
              {busy === `photo-${r.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Photo
              <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={e => upload(r, 'photo', e.target.files?.[0])} />
            </label>
          )}
          {r.can_upload_id && (canManage || !r.has_id_proof) && r.active && (
            <label className="flex items-center gap-1 text-brand cursor-pointer">
              {busy === `id-${r.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <IdCard className="w-3.5 h-3.5" />} {r.has_id_proof ? 'Replace ID proof' : 'Add ID proof'}
              <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="hidden" onChange={e => upload(r, 'id', e.target.files?.[0])} />
            </label>
          )}
          {!isCommittee && r.has_id_proof && <span className="flex items-center gap-1 text-fg-muted"><IdCard className="w-3.5 h-3.5" /> ID proof given</span>}
          {isCommittee && r.id_proof && (
            <button onClick={() => openFile(r.id_proof as string)} className="flex items-center gap-1 text-brand cursor-pointer"><FileText className="w-3.5 h-3.5" /> View ID proof</button>
          )}
          {!canManage && r.mine && r.flats.filter(f => myUnitIds.includes(f.unit_id)).map(f => (
            <button key={f.unit_id} onClick={() => run(`unlink-${r.id}`, async () => { await rpc('unlink_staff', { p_staff_id: r.id, p_unit_id: f.unit_id }); })}
              className="flex items-center gap-1 text-fg-muted hover:text-danger cursor-pointer"><Unlink className="w-3.5 h-3.5" /> Stop for {unitLabel(f.unit_id)}</button>
          ))}
          {canManage && (
            <>
              <label className="flex items-center gap-1 text-fg">
                Verified on
                <input type="date" value={r.police_verified_on ?? ''} className="bg-surface border border-border-strong rounded px-1 text-fg"
                  onChange={e => run(`v-${r.id}`, async () => { await rpc('set_staff_verified', { p_staff_id: r.id, p_verified_on: e.target.value || null }); })} />
              </label>
              <button onClick={async () => { const n = await promptDialog({ title: 'Note', label: 'Note (only the committee sees it)', defaultValue: r.notes ?? '', multiline: true, confirmText: 'Save note' }); if (n !== null) void run(`n-${r.id}`, async () => { await rpc('set_staff_notes', { p_staff_id: r.id, p_notes: n }); }); }}
                className="text-fg cursor-pointer">Note</button>
              <button onClick={() => run(`a-${r.id}`, async () => { await rpc('set_staff_active', { p_staff_id: r.id, p_active: !r.active }); })}
                className={r.active ? 'text-danger cursor-pointer' : 'text-success cursor-pointer'}>{r.active ? 'Remove' : 'Restore'}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-fg">Staff</h2>
          <p className="text-fg-muted">Maids, drivers, cooks and cleaners working in the society.</p>
        </div>
        {(canManage || myUnitIds.length > 0) && !draft && (
          <button onClick={() => setDraft({ ...EMPTY, units: canManage ? [] : myUnitIds.slice(0, 1) })}
            className="px-3 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold flex items-center gap-1.5 cursor-pointer"><Plus className="w-4 h-4" /> Add staff</button>
        )}
      </div>

      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{done}</Banner>

      {draft && (
        <div className="p-4 rounded-xl bg-surface border border-brand/40 space-y-2">
          <input value={draft.mobile} onChange={e => setDraft({ ...draft, mobile: e.target.value })} placeholder="Mobile number" inputMode="tel" className={inputClass} />
          <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} maxLength={80} placeholder="Name" className={inputClass} />
          <select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as StaffKind })} className={inputClass}>
            {STAFF_KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          {choosable.length > 0 && (
            <div>
              <div className="text-fg-muted mb-1">{canManage ? 'Works in (leave empty for society staff)' : 'Works in'}</div>
              <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
                {choosable.map(u => (
                  <label key={u.id} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-canvas border border-border text-fg cursor-pointer">
                    <input type="checkbox" checked={draft.units.includes(u.id)}
                      onChange={e => setDraft({ ...draft, units: e.target.checked ? [...draft.units, u.id] : draft.units.filter(x => x !== u.id) })} />
                    {u.label}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={save} disabled={busy !== null} className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold disabled:opacity-50 cursor-pointer">
              {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
            </button>
            <button onClick={() => setDraft(null)} className="px-4 py-2 rounded-lg bg-surface-muted text-fg cursor-pointer">Cancel</button>
          </div>
        </div>
      )}

      {loading && <Loader2 className="w-4 h-4 animate-spin text-fg-subtle" />}
      {!loading && rows.length === 0 && (
        <EmptyState icon={IdCard} title="No staff yet" description="Add the people who work in your flat or for the society." />
      )}

      {!isCommittee && mine.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-semibold text-fg text-sm">My staff</h3>
          {mine.map(card)}
        </div>
      )}
      {others.length > 0 && (
        <div className="space-y-2">
          {!isCommittee && <h3 className="font-semibold text-fg text-sm">Society staff</h3>}
          {others.map(card)}
        </div>
      )}
    </div>
  );
};
