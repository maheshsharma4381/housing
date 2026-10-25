'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase/client';
import { formatINR } from '../../../lib/inr';
import { Link } from '../../../router/RouterContext';
import { EmptyState } from '../../../components/EmptyState';
import { Payment, Unit } from '../../../types/database';
import { receiptText, whatsappLink } from '../../../lib/messages';
import { describeNotify, notify } from '../../../lib/notify';
import { QrCode, CheckCircle2, XCircle, AlertCircle, Loader2, Receipt, MessageCircle } from 'lucide-react';

type PaymentRow = Payment & { profiles: { full_name: string; email: string; phone?: string | null } | null };

interface PaymentsTabProps {
  societyId: string;
  societyName?: string;
  units: Unit[];
  onChanged: () => void;
}

export const PaymentsTab: React.FC<PaymentsTabProps> = ({ societyId, societyName, units, onChanged }) => {
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inBank, setInBank] = useState<Map<string, string>>(new Map());

  const unitNumber = (id: string) => units.find(u => u.id === id)?.unit_number ?? '—';

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const { data, error: loadErr } = await supabase
      .from('payments')
      .select('*, profiles:user_id (full_name, email, phone)')
      .eq('society_id', societyId)
      .order('created_at', { ascending: false })
      .limit(200);
    if (loadErr) setError(loadErr.message);
    setPayments(((data ?? []) as unknown) as PaymentRow[]);
    setLoading(false);
    // Lines matched in Bank statement match (Pro); empty on other plans
    const { data: lines } = await supabase.from('bank_transactions').select('reconciled_payment_id, transaction_date')
      .eq('society_id', societyId).not('reconciled_payment_id', 'is', null).limit(1000);
    setInBank(new Map((lines ?? []).map(l => [l.reconciled_payment_id as string, l.transaction_date as string])));
  }, [societyId]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (p: PaymentRow, approve: boolean) => {
    if (!supabase) return;
    if (!approve && !rejectReason.trim()) {
      setError('Enter a reason so the resident knows why the payment was rejected.');
      return;
    }
    setBusyId(p.id);
    setError(null);
    const { data, error: rpcErr } = await supabase.rpc('verify_payment', {
      p_payment_id: p.id,
      p_approve: approve,
      p_notes: approve ? null : rejectReason.trim(),
    });
    setBusyId(null);
    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }
    const r = data as { status: string; receipt_number?: string; allocated?: number; unallocated?: number };
    const emailed = approve ? await notify('receipt', p.id) : null;
    setNotice(
      approve
        ? `Verified ${formatINR(p.amount)} from flat ${unitNumber(p.unit_id)}. Receipt ${r.receipt_number}.` +
            (Number(r.unallocated) > 0 ? ` ${formatINR(r.unallocated)} exceeds the dues and will be adjusted against the next bill.` : '') +
            (emailed ? describeNotify(emailed, 'resident') : '')
        : `Rejected payment UTR ${p.transaction_reference_utr}.`
    );
    setRejectingId(null);
    setRejectReason('');
    load();
    onChanged();
  };

  const pending = payments.filter(p => p.status === 'pending_verification');
  const history = payments.filter(p => p.status !== 'pending_verification');

  return (
    <div className="space-y-6 text-xs">
      <div>
        <h2 className="text-lg font-bold text-white">Payment Verifications</h2>
        <p className="text-slate-400">
          Match each UTR with your bank statement or UPI app, then verify. Verified payments settle the flat&apos;s oldest dues first and issue a receipt.
        </p>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> <span>{notice}</span>
        </div>
      )}

      <section className="space-y-2">
        <h3 className="font-semibold text-slate-400 uppercase tracking-wider text-[11px]">Awaiting Verification ({pending.length})</h3>
        {pending.length === 0 && !loading ? (
          <EmptyState icon={QrCode} title="Nothing to Verify" description="When residents submit a UPI reference (UTR), it shows up here." />
        ) : (
          pending.map(p => (
            <div key={p.id} className="p-4 rounded-2xl bg-slate-900 border border-amber-500/30 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-bold text-white text-sm">{formatINR(p.amount)} • Flat {unitNumber(p.unit_id)}</div>
                  <div className="text-slate-400 truncate">{p.profiles?.full_name} ({p.profiles?.email})</div>
                  <div className="text-slate-400">
                    UTR <span className="font-mono text-white">{p.transaction_reference_utr}</span> • {p.payment_method.toUpperCase()} • {p.payment_date}
                  </div>
                  {inBank.has(p.id) && (
                    <div className="text-emerald-300 flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" /> In bank statement ({inBank.get(p.id)})
                    </div>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => decide(p, true)}
                    disabled={busyId !== null}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold cursor-pointer disabled:opacity-50"
                  >
                    {busyId === p.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                    Verify
                  </button>
                  <button
                    onClick={() => { setRejectingId(rejectingId === p.id ? null : p.id); setRejectReason(''); }}
                    disabled={busyId !== null}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-rose-300 font-semibold cursor-pointer disabled:opacity-50"
                  >
                    <XCircle className="w-3.5 h-3.5" /> Reject
                  </button>
                </div>
              </div>
              {rejectingId === p.id && (
                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={rejectReason}
                    onChange={e => setRejectReason(e.target.value)}
                    placeholder="Reason, e.g. UTR not found in bank statement"
                    className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-rose-500"
                  />
                  <button onClick={() => decide(p, false)} disabled={busyId !== null} className="px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold cursor-pointer disabled:opacity-50">
                    Confirm Reject
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </section>

      {history.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-semibold text-slate-400 uppercase tracking-wider text-[11px]">History</h3>
          <div className="rounded-2xl bg-slate-900 border border-slate-800 divide-y divide-slate-800">
            {history.map(p => (
              <div key={p.id} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-white">{formatINR(p.amount)} • Flat {unitNumber(p.unit_id)} <span className="text-slate-500 font-normal">• {p.profiles?.full_name}</span></div>
                  <div className="text-slate-400 truncate">
                    UTR {p.transaction_reference_utr} • {p.payment_date}
                    {p.status === 'rejected' && p.verification_notes && <> • <span className="text-rose-300">{p.verification_notes}</span></>}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold ${p.status === 'verified' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}>
                    {p.status}
                  </span>
                  {p.status === 'verified' && (
                    <>
                      <Link href={`/receipt/${p.id}`} className="flex items-center gap-1 text-sky-400 hover:underline">
                        <Receipt className="w-3.5 h-3.5" /> {p.receipt_number}
                      </Link>
                      <a
                        href={whatsappLink(receiptText({
                          societyName: societyName ?? 'Society',
                          ownerName: p.profiles?.full_name,
                          flat: unitNumber(p.unit_id),
                          receiptNumber: p.receipt_number ?? '',
                          amount: Number(p.amount),
                          utr: p.transaction_reference_utr,
                          receiptUrl: `${typeof window !== 'undefined' ? window.location.origin : ''}/receipt/${p.id}`,
                        }), p.profiles?.phone)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Send receipt on WhatsApp"
                        className="text-emerald-400 hover:text-emerald-300"
                      >
                        <MessageCircle className="w-4 h-4" />
                      </a>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
