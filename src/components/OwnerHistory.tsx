'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { Banner } from './Banner';
import { Loader2, Printer, Users } from 'lucide-react';

interface Period { id: string; owner_name: string; owner_email: string | null; owner_mobile: string | null; from_date: string; to_date: string | null; joined: boolean }
interface Statement {
  name: string;
  opening: number;
  closing: number;
  lines: { date: string; entry_number: string; narration: string; debit: number | null; credit: number | null; balance: number }[];
}

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const showDate = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const n = (v: unknown) => Number(v ?? 0);

/** Who owned the flat from when to when (029), each with a statement of their period. */
export const OwnerHistory: React.FC<{ societyId: string; unitId: string }> = ({ societyId, unitId }) => {
  const [periods, setPeriods] = useState<Period[] | null>(null);
  const [open, setOpen] = useState<{ index: number; statement: Statement | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data, error: err } = await supabase.rpc('flat_owner_periods', { p_unit_id: unitId });
    if (err) setError(err.message);
    else setPeriods((data ?? []) as Period[]);
  }, [unitId]);

  useEffect(() => {
    load();
  }, [load]);

  const showStatement = async (index: number) => {
    if (!supabase || !periods) return;
    const p = periods[index];
    setOpen({ index, statement: null });
    const { data, error: err } = await supabase.rpc('party_statement', {
      p_society_id: societyId, p_kind: 'flat', p_key: unitId, p_from: p.from_date, p_to: p.to_date ?? todayIso(),
    });
    if (err) return setError(err.message);
    setOpen({ index, statement: data as Statement });
  };

  if (!periods) return <div className="flex items-center gap-2 text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading owners…</div>;

  return (
    <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
      <div className="font-semibold text-white flex items-center gap-1.5"><Users className="w-3.5 h-3.5 text-sky-400" /> Owners</div>
      <Banner tone="error">{error}</Banner>
      {periods.length === 0 && <p className="text-slate-400">No owner has joined for this flat yet.</p>}
      <ul className="space-y-1">
        {periods.map((p, i) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-slate-200">
              {p.owner_name} · {showDate(p.from_date)} – {p.to_date ? showDate(p.to_date) : 'now'}{p.joined ? '' : ' · invited'}
            </span>
            <button onClick={() => showStatement(i)} className="text-sky-400 hover:underline cursor-pointer">Statement</button>
          </li>
        ))}
      </ul>
      {open && periods[open.index] && (
        <div className="space-y-2 print:text-black">
          {!open.statement ? (
            <div className="flex items-center gap-2 text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading statement…</div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div className="text-white font-semibold">{open.statement.name} · {periods[open.index].owner_name}</div>
                <button onClick={() => window.print()} className="flex items-center gap-1 text-slate-300 hover:text-white cursor-pointer print:hidden">
                  <Printer className="w-3.5 h-3.5" /> Print
                </button>
              </div>
              <table className="w-full">
                <thead className="text-slate-500 text-left">
                  <tr><th className="py-1">Date</th><th className="py-1">Entry</th><th className="py-1">Narration</th><th className="py-1 text-right">Debit</th><th className="py-1 text-right">Credit</th><th className="py-1 text-right">Balance</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  <tr>
                    <td className="py-1 text-slate-400" colSpan={5}>{open.index > 0 ? 'Brought forward from previous owner' : 'Opening balance'}</td>
                    <td className="py-1 text-right text-white">{formatINR(n(open.statement.opening))}</td>
                  </tr>
                  {open.statement.lines.map((l, i) => (
                    <tr key={`${l.entry_number}-${i}`}>
                      <td className="py-1 text-slate-300">{l.date}</td>
                      <td className="py-1 text-slate-400">{l.entry_number}</td>
                      <td className="py-1 text-slate-300">{l.narration}</td>
                      <td className="py-1 text-right text-slate-200">{l.debit ? formatINR(n(l.debit)) : ''}</td>
                      <td className="py-1 text-right text-slate-200">{l.credit ? formatINR(n(l.credit)) : ''}</td>
                      <td className="py-1 text-right text-white">{formatINR(n(l.balance))}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className="py-1 text-white" colSpan={5}>Closing balance</td>
                    <td className="py-1 text-right text-white">{formatINR(n(open.statement.closing))}</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
};
