'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase/client';
import { amountInWords, formatINR } from '../../lib/inr';
import { useRouter } from '../../router/RouterContext';
import { receiptText, whatsappLink } from '../../lib/messages';
import { Printer, MessageCircle } from 'lucide-react';
import { Button, buttonClass } from '../../components/ui/Button';
import { DocumentPage, DocumentState, Paper, Letterhead, DocFacts } from '../../components/ui/DocumentPaper';

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

  if (error) return <DocumentState error={error} onBack={() => navigate('/')} />;
  if (!receipt) return <DocumentState loading="Loading receipt…" />;
  if (receipt.status !== 'verified' || !receipt.receipt_number) {
    return (
      <DocumentState onBack={() => window.history.back()}>
        <p className="text-fg">This payment is {receipt.status === 'pending_verification' ? 'being checked' : receipt.status.replace('_', ' ')}.</p>
        <p>A receipt is issued once the treasurer verifies it.</p>
      </DocumentState>
    );
  }

  const s = receipt.societies;
  const unallocated = Number(receipt.amount) - receipt.payment_allocations.reduce((sum, a) => sum + Number(a.amount), 0);

  return (
    <DocumentPage actions={
      <>
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
          className={buttonClass('secondary', 'sm')}
        >
          <MessageCircle className="w-4 h-4 text-success" /> WhatsApp
        </a>
        <Button size="sm" onClick={() => window.print()} leftIcon={<Printer className="w-4 h-4" />}>Print / Save PDF</Button>
      </>
    }>
      <Paper>
        <Letterhead society={s?.name ?? ''} registration={s?.registration_number}
          address={[s?.address_line1, s?.address_line2, s?.city, `${s?.state ?? ''} ${s?.pincode ?? ''}`.trim()].filter(Boolean).join(', ')}
          title="PAYMENT RECEIPT" number={receipt.receipt_number} date={receipt.verified_at ? new Date(receipt.verified_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : undefined} />

        <DocFacts rows={[
          ['Received from', receipt.profiles?.full_name ?? '—'],
          ['Flat', receipt.units?.unit_number ?? '—'],
          ['Mode', `${receipt.payment_method.toUpperCase()} · UTR ${receipt.transaction_reference_utr}`],
          ['Payment date', fmtDate(receipt.payment_date)],
        ]} />

        <table className="w-full">
          <thead>
            <tr className="bg-slate-100 text-slate-600 text-xs">
              <th className="text-left font-semibold py-2 px-3">Against bill</th>
              <th className="text-left font-semibold py-2 px-3">Due date</th>
              <th className="text-right font-semibold py-2 px-3 w-40">Amount (₹)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {receipt.payment_allocations.map((a, i) => (
              <tr key={i}>
                <td className="py-2.5 px-3 font-mono">{a.bills?.bill_number}</td>
                <td className="py-2.5 px-3">{a.bills?.due_date ? fmtDate(a.bills.due_date) : ''}</td>
                <td className="py-2.5 px-3 text-right">{formatINR(a.amount)}</td>
              </tr>
            ))}
            {unallocated > 0.005 && (
              <tr><td className="py-2.5 px-3" colSpan={2}>Advance (adjusted against future bills)</td><td className="py-2.5 px-3 text-right">{formatINR(unallocated)}</td></tr>
            )}
          </tbody>
        </table>

        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <p className="text-xs italic text-slate-600 max-w-sm">{amountInWords(Number(receipt.amount))}</p>
          <div className="sm:min-w-64 rounded-lg border-2 border-slate-900 px-4 py-3 text-right">
            <div className="text-xs text-slate-600">Total received</div>
            <div className="text-2xl font-semibold text-slate-900">{formatINR(receipt.amount)}</div>
          </div>
        </div>

        <footer className="pt-8 flex items-end justify-between gap-6 text-xs text-slate-500">
          <span className="max-w-xs">Computer-generated receipt. Payment verified against the society&apos;s bank records.</span>
          <span className="text-right text-slate-700">For {s?.name}<br /><span className="inline-block mt-6 pt-1 border-t border-slate-300">Treasurer</span></span>
        </footer>
      </Paper>
    </DocumentPage>
  );
};

const fmtDate = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
