// GST on Sahvaas's own invoices: the same state gets CGST + SGST, another state IGST.
// Societies typed their state freely before the list, so names are matched by GST state code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stateCode, canonicalState, INDIAN_STATES } from '../../src/lib/india-states.ts';
import { gstSplit } from '../../src/lib/billing.ts';

test('a state is known by its name, an old name, a short code or a GSTIN', () => {
  for (const s of ['Maharashtra', ' maharashtra ', 'MH', 'mh', '27AAACS1234F1Z5']) assert.equal(stateCode(s), '27', s);
  assert.equal(stateCode('Orissa'), '21');
  assert.equal(stateCode('Jammu & Kashmir'), '01');
  assert.equal(stateCode('NCT of Delhi'), '07');
  assert.equal(stateCode('Telangana'), '36');
  assert.equal(stateCode('TG'), '36');
  assert.equal(stateCode('Dadra & Nagar Haveli'), '26');
  assert.equal(stateCode('Atlantis'), null);
  assert.equal(stateCode(''), null);
  assert.equal(stateCode(null), null);
  assert.equal(canonicalState('orissa'), 'Odisha');
  assert.equal(canonicalState('Pondicherry'), 'Puducherry');
  assert.equal(canonicalState('Nowhere'), null);
  assert.equal(new Set(INDIAN_STATES.map(s => s.code)).size, INDIAN_STATES.length, 'one entry per code');
});

const inv = (seller: { state?: string; gstin?: string }, buyer: { state?: string; gstin?: string | null }) =>
  ({ gst_amount: 180, gst_rate: 18, seller, bill_to: buyer });

test('the GST split goes by state code', () => {
  assert.deepEqual(gstSplit(inv({ state: 'Maharashtra' }, { state: 'MH' })).map(l => l.label), ['CGST 9%', 'SGST 9%']);
  assert.deepEqual(gstSplit(inv({ state: 'Maharashtra' }, { state: 'Karnataka' })).map(l => l.label), ['IGST 18%']);
  // a GSTIN says the state even when the typed name is wrong
  assert.deepEqual(gstSplit(inv({ state: 'Maharashtra', gstin: '27AAACS1234F1Z5' }, { state: 'Karnataka', gstin: '27AABCT9999K1Z2' })).map(l => l.label), ['CGST 9%', 'SGST 9%']);
  // text that names no state falls back to comparing the names
  assert.deepEqual(gstSplit(inv({ state: 'Atlantis' }, { state: ' atlantis' })).map(l => l.label), ['CGST 9%', 'SGST 9%']);
  assert.deepEqual(gstSplit(inv({ state: 'Maharashtra' }, {})).map(l => l.label), ['IGST 18%']);
  const halves = gstSplit(inv({ state: 'MH' }, { state: 'Maharashtra' }));
  assert.equal(halves[0].amount + halves[1].amount, 180);
});
