import { verifyWebhook } from './webhook.ts';
import { type OtpConfig, whatsappRequest, msg91Request, isIndianMobile, maskMobile } from './senders.ts';

// The Supabase "Send SMS" Auth Hook, without the framework: the route passes in the database and fetch.

export interface Claim { allowed: boolean; reason: string | null; log_id: string | null; foreign: boolean; prefer_sms?: boolean }
export interface SendReply { ok: boolean; status: number; text: string }
export interface HookDeps {
  secret: string;
  config: OtpConfig;
  /** the service-role client exists (otp_claim / otp_result are service-role only) */
  serviceReady: boolean;
  /** null when the database could not be asked */
  claim: (phone: string) => Promise<Claim | null>;
  result: (logId: string, channel: 'whatsapp' | 'sms' | 'console', ok: boolean, error: string | null) => Promise<void>;
  send: (url: string, init: RequestInit, timeoutMs: number) => Promise<SendReply>;
  log: (line: string) => void;
  now: () => number;
}
export interface HookReply { status: number; body: unknown }

// Supabase allows an auth hook 5 seconds in all; leave room for the two database calls
const BUDGET_MS = 3500;
const PER_TRY_MS = 2000;
const MIN_FOR_NEXT_TRY_MS = 1000;

/** Supabase shows `message` to the person only when the hook answers 200 with this body. */
const refuse = (httpCode: number, message: string): HookReply => ({ status: 200, body: { error: { http_code: httpCode, message } } });

/** MSG91 answers HTTP 200 even for errors; only {"type":"success"} is a sent SMS. */
export const msg91Ok = (text: string) => {
  try {
    return JSON.parse(text)?.type === 'success';
  } catch {
    return false;
  }
};

export async function handleSmsHook(rawBody: string, headers: Headers, deps: HookDeps): Promise<HookReply> {
  const start = deps.now();
  if (!verifyWebhook(deps.secret, headers, rawBody, Math.floor(start / 1000))) {
    return { status: 401, body: { error: { http_code: 401, message: 'Bad signature' } } };
  }
  let payload: { user?: { phone?: string; phone_change?: string }; sms?: { otp?: string } };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return refuse(400, 'Bad request');
  }
  // Supabase keeps phones as international digits; a phone change goes to the new number
  const to = String(payload.user?.phone_change || payload.user?.phone || '').replace(/\D/g, '');
  const code = String(payload.sms?.otp ?? '');
  if (to.length < 8 || to.length > 15 || !/^\d{4,10}$/.test(code)) return refuse(400, 'Enter a valid mobile number');
  if (deps.config.provider === 'none' || !deps.serviceReady) return refuse(503, 'Mobile login is not set up yet');

  const c = await deps.claim(`+${to}`);
  if (!c) return refuse(500, 'Could not send the code — try again');
  if (!c.allowed || !c.log_id) return refuse(429, c.reason ?? 'Try again later');

  let channel: 'whatsapp' | 'sms' | 'console' = 'console';
  let problem: string | null = null;
  if (deps.config.provider === 'console') {
    deps.log(`[otp] ${maskMobile(to)} ${code}`);
  } else {
    const wa = deps.config.whatsapp ? { channel: 'whatsapp' as const, req: whatsappRequest(deps.config.whatsapp, to, code) } : null;
    // SMS is the backup for Indian numbers only (spec 8.1: foreign numbers are WhatsApp-only)
    const sms = deps.config.msg91 && isIndianMobile(to) ? { channel: 'sms' as const, req: msg91Request(deps.config.msg91, to, code) } : null;
    const order = (c.prefer_sms ? [sms, wa] : [wa, sms]).filter((x): x is NonNullable<typeof x> => x !== null);
    problem = 'No way to send a code to this number';
    for (const [i, attempt] of order.entries()) {
      const left = BUDGET_MS - (deps.now() - start);
      if (i > 0 && left < MIN_FOR_NEXT_TRY_MS) break;
      channel = attempt.channel;
      const r = await deps.send(attempt.req.url, attempt.req.init, Math.max(500, Math.min(PER_TRY_MS, left)));
      const ok = attempt.channel === 'sms' ? r.ok && msg91Ok(r.text) : r.ok;
      problem = ok ? null : `${attempt.channel} HTTP ${r.status}: ${r.text.slice(0, 200)}`;
      if (ok) break;
    }
  }

  await deps.result(c.log_id, channel, problem === null, problem);
  if (problem) return refuse(502, 'Could not send the code — try again in a minute');
  return { status: 200, body: {} };
}
