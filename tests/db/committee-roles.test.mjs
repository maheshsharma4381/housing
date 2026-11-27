// 045: committee roles change without re-inviting anyone. One Secretary, one Chairman and one Treasurer at a time;
// the society always keeps a Secretary or Chairman; every term is kept for the AGM and the audit.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const change = (by, who, role) => val(by, 'SELECT public.change_committee_role($1,$2,$3)', [ids.societyId, who, role]);
const roleOf = async (who) => (await db.query(
  `SELECT role FROM society_memberships WHERE society_id=$1 AND user_id=$2 AND is_active
     AND role IN ('society_admin','secretary','chairman','treasurer','committee_member')`, [ids.societyId, who])).rows.map(r => r.role);
const history = (by) => val(by, 'SELECT public.committee_history($1)', [ids.societyId]);

before(async () => {
  db = await createDb();
  const secretary = await createUser(db, 'sec@roles.test', { fullName: 'Asha Secretary' });
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Roles Heights','Road','Pune','Maharashtra','411001','sec@roles.test','9876543210') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }, { unit_number: '102' }])]);
    await tx.query(`INSERT INTO member_invites (society_id,email,role,unit_id,invited_by)
      SELECT $1,'owner@roles.test','resident_owner',id,$2 FROM units WHERE society_id=$1 AND unit_number='101'`, [id, secretary]);
    for (const [email, role] of [['tre@roles.test', 'treasurer'], ['cm@roles.test', 'committee_member']]) {
      await tx.query(`INSERT INTO member_invites (society_id,email,role,invited_by) VALUES ($1,$2,$3,$4)`, [id, email, role, secretary]);
    }
    return id;
  });
  const owner = await createUser(db, 'owner@roles.test', { fullName: 'Ravi Owner' });
  const treasurer = await createUser(db, 'tre@roles.test', { fullName: 'Tara Treasurer' });
  const cm = await createUser(db, 'cm@roles.test', { fullName: 'Chetan Member' });
  const outsider = await createUser(db, 'out@roles.test');
  for (const u of [owner, treasurer, cm]) await asUser(db, u, (tx) => tx.query('SELECT public.claim_my_invites()'));
  ids = { societyId, secretary, owner, treasurer, cm, outsider };
});

test('only the Secretary, Chairman or society admin changes roles', async () => {
  await assert.rejects(change(ids.owner, ids.cm, 'treasurer'), /Only the Secretary or Chairman can change committee roles/);
  await assert.rejects(change(ids.cm, ids.cm, 'secretary'), /Only the Secretary or Chairman can change committee roles/);
  await assert.rejects(change(ids.treasurer, ids.cm, 'chairman'), /Only the Secretary or Chairman can change committee roles/);
  await assert.rejects(change(ids.secretary, ids.cm, 'president'), /Choose Secretary, Chairman, Treasurer or Committee member/);
  await assert.rejects(change(ids.secretary, ids.outsider, 'treasurer'), /Only members of this society can join the committee/);
});

test('a committee member becomes Chairman; their term is recorded and they are told', async () => {
  const r = await change(ids.secretary, ids.cm, 'chairman');
  assert.deepEqual(r, { user_id: ids.cm, role: 'chairman', previous_role: 'committee_member' });
  assert.deepEqual(await roleOf(ids.cm), ['chairman']);
  const n = await db.query(`SELECT title FROM notifications WHERE user_id=$1 AND kind='committee_role'`, [ids.cm]);
  assert.equal(n.rows[0].title, 'You are now Chairman of Roles Heights');
  const log = await db.query(`SELECT new_value FROM audit_logs WHERE society_id=$1 AND action='member.role_changed'`, [ids.societyId]);
  assert.equal(log.rows[0].new_value.role, 'chairman');
});

test('a flat owner joins the committee as Treasurer; the old Treasurer steps down to Committee member', async () => {
  const r = await change(ids.secretary, ids.owner, 'treasurer');
  assert.equal(r.previous_role, null);
  assert.deepEqual(await roleOf(ids.owner), ['treasurer']);
  assert.deepEqual(await roleOf(ids.treasurer), ['committee_member']);
  // the owner keeps their flat
  const flat = await db.query(`SELECT count(*)::int n FROM society_memberships WHERE society_id=$1 AND user_id=$2 AND is_active AND role='resident_owner'`,
    [ids.societyId, ids.owner]);
  assert.equal(flat.rows[0].n, 1);
  const told = await db.query(`SELECT title FROM notifications WHERE user_id=$1 AND kind='committee_role'`, [ids.treasurer]);
  assert.equal(told.rows[0].title, 'You are now Committee member of Roles Heights');
});

test('an invite for a post that is taken also moves the old holder down', async () => {
  await q(ids.secretary, `INSERT INTO member_invites (society_id,email,role,invited_by) VALUES ($1,'new@roles.test','treasurer',$2)`,
    [ids.societyId, ids.secretary]);
  const fresh = await createUser(db, 'new@roles.test');
  await asUser(db, fresh, (tx) => tx.query('SELECT public.claim_my_invites()'));
  assert.deepEqual(await roleOf(fresh), ['treasurer']);
  assert.deepEqual(await roleOf(ids.owner), ['committee_member']);
  ids.fresh = fresh;
});

test('the society always keeps a Secretary or Chairman', async () => {
  // the Chairman is still there, so the Secretary may step down
  await change(ids.secretary, ids.secretary, 'committee_member');
  assert.deepEqual(await roleOf(ids.secretary), ['committee_member']);
  // now the Chairman is the only one left who runs the society
  await assert.rejects(change(ids.cm, ids.cm, null), /The society needs a Secretary or Chairman/);
  await assert.rejects(change(ids.cm, ids.cm, 'treasurer'), /The society needs a Secretary or Chairman/);
  // handing over first works
  await change(ids.cm, ids.secretary, 'secretary');
  await change(ids.secretary, ids.cm, null);
  assert.deepEqual(await roleOf(ids.cm), []);
  await assert.rejects(change(ids.secretary, ids.cm, null), /They are not on the committee/);
});

test('history lists every term, newest first, for the committee only', async () => {
  await assert.rejects(history(ids.outsider), /Only the committee can see the committee history/);
  const rows = await history(ids.treasurer);
  const terms = rows.filter(r => r.name === 'Chetan Member').map(r => `${r.role}:${r.to_date ? 'ended' : 'open'}`);
  assert.deepEqual(terms, ['chairman:ended', 'committee_member:ended']);
  const asha = rows.filter(r => r.name === 'Asha Secretary').map(r => `${r.role}:${r.to_date ? 'ended' : 'open'}`);
  assert.deepEqual(asha, ['secretary:open', 'committee_member:ended', 'secretary:ended']);
  assert.ok(rows.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.from_date)));
});

test('an Accountant who leaves the committee stops being the Accountant', async () => {
  await q(ids.secretary, 'SELECT public.set_accountant($1,$2,true)', [ids.societyId, ids.treasurer]);
  await change(ids.secretary, ids.treasurer, null);
  const acc = await db.query(`SELECT bool_or(is_accountant) a FROM society_memberships WHERE society_id=$1 AND user_id=$2`,
    [ids.societyId, ids.treasurer]);
  assert.equal(acc.rows[0].a, false);
});
