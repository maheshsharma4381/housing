// What the login screen sends to Supabase, and when "Resend code" opens again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toE164, resendWait } from '../../src/lib/phone-login.ts';

test('a typed mobile becomes +<country><number>', () => {
  assert.equal(toE164('98765 43210'), '+919876543210');
  assert.equal(toE164('+91-98765-43210'), '+919876543210');
  assert.equal(toE164('+44 7700 900123'), '+447700900123');
  assert.equal(toE164('12345'), null);
  assert.equal(toE164('+65 9123 4567'), '+6591234567', 'Singapore, not India');
  assert.equal(toE164('0047 412 34 567'), '+4741234567');
});

test('resend opens 60 seconds after the last code', () => {
  assert.equal(resendWait(null, 1_000), 0);
  assert.equal(resendWait(1_000, 1_000), 60);
  assert.equal(resendWait(1_000, 30_500), 31);
  assert.equal(resendWait(1_000, 61_000), 0);
});
