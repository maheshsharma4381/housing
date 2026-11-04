// The Send SMS hook end to end, with the database and the providers stubbed: what Supabase receives,
// which provider is tried, and what is recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleSmsHook, type HookDeps, type Claim } from '../../src/lib/otp/hook.ts';
import { otpConfig } from '../../src/lib/otp/senders.ts';

const key = Buffer.from('a-test-key-of-32-bytes-length!!!');
const secret = `v1,whsec_${key.toString('base64')}`;
const NOW = 1_800_000_000_000;

function signed(payload: unknown, id = 'msg_1') {
  const body = JSON.stringify(payload);
  const ts = Math.floor(NOW / 1000);
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return { body, headers: new Headers({ 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sig}` }) };
}

const WA = { WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '5', WHATSAPP_TEMPLATE_NAME: 'login_code' };
const SMS = { MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_ID: 'tpl' };

function deps(over: Partial<HookDeps> & { claimReply?: Claim | null; replies?: Record<string, { ok: boolean; status: number; text: string }> } = {}) {
  const calls = { claim: [] as string[], send: [] as string[], result: [] as unknown[][] };
  let clock = NOW;
  const d: HookDeps = {
    secret,
    config: otpConfig({ ...WA, ...SMS }),
    serviceReady: true,
    claim: async (p) => { calls.claim.push(p); return over.claimReply === undefined ? { allowed: true, reason: null, log_id: 'L1', foreign: false, prefer_sms: false } : over.claimReply; },
    result: async (...a) => { calls.result.push(a); },
    send: async (url) => {
      calls.send.push(url.includes('msg91') ? 'sms' : 'whatsapp');
      clock += 1500;
      const r = over.replies?.[url.includes('msg91') ? 'sms' : 'whatsapp'];
      return r ?? (url.includes('msg91') ? { ok: true, status: 200, text: '{"type":"success"}' } : { ok: true, status: 200, text: '{}' });
    },
    log: () => {},
    now: () => clock,
    ...over,
  };
  return { d, calls };
}

const payload = (phone: string, extra: Record<string, unknown> = {}) => ({ user: { phone, ...extra }, sms: { otp: '123456' } });

test('a forged call is refused before the database is asked', async () => {
  const { d, calls } = deps();
  const { body } = signed(payload('919876543210'));
  const r = await handleSmsHook(body, new Headers({ 'webhook-id': 'x', 'webhook-timestamp': String(NOW / 1000), 'webhook-signature': 'v1,AAAA' }), d);
  assert.equal(r.status, 401);
  assert.deepEqual(calls.claim, []);
});

test('a refusal reaches the person: HTTP 200 with the error body Supabase reads', async () => {
  const { d } = deps({ claimReply: { allowed: false, reason: 'Too many codes for this number today — try again tomorrow', log_id: null, foreign: false } });
  const { body, headers } = signed(payload('919876543210'));
  const r = await handleSmsHook(body, headers, d);
  assert.deepEqual(r, { status: 200, body: { error: { http_code: 429, message: 'Too many codes for this number today — try again tomorrow' } } });
});

test('no provider configured is reported the same way', async () => {
  const { d } = deps({ config: otpConfig({ NODE_ENV: 'production' }) });
  const { body, headers } = signed(payload('919876543210'));
  assert.deepEqual(await handleSmsHook(body, headers, d), { status: 200, body: { error: { http_code: 503, message: 'Mobile login is not set up yet' } } });
});

test('WhatsApp first; the number is passed on as international digits', async () => {
  const { d, calls } = deps();
  const { body, headers } = signed(payload('6591234567'));
  const r = await handleSmsHook(body, headers, d);
  assert.deepEqual(r, { status: 200, body: {} });
  assert.deepEqual(calls.claim, ['+6591234567'], 'Singapore stays Singapore');
  assert.deepEqual(calls.result, [['L1', 'whatsapp', true, null]]);
});

test('WhatsApp failing falls back to SMS for an Indian number', async () => {
  const { d, calls } = deps({ replies: { whatsapp: { ok: false, status: 500, text: 'down' } } });
  const { body, headers } = signed(payload('919876543210'));
  assert.deepEqual(await handleSmsHook(body, headers, d), { status: 200, body: {} });
  assert.deepEqual(calls.send, ['whatsapp', 'sms']);
  assert.deepEqual(calls.result, [['L1', 'sms', true, null]]);
});

test('a resend after an undelivered WhatsApp code goes by SMS first', async () => {
  const { d, calls } = deps({ claimReply: { allowed: true, reason: null, log_id: 'L2', foreign: false, prefer_sms: true } });
  const { body, headers } = signed(payload('919876543210'));
  await handleSmsHook(body, headers, d);
  assert.deepEqual(calls.send, ['sms']);
});

test('MSG91 answering 200 with an error is a failed send', async () => {
  const { d, calls } = deps({ replies: { whatsapp: { ok: false, status: 500, text: 'down' }, sms: { ok: true, status: 200, text: '{"type":"error","message":"bad template"}' } } });
  const { body, headers } = signed(payload('919876543210'));
  const r = await handleSmsHook(body, headers, d);
  assert.deepEqual(r, { status: 200, body: { error: { http_code: 502, message: 'Could not send the code — try again in a minute' } } });
  assert.equal(calls.result[0][2], false);
});

test('a foreign number never falls back to SMS', async () => {
  const { d, calls } = deps({ claimReply: { allowed: true, reason: null, log_id: 'L3', foreign: true }, replies: { whatsapp: { ok: false, status: 500, text: 'down' } } });
  const { body, headers } = signed(payload('447700900123'));
  await handleSmsHook(body, headers, d);
  assert.deepEqual(calls.send, ['whatsapp']);
});

test('a phone change sends the code to the new number', async () => {
  const { d, calls } = deps();
  const { body, headers } = signed(payload('', { phone_change: '919811122222' }));
  await handleSmsHook(body, headers, d);
  assert.deepEqual(calls.claim, ['+919811122222']);
});

test('no second try once the time Supabase allows is nearly used', async () => {
  const { d, calls } = deps({ replies: { whatsapp: { ok: false, status: 500, text: 'slow' } } });
  const slow = { ...d, send: async (url: string, init: RequestInit, ms: number) => { calls.send.push(url.includes('msg91') ? 'sms' : 'whatsapp'); clockJump(); return { ok: false, status: 0, text: `timeout after ${ms}` }; } };
  let t = NOW;
  const clockJump = () => { t += 3000; };
  slow.now = () => t;
  const { body, headers } = signed(payload('919876543210'));
  await handleSmsHook(body, headers, slow);
  assert.deepEqual(calls.send, ['whatsapp']);
});
