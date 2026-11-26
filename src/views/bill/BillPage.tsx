'use client';

import React, { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { supabase } from '../../lib/supabase/client';
import { amountInWords, formatINR } from '../../lib/inr';
import { useRouter } from '../../router/RouterContext';
import { billView } from '../../lib/bill-view';
import { ArrowLeft, Printer, Loader2 } from 'lucide-react';

interface BillDocument {
  society: {
    name: string; registration_number: string | null; address: string; upi_id: string | null; payee_name: string | null;
    bank: { bank_name: string; account_number: string; ifsc: string; branch: string } | null;
  };
  flat: { number: string; wing: string | null; area: number | null };
  member_name: string | null;
  bill: {
    id: string; number: string; bill_date: string; due_date: string; period: string | null; period_start: string | null; period_end: string | null;
    status: string; items: { description: string; quantity: number; rate: number; amount: number; tax: number; total: number }[];
    subtotal: number; tax: number; late_fee: number; total: number; paid: number; balance: number;
  };
  arrears: number;
  advance: number;
  payable: number;
  late_fee_rule: string | null;
}

const fmtDate = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

/** The maintenance bill in the usual society format, printable as PDF (spec 9.2). */
export const BillPage: React.FC<{ billId: string }> = ({ billId }) => {
  const { navigate } = useRouter();
  const [doc, setDoc] = useState<BillDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.rpc('bill_document', { p_bill_id: billId }).then(({ data, error: err }) => {
      if (err) setError(err.message.includes('not found') ? 'Bill not found or you do not have access to it.' : err.message);
      else setDoc(data as BillDocument);
    });
  }, [billId]);

  if (error) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="max-w-sm p-6 rounded-2xl bg-slate-900 border border-slate-800 text-center text-xs text-slate-300 space-y-3">
          <p>{error}</p>
          <button onClick={() => navigate('/')} className="text-sky-400 hover:underline cursor-pointer">Go back</button>
        </div>
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-400 text-xs gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading bill…
      </div>
    );
  }

  const { society: s, bill: b } = doc;
  const view = billView(b.status, Number(b.balance));
  // a cancelled or paid bill asks for nothing: no total payable and no QR
  const payable = view.asksForPayment ? Number(doc.payable) : 0;
  const upi = s.upi_id && payable > 0
    ? `upi://pay?${new URLSearchParams({ pa: s.upi_id, pn: s.payee_name ?? s.name, am: payable.toFixed(2), cu: 'INR', tn: `${b.number} Flat ${doc.flat.number}` }).toString()}`
    : null;

  return (
    <div className="min-h-screen bg-slate-950 print:bg-white py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center justify-between print:hidden">
          <button onClick={() => window.history.back()} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white cursor-pointer">
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </button>
          <button onClick={() => window.print()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold cursor-pointer">
            <Printer className="w-3.5 h-3.5" /> Print / Save PDF
          </button>
        </div>

        <div className="palette-native bg-white text-slate-900 rounded-2xl print:rounded-none p-6 sm:p-8 shadow-xl print:shadow-none space-y-6 text-sm">
          <header className="text-center border-b border-slate-200 pb-4 space-y-1">
            <h1 className="text-xl font-bold">{s.name}</h1>
            {s.registration_number && <div className="text-xs text-slate-500">Reg. No. {s.registration_number}</div>}
            <div className="text-xs text-slate-500">{s.address}</div>
            <div className={`pt-2 text-base font-semibold tracking-widest ${b.status === 'cancelled' ? 'text-rose-600' : ''}`}>{view.heading}</div>
          </header>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
            <dt className="text-slate-500">Member</dt><dd className="font-semibold text-right">{doc.member_name ?? '—'}</dd>
            <dt className="text-slate-500">Flat</dt><dd className="text-right">{doc.flat.number}{doc.flat.area ? ` · ${doc.flat.area} sq.ft` : ''}</dd>
            <dt className="text-slate-500">Bill No.</dt><dd className="font-mono font-semibold text-right">{b.number}</dd>
            <dt className="text-slate-500">Bill Date</dt><dd className="text-right">{fmtDate(b.bill_date)}</dd>
            <dt className="text-slate-500">Period</dt>
            <dd className="text-right">{b.period_start ? `${fmtDate(b.period_start)} – ${fmtDate(b.period_end)}` : b.period ?? '—'}</dd>
            <dt className="text-slate-500">Due Date</dt><dd className="font-semibold text-right">{fmtDate(b.due_date)}</dd>
          </dl>

          <table className="w-full text-xs border-t border-slate-200">
            <thead>
              <tr className="text-slate-500"><th className="text-left py-2">Particulars</th><th className="text-right py-2">Amount</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {b.items.map((i, n) => (
                <tr key={n}>
                  <td className="py-2">{i.description}{Number(i.quantity) !== 1 ? ` (${i.quantity} × ${formatINR(i.rate)})` : ''}</td>
                  <td className="py-2 text-right">{formatINR(i.amount)}</td>
                </tr>
              ))}
              {Number(b.tax) > 0 && <tr><td className="py-2">GST</td><td className="py-2 text-right">{formatINR(b.tax)}</td></tr>}
              {Number(b.late_fee) > 0 && <tr><td className="py-2">Late fee</td><td className="py-2 text-right">{formatINR(b.late_fee)}</td></tr>}
              <tr className="font-semibold"><td className="py-2">This bill</td><td className="py-2 text-right">{formatINR(b.total)}</td></tr>
              {Number(b.paid) > 0 && <tr><td className="py-2">Less: paid against this bill</td><td className="py-2 text-right">− {formatINR(b.paid)}</td></tr>}
              {Number(doc.arrears) > 0 && <tr><td className="py-2">Add: previous dues</td><td className="py-2 text-right">{formatINR(doc.arrears)}</td></tr>}
              {view.asksForPayment && Number(doc.advance) > 0 && <tr><td className="py-2">Less: advance with the society</td><td className="py-2 text-right">− {formatINR(doc.advance)}</td></tr>}
            </tbody>
            {view.asksForPayment && (
              <tfoot>
                <tr className="border-t border-slate-300 font-bold text-sm">
                  <td className="py-2">Total payable by {fmtDate(b.due_date)}</td><td className="py-2 text-right">{formatINR(payable)}</td>
                </tr>
              </tfoot>
            )}
          </table>
          {payable > 0 && <p className="text-xs italic text-slate-600">{amountInWords(payable)}</p>}
          {b.status === 'cancelled' && <p className="text-xs font-semibold text-rose-600">This bill was cancelled. Nothing is payable against it.</p>}

          <footer className="pt-4 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-4 text-[11px] text-slate-600 items-start">
            {upi && (
              <div className="text-center space-y-1">
                <QRCodeSVG value={upi} size={112} />
                <div>Scan to pay {formatINR(payable)}</div>
              </div>
            )}
            <div className="space-y-1">
              {s.upi_id && <div>UPI: <strong>{s.upi_id}</strong></div>}
              {s.bank && <div>Bank: {s.bank.bank_name}, A/c {s.bank.account_number}, IFSC {s.bank.ifsc}{s.bank.branch ? `, ${s.bank.branch}` : ''}</div>}
              {doc.late_fee_rule && <div>Late fee: {doc.late_fee_rule}.</div>}
              <div>Computer-generated bill. For {s.name}, Secretary / Treasurer.</div>
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
};
