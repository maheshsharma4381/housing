'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { EMPTY_CHART, type Chart } from '../lib/chart';
import type { BillType, TdsNature } from '../types/database';
import { Banner } from './Banner';
import { Loader2, MoveRight, Plus, Power, RefreshCw, Save, Tags } from 'lucide-react';

const TDS_LABELS: [TdsNature, string][] = [
  ['none', 'No TDS'],
  ['goods', 'Goods (no TDS)'],
  ['contract', 'Contract work (194C)'],
  ['professional', 'Professional fees (194J)'],
  ['technical', 'Technical services (194J)'],
  ['rent_building', 'Rent — building (194I)'],
  ['rent_machinery', 'Rent — machinery (194I)'],
];

type Draft = { label: string; account_code: string; tds_nature: TdsNature };

const inputClass = 'bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-white outline-none focus:border-sky-500 disabled:opacity-60';
const linkClass = 'flex items-center gap-1 text-slate-400 hover:text-sky-300 cursor-pointer disabled:opacity-50';

/**
 * Bill Types: the secretary picks a type on every vendor bill; the CA / accountant (manage_accounts)
 * decides which ledger each type posts to and its TDS. Earlier bills move only by committee approval.
 */
export const BillTypes: React.FC<{ societyId: string; canManage: boolean }> = ({ societyId, canManage }) => {
  const [types, setTypes] = useState<BillType[]>([]);
  const [chart, setChart] = useState<Chart>(EMPTY_CHART);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [adding, setAdding] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    // Only someone who maps types needs the ledger list; viewers see each type's ledger name
    const [tRes, cRes] = await Promise.all([
      supabase.rpc('bill_types', { p_society_id: societyId }),
      canManage ? supabase.rpc('chart_of_accounts', { p_society_id: societyId }) : Promise.resolve({ data: EMPTY_CHART, error: null }),
    ]);
    if (tRes.error || cRes.error) setError((tRes.error ?? cRes.error)!.message);
    setTypes((tRes.data as BillType[] | null) ?? []);
    setChart((cRes.data as Chart | null) ?? EMPTY_CHART);
    setDrafts({});
    setLoading(false);
  }, [societyId, canManage]);

  useEffect(() => {
    load();
  }, [load]);

  const expenseLedgers = useMemo(
    () => chart.ledgers.filter(l => l.nature === 'expense' && l.is_active).sort((a, b) => a.name.localeCompare(b.name)),
    [chart],
  );
  const draftOf = (t: BillType): Draft => drafts[t.key] ?? { label: t.label, account_code: t.account_code, tds_nature: t.tds_nature };
  const changed = (t: BillType) => {
    const d = draftOf(t);
    return d.label.trim() !== t.label || d.account_code !== t.account_code || d.tds_nature !== t.tds_nature;
  };
  const edit = (t: BillType, patch: Partial<Draft>) => setDrafts(ds => ({ ...ds, [t.key]: { ...draftOf(t), ...patch } }));

  const run = async (key: string, fn: string, args: Record<string, unknown>, done: (data: unknown) => string) => {
    if (!supabase) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    const { data, error: err } = await supabase.rpc(fn, args);
    setBusy(null);
    if (err) return setError(err.message);
    setNotice(done(data));
    setAdding(null);
    load();
  };

  const save = (t: BillType) => {
    const d = draftOf(t);
    run(t.key, 'set_bill_type', { p_society_id: societyId, p_key: t.key, p_label: d.label, p_account_code: d.account_code, p_tds_nature: d.tds_nature },
      () => `${d.label.trim()} saved. New bills of this type go to ${expenseLedgers.find(l => l.code === d.account_code)?.name ?? d.account_code}.`);
  };
  const move = (t: BillType) =>
    run(`move:${t.key}`, 'propose_bill_type_move', { p_society_id: societyId, p_key: t.key },
      data => `Sent to the committee for approval as ${(data as { proposal_number: string }).proposal_number}.`);
  const toggle = (t: BillType) =>
    run(`active:${t.key}`, 'set_bill_type_active', { p_society_id: societyId, p_key: t.key, p_active: !t.is_active },
      () => `${t.label} turned ${t.is_active ? 'off' : 'on'}.`);
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!adding) return;
    run('add', 'set_bill_type', { p_society_id: societyId, p_key: null, p_label: adding.label, p_account_code: adding.account_code, p_tds_nature: adding.tds_nature },
      () => `Bill type "${adding.label.trim()}" added.`);
  };

  const ledgerSelect = (value: string, onChange: (v: string) => void, disabled: boolean) => (
    <select value={value} disabled={disabled} onChange={e => onChange(e.target.value)} className={inputClass}>
      {!expenseLedgers.some(l => l.code === value) && <option value={value}>{value}</option>}
      {expenseLedgers.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
    </select>
  );
  const tdsSelect = (value: TdsNature, onChange: (v: TdsNature) => void, disabled: boolean) => (
    <select value={value} disabled={disabled} onChange={e => onChange(e.target.value as TdsNature)} className={inputClass}>
      {TDS_LABELS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select>
  );

  return (
    <div className="space-y-4 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2"><Tags className="w-4 h-4 text-sky-400" /> Bill Types</h2>
          <p className="text-slate-400 max-w-2xl">
            The secretary picks a bill type. The type decides the ledger and the TDS. Point a type to another ledger and new bills go there.
          </p>
        </div>
        <div className="flex gap-2">
          {canManage && !adding && (
            <button onClick={() => setAdding({ label: '', account_code: expenseLedgers[0]?.code ?? '', tds_nature: 'contract' })}
              className="flex items-center gap-1 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold cursor-pointer">
              <Plus className="w-3.5 h-3.5" /> Add bill type
            </button>
          )}
          <button onClick={load} className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 cursor-pointer" title="Refresh">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      {adding && (
        <form onSubmit={add} className="p-3 rounded-2xl bg-slate-900 border border-slate-800 flex flex-wrap items-center gap-2">
          <input autoFocus required value={adding.label} onChange={e => setAdding({ ...adding, label: e.target.value })} placeholder="Name, e.g. Water tanker" className={inputClass} />
          {ledgerSelect(adding.account_code, v => setAdding({ ...adding, account_code: v }), false)}
          {tdsSelect(adding.tds_nature, v => setAdding({ ...adding, tds_nature: v }), false)}
          <button type="submit" disabled={busy !== null} className="px-3 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer disabled:opacity-50">Add</button>
          <button type="button" onClick={() => setAdding(null)} className="px-2 py-1 text-slate-400 hover:text-white cursor-pointer">Cancel</button>
        </form>
      )}

      {loading && types.length === 0 ? (
        <div className="flex items-center gap-2 text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : (
        <div className="rounded-2xl bg-slate-900 border border-slate-800 overflow-x-auto">
          <table className="w-full">
            <thead className="text-slate-500 text-left">
              <tr><th className="p-2">Bill type</th><th className="p-2">Ledger</th><th className="p-2">TDS</th><th className="p-2" /></tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {types.map(t => {
                const d = draftOf(t);
                return (
                  <tr key={t.key} className={t.is_active ? '' : 'opacity-50'}>
                    <td className="p-2">
                      {canManage
                        ? <input value={d.label} onChange={e => edit(t, { label: e.target.value })} className={`${inputClass} w-48`} />
                        : <span className="text-white">{t.label}</span>}
                      {!t.is_active && <span className="ml-2 text-slate-500">Off</span>}
                    </td>
                    <td className="p-2">{canManage ? ledgerSelect(d.account_code, v => edit(t, { account_code: v }), busy !== null) : <span className="text-slate-300">{t.ledger_name ?? t.account_code}</span>}</td>
                    <td className="p-2">{canManage ? tdsSelect(d.tds_nature, v => edit(t, { tds_nature: v }), busy !== null) : <span className="text-slate-300">{TDS_LABELS.find(([v]) => v === t.tds_nature)?.[1]}</span>}</td>
                    <td className="p-2">
                      {canManage && (
                        <div className="flex flex-wrap items-center justify-end gap-3">
                          {changed(t) && (
                            <button onClick={() => save(t)} disabled={busy !== null} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer disabled:opacity-50">
                              <Save className="w-3 h-3" /> Save
                            </button>
                          )}
                          <button onClick={() => move(t)} disabled={busy !== null || changed(t)} className={linkClass}
                            title="Move this financial year's earlier bills of this type to its ledger (the committee approves)">
                            <MoveRight className="w-3 h-3" /> Move earlier bills
                          </button>
                          {t.is_custom && (
                            <button onClick={() => toggle(t)} disabled={busy !== null} className={linkClass}>
                              <Power className="w-3 h-3" /> {t.is_active ? 'Turn off' : 'Turn on'}
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-slate-500">
        Earlier bills stay in their ledger until the committee approves a move; only this financial year&apos;s bills can be moved.
      </p>
    </div>
  );
};
