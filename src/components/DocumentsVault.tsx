'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { deleteSocietyFile, openSocietyFile, uploadSocietyFile, validateUpload } from '../lib/storage';
import { Banner } from './Banner';
import { EmptyState } from './EmptyState';
import { Document as SocietyDocument } from '../types/database';
import { FolderLock, Upload, Loader2, ExternalLink, Trash2, Lock } from 'lucide-react';

const CATEGORIES: { value: SocietyDocument['category']; label: string }[] = [
  { value: 'bylaws', label: 'Bye-laws' },
  { value: 'agm_minutes', label: 'AGM / Meeting minutes' },
  { value: 'audit_reports', label: 'Audit reports' },
  { value: 'financials', label: 'Financial statements' },
  { value: 'insurance', label: 'Insurance' },
  { value: 'conveyance', label: 'Conveyance / Title' },
  { value: 'noc_forms', label: 'NOC & forms' },
];
const categoryLabel = (c: string) => CATEGORIES.find(x => x.value === c)?.label ?? c;

interface DocumentsVaultProps {
  societyId: string;
  canManage: boolean;
}

export const DocumentsVault: React.FC<DocumentsVaultProps> = ({ societyId, canManage }) => {
  const [docs, setDocs] = useState<SocietyDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<SocietyDocument['category']>('bylaws');
  const [restricted, setRestricted] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const { data, error: loadErr } = await supabase
      .from('documents')
      .select('*')
      .eq('society_id', societyId)
      .order('created_at', { ascending: false });
    if (loadErr) setError(loadErr.message);
    setDocs((data ?? []) as SocietyDocument[]);
    setLoading(false);
  }, [societyId]);

  useEffect(() => {
    load();
  }, [load]);

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || !file) return;
    const problem = validateUpload(file);
    if (problem) return setError(problem);
    setUploading(true);
    setError(null);
    try {
      const path = await uploadSocietyFile(societyId, 'documents', file);
      const { error: insErr } = await supabase.from('documents').insert({
        society_id: societyId,
        category,
        title: title.trim() || file.name,
        file_url: path,
        file_size_kb: Math.ceil(file.size / 1024),
        is_restricted_to_committee: restricted,
        uploaded_by: (await supabase.auth.getUser()).data.user?.id,
      });
      if (insErr) {
        await deleteSocietyFile(path); // don't leave orphaned files
        throw new Error(insErr.message);
      }
      setTitle('');
      setFile(null);
      setRestricted(false);
      setNotice('Document uploaded.');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const open = async (doc: SocietyDocument) => {
    try {
      await openSocietyFile(doc.file_url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (doc: SocietyDocument) => {
    if (!supabase || !window.confirm(`Delete "${doc.title}"?`)) return;
    const { error: delErr } = await supabase.from('documents').delete().eq('id', doc.id);
    if (delErr) return setError(delErr.message);
    await deleteSocietyFile(doc.file_url);
    load();
  };

  const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500';

  return (
    <div className="space-y-5 text-xs">
      <div>
        <h2 className="text-lg font-bold text-white">Documents Vault</h2>
        <p className="text-slate-400">Bye-laws, minutes and audit reports in one place. Files are private and open through expiring links.</p>
      </div>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      {canManage && (
        <form onSubmit={upload} className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title (defaults to file name)" className={inputClass} />
            <select value={category} onChange={e => setCategory(e.target.value as SocietyDocument['category'])} className={inputClass}>
              {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <input
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp"
            onChange={e => { setFile(e.target.files?.[0] ?? null); setNotice(null); }}
            className="block w-full text-slate-300 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-slate-800 file:text-slate-200 file:cursor-pointer"
          />
          <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
            <input type="checkbox" checked={restricted} onChange={e => setRestricted(e.target.checked)} /> Committee only (residents cannot see it)
          </label>
          <button type="submit" disabled={uploading || !file} className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50">
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Upload (PDF / image, max 10 MB)
          </button>
        </form>
      )}

      {docs.length === 0 && !loading ? (
        <EmptyState icon={FolderLock} title="No Documents Yet" description={canManage ? 'Upload bye-laws, AGM minutes or audit reports above.' : 'Your committee has not shared any documents yet.'} />
      ) : (
        <div className="rounded-2xl bg-slate-900 border border-slate-800 divide-y divide-slate-800">
          {docs.map(d => (
            <div key={d.id} className="p-3 flex items-center justify-between gap-3">
              <button onClick={() => open(d)} className="min-w-0 text-left cursor-pointer group">
                <div className="font-semibold text-white truncate group-hover:text-sky-300 flex items-center gap-1.5">
                  {d.is_restricted_to_committee && <Lock className="w-3 h-3 text-amber-400 shrink-0" />}
                  {d.title}
                </div>
                <div className="text-slate-400">{categoryLabel(d.category)} • {new Date(d.created_at).toLocaleDateString('en-IN')} • {d.file_size_kb} KB</div>
              </button>
              <div className="flex items-center gap-3 shrink-0">
                <button onClick={() => open(d)} title="Open" className="text-sky-400 hover:text-sky-300 cursor-pointer"><ExternalLink className="w-4 h-4" /></button>
                {canManage && (
                  <button onClick={() => remove(d)} title="Delete" className="text-slate-500 hover:text-rose-400 cursor-pointer"><Trash2 className="w-4 h-4" /></button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
