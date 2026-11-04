'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { EMPTY_CHART, type Chart, type ChartLedger } from '../lib/chart';
import {
  OPENING_TEMPLATE, catchupLabel, fyEnds, signed, sideTotal,
  type AuditedLine, type OpeningBalance, type Side,
} from '../lib/opening-balance';
import { Banner } from './Banner';
import { CheckCircle2, Loader2, Plus, Save, Send, Undo2, X } from 'lucide-react';

type Row = { key: string; side: Side; label: string; code: string; groupKey?: string; pick?: 'fixed_assets' | 'bank_accounts'; amount: string };
type CatchRow = { key: string; code: string; debit: string; credit: string };
type VendorRow = { key: string; vendor_id: string; amount: string };

const inputClass = 'bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-white outline-none focus:border-sky-500 disabled:opacity-60';
const numClass = `${inputClass} w-32 text-right`;
const n = (v: unknown) => Number(v ?? 0) || 0;
const same = (a: number, b: number) => Math.abs(a - b) < 0.005;
let seq = 0;
const key = () => `r${++seq}`;
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const showDate = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

const Tie: React.FC<{ ok: boolean; children: React.ReactNode }> = ({ ok, children }) => (
  <div className={`flex items-center gap-1 ${ok ? 'text-emerald-300' : 'text-rose-300'}`}>
    {ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />} {children}
  </div>
);

/**
 * Opening Balance (CA login): the last audited balance sheet exactly as it is, a catch-up entry for the
 * months up to go-live, and each flat's dues or advance on the go-live date. The committee approves it.
 */
