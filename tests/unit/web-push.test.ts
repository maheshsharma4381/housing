import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { vapidJwt, pushHeaders, deadSubscription, endpointAudience } from '../../src/lib/web-push.ts';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

test('the VAPID token is an ES256 JWT the push service can verify', () => {
  const jwt = vapidJwt('https://fcm.googleapis.com', 'mailto:ops@sahvaas.in', pem, 3600, 1_700_000_000_000);
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(decode(h), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(decode(c), { aud: 'https://fcm.googleapis.com', exp: 1_700_000_000 + 3600, sub: 'mailto:ops@sahvaas.in' });
  assert.equal(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), true);
});

test('push headers, audience and dead subscriptions', () => {
  const headers = pushHeaders('a.b.c', 'BPUBLIC');
  assert.equal(headers.Authorization, 'vapid t=a.b.c, k=BPUBLIC');
  assert.equal(headers.TTL, '86400');
  assert.equal(endpointAudience('https://fcm.googleapis.com/fcm/send/abc'), 'https://fcm.googleapis.com');
  assert.equal(deadSubscription(410), true);
  assert.equal(deadSubscription(404), true);
  assert.equal(deadSubscription(201), false);
});
