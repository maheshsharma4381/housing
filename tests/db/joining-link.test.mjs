// 031: owners' mobiles on flats and one society joining link. A verified mobile that matches a flat joins it;
// anyone else becomes a join request in Approvals.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const withPhone = async (email, phone) => {
  const id = await createUser(db, email);
  if (phone) await db.query('UPDATE auth.users SET phone = $2 WHERE id = $1', [id, phone]);
  return id;
};
const join = (user, code, name, mobile = null, flat = null) => val(user, 'SELECT public.join_society($1,$2,$3,$4)', [code, name, mobile, flat]);

before(async () => {
  db = await createDb();
  const secretary = await createUser(db, 'sec@join.test');
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Join Heights','Road','Pune','Maharashtra','411001','sec@join.test','9876543210') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }, { unit_number: '102' }, { unit_number: '103' }])]);
    await tx.query(`INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Maintenance','flat_per_unit',1000)`, [id]);
    return id;
  });
  const unit = async (n) => (await db.query('SELECT id FROM units WHERE society_id=$1 AND unit_number=$2', [societyId, n])).rows[0].id;
  ids = { societyId, secretary, u101: await unit('101'), u102: await unit('102'), u103: await unit('103') };
  ids.code = await val(secretary, 'SELECT public.society_join_code($1)', [societyId]);
});

test('mobiles are kept as digits with the country code', async () => {
  const n = async (m) => (await db.query('SELECT public.normalize_mobile($1) AS v', [m])).rows[0].v;
  for (const m of ['+91 98765-43210', '098765 43210', '9876543210', '919876543210']) assert.equal(await n(m), '919876543210', m);
  assert.equal(await n('12345'), null);
  assert.equal(await n('+44 7700 900123'), '447700900123');
});

test('only the committee records owner contacts', async () => {
  const outsider = await createUser(db, 'out@join.test');
  await assert.rejects(q(outsider, 'SELECT public.set_flat_owner_contacts($1,$2)', [ids.societyId,
    JSON.stringify([{ unit_id: ids.u101, name: 'X', mobile: '9876543210' }])]), /Only the society committee can change flats/);
  await assert.rejects(q(ids.secretary, 'SELECT public.set_flat_owner_contacts($1,$2)', [ids.societyId,
    JSON.stringify([{ unit_id: ids.u101, name: 'Asha Rao', mobile: '98765' }])]), /Mobile 98765 is not a valid number/);
  assert.equal(await val(ids.secretary, 'SELECT public.set_flat_owner_contacts($1,$2)', [ids.societyId,
    JSON.stringify([{ unit_id: ids.u101, name: 'Asha Rao', mobile: '98765 43210' }])]), 1);
  const u = (await db.query('SELECT owner_name, owner_mobile FROM units WHERE id=$1', [ids.u101])).rows[0];
  assert.deepEqual([u.owner_name, u.owner_mobile], ['Asha Rao', '919876543210']);
});

test('the owner whose verified mobile matches joins their flat', async () => {
  const asha = await withPhone('asha@join.test', '919876543210');
  const r = await join(asha, ids.code, 'Asha Rao');
  assert.deepEqual([r.status, r.flat], ['joined', '101']);
  const m = (await db.query(`SELECT role, is_active FROM society_memberships WHERE user_id=$1 AND unit_id=$2`, [asha, ids.u101])).rows[0];
  assert.deepEqual([m.role, m.is_active], ['resident_owner', true]);
  assert.equal((await db.query(`SELECT count(*)::int n FROM unit_ownerships WHERE unit_id=$1 AND to_date IS NULL AND owner_user_id=$2`, [ids.u101, asha])).rows[0].n, 1);
  await assert.rejects(join(asha, ids.code, 'Asha Rao'), /You are already a member of Join Heights/);
});

test('a typed mobile never attaches anyone', async () => {
  const faker = await withPhone('fake@join.test', null);
  const r = await join(faker, ids.code, 'Not Asha', '9876543210', '101');
  assert.equal(r.status, 'requested');
  assert.equal((await db.query(`SELECT count(*)::int n FROM society_memberships WHERE user_id=$1`, [faker])).rows[0].n, 0);
  const n = await q(ids.secretary, `SELECT title FROM notifications WHERE kind='join_request'`);
  assert.deepEqual(n.map((x) => x.title), ['Join request: Not Asha']);
  assert.equal((await join(faker, ids.code, 'Not Asha')).status, 'requested', 'no duplicate request');
  assert.equal((await db.query(`SELECT count(*)::int n FROM join_requests WHERE user_id=$1`, [faker])).rows[0].n, 1);
  ids.faker = faker;
});

