'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase/client';
import { formatINR } from '../../lib/inr';
import { Banner } from '../../components/Banner';
import { EmptyState } from '../../components/EmptyState';
import { TaxRulesPanel } from '../../components/TaxRulesPanel';
import { BillingConsole } from '../../components/BillingConsole';
import { AdsConsole } from '../../components/AdsConsole';
import { AuditLog, Profile } from '../../types/database';
import { Building2, Users, FileText, Cpu, LogOut, RefreshCw, Loader2, Search, Inbox, Percent, CreditCard, Megaphone } from 'lucide-react';

interface SocietyOverview {
  id: string; name: string; slug: string; city: string; state: string;
  subscription_status: 'trial' | 'active' | 'suspended' | 'cancelled'; is_active: boolean; created_at: string;
  total_units: number; members: number; billed_this_month: number; collected_this_month: number;
  plan_tier: string | null; plan_period_end: string | null;
}

type Tab = 'overview' | 'societies' | 'billing' | 'sponsors' | 'leads' | 'tax_rules' | 'users' | 'audit_logs';

interface Lead {
  id: string; name: string; email: string; phone: string; society_name: string; city: string | null;
  units: number | null; message: string | null; status: 'new' | 'contacted' | 'converted' | 'closed'; created_at: string;
}

