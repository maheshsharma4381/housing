'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { Banner } from './Banner';
import { CreditCard, Receipt, ListChecks, QrCode, Loader2, BellRing } from 'lucide-react';
import type { SocietyTab } from '../lib/society-nav';

interface Cards {
  to_receive: { amount: number; flats: number; overdue_flats: number };
  to_pay: { amount: number; vendors: number; due_this_week: number };
  approvals: { vendor_bills: number; adjustments: number; opening_balance: number; join_requests: number; total: number };
  payments_to_verify: number;
}
interface DueRow { unit_number: string; owner_name: string; outstanding: number; oldest_due_date: string; days_overdue: number }
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
export const HomeCards: React.FC<{ societyId: string; canManage: boolean; onOpen: (tab: SocietyTab) => void }> = ({ societyId, canManage, onOpen }) => {
  const [cards, setCards] = useState<Cards | null>(null);
  const [open, setOpen] = useState<'receive' | 'pay' | null>(null);
  const [dues, setDues] = useState<DueRow[]>([]);
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

  if (!cards) return error ? <Banner tone="error">{error}</Banner> : null;
  const card = 'p-4 rounded-2xl text-left active:scale-95 transition cursor-pointer';
  const a = cards.approvals;

  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <button onClick={openReceive} className={`${card} bg-gradient-to-br from-sky-600 to-sky-700 text-white shadow-lg shadow-sky-600/20`}>
          <CreditCard className="w-5 h-5 mb-2 opacity-90" />
          <div className="font-medium opacity-80">To receive</div>
          <div className="text-lg font-bold">{formatINR(Number(cards.to_receive.amount))}</div>
          <div className="opacity-80">{plural(cards.to_receive.flats, 'flat')} · {cards.to_receive.overdue_flats} overdue</div>
        </button>
        <button onClick={openPay} className={`${card} bg-slate-900 border border-slate-800`}>
          <Receipt className="w-5 h-5 mb-2 text-amber-400" />
          <div className="text-slate-400">To pay</div>
          <div className="text-lg font-bold text-white">{formatINR(Number(cards.to_pay.amount))}</div>
          <div className="text-slate-400">{plural(cards.to_pay.vendors, 'vendor')} · {plural(cards.to_pay.due_this_week, 'bill')} due this week</div>
        </button>
        <button onClick={() => onOpen('approvals')} className={`${card} bg-slate-900 border border-slate-800`}>
          <ListChecks className="w-5 h-5 mb-2 text-violet-400" />
          <div className="text-slate-400">Approvals</div>
          <div className="text-lg font-bold text-white">{a.total}</div>
          <div className="text-slate-400">
            {[a.vendor_bills && `${a.vendor_bills} vendor bills`, a.join_requests && `${a.join_requests} join requests`,
              a.adjustments && `${a.adjustments} CA requests`, a.opening_balance && 'opening balance'].filter(Boolean).join(' · ') || 'Nothing waiting'}
          </div>
        </button>
        <button onClick={() => onOpen('payments')} className={`${card} bg-slate-900 border border-slate-800`}>
          <QrCode className="w-5 h-5 mb-2 text-emerald-400" />
          <div className="text-slate-400">Payments to verify</div>
          <div className="text-lg font-bold text-white">{cards.payments_to_verify}</div>
        </button>
      </div>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      {open === 'receive' && (
        <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-white">Flat-wise dues, oldest first</span>
            {canManage && cards.to_receive.overdue_flats > 0 && (
              <button onClick={remind} disabled={busy} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer disabled:opacity-50">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BellRing className="w-3.5 h-3.5" />}
                Send reminder to {cards.to_receive.overdue_flats} overdue flats
              </button>
            )}
          </div>
          <div className="divide-y divide-slate-800">
            {dues.map(d => (
              <div key={d.unit_number} className="py-2 flex items-center justify-between gap-3">
                <span className="text-white">Flat {d.unit_number} <span className="text-slate-400">· {d.owner_name}</span></span>
                <span className="text-right">
                  <strong className="text-white">{formatINR(Number(d.outstanding))}</strong>
                  <span className={`block ${d.days_overdue > 0 ? 'text-rose-300' : 'text-slate-500'}`}>{d.days_overdue > 0 ? `${d.days_overdue} days overdue` : `due ${fmt(d.oldest_due_date)}`}</span>
                </span>
              </div>
            ))}
            {listLoading && <Loader2 className="w-4 h-4 animate-spin text-sky-400 my-2" />}
            {!listLoading && dues.length === 0 && <p className="py-2 text-slate-500">Nothing is due.</p>}
          </div>
        </div>
      )}

      {open === 'pay' && (
        <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-white">Vendor-wise, soonest due first</span>
            {canManage && <button onClick={() => onOpen('expenses')} className="px-3 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer">Record a payment</button>}
          </div>
          <div className="divide-y divide-slate-800">
            {vendors.map(v => (
              <div key={v.who} className="py-2 flex items-center justify-between gap-3">
                <span className="text-white">{v.who} <span className="text-slate-400">· {v.bills} bill{v.bills === 1 ? '' : 's'} · due {fmt(v.due)}</span></span>
                <span className="text-right">
                  <strong className="text-white">{formatINR(v.cash)}</strong>
                  {v.tds > 0 && <span className="block text-slate-400">TDS to deduct {formatINR(v.tds)}</span>}
                </span>
              </div>
            ))}
            {listLoading && <Loader2 className="w-4 h-4 animate-spin text-sky-400 my-2" />}
            {!listLoading && vendors.length === 0 && <p className="py-2 text-slate-500">Nothing to pay.</p>}
          </div>
        </div>
      )}
    </div>
  );
};
