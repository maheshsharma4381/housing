import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { handleSmsHook, type Claim } from '../../../../lib/otp/hook';
import { otpConfig } from '../../../../lib/otp/senders';

// Supabase Auth "Send SMS" hook (Phase 3C): Supabase makes the code, we deliver it.
// The logic (signature, limits, WhatsApp then SMS, the reply Supabase reads) is in lib/otp/hook.ts.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const body = await request.text();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const admin = url && serviceKey ? createClient(url, serviceKey, { auth: { persistSession: false } }) : null;

  const reply = await handleSmsHook(body, request.headers, {
    secret: process.env.SEND_SMS_HOOK_SECRET ?? '',
    config: otpConfig(process.env),
    serviceReady: admin !== null,
    claim: async (phone) => {
      const { data, error } = await admin!.rpc('otp_claim', { p_phone: phone });
      return error ? null : (data as Claim);
    },
    result: async (logId, channel, ok, error) => {
      await admin!.rpc('otp_result', { p_log_id: logId, p_channel: channel, p_ok: ok, p_error: error });
    },
    send: async (target, init, timeoutMs) => {
      try {
        const res = await fetch(target, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        return { ok: res.ok, status: res.status, text: await res.text() };
      } catch (err) {
        return { ok: false, status: 0, text: err instanceof Error ? err.message : 'network error' };
      }
    },
    log: (line) => console.info(line),
    now: () => Date.now(),
  });
  return NextResponse.json(reply.body, { status: reply.status });
}
