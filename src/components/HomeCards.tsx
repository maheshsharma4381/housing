'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { Banner } from './Banner';
import { CreditCard, Receipt, ListChecks, QrCode, Loader2, BellRing, CheckCircle2, Megaphone } from 'lucide-react';
import { StatCard } from './ui/StatCard';
import { Card, CardHeader } from './ui/Card';
import { Button } from './ui/Button';
import type { SocietyTab } from '../lib/society-nav';
import { flatKey, flatLabels } from '../lib/flat-label';

interface Cards {
  to_receive: { amount: number; flats: number; overdue_flats: number };
  to_pay: { amount: number; vendors: number; due_this_week: number };
  approvals: { vendor_bills: number; adjustments: number; opening_balance: number; join_requests: number; total: number };
  payments_to_verify: number;
}
interface DueRow { unit_number: string; wing: string | null; owner_name: string; outstanding: number; oldest_due_date: string; days_overdue: number }
interface VendorRow { who: string; bills: number; cash: number; tds: number; due: string }
interface ExpenseRow {
  payee_name: string | null; title: string; subtotal: number; gst_amount: number; tds_amount: number; tds_deducted: number;
  amount_settled: number; invoice_date: string | null; created_at: string; vendors: { name: string } | { name: string }[] | null;
}

// date maths in UTC: a local midnight read back with toISOString lands a day early in India
const plusDays = (iso: string, days: number) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmt = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

