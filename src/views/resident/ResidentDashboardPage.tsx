'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase/client';
import { Bill, Payment, Notice, Complaint, Unit, SocietySetting } from '../../types/database';
import { NotificationBell } from '../../components/NotificationBell';
import { EmptyState } from '../../components/EmptyState';
import { Link } from '../../router/RouterContext';
import { DocumentsVault } from '../../components/DocumentsVault';
import { ResidentTickets } from './ResidentTickets';
import { SponsoredCard } from '../../components/SponsoredCard';
import {
  Home,
  Receipt,
  BookOpen,
  FileText,
  MessageSquare,
  CheckCircle2,
  AlertCircle,
  FolderLock,
  Vote,
  IdCard,
  FileSignature,
  ClipboardPaste,
  QrCode,
  Menu,
  ChevronRight,
  X,
} from 'lucide-react';
import { formatINR } from '../../lib/inr';
import { Banner } from '../../components/Banner';
import { LogoMark } from '../../components/ui/Logo';
import { Button, IconButton, buttonClass } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Badge, StatusBadge, type BadgeTone } from '../../components/ui/Badge';
import { PageHeader } from '../../components/ui/PageHeader';
import { fieldClass } from '../../components/ui/Field';
import { cn } from '../../components/ui/cn';
import { SignOutMenu } from '../../components/SignOutMenu';
import { FlatStatement } from '../../components/FlatStatement';
import { PWAInstallButton } from '../../components/PWAInstallButton';
import { PollsList } from '../../components/PollsList';
import { StaffRegister } from '../../components/StaffRegister';
import { MyRequests } from '../../components/MyRequests';

const RESIDENT_TABS = ['overview', 'bills', 'account', 'notices', 'polls', 'staff', 'requests', 'complaints', 'documents'] as const;
type ResidentTab = typeof RESIDENT_TABS[number];

const TAB_META: Record<ResidentTab, { label: string; Icon: React.ComponentType<{ className?: string }>; ownerOnly?: boolean }> = {
  overview: { label: 'Home', Icon: Home },
  bills: { label: 'Bills', Icon: Receipt, ownerOnly: true },
  account: { label: 'My account', Icon: BookOpen, ownerOnly: true },
  notices: { label: 'Notices', Icon: FileText },
  complaints: { label: 'Complaints', Icon: MessageSquare },
  requests: { label: 'Requests', Icon: FileSignature },
  polls: { label: 'Polls', Icon: Vote },
  staff: { label: 'Staff', Icon: IdCard },
  documents: { label: 'Documents', Icon: FolderLock },
};

const fmtDate = (iso?: string | null) => (iso
  ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  : '');

