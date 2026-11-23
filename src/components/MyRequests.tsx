'use client';
// Phase 11A: a resident's NOC requests — ask for one, add documents, follow it, open the letter.
import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, FileSignature } from 'lucide-react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import { EmptyState } from './EmptyState';
import { RequestDetail, type RequestRow } from './RequestDetail';
import { useFlatLabels } from './FlatRequests';
import type { ChecklistItem } from '../lib/requests';

interface NocType { id: string; name: string; checklist: ChecklistItem[]; tenant_can_ask: boolean; is_active: boolean }
export interface MyFlat { unit_id: string; role: string }

export const MyRequests: React.FC<{ societyId: string; flats: MyFlat[] }> = ({ societyId, flats }) => {
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [types, setTypes] = useState<NocType[]>([]);
  const [form, setForm] = useState<{ unit: string; type: string; purpose: string; addressee: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const labels = useFlatLabels(societyId);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [{ data: r }, { data: t }] = await Promise.all([
      supabase.from('flat_requests').select('*').eq('society_id', societyId).order('submitted_at', { ascending: false }).limit(100),
      supabase.from('noc_types').select('id, name, checklist, tenant_can_ask, is_active').eq('society_id', societyId).eq('is_active', true).order('sort'),
    ]);
    setRequests((r as RequestRow[]) ?? []);
    setTypes((t as NocType[]) ?? []);
    setLoading(false);
  }, [societyId]);

  useEffect(() => { void load(); }, [load]);

  const isTenantOf = (unit: string) => flats.some(f => f.unit_id === unit && f.role === 'resident_tenant') && !flats.some(f => f.unit_id === unit && f.role !== 'resident_tenant');
  const allowed = (unit: string) => types.filter(t => !isTenantOf(unit) || t.tenant_can_ask);
  const unitIds = [...new Set(flats.map(f => f.unit_id))];

  const submit = async () => {
    if (!supabase || !form) return;
    setBusy(true); setError(null);
    const { error: err } = await supabase.rpc('create_noc_request', { p_unit_id: form.unit, p_noc_type_id: form.type, p_purpose: form.purpose, p_addressee: form.addressee });
    setBusy(false);
    if (err) return setError(err.message);
    setForm(null);
    setDone('Request sent. Add the documents it asks for below.');
    void load();
  };

  const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500';
  const typeName = (r: RequestRow) => types.find(t => t.id === r.noc_type_id)?.name ?? 'NOC';

  return (
    <div className="space-y-4 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-white">Requests</h2>
          <p className="text-slate-400">Ask the committee for a NOC. You get the letter here once it is approved.</p>
        </div>
        {!form && unitIds.length > 0 && (
          <button onClick={() => { const unit = unitIds[0]; setForm({ unit, type: allowed(unit)[0]?.id ?? '', purpose: '', addressee: '' }); setDone(null); }}
            className="px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold flex items-center gap-1.5 cursor-pointer"><Plus className="w-4 h-4" /> New NOC request</button>
        )}
      </div>
      <Banner tone="success">{done}</Banner>

      {form && (
        <div className="p-4 rounded-2xl bg-slate-900 border border-sky-500/40 space-y-2">
          <Banner tone="error">{error}</Banner>
          {unitIds.length > 1 && (
            <select value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value, type: allowed(e.target.value)[0]?.id ?? '' })} className={inputClass}>
              {unitIds.map(u => <option key={u} value={u}>Flat {labels[u] ?? ''}</option>)}
            </select>
          )}
          <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} className={inputClass}>
            {allowed(form.unit).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <input value={form.purpose} onChange={e => setForm({ ...form, purpose: e.target.value })} maxLength={300} placeholder="Purpose, e.g. Home loan from SBI" className={inputClass} />
          <input value={form.addressee} onChange={e => setForm({ ...form, addressee: e.target.value })} maxLength={160} placeholder="Addressed to (optional), e.g. The Branch Manager, SBI Kothrud" className={inputClass} />
          {(() => { const t = types.find(x => x.id === form.type); return t && t.checklist.length > 0
            ? <div className="text-slate-400">You will be asked for: {t.checklist.map(c => c.label + (c.required ? '' : ' (optional)')).join(', ')}</div> : null; })()}
          <div className="flex gap-2">
            <button onClick={submit} disabled={busy || !form.type} className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold disabled:opacity-50 cursor-pointer">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send request'}</button>
            <button onClick={() => setForm(null)} className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 cursor-pointer">Cancel</button>
          </div>
        </div>
      )}

      {loading && <Loader2 className="w-4 h-4 animate-spin text-slate-500" />}
      {!loading && requests.length === 0 && !form && <EmptyState icon={FileSignature} title="No requests yet" description="Ask for a NOC for a loan, a sale, the electricity meter, a passport and more." />}
      {requests.map(r => (
        <RequestDetail key={r.id} request={r} title={typeName(r)} flatLabel={labels[r.unit_id] ?? ''} canDecide={false} canEdit isCommittee={false} onChanged={load} />
      ))}
    </div>
  );
};
