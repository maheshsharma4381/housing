import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTallyXml, tallyParentName } from '../../src/lib/tally-xml.ts';
import type { Chart, ChartGroup, ChartLedger } from '../../src/lib/chart.ts';

const g = (id: string, name: string, nature: ChartGroup['nature'], system_key: string | null, parent_id: string | null = null): ChartGroup =>
  ({ id, parent_id, name, nature, system_key, sort_order: 0, allows_ledgers: true });
const l = (code: string, name: string, nature: ChartLedger['nature'], group_id: string): ChartLedger =>
  ({ code, name, nature, group_id, is_system: !code.includes('C'), is_active: true, balance: 0, adjustable: true });

const chart: Chart = {
  groups: [
    g('cf', 'Capital & Funds', 'equity', 'capital_funds'),
    g('cl', 'Current Liabilities', 'liability', 'current_liabilities'),
    g('sc', 'Sundry Creditors', 'liability', 'sundry_creditors', 'cl'),
    g('dt', 'Duties & Taxes', 'liability', 'duties_taxes', 'cl'),
    g('fa', 'Fixed Assets', 'asset', 'fixed_assets'),
    g('inv', 'Investments', 'asset', 'investments'),
    g('ca', 'Current Assets', 'asset', 'current_assets'),
    g('bank', 'Banks', 'asset', 'bank_accounts', 'ca'),
    g('inc', 'Income', 'income', 'income'),
    g('exp', 'Expenses', 'expense', 'expenses'),
    g('fds', 'FDs', 'asset', null, 'inv'),
  ],
  ledgers: [
    l('1000', 'Bank Accounts', 'asset', 'bank'),
    l('1540', 'CCTV & Security Equipment', 'asset', 'fa'),
    l('2200', 'TDS Payable', 'liability', 'dt'),
    l('2000', 'Sundry Creditors', 'liability', 'sc'),
    l('3000', 'Sinking Fund', 'equity', 'cf'),
    l('5100', 'Security & Guards', 'expense', 'exp'),
    l('4000', 'Maintenance Charges', 'income', 'inc'),
    l('1C001', 'SBI FD', 'asset', 'fds'),
  ],
};
const parentOf = (code: string) => tallyParentName(chart, chart.ledgers.find((x) => x.code === code)!.group_id);

test('Tally groups for standard ledgers follow the chart', () => {
  assert.equal(parentOf('1000'), 'Bank Accounts', 'a renamed system group still maps to the Tally group');
  assert.equal(parentOf('1540'), 'Fixed Assets');
  assert.equal(parentOf('2200'), 'Duties & Taxes');
  assert.equal(parentOf('3000'), 'Reserves & Surplus');
  assert.equal(parentOf('5100'), 'Indirect Expenses');
  assert.equal(parentOf('1C001'), 'FDs');
});

test('journal vouchers use Tally signs and only the ledgers they need', () => {
  const xml = buildTallyXml('Palm Heights <CHS>', chart, [{
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
  assert.ok(!xml.includes('<GROUP '), 'no group masters when only standard groups are used');
  assert.match(xml, /<LEDGER NAME="TDS Payable" ACTION="Create"><NAME>TDS Payable<\/NAME><PARENT>Duties &amp; Taxes<\/PARENT>/);
  const amounts = [...xml.matchAll(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].map((m) => Number(m[1]));
  assert.equal(amounts.reduce((s, a) => s + a, 0), 0, 'voucher balances');
});

test('a CA sub-group is created as a Tally group before its ledgers', () => {
  const xml = buildTallyXml('Palm Heights', chart, [{
    entry_number: 'JV-000008', entry_date: '2026-10-16', narration: 'FD booked',
    lines: [{ code: '1C001', amount: 50000 }, { code: '1000', amount: -50000 }],
  }]);
  const group = xml.indexOf('<GROUP NAME="FDs" ACTION="Create"><NAME>FDs</NAME><PARENT>Investments</PARENT></GROUP>');
  const ledger = xml.indexOf('<LEDGER NAME="SBI FD" ACTION="Create"><NAME>SBI FD</NAME><PARENT>FDs</PARENT></LEDGER>');
  assert.ok(group >= 0, 'group master emitted');
  assert.ok(ledger > group, 'ledger master comes after its group');
});
