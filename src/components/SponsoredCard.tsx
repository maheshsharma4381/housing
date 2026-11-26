'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { ExternalLink, Info, Megaphone } from 'lucide-react';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';

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
          <section key={a.id} aria-label={a.is_house ? 'From Sahvaas' : 'Sponsored'}
            className="rounded-xl bg-surface border border-border shadow-card overflow-hidden">
            {image && (
              // a wide creative on top, cropped to the same shape everywhere
              <img src={image} alt="" loading="lazy" className="w-full aspect-[2/1] object-cover bg-surface-muted" />
            )}
            <div className="p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <Badge tone={a.is_house ? 'brand' : 'neutral'}>{a.is_house ? 'From Sahvaas' : 'Sponsored'}</Badge>
                <button type="button" onClick={() => setWhy(w => !w)} aria-expanded={why}
                  className="flex items-center gap-1 text-xs text-fg-subtle hover:text-fg cursor-pointer">
                  <Info className="w-3.5 h-3.5" aria-hidden="true" /> Why this?
                </button>
              </div>
              <div className="flex gap-3 items-start">
                {!image && (
                  <span className="w-11 h-11 shrink-0 rounded-full bg-brand-soft text-brand flex items-center justify-center">
                    <Megaphone className="w-5 h-5" aria-hidden="true" />
                  </span>
                )}
                <div className="min-w-0 space-y-0.5">
                  <h3 className="text-[15px] font-semibold text-fg leading-snug">{a.title}</h3>
                  {a.body && <p className="text-sm text-fg-muted leading-relaxed">{a.body}</p>}
                  {!a.is_house && <p className="text-xs text-fg-subtle">by {a.sponsor_name}</p>}
                </div>
              </div>
              {a.cta_url && (
                <Button variant="secondary" className="w-full" onClick={open} rightIcon={<ExternalLink className="w-4 h-4" aria-hidden="true" />}>
                  {a.cta_label || 'Learn more'}
                </Button>
              )}
              {why && (
                <p className="p-3 rounded-lg bg-surface-muted text-xs leading-relaxed text-fg-muted">
                  Your society uses the free Sahvaas plan, so a few local offers appear here. They are never shown on payments,
                  bills or receipts, and advertisers get no information about you — only how many times a card was seen in a city.
                </p>
              )}
            </div>
          </section>
        );
      })}
    </>
  );
};
