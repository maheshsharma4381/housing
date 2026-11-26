'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase/client';
import { COMMITTEE_ROLES } from '../../../context/AuthContext';
import { EmptyState } from '../../../components/EmptyState';
import { ComplaintThread, CommitteeOption } from '../../../components/ComplaintThread';
import { Complaint, ComplaintStatus, Unit } from '../../../types/database';
import { MessageSquare, ChevronDown, ChevronUp } from 'lucide-react';

const STATUS_STYLES: Record<ComplaintStatus, string> = {
  open: 'bg-danger-soft text-danger',
  in_progress: 'bg-warning-soft text-warning',
  resolved: 'bg-success-soft text-success',
  closed: 'bg-surface-muted text-fg-muted',
};
const PRIORITY_STYLES: Record<Complaint['priority'], string> = {
  low: 'text-fg-muted',
  medium: 'text-brand',
  high: 'text-warning',
  urgent: 'text-danger font-semibold',
};

interface ComplaintsTabProps {
  societyId: string;
  currentUserId?: string;
  complaints: Complaint[];
  units: Unit[];
  onChanged: () => void;
}

export const ComplaintsTab: React.FC<ComplaintsTabProps> = ({ societyId, currentUserId, complaints, units, onChanged }) => {
  const [filter, setFilter] = useState<'active' | ComplaintStatus | 'all'>('active');
  const [openId, setOpenId] = useState<string | null>(null);
  const [committee, setCommittee] = useState<CommitteeOption[]>([]);

  useEffect(() => {
    if (!supabase) return;
    supabase
      .from('society_memberships')
      .select('user_id, role, profiles:user_id (full_name)')
      .eq('society_id', societyId)
      .eq('is_active', true)
      .in('role', COMMITTEE_ROLES)
      .then(({ data }) => {
        const rows = ((data ?? []) as unknown) as { user_id: string; role: string; profiles: { full_name: string } | null }[];
        const unique = new Map(rows.map(r => [r.user_id, `${r.profiles?.full_name ?? 'Member'} (${r.role.replace('_', ' ')})`]));
        setCommittee([...unique].map(([user_id, name]) => ({ user_id, name })));
      });
  }, [societyId]);

  const unitNumber = (id: string) => units.find(u => u.id === id)?.unit_number ?? '—';
  const visible = complaints.filter(c =>
    filter === 'all' ? true : filter === 'active' ? c.status === 'open' || c.status === 'in_progress' : c.status === filter
  );

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-fg">Complaints</h2>
          <p className="text-fg-muted">Residents raise tickets from their phone; reply, assign and resolve here.</p>
        </div>
        <select value={filter} onChange={e => setFilter(e.target.value as typeof filter)} className="bg-surface border border-border-strong rounded-lg px-2 py-1.5 text-fg">
          <option value="active">Open & in progress</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
          <option value="all">All</option>
        </select>
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={MessageSquare} title="No Tickets Here" description="No complaints match this filter." />
      ) : (
        visible.map(c => (
          <div key={c.id} className="p-4 rounded-xl bg-surface border border-border">
            <button onClick={() => setOpenId(openId === c.id ? null : c.id)} className="w-full flex items-start justify-between gap-3 text-left cursor-pointer">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                  <span className="font-mono">{c.ticket_number}</span>
                  <span>• Flat {unitNumber(c.unit_id)}</span>
                  <span>• {c.category}</span>
                  <span className={PRIORITY_STYLES[c.priority]}>• {c.priority}</span>
                  <span>• {new Date(c.created_at).toLocaleDateString('en-IN')}</span>
                </div>
                <h4 className="font-semibold text-fg text-sm truncate">{c.title}</h4>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`px-2 py-0.5 rounded-full text-xs uppercase font-semibold ${STATUS_STYLES[c.status]}`}>{c.status.replace('_', ' ')}</span>
                {openId === c.id ? <ChevronUp className="w-4 h-4 text-fg-muted" /> : <ChevronDown className="w-4 h-4 text-fg-muted" />}
              </div>
            </button>
            {openId === c.id && (
              <ComplaintThread complaint={c} currentUserId={currentUserId} canManage committee={committee} onChanged={onChanged} />
            )}
          </div>
        ))
      )}
    </div>
  );
};
