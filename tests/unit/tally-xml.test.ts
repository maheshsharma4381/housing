import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTallyXml, tallyGroup } from '../../src/lib/tally-xml.ts';

const ledgers = [
  { code: '1000', name: 'Bank Accounts', type: 'asset' },
  { code: '2200', name: 'TDS Payable', type: 'liability' },
  { code: '2000', name: 'Sundry Creditors', type: 'liability' },
  { code: '5100', name: 'Security & Guards', type: 'expense' },
  { code: '4000', name: 'Maintenance Charges', type: 'income' },
];

test('Tally groups for standard accounts', () => {
  assert.equal(tallyGroup('1000', 'asset'), 'Bank Accounts');
  assert.equal(tallyGroup('1540', 'asset'), 'Fixed Assets');
  assert.equal(tallyGroup('2200', 'liability'), 'Duties & Taxes');
  assert.equal(tallyGroup('3000', 'equity'), 'Reserves & Surplus');
  assert.equal(tallyGroup('5100', 'expense'), 'Indirect Expenses');
});

test('journal vouchers use Tally signs and only the ledgers they need', () => {
  const xml = buildTallyXml('Palm Heights <CHS>', ledgers, [{
    entry_number: 'JV-000007', entry_date: '2026-10-15', narration: 'Payment VP-0001 for EXP-0001 "Guards" & co',
    lines: [{ code: '2000', amount: 47200 }, { code: '1000', amount: -46400 }, { code: '2200', amount: -800 }, { code: '5100', amount: 0 }],
  }]);
  assert.match(xml, /<SVCURRENTCOMPANY>Palm Heights &lt;CHS&gt;<\/SVCURRENTCOMPANY>/);
  assert.match(xml, /<DATE>20261015<\/DATE>/);
  assert.match(xml, /<NARRATION>Payment VP-0001 for EXP-0001 &quot;Guards&quot; &amp; co<\/NARRATION>/);
  assert.match(xml, /<LEDGERNAME>Sundry Creditors<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-47200.00<\/AMOUNT>/);
  assert.match(xml, /<LEDGERNAME>Bank Accounts<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>46400.00<\/AMOUNT>/);
  assert.ok(!xml.includes('Security &amp; Guards</LEDGERNAME>'), 'zero lines are skipped');
  assert.ok(!xml.includes('LEDGER NAME="Maintenance Charges"'), 'unused ledgers are not exported');
  assert.match(xml, /<LEDGER NAME="TDS Payable" ACTION="Create"><NAME>TDS Payable<\/NAME><PARENT>Duties &amp; Taxes<\/PARENT>/);
  const amounts = [...xml.matchAll(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].map(m => Number(m[1]));
  assert.equal(amounts.reduce((s, a) => s + a, 0), 0, 'voucher balances');
});
