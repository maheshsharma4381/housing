// Sale and transfer (Phase 11D): the form checks what the database checks; what still blocks approval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transferDraftError, transferFeeError, transferBlocker, TRANSFER_WARNING } from '../../src/lib/transfer.ts';

test('application checks', () => {
  const ok = { buyer_name: 'Neha Joshi', buyer_mobile: '98765 43210', buyer_email: '', deed_date: '2026-11-20', deed_number: '' };
  const today = '2026-11-25';
  assert.equal(transferDraftError(ok, today), null);
  assert.equal(transferDraftError({ ...ok, buyer_name: ' N ' }, today), "Enter the buyer's name");
  assert.equal(transferDraftError({ ...ok, buyer_mobile: ' ' }, today), "Enter the buyer's mobile number");
  assert.equal(transferDraftError({ ...ok, buyer_mobile: '12345' }, today), 'Mobile 12345 is not a valid number');
  assert.equal(transferDraftError({ ...ok, buyer_mobile: '+44 20 7946 0958' }, today), null, 'an overseas number is allowed');
  assert.equal(transferDraftError({ ...ok, buyer_email: 'neha' }, today), 'Enter a valid email for the buyer');
  assert.equal(transferDraftError({ ...ok, deed_date: '' }, today), 'Enter the sale deed date');
  assert.equal(transferDraftError({ ...ok, deed_date: '2026-11-26' }, today), 'The sale deed date cannot be in the future');
  assert.equal(transferDraftError({ ...ok, deed_date: today }, today), null);
  assert.equal(transferDraftError({ ...ok, deed_number: 'x'.repeat(41) }, today), 'The registration number can be up to 40 characters');
});

test('fee checks', () => {
  assert.equal(transferFeeError(500, 25000), null);
  assert.equal(transferFeeError(500, 25001), 'The transfer premium can be at most ₹25,000');
  assert.equal(transferFeeError(-1, 0), 'Amounts must be between ₹0 and ₹1,00,000');
  assert.equal(transferFeeError(100001, 0), 'Amounts must be between ₹0 and ₹1,00,000');
  assert.equal(transferFeeError(Number.NaN, 0), 'Amounts must be between ₹0 and ₹1,00,000');
  assert.equal(TRANSFER_WARNING, 'Charge only what your bye-laws allow. The transfer premium is capped at ₹25,000.');
});

test('what blocks approval, in order', () => {
  assert.equal(transferBlocker({ feesBilled: false, certificateReceived: false, dues: 500 }), 'Bill the transfer fees first (₹0 if none)');
  assert.equal(transferBlocker({ feesBilled: true, certificateReceived: false, dues: 500 }), 'Tick that the original share certificate is received');
  assert.equal(transferBlocker({ feesBilled: true, certificateReceived: true, dues: 20500 }), 'Clear dues of ₹20,500 before the transfer');
  assert.equal(transferBlocker({ feesBilled: true, certificateReceived: true, dues: 0 }), null);
  assert.equal(transferBlocker({ feesBilled: true, certificateReceived: true, dues: -200 }), null, 'an advance does not block');
});
