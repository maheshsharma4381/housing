// 029: every flat keeps its ownership history; the secretary records an owner change; the old owner loses the flat,
// the new owner is invited, and the flat's unpaid bills move to the new owner when they join.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser, applyMigration } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];

/** A society with flats 101 and 102: a secretary, a treasurer, a read-only committee member, owner r1 and tenant t1 of 101. */
async function makeSociety(database, tag) {
  const secretary = await createUser(database, `sec@${tag}.test`);
  const societyId = await asUser(database, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society($1,'Road','Pune','Maharashtra','411001',$2,'9876543210') AS id`,
      [`Owner Heights ${tag}`, `sec@${tag}.test`])).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }, { unit_number: '102' }])]);
    await tx.query(`INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Maintenance','flat_per_unit',1000)`, [id]);
    for (const [email, role] of [[`r1@${tag}.test`, 'resident_owner'], [`t1@${tag}.test`, 'resident_tenant']]) {
      await tx.query(`INSERT INTO member_invites (society_id,email,role,unit_id,invited_by)
        SELECT $1,$2,$3,id,$4 FROM units WHERE society_id=$1 AND unit_number='101'`, [id, email, role, secretary]);
    }
    for (const [email, role] of [[`tre@${tag}.test`, 'treasurer'], [`cm@${tag}.test`, 'committee_member']]) {
      await tx.query(`INSERT INTO member_invites (society_id,email,role,invited_by) VALUES ($1,$2,$3,$4)`, [id, email, role, secretary]);
    }
    return id;
  });
  const r1 = await createUser(database, `r1@${tag}.test`);
  const t1 = await createUser(database, `t1@${tag}.test`);
  const treasurer = await createUser(database, `tre@${tag}.test`);
  const cm = await createUser(database, `cm@${tag}.test`);
  for (const u of [r1, t1, treasurer, cm]) await asUser(database, u, (tx) => tx.query('SELECT public.claim_my_invites()'));
  const unit = async (n) => (await database.query('SELECT id FROM units WHERE society_id=$1 AND unit_number=$2', [societyId, n])).rows[0].id;
  return { societyId, secretary, treasurer, cm, r1, t1, u101: await unit('101'), u102: await unit('102') };
}

before(async () => {
  db = await createDb();
  ids = await makeSociety(db, 'owners');
});

test("the first owner who joins starts the flat's ownership history", async () => {
  const periods = await val(ids.secretary, 'SELECT public.flat_owner_periods($1)', [ids.u101]);
  assert.deepEqual(periods.map((p) => [p.owner_email, p.to_date, p.joined]), [['r1@owners.test', null, true]]);
  assert.deepEqual(await val(ids.secretary, 'SELECT public.flat_owner_periods($1)', [ids.u102]), []);
  await assert.rejects(q(ids.t1, 'SELECT public.flat_owner_periods($1)', [ids.u101]), /do not have access/);
});

test('owners who joined before 029 get their open period when it is applied', async () => {
  const old = await createDb({ upTo: '028' });
  const s = await makeSociety(old, 'backfill');
  await applyMigration(old, '029_owner_change.sql');
  const rows = (await old.query(`SELECT owner_user_id, owner_email, to_date FROM unit_ownerships WHERE unit_id=$1`, [s.u101])).rows;
  assert.deepEqual(rows.map((r) => [r.owner_user_id, r.owner_email, r.to_date]), [[s.r1, 'r1@backfill.test', null]]);
  assert.equal((await old.query(`SELECT count(*)::int n FROM unit_ownerships WHERE unit_id=$1`, [s.u102])).rows[0].n, 0);
});
