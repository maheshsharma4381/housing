import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountInWords, formatINR } from '../../src/lib/inr.ts';

test('amountInWords uses the Indian numbering system', () => {
  assert.equal(amountInWords(0), 'Rupees Zero Only');
  assert.equal(amountInWords(7), 'Rupees Seven Only');
  assert.equal(amountInWords(115), 'Rupees One Hundred Fifteen Only');
  assert.equal(amountInWords(2685), 'Rupees Two Thousand Six Hundred Eighty Five Only');
  assert.equal(amountInWords(150000), 'Rupees One Lakh Fifty Thousand Only');
  assert.equal(amountInWords(12345678), 'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only');
});

test('amountInWords handles paise and float rounding', () => {
  assert.equal(amountInWords(3172.2), 'Rupees Three Thousand One Hundred Seventy Two and Twenty Paise Only');
  assert.equal(amountInWords(0.1 + 0.2), 'Rupees Zero and Thirty Paise Only');
});

test('formatINR groups digits Indian style', () => {
  assert.equal(formatINR(150000), '₹1,50,000');
  assert.equal(formatINR('3172.2'), '₹3,172.20');
  assert.equal(formatINR(null), '₹0');
});
