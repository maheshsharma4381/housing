// "This year" / "Last year" on My account are Indian financial years (April to March).
// "This year" runs to today: a statement cannot close on a date that has not come yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fyRange } from '../../src/lib/fy.ts';

test('this year runs from April to today; before April it began last April', () => {
  assert.deepEqual(fyRange('this', new Date(2026, 10, 5)), { from: '2026-04-01', to: '2026-11-05' });
  assert.deepEqual(fyRange('this', new Date(2027, 1, 10)), { from: '2026-04-01', to: '2027-02-10' });
  assert.deepEqual(fyRange('this', new Date(2026, 3, 1)), { from: '2026-04-01', to: '2026-04-01' });
  assert.deepEqual(fyRange('this', new Date(2027, 2, 31)), { from: '2026-04-01', to: '2027-03-31' });
});

test('last year is the whole previous April to March', () => {
  assert.deepEqual(fyRange('last', new Date(2026, 10, 5)), { from: '2025-04-01', to: '2026-03-31' });
  assert.deepEqual(fyRange('last', new Date(2027, 1, 10)), { from: '2025-04-01', to: '2026-03-31' });
});
