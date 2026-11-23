// Tenant registration (Phase 11B): the state words and the form checks (the same rules as the database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenancyState, tenancyDraftError, TENANCY_STATE_LABELS } from '../../src/lib/tenancy.ts';

test('tenancy states', () => {
  const t = (status: string, start: string, end: string) => ({ status, start_date: start, end_date: end });
  assert.equal(tenancyState(t('active', '2026-01-01', '2026-12-31'), '2026-11-01'), 'active');
  assert.equal(tenancyState(t('active', '2026-01-01', '2026-12-31'), '2026-12-01'), 'ending');
  assert.equal(tenancyState(t('active', '2026-01-01', '2026-12-31'), '2026-11-30'), 'active');
  assert.equal(tenancyState(t('active', '2026-01-01', '2026-12-31'), '2027-01-01'), 'expired');
  assert.equal(tenancyState(t('ended', '2026-01-01', '2026-12-31'), '2026-06-01'), 'ended');
  assert.equal(tenancyState(t('renewed', '2026-01-01', '2026-12-31'), '2026-06-01'), 'renewed');
  assert.deepEqual(TENANCY_STATE_LABELS, { active: 'Active', ending: 'Ends soon', expired: 'Agreement expired', ended: 'Ended', renewed: 'Renewed' });
});

test('the tenant form checks what the database checks', () => {
  const ok = { tenant_name: 'Tara Rao', tenant_mobile: '98765 11111', tenant_email: '', occupants: 3, start_date: '2026-12-01', end_date: '2027-10-31', police_ref: '' };
  assert.equal(tenancyDraftError(ok), null);
  assert.equal(tenancyDraftError({ ...ok, tenant_name: 'T' }), "Enter the tenant's name (2 to 80 characters)");
  assert.equal(tenancyDraftError({ ...ok, tenant_mobile: '123' }), 'Enter a valid mobile number');
  assert.equal(tenancyDraftError({ ...ok, tenant_email: 'nope' }), 'Enter a valid email address');
  assert.equal(tenancyDraftError({ ...ok, occupants: 0 }), 'Number of people living there: 1 to 20');
  assert.equal(tenancyDraftError({ ...ok, occupants: 21 }), 'Number of people living there: 1 to 20');
  assert.equal(tenancyDraftError({ ...ok, end_date: '2026-12-01' }), 'The agreement must end after it starts, within 60 months');
  assert.equal(tenancyDraftError({ ...ok, end_date: '2031-12-02' }), 'The agreement must end after it starts, within 60 months');
  assert.equal(tenancyDraftError({ ...ok, end_date: '2031-12-01' }), null, '60 months exactly is allowed');
  assert.equal(tenancyDraftError({ ...ok, police_ref: 'x'.repeat(61) }), 'The police reference can be up to 60 characters');
});
