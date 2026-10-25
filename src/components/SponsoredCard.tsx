'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { Megaphone } from 'lucide-react';

interface AdCard { id: string; sponsor_name: string; title: string; body: string | null; image_path: string | null; cta_label: string | null; cta_url: string | null; is_house: boolean }

const SESSION_KEY = 'sahvaas.ads.seen';
const MAX_PER_SESSION = 2;

// Per-viewer session memory only (frequency cap); works without storage too
function seenThisSession(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}
function markSeen(id: string) {
  try {
    const seen = seenThisSession();
    if (!seen.includes(id)) sessionStorage.setItem(SESSION_KEY, JSON.stringify([...seen, id]));
  } catch {
    // storage unavailable: the cap simply resets on reload
  }
}

/**
 * Sponsored card for residents of societies on the Free plan. The server decides eligibility
 * (resident, plan with ads, not in trial, targeting); this only renders what it returns.
 * Never place it on payment, receipt, bill or report screens.
 */
export const SponsoredCard: React.FC<{ societyId: string; placement: 'home_feed' | 'notices' }> = ({ societyId, placement }) => {
  const [ads, setAds] = useState<AdCard[]>([]);
  const [why, setWhy] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    const client = supabase;
    client.rpc('ads_for_me', { p_society_id: societyId, p_placement: placement }).then(({ data }) => {
      if (cancelled) return;
      const seen = seenThisSession();
      const fresh = ((data ?? []) as AdCard[]);
      // Already-seen cards can show again; new ones only while under the session cap
      const allowed = fresh.filter(a => seen.includes(a.id) || seen.length < MAX_PER_SESSION).slice(0, 1);
      for (const a of allowed) {
        if (!seen.includes(a.id)) {
          markSeen(a.id);
          client.rpc('record_ad_event', { p_campaign_id: a.id, p_society_id: societyId, p_placement: placement, p_kind: 'impression' });
        }
      }
      setAds(allowed);
    });
    return () => { cancelled = true; };
  }, [societyId, placement]);

  if (!supabase || ads.length === 0) return null;
  const client = supabase;

  return (
    <>
      {ads.map(a => {
        const image = a.image_path ? client.storage.from('ad-creatives').getPublicUrl(a.image_path).data.publicUrl : null;
        const open = () => {
          client.rpc('record_ad_event', { p_campaign_id: a.id, p_society_id: societyId, p_placement: placement, p_kind: 'click' });
          if (a.cta_url) window.open(a.cta_url, '_blank', 'noopener,noreferrer');
        };
        return (
          <section key={a.id} aria-label="Sponsored" className="p-3 rounded-xl bg-slate-950 border border-slate-700 space-y-2 text-xs">
            <div className="flex items-center justify-between text-[10px] text-slate-500">
              <span className="font-bold uppercase tracking-wider">{a.is_house ? 'From Sahvaas' : 'Sponsored'}</span>
              <button onClick={() => setWhy(w => !w)} className="underline cursor-pointer">Why am I seeing this?</button>
            </div>
            <div className="flex gap-3 items-center">
              {image
                ? <img src={image} alt="" className="w-14 h-14 rounded-lg object-cover shrink-0" loading="lazy" />
                : <div className="w-14 h-14 rounded-lg bg-slate-800 flex items-center justify-center shrink-0"><Megaphone className="w-5 h-5 text-slate-400" /></div>}
              <div className="min-w-0">
                <div className="font-bold text-white">{a.title}</div>
                <div className="text-slate-400">{a.body ?? a.sponsor_name}</div>
                {!a.is_house && a.body && <div className="text-slate-500">{a.sponsor_name}</div>}
              </div>
            </div>
            {a.cta_url && (
              <button onClick={open} className="w-full py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold cursor-pointer">
                {a.cta_label || 'Learn more'}
              </button>
            )}
            {why && (
              <p className="text-[11px] leading-relaxed text-slate-400">
                Your society uses the free Sahvaas plan, so a few local offers appear here. They are never shown on payments,
                bills or receipts, and advertisers get no information about you — only how many times a card was seen in a city.
              </p>
            )}
          </section>
        );
      })}
    </>
  );
};