const STATUS_STYLES: Record<SocietyOverview['subscription_status'], string> = {
  trial: 'bg-sky-500/10 text-sky-300',
  active: 'bg-emerald-500/10 text-emerald-300',
  suspended: 'bg-rose-500/10 text-rose-300',
  cancelled: 'bg-slate-800 text-slate-400',
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
      reason = window.prompt(`Reason to ${status === 'suspended' ? 'suspend' : 'cancel'} ${s.name}? Members lose access immediately.`);
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
    { id: 'billing', label: 'Billing & Plans', icon: CreditCard },
    { id: 'sponsors', label: 'Sponsors', icon: Megaphone },
    { id: 'leads', label: 'Demo Requests', icon: Inbox },
    { id: 'tax_rules', label: 'Tax Rules', icon: Percent },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'audit_logs', label: 'Audit Logs', icon: FileText },
  ];

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col md:flex-row">
      <aside className="w-full md:w-64 bg-slate-950 border-r border-slate-800 p-4 shrink-0 flex flex-col justify-between">
        <div className="space-y-6">
          <div className="px-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-purple-400">Platform Governance</span>
            <h2 className="text-lg font-bold text-white tracking-tight">Platform Owner</h2>
            <p className="text-xs text-slate-400">Sahvaas SaaS Console</p>
          </div>
          <nav className="space-y-1">
            {nav.map(item => {
              const Icon = item.icon;
              return (
                <button key={item.id} onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer ${
                    activeTab === item.id ? 'bg-purple-600/20 text-purple-300 border border-purple-500/30' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                  }`}>
                  <Icon className="w-4 h-4 shrink-0" /><span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
        <div className="mt-8 pt-4 border-t border-slate-800 px-2 space-y-3 text-xs">
          <div>
            <div className="font-semibold text-white truncate">{profile?.full_name || 'Platform Admin'}</div>
            <div className="text-[11px] text-slate-400 truncate">{profile?.email}</div>
          </div>
          <button onClick={() => logout()} className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-rose-400 text-xs font-medium cursor-pointer">
            <LogOut className="w-3.5 h-3.5" /> <span>Sign Out</span>
          </button>
        </div>
      </aside>

      <main className="flex-1 p-4 md:p-8 overflow-y-auto space-y-6 text-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-slate-800">
          <h1 className="text-2xl font-bold text-white tracking-tight">{nav.find(n => n.id === activeTab)?.label}</h1>
          <button onClick={load} disabled={loading} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
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
              <div key={label as string} className="bg-slate-950 border border-slate-800 p-5 rounded-2xl">
                <div className="text-slate-400">{label}</div>
                <div className="mt-2 text-2xl font-extrabold text-white">{loading ? <Loader2 className="w-5 h-5 animate-spin text-slate-500" /> : value}</div>
                <div className="mt-1 text-[11px] text-slate-500">{hint}</div>
              </div>
            ))}
          </div>
        )}

        {(activeTab === 'overview' || activeTab === 'societies') && (
          <div className="bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between gap-3">
              <h3 className="font-semibold text-white text-sm">Tenant Societies</h3>
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-500" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search" className="bg-slate-900 border border-slate-700 rounded-xl pl-8 pr-3 py-1.5 text-white outline-none" />
              </div>
            </div>
            {filtered.length === 0 && !loading ? (
              <EmptyState icon={Building2} title="No Societies" description="Societies appear here when committees register through /onboarding." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-slate-900 text-slate-400 uppercase text-[10px] tracking-wider">
                    <tr><th className="py-3 px-4">Society</th><th className="py-3 px-4">Flats / Members</th><th className="py-3 px-4">This month</th><th className="py-3 px-4">Plan</th><th className="py-3 px-4">Status</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-slate-300">
                    {filtered.map(s => (
                      <tr key={s.id} className="hover:bg-slate-900/50">
                        <td className="py-3 px-4">
                          <div className="font-medium text-white">{s.name}</div>
                          <div className="text-slate-500">{s.city}, {s.state} • since {new Date(s.created_at).toLocaleDateString('en-IN')}</div>
                        </td>
                        <td className="py-3 px-4">{s.total_units} / {s.members}</td>
                        <td className="py-3 px-4">{formatINR(s.billed_this_month)} billed<div className="text-slate-500">{formatINR(s.collected_this_month)} collected</div></td>
                        <td className="py-3 px-4">
                          <div className="text-white capitalize">{s.subscription_status === 'trial' ? 'trial' : s.plan_tier ?? '—'}</div>
                          <select value="" disabled={busy === s.id} onChange={e => assignPlan(s, e.target.value)} className="mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-white">
                            <option value="">Give complimentary…</option>
                            {PLANS.map(p => <option key={p.tier} value={p.tier}>{p.label}</option>)}
                          </select>
                          {s.plan_period_end && <div className="text-slate-500 mt-0.5">till {new Date(s.plan_period_end).toLocaleDateString('en-IN')}</div>}
                        </td>
                        <td className="py-3 px-4">
                          <select value={s.subscription_status} disabled={busy === s.id} onChange={e => changeStatus(s, e.target.value as SocietyOverview['subscription_status'])}
                            className={`rounded-lg px-2 py-1 border border-slate-700 font-semibold ${STATUS_STYLES[s.subscription_status]}`}>
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
          <div className="bg-slate-950 border border-slate-800 rounded-2xl divide-y divide-slate-800">
            {leads.length === 0 && <div className="p-4 text-slate-500">No demo requests yet. They arrive from the public Contact page.</div>}
            {leads.map(l => (
              <div key={l.id} className="p-4 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  <div className="font-semibold text-white">{l.society_name} <span className="text-slate-500 font-normal">• {l.city ?? '—'}{l.units ? ` • ${l.units} flats` : ''}</span></div>
                  <div className="text-slate-300">{l.name} • <a href={`mailto:${l.email}`} className="text-sky-400 hover:underline">{l.email}</a> • <a href={`tel:${l.phone}`} className="text-sky-400 hover:underline">{l.phone}</a></div>
                  {l.message && <div className="text-slate-400 whitespace-pre-line">{l.message}</div>}
                  <div className="text-slate-500">{new Date(l.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</div>
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
                  className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-white"
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

        {activeTab === 'users' && (
          <div className="bg-slate-950 border border-slate-800 rounded-2xl overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-slate-900 text-slate-400 uppercase text-[10px]"><tr><th className="py-3 px-4">Name</th><th className="py-3 px-4">Email</th><th className="py-3 px-4">Joined</th></tr></thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-300">
                {usersList.map(u => (
                  <tr key={u.id}>
                    <td className="py-3 px-4 font-medium text-white">{u.full_name}{u.is_platform_admin && <span className="ml-2 text-purple-400">owner</span>}</td>
                    <td className="py-3 px-4 font-mono text-slate-400">{u.email}</td>
                    <td className="py-3 px-4 text-slate-400">{new Date(u.created_at).toLocaleDateString('en-IN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'audit_logs' && (
          <div className="bg-slate-950 border border-slate-800 rounded-2xl divide-y divide-slate-800">
            {auditLogs.length === 0 && <div className="p-4 text-slate-500">No audit events yet.</div>}
            {auditLogs.map(l => (
              <div key={l.id} className="p-3 flex justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-purple-300">{l.action}</div>
                  <div className="text-slate-400 truncate">{societyName(l.society_id)} • {l.entity_type} {l.reason ? `• ${l.reason}` : ''}</div>
                </div>
                <div className="text-slate-500 shrink-0">{new Date(l.timestamp).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};
