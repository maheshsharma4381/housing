'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { downloadCsv, toCsv } from '../lib/csv-export';
import { assetTypeLabel, fyEndFor, fyLabel } from '../lib/tds';
import { defaultBankId, fetchBankLedgers, type BankLedger } from '../lib/banks';
import { Banner } from './Banner';
import { EmptyState } from './EmptyState';
import { AssetAccountCode, DepreciationPreviewRow, FixedAsset } from '../types/database';
import { Boxes, Download, Loader2, Plus } from 'lucide-react';

interface AssetRegisterProps {
  societyId: string;
  /** The committee, the CA or the Accountant can add, re-rate, dispose and post depreciation; viewers read only */
  canManage: boolean;
}

interface Run { fy_end: string; total: number; posted_at: string }
interface AssetType { code: string; name: string; dep_rate: number }
type RowEdit = { id: string; kind: 'rate'; rate: number; method: 'wdv' | 'slm'; reason: string }
  | { id: string; kind: 'dispose'; date: string; amount: number; mode: 'bank' | 'cash'; bankId: string; reason: string };

const today = () => new Date().toISOString().slice(0, 10);
const emptyExisting = { name: '', code: '1500' as AssetAccountCode, purchased: '', cost: 0, wdv: 0, asOf: '', location: '' };

