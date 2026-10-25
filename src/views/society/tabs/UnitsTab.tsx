'use client';

import React, { useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase/client';
import { parseUnitCsv, UNIT_CSV_TEMPLATE } from '../../../lib/unit-csv';
import { EmptyState } from '../../../components/EmptyState';
import { Unit } from '../../../types/database';
import { Building2, Upload, FileDown, AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';

interface UnitsTabProps {
  societyId: string;
  societyName?: string;
  units: Unit[];
  loading: boolean;
  onChanged: () => void;
}

export const UnitsTab: React.FC<UnitsTabProps> = ({ societyId, societyName, units, loading, onChanged }) => {
  const [showImport, setShowImport] = useState(false);
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
          <h2 className="text-lg font-bold text-white">Flats & Occupancy Roster</h2>
          <p className="text-xs text-slate-400">{units.length} flats mapped for {societyName}</p>
        </div>
        <button
          onClick={() => setShowImport(v => !v)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold cursor-pointer"
        >
          {showImport ? <X className="w-3.5 h-3.5" /> : <Upload className="w-3.5 h-3.5" />}
          <span>{showImport ? 'Close' : 'Import Flats (CSV)'}</span>
        </button>
      </div>

      {result && (
        <div className="p-3.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{result}</span>
        </div>
      )}

      {showImport && (
        <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-slate-400">
              Upload a CSV with columns <code className="text-sky-300">building, wing, floor, unit_number, unit_type, carpet_area_sqft, occupancy_status</code>.
              Existing flats (same wing + number) are updated, not duplicated.
            </p>
            <a href={templateHref} download="sahvaas-flats-template.csv" className="flex items-center gap-1 text-sky-400 font-semibold hover:underline">
              <FileDown className="w-3.5 h-3.5" /> Download template
            </a>
          </div>

          <input
            type="file"
            accept=".csv,text/csv"
            onChange={e => handleFile(e.target.files?.[0])}
            className="block w-full text-slate-300 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-slate-800 file:text-slate-200 file:cursor-pointer"
          />

          <textarea
            rows={6}
            value={csvText}
            onChange={e => setCsvText(e.target.value)}
            placeholder="…or paste CSV here"
            className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 font-mono text-[11px] text-white outline-none focus:border-sky-500"
          />

          {parsed && (
            <div className="space-y-2">
              <div className="text-slate-300">
                <strong className="text-white">{parsed.rows.length}</strong> flats ready to import
                {parsed.errors.length > 0 && <>, <strong className="text-rose-300">{parsed.errors.length}</strong> rows skipped</>}
              </div>
              {parsed.errors.length > 0 && (
                <ul className="max-h-32 overflow-y-auto p-3 rounded-xl bg-rose-500/5 border border-rose-500/20 text-rose-300 space-y-0.5">
                  {parsed.errors.slice(0, 50).map(e => <li key={e}>{e}</li>)}
                </ul>
              )}
            </div>
          )}

          {rpcError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{rpcError}</span>
            </div>
          )}

          <button
            onClick={handleImport}
            disabled={importing || !parsed || parsed.rows.length === 0}
            className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
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
              <div key={u.id} className="p-4 rounded-2xl bg-slate-900 border border-slate-800 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-base text-white">{u.unit_number}</span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-sky-500/10 text-sky-400">
                    {u.occupancy_status?.replace('_', ' ')}
                  </span>
                </div>
                <div className="text-slate-400">
                  Type: <strong className="text-white">{u.unit_type}</strong> • Area: {u.carpet_area_sqft} sqft
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
};
