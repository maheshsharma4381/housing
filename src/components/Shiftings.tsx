'use client';
// Phase 11C: the committee's shifting list — upcoming and recent moves, deposits held, refunds.
import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Truck } from 'lucide-react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import { EmptyState } from './EmptyState';
import { Link } from '../router/RouterContext';
import { DIRECTION_LABELS, DEPOSIT_LABELS, refundSplit } from '../lib/shifting';
import { formatINR } from '../lib/inr';
import { fetchBankLedgers, defaultBankId } from '../lib/banks';

interface Row {
  id: string; unit_id: string; direction: string; shift_date: string; shift_time: string; vehicle: string | null;
  charge_amount: number; deposit_amount: number; bill_id: string | null; deposit_status: string;
  kept_amount: number | null; kept_reason: string | null; refunded_on: string | null;
}

export const Shiftings: React.FC<{ societyId: string; labels: Record<string, string>; canManage: boolean }> = ({ societyId, labels, canManage }) => {
  const [rows, setRows] = useState<Row[]>([]);
  const [paid, setPaid] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [refunding, setRefunding] = useState<{ id: string; kept: string; reason: string; paidOn: string; ledger: string; reference: string } | null>(null);
  const [payFrom, setPayFrom] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data } = await supabase.from('shiftings').select('*').eq('society_id', societyId).order('shift_date', { ascending: false }).limit(200);
    const list = (data as Row[]) ?? [];
    setRows(list);
    const billIds = list.map(r => r.bill_id).filter(Boolean) as string[];
    if (billIds.length) {
      const { data: b } = await supabase.from('bills').select('id, status').in('id', billIds);
      setPaid(Object.fromEntries(((b ?? []) as { id: string; status: string }[]).map(x => [x.id, x.status === 'paid'])));
    }
    setLoading(false);
  }, [societyId]);
  useEffect(() => { void load(); }, [load]);
  // where a refund is paid from: the society's bank ledgers, or cash
  useEffect(() => {
    if (!supabase || !canManage) return;
    const client = supabase;
    void (async () => {
      const banks = await fetchBankLedgers(client, societyId).catch(() => []);
      const { data: cash } = await client.from('accounts').select('id, name').eq('society_id', societyId).eq('code', '1100').maybeSingle();
      const first = defaultBankId(banks, 'payment');
      const list = [...banks.map(b => ({ id: b.id, name: b.name })), ...(cash ? [{ id: (cash as { id: string }).id, name: 'Cash' }] : [])];
      setPayFrom(first ? [...list.filter(x => x.id === first), ...list.filter(x => x.id !== first)] : list);
    })();
  }, [societyId, canManage]);

  const refund = async () => {
    if (!supabase || !refunding) return;
    const row = rows.find(r => r.id === refunding.id);
    const split = refundSplit(Number(row?.deposit_amount ?? 0), Number(refunding.kept || 0));
    if (split.error) return setError(split.error);
    setBusy(true); setError(null);
    const { error: err } = await supabase.rpc('refund_shifting_deposit', {
      p_shifting_id: refunding.id, p_kept: split.kept, p_reason: refunding.reason,
      p_paid_on: refunding.paidOn, p_ledger_id: refunding.ledger || null, p_reference: refunding.reference,
    });
    setBusy(false);
    if (err) return setError(err.message);
    const from = payFrom.find(p => p.id === refunding.ledger)?.name ?? 'the bank';
    setDone(`Refund of ${formatINR(split.refund)} recorded as paid on ${refunding.paidOn} from ${from}${split.kept > 0 ? `; ${formatINR(split.kept)} kept` : ''}.`);
    setRefunding(null);
    void load();
  };

  if (loading) return <Loader2 className="w-4 h-4 animate-spin text-fg-subtle" />;
  if (rows.length === 0) return <EmptyState icon={Truck} title="No shifting yet" description="Approved move-ins and move-outs appear here." />;
  return (
    <div className="space-y-2 text-xs">
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{done}</Banner>
      {rows.map(r => (
        <div key={r.id} className="p-3 rounded-xl bg-surface border border-border space-y-1">
          <div className="flex flex-wrap justify-between gap-2">
            <span className="text-fg font-semibold">Flat {labels[r.unit_id] ?? ''} · {DIRECTION_LABELS[r.direction]} · {r.shift_date} {r.shift_time.slice(0, 5)}</span>
            <span className={r.deposit_status === 'held' ? 'text-warning' : 'text-fg-muted'}>{Number(r.deposit_amount) > 0 || r.deposit_status === 'cancelled' ? DEPOSIT_LABELS[r.deposit_status] : ''}</span>
          </div>
          <div className="text-fg-muted">
            {Number(r.charge_amount) > 0 && `Charges ${formatINR(Number(r.charge_amount))}`}
            {Number(r.charge_amount) > 0 && Number(r.deposit_amount) > 0 && ' · '}
            {Number(r.deposit_amount) > 0 && `Deposit ${formatINR(Number(r.deposit_amount))}`}
            {r.vehicle ? ` · ${r.vehicle}` : ''}
            {r.bill_id && <> · <Link href={`/bill/${r.bill_id}`} className="text-brand">Bill{paid[r.bill_id] ? ' (paid)' : ' (not paid yet)'}</Link></>}
          </div>
          {r.deposit_status === 'refunded' && (
            <div className="text-fg-muted">Refunded {formatINR(Number(r.deposit_amount) - Number(r.kept_amount ?? 0))} on {r.refunded_on}{Number(r.kept_amount) > 0 ? ` · kept ${formatINR(Number(r.kept_amount))}: ${r.kept_reason}` : ''}</div>
          )}
          {canManage && r.deposit_status === 'held' && (
            refunding?.id === r.id ? (
              <div className="flex flex-wrap gap-2 items-center">
                <label className="text-fg">Keep ₹<input type="number" min={0} max={Number(r.deposit_amount)} value={refunding.kept} onChange={e => setRefunding({ ...refunding, kept: e.target.value })} className="w-24 ml-1 bg-surface border border-border-strong rounded px-2 py-1 text-fg" /></label>
                <input value={refunding.reason} onChange={e => setRefunding({ ...refunding, reason: e.target.value })} maxLength={200} placeholder="Why (needed when keeping some)" className="flex-1 min-w-40 bg-surface border border-border-strong rounded px-2 py-1 text-fg" />
                <label className="text-fg">Paid on<input type="date" value={refunding.paidOn} onChange={e => setRefunding({ ...refunding, paidOn: e.target.value })} className="ml-1 bg-surface border border-border-strong rounded px-2 py-1 text-fg" /></label>
                <select value={refunding.ledger} onChange={e => setRefunding({ ...refunding, ledger: e.target.value })} className="bg-surface border border-border-strong rounded px-2 py-1 text-fg">
                  {payFrom.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input value={refunding.reference} onChange={e => setRefunding({ ...refunding, reference: e.target.value })} maxLength={60} placeholder="Cheque / UTR no." className="w-32 bg-surface border border-border-strong rounded px-2 py-1 text-fg" />
                <button onClick={refund} disabled={busy} className="px-3 py-1.5 rounded-lg bg-success text-on-brand font-semibold disabled:opacity-50 cursor-pointer">{busy ? 'Saving…' : 'Record refund'}</button>
                <button onClick={() => setRefunding(null)} className="text-fg-muted cursor-pointer">Cancel</button>
              </div>
            ) : (
              <button onClick={() => { setRefunding({ id: r.id, kept: '0', reason: '', paidOn: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()), ledger: payFrom[0]?.id ?? '', reference: '' }); setDone(null); }} disabled={!r.bill_id || !paid[r.bill_id]}
                title={r.bill_id && !paid[r.bill_id] ? 'The deposit has not been paid yet' : undefined}
                className="text-brand disabled:text-fg-subtle cursor-pointer">Refund deposit</button>
            )
          )}
        </div>
      ))}
    </div>
  );
};
