'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { formatINR } from '../lib/inr';
import { Banner } from './Banner';
import { Loader2, Megaphone, Plus, Save, Target } from 'lucide-react';

interface Campaign {
  id: string; sponsor_name: string; title: string; body: string | null; image_path: string | null;
  cta_label: string | null; cta_url: string | null; cities: string[]; pincodes: string[]; placements: string[];
  starts_on: string; ends_on: string; monthly_price: number; is_house: boolean; priority: number;
  status: 'draft' | 'live' | 'paused' | 'ended'; notes: string | null;
}
interface Stat { campaign_id: string; impressions: number; clicks: number; societies: number }

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;
const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const blank = (): Omit<Campaign, 'id'> & { id?: string; citiesText: string; pincodesText: string } => ({
  sponsor_name: '', title: '', body: '', image_path: null, cta_label: 'WhatsApp', cta_url: '', cities: [], pincodes: [],
  placements: ['home_feed'], starts_on: today(), ends_on: plusDays(30), monthly_price: 0, is_house: false, priority: 0,
  status: 'draft', notes: '', citiesText: '', pincodesText: '',
});
const list = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Platform owner: local sponsor cards shown to residents of Free-plan societies. */
export const AdsConsole: React.FC = () => {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [stats, setStats] = useState<Record<string, Stat>>({});
  const [reach, setReach] = useState<Record<string, { societies: number; flats: number }>>({});
  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [cRes, sRes] = await Promise.all([
      supabase.from('ad_campaigns').select('*').order('created_at', { ascending: false }),
      supabase.rpc('platform_ad_report', { p_from: monthStart(), p_to: today() }),
    ]);
    if (cRes.error) setError(cRes.error.message);
    setCampaigns((cRes.data ?? []) as Campaign[]);
    setStats(Object.fromEntries(((sRes.data ?? []) as Stat[]).map(s => [s.campaign_id, s])));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const imageUrl = (path: string | null) => (path && supabase ? supabase.storage.from('ad-creatives').getPublicUrl(path).data.publicUrl : null);

  const upload = async (file: File | undefined) => {
    if (!supabase || !file || !form) return;
    if (!IMAGE_TYPES.includes(file.type) || file.size > 2 * 1024 * 1024) return setError('Use a JPG, PNG or WEBP image up to 2 MB.');
    setBusy('upload');
    const path = `campaigns/${crypto.randomUUID()}.${file.type.split('/')[1]}`;
    const { error: upErr } = await supabase.storage.from('ad-creatives').upload(path, file, { contentType: file.type });
    setBusy(null);
    if (upErr) return setError(upErr.message);
    setForm({ ...form, image_path: path });
  };

  const save = async () => {
    if (!supabase || !form) return;
    const { id, citiesText, pincodesText, ...rest } = form;
    const row = { ...rest, body: rest.body || null, cta_label: rest.cta_label || null, cta_url: rest.cta_url || null, notes: rest.notes || null,
      cities: list(citiesText), pincodes: list(pincodesText) };
    setBusy('save');
    const { error: err } = id
      ? await supabase.from('ad_campaigns').update(row).eq('id', id)
      : await supabase.from('ad_campaigns').insert(row);
    setBusy(null);
    if (err) return setError(err.message);
    setForm(null);
    setError(null);
    setNotice(row.status === 'live' ? 'Campaign is live for matching Free-plan societies.' : 'Campaign saved.');
    load();
  };

  const checkReach = async (id: string) => {
    const { data, error: err } = await supabase!.rpc('ad_reach', { p_campaign_id: id });
    if (err) return setError(err.message);
    setReach(r => ({ ...r, [id]: data as { societies: number; flats: number } }));
  };

  const live = campaigns.filter(c => c.status === 'live' && c.starts_on <= today() && c.ends_on >= today());
  const sponsorIncome = live.filter(c => !c.is_house).reduce((s, c) => s + Number(c.monthly_price), 0);
  const month = Object.values(stats).reduce((t, s) => ({ i: t.i + Number(s.impressions), c: t.c + Number(s.clicks) }), { i: 0, c: 0 });
  const cell = 'w-full bg-surface border border-border-strong rounded-lg px-2 py-1.5 text-fg outline-none focus:border-brand';

  return (
    <div className="space-y-6 text-xs">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-fg flex items-center gap-2"><Megaphone className="w-4 h-4 text-brand-ink" /> Sponsors</h2>
          <p className="text-fg-muted">Local businesses pay a fixed monthly fee. Cards appear only to residents of Free-plan societies (never in the trial, never to the committee), at most one per slot and two per session.</p>
        </div>
        {!form && <button onClick={() => setForm(blank())} className="flex items-center gap-1 px-3 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold cursor-pointer"><Plus className="w-3.5 h-3.5" /> New campaign</button>}
      </div>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {([['Live campaigns', String(live.length)], ['Sponsor income / month', formatINR(sponsorIncome)],
           ['Views this month', month.i.toLocaleString('en-IN')], ['Taps this month', `${month.c.toLocaleString('en-IN')}${month.i ? ` · ${((month.c / month.i) * 100).toFixed(1)}%` : ''}`]] as [string, string][]).map(([l, v]) => (
          <div key={l} className="p-3 rounded-xl bg-canvas border border-border"><div className="text-fg-muted">{l}</div><div className="text-lg font-semibold text-fg">{v}</div></div>
        ))}
      </div>

      {form && (
        <section className="p-4 rounded-xl bg-canvas border border-brand grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="space-y-1"><span className="text-fg-muted">Sponsor</span><input value={form.sponsor_name} onChange={e => setForm({ ...form, sponsor_name: e.target.value })} className={cell} /></label>
            <label className="space-y-1"><span className="text-fg-muted">Headline (80)</span><input maxLength={80} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} className={cell} /></label>
            <label className="space-y-1 sm:col-span-2"><span className="text-fg-muted">Line (160)</span><input maxLength={160} value={form.body ?? ''} onChange={e => setForm({ ...form, body: e.target.value })} className={cell} /></label>
            <label className="space-y-1"><span className="text-fg-muted">Button</span><input maxLength={32} value={form.cta_label ?? ''} onChange={e => setForm({ ...form, cta_label: e.target.value })} className={cell} /></label>
            <label className="space-y-1"><span className="text-fg-muted">Link (https:// or tel:)</span><input value={form.cta_url ?? ''} onChange={e => setForm({ ...form, cta_url: e.target.value })} placeholder="https://wa.me/91…" className={cell} /></label>
            <label className="space-y-1"><span className="text-fg-muted">Cities (comma separated, empty = all)</span><input value={form.citiesText} onChange={e => setForm({ ...form, citiesText: e.target.value })} className={cell} /></label>
            <label className="space-y-1"><span className="text-fg-muted">Pincodes (comma separated)</span><input value={form.pincodesText} onChange={e => setForm({ ...form, pincodesText: e.target.value })} className={cell} /></label>
            <label className="space-y-1"><span className="text-fg-muted">From</span><input type="date" value={form.starts_on} onChange={e => setForm({ ...form, starts_on: e.target.value })} className={cell} /></label>
            <label className="space-y-1"><span className="text-fg-muted">To</span><input type="date" value={form.ends_on} onChange={e => setForm({ ...form, ends_on: e.target.value })} className={cell} /></label>
            <label className="space-y-1"><span className="text-fg-muted">Price ₹ / month (invoice the sponsor)</span><input type="number" min={0} value={form.monthly_price} onChange={e => setForm({ ...form, monthly_price: Number(e.target.value) })} className={cell} /></label>
            <label className="space-y-1"><span className="text-fg-muted">Status</span>
              <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value as Campaign['status'] })} className={cell}>
                <option value="draft">Draft</option><option value="live">Live</option><option value="paused">Paused</option><option value="ended">Ended</option></select></label>
            <div className="sm:col-span-2 flex flex-wrap items-center gap-4 text-fg">
              {(['home_feed', 'notices'] as const).map(p => (
                <label key={p} className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" className="accent-purple-500" checked={form.placements.includes(p)}
                  onChange={e => setForm({ ...form, placements: e.target.checked ? [...form.placements, p] : form.placements.filter(x => x !== p) })} />
                  {p === 'home_feed' ? 'Resident home feed' : 'Notices list'}</label>
              ))}
              <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" className="accent-purple-500" checked={form.is_house} onChange={e => setForm({ ...form, is_house: e.target.checked })} /> Sahvaas house card</label>
              <label className="flex items-center gap-1.5">Priority <input type="number" value={form.priority} onChange={e => setForm({ ...form, priority: Number(e.target.value) })} className="w-16 bg-surface border border-border-strong rounded-lg px-2 py-1 text-fg" /></label>
            </div>
            <label className="space-y-1 sm:col-span-2"><span className="text-fg-muted">Image (JPG / PNG / WEBP, 2 MB)</span>
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => upload(e.target.files?.[0])}
                className="w-full text-fg file:mr-2 file:px-2 file:py-1.5 file:rounded-lg file:border-0 file:bg-slate-800 file:text-slate-200" /></label>
            <div className="sm:col-span-2 flex gap-2">
              <button onClick={save} disabled={busy !== null || !form.sponsor_name.trim() || !form.title.trim() || form.placements.length === 0}
                className="flex items-center gap-1 px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold cursor-pointer disabled:opacity-50">
                {busy === 'save' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
              </button>
              <button onClick={() => setForm(null)} className="px-3 rounded-xl bg-surface-muted text-fg cursor-pointer">Cancel</button>
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-fg-muted font-semibold text-xs">Preview</div>
            {/* the same card residents see (SponsoredCard) */}
            <div className="rounded-xl bg-surface border border-border shadow-card overflow-hidden max-w-sm">
              {imageUrl(form.image_path) && <img src={imageUrl(form.image_path)!} alt="" className="w-full aspect-[2/1] object-cover bg-surface-muted" />}
              <div className="p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className={`px-2 py-0.5 rounded-lg text-xs font-medium ${form.is_house ? 'bg-brand-soft text-brand-ink' : 'bg-surface-muted text-fg-muted'}`}>{form.is_house ? 'From Sahvaas' : 'Sponsored'}</span>
                  <span className="text-xs text-fg-subtle">Why this?</span>
                </div>
                <div className="flex gap-3 items-start">
                  {!imageUrl(form.image_path) && (
                    <span className="w-11 h-11 shrink-0 rounded-full bg-brand-soft text-brand flex items-center justify-center">
                      {busy === 'upload' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Megaphone className="w-5 h-5" />}
                    </span>
                  )}
                  <div className="min-w-0 space-y-0.5">
                    <div className="text-[15px] font-semibold text-fg leading-snug">{form.title || 'Headline'}</div>
                    {form.body && <div className="text-sm text-fg-muted">{form.body}</div>}
                    {!form.is_house && <div className="text-xs text-fg-subtle">by {form.sponsor_name || 'Sponsor'}</div>}
                  </div>
                </div>
                {form.cta_url && <div className="h-10 flex items-center justify-center rounded-lg border border-border-strong text-sm font-semibold text-fg">{form.cta_label || 'Learn more'}</div>}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-danger-soft border border-danger/20 text-danger leading-relaxed">
              Never shown on payments, receipts, bills, reports, committee or CA screens. Sponsors get only view / tap totals by city — no names, flats or phone numbers.
            </div>
          </div>
        </section>
      )}

      <section className="bg-canvas border border-border rounded-xl overflow-x-auto">
        <table className="w-full min-w-[820px] text-left">
          <thead className="text-fg-muted"><tr><th className="p-2">Campaign</th><th className="p-2">Where</th><th className="p-2">Dates</th><th className="p-2 text-right">₹ / month</th><th className="p-2">Status</th><th className="p-2 text-right">This month</th><th className="p-2" /></tr></thead>
          <tbody className="divide-y divide-border text-fg">
            {campaigns.length === 0 && <tr><td colSpan={7} className="p-4 text-fg-subtle">No campaigns yet.</td></tr>}
            {campaigns.map(c => {
              const s = stats[c.id];
              return (
                <tr key={c.id}>
                  <td className="p-2"><div className="font-semibold text-fg">{c.sponsor_name}{c.is_house && <span className="ml-1 text-xs text-brand-ink">house</span>}</div><div className="text-fg-muted">{c.title}</div></td>
                  <td className="p-2 text-fg">{[...c.cities, ...c.pincodes].join(', ') || 'Everywhere'}<div className="text-fg-subtle">{c.placements.join(' · ')}</div></td>
                  <td className="p-2 text-fg-muted">{c.starts_on} → {c.ends_on}</td>
                  <td className="p-2 text-right">{c.is_house ? '—' : formatINR(c.monthly_price)}</td>
                  <td className="p-2"><span className={c.status === 'live' ? 'text-success' : c.status === 'paused' ? 'text-warning' : 'text-fg-muted'}>{c.status}</span></td>
                  <td className="p-2 text-right">{s ? <>{Number(s.impressions).toLocaleString('en-IN')} views · {Number(s.clicks)} taps<div className="text-fg-subtle">{Number(s.societies)} societies</div></> : '—'}</td>
                  <td className="p-2 text-right whitespace-nowrap">
                    <button onClick={() => checkReach(c.id)} className="text-brand-ink hover:underline cursor-pointer mr-2 inline-flex items-center gap-1"><Target className="w-3 h-3" />
                      {reach[c.id] ? `${reach[c.id].societies} soc · ${reach[c.id].flats} flats` : 'Reach'}</button>
                    <button onClick={() => setForm({ ...c, body: c.body ?? '', notes: c.notes ?? '', citiesText: c.cities.join(', '), pincodesText: c.pincodes.join(', ') })} className="text-fg hover:underline cursor-pointer">Edit</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
};
