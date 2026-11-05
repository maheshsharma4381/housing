import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushSyncAction } from '../../src/lib/push-sync.ts';

test('a phone that already allowed notifications re-saves its subscription quietly', () => {
  assert.equal(pushSyncAction(true, 'granted'), 'resubscribe');
  assert.equal(pushSyncAction(true, 'default'), 'offer');
  assert.equal(pushSyncAction(true, 'denied'), 'blocked');
  assert.equal(pushSyncAction(false, 'default'), 'unsupported');
});

test('a subscription made with another server key is replaced', async () => {
  const { sameServerKey } = await import('../../src/lib/push-sync.ts');
  const key = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
  const bytes = (b64url: string) => Uint8Array.from(Buffer.from(b64url, 'base64url'));
  assert.equal(sameServerKey(bytes(key).buffer, key), true);
  const other = bytes(key);
  other[5] ^= 1;
  assert.equal(sameServerKey(other.buffer, key), false);
  assert.equal(sameServerKey(null, key), false);
  assert.equal(sameServerKey(undefined, key), false);
});
