'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth, COMMITTEE_ROLES } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase/client';
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
import { PriorYearEditor } from '../../components/PriorYearEditor';
import { YearLockPanel } from '../../components/YearLockPanel';
import { FeatureGate, PlanBilling } from '../../components/PlanBilling';
import { daysUntil } from '../../lib/billing';
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
  CheckCircle2,
  ChevronRight,
  Menu,
  Boxes,
  Scale,
  Gem,
} from 'lucide-react';

type Tab = 'home' | 'members' | 'flats' | 'billing' | 'payments' | 'expenses' | 'assets' | 'bank' | 'documents' | 'notices' | 'complaints' | 'professionals' | 'reports' | 'audit' | 'settings' | 'plan';

const NAV_ITEMS: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'home', label: 'Operations Feed', icon: Home },
  { id: 'flats', label: 'Flats & Units', icon: Building2 },
  { id: 'members', label: 'Members & Residents', icon: Users },
  { id: 'billing', label: 'Maintenance Billing', icon: CreditCard },
  { id: 'payments', label: 'Payment Verifications', icon: QrCode },
  { id: 'expenses', label: 'Expenses & Payables', icon: Receipt },
  { id: 'assets', label: 'Fixed Assets', icon: Boxes },
  { id: 'bank', label: 'Bank Reconciliation', icon: Landmark },
  { id: 'documents', label: 'Documents Vault', icon: FolderLock },
  { id: 'notices', label: 'Notice Board', icon: FileText },
  { id: 'complaints', label: 'Helpdesk Complaints', icon: MessageSquare },
  { id: 'professionals', label: 'CA & Auditor Access', icon: Briefcase },
  { id: 'reports', label: 'Financial Reports', icon: BarChart3 },
  { id: 'audit', label: 'Audit & Year Close', icon: Scale },
  { id: 'settings', label: 'Society Rules', icon: Settings },
  { id: 'plan', label: 'Sahvaas Plan & Billing', icon: Gem },
];

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
    logout
  } = useAuth();

  // A secretary who also owns a flat has two memberships: show the committee one here
  const committeeMembership = societyMemberships.find(m => activeSociety && m.society_id === activeSociety.id && COMMITTEE_ROLES.includes(m.role));
  const roleName = committeeMembership?.role?.replace('_', ' ') || 'Member';
  const readOnly = committeeMembership?.role === 'committee_member';

  const [activeTab, setActiveTab] = useState<Tab>('home');
  const [showMore, setShowMore] = useState(false);

  const [units, setUnits] = useState<Unit[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [summary, setSummary] = useState<SocietySummary | null>(null);
  const [plan, setPlan] = useState<SocietyPlan | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Fetch real records for the active society
  const loadSocietyData = useCallback(async () => {
    if (!activeSociety || !supabase) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const [uRes, bRes, eRes, nRes, cRes, sRes] = await Promise.all([
        supabase.from('units').select('*').eq('society_id', activeSociety.id).order('unit_number').limit(1000),
        supabase.from('bills').select('*').eq('society_id', activeSociety.id).order('bill_date', { ascending: false }).limit(LIST_LIMIT),
        supabase.from('expenses').select('*').eq('society_id', activeSociety.id).order('created_at', { ascending: false }).limit(LIST_LIMIT),
        supabase.from('notices').select('*').eq('society_id', activeSociety.id).order('published_at', { ascending: false }).limit(200),
        supabase.from('complaints').select('*').eq('society_id', activeSociety.id).order('created_at', { ascending: false }).limit(LIST_LIMIT),
        supabase.rpc('society_summary', { p_society_id: activeSociety.id }),
      ]);

      if (uRes.data) setUnits(uRes.data);
      if (bRes.data) setBills(bRes.data);
      if (eRes.data) setExpenses(eRes.data);
      if (nRes.data) setNotices(nRes.data);
      if (cRes.data) setComplaints(cRes.data);
      setSummary((sRes.data as SocietySummary) ?? null);
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
    : trialLeft != null && trialLeft <= 7 ? { tone: 'sky', text: `Free trial ends in ${trialLeft} day${trialLeft === 1 ? '' : 's'}. Choose a plan to keep the CA portal and asset register.` }
    : !plan.in_trial && plan.paid_plan_code === 'free' ? { tone: 'amber', text: 'You are on the Free plan — residents see a few local offers. Upgrade to remove them and unlock the CA portal.' }
    : null;

  const goTo = (tab: Tab) => {
    setActiveTab(tab);
    setShowMore(false);
  };

  // Onboarding checklist shown until the society is set up
  const setupSteps = [
    { done: true, label: 'Register society', tab: 'home' as const },
    { done: (summary?.units ?? units.length) > 0, label: 'Import flats', tab: 'flats' as const },
    { done: Boolean(summary?.upi_configured), label: 'Add society UPI ID', tab: 'settings' as const },
    { done: (summary?.members ?? 0) > 1, label: 'Invite members', tab: 'members' as const },
  ];
  const setupComplete = setupSteps.every(s => s.done);

  const outstandingTotal = Number(summary?.outstanding ?? 0);
  const pendingApprovalCount = summary?.pending_expenses ?? expenses.filter(e => e.status === 'pending_approval').length;
  const openComplaintCount = summary?.open_complaints ?? complaints.filter(c => c.status === 'open' || c.status === 'in_progress').length;
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
          <WorkspaceSelector />
          <button
            onClick={() => logout()}
            className="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:text-rose-400 cursor-pointer"
            title="Sign Out"
          >
            <LogOut className="w-4 h-4" />
          </button>
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

            <div className="pt-2">
              <WorkspaceSelector />
            </div>
          </div>

          <nav className="space-y-1">
            {NAV_ITEMS.map(tab => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
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
              );
            })}
          </nav>
        </div>

        <div className="pt-4 border-t border-slate-800 space-y-2 text-xs">
          <div className="truncate text-slate-400 font-mono text-[11px]">{profile?.email}</div>
          <button
            onClick={() => logout()}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-rose-400 font-medium cursor-pointer transition"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
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
                <h1 className="text-xl font-bold text-white tracking-tight">Daily Operations Feed</h1>
                <p className="text-xs text-slate-400">
                  {activeSociety?.name} • All events auto-posted to ledger
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
            {!loading && !setupComplete && (
              <div className="p-4 rounded-2xl bg-sky-500/5 border border-sky-500/30 space-y-3">
                <div className="text-xs font-bold text-sky-300 uppercase tracking-wider">Finish setting up your society</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {setupSteps.map(step => (
                    <button
                      key={step.label}
                      onClick={() => setActiveTab(step.tab)}
                      disabled={step.done}
                      className={`flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl text-xs text-left border transition ${
                        step.done
                          ? 'bg-slate-900/50 border-slate-800 text-slate-500 line-through'
                          : 'bg-slate-900 border-slate-700 text-white hover:border-sky-500 cursor-pointer'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <CheckCircle2 className={`w-4 h-4 ${step.done ? 'text-emerald-500' : 'text-slate-600'}`} />
                        {step.label}
                      </span>
                      {!step.done && <ChevronRight className="w-3.5 h-3.5 text-sky-400" />}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Quick Metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <button 
                onClick={() => setActiveTab('billing')}
                className="p-4 rounded-2xl bg-gradient-to-br from-sky-600 to-sky-700 text-white text-left shadow-lg shadow-sky-600/20 active:scale-95 transition cursor-pointer"
              >
                <CreditCard className="w-5 h-5 mb-2 opacity-90" />
                <div className="text-xs font-medium opacity-80">Outstanding Balance</div>
                <div className="text-lg font-bold">₹{outstandingTotal.toLocaleString('en-IN')}</div>
              </button>

              <button 
                onClick={() => setActiveTab('expenses')}
                className="p-4 rounded-2xl bg-slate-900 border border-slate-800 text-left active:scale-95 transition cursor-pointer"
              >
                <Receipt className="w-5 h-5 mb-2 text-amber-400" />
                <div className="text-xs text-slate-400">Pending Approvals</div>
                <div className="text-lg font-bold text-white flex items-center gap-1.5">
                  <span>{pendingApprovalCount}</span>
                  {pendingApprovalCount > 0 && (
                    <span className="text-[10px] font-semibold text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded">Action Req</span>
                  )}
                </div>
              </button>

              <button 
                onClick={() => setActiveTab('complaints')}
                className="p-4 rounded-2xl bg-slate-900 border border-slate-800 text-left active:scale-95 transition cursor-pointer"
              >
                <MessageSquare className="w-5 h-5 mb-2 text-rose-400" />
                <div className="text-xs text-slate-400">Open Complaints</div>
                <div className="text-lg font-bold text-white">{openComplaintCount}</div>
              </button>

              <button 
                onClick={() => setActiveTab('flats')}
                className="p-4 rounded-2xl bg-slate-900 border border-slate-800 text-left active:scale-95 transition cursor-pointer"
              >
                <Building2 className="w-5 h-5 mb-2 text-emerald-400" />
                <div className="text-xs text-slate-400">Registered Units</div>
                <div className="text-lg font-bold text-white">{summary?.units ?? units.length}</div>
              </button>
            </div>

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
          <UnitsTab
            societyId={activeSociety.id}
            societyName={activeSociety.name}
            units={units}
            loading={loading}
            onChanged={loadSocietyData}
          />
        )}

        {/* MEMBERS */}
        {activeTab === 'members' && activeSociety && (
          <MembersTab societyId={activeSociety.id} societyName={activeSociety.name} currentUserId={user?.id} units={units} />
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
          <FeatureGate plan={plan} feature="asset_register" label="The asset register" planName="Basic and Pro" onUpgrade={() => goTo('plan')}>
            <AssetRegister societyId={activeSociety.id} canManage={!readOnly} />
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

        {activeTab === 'audit' && activeSociety && (
          <div className="space-y-8">
            <AdjustmentsPanel societyId={activeSociety.id} currentUserId={user?.id} canDecide={!readOnly} canPropose={!readOnly} />
            <YearLockPanel societyId={activeSociety.id} canLock={!readOnly} />
            <PriorYearEditor societyId={activeSociety.id} canEdit={!readOnly} />
          </div>
        )}

        {/* PROFESSIONALS */}
        {activeTab === 'professionals' && activeSociety && (
          <FeatureGate plan={plan} feature="ca_portal" label="CA & auditor access" planName="Basic and Pro" onUpgrade={() => goTo('plan')}>
            <ProfessionalsTab societyId={activeSociety.id} currentUserId={user?.id} />
          </FeatureGate>
        )}

        {activeTab === 'bank' && activeSociety && (
          <FeatureGate plan={plan} feature="bank_match" label="Bank statement match" planName="Pro" onUpgrade={() => goTo('plan')}>
            <BankReconciliation societyId={activeSociety.id} canManage={!readOnly} />
          </FeatureGate>
        )}
      </main>

      {/* Mobile Bottom Navigation Bar */}
      <nav className="md:hidden print:hidden fixed bottom-0 left-0 right-0 z-30 bg-slate-900/95 backdrop-blur-md border-t border-slate-800 px-2 py-1.5 flex items-center justify-around text-[10px] text-slate-400">
        {([
          { id: 'home', label: 'Feed', icon: Home },
          { id: 'billing', label: 'Bills', icon: CreditCard },
          { id: 'payments', label: pendingPayments > 0 ? `Verify (${pendingPayments})` : 'Payments', icon: QrCode },
          { id: 'complaints', label: 'Tickets', icon: MessageSquare },
        ] as { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[]).map(item => {
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
            {NAV_ITEMS.map(item => {
              const Icon = item.icon;
              const badge = item.id === 'payments' ? pendingPayments : item.id === 'expenses' ? pendingApprovalCount : 0;
              return (
                <button
                  key={item.id}
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
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
