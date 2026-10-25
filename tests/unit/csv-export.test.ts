import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv } from '../../src/lib/csv-export.ts';

test('toCsv quotes commas, quotes and newlines', () => {
  const csv = toCsv(
    [{ name: 'Repair, Lift', note: 'He said "ok"\nthen left', amount: -250.5 }],
    [
      { header: 'Name', value: r => r.name },
      { header: 'Note', value: r => r.note },
      { header: 'Amount', value: r => r.amount },
    ]
  );
  assert.equal(csv, 'Name,Note,Amount\r\n"Repair, Lift","He said ""ok""\nthen left",-250.5\r\n');
});

test('toCsv neutralises spreadsheet formulas but keeps negative numbers', () => {
  const csv = toCsv([{ v: '=HYPERLINK("x")' }, { v: '-100' }, { v: null }], [{ header: 'V', value: r => r.v }]);
  assert.equal(csv, 'V\r\n"\'=HYPERLINK(""x"")"\r\n-100\r\n\r\n');
});
