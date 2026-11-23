'use client';
// Phase 11A: one flat request — details, the checklist with files, history, and (for the committee) the decision.
import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Upload, FileText, X, Printer, Share2, CheckCircle2 } from 'lucide-react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import { REQUEST_STATUS_LABELS, missingRequired, pendingDays, pendingTone, PENDING_NOTE, type ChecklistItem } from '../lib/requests';
import { openNocLetter, openRequestFile, uploadRequestFile } from '../lib/request-files';
import { whatsappLink } from '../lib/messages';
import { formatMobile } from '../lib/mobile';

export interface RequestRow {
  id: string; society_id: string; unit_id: string; kind: string; status: string; applicant_id: string | null;
  details: { purpose?: string; addressee?: string; tenant_name?: string; tenant_mobile?: string; tenant_email?: string | null; occupants?: number;
    start_date?: string; end_date?: string; police_ref?: string | null; renews_id?: string | null }; checklist: ChecklistItem[]; committee_note: string | null;
  submitted_at: string; noc_type_id: string | null;
}
interface Doc { id: string; item_key: string; path: string; file_name: string | null }
interface Event { id: string; action: string; note: string | null; at: string }
interface Letter { id: string; number: string; issued_on: string; title: string; body: string; signatory: string }

const ACTIONS: Record<string, string> = {
  submitted: 'Request sent', document_added: 'Document added', document_removed: 'Document removed', resubmitted: 'Sent again',
  changes_asked: 'Committee asked for changes', approved: 'Approved', rejected: 'Declined', withdrawn: 'Withdrawn', tenancy_ended: 'Tenant moved out',
};
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export const RequestDetail: React.FC<{
  request: RequestRow; title: string; flatLabel: string; applicantName?: string;
  canDecide: boolean; canEdit: boolean; isCommittee: boolean; onChanged: () => void;
}> = ({ request, title, flatLabel, applicantName, canDecide, canEdit, isCommittee, onChanged }) => {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [letter, setLetter] = useState<Letter | null>(null);
  const [preview, setPreview] = useState<{ body: string; warnings: string[] } | null>(null);
  const [shareNo, setShareNo] = useState<string>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [{ data: d }, { data: e }, { data: l }, { data: u }] = await Promise.all([
      supabase.from('request_documents').select('id, item_key, path, file_name').eq('request_id', request.id).order('uploaded_at'),
      supabase.from('request_events').select('id, action, note, at').eq('request_id', request.id).order('at'),
      supabase.from('noc_letters').select('id, number, issued_on, title, body, signatory').eq('request_id', request.id).maybeSingle(),
      supabase.from('units').select('share_certificate_no').eq('id', request.unit_id).maybeSingle(),
    ]);
    setDocs((d as Doc[]) ?? []);
    setEvents((e as Event[]) ?? []);
    setLetter((l as Letter) ?? null);
    setShareNo((u as { share_certificate_no: string | null } | null)?.share_certificate_no ?? '');
  }, [request.id, request.unit_id]);

  const open = request.status === 'submitted' || request.status === 'changes_asked';
  const loadPreview = useCallback(async () => {
    if (!supabase || !isCommittee || request.kind !== 'noc' || !open) return setPreview(null);
    const { data } = await supabase.rpc('noc_preview', { p_request_id: request.id });
    setPreview(data ? { body: (data as { body: string }).body, warnings: (data as { warnings?: string[] }).warnings ?? [] } : null);
  }, [request.id, request.kind, isCommittee, open]);

  // the committee always sees the letter it is about to sign
  useEffect(() => { void load(); void loadPreview(); }, [load, loadPreview]);

  const run = async (key: string, fn: () => Promise<void>, refreshList = true) => {
    setBusy(key); setError(null);
    try { await fn(); await load(); if (refreshList) onChanged(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    if (!supabase) throw new Error('Supabase is not configured');
    const { data, error: err } = await supabase.rpc(name, args);
    if (err) throw new Error(err.message);
    return data;
  };

  const missing = missingRequired(request.checklist, docs);
  const days = pendingDays(request.submitted_at, new Date());
  const amber = open && pendingTone(request.kind, days) === 'amber';

  return (
    <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-4 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-[11px] text-slate-400">Flat {flatLabel}{applicantName ? ` · ${applicantName}` : ''}</div>
          <h3 className="text-sm font-bold text-white">{title}</h3>
          {request.details.purpose && <div className="text-slate-300">Purpose: {request.details.purpose}</div>}
          {request.kind === 'tenancy' && (
            <div className="text-slate-300 space-y-0.5 mt-1">
              <div>Tenant: {request.details.tenant_name} · {formatMobile(request.details.tenant_mobile ?? '')}{request.details.tenant_email ? ` · ${request.details.tenant_email}` : ''}</div>
              <div>Agreement {request.details.start_date} to {request.details.end_date} · {request.details.occupants} {request.details.occupants === 1 ? 'person' : 'people'}</div>
              {request.details.police_ref && <div>Police reference: {request.details.police_ref}</div>}
              {request.details.renews_id && <div className="text-slate-400">Renews the current tenancy</div>}
            </div>
          )}
          {request.details.addressee && <div className="text-slate-400">To: {request.details.addressee}</div>}
        </div>
        <div className="text-right">
          <div className={`font-semibold ${request.status === 'approved' ? 'text-emerald-300' : request.status === 'changes_asked' ? 'text-amber-300' : request.status === 'rejected' ? 'text-rose-300' : 'text-sky-300'}`}>
            {REQUEST_STATUS_LABELS[request.status] ?? request.status}
          </div>
          {open && <div className={amber ? 'text-amber-300' : 'text-slate-500'}>Pending {days} day{days === 1 ? '' : 's'}</div>}
        </div>
      </div>
      {amber && <Banner tone="info">{PENDING_NOTE}</Banner>}
      {request.committee_note && <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-300">Committee: {request.committee_note}</div>}
      <Banner tone="error">{error}</Banner>

      {request.checklist.length > 0 && (
        <div className="space-y-1.5">
          <div className="font-semibold text-slate-300">Documents</div>
          {request.checklist.map(c => (
            <div key={c.key} className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-200">{c.label}{c.required ? <span className="text-rose-300"> *</span> : <span className="text-slate-500"> (optional)</span>}</span>
                {canEdit && open && (
                  <label className="flex items-center gap-1 text-sky-300 cursor-pointer shrink-0">
                    {busy === `up-${c.key}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Add file
                    <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="hidden"
                      onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void run(`up-${c.key}`, () => uploadRequestFile(request.society_id, request.id, c.key, f), false); }} />
                  </label>
                )}
              </div>
              {docs.filter(d => d.item_key === c.key).map(d => (
                <div key={d.id} className="flex items-center gap-2 mt-1">
                  <button onClick={() => openRequestFile(d.path)} className="flex items-center gap-1 text-sky-300 cursor-pointer"><FileText className="w-3.5 h-3.5" /> {d.file_name || 'File'}</button>
                  {canEdit && open && (
                    <button onClick={() => run(`rm-${d.id}`, async () => { await rpc('remove_request_document', { p_document_id: d.id }); }, false)} title="Remove" className="text-slate-500 hover:text-rose-300 cursor-pointer"><X className="w-3.5 h-3.5" /></button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {letter && (
        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 space-y-2">
          <div className="flex items-center gap-1.5 text-emerald-300 font-semibold"><CheckCircle2 className="w-4 h-4" /> {letter.number}</div>
          <div className="flex flex-wrap gap-3">
            <button onClick={() => openNocLetter(letter, request.society_id)} className="flex items-center gap-1 text-sky-300 cursor-pointer"><Printer className="w-4 h-4" /> Open letter (print or save as PDF)</button>
            <a href={whatsappLink(`${letter.title} (${letter.number}) for flat ${flatLabel} is ready. Open Sahvaas → Requests to download it.`)}
              target="_blank" rel="noreferrer" className="flex items-center gap-1 text-emerald-300"><Share2 className="w-4 h-4" /> Share on WhatsApp</a>
          </div>
        </div>
      )}

      {isCommittee && request.kind === 'noc' && (
        <div className="space-y-2">
          {canDecide && open && (
            <div className="flex items-center gap-2">
              <label className="text-slate-400">Share certificate No.</label>
              <input value={shareNo} onChange={e => setShareNo(e.target.value)} maxLength={32} className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-white w-32" />
              <button onClick={() => run('sc', async () => { await rpc('set_share_certificate', { p_unit_id: request.unit_id, p_number: shareNo }); await loadPreview(); }, false)}
                className="text-sky-300 cursor-pointer">Save</button>
            </div>
          )}
          {preview && (
            <div className="space-y-1.5">
              <div className="font-semibold text-slate-300">The letter as it will be issued today</div>
              {preview.warnings.map(w => <Banner key={w} tone="info">{w}</Banner>)}
              <pre className="whitespace-pre-wrap font-sans p-3 rounded-xl bg-slate-950 border border-slate-800 text-slate-200">{preview.body}</pre>
            </div>
          )}
        </div>
      )}

      {canDecide && open && (
        <div className="space-y-2">
          <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} maxLength={500} placeholder="Note to the applicant (needed to ask for changes or decline)"
            className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500" />
          {missing.length > 0 && request.status === 'submitted' && <div className="text-amber-300">Missing: {missing.join(', ')}</div>}
          <div className="flex flex-wrap gap-2">
            {request.status === 'submitted' && (
              <>
                <button disabled={busy !== null || missing.length > 0} onClick={() => run('approve', async () => { await rpc('decide_request', { p_request_id: request.id, p_decision: 'approve', p_note: note }); setNote(''); })}
                  className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold disabled:opacity-50 cursor-pointer">{busy === 'approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Approve'}</button>
                <button disabled={busy !== null} onClick={() => run('changes', async () => { await rpc('decide_request', { p_request_id: request.id, p_decision: 'changes', p_note: note }); setNote(''); })}
                  className="px-3 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold disabled:opacity-50 cursor-pointer">Ask for changes</button>
              </>
            )}
            <button disabled={busy !== null} onClick={() => run('reject', async () => { await rpc('decide_request', { p_request_id: request.id, p_decision: 'reject', p_note: note }); setNote(''); })}
              className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-rose-700 text-white font-bold disabled:opacity-50 cursor-pointer">Decline</button>
          </div>
        </div>
      )}

      {canEdit && !isCommittee && open && (
        <div className="flex flex-wrap gap-2">
          {request.status === 'changes_asked' && (
            <button disabled={busy !== null} onClick={() => run('resubmit', async () => { await rpc('resubmit_request', { p_request_id: request.id, p_note: null }); })}
              className="px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold disabled:opacity-50 cursor-pointer">Send to the committee again</button>
          )}
          <button disabled={busy !== null} onClick={() => { if (window.confirm('Withdraw this request?')) void run('withdraw', async () => { await rpc('withdraw_request', { p_request_id: request.id }); }); }}
            className="px-3 py-2 rounded-xl bg-slate-800 text-slate-300 cursor-pointer">Withdraw</button>
        </div>
      )}

      {events.length > 0 && (
        <details className="text-slate-400">
          <summary className="cursor-pointer">History</summary>
          <ul className="mt-1 space-y-0.5">
            {events.map(e => <li key={e.id}>{when(e.at)} · {ACTIONS[e.action] ?? e.action}{e.note && !['document_added', 'document_removed'].includes(e.action) ? ` — ${e.note}` : ''}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
};