const BILL_BADGE: Record<Bill['status'], { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  issued: { label: 'Due', tone: 'warning' },
  partially_paid: { label: 'Part paid', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
  overdue: { label: 'Overdue', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

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
    activeSociety,
    societyMemberships,
  } = useAuth();

  // The resident view is about flats: use memberships that carry a unit (a secretary who
  // also owns a flat has two memberships; one owner may have several flats)
  const flatMemberships = societyMemberships.filter(m => activeSociety && m.society_id === activeSociety.id && m.unit_id);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const unitId = (selectedUnitId && flatMemberships.some(m => m.unit_id === selectedUnitId))
    ? selectedUnitId
    : flatMemberships[0]?.unit_id ?? null;
  const [flatNumbers, setFlatNumbers] = useState<Record<string, string>>({});

  const [activeTab, setActiveTabState] = useState<ResidentTab>('overview');
  const [showMore, setShowMore] = useState(false);
  // the URL keeps your place: refresh, back and a shared link open this screen (brief section 7)
  const setActiveTab = useCallback((tab: ResidentTab) => {
    setActiveTabState(tab);
    setShowMore(false);
    const url = new URL(window.location.href);
    if (tab === 'overview') url.searchParams.delete('tab');
    else url.searchParams.set('tab', tab);
    window.history.replaceState(window.history.state, '', url);
  }, []);
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    if (wanted && (RESIDENT_TABS as readonly string[]).includes(wanted)) setActiveTabState(wanted as ResidentTab);
  }, []);
  // Tenants see no bills, dues or ledger (spec 10.2): owners pay
  const isOwner = flatMemberships.find(m => m.unit_id === unitId)?.role === 'resident_owner';
  // a flat switched to one they rent: leave the owner-only tabs
  useEffect(() => {
    if (!isOwner && (activeTab === 'bills' || activeTab === 'account')) setActiveTab('overview');
  }, [isOwner, activeTab, setActiveTab]);
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
        billsQuery.order('bill_date', { ascending: false }).order('created_at', { ascending: false }),
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

  // Phase 10: notices shown on the Notices screen are recorded as seen, once each (never blocks reading)
  const seenNotices = useRef(new Set<string>());
  useEffect(() => {
    if (activeTab !== 'notices' || !supabase) return;
    const fresh = societyNotices.map(n => n.id).filter(id => !seenNotices.current.has(id));
    if (fresh.length === 0) return;
    fresh.forEach(id => seenNotices.current.add(id));
    void supabase.rpc('mark_notices_seen', { p_notice_ids: fresh }).then(() => undefined, () => undefined);
  }, [activeTab, societyNotices]);

  const outstandingBills = myBills.filter(b => OUTSTANDING_STATUSES.includes(b.status));
  // the newest bill that still counts (not a cancelled one)
  const latestBill = myBills.find(b => b.status !== 'cancelled');
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
    const utr = utrNumber.replace(/\D/g, '');
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

  // the oldest unpaid due date leads (brief J1: "You owe ₹X, due 10 Dec")
  const nextDue = [...outstandingBills].sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
  const overdue = outstandingBills.some(b => b.status === 'overdue');
  const tabs = RESIDENT_TABS.filter(t => isOwner || !TAB_META[t].ownerOnly);
  const phoneBar: ResidentTab[] = isOwner ? ['overview', 'bills', 'notices', 'complaints'] : ['overview', 'notices', 'complaints', 'requests'];
  const roleLabel = flatMemberships.find(m => m.unit_id === unitId)?.role === 'resident_tenant' ? 'Tenant' : 'Owner';

  const pasteUtr = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setUtrNumber(text.replace(/\D/g, '').slice(0, 12));
    } catch {
      setPayError('Paste did not work on this phone: type the UTR instead.');
    }
  };

  const utrForm = (id: string) => (
    <form onSubmit={handleUtrSubmit} className="space-y-2.5">
      <label htmlFor={id} className="block text-sm font-semibold text-fg">Paid already? Enter the UTR</label>
      <div className="flex gap-2">
        <input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="12-digit UTR from your UPI app"
          value={utrNumber}
          onChange={e => setUtrNumber(e.target.value.replace(/[^\d\s-]/g, '').slice(0, 16))}
          className={cn(fieldClass, 'h-11 font-mono tracking-wide')}
        />
        <Button type="button" variant="secondary" className="h-11" onClick={pasteUtr} leftIcon={<ClipboardPaste className="w-4 h-4" />}>Paste</Button>
      </div>
      <Banner tone="error">{payError}</Banner>
      <Button type="submit" className="w-full h-11" loading={submittingUtr} disabled={utrNumber.replace(/\D/g, '').length !== 12}>
        Submit UTR
      </Button>
      <p className="text-xs text-fg-subtle">The treasurer matches it with the bank, then your receipt comes here.</p>
    </form>
  );

  return (
    <div className="min-h-screen bg-canvas text-fg text-sm pb-[calc(4.75rem+env(safe-area-inset-bottom))] md:pb-10">
      {/* Top bar */}
      <header className="sticky top-0 z-30 bg-surface/95 backdrop-blur-md border-b border-border print:hidden">
        <div className="max-w-2xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <LogoMark size={32} />
            <div className="min-w-0">
              <div className="text-[15px] font-semibold text-fg truncate">{activeSociety?.name || 'My society'}</div>
              {flatMemberships.length > 1 ? (
                <select
                  value={unitId ?? ''}
                  onChange={e => setSelectedUnitId(e.target.value)}
                  className="-ml-1 bg-transparent text-xs text-fg-muted outline-none cursor-pointer"
                  aria-label="Select flat"
                >
                  {flatMemberships.map(m => (
                    <option key={m.unit_id as string} value={m.unit_id as string}>
                      Flat {flatNumbers[m.unit_id as string] ?? '…'}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="text-xs text-fg-subtle truncate">
                  {myUnit ? `Flat ${myUnit.unit_number} · ${roleLabel}` : 'No flat linked yet: ask your secretary'}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {/* the installable app (spec: the PWA is the mobile app) */}
            <PWAInstallButton />
            <NotificationBell onOpen={(link) => {
              if (link === 'bills' || link === 'payments') setActiveTab(isOwner ? 'bills' : 'overview');
              else if (link === 'notices' || link === 'complaints' || link === 'polls' || link === 'requests') setActiveTab(link);
            }} />
            <SignOutMenu />
          </div>
        </div>
        {/* laptop: every screen as a tab row */}
        <nav aria-label="Resident" className="hidden md:block border-t border-border">
          <div className="max-w-2xl mx-auto px-2 flex gap-1 overflow-x-auto">
            {tabs.map(t => {
              const { label, Icon } = TAB_META[t];
              const on = activeTab === t;
              return (
                <button key={t} onClick={() => setActiveTab(t)} aria-current={on ? 'page' : undefined}
                  className={cn('flex items-center gap-1.5 px-3 h-11 border-b-2 text-sm whitespace-nowrap cursor-pointer',
                    on ? 'border-brand text-brand-ink font-semibold' : 'border-transparent text-fg-muted hover:text-fg')}>
                  <Icon className="w-4 h-4" /> {label}
                </button>
              );
            })}
          </div>
        </nav>
      </header>

      <main className="max-w-2xl mx-auto px-4 pt-5 space-y-4">
        {/* HOME */}
        {activeTab === 'overview' && (
          <>
            {isOwner && (
              <Card className="p-5 space-y-1 rounded-xl">
                {outstandingTotal > 0 ? (
                  <>
                    <div className="text-[13px] text-fg-muted">{payingBill ? `Bill ${payingBill.bill_number}` : `${outstandingBills.length} unpaid bills`}</div>
                    <div className="text-[34px] leading-[42px] font-semibold tracking-tight tabular-nums">{formatINR(outstandingTotal)}</div>
                    {nextDue && (
                      <Badge tone={overdue ? 'danger' : 'warning'} dot className="mt-1">
                        {overdue ? 'Overdue since' : 'Due'} {fmtDate(nextDue.due_date)}
                      </Badge>
                    )}
                    {/* one tap to the UPI app with the amount filled in (brief J1) */}
                    {upiLink ? (
                      <>
                        <a href={upiLink} className={buttonClass('primary', 'lg', 'w-full mt-4 md:hidden')}>Pay {formatINR(outstandingTotal)} via UPI</a>
                        <Button size="lg" className="w-full mt-4 hidden md:flex" onClick={() => setShowPayModal(true)} leftIcon={<QrCode className="w-5 h-5" />}>
                          Pay {formatINR(outstandingTotal)}: show UPI QR
                        </Button>
                        <button type="button" onClick={() => setShowPayModal(true)} className="w-full mt-2 text-xs text-fg-subtle md:hidden cursor-pointer">
                          Paying from another phone? <span className="text-brand font-medium">Show the QR code</span>
                        </button>
                      </>
                    ) : (
                      <Button size="lg" className="w-full mt-4" onClick={() => setShowPayModal(true)}>How to pay {formatINR(outstandingTotal)}</Button>
                    )}
                  </>
                ) : (
                  <div className="flex items-center gap-3">
                    <span className="w-11 h-11 rounded-full bg-success-soft text-success flex items-center justify-center shrink-0"><CheckCircle2 className="w-6 h-6" aria-hidden="true" /></span>
                    <div>
                      <div className="text-base font-semibold">All paid</div>
                      <div className="text-[13px] text-fg-muted">Nothing is due for flat {myUnit?.unit_number ?? ''}. Thank you.</div>
                    </div>
                  </div>
                )}
              </Card>
            )}

            {submittedUtrSuccess && (
              <div role="status" className="p-4 rounded-xl bg-success-soft border border-success/20 text-success flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 shrink-0 mt-px" aria-hidden="true" />
                <div className="text-[13px]">
                  <div className="font-semibold">Payment sent for verification</div>
                  UTR <span className="font-mono">{submittedUtrSuccess}</span> is with the treasurer. Your receipt appears below once it is verified.
                </div>
              </div>
            )}

            {isOwner && outstandingTotal > 0 && <Card className="p-4">{utrForm('utr')}</Card>}

            <div className="grid grid-cols-2 gap-3">
              <button type="button" onClick={() => setActiveTab('complaints')}
                className="flex flex-col items-start gap-2 p-4 min-h-11 rounded-xl bg-surface border border-border shadow-card text-left font-medium cursor-pointer hover:border-border-strong">
                <MessageSquare className="w-5 h-5 text-brand" aria-hidden="true" /> Raise a complaint
              </button>
              <button type="button" onClick={() => setActiveTab('requests')}
                className="flex flex-col items-start gap-2 p-4 min-h-11 rounded-xl bg-surface border border-border shadow-card text-left font-medium cursor-pointer hover:border-border-strong">
                <FileSignature className="w-5 h-5 text-brand" aria-hidden="true" /> Ask for an NOC
              </button>
            </div>

            {isOwner && latestBill && (
              <Link href={`/bill/${latestBill.id}`} className="flex items-center justify-between gap-3 p-4 rounded-xl bg-surface border border-border shadow-card hover:border-border-strong">
                <div className="min-w-0">
                  <div className="text-[13px] text-fg-muted">Latest bill · {latestBill.bill_number}</div>
                  <div className="font-semibold tabular-nums">{formatINR(Number(latestBill.total_amount))}</div>
                </div>
                <span className="text-[13px] font-medium text-brand">View bill →</span>
              </Link>
            )}

            {/* Payments (owners only: tenants see no money, spec 10.2) */}
            {isOwner && (
              <Card>
                <CardHeader title="My payments" />
                {myPayments.length === 0 && !loading ? (
                  <p className="px-5 py-4 text-fg-muted">No payments yet.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {myPayments.map(p => (
                      <li key={p.id} className="px-4 sm:px-5 py-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-semibold tabular-nums">{formatINR(Number(p.amount))}</div>
                          <div className="text-xs text-fg-subtle">UTR {p.transaction_reference_utr} · {fmtDate(p.payment_date)}</div>
                          {p.status === 'rejected' && p.verification_notes && <div className="text-xs text-danger mt-0.5">Rejected: {p.verification_notes}</div>}
                        </div>
                        <div className="text-right space-y-1 shrink-0">
                          <StatusBadge status={p.status === 'pending_verification' ? 'pending' : p.status} label={p.status === 'pending_verification' ? 'Being checked' : undefined} />
                          {p.status === 'verified' && <Link href={`/receipt/${p.id}`} className="block text-xs text-brand hover:underline">Receipt</Link>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}

            <Card>
              <CardHeader title="Notices" actions={<Button variant="link" size="sm" onClick={() => setActiveTab('notices')}>See all</Button>} />
              {societyNotices.length === 0 ? (
                <p className="px-5 py-4 text-fg-muted">Nothing new from the committee.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {societyNotices.slice(0, 2).map(n => (
                    <li key={n.id} className="px-4 sm:px-5 py-3 space-y-0.5">
                      <div className="font-semibold">{n.title}</div>
                      <div className="text-[13px] text-fg-muted line-clamp-2">{n.content}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {activeSociety && <SponsoredCard societyId={activeSociety.id} placement="home_feed" />}
          </>
        )}

        {activeTab === 'account' && isOwner && unitId && activeSociety && (
          <FlatStatement unitId={unitId} societyName={activeSociety.name} />
        )}

        {/* BILLS */}
        {activeTab === 'bills' && isOwner && (
          <div className="space-y-4">
            <PageHeader title="My bills" description={myUnit ? `Flat ${myUnit.unit_number}` : undefined} />
            {myBills.length === 0 && !loading ? (
              <EmptyState icon={Receipt} title="No bills yet" description="Your society has not issued a maintenance bill for your flat yet." />
            ) : (
              <Card>
                <ul className="divide-y divide-border">
                  {myBills.map(b => (
                    <li key={b.id}>
                      <Link href={`/bill/${b.id}`} className="px-4 sm:px-5 py-3.5 flex items-center justify-between gap-3 hover:bg-canvas">
                        <div className="min-w-0">
                          <div className="font-semibold">{b.bill_number}</div>
                          <div className="text-xs text-fg-subtle">Billed {fmtDate(b.bill_date)} · due {fmtDate(b.due_date)}</div>
                        </div>
                        <div className="text-right space-y-1 shrink-0">
                          <div className="font-semibold tabular-nums">{formatINR(Number(b.balance_due) > 0 ? Number(b.balance_due) : Number(b.total_amount))}</div>
                          <Badge tone={BILL_BADGE[b.status].tone} dot>{BILL_BADGE[b.status].label}</Badge>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )}

        {/* NOTICES */}
        {activeTab === 'notices' && (
          <div className="space-y-4">
            <PageHeader title="Notices" />
            {societyNotices.length === 0 && !loading ? (
              <EmptyState icon={FileText} title="No notices yet" description="Notices from your committee show up here, and you get a notification." />
            ) : (
              societyNotices.map(n => (
                <Card key={n.id} as="article" className="p-4 sm:p-5 space-y-1.5">
                  <div className="text-xs text-fg-subtle">{fmtDate(n.published_at)}</div>
                  <h3 className="text-base font-semibold">{n.title}</h3>
                  <p className="text-fg-muted leading-relaxed whitespace-pre-line">{n.content}</p>
                </Card>
              ))
            )}
            {activeSociety && <SponsoredCard societyId={activeSociety.id} placement="notices" />}
          </div>
        )}

        {/* COMPLAINTS */}
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

        {activeTab === 'documents' && activeSociety && (
          <DocumentsVault societyId={activeSociety.id} canManage={false} />
        )}

        {activeTab === 'staff' && activeSociety && (
          <StaffRegister societyId={activeSociety.id} isCommittee={false} canManage={false}
            myUnitIds={flatMemberships.map(m => m.unit_id).filter((u): u is string => Boolean(u))} />
        )}

        {activeTab === 'requests' && activeSociety && (
          <MyRequests societyId={activeSociety.id} userId={user?.id ?? ''}
            flats={flatMemberships.filter(m => m.unit_id).map(m => ({ unit_id: m.unit_id as string, role: m.role }))} />
        )}

        {activeTab === 'polls' && activeSociety && (
          <PollsList societyId={activeSociety.id} isCommittee={false} canManage={false} />
        )}
      </main>

      {/* Phone bottom bar */}
      <nav aria-label="Resident" className="md:hidden print:hidden fixed bottom-0 inset-x-0 z-30 bg-surface/95 backdrop-blur-md border-t border-border px-1 pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] grid grid-cols-5">
        {phoneBar.map(t => {
          const { label, Icon } = TAB_META[t];
          const on = activeTab === t && !showMore;
          return (
            <button key={t} onClick={() => setActiveTab(t)} aria-current={on ? 'page' : undefined}
              className={cn('min-h-12 flex flex-col items-center justify-center gap-0.5 text-xs cursor-pointer', on ? 'text-brand font-semibold' : 'text-fg-subtle font-medium')}>
              <Icon className="w-[22px] h-[22px]" />
              <span>{label}</span>
            </button>
          );
        })}
        <button onClick={() => setShowMore(v => !v)} aria-expanded={showMore}
          className={cn('min-h-12 flex flex-col items-center justify-center gap-0.5 text-xs cursor-pointer', showMore ? 'text-brand font-semibold' : 'text-fg-subtle font-medium')}>
          <Menu className="w-[22px] h-[22px]" />
          <span>More</span>
        </button>
      </nav>
      {showMore && (
        <div className="md:hidden fixed inset-0 z-20 bg-fg/40" onClick={() => setShowMore(false)}>
          <div role="dialog" aria-label="All screens" onClick={e => e.stopPropagation()}
            className="absolute bottom-[calc(3.75rem+env(safe-area-inset-bottom))] inset-x-0 rounded-t-2xl bg-surface border-t border-border shadow-pop px-3 pt-2 pb-3">
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-border-strong" aria-hidden="true" />
            {tabs.filter(t => !phoneBar.includes(t)).map(t => {
              const { label, Icon } = TAB_META[t];
              return (
                <button key={t} onClick={() => setActiveTab(t)}
                  className={cn('w-full min-h-12 flex items-center gap-3 px-3 rounded-lg text-left text-[15px] cursor-pointer',
                    activeTab === t ? 'bg-brand-soft text-brand-ink font-semibold' : 'text-fg font-medium active:bg-surface-muted')}>
                  <Icon className="w-5 h-5 text-fg-muted" />
                  <span className="flex-1">{label}</span>
                  <ChevronRight className="w-4 h-4 text-fg-subtle" />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Pay by QR (another phone, a laptop, or no UPI ID yet) */}
      {showPayModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-fg/40 p-0 sm:p-4" onClick={() => setShowPayModal(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="pay-title" onClick={e => e.stopPropagation()}
            className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl bg-surface p-5 sm:p-6 shadow-pop space-y-4 max-h-[92vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 id="pay-title" className="text-base font-semibold">Pay {formatINR(outstandingTotal)} by UPI</h3>
                <p className="text-[13px] text-fg-muted">Scan with GPay, PhonePe, Paytm or BHIM, then enter the 12-digit UTR.</p>
              </div>
              <IconButton variant="ghost" label="Close" onClick={() => setShowPayModal(false)} className="-mr-2 -mt-1"><X className="w-5 h-5" /></IconButton>
            </div>

            {upiLink ? (
              <div className="palette-native p-4 bg-surface rounded-xl border border-border flex flex-col items-center justify-center gap-1">
                <QRCodeSVG value={upiLink} size={176} />
                <span className="font-mono text-xs text-fg-subtle font-semibold mt-2">{societySettings?.upi_id}</span>
                <span className="text-xs text-fg-subtle">{societySettings?.upi_payee_name} · {formatINR(outstandingTotal)}</span>
              </div>
            ) : (
              <div className="p-3 rounded-lg bg-warning-soft text-warning text-[13px] flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                <span>Your society has not added its UPI ID yet. Pay the way your treasurer shared, then enter the UTR below.</span>
              </div>
            )}
            {utrForm('utr-qr')}
          </div>
        </div>
      )}
    </div>
  );
};
