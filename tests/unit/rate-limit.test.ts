// A small per-key limit for routes that call a third-party service (the pincode lookup).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../../src/lib/rate-limit.ts';

test('a key gets its limit per window, then waits', () => {
  const take = createRateLimiter(3, 60_000);
  const t0 = 1_000_000;
  assert.equal(take('u1', t0), true);
  assert.equal(take('u1', t0 + 1000), true);
  assert.equal(take('u1', t0 + 2000), true);
  assert.equal(take('u1', t0 + 3000), false, 'the fourth in a minute is refused');
  assert.equal(take('u1', t0 + 59_999), false);
  assert.equal(take('u1', t0 + 60_000), true, 'a minute after the first, one more is allowed');
});

test('keys are counted separately', () => {
  const take = createRateLimiter(1, 60_000);
  assert.equal(take('a', 0), true);
  assert.equal(take('b', 0), true);
  assert.equal(take('a', 1), false);
});
