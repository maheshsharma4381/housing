'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { openSocietyFile } from '../lib/storage';
import { Banner } from './Banner';
import { Paperclip, CheckCircle2 } from 'lucide-react';
import { Card, CardHeader } from './ui/Card';
import { Button } from './ui/Button';
import { promptDialog, toast } from './ui/feedback';

interface Row {
  id: string; expense_number: string; title: string; payee_name: string | null; subtotal: number; gst_amount: number;
  tds_amount: number; net_payable: number; created_by: string | null; invoice_date: string | null; document_url: string | null;
  vendors: { name: string } | { name: string }[] | null;
}
interface Approval { expense_id: string; approver_id: string; decision: string; profiles: { full_name: string } | { full_name: string }[] | null }

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

/**
 * Vendor bills waiting for approval, in Approvals (spec 9.3). Same rules as Vendor bills (decide_expense):
 * the maker cannot approve their own bill unless they are the society's only committee member, and with
 * two-step approval a second member approves after the first.
 */
export const PendingVendorBills: React.FC<{ societyId: string; currentUserId?: string; canDecide: boolean; onDecided?: () => void }> = ({ societyId, currentUserId, canDecide, onDecided }) => {
  const [rows, setRows] = useState<Row[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [sole, setSole] = useState(false);
  const [twoStep, setTwoStep] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [r, a, s, st] = await Promise.all([
      supabase.from('expenses')
        .select('id, expense_number, title, payee_name, subtotal, gst_amount, tds_amount, net_payable, created_by, invoice_date, document_url, vendors:vendor_id (name)')
        .eq('society_id', societyId).eq('status', 'pending_approval').order('created_at'),
      supabase.from('expense_approvals').select('expense_id, approver_id, decision, profiles:approver_id (full_name)').eq('society_id', societyId),
      supabase.rpc('sole_committee_admin', { p_society_id: societyId }),
      supabase.from('society_settings').select('require_two_step_expense_approval').eq('society_id', societyId).maybeSingle(),
    ]);
    setRows((r.data ?? []) as Row[]);
    setApprovals((a.data ?? []) as Approval[]);
    setSole(s.data === true);
    setTwoStep(Boolean(st.data?.require_two_step_expense_approval));
  }, [societyId]);
  useEffect(() => { load(); }, [load]);

  const required = twoStep && !sole ? 2 : 1;

  const reject = async (row: Row) => {
    const reason = await promptDialog({
      title: `Reject ${row.expense_number}?`, body: 'The person who recorded it sees your reason.',
      label: 'Reason', minLength: 3, confirmText: 'Reject bill', tone: 'danger',
    });
    if (reason) void decide(row, false, reason);
  };

  const decide = async (row: Row, approve: boolean, reason?: string) => {
    if (!supabase) return;
    setBusy(row.id);
    setError(null);
    const { data, error: err } = await supabase.rpc('decide_expense', { p_expense_id: row.id, p_approve: approve, p_notes: approve ? null : reason ?? null });
    setBusy(null);
    if (err) return setError(err.message);
    const res = data as { status: string; approvals: number; required: number };
    toast.success(res.status === 'pending_approval'
      ? `${row.expense_number}: your approval is recorded (${res.approvals}/${res.required}) — waiting for a second committee member.`
      : `${row.expense_number} ${res.status}.`);
    await load();
    onDecided?.();
  };

  const openFile = async (path: string) => {
    try {
      await openSocietyFile(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (rows.length === 0 && !error) return null;
  return (
    <Card>
      <CardHeader title="Vendor bills to approve" description={required === 2 ? 'Two committee members approve each bill.' : undefined} />
      {error && <div className="px-4 sm:px-5 pt-4"><Banner tone="error">{error}</Banner></div>}
      <ul className="divide-y divide-border">
        {rows.map(r => {
          const mine = r.created_by === currentUserId;
          const approvedBy = approvals.filter(a => a.expense_id === r.id && a.decision === 'approved');
          const iDecided = approvals.some(a => a.expense_id === r.id && a.approver_id === currentUserId);
          const can = canDecide && (!mine || sole) && !iDecided;
          const vendor = one(r.vendors)?.name ?? r.payee_name ?? 'Vendor';
          return (
            <li key={r.id} className="px-4 sm:px-5 py-4 space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-fg">{vendor}</div>
                  <div className="text-[13px] text-fg-muted">{r.title} · {r.expense_number}</div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-semibold tabular-nums">{formatINR(Number(r.subtotal) + Number(r.gst_amount))}</div>
                  {Number(r.tds_amount) > 0 && <div className="text-[13px] text-fg-muted tabular-nums">− TDS {formatINR(r.tds_amount)} · net {formatINR(r.net_payable)}</div>}
                </div>
              </div>
              <div className="text-[13px] text-fg-muted flex flex-wrap items-center gap-x-4 gap-y-1">
                {r.invoice_date && <span>Invoice {r.invoice_date}</span>}
                {r.document_url && (
                  <button onClick={() => openFile(r.document_url!)} className="flex items-center gap-1 text-brand hover:underline cursor-pointer">
                    <Paperclip className="w-4 h-4" aria-hidden="true" /> Open invoice
                  </button>
                )}
                {approvedBy.length > 0 && (
                  <span className="flex items-center gap-1 text-success">
                    <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                    Approved by {approvedBy.map(a => one(a.profiles)?.full_name ?? 'a member').join(', ')} ({approvedBy.length}/{required})
                  </span>
                )}
              </div>
              {can ? (
                <div className="flex gap-2">
                  <Button variant="secondary" className="flex-1 sm:flex-none text-danger hover:text-danger" onClick={() => reject(r)} disabled={busy === r.id}>Reject</Button>
                  <Button className="flex-1 sm:flex-none" onClick={() => decide(r, true)} loading={busy === r.id}>Approve{mine ? ' (self-approved)' : ''}</Button>
                </div>
              ) : (
                <p className="text-[13px] text-fg-subtle">
                  {iDecided ? 'You have recorded your decision. Waiting for another committee member.'
                    : mine ? 'You recorded this bill. Another committee member approves it.'
                    : 'Waiting for a committee member to approve.'}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
};
