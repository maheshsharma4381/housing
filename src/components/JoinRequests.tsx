'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatMobile } from '../lib/mobile';
import { Banner } from './Banner';
import { Card, CardHeader } from './ui/Card';
import { Button } from './ui/Button';
import { fieldClass } from './ui/Field';
import { cn } from './ui/cn';
import { promptDialog, toast } from './ui/feedback';

interface JoinRequestRow {
  id: string;
  full_name: string;
  mobile: string | null;
  flat_hint: string | null;
  created_at: string;
}


const RequestCard: React.FC<{
  r: JoinRequestRow; units: { id: string; unit_number: string }[]; canDecide: boolean; onDone: (msg: string) => void;
}> = ({ r, units, canDecide, onDone }) => {
  const guess = units.find(u => u.unit_number.trim().toLowerCase() === (r.flat_hint ?? '').trim().toLowerCase());
  const [unitId, setUnitId] = useState(guess?.id ?? '');
  const [role, setRole] = useState<'resident_owner' | 'resident_tenant'>('resident_owner');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reject = async () => {
    const reason = await promptDialog({
      title: `Reject ${r.full_name}'s request?`, body: 'They will see your reason.',
      label: 'Reason', minLength: 3, confirmText: 'Reject request', tone: 'danger',
    });
    if (reason) void decide(false, reason);
  };

  const decide = async (approve: boolean, reason = '') => {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc('decide_join_request', {
      p_request_id: r.id, p_approve: approve, p_unit_id: approve ? unitId || null : null,
      p_role: role, p_note: approve ? null : reason,
    });
    setBusy(false);
    if (err) return setError(err.message);
    onDone(approve ? `${r.full_name} has joined.` : `${r.full_name}'s request was rejected.`);
  };

  return (
    <li className="px-4 sm:px-5 py-4 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold text-fg">{r.full_name}</span>
        <span className="text-[13px] text-fg-subtle">{new Date(r.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
      </div>
      <div className="text-[13px] text-fg-muted">
        {r.mobile && <>Mobile <strong className="text-fg font-medium">{formatMobile(r.mobile)}</strong> · </>}
        Says flat <strong className="text-fg font-medium">{r.flat_hint || '—'}</strong>
      </div>
      <Banner tone="error">{error}</Banner>
      {canDecide && (
        <div className="flex flex-wrap items-center gap-2">
          <select className={cn(fieldClass, 'w-auto min-w-36')} value={unitId} onChange={e => setUnitId(e.target.value)} aria-label="Flat">
            <option value="">Choose the flat</option>
            {[...units]
              .sort((a, b) => a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true }))
              .map(u => <option key={u.id} value={u.id}>{u.unit_number}</option>)}
          </select>
          <select className={cn(fieldClass, 'w-auto')} value={role} onChange={e => setRole(e.target.value as typeof role)} aria-label="Role">
            <option value="resident_owner">Owner</option>
            <option value="resident_tenant">Tenant</option>
          </select>
          <Button variant="secondary" className="text-danger hover:text-danger" onClick={reject} disabled={busy}>Reject</Button>
          <Button onClick={() => decide(true)} loading={busy} disabled={!unitId}>Approve</Button>
        </div>
      )}
    </li>
  );
};

/** People who opened the joining link without a matching owner mobile (031). */
export const JoinRequests: React.FC<{
  societyId: string; units: { id: string; unit_number: string }[]; canDecide: boolean; onDecided?: () => void;
}> = ({ societyId, units, canDecide, onDecided }) => {
  const [rows, setRows] = useState<JoinRequestRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!supabase) return;
    const { data, error: err } = await supabase
      .from('join_requests')
      .select('id, full_name, mobile, flat_hint, created_at')
      .eq('society_id', societyId)
      .eq('status', 'pending')
      .order('created_at');
    if (err) setError(err.message);
    else setRows((data ?? []) as JoinRequestRow[]);
  }, [societyId]);

  useEffect(() => {
    load();
  }, [load]);

  if (rows.length === 0 && !error) return null;

  return (
    <Card>
      <CardHeader title="Join requests" description="They opened your joining link. Check who they are, pick their flat, then approve." />
      {error && <div className="px-4 sm:px-5 pt-4"><Banner tone="error">{error}</Banner></div>}
      <ul className="divide-y divide-border">
        {rows.map(r => (
          <RequestCard key={r.id} r={r} units={units} canDecide={canDecide} onDone={(msg) => { toast.success(msg); load(); onDecided?.(); }} />
        ))}
      </ul>
    </Card>
  );
};
