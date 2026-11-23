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
