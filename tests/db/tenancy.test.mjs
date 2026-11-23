// 041: tenant registration (Phase 11B) on the 11A request engine.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
const ids = {};

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const fails = async (promise, message) => assert.rejects(promise, (e) => { assert.ok(e.message.includes(message), `expected "${message}", got "${e.message}"`); return true; });

const member = async (email, role, unit, name, { active = true } = {}) => {
  const id = await createUser(db, email, { fullName: name ?? email.split('@')[0] });
  await db.query('INSERT INTO society_memberships (society_id, user_id, role, unit_id, is_active) VALUES ($1,$2,$3,$4,$5)', [ids.soc, id, role, unit, active]);
  return id;
};
const isoDays = (n) => { const d = new Date(Date.now() + n * 86400_000); return d.toISOString().slice(0, 10); };

before(async () => {
  db = await createDb();
  await db.exec('CREATE SCHEMA IF NOT EXISTS extensions; ALTER EXTENSION pgcrypto SET SCHEMA extensions;');
  ids.sec = await createUser(db, 'sec@ten.test', { fullName: 'Secretary' });
  ids.soc = await asUser(db, ids.sec, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Lake View CHS','5 Lake Road','Pune','Maharashtra','411002','sec@ten.test','9876500100') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([
      { unit_number: '101', wing: 'A' }, { unit_number: '102', wing: 'A' }, { unit_number: '103', wing: 'A' }, { unit_number: '104', wing: 'A' }])]);
    await tx.query(`INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Maintenance','flat_per_unit',1500)`, [id]);
    return id;
  });
  for (const n of ['101', '102', '103', '104']) {
    ids[`u${n}`] = (await db.query('SELECT id FROM units WHERE society_id=$1 AND unit_number=$2', [ids.soc, n])).rows[0].id;
  }
  ids.owner = await member('asha@ten.test', 'resident_owner', ids.u101, 'Asha Patil');
  ids.owner2 = await member('bina@ten.test', 'resident_owner', ids.u102, 'Bina Shah');
  ids.owner3 = await member('chetan@ten.test', 'resident_owner', ids.u103, 'Chetan Rao');
  ids.committee = await member('cm@ten.test', 'committee_member', ids.u104, 'Committee Member');
  ids.outsider = await createUser(db, 'out@ten.test');
  ids.soc2 = await asUser(db, ids.outsider, async (tx) =>
    (await tx.query(`SELECT public.create_society('Other','Road','Pune','Maharashtra','411003','out@ten.test','9876500101') AS id`)).rows[0].id);
});

const checklist = async (soc = ids.soc) => (await db.query(`SELECT checklist FROM request_checklists WHERE society_id=$1 AND kind='tenancy'`, [soc])).rows[0]?.checklist;

// ---------------------------------------------------------------- 1. the tenant document list
test('a society starts with the tenant document list', async () => {
  const c = await checklist();
  assert.deepEqual(c.map((x) => [x.key, x.required]), [['agreement', true], ['police', true], ['tenant_id', true], ['tenant_photo', false], ['undertaking', false]]);
  assert.equal(c[0].label, 'Registered leave and licence agreement');
  assert.equal((await checklist(ids.soc2)).length, 5);
  assert.equal((await q(ids.owner, `SELECT count(*)::int AS n FROM request_checklists WHERE society_id=$1`, [ids.soc]))[0].n, 1);
  assert.equal((await q(ids.outsider, `SELECT count(*)::int AS n FROM request_checklists WHERE society_id=$1`, [ids.soc]))[0].n, 0);
});

test('the committee edits the list', async () => {
  const c = await checklist();
  const next = [...c.filter((x) => x.key !== 'undertaking'), { label: 'Copy of tenant\'s PAN', required: false }];
  const saved = await val(ids.sec, `SELECT public.save_request_checklist($1,'tenancy',$2)`, [ids.soc, JSON.stringify(next)]);
  assert.deepEqual(saved.map((x) => x.key), ['agreement', 'police', 'tenant_id', 'tenant_photo', 'd1']);
  assert.deepEqual((await checklist()).map((x) => x.key), ['agreement', 'police', 'tenant_id', 'tenant_photo', 'd1']);
  await fails(q(ids.owner, `SELECT public.save_request_checklist($1,'tenancy',$2)`, [ids.soc, JSON.stringify(next)]), 'Only the committee can change this');
  await fails(q(ids.committee, `SELECT public.save_request_checklist($1,'tenancy',$2)`, [ids.soc, JSON.stringify(next)]), 'Only the committee can change this');
  await fails(q(ids.sec, `SELECT public.save_request_checklist($1,'tenancy',$2)`, [ids.soc, JSON.stringify([{ label: 'X', required: true }])]), 'Up to 10 documents, each with a name');
  // back to the default for the tests below
  await db.query(`UPDATE request_checklists SET checklist=$2 WHERE society_id=$1 AND kind='tenancy'`, [ids.soc, JSON.stringify(c)]);
});

// ---------------------------------------------------------------- 2. tenancy requests and the register
const details = (o = {}) => ({ tenant_name: 'Tara Rao', tenant_mobile: '98765 11111', tenant_email: ' Tara@Mail.com ', occupants: 3,
  start_date: isoDays(0), end_date: isoDays(330), police_ref: 'PNA/2026/123', ...o });
