'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth, COMMITTEE_ROLES } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase/client';
import { contactText } from '../../lib/mobile';
import { WorkspaceSelector } from '../../components/WorkspaceSelector';
import { EmptyState } from '../../components/EmptyState';
import { UnitsTab } from './tabs/UnitsTab';
import { MembersTab } from './tabs/MembersTab';
import { SettingsTab } from './tabs/SettingsTab';
import { BillingTab } from './tabs/BillingTab';
import { PaymentsTab } from './tabs/PaymentsTab';
import { FinancialReports } from '../../components/FinancialReports';
import { DocumentsVault } from '../../components/DocumentsVault';
import { NoticesTab } from './tabs/NoticesTab';
import { ComplaintsTab } from './tabs/ComplaintsTab';
import { ExpensesTab } from './tabs/ExpensesTab';
import { ProfessionalsTab } from './tabs/ProfessionalsTab';
import { AssetRegister } from '../../components/AssetRegister';
import { BankReconciliation } from '../../components/BankReconciliation';
import { AdjustmentsPanel } from '../../components/AdjustmentsPanel';
import { OpeningBalanceReview } from '../../components/OpeningBalanceReview';
import { JoinRequests } from '../../components/JoinRequests';
import { NotificationBell } from '../../components/NotificationBell';
import { OpeningBalanceEditor } from '../../components/OpeningBalanceEditor';
import { ChartOfAccounts } from '../../components/ChartOfAccounts';
import { PartyLedgers } from '../../components/PartyLedgers';
import { BillTypes } from '../../components/BillTypes';
import { societyNav, societyTabFor, GROUP_LABELS, PHONE_BAR, type SocietyTab } from '../../lib/society-nav';
import { HomeCards } from '../../components/HomeCards';
import { PollsList } from '../../components/PollsList';
import { StaffRegister } from '../../components/StaffRegister';
import { FlatRequests, RequestsWaiting } from '../../components/FlatRequests';
import { PendingVendorBills } from '../../components/PendingVendorBills';
import { PriorYearEditor } from '../../components/PriorYearEditor';
import { YearLockPanel } from '../../components/YearLockPanel';
import { FeatureGate, PlanBilling } from '../../components/PlanBilling';
import { daysUntil, featurePlan } from '../../lib/billing';
import {
  Unit,
  Bill,
  Expense,
  Notice,
  Complaint,
  SocietyPlan,
} from '../../types/database';
import {
  Home,
  Users,
  Building2,
  CreditCard,
  Receipt,
  Landmark,
  FolderLock,
  FileText,
  MessageSquare,
  Briefcase,
  BarChart3,
  Settings,
  LogOut,
  RefreshCw,
  QrCode,
  ChevronRight,
  Menu,
  Boxes,
  Scale,
  Gem,
  ListChecks,
  ListTree,
  Tags,
  BookOpen,
  Vote,
  IdCard,
  FileSignature,
  Plus,
} from 'lucide-react';
import { SignOutMenu, LogoutEverywhereButton } from '../../components/SignOutMenu';
import { nextSetupStep, type SetupStatus } from '../../lib/setup';
import { PWAInstallButton } from '../../components/PWAInstallButton';
import { Logo, LogoMark } from '../../components/ui/Logo';
import { Button, IconButton, buttonClass } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { PageHeader } from '../../components/ui/PageHeader';
import { cn } from '../../components/ui/cn';

type Tab = SocietyTab;

const ICONS: Record<SocietyTab, React.ComponentType<{ className?: string }>> = {
  home: Home, approvals: ListChecks, flats: Building2, members: Users, billing: CreditCard, payments: QrCode,
  expenses: Receipt, documents: FolderLock, notices: FileText, polls: Vote, staff: IdCard, requests: FileSignature, complaints: MessageSquare, professionals: Briefcase,
  reports: BarChart3, settings: Settings, plan: Gem,
  ledgers: ListTree, billtypes: Tags, opening: BookOpen, assets: Boxes, bank: Landmark, audit: Scale,
};

