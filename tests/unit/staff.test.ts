// Staff register (Phase 10): the kinds of staff and their labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAFF_KINDS, staffKindLabel } from '../../src/lib/staff.ts';

test('staff kinds and labels', () => {
  assert.deepEqual(STAFF_KINDS.map((k) => k.id), ['maid', 'driver', 'cook', 'cleaner', 'nanny', 'other']);
  assert.deepEqual(STAFF_KINDS.map((k) => k.label), ['Maid', 'Driver', 'Cook', 'Cleaner', 'Nanny', 'Other']);
  assert.equal(staffKindLabel('nanny'), 'Nanny');
  assert.equal(staffKindLabel('gardener'), 'Other');
});
