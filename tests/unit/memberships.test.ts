import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMembership, type MembershipRow } from '../../src/lib/memberships.ts';

const row = (extra: Partial<MembershipRow>): MembershipRow => ({
  id: 'm1', society_id: 's1', user_id: 'u1', role: 'treasurer', is_primary_contact: false, is_active: true,
  joined_date: '2026-11-01', created_at: '2026-11-01', updated_at: '2026-11-01',
  societies: { id: 's1', name: 'Test Heights', is_active: true } as MembershipRow['societies'],
  ...extra,
});

test('the Accountant switch reaches the app', () => {
  assert.equal(toMembership(row({ is_accountant: true })).is_accountant, true);
  assert.equal(toMembership(row({})).is_accountant, false);
  assert.equal(toMembership(row({})).society?.name, 'Test Heights');
});
