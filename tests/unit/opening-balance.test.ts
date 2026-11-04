import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signed, sideTotal, fyEnds, catchupLabel, OPENING_TEMPLATE, type AuditedLine } from '../../src/lib/opening-balance.ts';

test('a liability is stored as a credit and reads back as entered', () => {
  assert.equal(signed('liabilities', 500), -500);
  assert.equal(signed('assets', 500), 500);
  assert.equal(signed('liabilities', signed('liabilities', 7)), 7);
});

test('a side totals as printed, contra lines included', () => {
  const lines: AuditedLine[] = [
    { code: '3000', amount: -60000, side: 'liabilities' },
    { code: '1000', amount: 80000, side: 'assets' },
    { code: '1590', amount: -5000, side: 'assets' },
  ];
  assert.equal(sideTotal(lines, 'assets'), 75000);
  assert.equal(sideTotal(lines, 'liabilities'), 60000);
});

test('the audited date is a 31 March that has passed', () => {
  assert.deepEqual(fyEnds(new Date('2026-11-03T10:00:00')), ['2026-03-31', '2025-03-31', '2024-03-31']);
  assert.equal(fyEnds(new Date('2027-03-31T10:00:00'))[0], '2026-03-31');
  assert.equal(fyEnds(new Date('2027-04-01T10:00:00'))[0], '2027-03-31');
});

test('the catch-up covers the months between the audit and go-live', () => {
  assert.equal(catchupLabel('2026-03-31', '2026-10-01'), 'Catch-up from 1 Apr 2026 to 30 Sep 2026');
  assert.equal(catchupLabel('2026-03-31', '2026-04-01'), null);
  assert.equal(catchupLabel('2026-03-31', '2026-03-31'), null);
});

test('every starting line names a ledger, a group to create one in, or a list to pick from', () => {
  for (const line of OPENING_TEMPLATE) {
    const ways = [line.code, line.groupKey, line.pickFrom].filter(Boolean).length;
    assert.equal(ways, 1, line.label);
  }
  assert.ok(OPENING_TEMPLATE.some((l) => l.side === 'liabilities' && l.code === '2000'));
  assert.ok(OPENING_TEMPLATE.some((l) => l.side === 'assets' && l.code === '1200'));
});
