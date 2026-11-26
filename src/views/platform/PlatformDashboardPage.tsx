'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase/client';
import { contactText } from '../../lib/mobile';
import { formatINR } from '../../lib/inr';
import { Banner } from '../../components/Banner';
import { EmptyState } from '../../components/EmptyState';
import { TaxRulesPanel } from '../../components/TaxRulesPanel';
import { BillingConsole } from '../../components/BillingConsole';
import { AdsConsole } from '../../components/AdsConsole';
import { OtpCosts } from '../../components/platform/OtpCosts';
import { SetupFunnel, SocietyHealth, RevenuePanel, Announcements } from '../../components/platform/PlatformInsights';
import { AuditLog, Profile } from '../../types/database';
import { Building2, Users, FileText, Cpu, LogOut, RefreshCw, Loader2, Search, Inbox, Percent, CreditCard, Megaphone, MessageCircle, Filter, HeartPulse, IndianRupee, Send } from 'lucide-react';
import { LogoutEverywhereButton } from '../../components/SignOutMenu';
import { promptDialog } from '../../components/ui/feedback';
import { Logo } from '../../components/ui/Logo';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { PageHeader } from '../../components/ui/PageHeader';
import { cn } from '../../components/ui/cn';

interface SocietyOverview {
  id: string; name: string; slug: string; city: string; state: string;
  subscription_status: 'trial' | 'active' | 'suspended' | 'cancelled'; is_active: boolean; created_at: string;
  total_units: number; members: number; billed_this_month: number; collected_this_month: number;
  plan_tier: string | null; plan_period_end: string | null;
}

type Tab = 'funnel' | 'health' | 'revenue' | 'announce' | 'otp' | 'overview' | 'societies' | 'billing' | 'sponsors' | 'leads' | 'tax_rules' | 'users' | 'audit_logs';

interface Lead {
  id: string; name: string; email: string; phone: string; society_name: string; city: string | null;
  units: number | null; message: string | null; status: 'new' | 'contacted' | 'converted' | 'closed'; created_at: string;
}

const STATUS_STYLES: Record<SocietyOverview['subscription_status'], string> = {
  trial: 'bg-brand-soft text-brand',
  active: 'bg-success-soft text-success',
  suspended: 'bg-danger-soft text-danger',
  cancelled: 'bg-surface-muted text-fg-muted',
};
// Complimentary plan for a year without an invoice (pilots, support); paid plans go through Billing
const PLANS = [
  { tier: 'basic', label: 'Basic — complimentary year' },
  { tier: 'pro', label: 'Pro — complimentary year' },
];

