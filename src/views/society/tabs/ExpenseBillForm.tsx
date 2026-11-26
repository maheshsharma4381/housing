'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../../lib/supabase/client';
import { formatINR } from '../../../lib/inr';
import { deleteSocietyFile, uploadSocietyFile } from '../../../lib/storage';
import { explainTds, suggestsAsset, vendorPan, panEntity } from '../../../lib/tds';
import { assetTypeOptions, type AssetTypeRow } from '../../../lib/asset-types';
import type { ExtractedInvoice } from '../../../lib/invoice-extract';
import { AssetAccountCode, BillType, TdsSuggestion, Vendor } from '../../../types/database';
import { Banner } from '../../../components/Banner';
import { FileUp, Loader2, Receipt, Sparkles, Store, Camera } from 'lucide-react';

type Mode = 'invoice' | 'pending' | 'none';
type Source = 'invoice' | 'rule' | 'you';
type Field = 'vendor' | 'title' | 'category' | 'invoiceNumber' | 'invoiceDate' | 'subtotal' | 'gst' | 'type' | 'assetCode' | 'tds';

interface ExpenseBillFormProps {
  societyId: string;
  vendors: Vendor[];
  categories: BillType[];
  requiredApprovals: number;
  onVendorsChanged: () => void;
  onCreated: (message: string) => void;
}

const emptyForm = {
  vendorId: '', title: '', category: 'repairs', invoiceNumber: '', invoiceDate: '', subtotal: 0, gst: 0,
  expenseType: 'revenue' as 'revenue' | 'capital', assetCode: '' as AssetAccountCode | '', location: '',
  fundedFrom: 'general' as 'general' | 'sinking_fund' | 'repair_fund', gstClaimable: false,
  tds: 0, tdsReason: '', payeeName: '', payeePhone: '',
  otherNature: '' as '' | 'contract' | 'professional' | 'goods', // the "Other" bill type's answer
};

const OTHER_QUESTION = 'Is this for work or a service (contractor, AMC, repair), a professional (CA, lawyer, architect), or goods you bought?';
const OTHER_ANSWERS: [typeof emptyForm.otherNature, string][] = [['contract', 'Work or a service'], ['professional', 'A professional'], ['goods', 'Goods']];

const SOURCE_STYLE: Record<Source, string> = {
  invoice: 'bg-brand-soft text-brand',
  rule: 'bg-brand-soft text-brand-ink',
  you: 'bg-surface-muted text-fg-muted',
};

const Tag: React.FC<{ source?: Source }> = ({ source }) =>
  source ? <span className={`ml-1 px-1.5 py-px rounded-full text-xs font-semibold uppercase ${SOURCE_STYLE[source]}`}>{source}</span> : null;