test('the secretary approves a tenant and rejects a stranger', async () => {
  const tenant = await withPhone('ten@join.test', '919000000001');
  await join(tenant, ids.code, 'Tina Tenant', '9000000001', '102');
  const reqT = (await db.query(`SELECT id FROM join_requests WHERE user_id=$1`, [tenant])).rows[0].id;
  await assert.rejects(q(ids.secretary, 'SELECT public.decide_join_request($1,true,NULL,$2)', [reqT, 'resident_tenant']), /Choose the flat/);
  await assert.rejects(q(ids.secretary, 'SELECT public.decide_join_request($1,true,$2,$3)', [reqT, ids.u102, 'secretary']), /Role must be owner or tenant/);
  await q(ids.secretary, 'SELECT public.decide_join_request($1,true,$2,$3)', [reqT, ids.u102, 'resident_tenant']);
  const m = (await db.query(`SELECT role FROM society_memberships WHERE user_id=$1 AND unit_id=$2 AND is_active`, [tenant, ids.u102])).rows[0];
  assert.equal(m.role, 'resident_tenant');
  await q(ids.secretary, `SELECT public.generate_bills($1,'2026-11-01','2026-11-30','2026-11-10')`, [ids.societyId]);
  assert.equal((await db.query(`SELECT count(*)::int n FROM bills WHERE user_id=$1`, [tenant])).rows[0].n, 0, 'tenants get no bills');
  assert.equal((await q(tenant, `SELECT kind FROM notifications WHERE kind='join_result'`)).length, 1);

  const reqF = (await db.query(`SELECT id FROM join_requests WHERE user_id=$1`, [ids.faker])).rows[0].id;
  await assert.rejects(q(ids.secretary, 'SELECT public.decide_join_request($1,false)', [reqF]), /Give a reason for rejecting/);
  await q(ids.secretary, `SELECT public.decide_join_request($1,false,NULL,'resident_owner','Not a resident')`, [reqF]);
  await assert.rejects(q(ids.secretary, `SELECT public.decide_join_request($1,false,NULL,'resident_owner','again')`, [reqF]), /already rejected/);
});

test('a new link retires the old one', async () => {
  const old = ids.code;
  ids.code = await val(ids.secretary, 'SELECT public.new_join_code($1)', [ids.societyId]);
  assert.notEqual(ids.code, old);
  const someone = await withPhone('late@join.test', null);
  await assert.rejects(join(someone, old, 'Late Comer'), /This joining link has changed — ask your secretary for the new one/);
});

test('a waiting owner change completes through the link', async () => {
  // flat 103 has an owner since April 2025 with a bill
  await q(ids.secretary, `INSERT INTO member_invites (society_id,email,role,unit_id,invited_by) VALUES ($1,'o103@join.test','resident_owner',$2,$3)`,
    [ids.societyId, ids.u103, ids.secretary]);
  const o103 = await createUser(db, 'o103@join.test');
  await asUser(db, o103, (tx) => tx.query('SELECT public.claim_my_invites()'));
  await db.query(`UPDATE unit_ownerships SET from_date = '2025-04-01' WHERE unit_id = $1`, [ids.u103]);
  await q(ids.secretary, `SELECT public.generate_bills($1,'2026-12-01','2026-12-31','2026-12-10')`, [ids.societyId]);
  await q(ids.secretary, `SELECT public.transfer_flat_owner($1,'Vikram Shah','vikram@join.test','98111 11111',current_date)`, [ids.u103]);
  assert.equal((await db.query('SELECT owner_mobile FROM units WHERE id=$1', [ids.u103])).rows[0].owner_mobile, '919811111111');
  const vikram = await withPhone('vikram.other@join.test', '919811111111');
  assert.equal((await join(vikram, ids.code, 'Vikram Shah')).status, 'joined');
  const periods = await val(ids.secretary, 'SELECT public.flat_owner_periods($1)', [ids.u103]);
  assert.equal(periods.at(-1).joined, true);
  const open = (await db.query(`SELECT user_id FROM bills WHERE unit_id=$1 AND balance_due > 0`, [ids.u103])).rows;
  assert.ok(open.length > 0 && open.every((b) => b.user_id === vikram));
});

test('join requests are capped per society per day', async () => {
  const filler = await createUser(db, 'filler@join.test');
  for (let i = 0; i < 30; i += 1) {
    await db.query(`INSERT INTO join_requests (society_id, user_id, full_name, status) VALUES ($1,$2,$3,'rejected')`, [ids.societyId, filler, `F${i}`]);
  }
  const extra = await withPhone('extra@join.test', null);
  await assert.rejects(join(extra, ids.code, 'One Too Many'), /Too many join requests today — ask your secretary/);
});
