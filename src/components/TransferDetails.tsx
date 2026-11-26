'use client';
// Phase 11D: the sale part of a transfer request — the buyer, the deed, the flat's dues, and for the committee
// the share certificate, the fees and the approval that runs the owner change.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Share2 } from 'lucide-react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import { formatMobile } from '../lib/mobile';
import { formatINR } from '../lib/inr';
import { whatsappLink, inviteText } from '../lib/messages';
import { notify } from '../lib/notify';
import { transferBlocker, transferFeeError, TRANSFER_WARNING } from '../lib/transfer';
import type { RequestRow } from './RequestDetail';
import { confirmDialog } from './ui/feedback';

export const TransferDetails: React.FC<{
  request: RequestRow; flatLabel: string; canDecide: boolean; missingDocs: number; onChanged: () => void;
}> = ({ request, flatLabel, canDecide, missingDocs, onChanged }) => {
  const d = request.details;
  const open = request.status === 'submitted' || request.status === 'changes_asked';
  const [dues, setDues] = useState<number | null>(null);
  const [societyName, setSocietyName] = useState('');
  const [fees, setFees] = useState({ fee: '0', premium: '0' });
  const [form, setForm] = useState({ share_certificate_no: '', endorsed_on: '', transfer_date: '' });
  const certTouched = useRef(false);   // a number the committee typed is never replaced by a reload
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [{ data: due }, { data: s }, { data: set }, { data: u }] = await Promise.all([
      open ? supabase.rpc('request_flat_dues', { p_request_id: request.id }) : Promise.resolve({ data: null }),
      supabase.from('societies').select('name').eq('id', request.society_id).maybeSingle(),
      canDecide ? supabase.from('society_settings').select('transfer_fee, transfer_premium').eq('society_id', request.society_id).maybeSingle() : Promise.resolve({ data: null }),
      supabase.from('units').select('share_certificate_no').eq('id', request.unit_id).maybeSingle(),
    ]);
    setDues(due === null || due === undefined ? null : Number(due));
    setSocietyName((s as { name: string } | null)?.name ?? '');
    const st = set as { transfer_fee: number; transfer_premium: number } | null;
    if (st) setFees({ fee: String(st.transfer_fee), premium: String(st.transfer_premium) });
    if (!certTouched.current) setForm(f => ({ ...f, share_certificate_no: d.share_certificate_no ?? (u as { share_certificate_no: string | null } | null)?.share_certificate_no ?? '' }));
  }, [request.id, request.society_id, request.unit_id, open, canDecide, d.share_certificate_no]);

  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(null);
    try { await fn(); await load(); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    if (!supabase) throw new Error('Supabase is not configured');
    const { data, error: err } = await supabase.rpc(name, args);
    if (err) throw new Error(err.message);
    return data;
  };

  const feesBilled = Boolean(d.fees_billed_at);
  const received = Boolean(d.certificate_received);
  const blocker = transferBlocker({ feesBilled, certificateReceived: received, dues: dues ?? 0 });
  const inputClass = 'w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white';

  const billFees = () => {
    const fee = Number(fees.fee || 0);
    const premium = Number(fees.premium || 0);
    const problem = transferFeeError(fee, premium);
    if (problem) return setError(problem);
    void run('fees', async () => { await rpc('bill_transfer_fees', { p_request_id: request.id, p_fee: fee, p_premium: premium }); });
  };
  const approve = () => run('approve', async () => {
    await rpc('save_transfer_handover', { p_request_id: request.id, p_details: form });
    const res = await rpc('decide_request', { p_request_id: request.id, p_decision: 'approve', p_note: null }) as { invite_id?: string };
    // the buyer's invite goes by email when there is one; WhatsApp is offered once approved
    if (res?.invite_id && d.buyer_email) await notify('member_invite', res.invite_id);
  });

  return (
    <div className="space-y-2">
      <div className="text-slate-300 space-y-0.5">
        <div>Buyer: {d.buyer_name} · {formatMobile(d.buyer_mobile ?? '')}{d.buyer_email ? ` · ${d.buyer_email}` : ''}</div>
        <div>Sale deed dated {d.deed_date}{d.deed_number ? ` · registration No. ${d.deed_number}` : ''}</div>
        {feesBilled
          ? <div className="text-slate-400">Transfer fee {formatINR(d.fee ?? 0)} · premium {formatINR(d.premium ?? 0)}{d.fee_bill_id ? ' · billed to the flat' : ''}</div>
          : open && <div className="text-slate-400">Transfer fees not billed yet</div>}
        {open && dues !== null && (
          <div className={dues > 0 ? 'text-amber-300' : 'text-emerald-300'}>{dues > 0 ? `Flat dues today: ${formatINR(dues)}` : 'No dues on the flat'}</div>
        )}
        {request.status === 'approved' && (
          <div className="text-emerald-300">Transferred on {d.transfer_date}{d.share_certificate_no ? ` · share certificate ${d.share_certificate_no}` : ''}{d.endorsed_on ? `, endorsed ${d.endorsed_on}` : ''}</div>
        )}
      </div>
      <Banner tone="error">{error}</Banner>

      {request.status === 'approved' && d.invite_id && canDecide && (
        <a href={whatsappLink(inviteText({ societyName: societyName || 'Our society', inviteeName: d.buyer_name ?? '', role: 'Owner',
            email: d.buyer_email ?? null, mobile: d.buyer_mobile ?? null, flat: flatLabel, appUrl: typeof window !== 'undefined' ? window.location.origin : '' }), d.buyer_mobile ?? undefined)}
          target="_blank" rel="noreferrer" className="flex items-center gap-1 text-emerald-300"><Share2 className="w-4 h-4" /> Send the invite to {d.buyer_name} on WhatsApp</a>
      )}

      {canDecide && open && (
        <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
          <label className="flex items-center gap-1.5 text-slate-200">
            <input type="checkbox" checked={received} disabled={busy !== null}
              onChange={e => { const v = e.target.checked; void run('cert', async () => { await rpc('save_transfer_handover', { p_request_id: request.id, p_details: { certificate_received: v } }); }); }} />
            Original share certificate received
          </label>

          {!feesBilled && (
            <div className="space-y-1.5">
              <Banner tone="info">{TRANSFER_WARNING}</Banner>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-slate-400">Transfer fee (₹)<input type="number" min={0} max={100000} value={fees.fee} onChange={e => setFees({ ...fees, fee: e.target.value })} className={inputClass} /></label>
                <label className="text-slate-400">Transfer premium (₹)<input type="number" min={0} max={25000} value={fees.premium} onChange={e => setFees({ ...fees, premium: e.target.value })} className={inputClass} /></label>
              </div>
              <div className="text-slate-500">Many bye-laws charge no premium when the flat goes to a family member. Enter 0 for no charge.</div>
              <button onClick={billFees} disabled={busy !== null} className="px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold disabled:opacity-50 cursor-pointer">
                {busy === 'fees' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Bill transfer fees'}</button>
            </div>
          )}

          {request.status === 'submitted' && (
            <div className="space-y-1.5">
              <div className="grid sm:grid-cols-3 gap-2">
                <label className="text-slate-400">Share certificate No.<input value={form.share_certificate_no} maxLength={40} onChange={e => { certTouched.current = true; setForm({ ...form, share_certificate_no: e.target.value }); }} className={inputClass} /></label>
                <label className="text-slate-400">Endorsed on (blank: transfer date)<input type="date" value={form.endorsed_on} onChange={e => setForm({ ...form, endorsed_on: e.target.value })} className={inputClass} /></label>
                <label className="text-slate-400">Transfer date (blank: today)<input type="date" value={form.transfer_date} onChange={e => setForm({ ...form, transfer_date: e.target.value })} className={inputClass} /></label>
              </div>
              {missingDocs === 0 && blocker && <div className="text-amber-300">{blocker}</div>}
              <button onClick={async () => { if (await confirmDialog({ title: `Transfer flat ${flatLabel} to ${d.buyer_name}?`, body: 'The seller loses access and the buyer is invited.', confirmText: 'Approve transfer' })) void approve(); }}
                disabled={busy !== null || missingDocs > 0 || blocker !== null}
                className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold disabled:opacity-50 cursor-pointer">
                {busy === 'approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Approve transfer'}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
