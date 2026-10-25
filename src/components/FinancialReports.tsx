'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { downloadCsv, downloadFile, toCsv } from '../lib/csv-export';
import { buildTallyXml } from '../lib/tally-xml';
import { fyLabel } from '../lib/tds';
import { BarChart3, Download, Loader2, AlertCircle, RefreshCw, Printer, FileCode2, Lock } from 'lucide-react';

type ReportKey = 'pnl' | 'balance' | 'rp' | 'trial' | 'ledger' | 'dues' | 'payables' | 'tds' | 'gst' | 'journal';

interface CompareRow { type: string; code: string; name: string; current: number; previous: number; previous_source: 'audited' | 'books'; previous_as_of?: string }
interface TrialRow { code: string; name: string; type: string; debit: number; credit: number }
interface RpRow { section: 'opening' | 'receipt' | 'payment' | 'closing'; code: string | null; name: string; amount: number }
interface LedgerRow { entry_date: string; entry_number: string | null; narration: string; debit: number | null; credit: number | null; balance: number }
interface DuesRow { unit_number: string; wing: string; owner_name: string | null; owner_email: string | null; bills_count: number; outstanding: number; oldest_due_date: string; days_overdue: number }
interface PayableRow { expense_id: string; expense_number: string; payee: string; title: string; bill_date: string; outstanding: number; days: number; bucket: string }
interface TdsRow { paid_on: string; reference: string; expense_number: string; vendor: string | null; pan: string | null; entity: string | null; section: string | null; rate: number | null; taxable: number; amount_paid: number; tds: number }
interface GstSummary { output_gst: number; input_claimed: number; input_not_claimed: number; net_payable: number }
interface JournalRow {
  id: string;
  entry_number: string;
  entry_date: string;
  reference_event_type: string;
  narration: string;
  ledger_entries: { amount: number; accounts: { code: string; name: string } | null }[];
}
interface Account { code: string; name: string; type: string }

const REPORTS: { key: ReportKey; label: string }[] = [
  { key: 'pnl', label: 'Income & Expenditure' },
  { key: 'balance', label: 'Balance Sheet' },
  { key: 'rp', label: 'Receipts & Payments' },
  { key: 'trial', label: 'Trial Balance' },
  { key: 'ledger', label: 'Account Ledger' },
  { key: 'dues', label: 'Member Dues' },
  { key: 'payables', label: 'Payables' },
  { key: 'tds', label: 'TDS Register' },
  { key: 'gst', label: 'GST Summary' },
  { key: 'journal', label: 'Journal' },
];
const RANGE_REPORTS: ReportKey[] = ['pnl', 'rp', 'ledger', 'tds', 'gst', 'journal'];

/** Indian financial year (April–March) containing `d`. */
function financialYear(d = new Date()) {
  const startYear = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return { from: `${startYear}-04-01`, to: `${startYear + 1}-03-31`, label: `FY ${startYear}-${String(startYear + 1).slice(2)}` };
}

const today = () => new Date().toISOString().slice(0, 10);
const n = (v: unknown) => Number(v) || 0;
const prevFyEnd = (d: string) => {
  const y = Number(d.slice(0, 4));
  return Number(d.slice(5, 7)) >= 4 ? `${y}-03-31` : `${y - 1}-03-31`;
};

interface FinancialReportsProps {
  societyId: string;
  societyName?: string;
  /** Plan features; when given, Pro-only reports (TDS register, Tally export) are hidden if missing */
  features?: string[];
}

