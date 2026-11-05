'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase/client';
import { formatINR } from '../../lib/inr';
import { Banner } from '../Banner';
import { Loader2, Eye, Megaphone } from 'lucide-react';

// Spec 11 items 2–5: setup funnel, society health (with the support view), revenue, announcements.

const STEP_LABELS: Record<string, string> = { society: 'Registered', flats: 'Flats', maintenance: 'Maintenance', upi: 'UPI', owners: 'Owners', first_bill: 'First bill' };
const card = 'p-4 rounded-2xl bg-slate-900 border border-slate-800';

export const SetupFunnel: React.FC = () => {
  const [f, setF] = useState<{ steps: { step: string; reached: number }[]; stopped_at: Record<string, number>; first_bill: { societies: number; median_minutes: number | null } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    supabase?.rpc('platform_setup_funnel').then(({ data, error: err }) => (err ? setError(err.message) : setF(data)));
  }, []);
  if (!f) return error ? <Banner tone="error">{error}</Banner> : <Loader2 className="w-5 h-5 animate-spin text-purple-400" />;
  const top = Math.max(...f.steps.map(s => s.reached), 1);
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-white">Setup funnel</h2>
      <div className="space-y-2">
        {f.steps.map(s => (
          <div key={s.step} className="flex items-center gap-3">
            <span className="w-28 text-slate-400">{STEP_LABELS[s.step] ?? s.step}</span>
            <div className="flex-1 h-5 rounded bg-slate-800 overflow-hidden"><div className="h-full bg-purple-600" style={{ width: `${(100 * s.reached) / top}%` }} /></div>
            <span className="w-10 text-right text-white font-semibold">{s.reached}</span>
          </div>
        ))}
      </div>
      <p className="text-slate-300">
        Stopped at: {Object.entries(f.stopped_at).map(([k, v]) => `${v} at ${STEP_LABELS[k] ?? k}`).join(', ') || 'nobody'}.
      </p>
      <p className="text-slate-300">
        {f.first_bill.societies} issued their first bill{f.first_bill.median_minutes != null ? `; typical time from first login: ${Math.round(Number(f.first_bill.median_minutes))} minutes` : ''}.
      </p>
    </div>
  );
};

interface HealthRow { society_id: string; name: string; city: string; flats: number; owners_joined_pct: number; collection_pct: number; ca_invited: boolean; opening_approved: boolean; last_active: string; flag: string | null }

export const SocietyHealth: React.FC = () => {
  const [rows, setRows] = useState<HealthRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [support, setSupport] = useState<HealthRow | null>(null);
  useEffect(() => {
    supabase?.rpc('platform_society_health').then(({ data, error: err }) => (err ? setError(err.message) : setRows(data as HealthRow[])));
  }, []);
  if (support) return <SupportView society={support} onClose={() => setSupport(null)} />;
  if (!rows) return error ? <Banner tone="error">{error}</Banner> : <Loader2 className="w-5 h-5 animate-spin text-purple-400" />;
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-bold text-white">Society health</h2>
      <div className="overflow-x-auto rounded-2xl border border-slate-800">
        <table className="w-full text-left">
          <thead className="bg-slate-900 text-slate-400">
            <tr><th className="p-3">Society</th><th className="p-3">Flats</th><th className="p-3">Owners joined</th><th className="p-3">Collected this month</th><th className="p-3">CA</th><th className="p-3">Opening balance</th><th className="p-3">Last active</th><th className="p-3" /></tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.society_id} className="border-t border-slate-800">
                <td className="p-3 text-white">{r.name} <span className="text-slate-500">· {r.city}</span>
                  {r.flag && <span className={`ml-2 px-2 py-0.5 rounded-full text-[10px] font-semibold ${r.flag === 'stuck' ? 'bg-amber-500/15 text-amber-300' : 'bg-slate-700 text-slate-300'}`}>{r.flag === 'stuck' ? 'Stuck in setup' : 'Going quiet'}</span>}
                </td>
                <td className="p-3">{r.flats}</td>
                <td className="p-3">{Number(r.owners_joined_pct)}%</td>
                <td className="p-3">{Number(r.collection_pct)}%</td>
                <td className="p-3">{r.ca_invited ? 'Invited' : '—'}</td>
                <td className="p-3">{r.opening_approved ? 'Approved' : '—'}</td>
                <td className="p-3">{r.last_active ? new Date(r.last_active).toLocaleDateString('en-IN') : '—'}</td>
                <td className="p-3"><button onClick={() => setSupport(r)} className="flex items-center gap-1 text-purple-300 hover:underline cursor-pointer"><Eye className="w-3.5 h-3.5" /> View</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

