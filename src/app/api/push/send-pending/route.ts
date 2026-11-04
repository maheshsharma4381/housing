import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { vapidJwt, pushHeaders, endpointAudience, deadSubscription } from '../../../../lib/web-push';

// Sends a payload-free web push to every user with notifications not yet pushed (Phase 3A).
// Called by pg_cron (pg_net) or any scheduler with `Authorization: Bearer ${CRON_SECRET}`.
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 401 });
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return NextResponse.json({ skipped: 'no service key' }, { status: 503 });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: rows, error } = await admin.from('notifications').select('id, user_id').is('pushed_at', null)
    .order('created_at').limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const ids = (rows ?? []).map(r => r.id as string);
  const users = [...new Set((rows ?? []).map(r => r.user_id as string))];
  const markPushed = async () => {
    if (ids.length > 0) await admin.from('notifications').update({ pushed_at: new Date().toISOString() }).in('id', ids);
  };

  const privateKey = process.env.VAPID_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!privateKey || !publicKey) {
    await markPushed();
    return NextResponse.json({ skipped: 'no VAPID keys', marked: ids.length });
  }
  const subject = process.env.VAPID_SUBJECT || 'mailto:support@sahvaas.in';

  let sent = 0;
  let removed = 0;
  if (users.length > 0) {
    const { data: subs } = await admin.from('push_subscriptions').select('id, endpoint').in('user_id', users);
    for (const sub of subs ?? []) {
      try {
        const endpoint = sub.endpoint as string;
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { ...pushHeaders(vapidJwt(endpointAudience(endpoint), subject, privateKey), publicKey), 'Content-Length': '0' },
        });
        if (deadSubscription(res.status)) {
          await admin.from('push_subscriptions').delete().eq('id', sub.id);
          removed += 1;
        } else if (res.ok) {
          sent += 1;
        }
      } catch {
        // one unreachable push service must not stop the others
      }
    }
  }
  await markPushed();
  return NextResponse.json({ users: users.length, sent, removed });
}
