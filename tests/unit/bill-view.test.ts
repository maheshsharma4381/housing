// The printed bill must say when it no longer asks for money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billView } from '../../src/lib/bill-view.ts';

test('a cancelled bill says so and asks for nothing', () => {
  assert.deepEqual(billView('cancelled', 0), { heading: 'MAINTENANCE BILL — CANCELLED', asksForPayment: false });
});

test('a paid bill is marked paid; an open one asks for payment', () => {
  assert.deepEqual(billView('paid', 0), { heading: 'MAINTENANCE BILL — PAID', asksForPayment: false });
  assert.deepEqual(billView('issued', 1100), { heading: 'MAINTENANCE BILL', asksForPayment: true });
  assert.deepEqual(billView('partially_paid', 100), { heading: 'MAINTENANCE BILL', asksForPayment: true });
});