// List screens fetch the latest N rows; totals come from society_summary() (no API row cap)
const LIST_LIMIT = 500;

/** Writes ?tab= without a navigation; Home is the bare /society. */
function writeTabToUrl(tab: string) {
  const url = new URL(window.location.href);
  if (tab === 'home') url.searchParams.delete('tab');
  else url.searchParams.set('tab', tab);
  window.history.replaceState(window.history.state, '', url);
}

const SETUP_LABELS: Record<string, string> = {
  society: 'add the society details', flats: 'add your flats', maintenance: 'set the maintenance charge',
  upi: "add the society's UPI ID so residents can pay", owners: 'add flat owners',
};

const initials = (name?: string | null) => (name ?? '').trim().split(/\s+/).slice(0, 2).map(w => w[0] ?? '').join('') || 'Me';

const PHONE_LABELS: Partial<Record<SocietyTab, string>> = { home: 'Home', billing: 'Bills', payments: 'Payments', complaints: 'Complaints' };

/** "Good morning" by the device clock; set after mount so the server render does not guess the hour. */
function useGreeting() {
  const [g, setG] = useState<{ hello: string; today: string }>({ hello: 'Welcome back', today: '' });
  useEffect(() => {
    const now = new Date();
    const h = now.getHours();
    setG({
      hello: h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening',
      today: now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }),
    });
  }, []);
  return g;
}

interface SocietySummary {
  units: number; members: number; billed: number; collected: number; outstanding: number; overdue_flats: number;
  bills: number; pending_payments: number; pending_expenses: number; open_complaints: number; upi_configured: boolean | null;
}

