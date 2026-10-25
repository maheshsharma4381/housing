'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { downloadCsv, toCsv } from '../lib/csv-export';
import { GSTR2B_CSV_TEMPLATE, Gstr2bParseResult, parseGstr2bCsv, parseGstr2bJson } from '../lib/gstr2b';
import { Banner } from './Banner';
import { FileSpreadsheet, Upload, Loader2, ShieldCheck, Download, FileDown } from 'lucide-react';

interface UploadRow { id: string; return_period: string; file_name: string; uploaded_at: string; total_invoices_found: number; total_taxable_value: number }
interface DetailRow {
  side: 'portal' | 'books'; status: string; supplier_gstin: string; supplier_name: string; invoice_number: string;
  invoice_date: string; portal_taxable: number | null; portal_tax: number | null; books_taxable: number | null; books_tax: number | null; expense_number: string | null;
}
interface ImportResult {
  upload_id: string; invoices: number; exact_match: number; partial_match: number;
  missing_in_books: number; missing_in_2b: number; total_taxable: number; total_tax: number; itc_at_risk: number;
}

const STATUS_INFO: Record<string, { label: string; cls: string; hint: string }> = {
  exact_match: { label: 'Matched', cls: 'bg-emerald-500/10 text-emerald-300', hint: 'Invoice and amounts agree' },
  partial_match: { label: 'Amount mismatch', cls: 'bg-amber-500/10 text-amber-300', hint: 'Same invoice, taxable or tax differs by more than ₹1' },
  missing_in_books: { label: 'Not in books', cls: 'bg-sky-500/10 text-sky-300', hint: 'Supplier reported it; society has not recorded the bill' },
  missing_in_2b: { label: 'Not in 2B', cls: 'bg-rose-500/10 text-rose-300', hint: 'Recorded in books but supplier has not filed — ITC at risk' },
};

