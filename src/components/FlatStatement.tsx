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
            className={`px-3 py-1.5 rounded-full border cursor-pointer ${period === p ? 'bg-brand border-brand text-on-brand' : 'border-border-strong text-fg'}`}>
            {p === 'this' ? 'This year' : p === 'last' ? 'Last year' : 'Custom'}
          </button>
        ))}
      </div>
      {period === 'custom' && (
        <div className="flex gap-2">
          <input type="date" value={custom.from} onChange={e => setCustom({ ...custom, from: e.target.value })} className="flex-1 bg-surface border border-border-strong rounded-lg px-2 py-1.5 text-fg" />
          <input type="date" value={custom.to} onChange={e => setCustom({ ...custom, to: e.target.value })} className="flex-1 bg-surface border border-border-strong rounded-lg px-2 py-1.5 text-fg" />
        </div>
      )}
      <Banner tone="error">{error}</Banner>
      {loading && <div className="flex justify-center py-4"><Loader2 className="w-4 h-4 animate-spin text-brand" /></div>}
      {st && !loading && (
        <div className="rounded-xl bg-surface border border-border divide-y divide-border">
          <div className="p-3 flex justify-between text-fg">
            <span>{st.opening_label} · {fmt(st.from)}</span><strong className="text-fg">{balanceText(Number(st.opening))}</strong>
          </div>
          {st.lines.map((l, i) => {
            const href = link(l);
            return (
              <div key={i} className="p-3 flex justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-fg-muted">{fmt(l.date)}</div>
                  {href ? <Link href={href} className="text-brand hover:underline">{l.narration}</Link> : <div className="text-fg">{l.narration}</div>}
                </div>
                <div className="text-right shrink-0">
                  {l.debit ? <div className="text-danger">+ {formatINR(l.debit)}</div> : <div className="text-success">− {formatINR(l.credit ?? 0)}</div>}
                  <div className="text-fg-subtle">{balanceText(Number(l.balance))}</div>
                </div>
              </div>
            );
          })}
          {st.lines.length === 0 && <p className="p-3 text-fg-subtle">No entries in this period.</p>}
          {/* a period that runs past today shows today's balance, not a forecast for its last day */}
          <div className="p-3 flex justify-between font-semibold text-fg">
            <span>{st.to >= localIso(new Date()) ? 'Balance today' : `Closing balance · ${fmt(st.to)}`}</span>
            <span>{balanceText(Number(st.closing))}</span>
          </div>
        </div>
      )}
      {st && (
        <div className="flex gap-2">
          <button onClick={print} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold cursor-pointer">
            <Printer className="w-3.5 h-3.5" /> Download PDF
          </button>
          <a href={whatsappLink(`${societyName}: Flat ${st.flat} statement ${fmt(st.from)} – ${fmt(st.to)}. Closing balance: ${balanceText(Number(st.closing))}.`)}
            target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-success hover:bg-success/90 text-on-brand font-semibold">
            <MessageCircle className="w-3.5 h-3.5" /> Share on WhatsApp
          </a>
        </div>
      )}
    </div>
  );
};