export const SocietyDashboardPage: React.FC = () => {
  const {
    user,
    profile,
    activeSociety,
    societyMemberships,
    professionalGrants,
    logout,
    refreshUserData,
  } = useAuth();
  // more than one society or CA workspace: the phone bar keeps the switcher
  const manyWorkspaces = new Set(societyMemberships.map(m => m.society_id)).size + professionalGrants.length > 1;

  // A secretary who also owns a flat has two memberships: show the committee one here
  const committeeMembership = societyMemberships.find(m => activeSociety && m.society_id === activeSociety.id && COMMITTEE_ROLES.includes(m.role));
  const roleName = committeeMembership?.role?.replace('_', ' ') || 'Member';
  const readOnly = committeeMembership?.role === 'committee_member';
  // Phase 2D: the Accountant keeps the books, so the accounting screens appear only for them
  const isAccountant = Boolean(committeeMembership?.is_accountant);
  const NAV_ITEMS = societyNav({ isAccountant }).map(item => ({ ...item, icon: ICONS[item.id] }));

  const [activeTab, setActiveTab] = useState<Tab>('home');
  const greeting = useGreeting();
  // Flats & residents (spec 9.3): flats, members and owner change on one screen
  const [flatsView, setFlatsView] = useState<'flats' | 'members'>('flats');
  const [showMore, setShowMore] = useState(false);

  const [units, setUnits] = useState<Unit[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [summary, setSummary] = useState<SocietySummary | null>(null);
  const [plan, setPlan] = useState<SocietyPlan | null>(null);
  const [approvalsCount, setApprovalsCount] = useState(0);
  const [loading, setLoading] = useState<boolean>(true);

  // Fetch real records for the active society
  const loadSocietyData = useCallback(async () => {
    if (!activeSociety || !supabase) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const [uRes, bRes, eRes, nRes, cRes, sRes, aRes, oRes, jRes] = await Promise.all([
        supabase.from('units').select('*').eq('society_id', activeSociety.id).order('unit_number').limit(1000),
        supabase.from('bills').select('*').eq('society_id', activeSociety.id).order('bill_date', { ascending: false }).limit(LIST_LIMIT),
        supabase.from('expenses').select('*').eq('society_id', activeSociety.id).order('created_at', { ascending: false }).limit(LIST_LIMIT),
        supabase.from('notices').select('*').eq('society_id', activeSociety.id).order('published_at', { ascending: false }).limit(200),
        supabase.from('complaints').select('*').eq('society_id', activeSociety.id).order('created_at', { ascending: false }).limit(LIST_LIMIT),
        supabase.rpc('society_summary', { p_society_id: activeSociety.id }),
        // Approvals: CA adjustments waiting, and the opening balance once the CA submits it
        supabase.from('adjustment_proposals').select('id', { count: 'exact', head: true }).eq('society_id', activeSociety.id).eq('status', 'pending'),
        supabase.from('opening_balances').select('status').eq('society_id', activeSociety.id).maybeSingle(),
        // ...and people who asked to join through the joining link (031)
        supabase.from('join_requests').select('id', { count: 'exact', head: true }).eq('society_id', activeSociety.id).eq('status', 'pending'),
      ]);

      if (uRes.data) setUnits(uRes.data);
      if (bRes.data) setBills(bRes.data);
      if (eRes.data) setExpenses(eRes.data);
      if (nRes.data) setNotices(nRes.data);
      if (cRes.data) setComplaints(cRes.data);
      setSummary((sRes.data as SocietySummary) ?? null);
      setApprovalsCount((aRes.count ?? 0) + (jRes.count ?? 0) + (oRes.data?.status === 'submitted' ? 1 : 0));
    } catch (err) {
      console.warn('Error querying society records:', err);
    } finally {
      setLoading(false);
    }
  }, [activeSociety]);

  useEffect(() => {
    loadSocietyData();
  }, [loadSocietyData]);

  const loadPlan = useCallback(async () => {
    if (!supabase || !activeSociety) return setPlan(null);
    const { data } = await supabase.rpc('society_plan', { p_society_id: activeSociety.id });
    setPlan((data as SocietyPlan | null) ?? null);
  }, [activeSociety]);

  useEffect(() => {
    loadPlan();
  }, [loadPlan]);

  const trialLeft = plan?.in_trial && plan.plan_code === 'trial' ? daysUntil(plan.trial_ends_on) : null;
  const planBanner = !plan ? null
    : plan.status === 'past_due' ? { tone: 'rose', text: `Sahvaas renewal is unpaid — the society moves to the Free plan on ${plan.open_invoice?.moves_to_free_on ?? 'soon'}.` }
    : trialLeft != null && trialLeft <= 7 ? { tone: 'sky', text: `Free trial ends in ${trialLeft} day${trialLeft === 1 ? '' : 's'}. After that you move to Free: residents see a few local offers and Pro tools (GSTR-2B, TDS register, bank statement match, Tally export) lock. Choose Basic to stay ad-free, or Pro to keep them.` }
    : !plan.in_trial && plan.paid_plan_code === 'free' ? { tone: 'amber', text: 'You are on the Free plan — residents see a few local offers. Choose Basic to remove them.' }
    : null;

  const goTo = (tab: Tab) => {
    // "members" is a part of Flats & residents now
    // the menu's Flats & residents opens on Flats; a members link opens Members
    if (tab === 'members') setFlatsView('members');
    else if (tab === 'flats') setFlatsView('flats');
    setActiveTab(tab === 'members' ? 'flats' : tab);
    setShowMore(false);
    // the URL keeps your place: refresh, back and a shared link open this screen (brief section 7)
    writeTabToUrl(tab);
  };

  const showFlatsView = (v: 'flats' | 'members') => {
    setFlatsView(v);
    writeTabToUrl(v);
  };

  // A notification's link names a screen; residents' "bills" is the committee's Maintenance Billing
  const openFromNotification = (link: string) => {
    if (link === 'members') return goTo('members');
    const tab = societyTabFor(link);
    if (NAV_ITEMS.some(item => item.id === tab)) goTo(tab);
  };

  // An old link to an accounting screen goes home for anyone who is not the Accountant
  useEffect(() => {
    if (!NAV_ITEMS.some(item => item.id === activeTab)) setActiveTab('home');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAccountant, activeTab]);

  // A link such as /society?tab=members (from the setup wizard) opens that screen
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    if (wanted === 'members') goTo('members');
    else if (wanted && NAV_ITEMS.some(item => item.id === societyTabFor(wanted))) setActiveTab(societyTabFor(wanted));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What the setup wizard still has to do (034): the same rule the wizard resumes by
  const [setupNext, setSetupNext] = useState<string | null>(null);
  useEffect(() => {
    if (!supabase || !activeSociety || readOnly) return;
    supabase.rpc('setup_status', { p_society_id: activeSociety.id }).then(({ data }) => {
      if (!data) return;
      const next = nextSetupStep(data as SetupStatus);
      setSetupNext(next === 'done' ? null : next);
    });
  }, [activeSociety, readOnly, units.length]);

  const pendingApprovalCount = summary?.pending_expenses ?? expenses.filter(e => e.status === 'pending_approval').length;
  const pendingPayments = summary?.pending_payments ?? 0;

  const approvalsBadge = approvalsCount + pendingApprovalCount;
  const badgeFor = (id: Tab) => id === 'approvals' ? approvalsBadge : id === 'expenses' ? pendingApprovalCount : id === 'payments' ? pendingPayments : 0;
  const activeLabel = NAV_ITEMS.find(i => i.id === activeTab)?.label ?? 'Home';

  return (
    <div className="min-h-screen bg-canvas text-fg flex flex-col md:flex-row pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-0 text-sm">
      {/* Phone top bar */}
      <div className="md:hidden sticky top-0 z-30 bg-surface/95 backdrop-blur-md px-4 py-2.5 border-b border-border flex items-center justify-between gap-3 print:hidden">
        <div className="flex items-center gap-2.5 min-w-0">
          <LogoMark size={32} />
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-fg truncate">{activeSociety?.name || 'Society'}</div>
            <div className="text-xs text-fg-subtle capitalize truncate">{roleName}</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {/* the installable app (spec: the PWA is the mobile app) */}
          <PWAInstallButton />
          <NotificationBell onOpen={openFromNotification} />
          {/* the society name is already on the left: with one workspace the chip only shows from tablet width */}
          <div className={manyWorkspaces ? '' : 'hidden sm:block'}><WorkspaceSelector /></div>
          <SignOutMenu />
        </div>
      </div>

      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-[248px] shrink-0 flex-col gap-5 bg-surface border-r border-border px-3 py-5 print:hidden md:sticky md:top-0 md:h-screen md:overflow-y-auto">
        <div className="px-2"><Logo /></div>

        <div className="px-1 space-y-2">
          <div className="px-2">
            <div className="font-semibold text-fg truncate">{activeSociety?.name || 'My society'}</div>
            <div className="text-xs text-fg-subtle capitalize">{roleName}</div>
          </div>
          <WorkspaceSelector />
        </div>

        <nav aria-label="Society" className="flex-1 flex flex-col gap-0.5">
          {NAV_ITEMS.map((tab, index) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            const badge = badgeFor(tab.id);
            // a heading where each group starts: Money, Society, Settings (and Accounts for the Accountant)
            const firstOfGroup = tab.group !== 'top' && NAV_ITEMS[index - 1]?.group !== tab.group;
            return (
              <React.Fragment key={tab.id}>
                {firstOfGroup && <div className="px-3 pt-4 pb-1 text-xs font-medium text-fg-subtle">{GROUP_LABELS[tab.group]}</div>}
                <button
                  onClick={() => goTo(tab.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition duration-150 cursor-pointer text-left',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
                    isActive ? 'bg-brand-soft text-brand-ink font-semibold' : 'text-fg-muted font-medium hover:bg-surface-muted hover:text-fg',
                  )}
                >
                  <Icon className="w-5 h-5 shrink-0" />
                  <span className="flex-1 truncate">{tab.label}</span>
                  {badge > 0 && (
                    <span className="min-w-5 h-5 px-1.5 rounded-full bg-warning-soft text-warning text-xs font-semibold flex items-center justify-center tabular-nums">{badge}</span>
                  )}
                </button>
              </React.Fragment>
            );
          })}
        </nav>

        <div className="pt-4 border-t border-border space-y-2 px-1">
          <div className="flex items-center gap-2.5 px-2">
            <span className="w-8 h-8 shrink-0 rounded-full bg-surface-muted text-fg-muted text-xs font-semibold flex items-center justify-center uppercase">
              {initials(profile?.full_name)}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-fg truncate">{profile?.full_name || 'My profile'}</div>
              <div className="text-xs text-fg-subtle truncate">{contactText(profile)}</div>
            </div>
          </div>
          <Button variant="ghost" size="sm" className="w-full justify-start text-danger hover:text-danger" leftIcon={<LogOut className="w-4 h-4" />} onClick={() => logout()}>
            Sign out
          </Button>
          <LogoutEverywhereButton />
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Desktop top bar */}
        <header className="hidden md:flex sticky top-0 z-20 h-16 items-center justify-between gap-4 px-6 lg:px-8 bg-surface/95 backdrop-blur-md border-b border-border print:hidden">
          <div className="text-[13px] text-fg-subtle flex items-center gap-2 min-w-0">
            <span className="truncate">{activeSociety?.name}</span>
            <span aria-hidden="true">/</span>
            <span className="text-fg font-medium truncate">{activeLabel}</span>
          </div>
          <div className="flex items-center gap-2">
            <PWAInstallButton />
            <NotificationBell onOpen={openFromNotification} />
          </div>
        </header>

      {/* Main Content Workspace */}
      <main className="flex-1 w-full max-w-[1200px] mx-auto px-4 py-5 md:px-6 md:py-6 lg:px-8 lg:py-8">
        {readOnly && (
          <div role="note" className="mb-4 p-3 rounded-xl bg-warning-soft border border-warning/20 text-[13px] text-warning">
            <strong>Read-only committee access.</strong> As a Committee Member you can view everything, but issuing bills, verifying payments,
            approving expenses and publishing notices need the Secretary, Treasurer, Chairman or Society Admin.
          </div>
        )}
        {planBanner && activeTab !== 'plan' && (
          <button onClick={() => goTo('plan')} className={cn('mb-4 w-full text-left p-3 rounded-xl border text-[13px] cursor-pointer print:hidden',
            planBanner.tone === 'rose' ? 'bg-danger-soft border-danger/20 text-danger'
              : planBanner.tone === 'sky' ? 'bg-info-soft border-info/20 text-info' : 'bg-warning-soft border-warning/20 text-warning',
          )}>
            {planBanner.text} <span className="underline font-semibold">See plans →</span>
          </button>
        )}

        {/* HOME */}
        {activeTab === 'home' && (
          <div className="space-y-6">
            <PageHeader
              title={greeting.hello}
              description={[activeSociety?.name, greeting.today].filter(Boolean).join(' · ')}
              actions={
                <>
                  <IconButton label="Refresh" onClick={loadSocietyData}>
                    <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
                  </IconButton>
                  {!readOnly && <Button variant="secondary" onClick={() => goTo('payments')}>Verify payments</Button>}
                  {!readOnly && <Button onClick={() => goTo('billing')} leftIcon={<Plus className="w-4 h-4" />}>Issue bills</Button>}
                </>
              }
            />

            {/* Home cards (spec 9.4): KPIs and what needs you */}
            {activeSociety && (
              <HomeCards
                societyId={activeSociety.id}
                canManage={!readOnly}
                onOpen={goTo}
                aside={!loading && setupNext ? (
                  <Card className="p-5 space-y-3">
                    <h2 className="text-base font-semibold">Finish setting up</h2>
                    <p className="text-fg-muted">Next: {SETUP_LABELS[setupNext] ?? setupNext}.</p>
                    <a href="/setup" className={buttonClass('secondary', 'sm')}>Continue setup <ChevronRight className="w-4 h-4" /></a>
                  </Card>
                ) : null}
              />
            )}

            {/* Latest notices */}
            <Card>
              <CardHeader title="Latest notices" actions={<Button variant="link" size="sm" onClick={() => goTo('notices')}>All notices</Button>} />
              {notices.length > 0 ? (
                <ul className="divide-y divide-border">
                  {notices.slice(0, 3).map(n => (
                    <li key={n.id} className="px-4 sm:px-5 py-4 space-y-1">
                      <div className="flex items-center gap-2 text-xs text-fg-subtle">
                        <Badge tone="brand">{n.category}</Badge>
                        <span>{new Date(n.published_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                      </div>
                      <h3 className="font-semibold text-fg">{n.title}</h3>
                      <p className="text-fg-muted leading-relaxed line-clamp-2">{n.content}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  icon={FileText}
                  title="No notices yet"
                  description="Residents see notices on their phone and get a notification. Post the first one, like the water tank cleaning date."
                  actionText={readOnly ? undefined : 'Post a notice'}
                  onAction={readOnly ? undefined : () => goTo('notices')}
                  bare
                />
              )}
            </Card>
          </div>
        )}

        {/* FLATS & RESIDENTS */}
        {activeTab === 'flats' && activeSociety && (
          <div className="space-y-4">
            <div role="tablist" aria-label="Flats and residents" className="inline-flex rounded-lg bg-surface-muted p-1 text-sm">
              {(['flats', 'members'] as const).map(v => (
                <button key={v} role="tab" aria-selected={flatsView === v} onClick={() => showFlatsView(v)}
                  className={cn('px-4 h-8 rounded-md font-medium cursor-pointer transition duration-150',
                    flatsView === v ? 'bg-surface text-fg shadow-card' : 'text-fg-muted hover:text-fg')}>
                  {v === 'flats' ? 'Flats' : 'Members'}
                </button>
              ))}
            </div>
            {flatsView === 'flats' ? (
              <UnitsTab
                societyId={activeSociety.id}
                societyName={activeSociety.name}
                units={units}
                loading={loading}
                onChanged={loadSocietyData}
                canManage={!readOnly}
              />
            ) : (
              <MembersTab societyId={activeSociety.id} societyName={activeSociety.name} currentUserId={user?.id} units={units}
                canChooseAccountant={!readOnly} canManage={!readOnly} onAccountantChanged={(id) => { if (id === user?.id) refreshUserData(activeSociety.id); }} />
            )}
          </div>
        )}
        {/* SETTINGS */}
        {activeTab === 'settings' && activeSociety && (
          <SettingsTab societyId={activeSociety.id} />
        )}

        {/* TAB 3: BILLING */}
        {activeTab === 'billing' && activeSociety && (
          <BillingTab
            societyId={activeSociety.id}
            bills={bills}
            totalsOverride={summary ? { billed: Number(summary.billed), collected: Number(summary.collected), due: Number(summary.outstanding) } : null}
            units={units}
            loading={loading}
            onChanged={loadSocietyData}
          />
        )}

        {/* PAYMENTS */}
        {activeTab === 'payments' && activeSociety && (
          <PaymentsTab societyId={activeSociety.id} societyName={activeSociety.name} units={units} onChanged={loadSocietyData} />
        )}

        {/* TAB 4: EXPENSES */}
        {activeTab === 'expenses' && activeSociety && (
          <ExpensesTab societyId={activeSociety.id} currentUserId={user?.id} expenses={expenses} onChanged={loadSocietyData} />
        )}

        {activeTab === 'assets' && activeSociety && (
          <FeatureGate plan={plan} feature="asset_register" label="The asset register" planName={featurePlan('asset_register')} onUpgrade={() => goTo('plan')}>
            <AssetRegister societyId={activeSociety.id} canManage={isAccountant || !readOnly} />
          </FeatureGate>
        )}

        {activeTab === 'plan' && activeSociety && (
          <PlanBilling societyId={activeSociety.id} canManage={!readOnly} onPlanChanged={() => { loadPlan(); loadSocietyData(); }} />
        )}

        {/* TAB 5: COMPLAINTS */}
        {activeTab === 'complaints' && activeSociety && (
          <ComplaintsTab societyId={activeSociety.id} currentUserId={user?.id} complaints={complaints} units={units} onChanged={loadSocietyData} />
        )}

        {/* NOTICES */}
        {activeTab === 'notices' && activeSociety && (
          <NoticesTab societyId={activeSociety.id} currentUserId={user?.id} notices={notices} onChanged={loadSocietyData} />
        )}

        {/* POLLS (Phase 10) */}
        {activeTab === 'polls' && activeSociety && (
          <PollsList societyId={activeSociety.id} isCommittee canManage={!readOnly} />
        )}

        {/* STAFF (Phase 10) */}
        {activeTab === 'staff' && activeSociety && (
          <StaffRegister societyId={activeSociety.id} isCommittee canManage={!readOnly} myUnitIds={[]} />
        )}

        {/* REQUESTS & NOCs (Phase 11A) */}
        {activeTab === 'requests' && activeSociety && (
          <FlatRequests societyId={activeSociety.id} canManage={!readOnly} />
        )}

        {/* DOCUMENTS */}
        {activeTab === 'documents' && activeSociety && (
          <DocumentsVault societyId={activeSociety.id} canManage />
        )}

        {/* REPORTS */}
        {activeTab === 'reports' && activeSociety && (
          <FinancialReports societyId={activeSociety.id} societyName={activeSociety.name} features={plan?.features} />
        )}

        {activeTab === 'approvals' && activeSociety && (
          <div className="space-y-6">
            <PageHeader title="Approvals" description="Everything that waits for a committee decision, in one place." />
            <RequestsWaiting societyId={activeSociety.id} onOpen={() => goTo('requests')} />
            <PendingVendorBills societyId={activeSociety.id} currentUserId={user?.id} canDecide={!readOnly} onDecided={loadSocietyData} />
            <JoinRequests societyId={activeSociety.id} units={units} canDecide={!readOnly} onDecided={loadSocietyData} />
            <OpeningBalanceReview societyId={activeSociety.id} canDecide={!readOnly} onDecided={loadSocietyData} />
            <AdjustmentsPanel societyId={activeSociety.id} currentUserId={user?.id} canDecide={!readOnly} canPropose={false} />
          </div>
        )}

        {activeTab === 'audit' && activeSociety && (
          <div className="space-y-8">
            <AdjustmentsPanel societyId={activeSociety.id} currentUserId={user?.id} canDecide={!readOnly} canPropose={isAccountant || !readOnly} />
            <YearLockPanel societyId={activeSociety.id} canLock={isAccountant || !readOnly} />
            <PriorYearEditor societyId={activeSociety.id} canEdit={isAccountant || !readOnly} />
          </div>
        )}

        {/* PROFESSIONALS */}
        {activeTab === 'professionals' && activeSociety && (
          <FeatureGate plan={plan} feature="ca_portal" label="CA & auditor access" planName={featurePlan('ca_portal')} onUpgrade={() => goTo('plan')}>
            <ProfessionalsTab societyId={activeSociety.id} currentUserId={user?.id} />
          </FeatureGate>
        )}

        {activeTab === 'bank' && activeSociety && (
          <FeatureGate plan={plan} feature="bank_match" label="Bank statement match" planName={featurePlan('bank_match')} onUpgrade={() => goTo('plan')}>
            <BankReconciliation societyId={activeSociety.id} canManage={isAccountant || !readOnly} canVerify={!readOnly} />
          </FeatureGate>
        )}

        {/* ACCOUNTS (the Accountant only) */}
        {activeTab === 'ledgers' && activeSociety && isAccountant && (
          <div className="space-y-6">
            <ChartOfAccounts societyId={activeSociety.id} canManage />
            <PartyLedgers societyId={activeSociety.id} />
          </div>
        )}
        {activeTab === 'billtypes' && activeSociety && isAccountant && <BillTypes societyId={activeSociety.id} canManage />}
        {activeTab === 'opening' && activeSociety && isAccountant && <OpeningBalanceEditor societyId={activeSociety.id} canManage />}
      </main>
      </div>

      {/* Phone bottom bar: Home · Bills · Payments · Complaints · More */}
      <nav aria-label="Society" className="md:hidden print:hidden fixed bottom-0 left-0 right-0 z-30 bg-surface/95 backdrop-blur-md border-t border-border px-1 pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] grid grid-cols-5">
        {PHONE_BAR.map(id => {
          const Icon = ICONS[id];
          const isActive = activeTab === id && !showMore;
          const badge = badgeFor(id);
          return (
            <button
              key={id}
              onClick={() => goTo(id)}
              aria-current={isActive ? 'page' : undefined}
              className={cn('relative min-h-12 flex flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] cursor-pointer',
                isActive ? 'text-brand font-semibold' : 'text-fg-subtle font-medium')}
            >
              <Icon className="w-[22px] h-[22px]" />
              <span>{PHONE_LABELS[id]}</span>
              {badge > 0 && (
                <span className="absolute top-0.5 left-1/2 ml-2 min-w-4 h-4 px-1 rounded-full bg-danger-solid text-on-brand text-[10px] font-semibold flex items-center justify-center">{badge}</span>
              )}
            </button>
          );
        })}
        <button
          onClick={() => setShowMore(v => !v)}
          aria-expanded={showMore}
          className={cn('min-h-12 flex flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] cursor-pointer',
            showMore ? 'text-brand font-semibold' : 'text-fg-subtle font-medium')}
        >
          <Menu className="w-[22px] h-[22px]" />
          <span>More</span>
        </button>
      </nav>

      {/* Phone "More" sheet: every module reachable on a phone */}
      {showMore && (
        <div className="md:hidden fixed inset-0 z-20 bg-fg/40" onClick={() => setShowMore(false)}>
          <div
            role="dialog"
            aria-label="All screens"
            className="absolute bottom-[calc(3.75rem+env(safe-area-inset-bottom))] left-0 right-0 max-h-[70vh] overflow-y-auto rounded-t-2xl bg-surface border-t border-border shadow-pop px-3 pt-2 pb-3"
            onClick={e => e.stopPropagation()}
          >
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-border-strong" aria-hidden="true" />
            {NAV_ITEMS.filter(item => !PHONE_BAR.includes(item.id)).map((item, index, list) => {
              const Icon = item.icon;
              const heading = item.group !== 'top' && list[index - 1]?.group !== item.group ? GROUP_LABELS[item.group] : null;
              const badge = badgeFor(item.id);
              return (
                <React.Fragment key={item.id}>
                  {heading && <div className="px-3 pt-3 pb-1 text-xs font-medium text-fg-subtle">{heading}</div>}
                  <button
                    onClick={() => goTo(item.id)}
                    className={cn('w-full min-h-12 flex items-center gap-3 px-3 rounded-lg text-left text-[15px] cursor-pointer',
                      activeTab === item.id ? 'bg-brand-soft text-brand-ink font-semibold' : 'text-fg font-medium active:bg-surface-muted')}
                  >
                    <Icon className="w-5 h-5 text-fg-muted" />
                    <span className="flex-1">{item.label}</span>
                    {badge > 0 && <span className="min-w-5 h-5 px-1.5 rounded-full bg-warning-soft text-warning text-xs font-semibold flex items-center justify-center">{badge}</span>}
                    <ChevronRight className="w-4 h-4 text-fg-subtle" />
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