const register = (user, unit, o) => val(user, 'SELECT public.create_tenancy_request($1,$2)', [unit, JSON.stringify(details(o))]);
const addTenancy = async (unit, o = {}) => (await db.query(
  `INSERT INTO tenancies (society_id, unit_id, tenant_name, tenant_mobile, occupants, start_date, end_date, status, created_at)
   VALUES ($1,$2,'Old Tenant','919800000000',2,$3,$4,$5,$6) RETURNING id`,
  [ids.soc, unit, o.start ?? isoDays(-100), o.end ?? isoDays(200), o.status ?? 'active', o.created ?? new Date().toISOString()])).rows[0].id;

test('an owner registers a tenant', async () => {
  const r = await register(ids.owner, ids.u101);
  const row = (await db.query('SELECT * FROM flat_requests WHERE id=$1', [r])).rows[0];
  assert.equal(row.kind, 'tenancy');
  assert.equal(row.status, 'submitted');
  assert.equal(row.details.tenant_mobile, '919876511111');
  assert.equal(row.details.tenant_email, 'tara@mail.com');
  assert.equal(row.details.occupants, 3);
  assert.equal(row.checklist.length, 5);
  const told = (await db.query(`SELECT user_id, title FROM notifications WHERE ref_id=$1`, [r])).rows;
  assert.deepEqual(told.map((n) => [n.user_id, n.title]), [[ids.sec, 'Tenant registration for flat 101']]);
  ids.req101 = r;
});

test('tenancy checks', async () => {
  await fails(register(ids.owner, ids.u101, { tenant_name: 'T' }), "Enter the tenant's name (2 to 80 characters)");
  await fails(register(ids.owner, ids.u101, { tenant_mobile: '123' }), 'Enter a valid mobile number');
  await fails(register(ids.owner, ids.u101, { tenant_mobile: '' }), 'Enter a valid mobile number');
  await fails(register(ids.owner, ids.u101, { tenant_email: 'not-an-email' }), 'Enter a valid email address');
  await fails(register(ids.owner, ids.u101, { occupants: 0 }), 'Number of people living there: 1 to 20');
  await fails(register(ids.owner, ids.u101, { occupants: 'many' }), 'Number of people living there: 1 to 20');
  await fails(register(ids.owner, ids.u101, { end_date: isoDays(-1) }), 'The agreement must end after it starts, within 60 months');
  await fails(register(ids.owner, ids.u101, { end_date: isoDays(61 * 31) }), 'The agreement must end after it starts, within 60 months');
  await fails(register(ids.owner, ids.u101, { start_date: 'soon' }), 'The agreement must end after it starts, within 60 months');
  await fails(register(ids.owner, ids.u101, { police_ref: 'x'.repeat(61) }), 'The police reference can be up to 60 characters');
  assert.ok(await register(ids.owner, ids.u101, { tenant_email: '' }), 'email is optional');
});

test('only an owner of the flat or the committee registers a tenant', async () => {
  await fails(register(ids.owner2, ids.u101), 'Only an owner of this flat can register a tenant');
  await fails(register(ids.committee, ids.u101), 'Only an owner of this flat can register a tenant');
  await fails(register(ids.outsider, ids.u101), 'Only an owner of this flat can register a tenant');
  assert.ok(await register(ids.sec, ids.u102));
});

test('one tenant at a time', async () => {
  const t = await addTenancy(ids.u103);
  await fails(register(ids.owner3, ids.u103), 'This flat already has a tenant. End that tenancy or renew it.');
  await fails(register(ids.owner3, ids.u103, { renews_id: crypto.randomUUID() }), 'Choose the tenancy this renews');
  const other = await addTenancy(ids.u104, { status: 'ended' });
  await fails(register(ids.owner3, ids.u103, { renews_id: other }), 'Choose the tenancy this renews');
  const r = await register(ids.owner3, ids.u103, { renews_id: t });
  assert.equal((await db.query('SELECT details FROM flat_requests WHERE id=$1', [r])).rows[0].details.renews_id, t);
  await db.query('DELETE FROM tenancies WHERE id IN ($1,$2)', [t, other]);
});

test("the buyer of a let flat sees neither the seller's request nor the old tenancy", async () => {
  const t = await addTenancy(ids.u102, { created: new Date(Date.now() - 86400_000).toISOString() });
  const r = await register(ids.owner2, ids.u102, { renews_id: t });
  await db.query(`INSERT INTO unit_ownerships (society_id, unit_id, owner_name, from_date, created_by, created_at) VALUES ($1,$2,'Bela Buyer', current_date, $3, clock_timestamp())`, [ids.soc, ids.u102, ids.sec]);
  await db.query('UPDATE society_memberships SET is_active=false WHERE user_id=$1', [ids.owner2]);
  const buyer = await member('buyer@ten.test', 'resident_owner', ids.u102, 'Bela Buyer');
  assert.equal((await q(buyer, 'SELECT count(*)::int AS n FROM tenancies WHERE id=$1', [t]))[0].n, 0);
  assert.equal((await q(buyer, 'SELECT count(*)::int AS n FROM flat_requests WHERE id=$1', [r]))[0].n, 0);
  assert.equal((await q(ids.committee, 'SELECT count(*)::int AS n FROM tenancies WHERE id=$1', [t]))[0].n, 1);
  await db.query('UPDATE tenancies SET status=$2 WHERE id=$1', [t, 'ended']);
  ids.buyer = buyer;
});
