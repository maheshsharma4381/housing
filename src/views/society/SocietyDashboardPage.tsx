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
} from 'lucide-react';
import { SignOutMenu, LogoutEverywhereButton } from '../../components/SignOutMenu';
import { nextSetupStep, type SetupStatus } from '../../lib/setup';
import { PWAInstallButton } from '../../components/PWAInstallButton';

type Tab = SocietyTab;

const ICONS: Record<SocietyTab, React.ComponentType<{ className?: string }>> = {
  home: Home, approvals: ListChecks, flats: Building2, members: Users, billing: CreditCard, payments: QrCode,
  expenses: Receipt, documents: FolderLock, notices: FileText, polls: Vote, staff: IdCard, complaints: MessageSquare, professionals: Briefcase,
  reports: BarChart3, settings: Settings, plan: Gem,
  ledgers: ListTree, billtypes: Tags, opening: BookOpen, assets: Boxes, bank: Landmark, audit: Scale,
};

// List screens fetch the latest N rows; totals come from society_summary() (no API row cap)
const LIST_LIMIT = 500;

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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col md:flex-row pb-20 md:pb-0">
      {/* Top App Bar (Mobile & Desktop) */}
      <div className="md:hidden sticky top-0 z-30 bg-slate-900/95 backdrop-blur-md px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-[11px] font-bold text-sky-400 uppercase tracking-wide truncate max-w-[180px]">
            {activeSociety?.name || 'Society Portal'}
          </div>
          <div className="text-xs font-medium text-white flex items-center gap-1.5">
            <span>{profile?.full_name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-500/20 text-sky-300 font-mono capitalize">
              {roleName}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* the installable app (spec: the PWA is the mobile app) */}
          <PWAInstallButton />
          <NotificationBell onOpen={openFromNotification} />
          {/* the society name is already on the left: with one workspace the chip only shows from tablet width */}
          <div className={manyWorkspaces ? '' : 'hidden sm:block'}><WorkspaceSelector /></div>
          <SignOutMenu />
        </div>
      </div>

      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-64 bg-slate-900 border-r border-slate-800 p-4 shrink-0 flex-col justify-between print:hidden">
        <div className="space-y-6">
          <div className="px-2 space-y-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-sky-400">
              Operations Center
            </span>
            <h2 className="text-base font-bold text-white truncate">
              {activeSociety?.name || 'My Society'}
            </h2>
            <div className="text-xs text-slate-400">
              Role: <strong className="text-sky-300 capitalize">{roleName}</strong>
            </div>

            <div className="pt-2 flex items-center gap-2">
              <div className="flex-1 min-w-0"><WorkspaceSelector /></div>
              <NotificationBell onOpen={openFromNotification} align="left" />
            </div>
          </div>

          <nav className="space-y-1">
            {NAV_ITEMS.map((tab, index) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              // a heading where each group starts: Money, Society, Settings (and Accounts for the Accountant)
              const firstOfGroup = tab.group !== 'top' && NAV_ITEMS[index - 1]?.group !== tab.group;
              return (
                <React.Fragment key={tab.id}>
                {firstOfGroup && <div className="px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">{GROUP_LABELS[tab.group]}</div>}
                <button
                  onClick={() => goTo(tab.id)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer ${
                    isActive 
                      ? 'bg-sky-600 text-white shadow-sm' 
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className="w-4 h-4" />
                    <span>{tab.label}</span>
                  </div>
                  {tab.id === 'approvals' && (approvalsCount + pendingApprovalCount) > 0 && (
                    <span className="w-5 h-5 rounded-full bg-amber-500 text-slate-950 font-bold text-[10px] flex items-center justify-center">
                      {approvalsCount + pendingApprovalCount}
                    </span>
                  )}
                  {tab.id === 'expenses' && pendingApprovalCount > 0 && (
                    <span className="w-5 h-5 rounded-full bg-amber-500 text-slate-950 font-bold text-[10px] flex items-center justify-center">
                      {pendingApprovalCount}
                    </span>
                  )}
                  {tab.id === 'payments' && pendingPayments > 0 && (
                    <span className="w-5 h-5 rounded-full bg-amber-500 text-slate-950 font-bold text-[10px] flex items-center justify-center">
                      {pendingPayments}
                    </span>
                  )}
                </button>
                </React.Fragment>
              );
            })}
          </nav>
        </div>

        <div className="pt-4 border-t border-slate-800 space-y-2 text-xs">
          <div className="truncate text-slate-400 font-mono text-[11px]">{contactText(profile)}</div>
          <button
            onClick={() => logout()}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-rose-400 font-medium cursor-pointer transition"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
          <LogoutEverywhereButton />
        </div>
      </aside>

      {/* Main Content Workspace */}
      <main className="flex-1 p-4 md:p-6 lg:p-8 max-w-5xl mx-auto w-full">
        {readOnly && (
          <div className="mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">
            <strong>Read-only committee access.</strong> As a Committee Member you can view everything, but issuing bills, verifying payments,
            approving expenses and publishing notices need the Secretary, Treasurer, Chairman or Society Admin.
          </div>
        )}
        {planBanner && activeTab !== 'plan' && (
          <button onClick={() => goTo('plan')} className={`mb-4 w-full text-left p-3 rounded-xl border text-xs cursor-pointer print:hidden ${
            planBanner.tone === 'rose' ? 'bg-rose-500/10 border-rose-500/30 text-rose-200'
              : planBanner.tone === 'sky' ? 'bg-sky-500/10 border-sky-500/30 text-sky-200' : 'bg-amber-500/10 border-amber-500/30 text-amber-200'
          }`}>
            {planBanner.text} <span className="underline font-semibold">See plans →</span>
          </button>
        )}

        {/* TAB 1: OPERATIONS FEED */}
        {activeTab === 'home' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-xl font-bold text-white tracking-tight">Home</h1>
                <p className="text-xs text-slate-400">
                  {activeSociety?.name}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={loadSocietyData}
                  className="p-2 rounded-xl bg-slate-900 border border-slate-800 hover:bg-slate-800 text-slate-300 cursor-pointer"
                  title="Refresh"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>

            {/* Getting started checklist */}
            {!loading && setupNext && (
              <a href="/setup" className="block p-4 rounded-2xl bg-sky-500/5 border border-sky-500/30 hover:border-sky-500 space-y-1">
                <div className="text-xs font-bold text-sky-300 uppercase tracking-wider">Finish setting up your society</div>
                <div className="text-xs text-slate-300 flex items-center gap-1">
                  Next: {setupNext === 'upi' ? 'UPI' : setupNext} <ChevronRight className="w-3.5 h-3.5 text-sky-400" />
                </div>
              </a>
            )}

            {/* Home cards (spec 9.4) */}
            {activeSociety && <HomeCards societyId={activeSociety.id} canManage={!readOnly} onOpen={goTo} />}

            {/* Pinned Notices */}
            {notices.length > 0 ? (
              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Recent Announcements
                </h3>
                {notices.slice(0, 3).map(n => (
                  <div key={n.id} className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-1.5 text-xs">
                    <div className="flex items-center justify-between text-[11px] text-slate-400">
                      <span className="font-semibold text-sky-400">{n.category}</span>
                      <span className="font-mono">{new Date(n.published_at).toLocaleDateString()}</span>
                    </div>
                    <h4 className="font-bold text-white text-sm">{n.title}</h4>
                    <p className="text-slate-300 leading-relaxed">{n.content}</p>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={FileText}
                title="Notice Board is Clean"
                description="Publish circulars or AGM announcements to broadcast to all members on their phones."
              />
            )}
          </div>
        )}

        {/* TAB 2: FLATS */}
        {activeTab === 'flats' && activeSociety && (
          <div className="space-y-4">
            <div className="inline-flex rounded-xl bg-slate-900 border border-slate-800 p-1 text-xs">
              {(['flats', 'members'] as const).map(v => (
                <button key={v} onClick={() => setFlatsView(v)}
                  className={`px-4 py-1.5 rounded-lg font-semibold cursor-pointer ${flatsView === v ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-white'}`}>
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

        {/* DOCUMENTS */}
        {activeTab === 'documents' && activeSociety && (
          <DocumentsVault societyId={activeSociety.id} canManage />
        )}

        {/* REPORTS */}
        {activeTab === 'reports' && activeSociety && (
          <FinancialReports societyId={activeSociety.id} societyName={activeSociety.name} features={plan?.features} />
        )}

        {activeTab === 'approvals' && activeSociety && (
          <div className="space-y-8">
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

      {/* Mobile Bottom Navigation Bar */}
      <nav className="md:hidden print:hidden fixed bottom-0 left-0 right-0 z-30 bg-slate-900/95 backdrop-blur-md border-t border-slate-800 px-2 py-1.5 flex items-center justify-around text-[10px] text-slate-400">
        {(PHONE_BAR.map(id => ({
          id,
          label: id === 'home' ? 'Home' : id === 'billing' ? 'Bills' : id === 'payments' ? (pendingPayments > 0 ? `Verify (${pendingPayments})` : 'Payments') : 'Complaints',
          icon: id === 'home' ? Home : id === 'billing' ? CreditCard : id === 'payments' ? QrCode : MessageSquare,
        })) as { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[]).map(item => {
          const Icon = item.icon;
          const isActive = activeTab === item.id && !showMore;
          return (
            <button
              key={item.id}
              onClick={() => goTo(item.id)}
              className={`flex flex-col items-center gap-1 py-1 px-2 rounded-lg cursor-pointer ${
                isActive ? 'text-sky-400 font-bold' : 'text-slate-400'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{item.label}</span>
            </button>
          );
        })}
        <button
          onClick={() => setShowMore(v => !v)}
          aria-expanded={showMore}
          className={`flex flex-col items-center gap-1 py-1 px-2 rounded-lg cursor-pointer ${showMore ? 'text-sky-400 font-bold' : 'text-slate-400'}`}
        >
          <Menu className="w-4 h-4" />
          <span>More</span>
        </button>
      </nav>

      {/* Mobile "More" sheet: every module reachable on a phone */}
      {showMore && (
        <div className="md:hidden fixed inset-0 z-20 bg-black/60" onClick={() => setShowMore(false)}>
          <div
            className="absolute bottom-14 left-0 right-0 max-h-[70vh] overflow-y-auto rounded-t-3xl bg-slate-900 border-t border-slate-800 p-4 grid grid-cols-3 gap-2"
            onClick={e => e.stopPropagation()}
          >
            {NAV_ITEMS.filter(item => !PHONE_BAR.includes(item.id)).map((item, index, list) => {
              const Icon = item.icon;
              const heading = item.group !== 'top' && list[index - 1]?.group !== item.group ? GROUP_LABELS[item.group] : null;
              const badge = item.id === 'payments' ? pendingPayments : item.id === 'expenses' ? pendingApprovalCount : item.id === 'approvals' ? approvalsCount + pendingApprovalCount : 0;
              return (
                <React.Fragment key={item.id}>
                {heading && <div className="col-span-3 pt-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">{heading}</div>}
                <button
                  onClick={() => goTo(item.id)}
                  className={`relative flex flex-col items-center gap-1.5 p-3 rounded-2xl text-[11px] text-center cursor-pointer ${
                    activeTab === item.id ? 'bg-sky-600 text-white' : 'bg-slate-950 text-slate-300'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                  <span className="leading-tight">{item.label}</span>
                  {badge > 0 && (
                    <span className="absolute top-1.5 right-1.5 min-w-4 h-4 px-1 rounded-full bg-amber-500 text-slate-950 font-bold text-[9px] flex items-center justify-center">{badge}</span>
                  )}
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
