'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase/client';
import { parseUnitCsv, UNIT_CSV_TEMPLATE } from '../../../lib/unit-csv';
import { EmptyState } from '../../../components/EmptyState';
import { OwnerChange } from '../../../components/OwnerChange';
import { OwnerHistory } from '../../../components/OwnerHistory';
import { OwnerContactEdit, OwnerPaste } from '../../../components/OwnerContacts';
import { formatMobile } from '../../../lib/mobile';
import { Unit } from '../../../types/database';
import { Building2, Upload, FileDown, AlertCircle, CheckCircle2, Loader2, X, ClipboardPaste } from 'lucide-react';

interface UnitsTabProps {
  societyId: string;
  societyName?: string;
  units: Unit[];
  loading: boolean;
  onChanged: () => void;
  /** secretary / chairman / treasurer / society admin may record an owner change */
  canManage?: boolean;
}

export const UnitsTab: React.FC<UnitsTabProps> = ({ societyId, societyName, units, loading, onChanged, canManage = false }) => {
  const [panel, setPanel] = useState<{ unitId: string; kind: 'owners' | 'change' | 'contact' } | null>(null);
  const toggle = (unitId: string, kind: 'owners' | 'change' | 'contact') =>
    setPanel(p => (p && p.unitId === unitId && p.kind === kind ? null : { unitId, kind }));
  const [showImport, setShowImport] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  // The owner each flat expects (031): committee-only, so it is not part of units
  const [contacts, setContacts] = useState<Record<string, { owner_name: string | null; owner_mobile: string | null }>>({});
  useEffect(() => {
    if (!supabase || !canManage) return;
    supabase.from('unit_owner_contacts').select('unit_id, owner_name, owner_mobile').eq('society_id', societyId)
      .then(({ data }) => setContacts(Object.fromEntries((data ?? []).map(c => [c.unit_id, c]))));
  }, [societyId, canManage, units]);
  const [csvText, setCsvText] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [rpcError, setRpcError] = useState<string | null>(null);

  const parsed = useMemo(() => (csvText.trim() ? parseUnitCsv(csvText) : null), [csvText]);
  const templateHref = `data:text/csv;charset=utf-8,${encodeURIComponent(UNIT_CSV_TEMPLATE)}`;

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setResult(null);
    setRpcError(null);
    setCsvText(await file.text());
  };

  const handleImport = async () => {
    if (!supabase || !parsed || parsed.rows.length === 0) return;
    setImporting(true);
    setRpcError(null);
    const { data, error } = await supabase.rpc('bulk_upsert_units', {
      p_society_id: societyId,
      p_units: parsed.rows,
    });
    setImporting(false);

    if (error) {
      setRpcError(error.message);
      return;
    }
    const r = data as { inserted: number; updated: number; total_units: number };
    setResult(`Imported ${r.inserted} new and updated ${r.updated} existing flats. Society now has ${r.total_units} flats.`);
    setCsvText('');
    setShowImport(false);
    onChanged();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-fg">Flats</h2>
          <p className="text-xs text-fg-muted">{units.length} flats mapped for {societyName}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
        {canManage && units.length > 0 && (
          <button
            onClick={() => setShowPaste(v => !v)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-surface-muted hover:bg-border text-fg text-xs font-semibold cursor-pointer"
          >
            {showPaste ? <X className="w-3.5 h-3.5" /> : <ClipboardPaste className="w-3.5 h-3.5" />}
            <span>{showPaste ? 'Close' : 'Paste owners from Excel'}</span>
          </button>
        )}
        <button
          onClick={() => setShowImport(v => !v)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand text-xs font-semibold cursor-pointer"
        >
          {showImport ? <X className="w-3.5 h-3.5" /> : <Upload className="w-3.5 h-3.5" />}
          <span>{showImport ? 'Close' : 'Import Flats (CSV)'}</span>
        </button>
        </div>
      </div>

      {showPaste && canManage && <OwnerPaste societyId={societyId} units={units} onDone={onChanged} />}

      {result && (
        <div className="p-3.5 rounded-xl bg-success-soft border border-success/30 text-xs text-success flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{result}</span>
        </div>
      )}

      {showImport && (
        <div className="p-5 rounded-xl bg-surface border border-border space-y-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-fg-muted">
              Upload a CSV with columns <code className="text-brand">building, wing, floor, unit_number, unit_type, carpet_area_sqft, occupancy_status</code>.
              Existing flats (same wing + number) are updated, not duplicated.
            </p>
            <a href={templateHref} download="sahvaas-flats-template.csv" className="flex items-center gap-1 text-brand font-semibold hover:underline">
              <FileDown className="w-3.5 h-3.5" /> Download template
            </a>
          </div>

          <input
            type="file"
            accept=".csv,text/csv"
            onChange={e => handleFile(e.target.files?.[0])}
            className="block w-full text-fg file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border file:border-border-strong file:bg-surface-muted file:text-fg file:cursor-pointer"
          />

          <textarea
            rows={6}
            value={csvText}
            onChange={e => setCsvText(e.target.value)}
            placeholder="…or paste CSV here"
            className="w-full bg-surface border border-border-strong rounded-lg p-3 font-mono text-xs text-fg outline-none focus:border-brand"
          />

          {parsed && (
            <div className="space-y-2">
              <div className="text-fg">
                <strong className="text-fg">{parsed.rows.length}</strong> flats ready to import
                {parsed.errors.length > 0 && <>, <strong className="text-danger">{parsed.errors.length}</strong> rows skipped</>}
              </div>
              {parsed.errors.length > 0 && (
                <ul className="max-h-32 overflow-y-auto p-3 rounded-xl bg-danger-soft border border-danger/20 text-danger space-y-0.5">
                  {parsed.errors.slice(0, 50).map(e => <li key={e}>{e}</li>)}
                </ul>
              )}
            </div>
          )}

          {rpcError && (
            <div className="p-3 rounded-xl bg-danger-soft border border-danger/30 text-danger flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{rpcError}</span>
            </div>
          )}

          <button
            onClick={handleImport}
            disabled={importing || !parsed || parsed.rows.length === 0}
            className="w-full py-2.5 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            <span>{importing ? 'Importing…' : `Import ${parsed?.rows.length ?? 0} Flats`}</span>
          </button>
        </div>
      )}

      {units.length === 0 && !loading ? (
        <EmptyState
          icon={Building2}
          title="No Flats Recorded Yet"
          description="Import your building wings and flat numbers from a CSV to start managing occupancy and billing."
          actionText="Import Flats"
          onAction={() => setShowImport(true)}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[...units]
            .sort((a, b) => a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true }))
            .map(u => (
              <div key={u.id} className="p-4 rounded-xl bg-surface border border-border space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-base text-fg">{u.unit_number}</span>
                  <span className="px-2 py-0.5 rounded-full text-xs font-semibold uppercase bg-brand-soft text-brand">
                    {u.occupancy_status?.replace('_', ' ')}
                  </span>
                </div>
                <div className="text-fg-muted">
                  Type: <strong className="text-fg">{u.unit_type}</strong> • Area: {u.carpet_area_sqft} sqft
                </div>
                {(contacts[u.id]?.owner_name || contacts[u.id]?.owner_mobile) && (
                  <div className="text-fg-muted">
                    Owner: <strong className="text-fg">{[contacts[u.id]?.owner_name, formatMobile(contacts[u.id]?.owner_mobile)].filter(Boolean).join(' · ')}</strong>
                  </div>
                )}
                <div className="flex flex-wrap gap-3">
                  <button onClick={() => toggle(u.id, 'owners')} className="text-brand hover:underline cursor-pointer">Owners</button>
                  {canManage && <button onClick={() => toggle(u.id, 'contact')} className="text-brand hover:underline cursor-pointer">Owner mobile</button>}
                  {canManage && <button onClick={() => toggle(u.id, 'change')} className="text-brand hover:underline cursor-pointer">Owner change</button>}
                </div>
                {panel?.unitId === u.id && panel.kind === 'owners' && <OwnerHistory societyId={societyId} unitId={u.id} />}
                {panel?.unitId === u.id && panel.kind === 'contact' && (
                  <OwnerContactEdit
                    societyId={societyId} unitId={u.id} name={contacts[u.id]?.owner_name} mobile={contacts[u.id]?.owner_mobile}
                    onDone={() => { setPanel(null); onChanged(); }}
                  />
                )}
                {panel?.unitId === u.id && panel.kind === 'change' && (
                  <OwnerChange societyId={societyId} unitId={u.id} unitLabel={`Flat ${u.unit_number}`} onDone={onChanged} />
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
};
