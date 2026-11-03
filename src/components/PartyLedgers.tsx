'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { Banner } from './Banner';
import { CheckCircle2, Loader2, Store, Users, X } from 'lucide-react';

type Kind = 'flat' | 'vendor';
interface FlatParty { key: string; name: string; owner_name: string | null; dues: number; advance: number; balance: number }
interface VendorParty { key: string; name: string; balance: number }
interface FlatBalances { parties: FlatParty[]; control: { dues: number; advance: number } }
interface VendorBalances { parties: VendorParty[]; control: { payable: number } }
interface Statement {
  name: string;
  opening: number;
  closing: number;
  lines: { date: string; entry_number: string; narration: string; debit: number | null; credit: number | null; balance: number }[];
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fyStart = (d = new Date()) => `${d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1}-04-01`;
const n = (v: unknown) => Number(v ?? 0);
const same = (a: number, b: number) => Math.abs(a - b) < 0.005;
const amount = (v: number) => (same(v, 0) ? '—' : formatINR(v));
const inputClass = 'bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-white outline-none focus:border-sky-500';

const Tie: React.FC<{ ok: boolean; label: string; diff: number }> = ({ ok, label, diff }) =>
  ok
    ? <span className="flex items-center gap-1 text-emerald-300"><CheckCircle2 className="w-3.5 h-3.5" /> Matches {label}</span>
    : <span className="text-rose-300">Differs from {label} by {formatINR(Math.abs(diff))}</span>;

/**
 * Flat-wise and vendor-wise ledgers (025). They are worked out from the bills, payments and vendor
 * bills behind each Members' dues / Sundry Creditors entry, so their totals equal those ledgers.
 */
export const PartyLedgers: React.FC<{ societyId: string }> = ({ societyId }) => {
  const [flats, setFlats] = useState<FlatBalances | null>(null);
  const [vendors, setVendors] = useState<VendorBalances | null>(null);
  const [open, setOpen] = useState<{ kind: Kind; key: string } | null>(null);
  const [range, setRange] = useState({ from: fyStart(), to: iso(new Date()) });
  const [statement, setStatement] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const [fRes, vRes] = await Promise.all([
      supabase.rpc('party_balances', { p_society_id: societyId, p_kind: 'flat' }),
      supabase.rpc('party_balances', { p_society_id: societyId, p_kind: 'vendor' }),
    ]);
    if (fRes.error || vRes.error) setError((fRes.error ?? vRes.error)!.message);
    setFlats(fRes.data as FlatBalances | null);
    setVendors(vRes.data as VendorBalances | null);
    setLoading(false);
  }, [societyId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!supabase || !open) return;
    supabase.rpc('party_statement', { p_society_id: societyId, p_kind: open.kind, p_key: open.key, p_from: range.from, p_to: range.to })
      .then(({ data, error: err }) => {
        if (err) setError(err.message);
        else setStatement(data as Statement);
      });
  }, [societyId, open, range]);

  const pick = (kind: Kind, key: string) => {
    setStatement(null);
    setOpen(o => (o && o.kind === kind && o.key === key ? null : { kind, key }));
  };
  const rowClass = (kind: Kind, key: string) =>
    `cursor-pointer hover:bg-slate-800/60 ${open?.kind === kind && open.key === key ? 'bg-slate-800/80' : ''}`;

  const dues = (flats?.parties ?? []).reduce((s, p) => s + n(p.dues), 0);
  const advance = (flats?.parties ?? []).reduce((s, p) => s + n(p.advance), 0);
  const payable = (vendors?.parties ?? []).reduce((s, p) => s + n(p.balance), 0);

  return (
    <div className="space-y-4 text-xs">
      <Banner tone="error">{error}</Banner>
      {loading && !flats ? (
        <div className="flex items-center gap-2 text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading party ledgers…</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl bg-slate-900 border border-slate-800 overflow-hidden">
            <div className="p-3 font-semibold text-white flex items-center gap-2"><Users className="w-3.5 h-3.5 text-sky-400" /> Members (flat-wise)</div>
            <table className="w-full">
              <thead className="text-slate-500 text-left"><tr><th className="px-3 py-1">Flat</th><th className="px-3 py-1">Owner</th><th className="px-3 py-1 text-right">Dues</th><th className="px-3 py-1 text-right">Advance</th></tr></thead>
              <tbody className="divide-y divide-slate-800">
                {(flats?.parties ?? []).map(p => (
                  <tr key={p.key} onClick={() => pick('flat', p.key)} className={rowClass('flat', p.key)}>
                    <td className="px-3 py-1.5 text-white">{p.name}</td>
                    <td className="px-3 py-1.5 text-slate-400">{p.owner_name ?? '—'}</td>
                    <td className="px-3 py-1.5 text-right text-slate-200">{amount(n(p.dues))}</td>
                    <td className="px-3 py-1.5 text-right text-slate-200">{amount(n(p.advance))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-slate-700 font-semibold">
                <tr><td className="px-3 py-1.5 text-white" colSpan={2}>Total</td><td className="px-3 py-1.5 text-right text-white">{formatINR(dues)}</td><td className="px-3 py-1.5 text-right text-white">{formatINR(advance)}</td></tr>
              </tfoot>
            </table>
            {flats && (
              <div className="p-3 flex flex-wrap gap-4">
                <Tie ok={same(dues, n(flats.control.dues))} label="Members' dues" diff={dues - n(flats.control.dues)} />
                <Tie ok={same(advance, n(flats.control.advance))} label="Advance Maintenance" diff={advance - n(flats.control.advance)} />
              </div>
            )}
          </section>

          <section className="rounded-2xl bg-slate-900 border border-slate-800 overflow-hidden">
            <div className="p-3 font-semibold text-white flex items-center gap-2"><Store className="w-3.5 h-3.5 text-sky-400" /> Vendors</div>
            <table className="w-full">
              <thead className="text-slate-500 text-left"><tr><th className="px-3 py-1">Vendor</th><th className="px-3 py-1 text-right">Payable</th></tr></thead>
              <tbody className="divide-y divide-slate-800">
                {(vendors?.parties ?? []).map(p => (
                  <tr key={p.key} onClick={() => pick('vendor', p.key)} className={rowClass('vendor', p.key)}>
                    <td className="px-3 py-1.5 text-white">{p.name}</td>
                    <td className="px-3 py-1.5 text-right text-slate-200">{amount(n(p.balance))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-slate-700 font-semibold">
                <tr><td className="px-3 py-1.5 text-white">Total</td><td className="px-3 py-1.5 text-right text-white">{formatINR(payable)}</td></tr>
              </tfoot>
            </table>
            {vendors && (
              <div className="p-3">
                <Tie ok={same(payable, n(vendors.control.payable))} label="Sundry Creditors" diff={payable - n(vendors.control.payable)} />
              </div>
            )}
          </section>
        </div>
      )}

      {open && (
        <section className="rounded-2xl bg-slate-900 border border-slate-800 overflow-hidden">
          <div className="p-3 flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold text-white">{statement?.name ?? 'Statement'}</div>
            <div className="flex items-center gap-2 text-slate-400">
              From <input type="date" value={range.from} max={range.to} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} className={inputClass} />
              to <input type="date" value={range.to} min={range.from} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} className={inputClass} />
              <button onClick={() => setOpen(null)} className="p-1 rounded-lg hover:bg-slate-800 cursor-pointer" title="Close"><X className="w-3.5 h-3.5" /></button>
            </div>
          </div>
          {!statement ? (
            <div className="p-3 flex items-center gap-2 text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
          ) : (
            <table className="w-full">
              <thead className="text-slate-500 text-left">
                <tr><th className="px-3 py-1">Date</th><th className="px-3 py-1">Entry</th><th className="px-3 py-1">Narration</th><th className="px-3 py-1 text-right">Debit</th><th className="px-3 py-1 text-right">Credit</th><th className="px-3 py-1 text-right">Balance</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                <tr><td className="px-3 py-1.5 text-slate-400" colSpan={5}>Opening balance</td><td className="px-3 py-1.5 text-right text-white">{formatINR(n(statement.opening))}</td></tr>
                {statement.lines.map((l, i) => (
                  <tr key={`${l.entry_number}-${i}`}>
                    <td className="px-3 py-1.5 text-slate-300">{l.date}</td>
                    <td className="px-3 py-1.5 text-slate-400">{l.entry_number}</td>
                    <td className="px-3 py-1.5 text-slate-300">{l.narration}</td>
                    <td className="px-3 py-1.5 text-right text-slate-200">{l.debit ? formatINR(n(l.debit)) : ''}</td>
                    <td className="px-3 py-1.5 text-right text-slate-200">{l.credit ? formatINR(n(l.credit)) : ''}</td>
                    <td className="px-3 py-1.5 text-right text-white">{formatINR(n(l.balance))}</td>
                  </tr>
                ))}
                <tr className="font-semibold"><td className="px-3 py-1.5 text-white" colSpan={5}>Closing balance</td><td className="px-3 py-1.5 text-right text-white">{formatINR(n(statement.closing))}</td></tr>
              </tbody>
            </table>
          )}
          <p className="px-3 pb-3 text-slate-500">
            {open.kind === 'flat' ? 'A positive balance is what the flat owes; negative is an advance.' : 'The balance is what the society owes the vendor.'}
          </p>
        </section>
      )}
    </div>
  );
};