export const AssetRegister: React.FC<AssetRegisterProps> = ({ societyId, canManage }) => {
  const currentFy = fyEndFor();
  const fyOptions = [currentFy, `${Number(currentFy.slice(0, 4)) - 1}-03-31`, `${Number(currentFy.slice(0, 4)) - 2}-03-31`];
  const [fyEnd, setFyEnd] = useState(currentFy);
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [preview, setPreview] = useState<DepreciationPreviewRow[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState<RowEdit | null>(null);
  const [existing, setExisting] = useState<typeof emptyExisting | null>(null);
  const [assetTypes, setAssetTypes] = useState<AssetType[]>([]);
  const [banks, setBanks] = useState<BankLedger[]>([]);
  const [rateDrafts, setRateDrafts] = useState<Record<string, string>>({});
  const [newType, setNewType] = useState({ name: '', rate: '10' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const [aRes, pRes, rRes, tRes, bankList] = await Promise.all([
      supabase.from('fixed_assets').select('*').eq('society_id', societyId).neq('status', 'voided').order('asset_number'),
      supabase.rpc('preview_depreciation', { p_society_id: societyId, p_fy_end: fyEnd }),
      supabase.from('depreciation_runs').select('fy_end, total, posted_at').eq('society_id', societyId).order('fy_end', { ascending: false }),
      supabase.rpc('asset_ledgers', { p_society_id: societyId }),
      canManage ? fetchBankLedgers(supabase, societyId).catch(() => [] as BankLedger[]) : Promise.resolve([] as BankLedger[]),
    ]);
    setAssetTypes(((tRes.data ?? []) as AssetType[]).map(t => ({ ...t, dep_rate: Number(t.dep_rate) })));
    setBanks(bankList);
    setRateDrafts({});
    setLoading(false);
    if (aRes.error) return setError(aRes.error.message);
    setAssets((aRes.data ?? []) as FixedAsset[]);
    setPreview((pRes.data ?? []) as DepreciationPreviewRow[]);
    setRuns((rRes.data ?? []) as Run[]);
  }, [societyId, fyEnd, canManage]);

  useEffect(() => {
    load();
  }, [load]);

  // An asset type is a fixed-asset ledger; older codes fall back to the standard names
  const typeLabel = (code: string) => assetTypes.find(t => t.code === code)?.name ?? assetTypeLabel(code);

  const done = (msg: string) => {
    setError(null);
    setNotice(msg);
    setEdit(null);
    load();
  };

  const rpc = async (key: string, name: string, args: Record<string, unknown>, msg: string) => {
    if (!supabase) return;
    setBusy(key);
    const { error: rpcErr } = await supabase.rpc(name, args);
    setBusy(null);
    if (rpcErr) return setError(rpcErr.message);
    done(msg);
  };

  const saveExisting = async () => {
    if (!existing) return;
    await rpc('existing', 'add_existing_asset', {
      p_society_id: societyId, p_name: existing.name, p_account_code: existing.code, p_put_to_use: existing.purchased,
      p_cost: existing.cost, p_wdv: existing.wdv, p_as_of: existing.asOf, p_location: existing.location || null,
    }, `${existing.name} added to the register.`);
    setExisting(null);
  };

  const posted = runs.find(r => r.fy_end === fyEnd);
  const byId = new Map(preview.map(p => [p.asset_id, p]));
  const totals = preview.reduce((t, p) => ({
    open: t.open + Number(p.opening_wdv), add: t.add + Number(p.additions), dep: t.dep + Number(p.depreciation), close: t.close + Number(p.closing_wdv),
  }), { open: 0, add: 0, dep: 0, close: 0 });

  const exportCsv = () => downloadCsv(`fixed-assets-${fyLabel(fyEnd).replace(' ', '-')}.csv`, toCsv(preview, [
    { header: 'Asset no.', value: p => p.asset_number },
    { header: 'Name', value: p => p.name },
    { header: 'Type', value: p => typeLabel(p.account_code) },
    { header: 'Put to use', value: p => p.put_to_use_date },
    { header: 'Opening WDV', value: p => p.opening_wdv },
    { header: 'Additions', value: p => p.additions },
    { header: 'Rate %', value: p => p.rate },
    { header: 'Half rate', value: p => (p.half_rate ? 'yes' : '') },
    { header: 'Depreciation', value: p => p.depreciation },
    { header: 'Closing WDV', value: p => p.closing_wdv },
  ]));

  const inputClass = 'w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand';

  return (
    <div className="space-y-5 text-xs">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-fg">Fixed Asset Register</h2>
          <p className="text-fg-muted">Assets bought through approved bills appear here automatically. Depreciation is previewed now and posted once at year end.</p>
        </div>
        <div className="flex gap-2">
          <select value={fyEnd} onChange={e => setFyEnd(e.target.value)} className="bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg">
            {fyOptions.map(f => <option key={f} value={f}>{fyLabel(f)}</option>)}
          </select>
          <button onClick={exportCsv} disabled={preview.length === 0} className="flex items-center gap-1 px-3 py-2 rounded-lg bg-surface-muted text-fg cursor-pointer disabled:opacity-50">
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
        </div>
      </div>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      {loading ? (
        <div className="flex justify-center p-8"><Loader2 className="w-5 h-5 text-brand animate-spin" /></div>
      ) : assets.length === 0 ? (
        <EmptyState icon={Boxes} title="No assets yet" description="Book a purchase as “New asset” when adding a bill, or add assets the society already owns." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[760px]">
            <thead className="bg-surface text-fg-muted text-left">
              <tr>
                <th className="p-2.5">Asset</th><th className="p-2.5">Put to use</th><th className="p-2.5 text-right">Opening WDV</th>
                <th className="p-2.5 text-right">Additions</th><th className="p-2.5 text-right">Rate</th><th className="p-2.5 text-right">Depreciation</th>
                <th className="p-2.5 text-right">Closing WDV</th>{canManage && <th className="p-2.5" />}
              </tr>
            </thead>
            <tbody className="text-fg">
              {assets.map(a => {
                const p = byId.get(a.id);
                return (
                  <React.Fragment key={a.id}>
                    <tr className="border-t border-border">
                      <td className="p-2.5">
                        <span className="font-mono text-fg-subtle">{a.asset_number}</span> <span className="font-semibold text-fg">{a.name}</span>
                        <div className="text-fg-subtle">{typeLabel(a.account_code)}{a.location ? ` · ${a.location}` : ''}{a.opening_as_of ? ' · brought in with opening balances' : ''}</div>
                        {a.status === 'disposed' && <div className="text-danger">Disposed {a.disposed_on} for {formatINR(a.disposal_amount)}</div>}
                      </td>
                      <td className="p-2.5">{a.put_to_use_date}</td>
                      <td className="p-2.5 text-right">{p ? formatINR(p.opening_wdv) : '—'}</td>
                      <td className="p-2.5 text-right">{p && Number(p.additions) ? formatINR(p.additions) : '—'}</td>
                      <td className="p-2.5 text-right">{a.dep_rate}% {a.dep_method.toUpperCase()}{p?.half_rate && <div className="text-warning">half (&lt; 180 days)</div>}</td>
                      <td className="p-2.5 text-right">{p ? formatINR(p.depreciation) : '—'}</td>
                      <td className="p-2.5 text-right font-semibold text-fg">{p ? formatINR(p.closing_wdv) : '—'}</td>
                      {canManage && (
                        <td className="p-2.5 text-right whitespace-nowrap">
                          {a.status === 'active' && (
                            <>
                              <button onClick={() => setEdit({ id: a.id, kind: 'rate', rate: Number(a.dep_rate), method: a.dep_method, reason: '' })} className="text-brand hover:underline cursor-pointer mr-2">Rate</button>
                              <button onClick={() => setEdit({ id: a.id, kind: 'dispose', date: today(), amount: 0, mode: 'bank', bankId: defaultBankId(banks, 'receipt') ?? '', reason: '' })} className="text-fg-muted hover:text-danger cursor-pointer">Dispose</button>
                            </>
                          )}
                        </td>
                      )}
                    </tr>
                    {edit?.id === a.id && (
                      <tr className="bg-canvas">
                        <td colSpan={8} className="p-2.5">
                          {edit.kind === 'rate' ? (
                            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-end">
                              <label className="space-y-1"><span className="text-fg-muted">Rate %</span>
                                <input type="number" min={0} max={100} step="0.01" value={edit.rate} onChange={e => setEdit({ ...edit, rate: Number(e.target.value) })} className={inputClass} /></label>
                              <label className="space-y-1"><span className="text-fg-muted">Method</span>
                                <select value={edit.method} onChange={e => setEdit({ ...edit, method: e.target.value as 'wdv' | 'slm' })} className={inputClass}>
                                  <option value="wdv">WDV</option><option value="slm">Straight line</option></select></label>
                              <input value={edit.reason} onChange={e => setEdit({ ...edit, reason: e.target.value })} placeholder="Reason (e.g. as advised by CA)" className={`col-span-2 ${inputClass}`} />
                              <button onClick={() => rpc(a.id, 'update_asset', { p_asset_id: a.id, p_name: a.name, p_location: a.location ?? null, p_dep_rate: edit.rate, p_dep_method: edit.method, p_reason: edit.reason || null }, `${a.asset_number} updated.`)}
                                disabled={busy !== null} className="py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold cursor-pointer disabled:opacity-50">Save</button>
                            </div>
                          ) : (
                            <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
                              <label className="space-y-1"><span className="text-fg-muted">Date</span>
                                <input type="date" max={today()} value={edit.date} onChange={e => setEdit({ ...edit, date: e.target.value })} className={inputClass} /></label>
                              <label className="space-y-1"><span className="text-fg-muted">Sold for (₹, 0 = scrapped)</span>
                                <input type="number" min={0} value={edit.amount || ''} onChange={e => setEdit({ ...edit, amount: Number(e.target.value) })} className={inputClass} /></label>
                              <label className="space-y-1"><span className="text-fg-muted">Money received in</span>
                                <select value={edit.mode} onChange={e => setEdit({ ...edit, mode: e.target.value as 'bank' | 'cash' })} className={inputClass}>
                                  <option value="bank">Bank</option><option value="cash">Cash</option></select></label>
                              {edit.mode === 'bank' && banks.length > 1 && (
                                <label className="space-y-1 col-span-2"><span className="text-fg-muted">Received in</span>
                                  <select value={edit.bankId} onChange={e => setEdit({ ...edit, bankId: e.target.value })} className={inputClass}>
                                    {banks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                                  </select></label>
                              )}
                              <input value={edit.reason} onChange={e => setEdit({ ...edit, reason: e.target.value })} placeholder="Reason (e.g. sold as scrap)" className={`col-span-2 ${inputClass}`} />
                              <button onClick={() => rpc(a.id, 'dispose_asset', { p_asset_id: a.id, p_disposed_on: edit.date, p_sale_amount: edit.amount, p_mode: edit.mode, p_reason: edit.reason, p_bank_ledger_id: edit.mode === 'bank' && edit.bankId ? edit.bankId : null }, `${a.asset_number} disposed; gain or loss posted.`)}
                                disabled={busy !== null || !edit.reason.trim()} className="py-2 rounded-lg bg-danger-solid hover:bg-danger text-on-brand font-semibold cursor-pointer disabled:opacity-50">Dispose</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
            <tfoot className="bg-surface font-semibold text-fg">
              <tr className="border-t border-border-strong">
                <td className="p-2.5" colSpan={2}>Total {fyLabel(fyEnd)}</td>
                <td className="p-2.5 text-right">{formatINR(totals.open)}</td><td className="p-2.5 text-right">{formatINR(totals.add)}</td><td />
                <td className="p-2.5 text-right">{formatINR(totals.dep)}</td><td className="p-2.5 text-right">{formatINR(totals.close)}</td>{canManage && <td />}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="p-4 rounded-xl bg-surface border border-border flex flex-wrap items-center justify-between gap-3">
        <div className="text-fg">
          {posted
            ? <>Depreciation for {fyLabel(fyEnd)} posted on {posted.posted_at.slice(0, 10)}: <strong className="text-fg">{formatINR(posted.total)}</strong> (Dr Depreciation · Cr Accumulated Depreciation).</>
            : <>On posting: Dr Depreciation · Cr Accumulated Depreciation <strong className="text-fg">{formatINR(totals.dep)}</strong>. Defaults are Income-tax WDV rates — have your CA confirm them first.</>}
        </div>
        {canManage && !posted && (
          <button onClick={() => rpc('post', 'post_depreciation', { p_society_id: societyId, p_fy_end: fyEnd }, `Depreciation for ${fyLabel(fyEnd)} posted.`)}
            disabled={busy !== null || totals.dep <= 0} className="px-4 py-2 rounded-lg bg-success hover:bg-success/90 text-on-brand font-semibold cursor-pointer disabled:opacity-50">
            {busy === 'post' ? <Loader2 className="w-4 h-4 animate-spin" /> : `Post depreciation for ${fyLabel(fyEnd)}`}
          </button>
        )}
      </div>

      {canManage && (
        <div className="p-4 rounded-xl bg-surface border border-border space-y-3">
          <div className="font-semibold text-fg">Asset types</div>
          <p className="text-fg-muted">Each asset type is a ledger under Fixed Assets. A new asset takes its type&apos;s rate; you can still change an asset&apos;s own rate.</p>
          <table className="w-full">
            <thead className="text-fg-subtle text-left"><tr><th className="py-1">Type</th><th className="py-1 text-right">Depreciation (%)</th><th /></tr></thead>
            <tbody className="divide-y divide-border">
              {assetTypes.map(t => (
                <tr key={t.code}>
                  <td className="py-1.5 text-fg">{t.name} <span className="text-fg-subtle">({t.code})</span></td>
                  <td className="py-1.5 text-right">
                    <input type="number" min={0} max={100} step="0.01" value={rateDrafts[t.code] ?? String(t.dep_rate)}
                      onChange={e => setRateDrafts(d => ({ ...d, [t.code]: e.target.value }))} className={`w-24 text-right ${inputClass}`} />
                  </td>
                  <td className="py-1.5 text-right">
                    {rateDrafts[t.code] !== undefined && Number(rateDrafts[t.code]) !== t.dep_rate && (
                      <button onClick={() => rpc(`rate-${t.code}`, 'set_ledger_dep_rate', { p_society_id: societyId, p_code: t.code, p_rate: Number(rateDrafts[t.code]) }, `${t.name}: depreciation rate saved.`)}
                        disabled={busy !== null} className="text-brand hover:underline cursor-pointer disabled:opacity-50">Save</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex flex-wrap items-center gap-2">
            <input value={newType.name} onChange={e => setNewType({ ...newType, name: e.target.value })} placeholder="New asset type, e.g. Solar Panels" className={`flex-1 min-w-[200px] ${inputClass}`} />
            <input type="number" min={0} max={100} step="0.01" value={newType.rate} onChange={e => setNewType({ ...newType, rate: e.target.value })} className={`w-24 text-right ${inputClass}`} />
            <button onClick={async () => { await rpc('newtype', 'add_asset_ledger', { p_society_id: societyId, p_name: newType.name, p_rate: Number(newType.rate) }, `${newType.name} added as an asset type.`); setNewType({ name: '', rate: '10' }); }}
              disabled={busy !== null || newType.name.trim().length < 2} className="flex items-center gap-1 px-3 py-2 rounded-lg bg-surface-muted hover:bg-border text-fg cursor-pointer disabled:opacity-50">
              <Plus className="w-3.5 h-3.5" /> Add asset type
            </button>
          </div>
        </div>
      )}

      {canManage && (existing ? (
        <div className="p-4 rounded-xl bg-surface border border-border space-y-3">
          <div className="font-semibold text-fg">Add an asset the society already owns</div>
          <p className="text-fg-muted">Its written-down value must already be in your opening balances (account {existing.code}). Use the WDV as on the start of the financial year.</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <input value={existing.name} onChange={e => setExisting({ ...existing, name: e.target.value })} placeholder="e.g. Diesel generator 62.5 kVA" className={`col-span-2 ${inputClass}`} />
            <select value={existing.code} onChange={e => setExisting({ ...existing, code: e.target.value as AssetAccountCode })} className={`col-span-2 ${inputClass}`}>
              {assetTypes.map(t => <option key={t.code} value={t.code}>{t.name} ({t.dep_rate}%)</option>)}
            </select>
            <label className="space-y-1"><span className="text-fg-muted">Bought on</span>
              <input type="date" value={existing.purchased} onChange={e => setExisting({ ...existing, purchased: e.target.value })} className={inputClass} /></label>
            <label className="space-y-1"><span className="text-fg-muted">Original cost (₹)</span>
              <input type="number" min={0} value={existing.cost || ''} onChange={e => setExisting({ ...existing, cost: Number(e.target.value) })} className={inputClass} /></label>
            <label className="space-y-1"><span className="text-fg-muted">WDV (₹)</span>
              <input type="number" min={0} value={existing.wdv || ''} onChange={e => setExisting({ ...existing, wdv: Number(e.target.value) })} className={inputClass} /></label>
            <label className="space-y-1"><span className="text-fg-muted">WDV as on</span>
              <input type="date" value={existing.asOf} onChange={e => setExisting({ ...existing, asOf: e.target.value })} className={inputClass} /></label>
            <input value={existing.location} onChange={e => setExisting({ ...existing, location: e.target.value })} placeholder="Location (optional)" className={`col-span-2 ${inputClass}`} />
            <div className="col-span-2 flex gap-2">
              <button onClick={saveExisting} disabled={busy !== null || !existing.name.trim() || !existing.purchased || !existing.asOf}
                className="flex-1 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold cursor-pointer disabled:opacity-50">Add asset</button>
              <button onClick={() => setExisting(null)} className="px-3 rounded-xl bg-surface-muted text-fg cursor-pointer">Cancel</button>
            </div>
          </div>
        </div>
      ) : (
        <button onClick={() => setExisting({ ...emptyExisting, asOf: `${Number(currentFy.slice(0, 4)) - 1}-04-01` })} className="flex items-center gap-1 text-brand hover:underline cursor-pointer">
          <Plus className="w-3.5 h-3.5" /> Add an asset the society already owns
        </button>
      ))}
    </div>
  );
};