interface Snapshot {
  expires_at: string;
  society: { name: string; city: string; state: string };
  cards: { to_receive: { amount: number; flats: number; overdue_flats: number }; payments_to_verify: number; approvals: { total: number } };
  members: { active: number; owners: number };
  bills: { bill_number: string; unit_number: string; total_amount: number; balance_due: number; status: string }[];
  payments: { payment_number: string; unit_number: string; amount: number; status: string }[];
  complaints: { title: string; status: string }[];
}

/** Read-only, one hour, audit-logged; the committee gets "Sahvaas support viewed your society on <date>". */
const SupportView: React.FC<{ society: HealthRow; onClose: () => void }> = ({ society, onClose }) => {
  const [reason, setReason] = useState('');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An hour already open needs no new reason (and the committee is not told again)
  const load = async () => {
    if (!supabase) return false;
    const { data, error: err } = await supabase.rpc('support_snapshot', { p_society_id: society.society_id });
    if (err) {
      setSnap(null);
      return false;
    }
    setSnap(data as Snapshot);
    return true;
  };
  useEffect(() => { load(); }, [society.society_id]); // eslint-disable-line react-hooks/exhaustive-deps
  // the hour ends: the data leaves the screen
  useEffect(() => {
    if (!snap) return;
    const ms = new Date(snap.expires_at).getTime() - Date.now();
    const t = setTimeout(() => setSnap(null), Math.max(ms, 0));
    return () => clearTimeout(t);
  }, [snap]);

  const open = async () => {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const start = await supabase.rpc('start_support_view', { p_society_id: society.society_id, p_reason: reason });
    if (start.error) {
      setBusy(false);
      return setError(start.error.message);
    }
    await load();
    setBusy(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-white">Support view · {society.name}</h2>
        <button onClick={onClose} className="text-slate-400 hover:text-white cursor-pointer">Close</button>
      </div>
      <Banner tone="error">{error}</Banner>
      {!snap ? (
        <div className={`${card} space-y-3`}>
          <p className="text-slate-300">Read-only for one hour. The society&apos;s committee is told (with your reason), and every view is recorded in the society&apos;s audit log.</p>
          <input className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white" placeholder="Why are you opening this society? (e.g. secretary called about bills)" value={reason} onChange={e => setReason(e.target.value)} />
          <button onClick={open} disabled={busy} className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold cursor-pointer disabled:opacity-50 flex items-center gap-1.5">
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Open read-only
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-slate-400 flex items-center gap-3">
            Open until {new Date(snap.expires_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}.
            <button onClick={() => load()} className="text-purple-300 hover:underline cursor-pointer">Refresh</button>
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className={card}><div className="text-slate-400">To receive</div><div className="text-white font-bold">{formatINR(Number(snap.cards.to_receive.amount))}</div></div>
            <div className={card}><div className="text-slate-400">Overdue flats</div><div className="text-white font-bold">{snap.cards.to_receive.overdue_flats}</div></div>
            <div className={card}><div className="text-slate-400">Payments to verify</div><div className="text-white font-bold">{snap.cards.payments_to_verify}</div></div>
            <div className={card}><div className="text-slate-400">Members / owners</div><div className="text-white font-bold">{snap.members.active} / {snap.members.owners}</div></div>
          </div>
          <div className={card}>
            <div className="font-semibold text-white mb-2">Latest bills</div>
            {snap.bills.map(b => <div key={b.bill_number} className="flex justify-between py-1 text-slate-300"><span>{b.bill_number} · Flat {b.unit_number} · {b.status}</span><span>{formatINR(Number(b.balance_due))} of {formatINR(Number(b.total_amount))}</span></div>)}
            {snap.bills.length === 0 && <p className="text-slate-500">No bills yet.</p>}
          </div>
          <div className={card}>
            <div className="font-semibold text-white mb-2">Latest payments</div>
            {snap.payments.map(p => <div key={p.payment_number} className="flex justify-between py-1 text-slate-300"><span>{p.payment_number} · Flat {p.unit_number} · {p.status}</span><span>{formatINR(Number(p.amount))}</span></div>)}
            {snap.payments.length === 0 && <p className="text-slate-500">No payments yet.</p>}
          </div>
          <div className={card}>
            <div className="font-semibold text-white mb-2">Open complaints</div>
            {snap.complaints.map((c, i) => <div key={i} className="py-1 text-slate-300">{c.title} · {c.status}</div>)}
            {snap.complaints.length === 0 && <p className="text-slate-500">None open.</p>}
          </div>
        </div>
      )}
    </div>
  );
};

interface Revenue { plans: Record<string, number>; mrr: number; trials_ending_this_week: number; unpaid_invoices: { count: number; total: number }; ads_this_month: number; otp_cost_this_month: number }

export const RevenuePanel: React.FC = () => {
  const [r, setR] = useState<Revenue | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    supabase?.rpc('platform_revenue').then(({ data, error: err }) => (err ? setError(err.message) : setR(data as Revenue)));
  }, []);
  if (!r) return error ? <Banner tone="error">{error}</Banner> : <Loader2 className="w-5 h-5 animate-spin text-purple-400" />;
  const tiles: [string, string][] = [
    ['Monthly recurring revenue', formatINR(Number(r.mrr))],
    ['Trials ending this week', String(r.trials_ending_this_week)],
    ['Unpaid Sahvaas invoices', `${r.unpaid_invoices.count} · ${formatINR(Number(r.unpaid_invoices.total))}`],
    ['Free plan: ads this month vs OTP cost', `${formatINR(Number(r.ads_this_month))} vs ${formatINR(Number(r.otp_cost_this_month))}`],
  ];
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-white">Revenue</h2>
      <div className="flex flex-wrap gap-2">
        {Object.entries(r.plans).map(([plan, n]) => <span key={plan} className="px-3 py-1.5 rounded-full bg-slate-800 text-white capitalize">{plan}: {n}</span>)}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {tiles.map(([label, value]) => <div key={label} className={card}><div className="text-slate-400">{label}</div><div className="text-lg font-bold text-white">{value}</div></div>)}
      </div>
    </div>
  );
};

