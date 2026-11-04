import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withoutWaitingFlats } from '../../src/lib/notify-recipients.ts';
import { statementHtml } from '../../src/lib/statement-html.ts';

test('no bill or receipt email goes out for a flat whose new owner has not joined yet', () => {
  const items = [{ unit_id: 'u1', n: 1 }, { unit_id: 'u2', n: 2 }, { unit_id: 'u1', n: 3 }];
  assert.deepEqual(withoutWaitingFlats(items, ['u1']).map((i) => i.n), [2]);
  assert.equal(withoutWaitingFlats(items, []).length, 3);
});

test("an owner's statement prints on its own page, brought forward first", () => {
  const html = statementHtml({
    title: 'Flat 101 · Neha <Shah>', openingLabel: 'Brought forward from previous owner',
    statement: { name: 'Flat 101', opening: 2000, closing: 1500,
      lines: [{ date: '2026-11-05', entry_number: 'JV-000010', narration: 'Payment received', debit: null, credit: 500, balance: 1500 }] },
  });
  assert.match(html, /<title>Flat 101 · Neha &lt;Shah&gt;<\/title>/);
  assert.match(html, /Brought forward from previous owner/);
  assert.match(html, /JV-000010/);
  assert.ok(html.indexOf('Brought forward') < html.indexOf('JV-000010'));
  assert.match(html, /window\.print\(\)/);
});
