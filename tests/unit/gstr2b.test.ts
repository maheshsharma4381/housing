import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGstr2bCsv, parseGstr2bJson, toIsoDate, GSTR2B_CSV_TEMPLATE } from '../../src/lib/gstr2b.ts';

const portalJson = JSON.stringify({
  chksum: 'x',
  data: {
    gstin: '27AAAAA0000A1Z5',
    rtnprd: '102026',
    docdata: {
      b2b: [
        {
          ctin: '27aapfu0939f1zv',
          trdnm: 'GUARD CO',
          inv: [
            { inum: 'SG/2026/0045', dt: '05-10-2026', val: 11800, typ: 'R', itcavl: 'Y',
              items: [{ txval: 6000, cgst: 540, sgst: 540 }, { txval: 4000, cgst: 360, sgst: 360 }] },
            { inum: 'SG/2026/0046', dt: '31-02-2026', val: 100 },
          ],
        },
        { ctin: '29ABCDE1234F1Z5', trdnm: 'LIFT CO', inv: [{ inum: 'L-77', dt: '12-10-2026', txval: 5000, igst: 900, itcavl: 'N' }] },
      ],
      cdnr: [{ ctin: '29ABCDE1234F1Z5', nt: [] }],
    },
  },
});

test('toIsoDate understands portal date formats and rejects impossible dates', () => {
  assert.equal(toIsoDate('05-10-2026'), '2026-10-05');
  assert.equal(toIsoDate('5/1/2026'), '2026-01-05');
  assert.equal(toIsoDate('2026-10-05'), '2026-10-05');
  assert.equal(toIsoDate('05-Oct-26'), '2026-10-05');
  assert.equal(toIsoDate('31-02-2026'), null);
  assert.equal(toIsoDate('yesterday'), null);
});

test('parses official GSTR-2B JSON: sums items, reads header, reports skipped sections and bad rows', () => {
  const r = parseGstr2bJson(portalJson);
  assert.equal(r.gstin, '27AAAAA0000A1Z5');
  assert.equal(r.returnPeriod, '102026');
  assert.deepEqual(r.skipped, { cdnr: 1 });
  assert.deepEqual(r.errors, ['Supplier 1 (27AAPFU0939F1ZV), invoice 2: invalid date "31-02-2026".']);
  assert.equal(r.invoices.length, 2);
  assert.deepEqual(r.invoices[0], {
    supplier_gstin: '27AAPFU0939F1ZV', supplier_name: 'GUARD CO', invoice_number: 'SG/2026/0045',
    invoice_date: '2026-10-05', invoice_type: 'B2B', invoice_value: 11800, taxable_value: 10000,
    igst: 0, cgst: 900, sgst: 900, itc_available: 'Y',
  });
  assert.equal(r.invoices[1].invoice_value, 5900, 'computed when val is absent');
  assert.equal(r.invoices[1].itc_available, 'N');
});

test('rejects files that are not GSTR-2B JSON', () => {
  assert.deepEqual(parseGstr2bJson('not json').errors, ['This is not a valid JSON file.']);
  assert.match(parseGstr2bJson('{"data":{}}').errors[0], /No "docdata" section/);
});

test('parses the CSV template', () => {
  const r = parseGstr2bCsv(GSTR2B_CSV_TEMPLATE);
  assert.deepEqual(r.errors, []);
  assert.equal(r.invoices[0].taxable_value, 10000);
  assert.equal(r.invoices[0].invoice_date, '2026-10-05');
});

test('parses the portal B2B sheet saved as CSV (title rows, ₹ headers, comma amounts)', () => {
  const csv = [
    'Goods and Services Tax - GSTR-2B,,,,,,,,,',
    'Taxable inward supplies received from registered persons,,,,,,,,,',
    'GSTIN of supplier,Trade/Legal name,Invoice number,Invoice Date,Invoice Value(₹),Taxable Value (₹),Integrated Tax(₹),Central Tax(₹),State/UT Tax(₹),ITC Availability',
    '29ABCDE1234F1Z5,LIFT CO,L-77,12/10/2026,"5,900.00","5,000.00",900,0,0,No',
    'BAD,X,1,12/10/2026,1,1,0,0,0,Yes',
    ',,,,,,,,,',
  ].join('\n');
  const r = parseGstr2bCsv(csv);
  assert.deepEqual(r.errors, ['Line 5: invalid GSTIN "BAD".']);
  assert.deepEqual(r.invoices, [{
    supplier_gstin: '29ABCDE1234F1Z5', supplier_name: 'LIFT CO', invoice_number: 'L-77', invoice_date: '2026-10-12',
    invoice_type: 'B2B', invoice_value: 5900, taxable_value: 5000, igst: 900, cgst: 0, sgst: 0, itc_available: 'N',
  }]);
});