export const Announcements: React.FC = () => {
  const [f, setF] = useState({ title: '', body: '', plan: '', state: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const send = async () => {
    if (!supabase || !window.confirm('Send this announcement to the secretaries now?')) return;
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase.rpc('platform_announce', { p_title: f.title, p_body: f.body, p_plan: f.plan || null, p_state: f.state || null });
    setBusy(false);
    if (err) return setError(err.message);
    setNotice(`Sent to ${data} committee members (in-app and push).`);
  };
  const input = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white';
  return (
    <div className="space-y-3 max-w-xl">
      <h2 className="text-lg font-bold text-white flex items-center gap-2"><Megaphone className="w-5 h-5 text-purple-400" /> Announcements to secretaries</h2>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>
      <input className={input} placeholder="Title" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} />
      <textarea className={input} rows={4} placeholder="Message" value={f.body} onChange={e => setF({ ...f, body: e.target.value })} />
      <div className="grid grid-cols-2 gap-2">
        <select className={input} value={f.plan} onChange={e => setF({ ...f, plan: e.target.value })}>
          <option value="">All plans</option><option value="trial">Trial</option><option value="free">Free</option><option value="basic">Basic</option><option value="pro">Pro</option>
        </select>
        <input className={input} placeholder="State (all if empty)" value={f.state} onChange={e => setF({ ...f, state: e.target.value })} />
      </div>
      <button onClick={send} disabled={busy || f.title.trim().length < 3} className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold cursor-pointer disabled:opacity-50 flex items-center gap-1.5">
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Send
      </button>
    </div>
  );
};