export const OpeningBalanceEditor: React.FC<{ societyId: string; canManage: boolean }> = ({ societyId, canManage }) => {
  const [ob, setOb] = useState<OpeningBalance | null>(null);
  const [chart, setChart] = useState<Chart>(EMPTY_CHART);
  const [auditedAsOf, setAuditedAsOf] = useState(fyEnds(new Date())[0]);
  const [liveOn, setLiveOn] = useState(todayIso());
  const [rows, setRows] = useState<Row[]>([]);
  const [catchup, setCatchup] = useState<CatchRow[]>([]);
  const [flats, setFlats] = useState<Record<string, { dues: string; advance: string }>>({});
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const groupId = useCallback((c: Chart, systemKey: string) => c.groups.find(g => g.system_key === systemKey)?.id, []);

  /** Show what the server holds: saved lines, or the standard starting lines for a new one */
  const fill = useCallback((data: OpeningBalance, c: Chart) => {
    setOb(data);
    if (data.audited_as_of) setAuditedAsOf(data.audited_as_of);
    if (data.live_on) setLiveOn(data.live_on);
    const name = (code: string) => c.ledgers.find(l => l.code === code)?.name ?? code;
    if (data.audited_lines.length > 0) {
      setRows(data.audited_lines.map(l => ({
        key: key(), side: l.side, label: l.label ?? name(l.code), code: l.code, amount: String(signed(l.side, n(l.amount))),
      })));
    } else {
      const banks = c.ledgers.filter(l => l.is_active && l.group_id === groupId(c, 'bank_accounts'));
      setRows(OPENING_TEMPLATE.flatMap<Row>(t => {
        if (t.pickFrom === 'bank_accounts') {
          return banks.map(b => ({ key: key(), side: t.side, label: b.name, code: b.code, amount: '' }));
        }
        const exists = t.code && c.ledgers.some(l => l.code === t.code && l.is_active);
        return [{ key: key(), side: t.side, label: t.label, code: exists ? t.code! : '', groupKey: t.groupKey, pick: t.pickFrom, amount: '' }];
      }));
    }
    setCatchup(data.catchup_lines.map(l => ({
      key: key(), code: l.code, debit: n(l.amount) > 0 ? String(n(l.amount)) : '', credit: n(l.amount) < 0 ? String(-n(l.amount)) : '',
    })));
    setFlats(Object.fromEntries(data.flat_lines.map(l => [l.unit_id, n(l.amount) > 0
      ? { dues: String(n(l.amount)), advance: '' } : { dues: '', advance: String(-n(l.amount)) }])));
    setVendors(data.vendor_lines.map(l => ({ key: key(), vendor_id: l.vendor_id, amount: String(n(l.amount)) })));
  }, [groupId]);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const [oRes, cRes] = await Promise.all([
      supabase.rpc('opening_balance', { p_society_id: societyId }),
      supabase.rpc('chart_of_accounts', { p_society_id: societyId }),
    ]);
    if (oRes.error || cRes.error) setError((oRes.error ?? cRes.error)!.message);
    const c = (cRes.data as Chart | null) ?? EMPTY_CHART;
    setChart(c);
    if (oRes.data) fill(oRes.data as OpeningBalance, c);
    setLoading(false);
  }, [societyId, fill]);

  useEffect(() => {
    load();
  }, [load]);

  const editable = canManage && (ob?.status === 'none' || ob?.status === 'draft');

  const sheetLedgers = useMemo(() => chart.ledgers
    .filter(l => l.is_active && ['asset', 'liability', 'equity'].includes(l.nature))
    .sort((a, b) => a.name.localeCompare(b.name)), [chart]);
  const allLedgers = useMemo(() => chart.ledgers.filter(l => l.is_active).sort((a, b) => a.name.localeCompare(b.name)), [chart]);
  const fixedAssetLedgers = useMemo(() => sheetLedgers.filter(l => l.group_id === groupId(chart, 'fixed_assets')), [sheetLedgers, chart, groupId]);

  // ---- the figures, exactly as the server will check them
  const audited: AuditedLine[] = rows
    .filter(r => r.code && n(r.amount) !== 0)
    .map(r => ({ code: r.code, amount: signed(r.side, n(r.amount)), side: r.side, label: r.label }));
  const catchupLines = catchup.filter(r => r.code && n(r.debit) - n(r.credit) !== 0).map(r => ({ code: r.code, amount: n(r.debit) - n(r.credit) }));
  const liabilities = sideTotal(audited, 'liabilities');
  const assets = sideTotal(audited, 'assets');
  const catchupDiff = catchupLines.reduce((s, l) => s + l.amount, 0);
  const onCode = (lines: { code: string; amount: number }[], code: string) => lines.filter(l => l.code === code).reduce((s, l) => s + l.amount, 0);
  const duesSheet = onCode(audited, '1200');
  const duesCatch = onCode(catchupLines, '1200');
  const advanceExpected = 0 - (onCode(audited, '2300') + onCode(catchupLines, '2300'));
  const creditors = 0 - (onCode(audited, '2000') + onCode(catchupLines, '2000'));
  const duesEntered = Object.values(flats).reduce((s, f) => s + n(f.dues), 0);
  const advanceEntered = Object.values(flats).reduce((s, f) => s + n(f.advance), 0);
  const vendorsEntered = vendors.reduce((s, v) => s + n(v.amount), 0);
  const label = catchupLabel(auditedAsOf, liveOn);
  const ties = audited.length + catchupLines.length > 0 && same(assets, liabilities) && same(catchupDiff, 0)
    && same(duesEntered, duesSheet + duesCatch) && same(advanceEntered, advanceExpected) && vendorsEntered <= creditors + 0.005;

  const setRow = (k: string, patch: Partial<Row>) => setRows(rs => rs.map(r => (r.key === k ? { ...r, ...patch } : r)));
  const setCatch = (k: string, patch: Partial<CatchRow>) => setCatchup(rs => rs.map(r => (r.key === k ? { ...r, ...patch } : r)));
  const setVendor = (k: string, patch: Partial<VendorRow>) => setVendors(rs => rs.map(r => (r.key === k ? { ...r, ...patch } : r)));

  /** Create ledgers the starting lines need, then save the draft. Returns false when it could not. */
  const save = async (): Promise<boolean> => {
    if (!supabase) return false;
    setError(null);
    setNotice(null);
    let created = false;
    const ready: Row[] = [];
    for (const r of rows) {
      if (n(r.amount) === 0 || r.code) {
        ready.push(r);
        continue;
      }
      const gid = r.groupKey ? groupId(chart, r.groupKey) : undefined;
      if (!gid) {
        setError(`Choose a ledger for “${r.label}”.`);
        return false;
      }
      const { data, error: err } = await supabase.rpc('create_ledger', { p_society_id: societyId, p_group_id: gid, p_name: r.label });
      if (err) {
        setError(err.message);
        return false;
      }
      created = true;
      ready.push({ ...r, code: data as string });
    }
    setRows(ready);
    const lines = ready.filter(r => r.code && n(r.amount) !== 0)
      .map(r => ({ code: r.code, amount: signed(r.side, n(r.amount)), side: r.side, label: r.label }));
    const { data, error: err } = await supabase.rpc('save_opening_balance', {
      p_society_id: societyId,
      p_audited_as_of: auditedAsOf,
      p_live_on: liveOn,
      p_audited_lines: lines,
      p_catchup_lines: catchupLines,
      p_flat_lines: Object.entries(flats)
        .map(([unit_id, f]) => ({ unit_id, amount: n(f.dues) - n(f.advance) }))
        .filter(l => l.amount !== 0),
      p_vendor_lines: vendors.filter(v => v.vendor_id && n(v.amount) !== 0).map(v => ({ vendor_id: v.vendor_id, amount: n(v.amount) })),
    });
    if (err) {
      setError(err.message);
      return false;
    }
    setOb(data as OpeningBalance);
    if (created) {
      const cRes = await supabase.rpc('chart_of_accounts', { p_society_id: societyId });
      if (cRes.data) setChart(cRes.data as Chart);
    }
    return true;
  };

  const run = async (action: 'save' | 'submit' | 'withdraw') => {
    if (!supabase) return;
    setBusy(true);
    if (action === 'withdraw') {
      const { data, error: err } = await supabase.rpc('reopen_opening_balance', { p_society_id: societyId });
      if (err) setError(err.message);
      else setOb(data as OpeningBalance);
    } else if (await save()) {
      if (action === 'save') {
        setNotice('Draft saved.');
      } else {
        const { data, error: err } = await supabase.rpc('submit_opening_balance', { p_society_id: societyId });
        if (err) setError(err.message);
        else {
          setOb(data as OpeningBalance);
          setNotice('Sent to the committee for approval.');
        }
      }
    }
    setBusy(false);
  };

  if (loading && !ob) {
    return <div className="flex items-center gap-2 text-xs text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading opening balance…</div>;
  }
  if (!ob) return <Banner tone="error">{error}</Banner>;

  const ledgerOptions = (list: ChartLedger[]) => list.map(l => <option key={l.code} value={l.code}>{l.name} ({l.code})</option>);
  const side = (s: Side, title: string) => (
    <div className="space-y-1.5">
      <div className="font-semibold text-slate-300">{title}</div>
      {rows.filter(r => r.side === s).map(r => (
        <div key={r.key} className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-slate-200 truncate">{r.label}</div>
            <select value={r.code} disabled={!editable} onChange={e => setRow(r.key, { code: e.target.value })} className={`${inputClass} w-full mt-0.5`}>
              <option value="">{r.groupKey ? 'New ledger with this name' : 'Choose a ledger'}</option>
              {ledgerOptions(r.pick === 'fixed_assets' ? fixedAssetLedgers : sheetLedgers)}
            </select>
          </div>
          <input type="number" step="0.01" value={r.amount} disabled={!editable} onChange={e => setRow(r.key, { amount: e.target.value })} className={numClass} />
          {editable && <button onClick={() => setRows(rs => rs.filter(x => x.key !== r.key))} className="p-1 text-slate-500 hover:text-rose-300 cursor-pointer" title="Remove line"><X className="w-3.5 h-3.5" /></button>}
        </div>
      ))}
      {editable && (
        <button onClick={() => setRows(rs => [...rs, { key: key(), side: s, label: 'Other', code: '', amount: '' }])} className="flex items-center gap-1 text-sky-300 hover:text-sky-200 cursor-pointer">
          <Plus className="w-3.5 h-3.5" /> Add line
        </button>
      )}
      <div className="flex justify-between border-t border-slate-800 pt-1.5 font-semibold text-white"><span>Total</span><span>{formatINR(s === 'assets' ? assets : liabilities)}</span></div>
    </div>
  );

  return (
    <div className="space-y-5 text-xs">
      <p className="text-slate-400">
        Enter the last audited balance sheet exactly as it is, then each flat&apos;s dues on the day the society started using Sahvaas.
        The committee approves it before anything reaches the books.
      </p>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>
      {ob.status === 'draft' && ob.decision_note && <Banner tone="error">The committee sent this back: {ob.decision_note}</Banner>}
      {ob.status === 'submitted' && <Banner tone="info">Waiting for the committee&apos;s approval (submitted {showDate(ob.submitted_at)}).</Banner>}
      {ob.status === 'approved' && <Banner tone="success">Approved on {showDate(ob.decided_at)}. Corrections now go through Adjustments.</Banner>}

      <div className="flex flex-wrap gap-4">
        <label className="space-y-1">
          <div className="text-slate-400">Audited balance sheet as on</div>
          <select value={auditedAsOf} disabled={!editable} onChange={e => setAuditedAsOf(e.target.value)} className={inputClass}>
            {Array.from(new Set([...fyEnds(new Date()), auditedAsOf])).map(d => <option key={d} value={d}>{showDate(d)}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <div className="text-slate-400">Started using Sahvaas on</div>
          <input type="date" value={liveOn} min={auditedAsOf} max={todayIso()} disabled={!editable} onChange={e => setLiveOn(e.target.value)} className={inputClass} />
        </label>
      </div>

      <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-3">
        <h3 className="font-semibold text-white">1. Audited balance sheet</h3>
        <div className="grid gap-6 lg:grid-cols-2">
          {side('liabilities', 'Liabilities & funds')}
          {side('assets', 'Assets')}
        </div>
        <Tie ok={same(assets, liabilities)}>{same(assets, liabilities) ? 'Both sides match' : `Difference: ${formatINR(Math.abs(assets - liabilities))}`}</Tie>
      </section>

      <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-2">
        <h3 className="font-semibold text-white">2. {label ?? 'Catch-up entry'}</h3>
        {label === null ? (
          <p className="text-slate-400">Nothing to enter — you started on 1 April.</p>
        ) : (
          <>
            <p className="text-slate-400">One summary entry for the months between the audit and go-live: income, expenses, collections and payments for that period.</p>
            <table className="w-full">
              <thead className="text-slate-500 text-left"><tr><th className="py-1">Ledger</th><th className="py-1 text-right">Debit</th><th className="py-1 text-right">Credit</th><th /></tr></thead>
              <tbody>
                {catchup.map(r => (
                  <tr key={r.key}>
                    <td className="py-1 pr-2">
                      <select value={r.code} disabled={!editable} onChange={e => setCatch(r.key, { code: e.target.value })} className={`${inputClass} w-full`}>
                        <option value="">Choose a ledger</option>
                        {ledgerOptions(allLedgers)}
                      </select>
                    </td>
                    <td className="py-1 text-right"><input type="number" step="0.01" min="0" value={r.debit} disabled={!editable} onChange={e => setCatch(r.key, { debit: e.target.value, credit: '' })} className={numClass} /></td>
                    <td className="py-1 text-right"><input type="number" step="0.01" min="0" value={r.credit} disabled={!editable} onChange={e => setCatch(r.key, { credit: e.target.value, debit: '' })} className={numClass} /></td>
                    <td>{editable && <button onClick={() => setCatchup(rs => rs.filter(x => x.key !== r.key))} className="p-1 text-slate-500 hover:text-rose-300 cursor-pointer" title="Remove line"><X className="w-3.5 h-3.5" /></button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {editable && (
              <button onClick={() => setCatchup(rs => [...rs, { key: key(), code: '', debit: '', credit: '' }])} className="flex items-center gap-1 text-sky-300 hover:text-sky-200 cursor-pointer">
                <Plus className="w-3.5 h-3.5" /> Add line
              </button>
            )}
            <Tie ok={same(catchupDiff, 0)}>{same(catchupDiff, 0) ? 'Debits and credits match' : `Difference: ${formatINR(Math.abs(catchupDiff))}`}</Tie>
          </>
        )}
      </section>

      <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-2">
        <h3 className="font-semibold text-white">3. Flat-wise dues on {showDate(liveOn)}</h3>
        <table className="w-full">
          <thead className="text-slate-500 text-left"><tr><th className="py-1">Flat</th><th className="py-1">Owner</th><th className="py-1 text-right">Dues</th><th className="py-1 text-right">Advance</th></tr></thead>
          <tbody className="divide-y divide-slate-800">
            {ob.flats.map(f => (
              <tr key={f.unit_id}>
                <td className="py-1 text-white">{f.name}</td>
                <td className="py-1 text-slate-400">{f.owner_name ?? '—'}</td>
                <td className="py-1 text-right"><input type="number" step="0.01" min="0" value={flats[f.unit_id]?.dues ?? ''} disabled={!editable}
                  onChange={e => setFlats(fs => ({ ...fs, [f.unit_id]: { dues: e.target.value, advance: '' } }))} className={numClass} /></td>
                <td className="py-1 text-right"><input type="number" step="0.01" min="0" value={flats[f.unit_id]?.advance ?? ''} disabled={!editable}
                  onChange={e => setFlats(fs => ({ ...fs, [f.unit_id]: { dues: '', advance: e.target.value } }))} className={numClass} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Tie ok={same(duesEntered, duesSheet + duesCatch)}>
          Members&apos; dues on {showDate(liveOn)}: {formatINR(duesSheet + duesCatch)} (balance sheet {formatINR(duesSheet)} + catch-up {formatINR(duesCatch)}); flats add up to {formatINR(duesEntered)}
        </Tie>
        <Tie ok={same(advanceEntered, advanceExpected)}>
          Advance maintenance on {showDate(liveOn)}: {formatINR(advanceExpected)}; flats add up to {formatINR(advanceEntered)}
        </Tie>
      </section>

      <section className="rounded-2xl bg-slate-900 border border-slate-800 p-4 space-y-2">
        <h3 className="font-semibold text-white">4. Vendor-wise payables on {showDate(liveOn)} (optional)</h3>
        <p className="text-slate-400">Sundry Creditors on {showDate(liveOn)}: {formatINR(creditors)}. Anything not given to a vendor stays as “Not linked to a vendor”.</p>
        {vendors.map(v => (
          <div key={v.key} className="flex items-center gap-2">
            <select value={v.vendor_id} disabled={!editable} onChange={e => setVendor(v.key, { vendor_id: e.target.value })} className={`${inputClass} flex-1`}>
              <option value="">Choose a vendor</option>
              {ob.vendors.map(o => <option key={o.vendor_id} value={o.vendor_id}>{o.name}</option>)}
            </select>
            <input type="number" step="0.01" min="0" value={v.amount} disabled={!editable} onChange={e => setVendor(v.key, { amount: e.target.value })} className={numClass} />
            {editable && <button onClick={() => setVendors(vs => vs.filter(x => x.key !== v.key))} className="p-1 text-slate-500 hover:text-rose-300 cursor-pointer" title="Remove line"><X className="w-3.5 h-3.5" /></button>}
          </div>
        ))}
        {editable && ob.vendors.length > 0 && (
          <button onClick={() => setVendors(vs => [...vs, { key: key(), vendor_id: '', amount: '' }])} className="flex items-center gap-1 text-sky-300 hover:text-sky-200 cursor-pointer">
            <Plus className="w-3.5 h-3.5" /> Add vendor
          </button>
        )}
        {vendorsEntered > creditors + 0.005 && <Tie ok={false}>Vendor payables add up to {formatINR(vendorsEntered)} — more than Sundry Creditors</Tie>}
      </section>

      {canManage && (
        <div className="flex flex-wrap gap-2">
          {editable && (
            <>
              <button onClick={() => run('save')} disabled={busy} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white cursor-pointer disabled:opacity-50">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save draft
              </button>
              <button onClick={() => run('submit')} disabled={busy || !ties} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white cursor-pointer disabled:opacity-50">
                <Send className="w-3.5 h-3.5" /> Submit for approval
              </button>
            </>
          )}
          {ob.status === 'submitted' && (
            <button onClick={() => run('withdraw')} disabled={busy} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white cursor-pointer disabled:opacity-50">
              <Undo2 className="w-3.5 h-3.5" /> Withdraw to edit
            </button>
          )}
        </div>
      )}
    </div>
  );
};
