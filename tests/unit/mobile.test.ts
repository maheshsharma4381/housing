// The browser keeps mobiles in the same shape as the database's normalize_mobile (031).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMobile } from '../../src/lib/mobile.ts';

test('mobiles are digits with the country code', () => {
  for (const m of ['+91 98765-43210', '098765 43210', '9876543210', '919876543210']) assert.equal(normalizeMobile(m), '919876543210', m);
  assert.equal(normalizeMobile('12345'), null);
  assert.equal(normalizeMobile(''), null);
  assert.equal(normalizeMobile('+44 7700 900123'), '447700900123');
});

test('a number typed with + or 00 keeps its own country code', () => {
  assert.equal(normalizeMobile('+65 9123 4567'), '6591234567');
  assert.equal(normalizeMobile('0065 9123 4567'), '6591234567');
  assert.equal(normalizeMobile('+91 98765 43210'), '919876543210');
  assert.equal(normalizeMobile('+12 345'), null);
});

test('owners pasted from Excel match flats by number', async () => {
  const { parseOwnerPaste } = await import('../../src/lib/mobile.ts');
  const units = [{ id: 'u1', unit_number: 'A-101' }, { id: 'u2', unit_number: '102' }];
  const text = 'Flat\tOwner\tMobile\na-101\tAsha Rao\t98765 43210\n102, Ravi K, \n999\tNobody\t9000000000\nA-101\tBad\t123\n';
  const r = parseOwnerPaste(text, units);
  // an empty cell leaves what is saved alone (it is not sent)
  assert.deepEqual(r.rows, [
    { unit_id: 'u1', name: 'Asha Rao', mobile: '919876543210' },
    { unit_id: 'u2', name: 'Ravi K' },
  ]);
  assert.deepEqual(r.unknownFlats, ['999']);
  assert.deepEqual(r.badMobiles, ['A-101: 123']);
});

test('trunk zero after +91 is dropped', () => {
  for (const m of ['+91 0 98765 43210', '0091 098765 43210', '+91 (0) 98765-43210', '0091 98765 43210']) {
    assert.equal(normalizeMobile(m), '919876543210', m);
  }
  assert.equal(normalizeMobile('+44 7700 900123'), '447700900123');
});

test('a person is shown by email, else by mobile', async () => {
  const { contactText, contactLine } = await import('../../src/lib/mobile.ts');
  assert.equal(contactText({ email: 'asha@x.in', phone: null }), 'asha@x.in');
  assert.equal(contactText({ email: null, phone: '919876543210' }), '+91 98765 43210');
  assert.equal(contactText({ email: '', phone: '9876543210' }), '+91 98765 43210');
  assert.equal(contactText({ phone: '+6591234567' }), '+6591234567', 'a stored international number keeps its country');
  assert.equal(contactText({ email: null, phone: null }), '');
  assert.equal(contactText(null), '');
  assert.equal(contactLine({ email: 'asha@x.in', phone: '919876543210' }), 'asha@x.in · +91 98765 43210');
  assert.equal(contactLine({ email: null, phone: '919876543210' }), '+91 98765 43210');
  assert.equal(contactLine({ email: 'asha@x.in' }), 'asha@x.in');
  assert.equal(contactLine(undefined), '');
});
