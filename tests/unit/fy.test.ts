// "This year" / "Last year" on My account are Indian financial years (April to March).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fyRange } from '../../src/lib/fy.ts';

test('from April the year runs to next March; before April it began last April', () => {
  assert.deepEqual(fyRange('this', new Date(2026, 10, 5)), { from: '2026-04-01', to: '2027-03-31' });
  assert.deepEqual(fyRange('this', new Date(2027, 1, 10)), { from: '2026-04-01', to: '2027-03-31' });
  assert.deepEqual(fyRange('last', new Date(2026, 10, 5)), { from: '2025-04-01', to: '2026-03-31' });
  assert.deepEqual(fyRange('this', new Date(2026, 3, 1)), { from: '2026-04-01', to: '2027-03-31' });
});
