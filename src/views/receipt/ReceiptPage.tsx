'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase/client';
import { amountInWords, formatINR } from '../../lib/inr';
import { useRouter } from '../../router/RouterContext';
import { receiptText, whatsappLink } from '../../lib/messages';
import { ArrowLeft, Printer, Loader2, MessageCircle } from 'lucide-react';

interface ReceiptData {
  id: string;
  amount: number;
  payment_method: string;
  transaction_reference_utr: string;
  payment_date: string;
  status: string;
  receipt_number: string | null;
  verified_at: string | null;
  profiles: { full_name: string } | null;
  units: { unit_number: string } | null;
  societies: {
    name: string;
    registration_number: string | null;
    address_line1: string;
    address_line2: string | null;
    city: string;
    state: string;
    pincode: string;
  } | null;
  payment_allocations: { amount: number; bills: { bill_number: string; due_date: string } | null }[];
}

export const ReceiptPage: React.FC<{ paymentId: string }> = ({ paymentId }) => {
  const { navigate } = useRouter();
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase
      .from('payments')
      .select(`
        id, amount, payment_method, transaction_reference_utr, payment_date, status, receipt_number, verified_at,
        profiles:user_id (full_name),
        units:unit_id (unit_number),
        societies:society_id (name, registration_number, address_line1, address_line2, city, state, pincode),
        payment_allocations (amount, bills:bill_id (bill_number, due_date))
      `)
      .eq('id', paymentId)
      .maybeSingle()
      .then(({ data, error: loadErr }) => {
        if (loadErr) setError(loadErr.message);
        else if (!data) setError('Receipt not found or you do not have access to it.');
        else setReceipt((data as unknown) as ReceiptData);
      });
  }, [paymentId]);

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

  if (!receipt) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-400 text-xs gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading receipt…
      </div>
    );
  }

  if (receipt.status !== 'verified' || !receipt.receipt_number) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4 text-xs text-slate-300">
        This payment is {receipt.status.replace('_', ' ')} — a receipt is issued once the treasurer verifies it.
      </div>
    );
  }

  const s = receipt.societies;
  const unallocated = Number(receipt.amount) - receipt.payment_allocations.reduce((sum, a) => sum + Number(a.amount), 0);

  return (
    <div className="min-h-screen bg-slate-950 print:bg-white py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center justify-between print:hidden">
          <button onClick={() => window.history.back()} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white cursor-pointer">
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </button>
          <div className="flex items-center gap-2">
            <a
              href={whatsappLink(receiptText({
                societyName: s?.name ?? 'Society',
                ownerName: receipt.profiles?.full_name,
                flat: receipt.units?.unit_number ?? '',
                receiptNumber: receipt.receipt_number,
                amount: Number(receipt.amount),
                utr: receipt.transaction_reference_utr,
                receiptUrl: window.location.href,
              }))}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold"
            >
              <MessageCircle className="w-3.5 h-3.5" /> WhatsApp
            </a>
            <button onClick={() => window.print()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold cursor-pointer">
              <Printer className="w-3.5 h-3.5" /> Print / Save PDF
            </button>
          </div>
        </div>

        <div className="bg-white text-slate-900 rounded-2xl print:rounded-none p-8 shadow-xl print:shadow-none space-y-6 text-sm">
          <header className="text-center border-b border-slate-200 pb-4 space-y-1">
            <h1 className="text-xl font-bold">{s?.name}</h1>
            {s?.registration_number && <div className="text-xs text-slate-500">Reg. No. {s.registration_number}</div>}
            <div className="text-xs text-slate-500">
              {[s?.address_line1, s?.address_line2, s?.city, `${s?.state} ${s?.pincode}`].filter(Boolean).join(', ')}
            </div>
            <div className="pt-2 text-base font-semibold tracking-widest">PAYMENT RECEIPT</div>
          </header>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
            <dt className="text-slate-500">Receipt No.</dt><dd className="font-mono font-semibold text-right">{receipt.receipt_number}</dd>
            <dt className="text-slate-500">Receipt Date</dt><dd className="text-right">{receipt.verified_at ? new Date(receipt.verified_at).toLocaleDateString('en-IN') : '—'}</dd>
            <dt className="text-slate-500">Received From</dt><dd className="font-semibold text-right">{receipt.profiles?.full_name}</dd>
            <dt className="text-slate-500">Flat</dt><dd className="text-right">{receipt.units?.unit_number}</dd>
            <dt className="text-slate-500">Mode</dt><dd className="text-right">{receipt.payment_method.toUpperCase()} • UTR {receipt.transaction_reference_utr}</dd>
            <dt className="text-slate-500">Payment Date</dt><dd className="text-right">{new Date(receipt.payment_date).toLocaleDateString('en-IN')}</dd>
          </dl>

          <table className="w-full text-xs border-t border-slate-200">
            <thead>
              <tr className="text-slate-500"><th className="text-left py-2">Against Bill</th><th className="text-left py-2">Due Date</th><th className="text-right py-2">Amount</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {receipt.payment_allocations.map((a, i) => (
                <tr key={i}>
                  <td className="py-2 font-mono">{a.bills?.bill_number}</td>
                  <td className="py-2">{a.bills?.due_date}</td>
                  <td className="py-2 text-right">{formatINR(a.amount)}</td>
                </tr>
              ))}
              {unallocated > 0.005 && (
                <tr><td className="py-2" colSpan={2}>Advance (adjusted against future bills)</td><td className="py-2 text-right">{formatINR(unallocated)}</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-300 font-bold"><td className="py-2" colSpan={2}>Total Received</td><td className="py-2 text-right">{formatINR(receipt.amount)}</td></tr>
            </tfoot>
          </table>

          <p className="text-xs italic text-slate-600">{amountInWords(Number(receipt.amount))}</p>

          <footer className="pt-6 flex items-end justify-between text-[11px] text-slate-500">
            <span>Computer-generated receipt. Payment verified against the society&apos;s bank records.</span>
            <span className="text-right">For {s?.name}<br />Treasurer</span>
          </footer>
        </div>
      </div>
    </div>
  );
};
