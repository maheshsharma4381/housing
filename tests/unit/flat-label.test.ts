// Lists of flats: the same number can exist in two wings (CSV imports: "101" in A and in B).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatKey, flatLabels } from '../../src/lib/flat-label.ts';

test('the wing is added only where the same number is in two wings', () => {
  const rows = [
    { wing: 'A', unit_number: '101' }, { wing: 'B', unit_number: '101' }, { wing: 'A', unit_number: '102' },
  ];
  assert.deepEqual(flatLabels(rows), ['A-101', 'B-101', '102']);
  assert.notEqual(flatKey(rows[0]), flatKey(rows[1]));
});

test('numbers that already carry their wing are left alone', () => {
  const rows = [{ wing: 'A', unit_number: 'A-101' }, { wing: 'B', unit_number: 'B-101' }, { wing: null, unit_number: '7' }];
  assert.deepEqual(flatLabels(rows), ['A-101', 'B-101', '7']);
  // a wing that is already the prefix is not added twice, even when the number repeats across wings
  assert.deepEqual(flatLabels([{ wing: 'a', unit_number: 'A101' }, { wing: 'B', unit_number: 'A101' }]), ['A101', 'B-A101']);
});

test('a numeric wing is only a prefix with a separator', () => {
  assert.deepEqual(flatLabels([{ wing: '1', unit_number: '101' }, { wing: '2', unit_number: '101' }]), ['1-101', '2-101']);
});
