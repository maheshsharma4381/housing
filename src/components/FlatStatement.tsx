'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { fyRange, localIso } from '../lib/fy';
import { statementHtml } from '../lib/statement-html';
import { whatsappLink } from '../lib/messages';
import { Link } from '../router/RouterContext';
import { Banner } from './Banner';
import { Loader2, Printer, MessageCircle } from 'lucide-react';

interface Line { date: string; entry_number: string; narration: string; debit: number | null; credit: number | null; balance: number; ref_type: string | null; ref_id: string | null }
interface Statement { name: string; flat: string; from: string; to: string; opening: number; opening_label: string; lines: Line[]; closing: number }

const fmt = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
// a positive balance is what the flat owes the society
const balanceText = (n: number) => (n > 0.005 ? `${formatINR(n)} due` : n < -0.005 ? `${formatINR(-n)} advance` : 'Nil');

/** My account (spec 10.2): the flat's ledger for its owner — the same numbers as the CA's party ledger. */
export const FlatStatement: React.FC<{ unitId: string; societyName: string }> = ({ unitId, societyName }) => {
  const [period, setPeriod] = useState<'this' | 'last' | 'custom'>('this');
  const [custom, setCustom] = useState(() => fyRange('this'));
  const range = useMemo(() => (period === 'custom' ? custom : fyRange(period)), [period, custom]);
  const [st, setSt] = useState<Statement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!supabase || !range.from || !range.to) return;
    setLoading(true);
    supabase.rpc('my_flat_statement', { p_unit_id: unitId, p_from: range.from, p_to: range.to }).then(({ data, error: err }) => {
      setLoading(false);
      if (err) {
        setError(err.message);
        setSt(null);
      } else {
        setError(null);
        setSt(data as Statement);
      }
    });
  }, [unitId, range]);

  const print = () => {
    if (!st) return;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(statementHtml({
      title: `${societyName} · Flat ${st.flat} · ${fmt(st.from)} – ${fmt(st.to)}`,
      openingLabel: st.opening_label,
      statement: { name: st.name, opening: Number(st.opening), closing: Number(st.closing), lines: st.lines.map(l => ({ ...l, debit: l.debit ?? null, credit: l.credit ?? null })) },
    }));
    w.document.close();
  };

  const link = (l: Line) => {
    if (!l.ref_id || !l.ref_type) return null;
    if (l.ref_type.startsWith('bill.')) return `/bill/${l.ref_id}`;
    if (l.ref_type.startsWith('payment.')) return `/receipt/${l.ref_id}`;
    return null;
  };

  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {(['this', 'last', 'custom'] as const).map(p => (
          <button key={p} onClick={() => setPeriod(p)}
            className={`px-3 py-1.5 rounded-full border cursor-pointer ${period === p ? 'bg-sky-600 border-sky-500 text-white' : 'border-slate-700 text-slate-300'}`}>
            {p === 'this' ? 'This year' : p === 'last' ? 'Last year' : 'Custom'}
          </button>
        ))}
      </div>
      {period === 'custom' && (
        <div className="flex gap-2">
          <input type="date" value={custom.from} onChange={e => setCustom({ ...custom, from: e.target.value })} className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-2 py-1.5 text-white" />
          <input type="date" value={custom.to} onChange={e => setCustom({ ...custom, to: e.target.value })} className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-2 py-1.5 text-white" />
        </div>
      )}
      <Banner tone="error">{error}</Banner>
      {loading && <div className="flex justify-center py-4"><Loader2 className="w-4 h-4 animate-spin text-sky-400" /></div>}
      {st && !loading && (
        <div className="rounded-2xl bg-slate-900 border border-slate-800 divide-y divide-slate-800">
          <div className="p-3 flex justify-between text-slate-300">
            <span>{st.opening_label} · {fmt(st.from)}</span><strong className="text-white">{balanceText(Number(st.opening))}</strong>
          </div>
          {st.lines.map((l, i) => {
            const href = link(l);
            return (
              <div key={i} className="p-3 flex justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-slate-400">{fmt(l.date)}</div>
                  {href ? <Link href={href} className="text-sky-400 hover:underline">{l.narration}</Link> : <div className="text-white">{l.narration}</div>}
                </div>
                <div className="text-right shrink-0">
                  {l.debit ? <div className="text-rose-300">+ {formatINR(l.debit)}</div> : <div className="text-emerald-300">− {formatINR(l.credit ?? 0)}</div>}
                  <div className="text-slate-500">{balanceText(Number(l.balance))}</div>
                </div>
              </div>
            );
          })}
          {st.lines.length === 0 && <p className="p-3 text-slate-500">No entries in this period.</p>}
          {/* a period that runs past today shows today's balance, not a forecast for its last day */}
          <div className="p-3 flex justify-between font-bold text-white">
            <span>{st.to >= localIso(new Date()) ? 'Balance today' : `Closing balance · ${fmt(st.to)}`}</span>
            <span>{balanceText(Number(st.closing))}</span>
          </div>
        </div>
      )}
      {st && (
        <div className="flex gap-2">
          <button onClick={print} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer">
            <Printer className="w-3.5 h-3.5" /> Download PDF
          </button>
          <a href={whatsappLink(`${societyName}: Flat ${st.flat} statement ${fmt(st.from)} – ${fmt(st.to)}. Closing balance: ${balanceText(Number(st.closing))}.`)}
            target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold">
            <MessageCircle className="w-3.5 h-3.5" /> Share on WhatsApp
          </a>
        </div>
      )}
    </div>
  );
};
