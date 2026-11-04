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

test('the secretary records an owner change; the old owner loses the flat; the new owner is invited', async () => {
  // r1 has owned flat 101 since April 2025 (they joined Sahvaas today)
  await db.query(`UPDATE unit_ownerships SET from_date = '2025-04-01' WHERE unit_id = $1`, [ids.u101]);
  await q(ids.secretary, `SELECT public.generate_bills($1,'2026-10-01','2026-10-31','2026-10-10')`, [ids.societyId]);
  // generate_bills dates a bill today; this one belongs to October, before the transfer
  await db.query(`UPDATE bills SET bill_date = '2026-10-01' WHERE unit_id = $1`, [ids.u101]);
  await db.query(`UPDATE journal_entries SET entry_date = '2026-10-01' WHERE reference_event_id IN (SELECT id FROM bills WHERE unit_id = $1)`, [ids.u101]);
  await db.query(`UPDATE ledger_entries SET date = '2026-10-01' WHERE journal_entry_id IN (SELECT j.id FROM journal_entries j
    WHERE j.reference_event_id IN (SELECT id FROM bills WHERE unit_id = $1))`, [ids.u101]);
  // a payment the old owner sent before the transfer, still to be verified
  ids.oldPay = await val(ids.r1, `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, status)
    VALUES ($1,$2,$3,'P-R1',500,'222222222222','pending_verification') RETURNING id`, [ids.societyId, ids.u101, ids.r1]);
  const before = await val(ids.secretary, 'SELECT public.flat_balance($1)', [ids.u101]);
  assert.ok(Number(before.dues) > 0);
  ids.duesAtTransfer = Number(before.dues);
  await assert.rejects(q(ids.cm, `SELECT public.transfer_flat_owner($1,'Neha Shah','neha@owners.test','9876500000',current_date)`, [ids.u101]),
    /Only the society committee can record an owner change/);
  await assert.rejects(q(ids.secretary, `SELECT public.transfer_flat_owner($1,'Neha Shah','neha@owners.test','9876500000',current_date + 1)`, [ids.u101]),
    /cannot be in the future/);
  await assert.rejects(q(ids.secretary, `SELECT public.transfer_flat_owner($1,'Neha Shah','neha-at-owners',NULL,current_date)`, [ids.u101]),
    /email — they join with it/);
  const r = await val(ids.secretary, `SELECT public.transfer_flat_owner($1,'Neha Shah','neha@owners.test','9876500000',current_date)`, [ids.u101]);
  assert.equal(Number(r.dues), ids.duesAtTransfer);
  const m = (await db.query(`SELECT is_active FROM society_memberships WHERE user_id=$1 AND unit_id=$2`, [ids.r1, ids.u101])).rows[0];
  assert.equal(m.is_active, false);
  const tenant = (await db.query(`SELECT is_active FROM society_memberships WHERE user_id=$1 AND unit_id=$2`, [ids.t1, ids.u101])).rows[0];
  assert.equal(tenant.is_active, true, 'the tenant keeps the flat');
  await assert.rejects(q(ids.r1, `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, status)
    VALUES ($1,$2,$3,'P-OLD',100,'111111111111','pending_verification')`, [ids.societyId, ids.u101, ids.r1]), /row-level security/);
  await assert.rejects(q(ids.secretary, `SELECT public.transfer_flat_owner($1,'Someone Else','else@owners.test',NULL,current_date)`, [ids.u101]),
    /already has a new owner waiting to join/);
  const periods = await val(ids.secretary, 'SELECT public.flat_owner_periods($1)', [ids.u101]);
  assert.deepEqual(periods.map((p) => [p.owner_name, p.joined, p.owner_mobile]), [[periods[0].owner_name, true, null], ['Neha Shah', false, '9876500000']]);
  const invite = (await db.query(`SELECT role, status FROM member_invites WHERE email='neha@owners.test'`)).rows[0];
  assert.deepEqual([invite.role, invite.status], ['resident_owner', 'pending']);
});

test('bills raised before the new owner joins, and the old dues, move to the new owner', async () => {
  await q(ids.secretary, `SELECT public.generate_bills($1,'2026-12-01','2026-12-31','2026-12-10')`, [ids.societyId]);
  const neha = await createUser(db, 'neha@owners.test');
  await asUser(db, neha, (tx) => tx.query('SELECT public.claim_my_invites()'));
  ids.neha = neha;
  const open = (await db.query(`SELECT user_id FROM bills WHERE unit_id=$1 AND balance_due > 0`, [ids.u101])).rows;
  assert.ok(open.length >= 2, 'the October bill and the December bill');
  assert.ok(open.every((b) => b.user_id === neha));
  const seen = await asUser(db, neha, async (tx) => (await tx.query('SELECT count(*)::int n FROM bills WHERE balance_due > 0')).rows[0].n);
  assert.equal(seen, open.length);
  const periods = await val(ids.secretary, 'SELECT public.flat_owner_periods($1)', [ids.u101]);
  assert.equal(periods[1].joined, true);
});

test("the new owner's statement starts with what the flat brought forward", async () => {
  const periods = await val(ids.secretary, 'SELECT public.flat_owner_periods($1)', [ids.u101]);
  const st = await val(ids.secretary, `SELECT public.party_statement($1,'flat',$2,$3,current_date + 60)`, [ids.societyId, ids.u101, periods[1].from_date]);
  assert.ok(Number(st.opening) > 0, 'the previous owner left dues on the flat');
});

test("the old owner's payment, verified after the transfer, still settles the flat's dues", async () => {
  const before = Number((await val(ids.secretary, 'SELECT public.flat_balance($1)', [ids.u101])).dues);
  await q(ids.treasurer, 'SELECT public.verify_payment($1, true)', [ids.oldPay]);
  const after = Number((await val(ids.secretary, 'SELECT public.flat_balance($1)', [ids.u101])).dues);
  assert.equal(after, before - 500);
});

test("an owner change must come after the current owner's start", async () => {
  await q(ids.secretary, `INSERT INTO member_invites (society_id,email,role,unit_id,invited_by) VALUES ($1,'r2@owners.test','resident_owner',$2,$3)`,
    [ids.societyId, ids.u102, ids.secretary]);
  const r2 = await createUser(db, 'r2@owners.test');
  await asUser(db, r2, (tx) => tx.query('SELECT public.claim_my_invites()'));
  await assert.rejects(q(ids.secretary, `SELECT public.transfer_flat_owner($1,'Amit Rao','amit@owners.test',NULL,current_date)`, [ids.u102]),
    /must be after .* \(when the current owner's period began\)/);
});
