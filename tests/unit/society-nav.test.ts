import { test } from 'node:test';
import assert from 'node:assert/strict';
import { societyNav } from '../../src/lib/society-nav.ts';

test('the secretary menu has no accounting screens', () => {
  const ids = societyNav({ isAccountant: false }).map(i => i.id);
  for (const moved of ['assets', 'bank', 'audit', 'ledgers', 'billtypes', 'opening']) assert.ok(!ids.includes(moved as never), moved);
  assert.deepEqual(ids.slice(0, 2), ['home', 'approvals']);
});

test('the accountant sees the Accounts group after the main items', () => {
  const nav = societyNav({ isAccountant: true });
  assert.deepEqual(nav.filter(i => i.group === 'accounts').map(i => i.id), ['ledgers', 'billtypes', 'opening', 'assets', 'bank', 'audit']);
  assert.equal(nav.findIndex(i => i.group === 'accounts'), nav.filter(i => i.group === 'main').length);
});
