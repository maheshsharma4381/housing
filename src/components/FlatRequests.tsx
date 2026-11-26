'use client';
// Phase 11A: the committee's Requests & NOCs screen — the inbox, the NOC register and the NOC letter settings.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Printer, FileSignature } from 'lucide-react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import { EmptyState } from './EmptyState';
import { RequestDetail, type RequestRow } from './RequestDetail';
import { flatLabels } from '../lib/flat-label';
import { REQUEST_STATUS_LABELS, pendingDays, pendingTone, type ChecklistItem } from '../lib/requests';
import { openNocLetter } from '../lib/request-files';
import { Tenancies } from './Tenancies';
import { TenancySettings } from './TenancySettings';
import { Shiftings } from './Shiftings';
import { ShiftingSettings } from './ShiftingSettings';
import { TransferSettings } from './TransferSettings';

interface NocType { id: string; code: string; name: string; title: string; body: string; signatory: string; checklist: ChecklistItem[]; tenant_can_ask: boolean; is_active: boolean }
interface LetterRow { id: string; request_id: string; number: string; issued_on: string; type_name: string; title: string; body: string; signatory: string; issued_to: string | null; flat_label: string | null }

export function useFlatLabels(societyId: string) {
  const [labels, setLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!supabase) return;
    void supabase.from('units').select('id, unit_number, wings(name)').eq('society_id', societyId).then(({ data }) => {
      const list = ((data ?? []) as unknown as { id: string; unit_number: string; wings: { name: string } | null }[])
        .map(u => ({ id: u.id, wing: u.wings?.name ?? null, unit_number: u.unit_number }));
      const l = flatLabels(list);
      setLabels(Object.fromEntries(list.map((u, i) => [u.id, l[i]])));
    });
  }, [societyId]);
  return labels;
}

