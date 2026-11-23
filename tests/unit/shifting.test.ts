// Shifting (Phase 11C): the booking form checks what the database checks; the refund split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftingDraftError, refundSplit, DIRECTION_LABELS, DEPOSIT_LABELS } from '../../src/lib/shifting.ts';

test('booking checks', () => {
  const ok = { direction: 'in', date: '2026-11-28', time: '10:00', vehicle: '' };
  const today = '2026-11-25';
  assert.equal(shiftingDraftError(ok, today, '08:00', '20:00'), null);
  assert.equal(shiftingDraftError({ ...ok, direction: '' }, today, '08:00', '20:00'), 'Choose moving in or moving out');
  assert.equal(shiftingDraftError({ ...ok, date: '2026-11-24' }, today, '08:00', '20:00'), 'Choose a date from today up to 90 days ahead');
  assert.equal(shiftingDraftError({ ...ok, date: '2027-02-24' }, today, '08:00', '20:00'), 'Choose a date from today up to 90 days ahead');
  assert.equal(shiftingDraftError({ ...ok, date: '2027-02-23' }, today, '08:00', '20:00'), null, '90 days ahead is allowed');
  assert.equal(shiftingDraftError({ ...ok, time: '07:59' }, today, '08:00', '20:00'), 'Shifting is allowed between 08:00 and 20:00');
  assert.equal(shiftingDraftError({ ...ok, time: '20:00' }, today, '08:00', '20:00'), null);
  assert.equal(shiftingDraftError({ ...ok, vehicle: 'x'.repeat(81) }, today, '08:00', '20:00'), 'Vehicle details can be up to 80 characters');
});

test('the refund split', () => {
  assert.deepEqual(refundSplit(10000, 2000), { refund: 8000, kept: 2000, error: null });
  assert.deepEqual(refundSplit(10000, 0), { refund: 10000, kept: 0, error: null });
  assert.equal(refundSplit(10000, 10001).error, 'The amount kept can be at most the deposit');
  assert.equal(refundSplit(10000, -1).error, 'The amount kept can be at most the deposit');
  assert.deepEqual(DIRECTION_LABELS, { in: 'Moving in', out: 'Moving out' });
  assert.deepEqual(DEPOSIT_LABELS, { none: 'No deposit', held: 'Deposit held', refunded: 'Deposit refunded', cancelled: 'Bill cancelled' });
});
