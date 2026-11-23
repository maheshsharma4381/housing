import { test } from 'node:test';
import assert from 'node:assert/strict';
import { societyNav, societyTabFor, PHONE_BAR } from '../../src/lib/society-nav.ts';

test('the secretary menu: Home and Approvals, then Money, Society and Settings (spec 9.3)', () => {
  const nav = societyNav({ isAccountant: false });
  const by = (g: string) => nav.filter(i => i.group === g).map(i => i.label);
  assert.deepEqual(by('top'), ['Home', 'Approvals']);
  assert.deepEqual(by('money'), ['Maintenance bills', 'Payments received', 'Vendor bills', 'Reports']);
  assert.deepEqual(by('society'), ['Flats & residents', 'Notices', 'Polls', 'Staff', 'Requests & NOCs', 'Complaints', 'Documents']);
  assert.deepEqual(by('settings'), ['Society settings', 'CA & auditor', 'Plan & billing']);
  for (const moved of ['assets', 'bank', 'audit', 'ledgers', 'billtypes', 'opening', 'members']) assert.ok(!nav.some(i => i.id === moved), moved);
});

test('the accountant sees the Accounts group last', () => {
  const nav = societyNav({ isAccountant: true });
  assert.deepEqual(nav.filter(i => i.group === 'accounts').map(i => i.id), ['ledgers', 'billtypes', 'opening', 'assets', 'bank', 'audit']);
  assert.equal(nav.findIndex(i => i.group === 'accounts'), nav.length - 6);
});

test('old links and notification links open the right screen', () => {
  assert.equal(societyTabFor('members'), 'flats');
  assert.equal(societyTabFor('bills'), 'billing');
  assert.equal(societyTabFor('approvals'), 'approvals');
  assert.equal(societyTabFor('nonsense'), 'home');
  assert.equal(societyTabFor(null), 'home');
  assert.equal(societyTabFor('polls'), 'polls');
  assert.equal(societyTabFor('staff'), 'staff');
  assert.equal(societyTabFor('requests'), 'requests');
});

test('the phone bar', () => {
  assert.deepEqual(PHONE_BAR, ['home', 'billing', 'payments', 'complaints']);
});