const NocTemplates: React.FC<{ societyId: string; types: NocType[]; onSaved: () => void }> = ({ societyId, types, onSaved }) => {
  const [edit, setEdit] = useState<(Omit<NocType, 'id' | 'code'> & { id: string | null }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputClass = 'w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand';

  const save = async () => {
    if (!supabase || !edit) return;
    setBusy(true); setError(null);
    const { error: err } = await supabase.rpc('save_noc_type', {
      p_society_id: societyId, p_id: edit.id, p_name: edit.name, p_title: edit.title, p_body: edit.body, p_signatory: edit.signatory,
      p_checklist: edit.checklist.filter(c => c.label.trim()), p_tenant_can_ask: edit.tenant_can_ask, p_active: edit.is_active,
    });
    setBusy(false);
    if (err) return setError(err.message);
    setEdit(null);
    onSaved();
  };

  return (
    <div className="space-y-2">
      <Banner tone="info">Check this wording with your society&apos;s legal adviser. Words in {'{braces}'} are filled in by Sahvaas: {'{member_name} (the flat owners) {applicant_name} (who asked) {flat} {share_certificate_no} {dues_line} {date} {purpose} {addressee} {society_name} {registration_number} {society_address}'}.</Banner>
      {!edit && (
        <>
          {types.map(t => (
            <div key={t.id} className={`p-3 rounded-xl bg-canvas border border-border flex items-center justify-between ${t.is_active ? '' : 'opacity-50'}`}>
              <div><div className="text-fg font-semibold">{t.name}</div><div className="text-fg-subtle">{t.checklist.length} document{t.checklist.length === 1 ? '' : 's'}{t.tenant_can_ask ? ' · tenants can ask' : ''}{t.is_active ? '' : ' · switched off'}</div></div>
              <button onClick={() => setEdit({ ...t })} className="text-brand cursor-pointer">Edit</button>
            </div>
          ))}
          <button onClick={() => setEdit({ id: null, name: '', title: 'No Objection Certificate', body: '{addressee}\n\nThis is to certify that flat {flat} of {society_name} stands in the name of {member_name}.\n\n{dues_line}', signatory: 'secretary', checklist: [], tenant_can_ask: false, is_active: true })}
            className="flex items-center gap-1 text-brand cursor-pointer"><Plus className="w-4 h-4" /> Add a NOC type</button>
        </>
      )}
      {edit && (
        <div className="p-4 rounded-xl bg-surface border border-brand/40 space-y-2">
          <Banner tone="error">{error}</Banner>
          <input value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} maxLength={80} placeholder="Name, e.g. Bank account opening" className={inputClass} />
          <input value={edit.title} onChange={e => setEdit({ ...edit, title: e.target.value })} maxLength={120} placeholder="Letter title" className={inputClass} />
          <textarea rows={10} value={edit.body} onChange={e => setEdit({ ...edit, body: e.target.value })} maxLength={4000} className={`${inputClass} font-mono`} />
          <div className="flex flex-wrap gap-3 items-center text-fg">
            <label>Signed by{' '}
              <select value={edit.signatory} onChange={e => setEdit({ ...edit, signatory: e.target.value })} className="bg-surface border border-border-strong rounded-lg px-2 py-1 text-fg">
                <option value="secretary">Secretary</option><option value="chairman">Chairman</option><option value="treasurer">Treasurer</option>
              </select>
            </label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={edit.tenant_can_ask} onChange={e => setEdit({ ...edit, tenant_can_ask: e.target.checked })} /> Tenants can ask</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={edit.is_active} onChange={e => setEdit({ ...edit, is_active: e.target.checked })} /> In use</label>
          </div>
          <div className="space-y-1.5">
            <div className="text-fg-muted">Documents to ask for (up to 10)</div>
            {edit.checklist.map((c, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input value={c.label} maxLength={120} onChange={e => setEdit({ ...edit, checklist: edit.checklist.map((x, j) => j === i ? { ...x, label: e.target.value } : x) })} className={inputClass} />
                <label className="flex items-center gap-1 text-fg shrink-0"><input type="checkbox" checked={c.required} onChange={e => setEdit({ ...edit, checklist: edit.checklist.map((x, j) => j === i ? { ...x, required: e.target.checked } : x) })} /> Required</label>
                <button onClick={() => setEdit({ ...edit, checklist: edit.checklist.filter((_, j) => j !== i) })} className="text-fg-subtle hover:text-danger cursor-pointer">Remove</button>
              </div>
            ))}
            {edit.checklist.length < 10 && (
              <button onClick={() => setEdit({ ...edit, checklist: [...edit.checklist, { key: '', label: '', required: false }] })} className="flex items-center gap-1 text-brand cursor-pointer"><Plus className="w-4 h-4" /> Add a document</button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={busy} className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold disabled:opacity-50 cursor-pointer">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}</button>
            <button onClick={() => setEdit(null)} className="px-4 py-2 rounded-lg bg-surface-muted text-fg cursor-pointer">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
};

export const FlatRequests: React.FC<{ societyId: string; canManage: boolean }> = ({ societyId, canManage }) => {
  const [view, setView] = useState<'inbox' | 'tenants' | 'shifting' | 'sale' | 'register' | 'letters'>('inbox');
  const [pastTenants, setPastTenants] = useState(false);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [types, setTypes] = useState<NocType[]>([]);
  const [letters, setLetters] = useState<LetterRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const labels = useFlatLabels(societyId);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [{ data: r }, { data: t }, { data: l }] = await Promise.all([
      supabase.from('flat_requests').select('*').eq('society_id', societyId).order('submitted_at', { ascending: false }).limit(300),
      supabase.from('noc_types').select('*').eq('society_id', societyId).order('sort'),
      supabase.from('noc_letters').select('id, request_id, number, issued_on, type_name, title, body, signatory, issued_to, flat_label').eq('society_id', societyId).order('issued_on', { ascending: false }).order('seq', { ascending: false }).limit(500),
    ]);
    const rows = (r as RequestRow[]) ?? [];
    setRequests(rows);
    setTypes((t as NocType[]) ?? []);
    setLetters((l as LetterRow[]) ?? []);
    const ids = [...new Set(rows.map(x => x.applicant_id).filter(Boolean))] as string[];
    if (ids.length) {
      const { data: p } = await supabase.from('profiles').select('id, full_name').in('id', ids);
      setNames(Object.fromEntries(((p ?? []) as { id: string; full_name: string }[]).map(x => [x.id, x.full_name])));
    }
    setLoading(false);
  }, [societyId]);

  useEffect(() => { void load(); }, [load]);

  const typeName = (r: RequestRow) => r.kind === 'tenancy' ? 'Tenant registration' : r.kind === 'shifting' ? `Shifting: ${r.details.direction === 'out' ? 'moving out' : 'moving in'} ${r.details.date ?? ''}` : r.kind === 'transfer' ? `Sale: to ${r.details.buyer_name ?? ''}` : (types.find(t => t.id === r.noc_type_id)?.name ?? r.kind);
  const shown = useMemo(() => requests.filter(r => status === 'all' || r.status === 'submitted' || r.status === 'changes_asked'), [requests, status]);
  const current = requests.find(r => r.id === selected) ?? null;
  const tab = (id: typeof view, label: string) => (
    <button onClick={() => setView(id)} className={`px-3 py-1.5 rounded-lg cursor-pointer ${view === id ? 'bg-brand text-on-brand font-semibold' : 'bg-surface text-fg-muted border border-border'}`}>{label}</button>
  );

  return (
    <div className="space-y-4 text-sm">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-fg">Requests &amp; NOCs</h2>
        <p className="text-fg-muted">NOC requests, tenant registrations, shifting bookings and flat sales, with their documents. Approved NOCs get a number and go in the register.</p>
      </div>
      <div className="flex flex-wrap gap-2">{tab('inbox', 'Requests')}{tab('tenants', 'Tenants')}{tab('shifting', 'Shifting')}{canManage && tab('sale', 'Sale settings')}{tab('register', 'NOC register')}{canManage && tab('letters', 'NOC letters')}</div>
      {loading && <Loader2 className="w-4 h-4 animate-spin text-fg-subtle" />}

      {view === 'inbox' && !loading && (
        <div className="space-y-2">
          <div className="flex gap-2 text-fg">
            <label className="flex items-center gap-1"><input type="radio" checked={status === 'open'} onChange={() => setStatus('open')} /> Waiting</label>
            <label className="flex items-center gap-1"><input type="radio" checked={status === 'all'} onChange={() => setStatus('all')} /> All</label>
          </div>
          {shown.length === 0 && <EmptyState icon={FileSignature} title="No requests" description={status === 'open' ? 'Nothing is waiting for the committee.' : 'No requests yet.'} />}
          {shown.map(r => {
            const days = pendingDays(r.submitted_at, new Date());
            const open = r.status === 'submitted' || r.status === 'changes_asked';
            return (
              <div key={r.id} className="space-y-2">
                <button onClick={() => setSelected(selected === r.id ? null : r.id)} className={`w-full text-left p-3 rounded-xl border cursor-pointer ${selected === r.id ? 'bg-surface border-brand/50' : 'bg-surface border-border'}`}>
                  <div className="flex justify-between gap-2">
                    <span className="text-fg font-semibold">Flat {labels[r.unit_id] ?? ''} · {typeName(r)}</span>
                    <span className={open && pendingTone(r.kind, days) === 'amber' ? 'text-warning' : 'text-fg-muted'}>{open ? `${days} day${days === 1 ? '' : 's'}` : REQUEST_STATUS_LABELS[r.status]}</span>
                  </div>
                  <div className="text-fg-muted">{names[r.applicant_id ?? ''] ?? ''}{open ? ` · ${REQUEST_STATUS_LABELS[r.status]}` : ''}</div>
                </button>
                {selected === r.id && current && (
                  <RequestDetail request={current} title={typeName(current)} flatLabel={labels[current.unit_id] ?? ''} applicantName={names[current.applicant_id ?? '']}
                    canDecide={canManage} canEdit={canManage} isCommittee onChanged={load} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {view === 'tenants' && !loading && (
        <div className="space-y-4">
          <label className="flex items-center gap-1.5 text-fg"><input type="checkbox" checked={pastTenants} onChange={e => setPastTenants(e.target.checked)} /> Show past tenancies</label>
          <Tenancies societyId={societyId} labels={labels} canEnd={canManage} showPast={pastTenants} />
          {canManage && <TenancySettings societyId={societyId} />}
        </div>
      )}

      {view === 'shifting' && !loading && (
        <div className="space-y-4">
          <Shiftings societyId={societyId} labels={labels} canManage={canManage} />
          {canManage && <ShiftingSettings societyId={societyId} />}
        </div>
      )}

      {view === 'sale' && canManage && !loading && <TransferSettings societyId={societyId} />}

      {view === 'register' && !loading && (
        letters.length === 0
          ? <EmptyState icon={FileSignature} title="No NOCs issued yet" description="Approved NOC requests appear here with their numbers." />
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-fg-muted"><tr><th className="p-2">Number</th><th className="p-2">Date</th><th className="p-2">Flat</th><th className="p-2">Type</th><th className="p-2">Issued to</th><th className="p-2" /></tr></thead>
                <tbody>
                  {letters.map(l => (
                    <tr key={l.id} className="border-t border-border text-fg">
                      <td className="p-2 font-mono">{l.number}</td><td className="p-2">{l.issued_on}</td><td className="p-2">{l.flat_label}</td>
                      <td className="p-2">{l.type_name}</td><td className="p-2">{l.issued_to}</td>
                      <td className="p-2"><button onClick={() => openNocLetter(l, societyId)} className="text-brand cursor-pointer" title="Open letter"><Printer className="w-4 h-4" /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
      )}

      {view === 'letters' && canManage && !loading && <NocTemplates societyId={societyId} types={types} onSaved={load} />}
    </div>
  );
};

/** Approvals: how many flat requests wait, with a link to the Requests & NOCs screen */
export const RequestsWaiting: React.FC<{ societyId: string; onOpen: () => void }> = ({ societyId, onOpen }) => {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!supabase) return;
    void supabase.from('flat_requests').select('id', { count: 'exact', head: true }).eq('society_id', societyId).eq('status', 'submitted')
      .then(({ count }) => setN(count ?? 0));
  }, [societyId]);
  if (n === 0) return null;
  return (
    <button onClick={onOpen} className="w-full flex items-center justify-between gap-3 text-left px-4 sm:px-5 py-4 rounded-xl bg-info-soft border border-info/20 text-info text-sm font-medium cursor-pointer hover:border-info/40">
      <span>{n} flat request{n === 1 ? '' : 's'} waiting in Requests &amp; NOCs</span>
      <span aria-hidden="true">Open →</span>
    </button>
  );
};