/** Spec 9.4: To receive, To pay, Approvals, Payments to verify — each opens a list you can act on. */
export const HomeCards: React.FC<{ societyId: string; canManage: boolean; onOpen: (tab: SocietyTab) => void; aside?: React.ReactNode }> = ({ societyId, canManage, onOpen, aside }) => {
  const [cards, setCards] = useState<Cards | null>(null);
  const [open, setOpen] = useState<'receive' | 'pay' | null>(null);
  const [dues, setDues] = useState<DueRow[]>([]);
  // "101" in two wings reads "A-101" and "B-101"
  const duesLabels = useMemo(() => flatLabels(dues), [dues]);
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data, error: err } = await supabase.rpc('home_cards', { p_society_id: societyId });
    if (err) setError(err.message);
    else setCards(data as Cards);
  }, [societyId]);
  useEffect(() => { load(); }, [load]);

  const openReceive = async () => {
    if (open === 'receive') return setOpen(null);
    setOpen('receive');
    if (!supabase) return;
    setListLoading(true);
    const { data, error: err } = await supabase.rpc('member_dues', { p_society_id: societyId });
    setListLoading(false);
    if (err) return setError(err.message);
    setDues(((data ?? []) as DueRow[]).sort((a, b) => a.oldest_due_date.localeCompare(b.oldest_due_date)));
  };

  const openPay = async () => {
    if (open === 'pay') return setOpen(null);
    setOpen('pay');
    if (!supabase) return;
    setListLoading(true);
    const { data, error: err } = await supabase.from('expenses')
      .select('payee_name, title, subtotal, gst_amount, tds_amount, tds_deducted, amount_settled, invoice_date, created_at, vendors:vendor_id (name)')
      .eq('society_id', societyId).eq('status', 'approved');
    setListLoading(false);
    if (err) return setError(err.message);
    const byVendor = new Map<string, VendorRow>();
    for (const e of (data ?? []) as ExpenseRow[]) {
      const tds = Math.max(Number(e.tds_amount) - Number(e.tds_deducted), 0);
      const cash = Number(e.subtotal) + Number(e.gst_amount) - Number(e.amount_settled) - tds;
      if (cash <= 0.005) continue;
      const vendor = Array.isArray(e.vendors) ? e.vendors[0]?.name : e.vendors?.name;
      const who = vendor ?? e.payee_name ?? e.title;
      // invoice_due_by is the deadline to attach a missing invoice, not a payment due date (same rule as home_cards)
      const due = plusDays(e.invoice_date ?? e.created_at, 30);
      const row = byVendor.get(who) ?? { who, bills: 0, cash: 0, tds: 0, due };
      row.bills += 1;
      row.cash += cash;
      row.tds += tds;
      if (due < row.due) row.due = due;
      byVendor.set(who, row);
    }
    setVendors([...byVendor.values()].sort((a, b) => a.due.localeCompare(b.due)));
  };

  const remind = async () => {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase.rpc('remind_overdue_flats', { p_society_id: societyId });
    setBusy(false);
    if (err) return setError(err.message);
    const r = data as { reminded: number; payment_waiting: number; not_joined: number; already_today?: number };
    setNotice([
      `Reminded ${plural(r.reminded, 'flat')}.`,
      r.already_today ? `${plural(r.already_today, 'flat')} already reminded today.` : '',
      r.payment_waiting ? `${plural(r.payment_waiting, 'flat')} with a payment waiting for you to verify.` : '',
      r.not_joined ? `${plural(r.not_joined, 'flat')} with nobody joined yet — share your joining link.` : '',
    ].filter(Boolean).join(' '));
  };

  if (!cards) return error ? <Banner tone="error">{error}</Banner> : <HomeCardsSkeleton />;
  const a = cards.approvals;
  const approvalsLine = [a.vendor_bills && `${a.vendor_bills} vendor bills`, a.join_requests && `${a.join_requests} join requests`,
    a.adjustments && `${a.adjustments} CA requests`, a.opening_balance && 'opening balance'].filter(Boolean).join(' · ');

  // what needs the committee, most urgent first (brief section 13: attention before information)
  const attention: { key: string; tone: 'warning' | 'info' | 'danger' | 'neutral'; Icon: React.ComponentType<{ className?: string }>; title: string; sub: string; action: string; run: () => void }[] = [];
  if (cards.payments_to_verify > 0) attention.push({ key: 'verify', tone: 'warning', Icon: QrCode, title: `${plural(cards.payments_to_verify, 'payment')} to verify`,
    sub: 'Match the UTR with the bank, then verify', action: 'Verify', run: () => onOpen('payments') });
  if (a.total > 0) attention.push({ key: 'approvals', tone: 'info', Icon: ListChecks, title: `${a.total} waiting for approval`, sub: approvalsLine, action: 'Review', run: () => onOpen('approvals') });
  if (cards.to_receive.overdue_flats > 0) attention.push({ key: 'overdue', tone: 'danger', Icon: CreditCard, title: `${plural(cards.to_receive.overdue_flats, 'flat')} overdue`,
    sub: `${formatINR(Number(cards.to_receive.amount))} still to receive`, action: 'See who', run: openReceive });
  if (cards.to_pay.due_this_week > 0) attention.push({ key: 'pay', tone: 'neutral', Icon: Receipt, title: `${plural(cards.to_pay.due_this_week, 'vendor bill')} due this week`,
    sub: `${formatINR(Number(cards.to_pay.amount))} to pay in all`, action: 'See', run: openPay });

  const toneCls = { warning: 'bg-warning-soft text-warning', info: 'bg-info-soft text-info', danger: 'bg-danger-soft text-danger', neutral: 'bg-surface-muted text-fg-muted' };
  const quick: { label: string; Icon: React.ComponentType<{ className?: string }>; tab: SocietyTab }[] = [
    { label: 'Issue bills', Icon: CreditCard, tab: 'billing' },
    { label: 'Verify payments', Icon: QrCode, tab: 'payments' },
    { label: 'Add vendor bill', Icon: Receipt, tab: 'expenses' },
    { label: 'Post notice', Icon: Megaphone, tab: 'notices' },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <StatCard label="To receive" value={formatINR(Number(cards.to_receive.amount))} onClick={openReceive}
          sub={`${plural(cards.to_receive.flats, 'flat')} · ${cards.to_receive.overdue_flats} overdue`} tone={cards.to_receive.overdue_flats > 0 ? 'warning' : 'default'} />
        <StatCard label="To pay" value={formatINR(Number(cards.to_pay.amount))} onClick={openPay}
          sub={`${plural(cards.to_pay.vendors, 'vendor')} · ${plural(cards.to_pay.due_this_week, 'bill')} due this week`} />
        <StatCard label="Approvals" value={a.total} onClick={() => onOpen('approvals')} sub={approvalsLine || 'Nothing waiting'} />
        <StatCard label="Payments to verify" value={cards.payments_to_verify} onClick={() => onOpen('payments')}
          sub={cards.payments_to_verify > 0 ? 'UTRs sent by residents' : 'Nothing to verify'} />
      </div>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      <div className="grid gap-4 lg:grid-cols-3 items-start">
        <Card className="lg:col-span-2">
          <CardHeader title="Needs your attention" actions={attention.length > 0 ? <span className="text-[13px] text-fg-subtle">{plural(attention.length, 'item')}</span> : undefined} />
          {attention.length === 0 ? (
            <div className="px-5 py-8 flex items-center gap-3">
              <span className="w-10 h-10 shrink-0 rounded-full bg-success-soft text-success flex items-center justify-center"><CheckCircle2 className="w-5 h-5" aria-hidden="true" /></span>
              <div>
                <div className="font-semibold text-fg">You are all caught up</div>
                <div className="text-[13px] text-fg-muted">Nothing needs you right now. New payments and requests show up here.</div>
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {attention.map(t => (
                <li key={t.key} className="flex items-center gap-3 sm:gap-4 px-4 sm:px-5 py-4">
                  <span className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center ${toneCls[t.tone]}`}><t.Icon className="w-5 h-5" aria-hidden="true" /></span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-semibold text-fg">{t.title}</span>
                    {t.sub && <span className="block text-[13px] text-fg-muted truncate">{t.sub}</span>}
                  </span>
                  <Button variant="secondary" size="sm" onClick={t.run}>{t.action}</Button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-4">
          {aside}
          {canManage && (
            <Card className="p-5 space-y-3">
              <h2 className="text-base font-semibold text-fg">Quick actions</h2>
              <div className="grid grid-cols-2 gap-2">
                {quick.map(q => (
                  <button key={q.tab} type="button" onClick={() => onOpen(q.tab)}
                    className="flex flex-col items-start gap-2 p-3 min-h-11 rounded-lg border border-border text-left text-[13px] font-medium text-fg hover:border-border-strong hover:bg-surface-muted transition duration-150 cursor-pointer">
                    <q.Icon className="w-5 h-5 text-brand" aria-hidden="true" />
                    {q.label}
                  </button>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>

      {open === 'receive' && (
        <Card>
          <CardHeader title="Flat-wise dues" description="Oldest first"
            actions={canManage && cards.to_receive.overdue_flats > 0 ? (
              <Button size="sm" onClick={remind} loading={busy} leftIcon={<BellRing className="w-4 h-4" />}>
                Send reminder to {plural(cards.to_receive.overdue_flats, 'overdue flat')}
              </Button>
            ) : undefined} />
          <ul className="divide-y divide-border">
            {dues.map((d, i) => (
              <li key={flatKey(d)} className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3">
                <span className="min-w-0"><span className="font-semibold text-fg">{duesLabels[i]}</span> <span className="text-fg-muted">· {d.owner_name}</span></span>
                <span className="text-right tabular-nums">
                  <strong className="text-fg font-semibold">{formatINR(Number(d.outstanding))}</strong>
                  <span className={`block text-[13px] ${d.days_overdue > 0 ? 'text-danger' : 'text-fg-subtle'}`}>{d.days_overdue > 0 ? `${d.days_overdue} days overdue` : `due ${fmt(d.oldest_due_date)}`}</span>
                </span>
              </li>
            ))}
            {listLoading && <li className="px-5 py-3"><Loader2 className="w-4 h-4 animate-spin text-brand" aria-label="Loading" /></li>}
            {!listLoading && dues.length === 0 && <li className="px-5 py-4 text-fg-muted">Nothing is due.</li>}
          </ul>
        </Card>
      )}

      {open === 'pay' && (
        <Card>
          <CardHeader title="To pay, vendor-wise" description="Soonest due first"
            actions={canManage ? <Button size="sm" variant="secondary" onClick={() => onOpen('expenses')}>Record a payment</Button> : undefined} />
          <ul className="divide-y divide-border">
            {vendors.map(v => (
              <li key={v.who} className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3">
                <span className="min-w-0"><span className="font-semibold text-fg">{v.who}</span> <span className="text-fg-muted">· {v.bills} bill{v.bills === 1 ? '' : 's'} · due {fmt(v.due)}</span></span>
                <span className="text-right tabular-nums">
                  <strong className="text-fg font-semibold">{formatINR(v.cash)}</strong>
                  {v.tds > 0 && <span className="block text-[13px] text-fg-subtle">TDS to deduct {formatINR(v.tds)}</span>}
                </span>
              </li>
            ))}
            {listLoading && <li className="px-5 py-3"><Loader2 className="w-4 h-4 animate-spin text-brand" aria-label="Loading" /></li>}
            {!listLoading && vendors.length === 0 && <li className="px-5 py-4 text-fg-muted">Nothing to pay.</li>}
          </ul>
        </Card>
      )}
    </div>
  );
};

/** Grey blocks where the cards will be, while they load. */
const HomeCardsSkeleton: React.FC = () => (
  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4" aria-hidden="true">
    {[0, 1, 2, 3].map(i => (
      <div key={i} className="h-[116px] rounded-xl bg-surface border border-border p-5 space-y-3">
        <div className="h-3 w-20 rounded bg-surface-muted animate-pulse" />
        <div className="h-6 w-28 rounded bg-surface-muted animate-pulse" />
        <div className="h-3 w-24 rounded bg-surface-muted animate-pulse" />
      </div>
    ))}
  </div>
);