export const ExpenseBillForm: React.FC<ExpenseBillFormProps> = ({ societyId, vendors, categories, requiredApprovals, onVendorsChanged, onCreated }) => {
  // Asset types are the society's fixed-asset ledgers with their own rates (028)
  const [assetRows, setAssetRows] = useState<AssetTypeRow[]>([]);
  useEffect(() => {
    if (!supabase) return;
    supabase.rpc('asset_ledgers', { p_society_id: societyId }).then(({ data }) => setAssetRows((data ?? []) as AssetTypeRow[]));
  }, [societyId]);
  const assetOptions = assetTypeOptions(assetRows);
  const [mode, setMode] = useState<Mode>('invoice');
  const [form, setForm] = useState(emptyForm);
  const [sources, setSources] = useState<Partial<Record<Field, Source>>>({});
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<ExtractedInvoice | null>(null);
  const [newVendor, setNewVendor] = useState<{ name: string; phone: string; gstin: string; pan: string } | null>(null);
  const [suggestion, setSuggestion] = useState<TdsSuggestion | null>(null);
  const [busy, setBusy] = useState<'upload' | 'read' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sourcesRef = useRef(sources);
  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);

  const category = useMemo(() => categories.find(c => c.key === form.category), [categories, form.category]);
  const vendor = vendors.find(v => v.id === form.vendorId);
  const pan = vendorPan(vendor?.pan, vendor?.gstin);

  // Any field the user touches stops being overwritten by the invoice reader or the rules
  const set = <K extends keyof typeof emptyForm>(key: K, value: (typeof emptyForm)[K], field?: Field) => {
    setForm(f => ({ ...f, [key]: value }));
    if (field) setSources(s => ({ ...s, [field]: 'you' }));
  };

  // Rule: big amount + asset-capable category -> suggest booking it as an asset
  useEffect(() => {
    if (sources.type === 'you') return;
    const capital = mode !== 'none' && suggestsAsset(category, form.subtotal + form.gst);
    setForm(f => ({ ...f, expenseType: capital ? 'capital' : 'revenue', assetCode: capital ? (category?.asset_account_code ?? '') : f.assetCode }));
    setSources(s => ({ ...s, type: 'rule', ...(capital ? { assetCode: 'rule' as Source } : {}) }));
  }, [category, form.subtotal, form.gst, mode, sources.type]);

  // Rule: TDS from the admin's tax rules, the vendor's PAN and this year's total
  useEffect(() => {
    if (!supabase || form.subtotal <= 0) {
      setSuggestion(null);
      return;
    }
    const client = supabase;
    const timer = setTimeout(async () => {
      const { data, error: rpcErr } = await client.rpc('suggest_tds', {
        p_society_id: societyId,
        p_vendor_id: form.vendorId || null,
        p_category: form.category,
        p_taxable: form.subtotal,
        p_invoice_date: form.invoiceDate || null,
        p_tds_nature: form.category === 'other' ? form.otherNature || null : null,
      });
      if (rpcErr) return;
      const s = data as TdsSuggestion;
      setSuggestion(s);
      if (sourcesRef.current.tds !== 'you') {
        setForm(f => ({ ...f, tds: Number(s.amount) || 0 }));
        setSources(src => ({ ...src, tds: 'rule' }));
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [societyId, form.vendorId, form.category, form.subtotal, form.invoiceDate, form.otherNature]);

  const applyExtraction = (inv: ExtractedInvoice) => {
    const found: Partial<Record<Field, Source>> = {};
    const match = vendors.find(v => (inv.gstin && v.gstin?.toUpperCase() === inv.gstin)
      || (inv.vendor_name && v.name.trim().toLowerCase() === inv.vendor_name.trim().toLowerCase()));
    setForm(f => {
      const next = { ...f };
      if (match) { next.vendorId = match.id; found.vendor = 'invoice'; }
      if (inv.description || inv.vendor_name) { next.title = inv.description ?? `Bill from ${inv.vendor_name}`; found.title = 'invoice'; }
      if (inv.category) { next.category = inv.category; found.category = 'invoice'; }
      if (inv.invoice_number) { next.invoiceNumber = inv.invoice_number; found.invoiceNumber = 'invoice'; }
      if (inv.invoice_date) { next.invoiceDate = inv.invoice_date; found.invoiceDate = 'invoice'; }
      if (inv.subtotal != null) { next.subtotal = inv.subtotal; found.subtotal = 'invoice'; }
      if (inv.gst != null) { next.gst = inv.gst; found.gst = 'invoice'; }
      return next;
    });
    setSources(s => ({ ...s, ...found }));
    if (!match && inv.vendor_name) {
      setNewVendor({ name: inv.vendor_name, phone: inv.vendor_phone ?? '', gstin: inv.gstin ?? '', pan: '' });
    }
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setInfo(null);
    setBusy('upload');
    try {
      if (filePath) await deleteSocietyFile(filePath);
      const path = await uploadSocietyFile(societyId, 'expenses', file);
      setFilePath(path);
      setFileName(file.name);
      if (mode !== 'invoice') return;

      setBusy('read');
      type ReadResult = { configured?: boolean; invoice?: ExtractedInvoice; error?: string; needsImages?: boolean; maxPages?: number };
      const read = async (pageImages?: string[]) => (await fetch('/api/extract-invoice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ societyId, path, pageImages }),
      })).json() as Promise<ReadResult>;
      let body = await read();
      // Image-only readers: render the PDF's first pages in the browser and send those
      if (body.needsImages) {
        const { pdfToJpegs } = await import('../../../lib/pdf-to-images');
        body = await read(await pdfToJpegs(file, body.maxPages ?? 2));
      }
      if (body.configured === false) {
        setInfo('Automatic invoice reading is not switched on yet — please type the details.');
      } else if (body.invoice) {
        setExtraction(body.invoice);
        applyExtraction(body.invoice);
        setInfo(body.invoice.warnings.length ? body.invoice.warnings.join(' ') : 'Details read from the invoice — please check each field.');
      } else {
        setInfo(body.error ?? 'Could not read the invoice — please type the details.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const saveVendor = async () => {
    if (!supabase || !newVendor) return;
    if (!newVendor.name.trim() || newVendor.phone.replace(/\D/g, '').length < 10) return setError('Vendor name and a 10-digit phone are required.');
    const { data, error: insErr } = await supabase.from('vendors').insert({
      society_id: societyId,
      name: newVendor.name.trim(),
      phone: newVendor.phone.trim(),
      gstin: newVendor.gstin.trim().toUpperCase() || null,
      pan: newVendor.pan.trim().toUpperCase() || null,
      category: 'other',
    }).select('id').single();
    if (insErr) return setError(insErr.message);
    setNewVendor(null);
    setForm(f => ({ ...f, vendorId: data.id }));
    onVendorsChanged();
  };

  const reset = () => {
    setForm(emptyForm);
    setSources({});
    setFilePath(null);
    setFileName(null);
    setExtraction(null);
    setSuggestion(null);
    setNewVendor(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const switchMode = async (m: Mode) => {
    if (filePath) await deleteSocietyFile(filePath);
    reset();
    setMode(m);
    setInfo(null);
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    if (form.title.trim().length < 3 || form.subtotal <= 0) return setError('Add what the bill is for and the amount.');
    if (mode === 'invoice' && !filePath) return setError('Upload the invoice, or choose "Invoice comes later".');
    if (mode === 'none' && (!form.payeeName.trim() || !filePath)) return setError('A voucher needs who was paid and a photo of the work or receipt.');
    if (form.expenseType === 'capital' && !form.assetCode) return setError('Pick the asset type.');
    if (form.category === 'other' && !form.otherNature) return setError('Answer what this bill is for, so TDS is worked out correctly.');
    const suggested = suggestion ? Number(suggestion.amount) : null;
    if (suggested != null && form.tds !== suggested && !form.tdsReason.trim()) return setError('You changed the TDS — add a reason.');

    setBusy('save');
    setError(null);
    const { error: insErr } = await supabase.from('expenses').insert({
      society_id: societyId,
      vendor_id: form.vendorId || null,
      expense_number: '', // assigned by the database
      category: form.category,
      title: form.title.trim(),
      invoice_number: form.invoiceNumber.trim() || null,
      invoice_date: form.invoiceDate || null,
      subtotal: form.subtotal,
      gst_amount: mode === 'none' ? 0 : form.gst,
      tds_amount: form.tds,
      net_payable: form.subtotal + form.gst - form.tds,
      status: 'pending_approval',
      document_url: filePath,
      expense_type: form.expenseType,
      asset_account_code: form.expenseType === 'capital' ? form.assetCode : null,
      asset_location: form.location.trim() || null,
      funded_from: form.fundedFrom,
      gst_claimable: mode !== 'none' && form.gstClaimable,
      tds_nature: suggestion?.nature ?? null,
      tds_section: suggestion?.applies ? suggestion.section : null,
      tds_rate: suggestion?.applies ? suggestion.rate : null,
      tds_rule_id: suggestion?.rule_id ?? null,
      tds_suggested: suggested,
      tds_override_reason: form.tdsReason.trim() || null,
      invoice_status: mode,
      payee_name: mode === 'none' ? form.payeeName.trim() : null,
      payee_phone: mode === 'none' ? form.payeePhone.trim() || null : null,
      extraction: extraction as unknown as Record<string, unknown> | null,
    });
    setBusy(null);
    if (insErr) return setError(insErr.message);
    reset();
    onCreated(`${mode === 'none' ? 'Voucher' : 'Bill'} submitted. ${requiredApprovals === 2 ? 'Two other committee members' : 'Another committee member'} must approve it.`);
  };

  const inputClass = 'w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand';
  const labelClass = 'space-y-1 block';
  const gross = form.subtotal + (mode === 'none' ? 0 : form.gst);

  return (
    <form onSubmit={submit} className="p-5 rounded-xl bg-surface border border-border space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold text-fg text-sm flex items-center gap-2"><Receipt className="w-4 h-4 text-brand" /> Add a bill</div>
        <div role="radiogroup" className="flex gap-1 p-1 rounded-xl bg-canvas border border-border">
          {([['invoice', 'With invoice'], ['pending', 'Invoice comes later'], ['none', 'No invoice (voucher)']] as [Mode, string][]).map(([m, label]) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => switchMode(m)}
              className={`px-3 py-1.5 rounded-lg font-semibold cursor-pointer ${mode === m ? 'bg-brand text-on-brand' : 'text-fg-muted hover:text-fg'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <Banner tone="error">{error}</Banner>
      <Banner tone="info">{info}</Banner>

      {mode !== 'pending' && (
        <label className="flex flex-col items-center justify-center gap-2 p-5 rounded-xl border-2 border-dashed border-border-strong bg-canvas text-center cursor-pointer hover:border-brand">
          {busy === 'upload' || busy === 'read'
            ? <Loader2 className="w-6 h-6 text-brand animate-spin" />
            : mode === 'none' ? <Camera className="w-6 h-6 text-brand" /> : <FileUp className="w-6 h-6 text-brand" />}
          <span className="text-sm font-semibold text-fg">
            {busy === 'read' ? 'Reading the invoice…' : fileName ?? (mode === 'none' ? 'Photo of the work or handwritten receipt' : 'Upload the vendor\'s invoice (photo or PDF)')}
          </span>
          <span className="text-fg-subtle">{mode === 'none' ? 'Required for a voucher' : 'We fill the bill from it — you check and send for approval'}</span>
          <input ref={fileInput} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" capture={mode === 'none' ? 'environment' : undefined}
            onChange={e => pickFile(e.target.files?.[0])} className="sr-only" disabled={busy !== null} />
        </label>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {mode === 'none' ? (
          <>
            <label className={labelClass}><span className="text-fg-muted">Paid to</span>
              <input value={form.payeeName} onChange={e => set('payeeName', e.target.value)} placeholder="e.g. Ramesh Pawar (plumber)" className={inputClass} /></label>
            <label className={labelClass}><span className="text-fg-muted">Payee phone</span>
              <input value={form.payeePhone} onChange={e => set('payeePhone', e.target.value)} placeholder="Optional" className={inputClass} /></label>
          </>
        ) : (
          <div className="sm:col-span-2 space-y-1">
            <span className="text-fg-muted">Vendor<Tag source={sources.vendor} /></span>
            <div className="flex gap-2">
              <select value={form.vendorId} onChange={e => set('vendorId', e.target.value, 'vendor')} className={inputClass}>
                <option value="">No vendor</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <button type="button" onClick={() => setNewVendor(v => v ? null : { name: '', phone: '', gstin: '', pan: '' })} title="Add vendor"
                className="px-2.5 rounded-xl bg-surface-muted text-fg hover:text-fg cursor-pointer"><Store className="w-4 h-4" /></button>
            </div>
            {vendor && (
              <div className="text-fg-subtle">
                {pan ? <>PAN {pan} · <span className="text-brand-ink">{panEntity(pan) === 'individual' ? 'individual / HUF' : 'company / firm'}</span></> : <span className="text-warning">No PAN or GSTIN — TDS at the no-PAN rate if it applies</span>}
                {vendor.tds_override_rate != null && <> · certificate {vendor.tds_override_rate}%</>}
              </div>
            )}
          </div>
        )}
        <label className={labelClass}><span className="text-fg-muted">Bill type<Tag source={sources.category} /></span>
          <select value={form.category} onChange={e => set('category', e.target.value, 'category')} className={inputClass}>
            {categories.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select></label>
      </div>

      {form.category === 'other' && (
        <div role="radiogroup" aria-label={OTHER_QUESTION} className="p-3 rounded-xl bg-canvas border border-brand space-y-2">
          <div className="text-brand-ink">{OTHER_QUESTION}</div>
          <div className="flex flex-wrap gap-2">
            {OTHER_ANSWERS.map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={form.otherNature === value} onClick={() => set('otherNature', value)}
                className={`px-3 py-1.5 rounded-lg border cursor-pointer ${form.otherNature === value ? 'bg-brand border-brand text-on-brand' : 'bg-surface border-border-strong text-fg hover:border-brand'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {newVendor && (
        <div className="p-3 rounded-xl bg-canvas border border-brand grid grid-cols-2 sm:grid-cols-5 gap-2">
          <div className="col-span-2 sm:col-span-5 text-brand font-semibold">{extraction ? 'New vendor found on the invoice — save it' : 'New vendor'}</div>
          <input value={newVendor.name} onChange={e => setNewVendor({ ...newVendor, name: e.target.value })} placeholder="Vendor name" className={`col-span-2 ${inputClass}`} />
          <input value={newVendor.phone} onChange={e => setNewVendor({ ...newVendor, phone: e.target.value })} placeholder="Phone" className={inputClass} />
          <input value={newVendor.gstin} onChange={e => setNewVendor({ ...newVendor, gstin: e.target.value })} placeholder="GSTIN (gives PAN)" maxLength={15} className={inputClass} />
          <button type="button" onClick={saveVendor} className="rounded-xl bg-brand hover:bg-brand-hover text-on-brand font-semibold cursor-pointer">Save vendor</button>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
        <label className={`col-span-2 sm:col-span-3 ${labelClass}`}><span className="text-fg-muted">What is it for<Tag source={sources.title} /></span>
          <input value={form.title} onChange={e => set('title', e.target.value, 'title')} placeholder="e.g. Security guards — October" className={inputClass} /></label>
        {mode !== 'none' && (
          <>
            <label className={labelClass}><span className="text-fg-muted">Invoice no.<Tag source={sources.invoiceNumber} /></span>
              <input value={form.invoiceNumber} onChange={e => set('invoiceNumber', e.target.value, 'invoiceNumber')} className={inputClass} /></label>
            <label className={`col-span-1 sm:col-span-2 ${labelClass}`}><span className="text-fg-muted">Invoice date<Tag source={sources.invoiceDate} /></span>
              <input type="date" value={form.invoiceDate} onChange={e => set('invoiceDate', e.target.value, 'invoiceDate')} className={inputClass} /></label>
          </>
        )}
        <label className={`col-span-1 sm:col-span-2 ${labelClass}`}><span className="text-fg-muted">{mode === 'none' ? 'Amount (₹)' : 'Taxable amount (₹)'}<Tag source={sources.subtotal} /></span>
          <input type="number" min={0} step="0.01" value={form.subtotal || ''} onChange={e => set('subtotal', Number(e.target.value), 'subtotal')} className={inputClass} /></label>
        {mode !== 'none' && (
          <label className={`col-span-1 sm:col-span-2 ${labelClass}`}><span className="text-fg-muted">GST (₹)<Tag source={sources.gst} /></span>
            <input type="number" min={0} step="0.01" value={form.gst || ''} onChange={e => set('gst', Number(e.target.value), 'gst')} className={inputClass} /></label>
        )}
        <div className="col-span-2 sm:col-span-2 flex items-end text-fg">Total: <strong className="ml-1 text-fg">{formatINR(gross)}</strong></div>
      </div>

      {mode !== 'none' && (
        <div className="space-y-2">
          <div className="text-fg font-semibold">What is this bill for?<Tag source={sources.type} /></div>
          <div role="radiogroup" className="grid grid-cols-2 gap-2">
            {([['revenue', 'Regular expense', 'Security, cleaning, repairs, AMC — goes to Income & Expenditure'],
               ['capital', 'New asset', 'Lasts years — goes to the Balance Sheet, depreciated yearly']] as const).map(([value, label, hint]) => (
              <button key={value} type="button" role="radio" aria-checked={form.expenseType === value}
                onClick={() => { set('expenseType', value, 'type'); if (value === 'capital' && !form.assetCode) set('assetCode', category?.asset_account_code ?? assetOptions[0]?.code ?? '', 'assetCode'); }}
                className={`p-3 rounded-xl text-left cursor-pointer border ${form.expenseType === value ? 'border-brand bg-brand-soft text-fg' : 'border-border bg-canvas text-fg'}`}>
                <div className="font-semibold">{label}{form.expenseType === value ? ' ✓' : ''}</div>
                <div className="text-fg-muted">{hint}</div>
              </button>
            ))}
          </div>
          {sources.type === 'rule' && form.expenseType === 'capital' && (
            <div className="px-3 py-2 rounded-lg bg-warning-soft text-warning">
              {formatINR(gross)} for {category?.label ?? 'this'} usually counts as an asset. It won&apos;t reduce this year&apos;s surplus.
            </div>
          )}
          {form.expenseType === 'capital' && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <label className={labelClass}><span className="text-fg-muted">Asset type<Tag source={sources.assetCode} /></span>
                <select value={form.assetCode} onChange={e => set('assetCode', e.target.value as AssetAccountCode, 'assetCode')} className={inputClass}>
                  {assetOptions.map(a => <option key={a.code} value={a.code}>{a.label} ({a.rate}%)</option>)}
                </select></label>
              <label className={labelClass}><span className="text-fg-muted">Paid from</span>
                <select value={form.fundedFrom} onChange={e => set('fundedFrom', e.target.value as typeof form.fundedFrom)} className={inputClass}>
                  <option value="general">General funds</option>
                  <option value="sinking_fund">Sinking fund</option>
                  <option value="repair_fund">Repair fund</option>
                </select></label>
              <label className={labelClass}><span className="text-fg-muted">Location</span>
                <input value={form.location} onChange={e => set('location', e.target.value)} placeholder="e.g. Gate + lobbies" className={inputClass} /></label>
            </div>
          )}
        </div>
      )}

      <div className="p-3 rounded-xl bg-brand-soft border border-brand space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-fg font-semibold flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5 text-brand-ink" /> TDS<Tag source={sources.tds} /></div>
          <label className="flex items-center gap-2 text-fg">₹
            <input type="number" min={0} step="1" value={form.tds || ''} onChange={e => set('tds', Number(e.target.value), 'tds')} className="w-28 bg-surface border border-border-strong rounded-lg px-2 py-1 text-fg outline-none focus:border-brand" />
          </label>
        </div>
        <div className="text-brand-ink">{suggestion ? explainTds(suggestion) : 'Enter the amount to work out TDS.'}</div>
        {extraction?.material_shown_separately && suggestion?.applies && (
          <div className="text-warning">The invoice lists material separately — TDS may apply only on the labour part. Change the amount if your CA agrees.</div>
        )}
        {suggestion && form.tds !== Number(suggestion.amount) && (
          <input value={form.tdsReason} onChange={e => set('tdsReason', e.target.value)} placeholder="Why is TDS different? (required, logged)" className={inputClass} />
        )}
      </div>

      {mode !== 'none' && (
        <label className="flex items-center gap-2 text-fg cursor-pointer">
          <input type="checkbox" checked={form.gstClaimable} onChange={e => set('gstClaimable', e.target.checked)} className="accent-brand" />
          Claim GST input credit <span className="text-fg-subtle">— off for most society purchases; your CA decides</span>
        </label>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-fg">
        <span>Net payable: <strong className="text-fg">{formatINR(Math.max(gross - form.tds, 0))}</strong>{mode === 'none' && <span className="text-fg-subtle"> · a payment voucher number is created</span>}</span>
      </div>
      <button type="submit" disabled={busy !== null} className="w-full py-2.5 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
        {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Receipt className="w-4 h-4" />} Send for approval ({requiredApprovals} needed)
      </button>
    </form>
  );
};
