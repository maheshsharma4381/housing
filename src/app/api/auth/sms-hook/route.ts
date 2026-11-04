import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyWebhook } from '../../../../lib/otp/webhook';
import { otpConfig, whatsappRequest, msg91Request, isIndianMobile, maskMobile } from '../../../../lib/otp/senders';
import { normalizeMobile } from '../../../../lib/mobile';

// Supabase Auth "Send SMS" hook (Phase 3C): Supabase makes the code, we deliver it.
// Signed by Supabase (Standard Webhooks); the database decides whether this number may get a code now
// (otp_claim: blocked numbers, 60-second resend, daily limits, platform cap) and records the cost (otp_result).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Supabase waits only a few seconds for an auth hook: WhatsApp, then SMS, must both fit
const TIMEOUT_MS = 2000;

/** Supabase shows `message` to the person who asked for the code. */
const fail = (status: number, message: string) => NextResponse.json({ error: { http_code: status, message } }, { status });

async function deliver(url: string, init: RequestInit): Promise<string | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) return null;
    return `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
  } catch (err) {
    return err instanceof Error ? err.message : 'network error';
  }
}

export async function POST(request: Request) {
  const body = await request.text();
  if (!verifyWebhook(process.env.SEND_SMS_HOOK_SECRET ?? '', request.headers, body, Math.floor(Date.now() / 1000))) {
    return fail(401, 'Bad signature');
  }
  let payload: { user?: { phone?: string }; sms?: { otp?: string } };
  try {
    payload = JSON.parse(body);
  } catch {
    return fail(400, 'Bad request');
  }
  const to = normalizeMobile(payload.user?.phone);
  const code = String(payload.sms?.otp ?? '');
  if (!to || !/^\d{4,10}$/.test(code)) return fail(400, 'Enter a valid mobile number');

  const cfg = otpConfig(process.env);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (cfg.provider === 'none' || !url || !serviceKey) return fail(503, 'Mobile login is not set up yet');
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: claim, error } = await admin.rpc('otp_claim', { p_phone: to });
  if (error) return fail(500, 'Could not send the code — try again');
  const c = claim as { allowed: boolean; reason: string | null; log_id: string | null; foreign: boolean };
  if (!c.allowed || !c.log_id) return fail(429, c.reason ?? 'Try again later');

  let channel: 'whatsapp' | 'sms' | 'console' = 'console';
  let problem: string | null = null;
  if (cfg.provider === 'console') {
    console.info(`[otp] ${maskMobile(to)} ${code}`);
  } else if (cfg.whatsapp) {
    channel = 'whatsapp';
    const r = whatsappRequest(cfg.whatsapp, to, code);
    problem = await deliver(r.url, r.init);
    // SMS backup for Indian numbers only (spec 8.1: foreign numbers are WhatsApp-only)
    if (problem && cfg.msg91 && isIndianMobile(to)) {
      channel = 'sms';
      const s = msg91Request(cfg.msg91, to, code);
      problem = await deliver(s.url, s.init);
    }
  }

  await admin.rpc('otp_result', { p_log_id: c.log_id, p_channel: channel, p_ok: problem === null, p_error: problem });
  if (problem) return fail(502, 'Could not send the code — try again in a minute');
  return NextResponse.json({});
}