const toPeriod = (month: string) => { const [y, m] = month.split('-'); return `${m}${y}`; }; // 2026-10 -> 102026
const periodLabel = (p: string) => new Date(Number(p.slice(2)), Number(p.slice(0, 2)) - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

export const Gstr2bPanel: React.FC<{ societyId: string; societyName?: string }> = ({ societyId, societyName }) => {
  const lastMonth = (() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
  const [month, setMonth] = useState(lastMonth);
  const [fileName, setFileName] = useState('');
  const [format, setFormat] = useState<'json' | 'csv'>('json');
  const [parsed, setParsed] = useState<Gstr2bParseResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailRow[]>([]);
  const [filter, setFilter] = useState<string>('issues');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadUploads = useCallback(async () => {
    if (!supabase) return;
    const { data } = await supabase.from('gst_2b_uploads').select('id, return_period, file_name, uploaded_at, total_invoices_found, total_taxable_value')
      .eq('society_id', societyId).order('return_period', { ascending: false });
    setUploads((data ?? []) as UploadRow[]);
  }, [societyId]);

  const loadDetail = useCallback(async (uploadId: string) => {
    if (!supabase) return;
    setSelected(uploadId);
    const { data, error: rpcErr } = await supabase.rpc('gst_reconciliation_detail', { p_upload_id: uploadId });
    if (rpcErr) return setError(rpcErr.message);
    setDetail((data ?? []) as DetailRow[]);
  }, []);

  useEffect(() => {
    loadUploads();
  }, [loadUploads]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setResult(null);
    setError(null);
    const text = await file.text();
    const isJson = file.name.toLowerCase().endsWith('.json') || text.trimStart().startsWith('{');
    const p = isJson ? parseGstr2bJson(text) : parseGstr2bCsv(text);
    setFormat(isJson ? 'json' : 'csv');
    setFileName(file.name);
    setParsed(p);
    if (p.returnPeriod) setMonth(`${p.returnPeriod.slice(2)}-${p.returnPeriod.slice(0, 2)}`);
  };

  const runImport = async () => {
    if (!supabase || !parsed?.invoices.length) return;
    setBusy(true);
    setError(null);
    const { data, error: rpcErr } = await supabase.rpc('import_gstr2b', {
      p_society_id: societyId,
      p_return_period: toPeriod(month),
      p_file_name: fileName,
      p_format: format,
      p_invoices: parsed.invoices,
    });
    setBusy(false);
    if (rpcErr) return setError(rpcErr.message);
    const r = data as ImportResult;
    setResult(r);
    setParsed(null);
    await loadUploads();
    loadDetail(r.upload_id);
  };

  const exportDetail = () => {
    const upload = uploads.find(u => u.id === selected);
    downloadCsv(`${(societyName ?? 'society').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-gstr2b-recon-${upload?.return_period ?? ''}.csv`, toCsv(detail, [
      { header: 'Status', value: d => STATUS_INFO[d.status]?.label ?? d.status },
      { header: 'Supplier GSTIN', value: d => d.supplier_gstin },
      { header: 'Supplier', value: d => d.supplier_name },
      { header: 'Invoice No', value: d => d.invoice_number },
      { header: 'Invoice Date', value: d => d.invoice_date },
      { header: '2B Taxable', value: d => d.portal_taxable },
      { header: '2B Tax', value: d => d.portal_tax },
      { header: 'Books Taxable', value: d => d.books_taxable },
      { header: 'Books Tax', value: d => d.books_tax },
      { header: 'Expense No', value: d => d.expense_number },
    ]));
  };

  const shown = detail.filter(d => (filter === 'all' ? true : filter === 'issues' ? d.status !== 'exact_match' : d.status === filter));
  const inputClass = 'bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-amber-500';

  return (
    <div className="space-y-5 text-xs">
      <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 flex items-start gap-3 text-slate-300">
        <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
        <div>
          <div className="font-semibold text-white">GSTR-2B Offline Matching</div>
          <div className="text-slate-400 mt-0.5">
            No GST portal password is ever stored. Download GSTR-2B (JSON, or the B2B sheet saved as CSV) from gst.gov.in and upload it here.
            Supplier GSTIN + invoice number are matched against the society&apos;s recorded vendor bills.
          </div>
        </div>
      </div>
      <Banner tone="error">{error}</Banner>

      <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-bold text-white text-sm flex items-center gap-2"><FileSpreadsheet className="w-4 h-4 text-amber-400" /> Upload GSTR-2B</div>
          <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(GSTR2B_CSV_TEMPLATE)}`} download="gstr2b-template.csv" className="flex items-center gap-1 text-sky-400 hover:underline">
            <FileDown className="w-3.5 h-3.5" /> CSV template
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-slate-400">Return period</span>
          <input type="month" value={month} onChange={e => setMonth(e.target.value)} className={inputClass} />
          <input type="file" accept=".json,.csv,application/json,text/csv" onChange={e => onFile(e.target.files?.[0])}
            className="text-slate-300 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-slate-800 file:text-slate-200 file:cursor-pointer" />
        </div>

        {parsed && (
          <div className="space-y-2">
            <div className="text-slate-300">
              <strong className="text-white">{parsed.invoices.length}</strong> B2B invoices read from {fileName}
              {parsed.returnPeriod && <> for <strong className="text-white">{periodLabel(parsed.returnPeriod)}</strong></>}
              {parsed.returnPeriod && parsed.returnPeriod !== toPeriod(month) && <span className="text-amber-300"> — file period differs from the selected month</span>}
            </div>
            {Object.keys(parsed.skipped).length > 0 && (
              <div className="text-slate-500">Not reconciled yet: {Object.entries(parsed.skipped).map(([k, n]) => `${k.toUpperCase()} (${n})`).join(', ')}</div>
            )}
            {parsed.errors.length > 0 && (
              <ul className="max-h-28 overflow-y-auto p-3 rounded-xl bg-rose-500/5 border border-rose-500/20 text-rose-300 space-y-0.5">
                {parsed.errors.slice(0, 30).map(e => <li key={e}>{e}</li>)}
              </ul>
            )}
            <button onClick={runImport} disabled={busy || parsed.invoices.length === 0} className="w-full py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Reconcile {periodLabel(toPeriod(month))}
            </button>
          </div>
        )}
      </section>

      {result && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {[
            ['Matched', result.exact_match, 'text-emerald-400'],
            ['Amount mismatch', result.partial_match, 'text-amber-300'],
            ['Not in books', result.missing_in_books, 'text-sky-300'],
            ['Not in 2B', result.missing_in_2b, 'text-rose-400'],
            ['ITC at risk', formatINR(result.itc_at_risk), 'text-rose-400'],
          ].map(([label, value, cls]) => (
            <div key={label as string} className="p-3 rounded-2xl bg-slate-900 border border-slate-800">
              <div className="text-slate-400">{label}</div>
              <div className={`text-base font-bold ${cls}`}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {uploads.length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-white text-sm">Reconciliations</span>
            {uploads.map(u => (
              <button key={u.id} onClick={() => loadDetail(u.id)} className={`px-3 py-1.5 rounded-xl cursor-pointer ${selected === u.id ? 'bg-amber-600 text-white' : 'bg-slate-900 border border-slate-800 text-slate-300'}`}>
                {periodLabel(u.return_period)}
              </button>
            ))}
          </div>

          {selected && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <select value={filter} onChange={e => setFilter(e.target.value)} className="bg-slate-900 border border-slate-700 rounded-xl px-2 py-1.5 text-white">
                  <option value="issues">Needs attention</option>
                  <option value="all">All lines</option>
                  {Object.entries(STATUS_INFO).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                <button onClick={exportDetail} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-slate-200 cursor-pointer">
                  <Download className="w-3.5 h-3.5" /> Export CSV
                </button>
              </div>
              <div className="rounded-2xl bg-slate-900 border border-slate-800 overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-slate-950 text-slate-400">
                    <tr><th className="p-2">Status</th><th className="p-2">Supplier</th><th className="p-2">Invoice</th><th className="p-2 text-right">2B taxable / tax</th><th className="p-2 text-right">Books taxable / tax</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 text-slate-300">
                    {shown.length === 0 && <tr><td className="p-3 text-slate-500" colSpan={5}>Nothing to show — all invoices matched. ✓</td></tr>}
                    {shown.map((d, i) => (
                      <tr key={i} title={STATUS_INFO[d.status]?.hint}>
                        <td className="p-2"><span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap ${STATUS_INFO[d.status]?.cls}`}>{STATUS_INFO[d.status]?.label ?? d.status}</span></td>
                        <td className="p-2"><div className="text-white">{d.supplier_name}</div><div className="font-mono text-[10px] text-slate-500">{d.supplier_gstin}</div></td>
                        <td className="p-2"><div className="text-white">{d.invoice_number}</div><div className="text-slate-500">{d.invoice_date}{d.expense_number && ` • ${d.expense_number}`}</div></td>
                        <td className="p-2 text-right whitespace-nowrap">{d.portal_taxable !== null ? `${formatINR(d.portal_taxable)} / ${formatINR(d.portal_tax)}` : '—'}</td>
                        <td className="p-2 text-right whitespace-nowrap">{d.books_taxable !== null ? `${formatINR(d.books_taxable)} / ${formatINR(d.books_tax)}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
};
