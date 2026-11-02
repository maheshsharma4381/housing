import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupTree, type Chart } from '../../src/lib/chart.ts';

const chart: Chart = {
  groups: [
    { id: 'exp', parent_id: null, name: 'Expenses', nature: 'expense', system_key: 'expenses', sort_order: 70, allows_ledgers: true },
    { id: 'ca', parent_id: null, name: 'Current Assets', nature: 'asset', system_key: 'current_assets', sort_order: 50, allows_ledgers: true },
    { id: 'bank', parent_id: 'ca', name: 'Bank Accounts', nature: 'asset', system_key: 'bank_accounts', sort_order: 51, allows_ledgers: true },
    { id: 'empty', parent_id: 'ca', name: 'Deposits', nature: 'asset', system_key: null, sort_order: 50, allows_ledgers: true },
  ],
  ledgers: [
    { code: '1000', name: 'HDFC Savings', nature: 'asset', group_id: 'bank', is_system: true, is_active: true, balance: 0, adjustable: true },
    { code: '1100', name: 'Cash in Hand', nature: 'asset', group_id: 'ca', is_system: true, is_active: true, balance: 0, adjustable: true },
    { code: '5100', name: 'Security Charges', nature: 'expense', group_id: 'exp', is_system: true, is_active: true, balance: 0, adjustable: true },
  ],
};
const rows = [
  { code: '5100', amt: 300 },
  { code: '1000', amt: 1000 },
  { code: '1100', amt: 50 },
];

test('groupTree nests a sub-group under its primary group, in sort order', () => {
  const tree = groupTree(chart, rows, (r) => r.amt);
  assert.deepEqual(tree.map((n) => n.group.name), ['Current Assets', 'Expenses']);
  const ca = tree[0];
  assert.deepEqual(ca.rows.map((r) => r.code), ['1100']);
  assert.deepEqual(ca.children.map((c) => c.group.name), ['Bank Accounts']);
  assert.deepEqual(ca.children[0].rows.map((r) => r.code), ['1000']);
});

test('totals roll up from sub-groups', () => {
  const [ca, exp] = groupTree(chart, rows, (r) => r.amt);
  assert.equal(ca.children[0].total, 1000);
  assert.equal(ca.total, 1050);
  assert.equal(exp.total, 300);
});

test('empty groups are pruned', () => {
  const tree = groupTree(chart, rows, (r) => r.amt);
  assert.ok(!tree[0].children.some((c) => c.group.id === 'empty'));
  assert.deepEqual(groupTree(chart, [{ code: '5100', amt: 1 }], (r) => r.amt).map((n) => n.group.id), ['exp']);
});

test('a row whose code is not in the chart lands in Unclassified and counts', () => {
  const tree = groupTree(chart, [...rows, { code: '9999', amt: 7 }], (r) => r.amt);
  const last = tree.at(-1)!;
  assert.equal(last.group.name, 'Unclassified');
  assert.equal(last.group.id, 'unclassified');
  assert.deepEqual(last.rows.map((r) => r.code), ['9999']);
  assert.equal(last.total, 7);
  assert.equal(tree.reduce((s, n) => s + n.total, 0), 1357);
});

test('a ledger in a group missing from the chart also lands in Unclassified', () => {
  const drift: Chart = { ...chart, ledgers: [...chart.ledgers, { code: '1C001', name: 'Lost', nature: 'asset', group_id: 'gone', is_system: false, is_active: true, balance: 0, adjustable: true }] };
  const tree = groupTree(drift, [{ code: '1C001', amt: 5 }], (r) => r.amt);
  assert.deepEqual(tree.map((n) => [n.group.id, n.total]), [['unclassified', 5]]);
});
