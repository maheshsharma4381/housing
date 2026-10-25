'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase/client';
import { SocietySetting } from '../../../types/database';
import { OpeningBalances } from './OpeningBalances';
import { Settings, QrCode, AlertCircle, CheckCircle2, Loader2, Save } from 'lucide-react';

// UPI VPA format: handle@psp (e.g. palmheights@icici)
const UPI_ID_PATTERN = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/;

interface SettingsTabProps {
  societyId: string;
}

type EditableSettings = Pick<
  SocietySetting,
  'upi_id' | 'upi_payee_name' | 'due_day_of_month' | 'late_fee_type' | 'late_fee_amount' | 'require_two_step_expense_approval'
>;

export const SettingsTab: React.FC<SettingsTabProps> = ({ societyId }) => {
  const [settings, setSettings] = useState<EditableSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    setLoading(true);
    supabase
      .from('society_settings')
      .select('upi_id, upi_payee_name, due_day_of_month, late_fee_type, late_fee_amount, require_two_step_expense_approval')
      .eq('society_id', societyId)
      .maybeSingle()
      .then(({ data, error: loadErr }) => {
        if (cancelled) return;
        if (loadErr) setError(loadErr.message);
        setSettings((data as EditableSettings) ?? null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [societyId]);

  const update = <K extends keyof EditableSettings>(key: K, value: EditableSettings[K]) => {
    setSaved(false);
    setSettings(s => (s ? { ...s, [key]: value } : s));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || !settings) return;
    setError(null);

    const upi = settings.upi_id?.trim() ?? '';
    if (upi && !UPI_ID_PATTERN.test(upi)) {
      setError('UPI ID looks invalid. It should look like name@bank (e.g. palmheights@icici).');
      return;
    }
    if (settings.due_day_of_month < 1 || settings.due_day_of_month > 28) {
      setError('Due day must be between 1 and 28.');
      return;
    }

    setSaving(true);
    const { error: saveErr } = await supabase
      .from('society_settings')
      .update({
        upi_id: upi || null,
        upi_payee_name: settings.upi_payee_name?.trim() || null,
        due_day_of_month: settings.due_day_of_month,
        late_fee_type: settings.late_fee_type,
        late_fee_amount: settings.late_fee_amount,
        require_two_step_expense_approval: settings.require_two_step_expense_approval,
        updated_at: new Date().toISOString(),
      })
      .eq('society_id', societyId);
    setSaving(false);

    if (saveErr) {
      setError(saveErr.message);
      return;
    }
    setSaved(true);
  };

  const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500';

  if (loading) {
    return <div className="flex items-center gap-2 text-xs text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading settings…</div>;
  }

  if (!settings) {
    return (
      <div className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
        {error ?? 'Settings not found for this society.'}
      </div>
    );
  }

  return (
    <div className="space-y-6">
    <form onSubmit={handleSave} className="space-y-6 text-xs">
      <div>
        <h2 className="text-lg font-bold text-white flex items-center gap-2"><Settings className="w-4 h-4 text-sky-400" /> Society Rules</h2>
        <p className="text-slate-400">Collection account, due dates and late fee policy.</p>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      {saved && (
        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          <span>Settings saved.</span>
        </div>
      )}

      <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
        <div className="flex items-center gap-2 font-bold text-white text-sm"><QrCode className="w-4 h-4 text-emerald-400" /> UPI Collection Account</div>
        <p className="text-slate-400">
          Residents see a QR code for this UPI ID with the exact due amount. Use the society&apos;s bank account VPA, never a personal one.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="block text-slate-400 font-medium">Society UPI ID</span>
            <input value={settings.upi_id ?? ''} onChange={e => update('upi_id', e.target.value)} placeholder="palmheights@icici" className={inputClass} />
          </label>
          <label className="space-y-1">
            <span className="block text-slate-400 font-medium">Payee Name (as per bank)</span>
            <input value={settings.upi_payee_name ?? ''} onChange={e => update('upi_payee_name', e.target.value)} placeholder="Palm Heights CHS Ltd" className={inputClass} />
          </label>
        </div>
      </section>

      <section className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
        <div className="font-bold text-white text-sm">Billing Rules</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="space-y-1">
            <span className="block text-slate-400 font-medium">Due Day of Month</span>
            <input type="number" min={1} max={28} value={settings.due_day_of_month} onChange={e => update('due_day_of_month', Number(e.target.value))} className={inputClass} />
          </label>
          <label className="space-y-1">
            <span className="block text-slate-400 font-medium">Late Fee Type</span>
            <select value={settings.late_fee_type} onChange={e => update('late_fee_type', e.target.value as EditableSettings['late_fee_type'])} className={inputClass}>
              <option value="percentage">% of due per month</option>
              <option value="flat">Flat ₹ amount</option>
              <option value="none">No late fee</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-slate-400 font-medium">{settings.late_fee_type === 'flat' ? 'Late Fee (₹)' : 'Late Fee (%)'}</span>
            <input type="number" min={0} step="0.01" disabled={settings.late_fee_type === 'none'} value={settings.late_fee_amount} onChange={e => update('late_fee_amount', Number(e.target.value))} className={`${inputClass} disabled:opacity-50`} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
          <input type="checkbox" checked={settings.require_two_step_expense_approval} onChange={e => update('require_two_step_expense_approval', e.target.checked)} />
          <span>Require two committee approvals for every expense</span>
        </label>
      </section>

      <button
        type="submit"
        disabled={saving}
        className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        <span>{saving ? 'Saving…' : 'Save Settings'}</span>
      </button>
    </form>
    <OpeningBalances societyId={societyId} />
    </div>
  );
};
