import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { vapidJwt, pushHeaders, endpointAudience, deadSubscription } from '../../../../lib/web-push';

// Sends a payload-free web push to every user with notifications not yet pushed (Phase 3A).
// Called by pg_cron (pg_net) or any scheduler with `Authorization: Bearer ${CRON_SECRET}`.
// Rows are claimed first (claim_push_batch), so each notification is pushed at most once and runs never overlap.
export const runtime = 'nodejs';
export const maxDuration = 60;

const CHUNK = 20;
const TIMEOUT_MS = 5000;

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 });
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return NextResponse.json({ skipped: 'no service key' }, { status: 503 });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: subs, error } = await admin.rpc('claim_push_batch', { p_limit: 500 });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const targets = (subs ?? []) as { sub_id: string; user_id: string; endpoint: string }[];

  const privateKey = process.env.VAPID_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!privateKey || !publicKey) return NextResponse.json({ skipped: 'no VAPID keys', claimed: targets.length });
  const subject = process.env.VAPID_SUBJECT || 'mailto:support@sahvaas.in';

  let sent = 0;
  const dead: string[] = [];
  for (let i = 0; i < targets.length; i += CHUNK) {
    const results = await Promise.allSettled(targets.slice(i, i + CHUNK).map(async (t) => {
      const res = await fetch(t.endpoint, {
        method: 'POST',
        headers: { ...pushHeaders(vapidJwt(endpointAudience(t.endpoint), subject, privateKey), publicKey), 'Content-Length': '0' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (deadSubscription(res.status)) dead.push(t.sub_id);
      else if (res.ok) sent += 1;
    }));
    void results; // one unreachable push service must not stop the others
  }
  if (dead.length > 0) {
    const { error: delErr } = await admin.from('push_subscriptions').delete().in('id', dead);
    if (delErr) return NextResponse.json({ error: delErr.message, sent }, { status: 500 });
  }
  return NextResponse.json({ subscriptions: targets.length, sent, removed: dead.length });
}
