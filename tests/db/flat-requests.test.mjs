// 040: flat requests and NOC letters (Phase 11A).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
const ids = {};

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const fails = async (promise, message) => assert.rejects(promise, (e) => { assert.ok(e.message.includes(message), `expected "${message}", got "${e.message}"`); return true; });

const member = async (email, role, unit, name) => {
  const id = await createUser(db, email, { fullName: name ?? email.split('@')[0] });
  await db.query('INSERT INTO society_memberships (society_id, user_id, role, unit_id) VALUES ($1,$2,$3,$4)', [ids.soc, id, role, unit]);
  return id;
};

before(async () => {
  db = await createDb();
  await db.exec('CREATE SCHEMA IF NOT EXISTS extensions; ALTER EXTENSION pgcrypto SET SCHEMA extensions;');
  ids.sec = await createUser(db, 'sec@noc.test', { fullName: 'Secretary' });
  ids.soc = await asUser(db, ids.sec, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Green Park CHS','12 MG Road','Pune','Maharashtra','411001','sec@noc.test','9876500000') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([
      { unit_number: '101', wing: 'A' }, { unit_number: '102', wing: 'A' }, { unit_number: '103', wing: 'A' }, { unit_number: '104', wing: 'A' }])]);
    await tx.query(`INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Maintenance','flat_per_unit',1500)`, [id]);
    return id;
  });
  await db.query(`UPDATE societies SET registration_number = 'PNA/HSG/123/2001' WHERE id = $1`, [ids.soc]);
  for (const n of ['101', '102', '103', '104']) {
    ids[`u${n}`] = (await db.query('SELECT id FROM units WHERE society_id=$1 AND unit_number=$2', [ids.soc, n])).rows[0].id;
  }
  ids.owner = await member('asha@noc.test', 'resident_owner', ids.u101, 'Asha Patil');
  ids.joint = await member('arun@noc.test', 'resident_owner', ids.u101, 'Arun Patil');
  ids.owner2 = await member('bina@noc.test', 'resident_owner', ids.u102, 'Bina Shah');
  ids.tenant = await member('tara@noc.test', 'resident_tenant', ids.u101, 'Tara Rao');
  ids.tenant2 = await member('tom@noc.test', 'resident_tenant', ids.u102, 'Tom');
  ids.committee = await member('cm@noc.test', 'committee_member', ids.u104, 'Committee Member');
  ids.outsider = await createUser(db, 'out@noc.test');
  ids.soc2 = await asUser(db, ids.outsider, async (tx) =>
    (await tx.query(`SELECT public.create_society('Other','Road','Pune','Maharashtra','411002','out@noc.test','9876500001') AS id`)).rows[0].id);
});

const types = async (user, soc = ids.soc) => q(user, 'SELECT * FROM noc_types WHERE society_id=$1 ORDER BY sort', [soc]);
const typeId = async (code) => (await db.query('SELECT id FROM noc_types WHERE society_id=$1 AND code=$2', [ids.soc, code])).rows[0].id;
const saveType = (user, { id = null, name = 'Bank account', title = 'No Objection Certificate', body = 'This is to certify that {member_name} of flat {flat} is a member.', signatory = 'secretary', checklist = [], tenant = false, active = true } = {}) =>
  val(user, 'SELECT public.save_noc_type($1,$2,$3,$4,$5,$6,$7,$8,$9)', [ids.soc, id, name, title, body, signatory, JSON.stringify(checklist), tenant, active]);

// ---------------------------------------------------------------- 1. NOC types, share certificates
test('a new society has the seven NOC types', async () => {
  const t = await types(ids.sec);
  assert.deepEqual(t.map((x) => x.code), ['sale', 'home_loan', 'leave_licence', 'electricity', 'passport', 'gas', 'repairs']);
  assert.equal(t.find((x) => x.code === 'passport').tenant_can_ask, true);
  assert.equal(t.find((x) => x.code === 'sale').tenant_can_ask, false);
  assert.deepEqual(t.find((x) => x.code === 'leave_licence').checklist, [{ key: 'agreement', label: 'Draft or registered leave and licence agreement', required: true }]);
  assert.ok(t.every((x) => x.body.includes('{member_name}') && x.body.includes('{flat}')));
  // the other society got its own
  assert.equal((await types(ids.outsider, ids.soc2)).length, 7);
});

test('members read NOC types, outsiders do not', async () => {
  assert.equal((await types(ids.tenant)).length, 7);
  assert.equal((await types(ids.outsider)).length, 0);
});

test('the committee edits a type and adds its own', async () => {
  const sale = await typeId('sale');
  await saveType(ids.sec, { id: sale, name: 'Sale of flat (resale)', checklist: [{ label: 'Sale agreement draft', required: true }] });
  const row = (await types(ids.sec)).find((x) => x.code === 'sale');
  assert.equal(row.name, 'Sale of flat (resale)');
  assert.deepEqual(row.checklist, [{ key: 'd1', label: 'Sale agreement draft', required: true }]);
  // an existing key is kept when the item is edited
  await saveType(ids.sec, { id: sale, name: 'Sale of flat', checklist: [{ key: 'd1', label: 'Draft sale agreement', required: false }, { label: 'Bank NOC', required: false }] });
  assert.deepEqual((await types(ids.sec)).find((x) => x.code === 'sale').checklist.map((c) => c.key), ['d1', 'd2']);
  const custom = await saveType(ids.sec, {});
  assert.equal((await db.query('SELECT code FROM noc_types WHERE id=$1', [custom])).rows[0].code, 'custom-1');
  await fails(saveType(ids.owner, {}), 'Only the committee can change NOC letters');
  await fails(saveType(ids.committee, {}), 'Only the committee can change NOC letters');
  await fails(saveType(ids.sec, { name: 'X' }), 'Name the NOC (2 to 80 characters)');
  await fails(saveType(ids.sec, { body: 'Too short' }), 'Write the letter (20 to 4000 characters)');
  await fails(saveType(ids.sec, { checklist: Array.from({ length: 11 }, (_, i) => ({ label: `Doc ${i}`, required: false })) }), 'Up to 10 documents, each with a name');
  await fails(saveType(ids.sec, { checklist: [{ label: 'X', required: true }] }), 'Up to 10 documents, each with a name');
  await fails(saveType(ids.sec, { signatory: 'guard' }), 'Choose who signs');
});

test('share certificate numbers', async () => {
  await q(ids.sec, 'SELECT public.set_share_certificate($1,$2)', [ids.u101, ' SC-12 ']);
  assert.equal((await db.query('SELECT share_certificate_no FROM units WHERE id=$1', [ids.u101])).rows[0].share_certificate_no, 'SC-12');
  await fails(q(ids.owner, 'SELECT public.set_share_certificate($1,$2)', [ids.u101, 'SC-99']), 'Only the committee can do this');
  await q(ids.sec, 'SELECT public.set_share_certificate($1,$2)', [ids.u102, 'SC-13']);
  await q(ids.sec, 'SELECT public.set_share_certificate($1,$2)', [ids.u102, '']);
  assert.equal((await db.query('SELECT share_certificate_no FROM units WHERE id=$1', [ids.u102])).rows[0].share_certificate_no, null);
});
