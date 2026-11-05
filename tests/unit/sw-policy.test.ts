// The service worker only ever answers a failed page load with the offline page — never API calls or other sites,
// so money data is never served stale from a cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swShouldHandle } from '../../src/lib/sw-policy.ts';

const origin = 'https://app.sahvaas.in';
const req = (url: string, mode = 'navigate', method = 'GET') => ({ url, mode, method });

test('only page loads of this site', () => {
  assert.equal(swShouldHandle(req(`${origin}/resident`), origin), true);
  assert.equal(swShouldHandle(req(`${origin}/society?tab=billing`), origin), true);
});

test('never API calls, other sites, fetches or posts', () => {
  assert.equal(swShouldHandle(req(`${origin}/api/push/send-pending`), origin), false);
  assert.equal(swShouldHandle(req('https://xyz.supabase.co/rest/v1/bills'), origin), false);
  assert.equal(swShouldHandle(req(`${origin}/resident`, 'cors'), origin), false);
  assert.equal(swShouldHandle(req(`${origin}/login`, 'navigate', 'POST'), origin), false);
});
