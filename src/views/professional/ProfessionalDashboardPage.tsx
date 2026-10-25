'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase/client';
import { formatINR } from '../../lib/inr';
import { permissionLabel, roleLabel } from '../../lib/professional-permissions';
import { WorkspaceSelector } from '../../components/WorkspaceSelector';
import { EmptyState } from '../../components/EmptyState';
import { FinancialReports } from '../../components/FinancialReports';
import { Gstr2bPanel } from '../../components/Gstr2bPanel';
import { DocumentsVault } from '../../components/DocumentsVault';
import { RemarksPanel } from '../../components/RemarksPanel';
import { AssetRegister } from '../../components/AssetRegister';
import { AdjustmentsPanel } from '../../components/AdjustmentsPanel';
import { PriorYearEditor } from '../../components/PriorYearEditor';
import { Expense } from '../../types/database';
import { Briefcase, FileSpreadsheet, Landmark, Receipt, FolderLock, LogOut, ShieldCheck, Lock, Boxes, Scale } from 'lucide-react';

type Tab = 'gst' | 'financials' | 'expenses' | 'assets' | 'adjustments' | 'documents' | 'remarks' | 'my_societies';

export const ProfessionalDashboardPage: React.FC = () => {
  const { user, profile, professionalGrants, activeSociety, logout } = useAuth();

  const currentGrant = professionalGrants.find(g => activeSociety && g.society_id === activeSociety.id);
  const permissions = currentGrant?.permissions ?? [];
  const allowed: Record<Tab, boolean> = {
    gst: permissions.includes('audit_gst'),
    financials: permissions.includes('view_reports') || permissions.includes('view_ledger'),
    expenses: permissions.includes('view_expenses'),
    assets: permissions.includes('view_expenses') || permissions.includes('view_reports') || permissions.includes('view_ledger'),
    adjustments: permissions.includes('view_reports') || permissions.includes('view_ledger'),
    documents: permissions.includes('view_documents'),
    remarks: Boolean(currentGrant),
    my_societies: true,
  };

  const [activeTab, setActiveTab] = useState<Tab>('my_societies');

  // Land on the first module this grant allows when switching society
  useEffect(() => {
    const first = (['financials', 'gst', 'expenses', 'assets', 'adjustments', 'documents', 'remarks'] as Tab[]).find(t => allowed[t]);
    setActiveTab(first ?? 'my_societies');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSociety?.id]);

  // Access log: the committee sees which modules their professional opened
  useEffect(() => {
    if (!supabase || !user || !activeSociety || !currentGrant || activeTab === 'my_societies') return;
    supabase.from('access_logs').insert({
      society_id: activeSociety.id,
      professional_user_id: user.id,
      module_accessed: activeTab,
      action_performed: 'viewed',
    }).then(({ error }) => {
      if (error) console.warn('Access log warning:', error.message);
    });
  }, [activeTab, activeSociety, currentGrant, user]);

  const tabs: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'financials', label: 'Financial Reports', icon: Landmark },
    { id: 'gst', label: 'GST (GSTR-2B)', icon: FileSpreadsheet },
    { id: 'expenses', label: 'Expenses & TDS', icon: Receipt },
    { id: 'assets', label: 'Fixed Assets', icon: Boxes },
    { id: 'adjustments', label: 'Adjustments & Last Year', icon: Scale },
    { id: 'documents', label: 'Audit Vault', icon: FolderLock },
    { id: 'remarks', label: 'Audit Remarks', icon: ShieldCheck },
    { id: 'my_societies', label: 'My Client Societies', icon: Briefcase },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col md:flex-row">
      <aside className="w-full md:w-72 bg-slate-900 border-r border-slate-800 p-4 shrink-0 flex flex-col justify-between print:hidden">
        <div className="space-y-6">
          <div className="px-2 space-y-1">
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-amber-400">
              <Briefcase className="w-3.5 h-3.5" />
              <span>Professional Portal</span>
            </div>
            <h2 className="text-base font-bold text-white mt-1">{profile?.full_name}</h2>
            <p className="text-xs text-slate-400">{currentGrant ? roleLabel(currentGrant.role) : 'CA & Auditor Console'}</p>
            <div className="pt-2"><WorkspaceSelector /></div>
          </div>

          <nav className="space-y-1">
            {tabs.map(tab => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              const ok = allowed[tab.id];
              return (
                <button
                  key={tab.id}
                  onClick={() => ok && setActiveTab(tab.id)}
                  disabled={!ok}
                  title={ok ? undefined : 'Not included in the access granted by this society'}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-medium transition ${
                    isActive ? 'bg-amber-600 text-white shadow-sm'
                      : ok ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-800 cursor-pointer'
                      : 'text-slate-600 cursor-not-allowed opacity-50'
                  }`}
                >
                  <div className="flex items-center gap-2.5"><Icon className="w-4 h-4" /><span>{tab.label}</span></div>
                  {!ok && <Lock className="w-3 h-3 text-slate-600" />}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="pt-4 border-t border-slate-800 space-y-2 text-xs">
          <div className="truncate text-slate-400 font-mono text-[11px]">{profile?.email}</div>
          <button onClick={() => logout()} className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-rose-400 font-medium cursor-pointer transition">
            <LogOut className="w-3.5 h-3.5" /> <span>Sign Out</span>
          </button>
        </div>
      </aside>

      <main className="flex-1 p-4 md:p-8 overflow-y-auto">
        <div className="pb-6 border-b border-slate-800 mb-6">
          <h1 className="text-xl font-bold text-white flex flex-wrap items-center gap-2">
            <span>{tabs.find(t => t.id === activeTab)?.label}</span>
            <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
              Client: {activeSociety?.name || 'None selected'}
            </span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Read-only access granted by the society committee{currentGrant?.expires_at ? ` until ${new Date(currentGrant.expires_at).toLocaleDateString('en-IN')}` : ''}. Every module you open is logged for the committee.
          </p>
        </div>

        {activeTab === 'financials' && activeSociety && allowed.financials && (
          <FinancialReports societyId={activeSociety.id} societyName={activeSociety.name} />
        )}
        {activeTab === 'gst' && activeSociety && allowed.gst && (
          <Gstr2bPanel societyId={activeSociety.id} societyName={activeSociety.name} />
        )}
        {activeTab === 'expenses' && activeSociety && allowed.expenses && <ExpensesReadOnly societyId={activeSociety.id} />}
        {activeTab === 'assets' && activeSociety && allowed.assets && <AssetRegister societyId={activeSociety.id} canManage={false} />}
        {activeTab === 'adjustments' && activeSociety && allowed.adjustments && (
          <div className="space-y-8">
            <AdjustmentsPanel societyId={activeSociety.id} currentUserId={user?.id} canDecide={false} canPropose />
            <PriorYearEditor societyId={activeSociety.id} canEdit={permissions.includes('view_reports')} />
          </div>
        )}
        {activeTab === 'documents' && activeSociety && allowed.documents && <DocumentsVault societyId={activeSociety.id} canManage={false} />}
        {activeTab === 'remarks' && activeSociety && currentGrant && (
          <RemarksPanel societyId={activeSociety.id} currentUserId={user?.id} mode="professional" />
        )}

        {activeTab === 'my_societies' && (
          professionalGrants.length === 0 ? (
            <EmptyState icon={Briefcase} title="No Active Society Grants" description="When a society committee invites your email, accept the invitation shown at the top of this page." />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {professionalGrants.map(grant => (
                <div key={grant.id} className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold text-white text-sm">{grant.society.name}</h3>
                    <span className="px-2 py-0.5 rounded-full text-[10px] uppercase font-semibold bg-emerald-500/10 text-emerald-400">{grant.status}</span>
                  </div>
                  <div className="text-slate-400">{grant.society.city}, {grant.society.state}</div>
                  <div className="text-amber-300">{roleLabel(grant.role)}{grant.expires_at && ` • until ${new Date(grant.expires_at).toLocaleDateString('en-IN')}`}</div>
                  <div className="flex flex-wrap gap-1 pt-1">
                    {grant.permissions.map(p => <span key={p} className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 text-[10px]">{permissionLabel(p)}</span>)}
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </main>
    </div>
  );
};

type ExpenseRow = Expense & { vendors: { name: string; gstin: string | null } | null };

const ExpensesReadOnly: React.FC<{ societyId: string }> = ({ societyId }) => {
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase) return;
    setLoading(true);
    supabase
      .from('expenses')
      .select('*, vendors (name, gstin)')
      .eq('society_id', societyId)
      .order('invoice_date', { ascending: false, nullsFirst: false })
      .limit(300)
      .then(({ data }) => {
        setRows(((data ?? []) as unknown) as ExpenseRow[]);
        setLoading(false);
      });
  }, [societyId]);

  const live = rows.filter(r => r.status === 'approved' || r.status === 'paid');
  const totals = live.reduce((a, r) => ({ gst: a.gst + Number(r.gst_amount), tds: a.tds + Number(r.tds_deducted ?? 0) }), { gst: 0, tds: 0 });

  if (!loading && rows.length === 0) {
    return <EmptyState icon={Receipt} title="No Expenses" description="The society has not recorded vendor bills yet." />;
  }
  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 rounded-2xl bg-slate-900 border border-slate-800"><div className="text-slate-400">GST on approved bills</div><div className="text-base font-bold text-white">{formatINR(totals.gst)}</div></div>
        <div className="p-3 rounded-2xl bg-slate-900 border border-slate-800"><div className="text-slate-400">TDS deducted</div><div className="text-base font-bold text-white">{formatINR(totals.tds)}</div></div>
      </div>
      <div className="rounded-2xl bg-slate-900 border border-slate-800 overflow-x-auto">
        <table className="w-full text-left">
          <thead className="bg-slate-950 text-slate-400">
            <tr><th className="p-2">No.</th><th className="p-2">Vendor / GSTIN</th><th className="p-2">Invoice</th><th className="p-2 text-right">Taxable</th><th className="p-2 text-right">GST</th><th className="p-2 text-right">TDS</th><th className="p-2">Status</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-800 text-slate-300">
            {rows.map(r => (
              <tr key={r.id}>
                <td className="p-2 font-mono">{r.expense_number}{r.voucher_number && <div className="text-[10px] text-slate-500">{r.voucher_number}</div>}</td>
                <td className="p-2"><div className="text-white">{r.vendors?.name ?? r.payee_name ?? '—'}</div><div className="font-mono text-[10px] text-slate-500">{r.vendors?.gstin ?? 'No GSTIN'}</div></td>
                <td className="p-2">
                  {r.invoice_status === 'none' ? 'No invoice (voucher)' : r.invoice_status === 'pending' ? <span className="text-amber-300">Invoice pending</span> : r.invoice_number ?? '—'}
                  <div className="text-slate-500">{r.invoice_date ?? ''}{r.expense_type === 'capital' ? ' · asset' : ''}</div>
                </td>
                <td className="p-2 text-right">{formatINR(r.subtotal)}</td>
                <td className="p-2 text-right">{formatINR(r.gst_amount)}{r.gst_claimable && <div className="text-[10px] text-emerald-400">ITC</div>}</td>
                <td className="p-2 text-right">{formatINR(r.tds_amount)}{r.tds_section && <div className="text-[10px] text-slate-500">{r.tds_section} {r.tds_rate}%</div>}{r.tds_override_reason && <div className="text-[10px] text-amber-300" title={r.tds_override_reason}>changed</div>}</td>
                <td className="p-2 capitalize">{r.payment_status === 'partial' && r.status === 'approved' ? 'part paid' : r.status.replace('_', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
