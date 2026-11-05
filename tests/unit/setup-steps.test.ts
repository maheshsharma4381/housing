// The setup wizard's decisions, without the screen: where to resume, when the first bills fall due, a valid UPI ID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSetupStep, firstBillDates, isValidUpiId } from '../../src/lib/setup.ts';

const base = { steps: ['society'], flats: 0, rules: 0, upi: false, owners_entered: 0, joined_owners: 0, bills: 0 };

test('resume at the first unfinished step', () => {
  assert.equal(nextSetupStep(base), 'flats');
  assert.equal(nextSetupStep({ ...base, flats: 40 }), 'maintenance', 'flats uploaded from Excel count');
  assert.equal(nextSetupStep({ ...base, flats: 40, rules: 2 }), 'upi');
  assert.equal(nextSetupStep({ ...base, flats: 40, rules: 2, upi: true }), 'owners');
  assert.equal(nextSetupStep({ ...base, flats: 40, rules: 2, steps: ['society', 'upi_skipped'] }), 'owners', 'UPI "Later"');
  assert.equal(nextSetupStep({ ...base, flats: 40, rules: 2, upi: true, owners_entered: 3 }), 'done', 'owners entered elsewhere');
  assert.equal(nextSetupStep({ ...base, flats: 40, rules: 2, upi: true, steps: ['society', 'owners_skipped'] }), 'done');
  assert.equal(nextSetupStep({ ...base, bills: 5 }), 'done', 'bills already issued: nothing left to set up');
});

test('the first bills are never due in less than a week', () => {
  assert.deepEqual(firstBillDates(new Date(2026, 10, 2), 10), { start: '2026-11-01', end: '2026-11-30', due: '2026-11-10' });
  // the 5th, due day 10: only 5 days away — due next month's 10th
  assert.deepEqual(firstBillDates(new Date(2026, 10, 5), 10), { start: '2026-11-01', end: '2026-11-30', due: '2026-12-10' });
  assert.deepEqual(firstBillDates(new Date(2026, 11, 20), 5), { start: '2026-12-01', end: '2026-12-31', due: '2027-01-05' });
});

test('a UPI ID is handle@bank, not an email address', () => {
  assert.equal(isValidUpiId('palmheights@icici'), true);
  assert.equal(isValidUpiId('soc@gmail.com'), false);
  assert.equal(isValidUpiId('x'), false);
});

test('Back goes one step, never to redo the society or the flats', async () => {
  const { previousSetupStep } = await import('../../src/lib/setup.ts');
  assert.equal(previousSetupStep('society'), null);
  assert.equal(previousSetupStep('flats'), null);
  assert.equal(previousSetupStep('maintenance'), 'flats');
  assert.equal(previousSetupStep('upi'), 'maintenance');
  assert.equal(previousSetupStep('owners'), 'upi');
  assert.equal(previousSetupStep('done'), 'owners');
});
