'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase/client';
import { formatINR } from '../../../lib/inr';
import { parseCsv } from '../../../lib/unit-csv';
import { Banner } from '../../../components/Banner';
import { History, Loader2, CheckCircle2 } from 'lucide-react';

// side: which side is "normal" for the account, so users type positive numbers
const ACCOUNTS: { code: string; name: string; side: 'debit' | 'credit' }[] = [
  { code: '1000', name: 'Bank balance (all accounts)', side: 'debit' },
  { code: '1100', name: 'Cash in hand', side: 'debit' },
  { code: '2000', name: 'Payable to vendors', side: 'credit' },
  { code: '2100', name: 'GST payable', side: 'credit' },
  { code: '2200', name: 'TDS payable', side: 'credit' },
  { code: '2300', name: 'Advance maintenance received', side: 'credit' },
  { code: '3000', name: 'Sinking fund', side: 'credit' },
  { code: '3100', name: 'Repair & maintenance fund', side: 'credit' },
];

/** "flat,amount" or "wing,flat,amount" per line; header optional. */
function parseDues(text: string): { rows: { wing?: string; unit_number: string; amount: number }[]; errors: string[] } {
  const rows: { wing?: string; unit_number: string; amount: number }[] = [];
  const errors: string[] = [];
  parseCsv(text).forEach((cells, i) => {
    const c = cells.map(x => x.trim());
    const amountText = (c.length >= 3 ? c[2] : c[1] ?? '').replace(/[₹,\s]/g, '');
    if (i === 0 && Number.isNaN(Number(amountText))) return; // header
    const amount = Number(amountText);
    const flat = c.length >= 3 ? c[1] : c[0];
    if (!flat || !Number.isFinite(amount) || amount < 0) {
      errors.push(`Line ${i + 1}: expected "flat,amount" with a positive amount.`);
      return;
    }
    if (amount > 0) rows.push({ ...(c.length >= 3 && c[0] ? { wing: c[0] } : {}), unit_number: flat, amount });
  });
  return { rows, errors };
}

const lastMarch31 = () => {
  const d = new Date();
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-03-31`;
};

export const OpeningBalances: React.FC<{ societyId: string }> = ({ societyId }) => {
  const [posted, setPosted] = useState<{ entry_number: string; entry_date: string } | null>(null);
  const [asOf, setAsOf] = useState(lastMarch31());
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [duesText, setDuesText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.from('journal_entries').select('entry_number, entry_date')
      .eq('society_id', societyId).eq('reference_event_type', 'opening.balance').maybeSingle()
      .then(({ data }) => setPosted(data ?? null));
  }, [societyId, notice]);

  const dues = useMemo(() => parseDues(duesText), [duesText]);
  const lines = ACCOUNTS.map(a => ({ ...a, value: Number(amounts[a.code] || 0) })).filter(a => a.value);
  const signed = lines.map(l => ({ code: l.code, amount: l.side === 'debit' ? l.value : -l.value }));
  const duesTotal = dues.rows.reduce((s, r) => s + r.amount, 0);
  const balancing = -(signed.reduce((s, l) => s + l.amount, 0) + duesTotal); // to General Reserve (credit if negative)

  const submit = async () => {
    if (!supabase) return;
    if (dues.errors.length) return setError('Fix the member dues lines first.');
    if (!window.confirm(`Post opening balances as on ${asOf}? This can be done only once.`)) return;
    setSaving(true);
    setError(null);
    const { data, error: rpcErr } = await supabase.rpc('post_opening_balances', {
      p_society_id: societyId,
      p_as_of: asOf,
      p_accounts: signed,
      p_member_dues: dues.rows,
    });
    setSaving(false);
    if (rpcErr) return setError(rpcErr.message);
    const r = data as { opening_bills: number; member_dues_total: number; balancing_to_general_reserve: number };
    setNotice(`Opening balances posted. ${r.opening_bills} flats carry arrears of ${formatINR(r.member_dues_total)}; residents can pay them like any bill.`);
  };

  if (posted) {
    return (
      <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 text-xs text-slate-300 flex items-start gap-2">
        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
        <span>Opening balances were posted as on {posted.entry_date} ({posted.entry_number}). See Financial Reports → Journal.</span>
      </div>
    );
  }

  const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500';

  return (
    <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4 text-xs">
      <div>
        <div className="font-bold text-white text-sm flex items-center gap-2"><History className="w-4 h-4 text-amber-400" /> Opening Balances (one time)</div>
        <p className="text-slate-400 mt-1">
          Moving from Tally or registers? Enter closing balances from your last audited balance sheet and each flat&apos;s unpaid dues.
          Any difference is posted to General Reserve — ask your CA to confirm the figures.
        </p>
      </div>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      <label className="flex items-center gap-2 text-slate-400">
        <span className="shrink-0">Balances as on</span>
        <input type="date" value={asOf} max={new Date().toISOString().slice(0, 10)} onChange={e => setAsOf(e.target.value)} className={inputClass} />
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {ACCOUNTS.map(a => (
          <label key={a.code} className="flex items-center gap-2">
            <span className="flex-1 text-slate-300">{a.name} <span className="text-slate-600">({a.side === 'debit' ? 'Dr' : 'Cr'})</span></span>
            <input type="number" min={0} step="0.01" value={amounts[a.code] ?? ''} onChange={e => setAmounts({ ...amounts, [a.code]: e.target.value })} className={`w-36 ${inputClass}`} />
          </label>
        ))}
      </div>

      <label className="block space-y-1">
        <span className="block text-slate-400">Member dues (arrears) — one flat per line: <code className="text-sky-300">flat,amount</code> or <code className="text-sky-300">wing,flat,amount</code></span>
        <textarea rows={5} value={duesText} onChange={e => setDuesText(e.target.value)} placeholder={'A-101,4500\nA-102,1200'} className={`${inputClass} font-mono`} />
      </label>
      {dues.errors.length > 0 && <ul className="text-rose-300 space-y-0.5">{dues.errors.slice(0, 10).map(e => <li key={e}>{e}</li>)}</ul>}

      <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 grid grid-cols-3 gap-2">
        <div><div className="text-slate-500">Member dues</div><div className="font-bold text-white">{formatINR(duesTotal)}</div></div>
        <div><div className="text-slate-500">Accounts entered</div><div className="font-bold text-white">{lines.length}</div></div>
        <div>
          <div className="text-slate-500">To General Reserve</div>
          <div className="font-bold text-white">{formatINR(Math.abs(balancing))} {balancing < 0 ? 'Cr' : balancing > 0 ? 'Dr' : ''}</div>
        </div>
      </div>

      <button onClick={submit} disabled={saving || (lines.length === 0 && dues.rows.length === 0)} className="w-full py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
        {saving && <Loader2 className="w-4 h-4 animate-spin" />} Post Opening Balances
      </button>
    </section>
  );
};
