'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { EMPTY_CHART, type Chart, type ChartGroup, type ChartLedger } from '../lib/chart';
import { type BankLedger, defaultBankId, fetchBankLedgers } from '../lib/banks';
import { Banner } from './Banner';
import { FolderPlus, Landmark, ListTree, Loader2, MoveRight, Pencil, Plus, Power, RefreshCw } from 'lucide-react';

type Editor =
  | { kind: 'add_group' | 'add_ledger'; groupId: string; name: string }
  | { kind: 'rename_group'; groupId: string; name: string }
  | { kind: 'move_group'; groupId: string; parentId: string }
  | { kind: 'rename_ledger'; code: string; name: string }
  | { kind: 'move_ledger'; code: string; groupId: string };

const drCr = (v: number) => (Math.abs(v) < 0.005 ? '—' : `${formatINR(Math.abs(v))} ${v > 0 ? 'Dr' : 'Cr'}`);
const bySortThenName = (a: ChartGroup, b: ChartGroup) => a.sort_order - b.sort_order || a.name.localeCompare(b.name);
const inputClass = 'bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-white outline-none focus:border-sky-500';
const linkClass = 'flex items-center gap-1 text-slate-400 hover:text-sky-300 cursor-pointer disabled:opacity-50';

/** The CA's default bank for money coming in and for bills paid out; others see it read-only. */
const DefaultBanks: React.FC<{ societyId: string; canManage: boolean; chart: Chart }> = ({ societyId, canManage, chart }) => {
  const [banks, setBanks] = useState<BankLedger[]>([]);
  const [receipt, setReceipt] = useState('');
  const [payment, setPayment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Reload whenever the chart changes: a new or renamed ledger under Bank Accounts is a new bank
  useEffect(() => {
    if (!supabase) return;
    fetchBankLedgers(supabase, societyId)
      .then(list => {
        setBanks(list);
        setReceipt(defaultBankId(list, 'receipt') ?? '');
        setPayment(defaultBankId(list, 'payment') ?? '');
      })
      .catch((err: Error) => setError(err.message));
  }, [societyId, chart]);

  const changed = receipt !== (defaultBankId(banks, 'receipt') ?? '') || payment !== (defaultBankId(banks, 'payment') ?? '');
  const save = async () => {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const { error: err } = await supabase.rpc('set_default_banks', { p_society_id: societyId, p_receipt_ledger_id: receipt, p_payment_ledger_id: payment });
    setBusy(false);
    if (err) return setError(err.message);
    setBanks(list => list.map(b => ({ ...b, is_default_receipt: b.id === receipt, is_default_payment: b.id === payment })));
    setNotice('Default banks saved. New receipts and payments use them unless the secretary picks another bank.');
  };
  const select = (value: string, onChange: (v: string) => void) => (
    <select value={value} disabled={!canManage || busy} onChange={e => onChange(e.target.value)} className={inputClass}>
      {banks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
    </select>
  );

  return (
    <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
      <div className="font-semibold text-white flex items-center gap-2"><Landmark className="w-3.5 h-3.5 text-sky-400" /> Default banks</div>
      <div className="flex flex-wrap items-center gap-4 text-slate-400">
        <label className="flex items-center gap-2">Money comes into {select(receipt, setReceipt)}</label>
        <label className="flex items-center gap-2">Bills are paid from {select(payment, setPayment)}</label>
        {canManage && (
          <button onClick={save} disabled={busy || !changed} className="px-3 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer disabled:opacity-50">
            Save
          </button>
        )}
      </div>
      <p className="text-slate-500">Add a ledger under Bank Accounts for each bank account first.</p>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>
    </div>
  );
};

/**
 * Groups & Ledgers: the society's Tally-style chart. The CA / accountant (manage_accounts) adds
 * groups and ledgers, renames, moves within the same nature and deactivates; everyone else reads.
 */
export const ChartOfAccounts: React.FC<{ societyId: string; canManage: boolean }> = ({ societyId, canManage }) => {
  const [chart, setChart] = useState<Chart>(EMPTY_CHART);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const { data, error: err } = await supabase.rpc('chart_of_accounts', { p_society_id: societyId });
    if (err) setError(err.message);
    else setChart((data as Chart | null) ?? EMPTY_CHART);
    setLoading(false);
  }, [societyId]);

  useEffect(() => {
    load();
  }, [load]);

  const groupById = useMemo(() => new Map(chart.groups.map(g => [g.id, g])), [chart]);
  const childrenOf = useMemo(() => {
    const m = new Map<string | null, ChartGroup[]>();
    for (const g of chart.groups) {
      const key = g.parent_id && groupById.has(g.parent_id) ? g.parent_id : null;
      m.set(key, [...(m.get(key) ?? []), g]);
    }
    m.forEach(list => list.sort(bySortThenName));
    return m;
  }, [chart, groupById]);
  const ledgersOf = useMemo(() => {
    const m = new Map<string, ChartLedger[]>();
    for (const l of chart.ledgers) m.set(l.group_id, [...(m.get(l.group_id) ?? []), l]);
    return m;
  }, [chart]);

  const isInside = (groupId: string, ancestorId: string): boolean => {
    for (let g = groupById.get(groupId), i = 0; g && i < 64; g = g.parent_id ? groupById.get(g.parent_id) : undefined, i++) {
      if (g.id === ancestorId) return true;
    }
    return false;
  };
  const subtotal = (g: ChartGroup): number =>
    (ledgersOf.get(g.id) ?? []).reduce((s, l) => s + Number(l.balance), 0) + (childrenOf.get(g.id) ?? []).reduce((s, c) => s + subtotal(c), 0);
  const groupPath = (g: ChartGroup): string => (g.parent_id && groupById.get(g.parent_id) ? `${groupPath(groupById.get(g.parent_id)!)} › ${g.name}` : g.name);
  const targets = (nature: string, ok: (g: ChartGroup) => boolean) =>
    chart.groups.filter(g => g.nature === nature && g.allows_ledgers && ok(g)).sort((a, b) => groupPath(a).localeCompare(groupPath(b)));

  const run = async (call: () => PromiseLike<{ data: unknown; error: { message: string } | null }>, done: (data: unknown) => string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { data, error: err } = await call();
    setBusy(false);
    if (err) return setError(err.message);
    setNotice(done(data));
    setEditor(null);
    load();
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || !editor) return;
    if ((editor.kind === 'move_group' && !editor.parentId) || (editor.kind === 'move_ledger' && !editor.groupId)) {
      return setError('Choose the group to move it to');
    }
    const sb = supabase;
    switch (editor.kind) {
      case 'add_group':
        return run(() => sb.rpc('create_account_group', { p_society_id: societyId, p_parent_id: editor.groupId, p_name: editor.name }), () => `Group "${editor.name.trim()}" added`);
      case 'add_ledger':
        return run(() => sb.rpc('create_ledger', { p_society_id: societyId, p_group_id: editor.groupId, p_name: editor.name }), code => `Ledger ${code} · ${editor.name.trim()} added`);
      case 'rename_group':
        return run(() => sb.rpc('update_account_group', { p_group_id: editor.groupId, p_name: editor.name, p_parent_id: null }), () => 'Group renamed');
      case 'move_group':
        return run(() => sb.rpc('update_account_group', { p_group_id: editor.groupId, p_name: null, p_parent_id: editor.parentId }), () => 'Group moved');
      case 'rename_ledger':
        return run(() => sb.rpc('update_ledger', { p_society_id: societyId, p_code: editor.code, p_name: editor.name, p_group_id: null }), () => `Ledger ${editor.code} renamed`);
      case 'move_ledger':
        return run(() => sb.rpc('update_ledger', { p_society_id: societyId, p_code: editor.code, p_name: null, p_group_id: editor.groupId }), () => `Ledger ${editor.code} moved`);
    }
  };

  const toggleActive = (l: ChartLedger) => {
    if (!supabase) return;
    const sb = supabase;
    run(() => sb.rpc('set_ledger_active', { p_society_id: societyId, p_code: l.code, p_active: !l.is_active }),
      () => `Ledger ${l.code} ${l.is_active ? 'deactivated' : 'activated'}`);
  };

  const form = (body: React.ReactNode, depth: number) => (
    <form onSubmit={save} className="flex flex-wrap items-center gap-2 py-2" style={{ paddingLeft: 12 + depth * 18 }}>
      {body}
      <button type="submit" disabled={busy} className="px-3 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer disabled:opacity-50">
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save'}
      </button>
      <button type="button" onClick={() => setEditor(null)} className="px-3 py-1 rounded-lg text-slate-400 hover:text-white cursor-pointer">Cancel</button>
    </form>
  );
  const nameInput = (value: string, placeholder: string, set: (v: string) => void) => (
    <input autoFocus value={value} onChange={e => set(e.target.value)} placeholder={placeholder} maxLength={128} className={`w-64 ${inputClass}`} />
  );

  const renderLedger = (l: ChartLedger, depth: number) => {
    const ed = editor && 'code' in editor && editor.code === l.code ? editor : null;
    return (
      <div key={l.code} className={l.is_active ? '' : 'opacity-50'}>
        <div className="py-1.5 pr-3 grid grid-cols-[1fr_auto] gap-4 items-center hover:bg-slate-800/40" style={{ paddingLeft: 12 + depth * 18 }}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-slate-500 w-12">{l.code}</span>
            <span className="text-slate-200">{l.name}</span>
            {!l.is_active && <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-400">Inactive</span>}
            {canManage && (
              <span className="flex items-center gap-3">
                <button type="button" disabled={busy} onClick={() => setEditor({ kind: 'rename_ledger', code: l.code, name: l.name })} className={linkClass}><Pencil className="w-3 h-3" /> Rename</button>
                {!l.is_system && <button type="button" disabled={busy} onClick={() => setEditor({ kind: 'move_ledger', code: l.code, groupId: '' })} className={linkClass}><MoveRight className="w-3 h-3" /> Move</button>}
                {!l.is_system && <button type="button" disabled={busy} onClick={() => toggleActive(l)} className={linkClass}><Power className="w-3 h-3" /> {l.is_active ? 'Deactivate' : 'Activate'}</button>}
              </span>
            )}
          </div>
          <span className="text-right text-slate-300 w-32">{drCr(Number(l.balance))}</span>
        </div>
        {ed?.kind === 'rename_ledger' && form(nameInput(ed.name, 'Ledger name', v => setEditor({ ...ed, name: v })), depth + 1)}
        {ed?.kind === 'move_ledger' && form(
          <select autoFocus value={ed.groupId} onChange={e => setEditor({ ...ed, groupId: e.target.value })} className={inputClass}>
            <option value="">Move to group…</option>
            {targets(l.nature, g => g.id !== l.group_id).map(g => <option key={g.id} value={g.id}>{groupPath(g)}</option>)}
          </select>, depth + 1)}
      </div>
    );
  };

  const renderGroup = (g: ChartGroup, depth: number): React.ReactNode => {
    const ed = editor && 'groupId' in editor && editor.groupId === g.id && !('code' in editor) ? editor : null;
    const primary = g.parent_id === null;
    const children = childrenOf.get(g.id) ?? [];
    const ledgers = ledgersOf.get(g.id) ?? [];
    return (
      <div key={g.id}>
        <div className={`py-2 pr-3 grid grid-cols-[1fr_auto] gap-4 items-center ${primary ? 'bg-slate-950/60' : ''}`} style={{ paddingLeft: 12 + depth * 18 }}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={`font-semibold ${primary ? 'text-white' : 'text-slate-200'}`}>{g.name}</span>
            {canManage && (
              <span className="flex items-center gap-3">
                <button type="button" disabled={busy} onClick={() => setEditor({ kind: 'add_group', groupId: g.id, name: '' })} className={linkClass}><FolderPlus className="w-3 h-3" /> Add group</button>
                {g.allows_ledgers
                  ? <button type="button" disabled={busy} onClick={() => setEditor({ kind: 'add_ledger', groupId: g.id, name: '' })} className={linkClass}><Plus className="w-3 h-3" /> Add ledger</button>
                  : <span className="text-slate-500">Ledgers created automatically</span>}
                {!primary && <button type="button" disabled={busy} onClick={() => setEditor({ kind: 'rename_group', groupId: g.id, name: g.name })} className={linkClass}><Pencil className="w-3 h-3" /> Rename</button>}
                {!primary && !g.system_key && <button type="button" disabled={busy} onClick={() => setEditor({ kind: 'move_group', groupId: g.id, parentId: '' })} className={linkClass}><MoveRight className="w-3 h-3" /> Move</button>}
              </span>
            )}
          </div>
          <span className="text-right font-semibold text-slate-200 w-32">{drCr(subtotal(g))}</span>
        </div>
        {ed?.kind === 'add_group' && form(nameInput(ed.name, `New group under ${g.name}`, v => setEditor({ ...ed, name: v })), depth + 1)}
        {ed?.kind === 'add_ledger' && form(nameInput(ed.name, `New ledger in ${g.name}`, v => setEditor({ ...ed, name: v })), depth + 1)}
        {ed?.kind === 'rename_group' && form(nameInput(ed.name, 'Group name', v => setEditor({ ...ed, name: v })), depth + 1)}
        {ed?.kind === 'move_group' && form(
          <select autoFocus value={ed.parentId} onChange={e => setEditor({ ...ed, parentId: e.target.value })} className={inputClass}>
            <option value="">Move under…</option>
            {targets(g.nature, t => t.id !== g.parent_id && !isInside(t.id, g.id)).map(t => <option key={t.id} value={t.id}>{groupPath(t)}</option>)}
          </select>, depth + 1)}
        {ledgers.map(l => renderLedger(l, depth + 1))}
        {children.map(c => renderGroup(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className="space-y-4 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2"><ListTree className="w-4 h-4 text-sky-400" /> Groups &amp; Ledgers</h2>
          <p className="text-slate-400">
            {canManage
              ? 'Add sub-groups and ledgers, rename them, move them within the same nature, or deactivate a ledger once its balance is zero (income and expense: zero this financial year). Codes never change.'
              : 'The society’s chart of accounts. Only the CA or accountant with “Manage accounts” can change it.'}
          </p>
        </div>
        <button onClick={load} className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 cursor-pointer" title="Refresh">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      <DefaultBanks societyId={societyId} canManage={canManage} chart={chart} />

      {loading && chart.groups.length === 0 ? (
        <div className="flex items-center gap-2 text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : (
        <div className="rounded-2xl bg-slate-900 border border-slate-800 divide-y divide-slate-800 overflow-hidden">
          {(childrenOf.get(null) ?? []).map(g => renderGroup(g, 0))}
        </div>
      )}
      <p className="text-slate-500">Assets, liabilities and funds show the balance today; income and expense ledgers show this financial year (Dr / Cr). Members&apos; dues, creditors and member advances get their ledgers from Sahvaas automatically; fixed-asset ledgers come from the asset register.</p>
    </div>
  );
};
