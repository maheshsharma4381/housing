import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseUnitCsv, UNIT_CSV_TEMPLATE } from '../../src/lib/unit-csv.ts';

test('parseCsv handles quotes, escaped quotes, CRLF and blank lines', () => {
  const rows = parseCsv('a,b\r\n"Tower, East","He said ""hi"""\r\n\r\nx,\n');
  assert.deepEqual(rows, [['a', 'b'], ['Tower, East', 'He said "hi"'], ['x', '']]);
});

test('template parses cleanly', () => {
  const { rows, errors } = parseUnitCsv(UNIT_CSV_TEMPLATE);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], {
    building: 'Tower A', wing: 'A', floor: 1, unit_number: 'A-102',
    unit_type: '3BHK', carpet_area_sqft: 920, occupancy_status: 'tenant_occupied',
  });
});

test('accepts header aliases and friendly occupancy values', () => {
  const { rows, errors } = parseUnitCsv('﻿Tower,Flat No,BHK,Area,Occupancy\nT1,101,2BHK,"1,050",Tenant\n');
  assert.deepEqual(errors, []);
  assert.deepEqual(rows[0], { building: 'T1', unit_number: '101', unit_type: '2BHK', carpet_area_sqft: 1050, occupancy_status: 'tenant_occupied' });
});

test('reports line-numbered errors and skips bad rows', () => {
  const { rows, errors } = parseUnitCsv('wing,unit_number,floor,occupancy\nA,101,1,owner\nA,,2,owner\nA,102,two,owner\nA,103,3,sold\nA,101,1,owner\n');
  assert.equal(rows.length, 1);
  assert.deepEqual(errors, [
    'Line 3: unit_number is empty.',
    'Line 4: floor "two" is not a whole number.',
    'Line 5: occupancy "sold" must be owner, tenant, vacant or renovation.',
    'Line 6: duplicate flat 101 in the same wing.',
  ]);
});

test('requires a unit_number column', () => {
  assert.deepEqual(parseUnitCsv('wing,floor\nA,1\n').errors, ['Header must include a unit_number (or flat / flat_no) column.']);
  assert.deepEqual(parseUnitCsv('').errors, ['The file is empty.']);
});