export const PlatformDashboardPage: React.FC = () => {
  const { user, profile, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [societies, setSocieties] = useState<SocietyOverview[]>([]);
  const [usersList, setUsersList] = useState<Profile[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return setLoading(false);
    setLoading(true);
    const [socRes, usersRes, auditRes, leadsRes] = await Promise.all([
      supabase.rpc('platform_society_overview'),
      supabase.from('profiles').select('*').order('created_at', { ascending: false }).limit(500),
      supabase.from('audit_logs').select('*').order('timestamp', { ascending: false }).limit(100),
      supabase.from('leads').select('*').order('created_at', { ascending: false }).limit(300),
    ]);
    if (socRes.error) setError(socRes.error.message);
    setSocieties((socRes.data ?? []) as SocietyOverview[]);
    setUsersList((usersRes.data ?? []) as Profile[]);
    setAuditLogs((auditRes.data ?? []) as AuditLog[]);
    setLeads((leadsRes.data ?? []) as Lead[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const changeStatus = async (s: SocietyOverview, status: SocietyOverview['subscription_status']) => {
    if (!supabase || status === s.subscription_status) return;
    let reason: string | null = null;
    if (status === 'suspended' || status === 'cancelled') {
      reason = await promptDialog({ title: `${status === 'suspended' ? 'Suspend' : 'Cancel'} ${s.name}?`, body: 'Members lose access immediately.', label: 'Reason', minLength: 3, confirmText: status === 'suspended' ? 'Suspend society' : 'Cancel society', tone: 'danger' });
      if (!reason?.trim()) return;
    }
    setBusy(s.id);
    const { error: rpcErr } = await supabase.rpc('platform_set_society_status', { p_society_id: s.id, p_status: status, p_reason: reason });
    setBusy(null);
    if (rpcErr) return setError(rpcErr.message);
    setNotice(`${s.name} is now ${status}.`);
    load();
  };

  const assignPlan = async (s: SocietyOverview, tier: string) => {
    if (!supabase || !tier) return;
    setBusy(s.id);
    const { error: rpcErr } = await supabase.rpc('platform_assign_plan', { p_society_id: s.id, p_tier_code: tier, p_billing_term: 'annual', p_period_end: null });
    setBusy(null);
    if (rpcErr) return setError(rpcErr.message);
    setNotice(`${s.name} is on a complimentary ${tier} year (no invoice).`);
    load();
  };

  const count = (st: SocietyOverview['subscription_status']) => societies.filter(s => s.subscription_status === st).length;
  const sum = (k: 'total_units' | 'members' | 'billed_this_month' | 'collected_this_month') => societies.reduce((a, s) => a + Number(s[k]), 0);
  const filtered = societies.filter(s => `${s.name} ${s.city} ${s.slug}`.toLowerCase().includes(search.toLowerCase()));
  const societyName = (id?: string) => societies.find(s => s.id === id)?.name ?? '—';

  const nav: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'overview', label: 'Overview', icon: Cpu },
    { id: 'societies', label: 'Societies', icon: Building2 },
    { id: 'funnel', label: 'Setup funnel', icon: Filter },
    { id: 'health', label: 'Society health', icon: HeartPulse },
    { id: 'revenue', label: 'Revenue', icon: IndianRupee },
    { id: 'announce', label: 'Announcements', icon: Send },
    { id: 'billing', label: 'Billing & Plans', icon: CreditCard },
    { id: 'sponsors', label: 'Sponsors', icon: Megaphone },
    { id: 'otp', label: 'OTP & cost', icon: MessageCircle },
    { id: 'leads', label: 'Demo Requests', icon: Inbox },
    { id: 'tax_rules', label: 'Tax Rules', icon: Percent },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'audit_logs', label: 'Audit Logs', icon: FileText },
  ];

  return (
    <div className="min-h-screen bg-canvas text-fg text-sm flex flex-col md:flex-row">
      <aside className="w-full md:w-[248px] shrink-0 flex flex-col gap-4 md:gap-5 bg-surface border-b md:border-b-0 md:border-r border-border px-3 py-4 md:py-5 md:sticky md:top-0 md:h-screen md:overflow-y-auto">
        <div className="px-2 flex items-center justify-between gap-2"><Logo /><Badge tone="brand">Owner</Badge></div>
        <nav aria-label="Platform" className="flex md:flex-col gap-1 md:gap-0.5 overflow-x-auto md:overflow-visible -mx-1 px-1 md:mx-0 md:px-0 md:flex-1">
          {nav.map(item => {
            const Icon = item.icon;
            const on = activeTab === item.id;
            return (
              <button key={item.id} onClick={() => setActiveTab(item.id)} aria-current={on ? 'page' : undefined}
                className={cn('shrink-0 md:w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm whitespace-nowrap text-left transition duration-150 cursor-pointer',
                  on ? 'bg-brand-soft text-brand-ink font-semibold' : 'text-fg-muted font-medium hover:bg-surface-muted hover:text-fg')}>
                <Icon className="w-5 h-5 shrink-0" /><span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="hidden md:block pt-4 border-t border-border space-y-2 px-1">
          <div className="px-2">
            <div className="text-sm font-medium text-fg truncate">{profile?.full_name || 'Platform admin'}</div>
            <div className="text-xs text-fg-subtle truncate">{contactText(profile)}</div>
          </div>
          <Button variant="ghost" size="sm" className="w-full justify-start text-danger hover:text-danger" leftIcon={<LogOut className="w-4 h-4" />} onClick={() => logout()}>
            Sign out
          </Button>
          <LogoutEverywhereButton />
        </div>
      </aside>

      <main className="flex-1 min-w-0 w-full max-w-[1440px] mx-auto px-4 py-5 md:px-6 md:py-6 lg:px-8 lg:py-8 space-y-6">
        <PageHeader
          title={nav.find(n => n.id === activeTab)?.label}
          description="Sahvaas platform console"
          actions={<Button variant="secondary" onClick={load} loading={loading} leftIcon={<RefreshCw className="w-4 h-4" />}>Refresh</Button>}
        />
        <Banner tone="error">{error}</Banner>
        <Banner tone="success">{notice}</Banner>

        {activeTab === 'overview' && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              ['Societies', societies.length, `${count('active')} paying • ${count('trial')} trial • ${count('suspended')} suspended`],
              ['Flats on platform', sum('total_units'), `${sum('members')} active memberships`],
              ['Billed this month', formatINR(sum('billed_this_month')), 'Across all societies'],
              ['Collected this month', formatINR(sum('collected_this_month')), 'Verified UPI / bank receipts'],
            ].map(([label, value, hint]) => (
              <div key={label as string} className="bg-canvas border border-border p-5 rounded-xl">
                <div className="text-fg-muted">{label}</div>
                <div className="mt-2 text-2xl font-semibold text-fg">{loading ? <Loader2 className="w-5 h-5 animate-spin text-fg-subtle" /> : value}</div>
                <div className="mt-1 text-xs text-fg-subtle">{hint}</div>
              </div>
            ))}
          </div>
        )}

        {(activeTab === 'overview' || activeTab === 'societies') && (
          <div className="bg-canvas border border-border rounded-xl overflow-hidden">
            <div className="p-4 border-b border-border flex items-center justify-between gap-3">
              <h3 className="font-semibold text-fg text-sm">Tenant Societies</h3>
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-fg-subtle" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search" className="bg-surface border border-border-strong rounded-lg pl-8 pr-3 py-1.5 text-fg outline-none" />
              </div>
            </div>
            {filtered.length === 0 && !loading ? (
              <EmptyState icon={Building2} title="No Societies" description="Societies appear here when committees register through /onboarding." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-surface-muted text-fg-muted text-xs">
                    <tr><th className="py-3 px-4">Society</th><th className="py-3 px-4">Flats / Members</th><th className="py-3 px-4">This month</th><th className="py-3 px-4">Plan</th><th className="py-3 px-4">Status</th></tr>
                  </thead>
                  <tbody className="divide-y divide-border/60 text-fg">
                    {filtered.map(s => (
                      <tr key={s.id} className="hover:bg-surface/50">
                        <td className="py-3 px-4">
                          <div className="font-medium text-fg">{s.name}</div>
                          <div className="text-fg-subtle">{s.city}, {s.state} • since {new Date(s.created_at).toLocaleDateString('en-IN')}</div>
                        </td>
                        <td className="py-3 px-4">{s.total_units} / {s.members}</td>
                        <td className="py-3 px-4">{formatINR(s.billed_this_month)} billed<div className="text-fg-subtle">{formatINR(s.collected_this_month)} collected</div></td>
                        <td className="py-3 px-4">
                          <div className="text-fg capitalize">{s.subscription_status === 'trial' ? 'trial' : s.plan_tier ?? '—'}</div>
                          <select value="" disabled={busy === s.id} onChange={e => assignPlan(s, e.target.value)} className="mt-1 bg-surface border border-border-strong rounded-lg px-2 py-1 text-fg">
                            <option value="">Give complimentary…</option>
                            {PLANS.map(p => <option key={p.tier} value={p.tier}>{p.label}</option>)}
                          </select>
                          {s.plan_period_end && <div className="text-fg-subtle mt-0.5">till {new Date(s.plan_period_end).toLocaleDateString('en-IN')}</div>}
                        </td>
                        <td className="py-3 px-4">
                          <select value={s.subscription_status} disabled={busy === s.id} onChange={e => changeStatus(s, e.target.value as SocietyOverview['subscription_status'])}
                            className={`rounded-lg px-2 py-1 border border-border-strong font-semibold ${STATUS_STYLES[s.subscription_status]}`}>
                            <option value="trial">Trial</option><option value="active">Active</option>
                            <option value="suspended">Suspended</option><option value="cancelled">Cancelled</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === 'leads' && (
          <div className="bg-canvas border border-border rounded-xl divide-y divide-border">
            {leads.length === 0 && <div className="p-4 text-fg-subtle">No demo requests yet. They arrive from the public Contact page.</div>}
            {leads.map(l => (
              <div key={l.id} className="p-4 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  <div className="font-semibold text-fg">{l.society_name} <span className="text-fg-subtle font-normal">• {l.city ?? '—'}{l.units ? ` • ${l.units} flats` : ''}</span></div>
                  <div className="text-fg">{l.name} • <a href={`mailto:${l.email}`} className="text-brand hover:underline">{l.email}</a> • <a href={`tel:${l.phone}`} className="text-brand hover:underline">{l.phone}</a></div>
                  {l.message && <div className="text-fg-muted whitespace-pre-line">{l.message}</div>}
                  <div className="text-fg-subtle">{new Date(l.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</div>
                </div>
                <select
                  value={l.status}
                  onChange={async e => {
                    if (!supabase) return;
                    const status = e.target.value as Lead['status'];
                    const { error: updErr } = await supabase.from('leads').update({ status }).eq('id', l.id);
                    if (updErr) setError(updErr.message);
                    else setLeads(ls => ls.map(x => (x.id === l.id ? { ...x, status } : x)));
                  }}
                  className="bg-surface border border-border-strong rounded-lg px-2 py-1 text-fg"
                >
                  <option value="new">New</option><option value="contacted">Contacted</option>
                  <option value="converted">Converted</option><option value="closed">Closed</option>
                </select>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'tax_rules' && <TaxRulesPanel currentUserId={user?.id} />}
        {activeTab === 'billing' && <BillingConsole />}
        {activeTab === 'sponsors' && <AdsConsole />}
        {activeTab === 'otp' && <OtpCosts />}
        {activeTab === 'funnel' && <SetupFunnel />}
        {activeTab === 'health' && <SocietyHealth />}
        {activeTab === 'revenue' && <RevenuePanel />}
        {activeTab === 'announce' && <Announcements />}

        {activeTab === 'users' && (
          <div className="bg-canvas border border-border rounded-xl overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-surface-muted text-fg-muted text-xs"><tr><th className="py-3 px-4">Name</th><th className="py-3 px-4">Email or mobile</th><th className="py-3 px-4">Joined</th></tr></thead>
              <tbody className="divide-y divide-border/60 text-fg">
                {usersList.map(u => (
                  <tr key={u.id}>
                    <td className="py-3 px-4 font-medium text-fg">{u.full_name}{u.is_platform_admin && <span className="ml-2 text-brand-ink">owner</span>}</td>
                    <td className="py-3 px-4 font-mono text-fg-muted">{contactText(u)}</td>
                    <td className="py-3 px-4 text-fg-muted">{new Date(u.created_at).toLocaleDateString('en-IN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'audit_logs' && (
          <div className="bg-canvas border border-border rounded-xl divide-y divide-border">
            {auditLogs.length === 0 && <div className="p-4 text-fg-subtle">No audit events yet.</div>}
            {auditLogs.map(l => (
              <div key={l.id} className="p-3 flex justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-brand-ink">{l.action}</div>
                  <div className="text-fg-muted truncate">{societyName(l.society_id)} • {l.entity_type} {l.reason ? `• ${l.reason}` : ''}</div>
                </div>
                <div className="text-fg-subtle shrink-0">{new Date(l.timestamp).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};
