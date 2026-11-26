'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase/client';
import { contactText } from '../../lib/mobile';
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
import { ChartOfAccounts } from '../../components/ChartOfAccounts';
import { BillTypes } from '../../components/BillTypes';
import { PartyLedgers } from '../../components/PartyLedgers';
import { OpeningBalanceEditor } from '../../components/OpeningBalanceEditor';
import { BankReconciliation } from '../../components/BankReconciliation';
import { YearLockPanel } from '../../components/YearLockPanel';
import { Expense } from '../../types/database';
import { Briefcase, FileSpreadsheet, Landmark, Receipt, FolderLock, LogOut, ShieldCheck, Lock, Boxes, Scale, ListTree, Tags, BookOpen, BarChart3 } from 'lucide-react';
import { LogoutEverywhereButton } from '../../components/SignOutMenu';
import { Logo } from '../../components/ui/Logo';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { cn } from '../../components/ui/cn';

type Tab = 'gst' | 'financials' | 'ledgers' | 'billtypes' | 'opening' | 'expenses' | 'assets' | 'bank' | 'adjustments' | 'documents' | 'remarks' | 'my_societies';

export const ProfessionalDashboardPage: React.FC = () => {
  const { user, profile, professionalGrants, activeSociety, logout } = useAuth();

  const currentGrant = professionalGrants.find(g => activeSociety && g.society_id === activeSociety.id);
  const permissions = currentGrant?.permissions ?? [];
  const [bankMatch, setBankMatch] = useState(false);
  const bankPermission = permissions.includes('manage_accounts') || permissions.includes('view_bank_reconciliation');
  const allowed: Record<Tab, boolean> = {
    gst: permissions.includes('audit_gst'),
    financials: permissions.includes('view_reports') || permissions.includes('view_ledger'),
    ledgers: permissions.includes('manage_accounts') || permissions.includes('view_reports') || permissions.includes('view_ledger'),
    billtypes: permissions.includes('manage_accounts') || permissions.includes('view_expenses'),
    opening: permissions.includes('manage_accounts') || permissions.includes('view_reports') || permissions.includes('view_ledger'),
    expenses: permissions.includes('view_expenses'),
    assets: permissions.includes('view_expenses') || permissions.includes('view_reports') || permissions.includes('view_ledger'),
    bank: bankPermission && bankMatch,
    adjustments: permissions.includes('view_reports') || permissions.includes('view_ledger'),
    documents: permissions.includes('view_documents'),
    remarks: Boolean(currentGrant),
    my_societies: true,
  };

  const [activeTab, setActiveTab] = useState<Tab>('my_societies');

  // Land on the first module this grant allows when switching society
  useEffect(() => {
    const first = (['financials', 'ledgers', 'billtypes', 'opening', 'gst', 'expenses', 'assets', 'bank', 'adjustments', 'documents', 'remarks'] as Tab[]).find(t => allowed[t]);
    setActiveTab(first ?? 'my_societies');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSociety?.id]);

  // Bank statement match follows the society's plan, as it does for the secretary
  useEffect(() => {
    if (!supabase || !activeSociety) return;
    supabase.rpc('society_has_feature', { p_society_id: activeSociety.id, p_key: 'bank_match' })
      .then(({ data }) => setBankMatch(Boolean(data)));
  }, [activeSociety]);

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
    { id: 'financials', label: 'Financial Reports', icon: BarChart3 },
    { id: 'ledgers', label: 'Groups & Ledgers', icon: ListTree },
    { id: 'billtypes', label: 'Bill Types', icon: Tags },
    { id: 'opening', label: 'Opening Balance', icon: BookOpen },
    { id: 'gst', label: 'GST (GSTR-2B)', icon: FileSpreadsheet },
    { id: 'expenses', label: 'Expenses & TDS', icon: Receipt },
    { id: 'assets', label: 'Fixed Assets', icon: Boxes },
    { id: 'bank', label: 'Bank Reconciliation', icon: Landmark },
    { id: 'adjustments', label: 'Audit & Year Close', icon: Scale },
    { id: 'documents', label: 'Audit Vault', icon: FolderLock },
    { id: 'remarks', label: 'Audit Remarks', icon: ShieldCheck },
    { id: 'my_societies', label: 'My client societies', icon: Briefcase },
  ];

  return (
    <div className="min-h-screen bg-canvas text-fg text-sm flex flex-col md:flex-row">
      <aside className="w-full md:w-[248px] shrink-0 flex flex-col gap-4 md:gap-5 bg-surface border-b md:border-b-0 md:border-r border-border px-3 py-4 md:py-5 print:hidden md:sticky md:top-0 md:h-screen md:overflow-y-auto">
        <div className="px-2 flex items-center justify-between gap-2"><Logo /><Badge tone="brand">CA portal</Badge></div>
        <div className="px-1 space-y-2">
          <div className="px-2">
            <div className="font-semibold text-fg truncate">{profile?.full_name || 'My profile'}</div>
            <div className="text-xs text-fg-subtle">{currentGrant ? roleLabel(currentGrant.role) : 'CA & auditor'}</div>
          </div>
          <WorkspaceSelector />
        </div>

        <nav aria-label="CA portal" className="flex md:flex-col gap-1 md:gap-0.5 overflow-x-auto md:overflow-visible -mx-1 px-1 md:mx-0 md:px-0 md:flex-1">
          {tabs.map(tab => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            const ok = allowed[tab.id];
            return (
              <button
                key={tab.id}
                onClick={() => ok && setActiveTab(tab.id)}
                disabled={!ok}
                aria-current={isActive ? 'page' : undefined}
                title={ok ? undefined : tab.id === 'bank' && bankPermission ? 'Bank statement match is part of the Pro plan' : 'Not included in the access granted by this society'}
                className={cn('shrink-0 md:w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm whitespace-nowrap text-left transition duration-150',
                  isActive ? 'bg-brand-soft text-brand-ink font-semibold'
                    : ok ? 'text-fg-muted font-medium hover:bg-surface-muted hover:text-fg cursor-pointer'
                    : 'text-fg-subtle opacity-60 cursor-not-allowed')}
              >
                <Icon className="w-5 h-5 shrink-0" />
                <span className="flex-1">{tab.label}</span>
                {!ok && <Lock className="w-3.5 h-3.5" aria-label="Locked" />}
              </button>
            );
          })}
        </nav>

        <div className="hidden md:block pt-4 border-t border-border space-y-2 px-1">
          <div className="px-2 text-xs text-fg-subtle truncate">{contactText(profile)}</div>
          <Button variant="ghost" size="sm" className="w-full justify-start text-danger hover:text-danger" leftIcon={<LogOut className="w-4 h-4" />} onClick={() => logout()}>
            Sign out
          </Button>
          <LogoutEverywhereButton />
        </div>
      </aside>

      <main className="flex-1 min-w-0 w-full max-w-[1440px] mx-auto px-4 py-5 md:px-6 md:py-6 lg:px-8 lg:py-8">
        {/* the client and what this grant allows, always in view (brief: sticky context bar) */}
        <div className="mb-6 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl leading-8 font-semibold tracking-tight">{tabs.find(t => t.id === activeTab)?.label}</h1>
            <Badge tone="brand">{activeSociety?.name || 'No client selected'}</Badge>
          </div>
          <p className="text-[13px] text-fg-muted">
            {permissions.includes('manage_accounts') ? 'Access' : 'Read-only access'} granted by the society committee{currentGrant?.expires_at ? ` until ${new Date(currentGrant.expires_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}. Every module you open is logged for the committee.
          </p>
        </div>

        {activeTab === 'financials' && activeSociety && allowed.financials && (
          <FinancialReports societyId={activeSociety.id} societyName={activeSociety.name} />
        )}
        {activeTab === 'ledgers' && activeSociety && allowed.ledgers && (
          <div className="space-y-6">
            <ChartOfAccounts societyId={activeSociety.id} canManage={permissions.includes('manage_accounts')} />
            <PartyLedgers societyId={activeSociety.id} />
          </div>
        )}
        {activeTab === 'billtypes' && activeSociety && allowed.billtypes && (
          <BillTypes societyId={activeSociety.id} canManage={permissions.includes('manage_accounts')} />
        )}
        {activeTab === 'opening' && activeSociety && allowed.opening && (
          <OpeningBalanceEditor societyId={activeSociety.id} canManage={permissions.includes('manage_accounts')} />
        )}
        {activeTab === 'gst' && activeSociety && allowed.gst && (
          <Gstr2bPanel societyId={activeSociety.id} societyName={activeSociety.name} />
        )}
        {activeTab === 'expenses' && activeSociety && allowed.expenses && <ExpensesReadOnly societyId={activeSociety.id} />}
        {activeTab === 'assets' && activeSociety && allowed.assets && <AssetRegister societyId={activeSociety.id} canManage={permissions.includes('manage_accounts')} />}
        {activeTab === 'bank' && activeSociety && allowed.bank && (
          <BankReconciliation societyId={activeSociety.id} canManage={permissions.includes('manage_accounts')} canVerify={false} />
        )}
        {activeTab === 'adjustments' && activeSociety && allowed.adjustments && (
          <div className="space-y-8">
            <AdjustmentsPanel societyId={activeSociety.id} currentUserId={user?.id} canDecide={false} canPropose />
            <YearLockPanel societyId={activeSociety.id} canLock={permissions.includes('manage_accounts')} />
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
                <div key={grant.id} className="p-5 rounded-xl bg-surface border border-border space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-fg text-sm">{grant.society.name}</h3>
                    <span className="px-2 py-0.5 rounded-lg text-xs font-medium bg-success-soft text-success capitalize">{grant.status}</span>
                  </div>
                  <div className="text-fg-muted">{grant.society.city}, {grant.society.state}</div>
                  <div className="text-warning">{roleLabel(grant.role)}{grant.expires_at && ` • until ${new Date(grant.expires_at).toLocaleDateString('en-IN')}`}</div>
                  <div className="flex flex-wrap gap-1 pt-1">
                    {grant.permissions.map(p => <span key={p} className="px-2 py-0.5 rounded-full bg-surface-muted text-fg text-xs">{permissionLabel(p)}</span>)}
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
        <div className="p-3 rounded-xl bg-surface border border-border"><div className="text-fg-muted">GST on approved bills</div><div className="text-base font-semibold text-fg">{formatINR(totals.gst)}</div></div>
        <div className="p-3 rounded-xl bg-surface border border-border"><div className="text-fg-muted">TDS deducted</div><div className="text-base font-semibold text-fg">{formatINR(totals.tds)}</div></div>
      </div>
      <div className="rounded-xl bg-surface border border-border overflow-x-auto">
        <table className="w-full text-left">
          <thead className="bg-canvas text-fg-muted">
            <tr><th className="p-2">No.</th><th className="p-2">Vendor / GSTIN</th><th className="p-2">Invoice</th><th className="p-2 text-right">Taxable</th><th className="p-2 text-right">GST</th><th className="p-2 text-right">TDS</th><th className="p-2">Status</th></tr>
          </thead>
          <tbody className="divide-y divide-border text-fg">
            {rows.map(r => (
              <tr key={r.id}>
                <td className="p-2 font-mono">{r.expense_number}{r.voucher_number && <div className="text-xs text-fg-subtle">{r.voucher_number}</div>}</td>
                <td className="p-2"><div className="text-fg">{r.vendors?.name ?? r.payee_name ?? '—'}</div><div className="font-mono text-xs text-fg-subtle">{r.vendors?.gstin ?? 'No GSTIN'}</div></td>
                <td className="p-2">
                  {r.invoice_status === 'none' ? 'No invoice (voucher)' : r.invoice_status === 'pending' ? <span className="text-warning">Invoice pending</span> : r.invoice_number ?? '—'}
                  <div className="text-fg-subtle">{r.invoice_date ?? ''}{r.expense_type === 'capital' ? ' · asset' : ''}</div>
                </td>
                <td className="p-2 text-right">{formatINR(r.subtotal)}</td>
                <td className="p-2 text-right">{formatINR(r.gst_amount)}{r.gst_claimable && <div className="text-xs text-success">ITC</div>}</td>
                <td className="p-2 text-right">{formatINR(r.tds_amount)}{r.tds_section && <div className="text-xs text-fg-subtle">{r.tds_section} {r.tds_rate}%</div>}{r.tds_override_reason && <div className="text-xs text-warning" title={r.tds_override_reason}>changed</div>}</td>
                <td className="p-2 capitalize">{r.payment_status === 'partial' && r.status === 'approved' ? 'part paid' : r.status.replace('_', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
