'use client';

import React, { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { supabase } from '../../lib/supabase/client';
import { amountInWords, formatINR } from '../../lib/inr';
import { useRouter } from '../../router/RouterContext';
import { billView } from '../../lib/bill-view';
import { Printer } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { DocumentPage, DocumentState, Paper, Letterhead, DocFacts } from '../../components/ui/DocumentPaper';

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

const fmtDate = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');

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

  if (error) return <DocumentState error={error} onBack={() => navigate('/')} />;
  if (!doc) return <DocumentState loading="Loading bill…" />;

  const { society: s, bill: b } = doc;
  const view = billView(b.status, Number(b.balance));
  // a cancelled or paid bill asks for nothing: no total payable and no QR
  const payable = view.asksForPayment ? Number(doc.payable) : 0;
  const upi = s.upi_id && payable > 0
    ? `upi://pay?${new URLSearchParams({ pa: s.upi_id, pn: s.payee_name ?? s.name, am: payable.toFixed(2), cu: 'INR', tn: `${b.number} Flat ${doc.flat.number}` }).toString()}`
    : null;

  return (
    <DocumentPage actions={<Button size="sm" onClick={() => window.print()} leftIcon={<Printer className="w-4 h-4" />}>Print / Save PDF</Button>}>
      <Paper>
        <Letterhead society={s.name} registration={s.registration_number} address={s.address}
          title={view.heading} number={b.number} date={`Bill date ${fmtDate(b.bill_date)}`} titleTone={b.status === 'cancelled' ? 'danger' : 'default'} />

        <DocFacts rows={[
          ['Member', doc.member_name ?? '—'],
          ['Flat', `${doc.flat.number}${doc.flat.area ? ` · ${doc.flat.area} sq.ft` : ''}`],
          ['Period', b.period_start ? `${fmtDate(b.period_start)} – ${fmtDate(b.period_end)}` : b.period ?? '—'],
          ['Due date', <strong key="due">{fmtDate(b.due_date)}</strong>],
        ]} />

        <table className="w-full">
          <thead>
            <tr className="bg-slate-100 text-slate-600 text-xs">
              <th className="text-left font-semibold py-2 px-3">Particulars</th>
              <th className="text-right font-semibold py-2 px-3 w-40">Amount (₹)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {b.items.map((i, n) => (
              <tr key={n}>
                <td className="py-2.5 px-3">{i.description}{Number(i.quantity) !== 1 ? <span className="text-slate-500"> ({i.quantity} × {formatINR(i.rate)})</span> : ''}</td>
                <td className="py-2.5 px-3 text-right">{formatINR(i.amount)}</td>
              </tr>
            ))}
            {Number(b.tax) > 0 && <tr><td className="py-2.5 px-3">GST</td><td className="py-2.5 px-3 text-right">{formatINR(b.tax)}</td></tr>}
            {Number(b.late_fee) > 0 && <tr><td className="py-2.5 px-3">Late fee</td><td className="py-2.5 px-3 text-right">{formatINR(b.late_fee)}</td></tr>}
            <tr className="font-semibold border-t border-slate-300"><td className="py-2.5 px-3">This bill</td><td className="py-2.5 px-3 text-right">{formatINR(b.total)}</td></tr>
            {Number(b.paid) > 0 && <tr><td className="py-2.5 px-3">Less: paid against this bill</td><td className="py-2.5 px-3 text-right">− {formatINR(b.paid)}</td></tr>}
            {Number(doc.arrears) > 0 && <tr><td className="py-2.5 px-3">Add: previous dues</td><td className="py-2.5 px-3 text-right">{formatINR(doc.arrears)}</td></tr>}
            {view.asksForPayment && Number(doc.advance) > 0 && <tr><td className="py-2.5 px-3">Less: advance with the society</td><td className="py-2.5 px-3 text-right">− {formatINR(doc.advance)}</td></tr>}
          </tbody>
        </table>

        {view.asksForPayment && (
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <p className="text-xs italic text-slate-600 max-w-sm">{payable > 0 ? amountInWords(payable) : ''}</p>
            <div className="sm:min-w-64 rounded-lg border-2 border-slate-900 px-4 py-3 text-right">
              <div className="text-xs text-slate-600">Total payable by {fmtDate(b.due_date)}</div>
              <div className="text-2xl font-semibold text-slate-900">{formatINR(payable)}</div>
            </div>
          </div>
        )}
        {b.status === 'cancelled' && <p className="text-sm font-semibold text-rose-600">This bill was cancelled. Nothing is payable against it.</p>}

        <footer className="pt-5 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-5 text-xs text-slate-600 items-start">
          {upi && (
            <div className="flex flex-col items-center gap-1 p-2 rounded-lg border border-slate-200 w-fit">
              <QRCodeSVG value={upi} size={112} />
              <div className="font-medium text-slate-900">Scan to pay {formatINR(payable)}</div>
            </div>
          )}
          <div className="space-y-1.5">
            <div className="text-slate-900 font-semibold">How to pay</div>
            {s.upi_id && <div>UPI: <strong className="text-slate-900">{s.upi_id}</strong></div>}
            {s.bank && <div>Bank: {s.bank.bank_name}, A/c {s.bank.account_number}, IFSC {s.bank.ifsc}{s.bank.branch ? `, ${s.bank.branch}` : ''}</div>}
            {doc.late_fee_rule && <div>Late fee: {doc.late_fee_rule}.</div>}
            <div className="pt-2 text-slate-500">Computer-generated bill. For {s.name}, Secretary / Treasurer.</div>
          </div>
        </footer>
      </Paper>
    </DocumentPage>
  );
};
