'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { ASSET_TYPES } from '../lib/tds';
import { Banner } from './Banner';
import { ExpenseCategory, TdsNature, TdsRule } from '../types/database';
import { Loader2, Plus, Save } from 'lucide-react';

const NATURES: { value: TdsNature; label: string }[] = [
  { value: 'none', label: 'No TDS' },
  { value: 'goods', label: 'Purchase of goods (no TDS)' },
  { value: 'contract', label: 'Contract work' },
  { value: 'professional', label: 'Professional fees' },
  { value: 'technical', label: 'Technical services' },
  { value: 'rent_building', label: 'Rent — building' },
  { value: 'rent_machinery', label: 'Rent — machinery' },
];

const emptyCategory = { key: '', label: '', account_code: '5900', tds_nature: 'none' as TdsNature, asset_account_code: '', asset_threshold: '' };

/** Platform-owner screen: TDS rates / limits (dated versions) and the default expense categories. */
export const TaxRulesPanel: React.FC<{ currentUserId?: string }> = ({ currentUserId }) => {
  const [rules, setRules] = useState<TdsRule[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [noPanRate, setNoPanRate] = useState(20);
  const [newFrom, setNewFrom] = useState('');
  const [newCategory, setNewCategory] = useState<typeof emptyCategory | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [rRes, cRes, sRes] = await Promise.all([
      supabase.from('tds_rules').select('*').order('effective_from', { ascending: false }).order('nature'),
      supabase.from('expense_categories').select('*').is('society_id', null).order('sort_order'),
      supabase.from('platform_settings').select('value').eq('key', 'tds_no_pan_rate').maybeSingle(),
    ]);
    if (rRes.error) return setError(rRes.error.message);
    setRules((rRes.data ?? []) as TdsRule[]);
    setCategories((cRes.data ?? []) as ExpenseCategory[]);
    setNoPanRate(Number((sRes.data?.value as { rate?: number } | undefined)?.rate ?? 20));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const latestFrom = rules[0]?.effective_from;
  const current = rules.filter(r => r.effective_from === latestFrom);

  const editRule = (id: string, patch: Partial<TdsRule>) => setRules(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)));
  const editCategory = (id: string, patch: Partial<ExpenseCategory>) => setCategories(cs => cs.map(c => (c.id === id ? { ...c, ...patch } : c)));

  const run = async (key: string, fn: () => Promise<{ error: { message: string } | null }>, msg: string) => {
    setBusy(key);
    const { error: err } = await fn();
    setBusy(null);
    if (err) return setError(err.message);
    setError(null);
    setNotice(msg);
    load();
  };

  const saveRules = () => run('rules', async () => {
    for (const r of current) {
      const { error: err } = await supabase!.from('tds_rules').update({
        label: r.label, section_label: r.section_label, rate_individual: r.rate_individual, rate_other: r.rate_other,
        single_bill_limit: r.single_bill_limit, annual_limit: r.annual_limit, is_active: r.is_active,
        updated_by: currentUserId ?? null, updated_at: new Date().toISOString(),
      }).eq('id', r.id);
      if (err) return { error: err };
    }
    return supabase!.from('platform_settings').update({ value: { rate: noPanRate } }).eq('key', 'tds_no_pan_rate');
  }, 'Tax rules saved. New bills use them right away; saved bills keep the rule they used.');

  // A law change from a date: copy the current rules as a new dated version, then edit that
  const newVersion = () => run('version', async () => supabase!.from('tds_rules').insert(current.map(r => ({
    nature: r.nature, label: r.label, section_label: r.section_label, rate_individual: r.rate_individual, rate_other: r.rate_other,
    single_bill_limit: r.single_bill_limit, annual_limit: r.annual_limit, effective_from: newFrom, updated_by: currentUserId ?? null,
  }))), `New rule version from ${newFrom} created — edit the rates below.`);

  const saveCategories = () => run('categories', async () => {
    for (const c of categories) {
      const { error: err } = await supabase!.from('expense_categories').update({
        label: c.label, account_code: c.account_code, tds_nature: c.tds_nature,
        asset_account_code: c.asset_account_code || null, asset_threshold: c.asset_threshold ?? null, is_active: c.is_active,
      }).eq('id', c.id);
      if (err) return { error: err };
    }
    return { error: null };
  }, 'Categories saved.');

  const addCategory = () => newCategory && run('add', async () => supabase!.from('expense_categories').insert({
    society_id: null, key: newCategory.key.trim().toLowerCase(), label: newCategory.label.trim(), account_code: newCategory.account_code,
    tds_nature: newCategory.tds_nature, asset_account_code: newCategory.asset_account_code || null,
    asset_threshold: newCategory.asset_threshold ? Number(newCategory.asset_threshold) : null, sort_order: 500,
  }), 'Category added.').then(() => setNewCategory(null));

  const num = (v: string) => (v === '' ? null : Number(v));
  const cell = 'bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-white outline-none focus:border-purple-500';

  return (
    <div className="space-y-6 text-xs">
      <div>
        <h2 className="text-lg font-bold text-white">Tax rules</h2>
        <p className="text-slate-400">TDS rates and limits for every society. Each bill stores the rule it used. Have a CA confirm these — the Income-tax Act, 2025 renumbers sections from 1 Apr 2026, so section labels are editable.</p>
      </div>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      <section className="bg-slate-950 border border-slate-800 rounded-2xl overflow-x-auto">
        <div className="p-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-800">
          <div className="font-bold text-white">TDS rates · in force from {latestFrom ?? '—'}</div>
          <div className="flex items-center gap-2">
            <input type="date" value={newFrom} onChange={e => setNewFrom(e.target.value)} className={cell} />
            <button onClick={newVersion} disabled={!newFrom || (latestFrom != null && newFrom <= latestFrom) || busy !== null}
              className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 cursor-pointer disabled:opacity-50">New version from this date</button>
          </div>
        </div>
        <table className="w-full min-w-[820px] text-left">
          <thead className="text-slate-400"><tr>
            <th className="p-2">Nature</th><th className="p-2">Section</th><th className="p-2">Individual / HUF %</th><th className="p-2">Company / others %</th>
            <th className="p-2">One bill above ₹</th><th className="p-2">Yearly total above ₹</th><th className="p-2">Active</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-800 text-slate-200">
            {current.map(r => (
              <tr key={r.id}>
                <td className="p-2"><input value={r.label} onChange={e => editRule(r.id, { label: e.target.value })} className={`w-44 ${cell}`} /></td>
                <td className="p-2"><input value={r.section_label} onChange={e => editRule(r.id, { section_label: e.target.value })} className={`w-20 ${cell}`} /></td>
                <td className="p-2"><input type="number" step="0.01" min={0} max={100} value={r.rate_individual} onChange={e => editRule(r.id, { rate_individual: Number(e.target.value) })} className={`w-20 ${cell}`} /></td>
                <td className="p-2"><input type="number" step="0.01" min={0} max={100} value={r.rate_other} onChange={e => editRule(r.id, { rate_other: Number(e.target.value) })} className={`w-20 ${cell}`} /></td>
                <td className="p-2"><input type="number" min={0} value={r.single_bill_limit ?? ''} placeholder="—" onChange={e => editRule(r.id, { single_bill_limit: num(e.target.value) })} className={`w-28 ${cell}`} /></td>
                <td className="p-2"><input type="number" min={0} value={r.annual_limit ?? ''} placeholder="—" onChange={e => editRule(r.id, { annual_limit: num(e.target.value) })} className={`w-28 ${cell}`} /></td>
                <td className="p-2"><input type="checkbox" checked={r.is_active} onChange={e => editRule(r.id, { is_active: e.target.checked })} className="accent-purple-500" /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="p-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800">
          <label className="flex items-center gap-2 text-slate-300">Vendor has no PAN (206AA): <input type="number" min={0} max={100} value={noPanRate} onChange={e => setNoPanRate(Number(e.target.value))} className={`w-20 ${cell}`} /> %</label>
          <button onClick={saveRules} disabled={busy !== null} className="flex items-center gap-1 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold cursor-pointer disabled:opacity-50">
            {busy === 'rules' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save rates
          </button>
        </div>
        {rules.length > current.length && (
          <div className="p-3 border-t border-slate-800 text-slate-500">Older versions kept for bills dated before {latestFrom}: {[...new Set(rules.map(r => r.effective_from))].filter(d => d !== latestFrom).join(', ')}</div>
        )}
      </section>

      <section className="bg-slate-950 border border-slate-800 rounded-2xl overflow-x-auto">
        <div className="p-3 font-bold text-white border-b border-slate-800">Expense categories (defaults for every society)</div>
        <table className="w-full min-w-[820px] text-left">
          <thead className="text-slate-400"><tr>
            <th className="p-2">Category</th><th className="p-2">Ledger head</th><th className="p-2">TDS</th><th className="p-2">Can be an asset</th><th className="p-2">Suggest asset from ₹</th><th className="p-2">On</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-800 text-slate-200">
            {categories.map(c => (
              <tr key={c.id}>
                <td className="p-2"><input value={c.label} onChange={e => editCategory(c.id, { label: e.target.value })} className={`w-48 ${cell}`} /> <span className="font-mono text-slate-500">{c.key}</span></td>
                <td className="p-2"><input value={c.account_code} onChange={e => editCategory(c.id, { account_code: e.target.value })} className={`w-16 ${cell}`} /></td>
                <td className="p-2"><select value={c.tds_nature} onChange={e => editCategory(c.id, { tds_nature: e.target.value as TdsNature })} className={cell}>
                  {NATURES.map(n => <option key={n.value} value={n.value}>{n.label}</option>)}</select></td>
                <td className="p-2"><select value={c.asset_account_code ?? ''} onChange={e => editCategory(c.id, { asset_account_code: (e.target.value || null) as ExpenseCategory['asset_account_code'] })} className={cell}>
                  <option value="">Never</option>{ASSET_TYPES.map(a => <option key={a.code} value={a.code}>{a.label}</option>)}</select></td>
                <td className="p-2"><input type="number" min={0} value={c.asset_threshold ?? ''} placeholder="—" onChange={e => editCategory(c.id, { asset_threshold: num(e.target.value) })} className={`w-24 ${cell}`} />
                  {c.asset_threshold != null && <span className="ml-1 text-slate-500">{formatINR(c.asset_threshold)}</span>}</td>
                <td className="p-2"><input type="checkbox" checked={c.is_active} onChange={e => editCategory(c.id, { is_active: e.target.checked })} className="accent-purple-500" /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="p-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800">
          {newCategory ? (
            <div className="flex flex-wrap items-center gap-2">
              <input value={newCategory.key} onChange={e => setNewCategory({ ...newCategory, key: e.target.value })} placeholder="key e.g. solar" className={`w-28 ${cell}`} />
              <input value={newCategory.label} onChange={e => setNewCategory({ ...newCategory, label: e.target.value })} placeholder="Label" className={`w-40 ${cell}`} />
              <input value={newCategory.account_code} onChange={e => setNewCategory({ ...newCategory, account_code: e.target.value })} placeholder="Head" className={`w-16 ${cell}`} />
              <select value={newCategory.tds_nature} onChange={e => setNewCategory({ ...newCategory, tds_nature: e.target.value as TdsNature })} className={cell}>
                {NATURES.map(n => <option key={n.value} value={n.value}>{n.label}</option>)}</select>
              <select value={newCategory.asset_account_code} onChange={e => setNewCategory({ ...newCategory, asset_account_code: e.target.value })} className={cell}>
                <option value="">Never an asset</option>{ASSET_TYPES.map(a => <option key={a.code} value={a.code}>{a.label}</option>)}</select>
              <input type="number" value={newCategory.asset_threshold} onChange={e => setNewCategory({ ...newCategory, asset_threshold: e.target.value })} placeholder="Asset from ₹" className={`w-28 ${cell}`} />
              <button onClick={addCategory} disabled={!/^[a-z0-9_]+$/.test(newCategory.key.trim().toLowerCase()) || !newCategory.label.trim() || busy !== null}
                className="px-3 py-1.5 rounded-lg bg-purple-600 text-white cursor-pointer disabled:opacity-50">Add</button>
              <button onClick={() => setNewCategory(null)} className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 cursor-pointer">Cancel</button>
            </div>
          ) : (
            <button onClick={() => setNewCategory(emptyCategory)} className="flex items-center gap-1 text-purple-300 hover:underline cursor-pointer"><Plus className="w-3.5 h-3.5" /> Add category</button>
          )}
          <button onClick={saveCategories} disabled={busy !== null} className="flex items-center gap-1 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold cursor-pointer disabled:opacity-50">
            {busy === 'categories' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save categories
          </button>
        </div>
      </section>
    </div>
  );
};
