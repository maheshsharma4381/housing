import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gstinCheckDigitOk, vendorPan, panEntity, explainTds, suggestsAsset, fyEndFor, fyLabel } from '../../src/lib/tds.ts';
import { normaliseExtraction, parseAmount, parseInvoiceDate, openAiInvoiceTool } from '../../src/lib/invoice-extract.ts';

test('OpenAI-compatible invoice tool has plain types and no null enum values', () => {
  const tool = openAiInvoiceTool(['cctv', 'other']);
  assert.equal(tool.type, 'function');
  assert.equal(tool.function.name, 'record_invoice');
  const props = tool.function.parameters.properties as Record<string, { type: unknown; enum?: unknown[] }>;
  for (const [key, p] of Object.entries(props)) assert.equal(typeof p.type, 'string', `${key} has a single type`);
  assert.deepEqual(props.category.enum, ['cctv', 'other']);
  assert.equal(props.subtotal.type, 'string', 'amounts come back as printed text');
  assert.equal(props.material_shown_separately.type, 'boolean');
});

test('GSTIN check digit', () => {
  assert.equal(gstinCheckDigitOk('27AAPFU0939F1ZV'), true);
  assert.equal(gstinCheckDigitOk('27AAPFU0939F1ZW'), false);
  assert.equal(gstinCheckDigitOk('27AAPFU0939F1Z'), false);
});

test('PAN from GSTIN and entity from its 4th letter', () => {
  assert.equal(vendorPan(null, '27aakcs5521p1z6'), 'AAKCS5521P');
  assert.equal(vendorPan('abcpp1234k', '27AAKCS5521P1Z6'), 'ABCPP1234K', 'explicit PAN wins');
  assert.equal(vendorPan('bad', 'bad'), null);
  assert.equal(panEntity('ABCPP1234K'), 'individual');
  assert.equal(panEntity('AAAHH1234K'), 'individual');
  assert.equal(panEntity('AAKCS5521P'), 'other');
  assert.equal(panEntity(null), null);
});

test('TDS explanations', () => {
  assert.match(
    explainTds({ applies: true, nature: 'contract', section: '194C', label: 'Contract work', rate: 2, amount: 2000, base: 100000,
      rate_source: 'other', reason: 'single_bill', single_limit: 30000, annual_limit: 100000 }),
    /Contract work \(194C\) · vendor is a company \/ firm · 2% on ₹1,00,000 — single bill above ₹30,000/
  );
  assert.match(
    explainTds({ applies: false, nature: 'contract', section: '194C', label: 'Contract work', rate: 0, amount: 0, reason: 'below_limits',
      single_limit: 30000, annual_limit: 100000, fy_total: 1800 }),
    /below the limits .* ₹30,000 .* ₹1,00,000 \(now ₹1,800\)/
  );
  assert.equal(explainTds({ applies: false, nature: 'goods', rate: 0, amount: 0, reason: 'goods' }), 'Purchase of goods — no TDS.');
});

test('asset suggestion and financial year helpers', () => {
  assert.equal(suggestsAsset({ asset_account_code: '1540', asset_threshold: 25000 }, 118000), true);
  assert.equal(suggestsAsset({ asset_account_code: '1540', asset_threshold: 25000 }, 2000), false);
  assert.equal(suggestsAsset({ asset_account_code: null, asset_threshold: null }, 1e9), false);
  assert.equal(fyEndFor(new Date(2026, 9, 20)), '2027-03-31');
  assert.equal(fyEndFor(new Date(2027, 2, 31)), '2027-03-31');
  assert.equal(fyEndFor(new Date(2027, 3, 1)), '2028-03-31');
  assert.equal(fyLabel('2027-03-31'), 'FY 2026-27');
});

test('invoice reader output is cleaned and checked', () => {
  assert.equal(parseInvoiceDate('14-10-2026'), '2026-10-14');
  assert.equal(parseInvoiceDate('14/10/26'), '2026-10-14');
  assert.equal(parseInvoiceDate('2026-10-14'), '2026-10-14');
  assert.equal(parseInvoiceDate('14 Oct 2026'), '2026-10-14');
  assert.equal(parseInvoiceDate('31-02-2026'), null);
  assert.equal(parseAmount('₹ 1,00,000.50'), 100000.5);
  assert.equal(parseAmount('Rs. 18,000'), 18000);
  assert.equal(parseAmount('-5'), null);
  assert.equal(parseAmount('abc'), null);

  const ok = normaliseExtraction({
    vendor_name: ' SecureVision Systems Pvt Ltd ', gstin: '27aakcs5521p1z6', invoice_number: 'SVS/1187', invoice_date: '14-10-2026',
    subtotal: '1,00,000', gst: 18000, total: 118000, category: 'cctv', material_shown_separately: false, vendor_phone: '+91 98200 11223',
  }, ['cctv', 'other']);
  assert.deepEqual(
    [ok.vendor_name, ok.gstin, ok.invoice_date, ok.subtotal, ok.gst, ok.category, ok.vendor_phone, ok.warnings],
    ['SecureVision Systems Pvt Ltd', '27AAKCS5521P1Z6', '2026-10-14', 100000, 18000, 'cctv', '+919820011223', []]
  );

  const bad = normaliseExtraction({ gstin: 'NOTAGSTIN', subtotal: 100, gst: 18, total: 200, category: 'drop table', invoice_date: 'yesterday' }, ['other']);
  assert.equal(bad.gstin, null);
  assert.equal(bad.category, null);
  assert.equal(bad.warnings.length, 3);
  assert.deepEqual(normaliseExtraction(null, []).warnings, []);

  const gstFromTotal = normaliseExtraction({ subtotal: 5000, total: 5900 }, []);
  assert.equal(gstFromTotal.gst, 900);
});