export const FinancialReports: React.FC<FinancialReportsProps> = ({ societyId, societyName, features }) => {
  const has = (key: string) => !features || features.includes(key);
  const fy = financialYear();
  const [report, setReport] = useState<ReportKey>('pnl');
  const [from, setFrom] = useState(fy.from);
  const [to, setTo] = useState(fy.to);
  const [asOf, setAsOf] = useState(today());
  const [ledgerCode, setLedgerCode] = useState('1000');

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [lockedUntil, setLockedUntil] = useState<string | null>(null);
  const [compare, setCompare] = useState<CompareRow[]>([]);
  const [trial, setTrial] = useState<TrialRow[]>([]);
  const [rp, setRp] = useState<RpRow[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [dues, setDues] = useState<DuesRow[]>([]);
  const [payables, setPayables] = useState<PayableRow[]>([]);
  const [tds, setTds] = useState<TdsRow[]>([]);
  const [deposited, setDeposited] = useState(0);
  const [gst, setGst] = useState<GstSummary | null>(null);
  const [journal, setJournal] = useState<JournalRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.from('accounts').select('code, name, type').eq('society_id', societyId).order('code')
      .then(({ data }) => setAccounts((data ?? []) as Account[]));
    supabase.rpc('books_locked_until', { p_society_id: societyId }).then(({ data }) => setLockedUntil((data as string | null) ?? null));
  }, [societyId]);

  const loadJournal = useCallback(async () => supabase!
    .from('journal_entries')
    .select('id, entry_number, entry_date, reference_event_type, narration, ledger_entries (amount, accounts (code, name))')
    .eq('society_id', societyId)
    .gte('entry_date', from)
    .lte('entry_date', to)
    .order('entry_number', { ascending: false })
    .limit(2000), [societyId, from, to]);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    const failure = { message: '' };
    const run = async <T,>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>, set: (v: T) => void) => {
      const res = await p;
      if (res.error) failure.message = res.error.message;
      else set(res.data as T);
    };
    switch (report) {
      case 'pnl': await run<CompareRow[]>(supabase.rpc('income_expenditure_compare', { p_society_id: societyId, p_from: from, p_to: to }), v => setCompare(v ?? [])); break;
      case 'balance': await run<CompareRow[]>(supabase.rpc('balance_sheet_compare', { p_society_id: societyId, p_as_of: asOf }), v => setCompare(v ?? [])); break;
      case 'rp': await run<RpRow[]>(supabase.rpc('receipts_payments', { p_society_id: societyId, p_from: from, p_to: to }), v => setRp(v ?? [])); break;
      case 'trial': await run<TrialRow[]>(supabase.rpc('trial_balance', { p_society_id: societyId, p_as_of: asOf }), v => setTrial(v ?? [])); break;
      case 'ledger': await run<LedgerRow[]>(supabase.rpc('account_ledger', { p_society_id: societyId, p_code: ledgerCode, p_from: from, p_to: to }), v => setLedger(v ?? [])); break;
      case 'dues': await run<DuesRow[]>(supabase.rpc('member_dues', { p_society_id: societyId, p_as_of: asOf }), v => setDues(v ?? [])); break;
      case 'payables': await run<PayableRow[]>(supabase.rpc('payables_ageing', { p_society_id: societyId, p_as_of: asOf }), v => setPayables(v ?? [])); break;
      case 'tds':
        await run<TdsRow[]>(supabase.rpc('tds_register', { p_society_id: societyId, p_from: from, p_to: to }), v => setTds(v ?? []));
        await run<{ amount: number }[]>(supabase.from('tds_challans').select('amount').eq('society_id', societyId).gte('paid_on', from).lte('paid_on', to),
          v => setDeposited((v ?? []).reduce((s, r) => s + n(r.amount), 0)));
        break;
      case 'gst': await run<GstSummary>(supabase.rpc('gst_summary', { p_society_id: societyId, p_from: from, p_to: to }), v => setGst(v)); break;
      case 'journal': await run<JournalRow[]>(loadJournal(), v => setJournal(v ?? [])); break;
    }
    if (failure.message) setError(failure.message);
    setLoading(false);
  }, [report, societyId, from, to, asOf, ledgerCode, loadJournal]);

  useEffect(() => {
    load();
  }, [load]);

  const openLedger = (code: string) => {
    setLedgerCode(code);
    setReport('ledger');
  };

  // ----- Derived figures -----
  const prevLabel = report === 'balance'
    ? `31 Mar ${prevFyEnd(asOf).slice(0, 4)}`
    : fyLabel(prevFyEnd(from));
  const prevSource = compare[0]?.previous_source;

  const ie = useMemo(() => {
    const income = compare.filter(r => r.type === 'income');
    const expense = compare.filter(r => r.type === 'expense');
    const sum = (rows: CompareRow[], k: 'current' | 'previous') => rows.reduce((s, r) => s + n(r[k]), 0);
    return {
      income, expense,
      inc: { cur: sum(income, 'current'), prev: sum(income, 'previous') },
      exp: { cur: sum(expense, 'current'), prev: sum(expense, 'previous') },
    };
  }, [compare]);

  const bs = useMemo(() => {
    const pick = (types: string[], sign: number) => compare.filter(r => types.includes(r.type)).map(r => ({ ...r, cur: sign * n(r.current), prev: sign * n(r.previous) }));
    const assets = pick(['asset'], 1);
    const liabilities = pick(['liability', 'equity'], -1);
    const ieRows = compare.filter(r => r.type === 'income' || r.type === 'expense');
    const surplus = { cur: -ieRows.reduce((s, r) => s + n(r.current), 0), prev: -ieRows.reduce((s, r) => s + n(r.previous), 0) };
    const total = (rows: { cur: number; prev: number }[], extra = { cur: 0, prev: 0 }) => ({
      cur: rows.reduce((s, r) => s + r.cur, 0) + extra.cur, prev: rows.reduce((s, r) => s + r.prev, 0) + extra.prev,
    });
    return { assets, liabilities, surplus, totalAssets: total(assets), totalLiabilities: total(liabilities, surplus) };
  }, [compare]);

  const trialDr = trial.reduce((s, r) => s + n(r.debit), 0);
  const trialCr = trial.reduce((s, r) => s + n(r.credit), 0);
  const totalDues = dues.reduce((s, r) => s + n(r.outstanding), 0);
  const tdsDeducted = tds.reduce((s, r) => s + n(r.tds), 0);
  const buckets = ['0-30', '31-60', '61-90', '90+'].map(b => ({ b, total: payables.filter(p => p.bucket === b).reduce((s, p) => s + n(p.outstanding), 0) }));

  // ----- Export -----
  const slug = (societyName ?? 'society').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const exportCsv = () => {
    const file = (name: string) => `${slug}-${name}.csv`;
    if (report === 'pnl' || report === 'balance') {
      downloadCsv(file(report === 'pnl' ? `income-expenditure-${from}-to-${to}` : `balance-sheet-${asOf}`), toCsv(compare, [
        { header: 'Type', value: r => r.type },
        { header: 'Code', value: r => r.code },
        { header: 'Account', value: r => r.name },
        { header: report === 'pnl' ? `${from} to ${to}` : `As of ${asOf}`, value: r => n(r.current) },
        { header: `${prevLabel} (${r0(prevSource)})`, value: r => n(r.previous) },
      ]));
    } else if (report === 'rp') {
      downloadCsv(file(`receipts-payments-${from}-to-${to}`), toCsv(rp, [
        { header: 'Section', value: r => r.section }, { header: 'Code', value: r => r.code }, { header: 'Head', value: r => r.name }, { header: 'Amount', value: r => n(r.amount) },
      ]));
    } else if (report === 'trial') {
      downloadCsv(file(`trial-balance-${asOf}`), toCsv(trial, [
        { header: 'Code', value: r => r.code }, { header: 'Account', value: r => r.name }, { header: 'Type', value: r => r.type },
        { header: 'Debit', value: r => n(r.debit) }, { header: 'Credit', value: r => n(r.credit) },
      ]));
    } else if (report === 'ledger') {
      downloadCsv(file(`ledger-${ledgerCode}-${from}-to-${to}`), toCsv(ledger, [
        { header: 'Date', value: r => r.entry_date }, { header: 'Entry', value: r => r.entry_number }, { header: 'Narration', value: r => r.narration },
        { header: 'Debit', value: r => (r.debit ? n(r.debit) : '') }, { header: 'Credit', value: r => (r.credit ? n(r.credit) : '') }, { header: 'Balance', value: r => n(r.balance) },
      ]));
    } else if (report === 'dues') {
      downloadCsv(file(`member-dues-${asOf}`), toCsv(dues, [
        { header: 'Wing', value: r => r.wing }, { header: 'Flat', value: r => r.unit_number }, { header: 'Owner', value: r => r.owner_name },
        { header: 'Email', value: r => r.owner_email }, { header: 'Unpaid Bills', value: r => r.bills_count }, { header: 'Outstanding', value: r => n(r.outstanding) },
        { header: 'Oldest Due Date', value: r => r.oldest_due_date }, { header: 'Days Overdue', value: r => r.days_overdue },
      ]));
    } else if (report === 'payables') {
      downloadCsv(file(`payables-${asOf}`), toCsv(payables, [
        { header: 'Bill', value: r => r.expense_number }, { header: 'Vendor / payee', value: r => r.payee }, { header: 'For', value: r => r.title },
        { header: 'Bill date', value: r => r.bill_date }, { header: 'Outstanding', value: r => n(r.outstanding) }, { header: 'Days', value: r => r.days }, { header: 'Bucket', value: r => r.bucket },
      ]));
    } else if (report === 'tds') {
      downloadCsv(file(`tds-register-${from}-to-${to}`), toCsv(tds, [
        { header: 'Paid on', value: r => r.paid_on }, { header: 'Payment', value: r => r.reference }, { header: 'Bill', value: r => r.expense_number },
        { header: 'Vendor', value: r => r.vendor }, { header: 'PAN', value: r => r.pan }, { header: 'Section', value: r => r.section }, { header: 'Rate %', value: r => r.rate },
        { header: 'Taxable', value: r => n(r.taxable) }, { header: 'Paid', value: r => n(r.amount_paid) }, { header: 'TDS', value: r => n(r.tds) },
      ]));
    } else if (report === 'gst' && gst) {
      downloadCsv(file(`gst-summary-${from}-to-${to}`), toCsv(Object.entries(gst), [{ header: 'Item', value: r => r[0] }, { header: 'Amount', value: r => n(r[1]) }]));
    } else {
      const lines = journal.flatMap(j => j.ledger_entries.map(l => ({ j, l })));
      downloadCsv(file(`journal-${from}-to-${to}`), toCsv(lines, [
        { header: 'Entry', value: x => x.j.entry_number }, { header: 'Date', value: x => x.j.entry_date }, { header: 'Narration', value: x => x.j.narration },
        { header: 'Account Code', value: x => x.l.accounts?.code }, { header: 'Account', value: x => x.l.accounts?.name },
        { header: 'Debit', value: x => (n(x.l.amount) > 0 ? n(x.l.amount) : '') }, { header: 'Credit', value: x => (n(x.l.amount) < 0 ? -n(x.l.amount) : '') },
      ]));
    }
  };

  const exportTally = async () => {
    if (!supabase) return;
    const { data, error: jErr } = await loadJournal();
    if (jErr) return setError(jErr.message);
    const rows = ((data ?? []) as unknown as JournalRow[]).slice().reverse();
    const xml = buildTallyXml(societyName ?? 'Society', accounts, rows.map(j => ({
      entry_number: j.entry_number, entry_date: j.entry_date, narration: j.narration,
      lines: j.ledger_entries.map(l => ({ code: l.accounts?.code ?? '', amount: n(l.amount) })),
    })));
    downloadFile(`${slug}-tally-${from}-to-${to}.xml`, xml, 'application/xml');
  };

  const inputClass = 'bg-slate-950 border border-slate-700 rounded-xl px-2 py-1.5 text-white outline-none focus:border-sky-500';
  const usesRange = RANGE_REPORTS.includes(report);
  const show = !loading && !error;

  return (
    <div className="space-y-5 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2"><BarChart3 className="w-4 h-4 text-sky-400" /> Financial Reports</h2>
          <p className="text-slate-400">Built automatically from bills, payments, vendor bills, depreciation and approved adjustments (double-entry).</p>
          {lockedUntil && <p className="text-amber-300 flex items-center gap-1 mt-1"><Lock className="w-3 h-3" /> Books locked after audit up to {lockedUntil}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <button onClick={load} className="p-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 cursor-pointer" title="Refresh">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={exportCsv} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 hover:border-sky-500 text-slate-200 cursor-pointer">
            <Download className="w-3.5 h-3.5" /> Excel (CSV)
          </button>
          <button onClick={() => window.print()} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 hover:border-sky-500 text-slate-200 cursor-pointer">
            <Printer className="w-3.5 h-3.5" /> Print / PDF
          </button>
          {has('tally_export') && <button onClick={exportTally} title="Journal vouchers for the selected period; import into a test company first"
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 hover:border-sky-500 text-slate-200 cursor-pointer">
            <FileCode2 className="w-3.5 h-3.5" /> Tally XML
          </button>}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 print:hidden">
        {REPORTS.filter(r => r.key !== 'tds' || has('tds_register')).map(r => (
          <button key={r.key} onClick={() => setReport(r.key)}
            className={`px-3 py-1.5 rounded-xl font-medium cursor-pointer transition ${report === r.key ? 'bg-sky-600 text-white' : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-white'}`}>
            {r.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-slate-400">
        <span className="hidden print:inline font-bold text-white">{societyName} · {REPORTS.find(r => r.key === report)?.label} ·</span>
        {report === 'ledger' && (
          <select value={ledgerCode} onChange={e => setLedgerCode(e.target.value)} className={inputClass}>
            {accounts.map(a => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select>
        )}
        {usesRange ? (
          <>
            <span>From</span><input type="date" value={from} onChange={e => setFrom(e.target.value)} className={inputClass} />
            <span>to</span><input type="date" value={to} onChange={e => setTo(e.target.value)} className={inputClass} />
            <button onClick={() => { setFrom(fy.from); setTo(fy.to); }} className="text-sky-400 hover:underline cursor-pointer print:hidden">{fy.label}</button>
          </>
        ) : (
          <><span>As of</span><input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} className={inputClass} /></>
        )}
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{error}</span>
        </div>
      )}
      {loading && <div className="flex items-center gap-2 text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}

      {show && report === 'pnl' && (
        <div className="space-y-3">
          <CompareTable title="Income" rows={ie.income} prevLabel={prevLabel} prevSource={prevSource} onOpen={openLedger} total={ie.inc} />
          <CompareTable title="Expenditure" rows={ie.expense} prevLabel={prevLabel} prevSource={prevSource} onOpen={openLedger} total={ie.exp} />
          <div className={`p-4 rounded-2xl border font-bold text-sm grid grid-cols-[1fr_auto_auto] gap-6 ${ie.inc.cur - ie.exp.cur >= 0 ? 'bg-emerald-500/5 border-emerald-500/30 text-emerald-300' : 'bg-rose-500/5 border-rose-500/30 text-rose-300'}`}>
            <span>{ie.inc.cur - ie.exp.cur >= 0 ? 'Surplus' : 'Deficit'} for the period</span>
            <span className="w-28 text-right">{signed(ie.inc.cur - ie.exp.cur)}</span>
            <span className="w-28 text-right opacity-70">{signed(ie.inc.prev - ie.exp.prev)}</span>
          </div>
          <p className="text-slate-500">Capital purchases are in the Balance Sheet (Fixed Assets), not here. Click a head to see its entries.</p>
        </div>
      )}

      {show && report === 'balance' && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <CompareTable title="Funds & Liabilities" rows={bs.liabilities.map(r => ({ ...r, current: r.cur, previous: r.prev }))}
              extra={{ name: 'Income & Expenditure surplus', cur: bs.surplus.cur, prev: bs.surplus.prev }}
              prevLabel={prevLabel} prevSource={prevSource} onOpen={openLedger} total={bs.totalLiabilities} />
            <CompareTable title="Assets" rows={bs.assets.map(r => ({ ...r, current: r.cur, previous: r.prev }))}
              prevLabel={prevLabel} prevSource={prevSource} onOpen={openLedger} total={bs.totalAssets} />
          </div>
          <BalanceCheck ok={Math.abs(bs.totalAssets.cur - bs.totalLiabilities.cur) < 0.01} />
        </div>
      )}

      {show && report === 'rp' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Statement title="Receipts" rows={[
            ...rp.filter(r => r.section === 'opening').map(r => [r.name, n(r.amount)] as [string, number]),
            ...rp.filter(r => r.section === 'receipt').map(r => [`From ${r.name}`, n(r.amount)] as [string, number]),
          ]} total={rp.filter(r => r.section === 'opening' || r.section === 'receipt').reduce((s, r) => s + n(r.amount), 0)} />
          <Statement title="Payments" rows={[
            ...rp.filter(r => r.section === 'payment').map(r => [`To ${r.name}`, n(r.amount)] as [string, number]),
            ...rp.filter(r => r.section === 'closing').map(r => [r.name, n(r.amount)] as [string, number]),
          ]} total={rp.filter(r => r.section === 'payment' || r.section === 'closing').reduce((s, r) => s + n(r.amount), 0)} />
          <p className="md:col-span-2 text-slate-500">Cash basis: every bank / cash movement in the period, grouped by what it was for. TDS kept back from vendors is not a payment until deposited.</p>
        </div>
      )}

      {show && report === 'trial' && (
        <div className="space-y-3">
          <div className="rounded-2xl bg-slate-900 border border-slate-800 overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-slate-950 text-slate-400"><tr><th className="p-2.5">Code</th><th className="p-2.5">Account</th><th className="p-2.5 text-right">Debit</th><th className="p-2.5 text-right">Credit</th></tr></thead>
              <tbody className="divide-y divide-slate-800 text-slate-300">
                {trial.map(r => (
                  <tr key={r.code} onClick={() => openLedger(r.code)} className="cursor-pointer hover:bg-slate-800/50">
                    <td className="p-2.5 font-mono text-slate-500">{r.code}</td>
                    <td className="p-2.5 text-white">{r.name}</td>
                    <td className="p-2.5 text-right">{n(r.debit) ? formatINR(r.debit) : ''}</td>
                    <td className="p-2.5 text-right">{n(r.credit) ? formatINR(r.credit) : ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-slate-700 font-bold text-white">
                <tr><td className="p-2.5" colSpan={2}>Total</td><td className="p-2.5 text-right">{formatINR(trialDr)}</td><td className="p-2.5 text-right">{formatINR(trialCr)}</td></tr>
              </tfoot>
            </table>
          </div>
          <BalanceCheck ok={Math.abs(trialDr - trialCr) < 0.01} />
        </div>
      )}

      {show && report === 'ledger' && (
        <div className="rounded-2xl bg-slate-900 border border-slate-800 overflow-x-auto">
          <table className="w-full text-left min-w-[640px]">
            <thead className="bg-slate-950 text-slate-400"><tr><th className="p-2.5">Date</th><th className="p-2.5">Entry</th><th className="p-2.5">Narration</th><th className="p-2.5 text-right">Debit</th><th className="p-2.5 text-right">Credit</th><th className="p-2.5 text-right">Balance</th></tr></thead>
            <tbody className="divide-y divide-slate-800 text-slate-300">
              {ledger.map((r, i) => (
                <tr key={i} className={i === 0 ? 'text-slate-400 italic' : ''}>
                  <td className="p-2.5 whitespace-nowrap">{r.entry_date}</td>
                  <td className="p-2.5 font-mono text-sky-300">{r.entry_number ?? ''}</td>
                  <td className="p-2.5">{r.narration}</td>
                  <td className="p-2.5 text-right">{r.debit ? formatINR(r.debit) : ''}</td>
                  <td className="p-2.5 text-right">{r.credit ? formatINR(r.credit) : ''}</td>
                  <td className="p-2.5 text-right font-semibold text-white">{drCr(n(r.balance))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {show && report === 'dues' && (
        <div className="space-y-3">
          <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 flex justify-between font-bold text-white">
            <span>{dues.length} flats with dues</span><span className="text-amber-400">{formatINR(totalDues)}</span>
          </div>
          <div className="rounded-2xl bg-slate-900 border border-slate-800 divide-y divide-slate-800">
            {dues.length === 0 && <div className="p-4 text-slate-400">No outstanding dues. 🎉</div>}
            {dues.map(d => (
              <div key={`${d.wing}-${d.unit_number}`} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-white">Flat {d.unit_number} <span className="text-slate-500 font-normal">• {d.owner_name ?? 'Unknown owner'}</span></div>
                  <div className="text-slate-400">{d.bills_count} unpaid bill{d.bills_count > 1 ? 's' : ''} • oldest due {d.oldest_due_date}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-bold text-white">{formatINR(d.outstanding)}</div>
                  <div className={d.days_overdue > 90 ? 'text-rose-400 font-semibold' : d.days_overdue > 0 ? 'text-amber-400' : 'text-slate-500'}>
                    {d.days_overdue > 0 ? `${d.days_overdue} days overdue` : 'not yet due'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {show && report === 'payables' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {buckets.map(b => (
              <div key={b.b} className={`p-3 rounded-2xl border ${b.b === '90+' && b.total > 0 ? 'bg-rose-500/5 border-rose-500/30' : 'bg-slate-900 border-slate-800'}`}>
                <div className="text-slate-400">{b.b} days</div><div className="text-base font-bold text-white">{formatINR(b.total)}</div>
              </div>
            ))}
          </div>
          <div className="rounded-2xl bg-slate-900 border border-slate-800 divide-y divide-slate-800">
            {payables.length === 0 && <div className="p-4 text-slate-400">Nothing owed to vendors.</div>}
            {payables.map(p => (
              <div key={p.expense_id} className="p-3 flex justify-between gap-3">
                <div className="min-w-0"><div className="text-white font-semibold">{p.payee}</div><div className="text-slate-400 truncate">{p.expense_number} · {p.title} · billed {p.bill_date}</div></div>
                <div className="text-right shrink-0"><div className="font-bold text-white">{formatINR(p.outstanding)}</div><div className="text-slate-500">{p.days} days</div></div>
              </div>
            ))}
          </div>
        </div>
      )}

      {show && report === 'tds' && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div className="p-3 rounded-2xl bg-slate-900 border border-slate-800"><div className="text-slate-400">Deducted</div><div className="text-base font-bold text-white">{formatINR(tdsDeducted)}</div></div>
            <div className="p-3 rounded-2xl bg-slate-900 border border-slate-800"><div className="text-slate-400">Deposited (challans)</div><div className="text-base font-bold text-white">{formatINR(deposited)}</div></div>
            <div className={`p-3 rounded-2xl border ${tdsDeducted - deposited > 0 ? 'bg-amber-500/5 border-amber-500/30' : 'bg-slate-900 border-slate-800'}`}><div className="text-slate-400">Still to deposit</div><div className="text-base font-bold text-white">{formatINR(Math.max(tdsDeducted - deposited, 0))}</div></div>
          </div>
          <div className="rounded-2xl bg-slate-900 border border-slate-800 overflow-x-auto">
            <table className="w-full text-left min-w-[720px]">
              <thead className="bg-slate-950 text-slate-400"><tr><th className="p-2.5">Paid on</th><th className="p-2.5">Vendor / PAN</th><th className="p-2.5">Section</th><th className="p-2.5">Bill</th><th className="p-2.5 text-right">Taxable</th><th className="p-2.5 text-right">Paid</th><th className="p-2.5 text-right">TDS</th></tr></thead>
              <tbody className="divide-y divide-slate-800 text-slate-300">
                {tds.length === 0 && <tr><td colSpan={7} className="p-4 text-slate-500">No TDS deducted in this period.</td></tr>}
                {tds.map((r, i) => (
                  <tr key={i}>
                    <td className="p-2.5">{r.paid_on}<div className="font-mono text-slate-500">{r.reference}</div></td>
                    <td className="p-2.5"><div className="text-white">{r.vendor ?? '—'}</div><div className="font-mono text-slate-500">{r.pan ?? 'No PAN'}{r.entity ? ` · ${r.entity === 'individual' ? 'individual' : 'company/firm'}` : ''}</div></td>
                    <td className="p-2.5">{r.section ?? '—'}{r.rate != null && ` · ${r.rate}%`}</td>
                    <td className="p-2.5 font-mono">{r.expense_number}</td>
                    <td className="p-2.5 text-right">{formatINR(r.taxable)}</td>
                    <td className="p-2.5 text-right">{formatINR(r.amount_paid)}</td>
                    <td className="p-2.5 text-right font-semibold text-white">{formatINR(r.tds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {show && report === 'gst' && gst && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {([['GST charged on bills (output)', gst.output_gst], ['GST input claimed', gst.input_claimed], ['GST paid, not claimed', gst.input_not_claimed],
             [n(gst.net_payable) >= 0 ? 'Net GST payable' : 'Input credit carried forward', Math.abs(n(gst.net_payable))]] as [string, number][]).map(([label, v]) => (
            <div key={label} className="p-4 rounded-2xl bg-slate-900 border border-slate-800"><div className="text-slate-400">{label}</div><div className="text-lg font-bold text-white">{formatINR(v)}</div></div>
          ))}
          <p className="col-span-2 lg:col-span-4 text-slate-500">From the books. Match input credit with GSTR-2B before filing; “not claimed” is GST on bills the committee did not mark as claimable.</p>
        </div>
      )}

      {show && report === 'journal' && (
        <div className="space-y-2">
          {journal.length === 0 && <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 text-slate-400">No journal entries in this period.</div>}
          {journal.slice(0, 200).map(j => (
            <div key={j.id} className="p-3 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
              <div className="min-w-0">
                <span className="font-mono text-sky-300">{j.entry_number}</span> <span className="text-slate-500">• {j.entry_date}</span>
                {j.reference_event_type === 'adjustment.approved' && <span className="ml-2 px-1.5 py-px rounded-full text-[9px] font-bold uppercase bg-violet-500/15 text-violet-300">CA adjustment</span>}
                <div className="text-slate-300 truncate">{j.narration}</div>
              </div>
              <table className="w-full">
                <tbody className="text-slate-400">
                  {[...j.ledger_entries].sort((a, b) => n(b.amount) - n(a.amount)).map((l, i) => (
                    <tr key={i}>
                      <td className={`py-0.5 ${n(l.amount) < 0 ? 'pl-6' : ''}`}>{n(l.amount) > 0 ? 'Dr' : 'Cr'} {l.accounts?.name ?? 'Account'}</td>
                      <td className="py-0.5 text-right w-28">{n(l.amount) > 0 ? formatINR(l.amount) : ''}</td>
                      <td className="py-0.5 text-right w-28">{n(l.amount) < 0 ? formatINR(-n(l.amount)) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {journal.length > 200 && <div className="text-slate-500">Showing 200 of {journal.length} — export CSV or Tally XML for the full period.</div>}
        </div>
      )}
    </div>
  );
};

const r0 = (s?: string) => (s === 'audited' ? 'audited' : 'books');
const signed = (v: number) => (v < 0 ? `(${formatINR(-v)})` : formatINR(v));
const drCr = (v: number) => (v === 0 ? formatINR(0) : `${formatINR(Math.abs(v))} ${v > 0 ? 'Dr' : 'Cr'}`);

const CompareTable: React.FC<{
  title: string;
  rows: { code: string; name: string; current: number; previous: number }[];
  extra?: { name: string; cur: number; prev: number };
  total: { cur: number; prev: number };
  prevLabel: string;
  prevSource?: string;
  onOpen: (code: string) => void;
}> = ({ title, rows, extra, total, prevLabel, prevSource, onOpen }) => (
  <div className="rounded-2xl bg-slate-900 border border-slate-800 overflow-hidden">
    <div className="p-3 border-b border-slate-800 font-bold text-white grid grid-cols-[1fr_auto_auto] gap-6">
      <span>{title}</span><span className="w-28 text-right text-slate-400 font-medium">This period</span>
      <span className="w-28 text-right text-slate-400 font-medium">{prevLabel}{prevSource && <span className="block text-[10px]">({r0(prevSource)})</span>}</span>
    </div>
    <div className="divide-y divide-slate-800">
      {rows.length === 0 && !extra && <div className="p-3 text-slate-500">Nothing recorded</div>}
      {rows.map(r => (
        <button key={r.code} onClick={() => onOpen(r.code)} className="w-full p-3 grid grid-cols-[1fr_auto_auto] gap-6 text-left text-slate-300 hover:bg-slate-800/50 cursor-pointer">
          <span><span className="font-mono text-slate-500 mr-2">{r.code}</span>{r.name}</span>
          <span className="w-28 text-right">{signed(Number(r.current) || 0)}</span>
          <span className="w-28 text-right text-slate-500">{signed(Number(r.previous) || 0)}</span>
        </button>
      ))}
      {extra && (
        <div className="p-3 grid grid-cols-[1fr_auto_auto] gap-6 text-slate-300">
          <span>{extra.name}</span><span className="w-28 text-right">{signed(extra.cur)}</span><span className="w-28 text-right text-slate-500">{signed(extra.prev)}</span>
        </div>
      )}
    </div>
    <div className="p-3 border-t border-slate-700 grid grid-cols-[1fr_auto_auto] gap-6 font-bold text-white">
      <span>Total</span><span className="w-28 text-right">{signed(total.cur)}</span><span className="w-28 text-right text-slate-400">{signed(total.prev)}</span>
    </div>
  </div>
);

const Statement: React.FC<{ title: string; rows: [string, number][]; total: number }> = ({ title, rows, total }) => (
  <div className="rounded-2xl bg-slate-900 border border-slate-800">
    <div className="p-3 border-b border-slate-800 font-bold text-white">{title}</div>
    <div className="divide-y divide-slate-800">
      {rows.length === 0 && <div className="p-3 text-slate-500">Nothing recorded</div>}
      {rows.map(([label, value], i) => (
        <div key={`${label}-${i}`} className="p-3 flex justify-between text-slate-300">
          <span>{label}</span><span className={value < 0 ? 'text-rose-300' : ''}>{signed(value)}</span>
        </div>
      ))}
    </div>
    <div className="p-3 border-t border-slate-700 flex justify-between font-bold text-white"><span>Total</span><span>{formatINR(total)}</span></div>
  </div>
);

const BalanceCheck: React.FC<{ ok: boolean }> = ({ ok }) => (
  <div className={`p-2.5 rounded-xl text-center font-semibold ${ok ? 'bg-emerald-500/5 text-emerald-400' : 'bg-rose-500/10 text-rose-300'}`}>
    {ok ? '✓ Books balance' : '⚠ Books do not balance — contact support'}
  </div>
);
