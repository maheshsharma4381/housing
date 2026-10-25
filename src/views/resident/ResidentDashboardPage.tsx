'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase/client';
import { Bill, Payment, Notice, Complaint, Unit, SocietySetting } from '../../types/database';
import { EmptyState } from '../../components/EmptyState';
import { Link } from '../../router/RouterContext';
import { DocumentsVault } from '../../components/DocumentsVault';
import { ResidentTickets } from './ResidentTickets';
import { SponsoredCard } from '../../components/SponsoredCard';
import {
  Home,
  Receipt,
  FileText,
  MessageSquare,
  LogOut,
  CheckCircle2,
  AlertCircle,
  FolderLock,
} from 'lucide-react';

const OUTSTANDING_STATUSES: Bill['status'][] = ['issued', 'partially_paid', 'overdue'];
const UTR_PATTERN = /^\d{12}$/;

function buildUpiLink(settings: Pick<SocietySetting, 'upi_id' | 'upi_payee_name'>, amount: number, note: string) {
  const params = new URLSearchParams({
    pa: settings.upi_id || '',
    pn: settings.upi_payee_name || '',
    am: amount.toFixed(2),
    cu: 'INR',
    tn: note,
  });
  return `upi://pay?${params.toString()}`;
}

export const ResidentDashboardPage: React.FC = () => {
  const {
    user,
    profile,
    activeSociety,
    societyMemberships,
    logout
  } = useAuth();

  // The resident view is about flats: use memberships that carry a unit (a secretary who
  // also owns a flat has two memberships; one owner may have several flats)
  const flatMemberships = societyMemberships.filter(m => activeSociety && m.society_id === activeSociety.id && m.unit_id);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const unitId = (selectedUnitId && flatMemberships.some(m => m.unit_id === selectedUnitId))
    ? selectedUnitId
    : flatMemberships[0]?.unit_id ?? null;
  const [flatNumbers, setFlatNumbers] = useState<Record<string, string>>({});

  const [activeTab, setActiveTab] = useState<'overview' | 'bills' | 'notices' | 'complaints' | 'documents' | 'profile'>('overview');
  const [myBills, setMyBills] = useState<Bill[]>([]);
  const [myPayments, setMyPayments] = useState<Payment[]>([]);
  const [societyNotices, setSocietyNotices] = useState<Notice[]>([]);
  const [myComplaints, setMyComplaints] = useState<Complaint[]>([]);
  const [myUnit, setMyUnit] = useState<Unit | null>(null);
  const [societySettings, setSocietySettings] = useState<SocietySetting | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Modal for submitting UPI reference
  const [showPayModal, setShowPayModal] = useState(false);
  const [utrNumber, setUtrNumber] = useState('');
  const [submittingUtr, setSubmittingUtr] = useState(false);
  const [submittedUtrSuccess, setSubmittedUtrSuccess] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);

  // Fetch strictly this resident's data (RLS enforced)
  const loadResidentData = useCallback(async () => {
    if (!user || !activeSociety || !supabase) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      // 1. Fetch the resident's flats (for the selector) and the selected one
      const unitIds = flatMemberships.map(m => m.unit_id as string);
      if (unitIds.length > 0) {
        const { data: unitRows } = await supabase.from('units').select('*').in('id', unitIds);
        const rows = (unitRows ?? []) as Unit[];
        setFlatNumbers(Object.fromEntries(rows.map(u => [u.id, u.unit_number])));
        setMyUnit(rows.find(u => u.id === unitId) ?? null);
      } else {
        setMyUnit(null);
      }

      // 2. Fetch the resident's bills and payments for the selected flat (RLS also enforces user_id)
      let billsQuery = supabase.from('bills').select('*').eq('society_id', activeSociety.id).eq('user_id', user.id);
      let paymentsQuery = supabase.from('payments').select('*').eq('society_id', activeSociety.id).eq('user_id', user.id);
      if (unitId) {
        billsQuery = billsQuery.eq('unit_id', unitId);
        paymentsQuery = paymentsQuery.eq('unit_id', unitId);
      }
      const [bRes, pRes, nRes, cRes, sRes] = await Promise.all([
        billsQuery.order('bill_date', { ascending: false }),
        paymentsQuery.order('payment_date', { ascending: false }),
        supabase.from('notices').select('*').eq('society_id', activeSociety.id).order('published_at', { ascending: false }),
        supabase.from('complaints').select('*').eq('society_id', activeSociety.id).eq('user_id', user.id).order('created_at', { ascending: false }),
        supabase.from('society_settings').select('*').eq('society_id', activeSociety.id).maybeSingle(),
      ]);

      if (bRes.data) setMyBills(bRes.data);
      if (pRes.data) setMyPayments(pRes.data);
      if (nRes.data) setSocietyNotices(nRes.data);
      if (cRes.data) setMyComplaints(cRes.data);
      setSocietySettings(sRes.data ?? null);
    } catch (err) {
      console.warn('Error loading resident records:', err);
    } finally {
      setLoading(false);
    }
    // flatMemberships is derived from context each render; its unit ids are what matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, activeSociety, unitId, flatMemberships.map(m => m.unit_id).join(',')]);

  useEffect(() => {
    loadResidentData();
  }, [loadResidentData]);

  const outstandingBills = myBills.filter(b => OUTSTANDING_STATUSES.includes(b.status));
  const outstandingTotal = outstandingBills.reduce((sum, b) => sum + (Number(b.balance_due) || 0), 0);
  // Link the payment to a bill only when it settles exactly one outstanding bill
  const payingBill = outstandingBills.length === 1 ? outstandingBills[0] : null;
  const upiReady = Boolean(societySettings?.upi_id);
  const upiLink = upiReady && societySettings
    ? buildUpiLink(societySettings, outstandingTotal, payingBill ? `Bill ${payingBill.bill_number}` : `Maintenance ${myUnit?.unit_number ?? ''}`.trim())
    : null;

  const handleUtrSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPayError(null);
    const utr = utrNumber.trim();
    if (!user || !activeSociety || !supabase) return;

    if (!unitId) {
      setPayError('Your membership is not linked to a flat yet. Please ask the society secretary to link your unit.');
      return;
    }
    if (!UTR_PATTERN.test(utr)) {
      setPayError('UTR must be exactly 12 digits.');
      return;
    }
    if (outstandingTotal <= 0) {
      setPayError('There is no outstanding amount to pay.');
      return;
    }

    setSubmittingUtr(true);
    try {
      const { error } = await supabase.from('payments').insert({
        society_id: activeSociety.id,
        user_id: user.id,
        unit_id: unitId,
        bill_id: payingBill?.id ?? null,
        payment_number: `PAY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        amount: outstandingTotal,
        payment_method: 'upi',
        transaction_reference_utr: utr,
        payment_date: new Date().toISOString().split('T')[0],
        status: 'pending_verification',
      });

      if (error) {
        setPayError(
          error.code === '23505'
            ? 'This UTR has already been submitted. Check your payment history below.'
            : `Could not record payment: ${error.message}`
        );
        return;
      }

      setSubmittedUtrSuccess(utr);
      setShowPayModal(false);
      setUtrNumber('');
      loadResidentData();
    } catch (err) {
      setPayError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingUtr(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 pb-20 md:pb-8">
      {/* Mobile Top Header */}
      <div className="bg-slate-900 border-b border-slate-800 px-4 py-4">
        <div className="max-w-md mx-auto flex items-center justify-between">
          <div>
            <div className="text-[11px] font-semibold text-sky-400 uppercase tracking-wide">
              {activeSociety?.name || 'Resident Portal'}
            </div>
            <h1 className="text-base font-bold text-white mt-0.5">
              {profile?.full_name}
            </h1>
            {flatMemberships.length > 1 ? (
              <select
                value={unitId ?? ''}
                onChange={e => setSelectedUnitId(e.target.value)}
                className="mt-0.5 bg-slate-950 border border-slate-700 rounded-lg px-2 py-0.5 text-[11px] text-white outline-none"
                aria-label="Select flat"
              >
                {flatMemberships.map(m => (
                  <option key={m.unit_id as string} value={m.unit_id as string}>
                    Flat {flatNumbers[m.unit_id as string] ?? '…'}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-[11px] text-slate-400">
                {myUnit ? `Flat ${myUnit.unit_number} (${myUnit.unit_type})` : 'No flat linked yet — ask your secretary'}
              </div>
            )}
          </div>

          <button
            onClick={() => logout()}
            className="p-2 rounded-xl bg-slate-800 text-slate-300 hover:text-rose-400 cursor-pointer"
            title="Sign Out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Resident Container */}
      <div className="max-w-md mx-auto px-4 mt-6 space-y-6">
        {/* Outstanding Banner */}
        <div className="p-5 rounded-3xl bg-gradient-to-br from-sky-600 to-sky-800 text-white shadow-xl shadow-sky-900/30 flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-sky-200">Current Outstanding Due</div>
            <div className="text-2xl font-black mt-0.5">
              ₹{outstandingTotal.toLocaleString('en-IN')}
            </div>
            <div className="text-[11px] text-sky-200 mt-1">
              Flat {myUnit?.unit_number || 'Unit'}
            </div>
          </div>

          {outstandingTotal > 0 ? (
            <button
              onClick={() => setShowPayModal(true)}
              className="px-4 py-2.5 rounded-xl bg-white text-sky-950 font-bold text-xs shadow-md active:scale-95 transition cursor-pointer"
            >
              Pay via UPI
            </button>
          ) : (
            <span className="px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-200 text-xs font-semibold flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> All Clear
            </span>
          )}
        </div>

        {submittedUtrSuccess && (
          <div className="p-3.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300 flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-white">Payment Submission Recorded!</span>
              <p className="mt-0.5 text-emerald-300">
                UTR <strong className="font-mono text-white">{submittedUtrSuccess}</strong> submitted to society treasurer for bank statement reconciliation.
              </p>
            </div>
          </div>
        )}

        {/* Navigation Tabs */}
        <div className="grid grid-cols-5 gap-2 text-center text-xs">
          <button
            onClick={() => setActiveTab('overview')}
            className={`p-2.5 rounded-xl border transition cursor-pointer ${
              activeTab === 'overview' 
                ? 'bg-sky-600/20 border-sky-500 text-sky-400 font-bold' 
                : 'bg-slate-900 border-slate-800 text-slate-400'
            }`}
          >
            <Home className="w-4 h-4 mx-auto mb-1" />
            <span>Home</span>
          </button>

          <button
            onClick={() => setActiveTab('bills')}
            className={`p-2.5 rounded-xl border transition cursor-pointer ${
              activeTab === 'bills' 
                ? 'bg-sky-600/20 border-sky-500 text-sky-400 font-bold' 
                : 'bg-slate-900 border-slate-800 text-slate-400'
            }`}
          >
            <Receipt className="w-4 h-4 mx-auto mb-1" />
            <span>Bills</span>
          </button>

          <button
            onClick={() => setActiveTab('notices')}
            className={`p-2.5 rounded-xl border transition cursor-pointer ${
              activeTab === 'notices' 
                ? 'bg-sky-600/20 border-sky-500 text-sky-400 font-bold' 
                : 'bg-slate-900 border-slate-800 text-slate-400'
            }`}
          >
            <FileText className="w-4 h-4 mx-auto mb-1" />
            <span>Notices</span>
          </button>

          <button
            onClick={() => setActiveTab('complaints')}
            className={`p-2.5 rounded-xl border transition cursor-pointer ${
              activeTab === 'complaints' 
                ? 'bg-sky-600/20 border-sky-500 text-sky-400 font-bold' 
                : 'bg-slate-900 border-slate-800 text-slate-400'
            }`}
          >
            <MessageSquare className="w-4 h-4 mx-auto mb-1" />
            <span>Tickets</span>
          </button>

          <button
            onClick={() => setActiveTab('documents')}
            className={`p-2.5 rounded-xl border transition cursor-pointer ${
              activeTab === 'documents'
                ? 'bg-sky-600/20 border-sky-500 text-sky-400 font-bold'
                : 'bg-slate-900 border-slate-800 text-slate-400'
            }`}
          >
            <FolderLock className="w-4 h-4 mx-auto mb-1" />
            <span>Docs</span>
          </button>
        </div>

        {/* TAB 1: OVERVIEW */}
        {activeTab === 'overview' && (
          <div className="space-y-4">
            {/* Account History / Payments */}
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-3 text-xs">
              <h3 className="font-bold text-white text-sm">Account Payment History</h3>
              {myPayments.length === 0 && !loading ? (
                <p className="text-slate-400 text-xs">No payment records found.</p>
              ) : (
                <div className="space-y-2">
                  {myPayments.map(p => (
                    <div key={p.id} className="p-3 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between">
                      <div>
                        <div className="font-bold text-white">₹{Number(p.amount).toLocaleString('en-IN')}</div>
                        <div className="text-[11px] font-mono text-slate-400">UTR: {p.transaction_reference_utr}</div>
                        <div className="text-[10px] text-slate-500">{p.payment_date}</div>
                        {p.status === 'rejected' && p.verification_notes && (
                          <div className="text-[11px] text-rose-300 mt-0.5">Rejected: {p.verification_notes}</div>
                        )}
                      </div>
                      <div className="text-right space-y-1">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold ${
                          p.status === 'verified' ? 'bg-emerald-500/10 text-emerald-400'
                            : p.status === 'rejected' ? 'bg-rose-500/10 text-rose-300'
                            : 'bg-amber-500/10 text-amber-300'
                        }`}>
                          {p.status.replace('_', ' ')}
                        </span>
                        {p.status === 'verified' && (
                          <Link href={`/receipt/${p.id}`} className="block text-[11px] text-sky-400 hover:underline">
                            View receipt
                          </Link>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Circulars snippet */}
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-3 text-xs">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-white text-sm">Society Circulars</h3>
                <button onClick={() => setActiveTab('notices')} className="text-xs text-sky-400">
                  View all
                </button>
              </div>
              {societyNotices.slice(0, 2).map(n => (
                <div key={n.id} className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                  <div className="font-bold text-white">{n.title}</div>
                  <div className="text-slate-400 line-clamp-2">{n.content}</div>
                </div>
              ))}
              {activeSociety && <SponsoredCard societyId={activeSociety.id} placement="home_feed" />}
            </div>
          </div>
        )}

        {/* TAB 2: BILLS */}
        {activeTab === 'bills' && (
          <div className="space-y-3 text-xs">
            <h2 className="text-base font-bold text-white">My Maintenance Bills</h2>
            {myBills.length === 0 && !loading ? (
              <EmptyState
                icon={Receipt}
                title="No Bills Issued"
                description="There are currently no maintenance bills issued for your unit."
              />
            ) : (
              myBills.map(b => (
                <div key={b.id} className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-slate-400">{b.bill_number}</span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold bg-slate-800 text-slate-300">
                      {b.status}
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline pt-1">
                    <div>
                      <div className="text-slate-400">Bill Date: {b.bill_date}</div>
                      <div className="font-bold text-white text-sm">Total: ₹{Number(b.total_amount).toLocaleString('en-IN')}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-slate-400">Due: {b.due_date}</div>
                      <div className="font-bold text-sky-400 text-sm">Balance: ₹{Number(b.balance_due).toLocaleString('en-IN')}</div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* TAB 3: NOTICES */}
        {activeTab === 'notices' && (
          <div className="space-y-3 text-xs">
            <h2 className="text-base font-bold text-white">Society Notices & Circulars</h2>
            {societyNotices.length === 0 && !loading ? (
              <EmptyState
                icon={FileText}
                title="Notice Board Empty"
                description="No notices have been published by the managing committee yet."
              />
            ) : (
              societyNotices.map(n => (
                <div key={n.id} className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-1.5">
                  <div className="text-[10px] text-slate-400 font-mono">{new Date(n.published_at).toLocaleDateString()}</div>
                  <h4 className="font-bold text-white text-sm">{n.title}</h4>
                  <p className="text-slate-300 leading-relaxed">{n.content}</p>
                </div>
              ))
            )}
            {activeSociety && <SponsoredCard societyId={activeSociety.id} placement="notices" />}
          </div>
        )}

        {/* TAB 4: COMPLAINTS */}
        {activeTab === 'complaints' && activeSociety && (
          <ResidentTickets
            societyId={activeSociety.id}
            unitId={unitId}
            userId={user?.id}
            complaints={myComplaints}
            loading={loading}
            onChanged={loadResidentData}
          />
        )}

        {/* TAB 5: DOCUMENTS */}
        {activeTab === 'documents' && activeSociety && (
          <DocumentsVault societyId={activeSociety.id} canManage={false} />
        )}
      </div>

      {/* Pay via UPI Modal */}
      {showPayModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs">
          <div className="w-full max-w-sm rounded-2xl bg-slate-900 p-6 border border-slate-800 text-xs text-slate-200 shadow-2xl space-y-4">
            <h3 className="text-base font-bold text-white">Society UPI Payment</h3>
            <p className="text-slate-400">
              Scan with GPay, PhonePe, Paytm or BHIM, then enter the 12-digit UTR reference below.
            </p>

            {upiLink ? (
              <div className="p-3 bg-white rounded-xl text-slate-950 flex flex-col items-center justify-center gap-1">
                <QRCodeSVG value={upiLink} size={160} />
                <span className="font-mono text-[11px] text-slate-800 font-bold mt-1">
                  {societySettings?.upi_id}
                </span>
                <span className="text-[11px] text-slate-600">
                  {societySettings?.upi_payee_name} • ₹{outstandingTotal.toLocaleString('en-IN')}
                </span>
                <a href={upiLink} className="mt-1 text-[11px] font-semibold text-sky-700 underline sm:hidden">
                  Open in UPI app
                </a>
              </div>
            ) : (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>Your society has not configured its UPI ID yet. Please pay via the method shared by the treasurer and enter the UTR below.</span>
              </div>
            )}

            {payError && (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{payError}</span>
              </div>
            )}

            <form onSubmit={handleUtrSubmit} className="space-y-3">
              <div>
                <label className="block text-slate-400 mb-1">Enter 12-digit UPI UTR / Reference</label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={12}
                  required
                  placeholder="e.g. 625219401292"
                  value={utrNumber}
                  onChange={(e) => setUtrNumber(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white font-mono outline-none focus:border-sky-500"
                />
              </div>

              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={submittingUtr}
                  className="flex-1 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold cursor-pointer disabled:opacity-50"
                >
                  {submittingUtr ? 'Recording...' : 'Submit UTR for Verification'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowPayModal(false)}
                  className="px-3 py-2.5 rounded-xl bg-slate-800 text-slate-300 font-medium cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
