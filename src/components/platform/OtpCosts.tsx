'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase/client';
import { formatINR } from '../../lib/inr';
import { formatMobile } from '../../lib/mobile';
import { Banner } from '../Banner';
import { AlertTriangle, Ban, Loader2, Save } from 'lucide-react';

interface Overview {
  days: number;
  totals: { whatsapp: number; sms: number; foreign: number; console: number; failed: number; refused: number; cost: number };
  societies: { society_id: string; name: string; flats: number; sent: number; cost: number; sent_year: number; alert: boolean }[];
  unattributed: number;
  settings: Record<string, number | string | null>;
  blocked: { mobile: string; reason: string | null; created_at: string }[];
}

const SETTING_FIELDS: { key: string; label: string; step?: string }[] = [
  { key: 'per_number_daily', label: 'Codes per number a day' },
  { key: 'unknown_per_number_daily', label: 'Codes a day for an unregistered number' },
  { key: 'platform_daily_cap', label: 'Codes a day to unregistered numbers, whole platform' },
  { key: 'known_daily_cap', label: 'Codes a day to registered numbers, whole platform' },
  { key: 'resend_seconds', label: 'Seconds before "Resend"' },
  { key: 'cost_whatsapp', label: '₹ per WhatsApp code', step: '0.001' },
  { key: 'cost_sms', label: '₹ per SMS code', step: '0.001' },
  { key: 'cost_foreign', label: '₹ per code to a foreign number', step: '0.001' },
];

const inputClass = 'w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand';

/** Spec 11 item 1: what login codes cost, per society and in all, with the limits and blocked numbers. */
export const OtpCosts: React.FC = () => {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Overview | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [block, setBlock] = useState({ mobile: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data: d, error: err } = await supabase.rpc('otp_overview', { p_days: days });
    if (err) return setError(err.message);
    const o = d as Overview;
    setData(o);
    setForm(Object.fromEntries(SETTING_FIELDS.map(f => [f.key, String(o.settings?.[f.key] ?? '')])));
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { error: err } = await fn();
    setBusy(false);
    if (err) return setError(err.message);
    setNotice(done);
    load();
  };

  const saveSettings = () => run(() => supabase!.rpc('set_otp_settings', {
    p: Object.fromEntries(SETTING_FIELDS.filter(f => form[f.key] !== '').map(f => [f.key, Number(form[f.key])])),
  }), 'Limits saved.');

  if (!data) return error ? <Banner tone="error">{error}</Banner> : <Loader2 className="w-5 h-5 animate-spin text-brand-ink" />;
  const t = data.totals;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-fg">OTP &amp; cost</h2>
          <p className="text-fg-muted">Login codes sent and what they cost (before GST).</p>
        </div>
        <select value={days} onChange={e => setDays(Number(e.target.value))} className="bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={365}>Last 12 months</option>
        </select>
      </div>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          ['WhatsApp', t.whatsapp], ['SMS', t.sms], ['Foreign numbers', t.foreign], ['Estimated cost', formatINR(Number(t.cost))],
        ].map(([label, v]) => (
          <div key={label as string} className="p-4 rounded-xl bg-surface border border-border">
            <div className="text-fg-muted">{label}</div>
            <div className="text-xl font-semibold text-fg">{v}</div>
          </div>
        ))}
      </div>
      <p className="text-fg-subtle">
        Failed {t.failed} · refused by the limits {t.refused}{t.console > 0 ? ` · shown in the server log (development) ${t.console}` : ''} · not linked to a society {data.unattributed}
      </p>

      <section className="space-y-2">
        <h3 className="font-semibold text-fg">By society (alert above 5 codes per flat a year)</h3>
        {data.societies.length === 0 ? (
          <p className="text-fg-subtle">No codes sent to registered numbers yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left">
              <thead className="bg-surface text-fg-muted">
                <tr><th className="p-3">Society</th><th className="p-3">Flats</th><th className="p-3">Sent</th><th className="p-3">Cost</th><th className="p-3">Last 12 months</th></tr>
              </thead>
              <tbody>
                {data.societies.map(s => (
                  <tr key={s.society_id} className="border-t border-border">
                    <td className="p-3 text-fg">{s.name}</td>
                    <td className="p-3">{s.flats}</td>
                    <td className="p-3">{s.sent}</td>
                    <td className="p-3">{formatINR(Number(s.cost))}</td>
                    <td className="p-3">
                      {s.sent_year}
                      {s.alert && (
                        <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-danger-soft text-danger text-xs font-semibold">
                          <AlertTriangle className="w-3 h-3" /> Over 5 per flat a year
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="p-5 rounded-xl bg-surface border border-border space-y-3">
        <h3 className="font-semibold text-fg">Limits</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {SETTING_FIELDS.map(f => (
            <label key={f.key} className="space-y-1">
              <span className="text-fg-muted">{f.label}</span>
              <input type="number" min={0} step={f.step ?? '1'} value={form[f.key] ?? ''} onChange={e => setForm(v => ({ ...v, [f.key]: e.target.value }))} className={inputClass} />
            </label>
          ))}
        </div>
        <button onClick={saveSettings} disabled={busy} className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold cursor-pointer disabled:opacity-50 flex items-center gap-1.5">
          <Save className="w-3.5 h-3.5" /> Save limits
        </button>
      </section>

      <section className="p-5 rounded-xl bg-surface border border-border space-y-3">
        <h3 className="font-semibold text-fg">Blocked numbers</h3>
        <div className="flex flex-wrap gap-2">
          <input placeholder="Mobile" inputMode="tel" value={block.mobile} onChange={e => setBlock(b => ({ ...b, mobile: e.target.value }))} className={`${inputClass} max-w-[12rem]`} />
          <input placeholder="Reason" value={block.reason} onChange={e => setBlock(b => ({ ...b, reason: e.target.value }))} className={`${inputClass} flex-1 min-w-[12rem]`} />
          <button
            onClick={() => run(() => supabase!.rpc('block_mobile', { p_mobile: block.mobile, p_reason: block.reason }), 'Number blocked.').then(() => setBlock({ mobile: '', reason: '' }))}
            disabled={busy || !block.mobile.trim()}
            className="px-4 py-2 rounded-lg bg-danger-solid hover:bg-danger text-on-brand font-semibold cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
          >
            <Ban className="w-3.5 h-3.5" /> Block
          </button>
        </div>
        {data.blocked.length === 0 ? (
          <p className="text-fg-subtle">No blocked numbers.</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.blocked.map(b => (
              <li key={b.mobile} className="py-2 flex items-center justify-between gap-3">
                <span><strong className="text-fg">{formatMobile(b.mobile)}</strong>{b.reason ? <span className="text-fg-muted"> · {b.reason}</span> : null}</span>
                <button onClick={() => run(() => supabase!.rpc('unblock_mobile', { p_mobile: b.mobile }), 'Number unblocked.')} className="text-brand hover:underline cursor-pointer">Unblock</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};
