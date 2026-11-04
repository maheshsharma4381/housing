// Supabase's Send SMS hook signs each call (Standard Webhooks); only a correctly signed, fresh call may send a code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyWebhook } from '../../src/lib/otp/webhook.ts';

const key = Buffer.from('a-test-key-of-32-bytes-length!!!');
const secret = `v1,whsec_${key.toString('base64')}`;
const body = JSON.stringify({ user: { phone: '919876543210' }, sms: { otp: '123456' } });
const sign = (id: string, ts: number, b: string) => createHmac('sha256', key).update(`${id}.${ts}.${b}`).digest('base64');
const headers = (id: string, ts: number, sig: string) => new Headers({ 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': sig });

test('a correctly signed, fresh call is accepted', () => {
  const now = 1_800_000_000;
  assert.equal(verifyWebhook(secret, headers('msg_1', now, `v1,${sign('msg_1', now, body)}`), body, now), true);
  // several signatures, one of them right (key rotation)
  assert.equal(verifyWebhook(secret, headers('msg_1', now, `v1,AAAA v1,${sign('msg_1', now, body)}`), body, now + 10), true);
});

test('a forged, altered or stale call is refused', () => {
  const now = 1_800_000_000;
  const good = `v1,${sign('msg_1', now, body)}`;
  assert.equal(verifyWebhook(secret, headers('msg_1', now, good), body.replace('123456', '000000'), now), false, 'body changed');
  assert.equal(verifyWebhook(secret, headers('msg_2', now, good), body, now), false, 'id changed');
  assert.equal(verifyWebhook(secret, headers('msg_1', now, good), body, now + 301), false, 'older than 5 minutes');
  assert.equal(verifyWebhook(secret, new Headers(), body, now), false, 'no headers');
  assert.equal(verifyWebhook('', headers('msg_1', now, good), body, now), false, 'no secret configured');
});
