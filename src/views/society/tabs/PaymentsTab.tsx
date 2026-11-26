'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase/client';
import { formatINR } from '../../../lib/inr';
import { contactLine } from '../../../lib/mobile';
import { Link } from '../../../router/RouterContext';
import { EmptyState } from '../../../components/EmptyState';
import { Payment, Unit } from '../../../types/database';
import { receiptText, whatsappLink } from '../../../lib/messages';
import { describeNotify, notify } from '../../../lib/notify';
import { type BankLedger, defaultBankId, fetchBankLedgers } from '../../../lib/banks';
import { QrCode, CheckCircle2, XCircle, Receipt, MessageCircle } from 'lucide-react';
import { Banner } from '../../../components/Banner';
import { PageHeader } from '../../../components/ui/PageHeader';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge, StatusBadge } from '../../../components/ui/Badge';
import { fieldClass } from '../../../components/ui/Field';
import { cn } from '../../../components/ui/cn';
import { promptDialog, toast } from '../../../components/ui/feedback';

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
  const [error, setError] = useState<string | null>(null);
  const [inBank, setInBank] = useState<Map<string, string>>(new Map());
  const [banks, setBanks] = useState<BankLedger[]>([]);
  const [bankFor, setBankFor] = useState<Record<string, string>>({});

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
    setBanks(await fetchBankLedgers(supabase, societyId).catch(() => []));
  }, [societyId]);

  // Only when the society has more than one bank, and the bank statement has not already decided
  const asksBank = (p: PaymentRow) => banks.length > 1 && p.payment_method !== 'cash' && !inBank.has(p.id);

  useEffect(() => {
    load();
  }, [load]);

  const reject = async (p: PaymentRow) => {
    const reason = await promptDialog({
      title: `Reject ${formatINR(p.amount)} from flat ${unitNumber(p.unit_id)}?`,
      body: 'The resident sees this reason and can submit the right UTR.',
      label: 'Reason', placeholder: 'UTR not found in the bank statement', minLength: 3,
      confirmText: 'Reject payment', tone: 'danger',
    });
    if (reason) void decide(p, false, reason);
  };

  const decide = async (p: PaymentRow, approve: boolean, rejectReason = '') => {
    if (!supabase) return;
    setBusyId(p.id);
    setError(null);
    if (approve && asksBank(p)) {
      const { error: bankErr } = await supabase.rpc('set_payment_bank', {
        p_payment_id: p.id, p_bank_ledger_id: bankFor[p.id] ?? defaultBankId(banks, 'receipt'),
      });
      // A payment matched on a bank statement goes to that bank; anything else stops here
      if (bankErr && !bankErr.message.includes('matched to a bank statement line')) {
        setBusyId(null);
        setError(bankErr.message);
        return;
      }
    }
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
    toast.success(
      approve
        ? `Verified ${formatINR(p.amount)} from flat ${unitNumber(p.unit_id)}. Receipt ${r.receipt_number}.` +
            (Number(r.unallocated) > 0 ? ` ${formatINR(r.unallocated)} exceeds the dues and will be adjusted against the next bill.` : '') +
            (emailed ? describeNotify(emailed, 'resident') : '')
        : `Rejected payment UTR ${p.transaction_reference_utr}.`
    );
    load();
    onChanged();
  };

  const pending = payments.filter(p => p.status === 'pending_verification');
  const history = payments.filter(p => p.status !== 'pending_verification');
  const who = (p: PaymentRow) => [p.profiles?.full_name, contactLine(p.profiles)].filter(Boolean).join(' · ');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments received"
        description="Match each UTR with your bank statement or UPI app, then verify. A verified payment settles the flat's oldest dues first and issues a receipt."
      />

      <Banner tone="error">{error}</Banner>

      {/* To verify first (brief J3) */}
      <Card>
        <CardHeader title="To verify" actions={<Badge tone={pending.length > 0 ? 'warning' : 'neutral'}>{pending.length}</Badge>} />
        {pending.length === 0 && !loading ? (
          <EmptyState bare icon={QrCode} title="Nothing to verify" description="When residents submit a UPI reference (UTR), it shows up here." />
        ) : (
          <ul className="divide-y divide-border">
            {pending.map(p => (
              <li key={p.id} className="px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-lg font-semibold tabular-nums">{formatINR(p.amount)}</span>
                    <span className="font-semibold text-fg">· {unitNumber(p.unit_id)}</span>
                  </div>
                  {who(p) && <div className="text-[13px] text-fg-muted truncate">{who(p)}</div>}
                  <div className="text-[13px] text-fg-muted">
                    UTR <span className="font-mono text-fg tracking-wide">{p.transaction_reference_utr}</span> · {p.payment_method.toUpperCase()} · {fmtDate(p.payment_date)}
                  </div>
                  {inBank.has(p.id) && (
                    <div className="text-[13px] text-success flex items-center gap-1">
                      <CheckCircle2 className="w-4 h-4" aria-hidden="true" /> In the bank statement ({fmtDate(inBank.get(p.id) ?? '')})
                    </div>
                  )}
                  {asksBank(p) && (
                    <label className="flex items-center gap-2 pt-1 text-[13px] text-fg-muted">
                      Received in
                      <select
                        value={bankFor[p.id] ?? defaultBankId(banks, 'receipt') ?? ''}
                        onChange={e => setBankFor(b => ({ ...b, [p.id]: e.target.value }))}
                        className={cn(fieldClass, 'h-9 w-auto')}
                      >
                        {banks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </label>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button variant="secondary" className="flex-1 sm:flex-none text-danger hover:text-danger" onClick={() => reject(p)} disabled={busyId !== null} leftIcon={<XCircle className="w-4 h-4" />}>
                    Reject
                  </Button>
                  <Button className="flex-1 sm:flex-none" onClick={() => decide(p, true)} loading={busyId === p.id} disabled={busyId !== null} leftIcon={<CheckCircle2 className="w-4 h-4" />}>
                    Verify
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {history.length > 0 && (
        <Card>
          <CardHeader title="History" description="Latest 200 payments" />
          <ul className="divide-y divide-border">
            {history.map(p => (
              <li key={p.id} className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-fg">
                    <span className="tabular-nums">{formatINR(p.amount)}</span> · {unitNumber(p.unit_id)}
                    {p.profiles?.full_name && <span className="text-fg-muted font-normal"> · {p.profiles.full_name}</span>}
                  </div>
                  <div className="text-[13px] text-fg-muted truncate">
                    UTR {p.transaction_reference_utr} · {fmtDate(p.payment_date)}
                    {p.status === 'rejected' && p.verification_notes && <> · <span className="text-danger">{p.verification_notes}</span></>}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <StatusBadge status={p.status} />
                  {p.status === 'verified' && (
                    <>
                      <Link href={`/receipt/${p.id}`} className="hidden sm:flex items-center gap-1 text-[13px] text-brand hover:underline">
                        <Receipt className="w-4 h-4" aria-hidden="true" /> {p.receipt_number}
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
                        aria-label={`Send receipt ${p.receipt_number} on WhatsApp`}
                        title="Send receipt on WhatsApp"
                        className="w-9 h-9 rounded-lg flex items-center justify-center text-success hover:bg-success-soft"
                      >
                        <MessageCircle className="w-4 h-4" />
                      </a>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
};

const fmtDate = (iso: string) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
