// 038: loose ends — mobiles with a 0 after +91, waiting requests and invites that close themselves,
// the CA's receiving bank on bills, and no notifications from a closed society.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser, applyMigration } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

before(async () => {
  db = await createDb();
  await db.exec('CREATE SCHEMA IF NOT EXISTS extensions; ALTER EXTENSION pgcrypto SET SCHEMA extensions;');
  const secretary = await createUser(db, 'sec@loose.test');
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Loose Ends','Road','Pune','Maharashtra','411001','sec@loose.test','9876543210') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify(['101', '102', '103', '104', '105', '106'].map((n) => ({ unit_number: n })))]);
    await tx.query(`INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Maintenance','flat_per_unit',1000)`, [id]);
    return id;
  });
  const unit = async (n) => (await db.query('SELECT id FROM units WHERE society_id=$1 AND unit_number=$2', [societyId, n])).rows[0].id;
  ids = { societyId, secretary };
  for (const n of ['101', '102', '103', '104', '105', '106']) ids[`u${n}`] = await unit(n);
  ids.code = await val(secretary, 'SELECT public.society_join_code($1)', [societyId]);
  // a second society, to prove nothing reaches across
  const sec2 = await createUser(db, 'sec2@loose.test');
  ids.society2 = await asUser(db, sec2, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Other Place','Road','Pune','Maharashtra','411002','sec2@loose.test','9876543211') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '1' }])]);
    return id;
  });
  ids.code2 = await val(sec2, 'SELECT public.society_join_code($1)', [ids.society2]);
});

const join = async (user, code, name, mobile = null, flat = null) => val(user, 'SELECT public.join_society($1,$2,$3,$4)', [code, name, mobile, flat]);
const withPhone = async (email, phone) => {
  const id = await createUser(db, email);
  await db.query('UPDATE auth.users SET phone = $2, phone_confirmed_at = now() WHERE id = $1', [id, phone]);
  return id;
};
const invite = async (fields) => val(ids.secretary,
  `INSERT INTO member_invites (society_id, email, mobile, full_name, role, unit_id, invited_by)
   VALUES ($1,$2,$3,$4,'resident_owner',$5,$6) RETURNING id`,
  [ids.societyId, fields.email ?? null, fields.mobile ?? null, fields.name ?? null, fields.unit, ids.secretary]);
const contacts = (rows) => q(ids.secretary, 'SELECT public.set_flat_owner_contacts($1,$2)', [ids.societyId, JSON.stringify(rows)]);
const request = async (user, societyId) => one(`SELECT id, status, unit_id, role FROM join_requests WHERE user_id=$1 AND society_id=$2 ORDER BY created_at DESC LIMIT 1`, [user, societyId]);
const inviteStatus = async (id) => one('SELECT status, accepted_user_id FROM member_invites WHERE id=$1', [id]);

// ---------------------------------------------------------------- 1. mobiles
test('normalize_mobile drops the 0 after +91', async () => {
  const n = async (m) => (await db.query('SELECT public.normalize_mobile($1) AS v', [m])).rows[0].v;
  for (const m of ['+91 0 98765 43210', '0091 098765 43210', '+91 (0) 98765-43210', '0091 98765 43210', '98765 43210']) {
    assert.equal(await n(m), '919876543210', m);
  }
  assert.equal(await n('+44 7700 900123'), '447700900123');
});

test('mobiles stored by the old rule are rewritten', async () => {
  // the old normalize_mobile kept "+91 0 98765 43210" as 13 digits
  await db.query(`INSERT INTO unit_owner_contacts (society_id, unit_id, owner_name, owner_mobile) VALUES ($1,$2,'Old Shape','9109876543211')
                  ON CONFLICT (unit_id) DO UPDATE SET owner_mobile = EXCLUDED.owner_mobile`, [ids.societyId, ids.u104]);
  await applyMigration(db, '038_loose_ends.sql');
  assert.equal((await one('SELECT owner_mobile FROM unit_owner_contacts WHERE unit_id=$1', [ids.u104])).owner_mobile, '919876543211');
  await db.query('DELETE FROM unit_owner_contacts WHERE unit_id=$1', [ids.u104]);
});

// ---------------------------------------------------------------- 2. requests and invites close themselves
test('joining another way closes the waiting request', async () => {
  const x = await createUser(db, 'x@loose.test');
  assert.equal((await join(x, ids.code, 'Xavier', '9000000001', '101')).status, 'requested');
  assert.equal((await join(x, ids.code2, 'Xavier', '9000000001', '1')).status, 'requested');
  const inv = await invite({ email: 'x@loose.test', unit: ids.u101 });
  await q(x, `SELECT public.respond_to_invite('member', $1, true)`, [inv]);
  const r = await request(x, ids.societyId);
  assert.deepEqual([r.status, r.unit_id, r.role], ['approved', ids.u101, 'resident_owner']);
  await assert.rejects(q(ids.secretary, `SELECT public.decide_join_request($1,true,$2,'resident_owner')`, [r.id, ids.u101]), /already approved/);
  // the other society's request is that committee's to decide
  assert.equal((await request(x, ids.society2)).status, 'pending');
});

test('a later phone match is not blocked by a waiting request', async () => {
  const p = await createUser(db, 'p@loose.test');
  assert.equal((await join(p, ids.code, 'Pooja', '98111 00002', '102')).status, 'requested');
  // she then logs in with her mobile on the same account, and the committee saves it on flat 102
  await db.query('UPDATE auth.users SET phone = $2, phone_confirmed_at = now() WHERE id = $1', [p, '919811100002']);
  await contacts([{ unit_id: ids.u102, name: 'Pooja', mobile: '98111 00002' }]);
  const r = await join(p, ids.code, 'Pooja');
  assert.deepEqual([r.status, r.flat], ['joined', '102']);
  assert.equal((await request(p, ids.societyId)).status, 'approved');
});

test("the owner's own invites are settled when they join by phone", async () => {
  const mine = await invite({ mobile: '+91 0 98111 00003', name: 'Meera', unit: ids.u103 });
  const coOwner = await invite({ email: 'co@loose.test', name: 'Co Owner', unit: ids.u103 });
  await contacts([{ unit_id: ids.u103, name: 'Meera', mobile: '98111 00003' }]);
  const m = await withPhone('m@loose.test', '919811100003');
  const claimed = await val(m, 'SELECT public.claim_my_flats()');
  assert.equal(claimed.length, 1);
  assert.deepEqual(await inviteStatus(mine), { status: 'accepted', accepted_user_id: m });
  assert.deepEqual(await inviteStatus(coOwner), { status: 'pending', accepted_user_id: null }, 'a joint owner is still invited');
});

test('the owner-change invite closes when the change completes through the link', async () => {
  // Om owns 105 and sells it; the buyer is first named by email only
  const om = await createUser(db, 'om@loose.test');
  await q(om, `SELECT public.respond_to_invite('member', $1, true)`, [await invite({ email: 'om@loose.test', unit: ids.u105 })]);
  await db.query(`UPDATE unit_ownerships SET from_date = current_date - 30 WHERE unit_id = $1`, [ids.u105]);
  const t = await val(ids.secretary, `SELECT public.transfer_flat_owner($1,'Neha','neha@loose.test',NULL,current_date)`, [ids.u105]);
  assert.equal((await inviteStatus(t.invite_id)).status, 'pending');
  // the committee then saves the buyer's mobile, and Yash (that mobile) joins through the link
  await contacts([{ unit_id: ids.u105, name: 'Yash', mobile: '98111 00005' }]);
  const y = await withPhone('y@loose.test', '919811100005');
  assert.equal((await join(y, ids.code, 'Yash')).status, 'joined');
  assert.equal((await inviteStatus(t.invite_id)).status, 'revoked');
  assert.equal((await one('SELECT owner_user_id FROM unit_ownerships WHERE unit_id=$1 AND to_date IS NULL', [ids.u105])).owner_user_id, y);
});

// ---------------------------------------------------------------- 3. the bank printed on a bill
test('the bill names the bank the CA receives into', async () => {
  const owner = await createUser(db, 'pa@loose.test');
  await db.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [owner]);
  const group = (await one(`SELECT id FROM account_groups WHERE society_id=$1 AND system_key='bank_accounts'`, [ids.societyId])).id;
  const code = await val(owner, 'SELECT public.create_ledger($1,$2,$3)', [ids.societyId, group, 'ICICI Current']);
  const icici = (await one('SELECT id FROM accounts WHERE society_id=$1 AND code=$2', [ids.societyId, code])).id;
  const b1000 = (await one(`SELECT id FROM accounts WHERE society_id=$1 AND code='1000'`, [ids.societyId])).id;
  const addBank = (name, no, ifsc, primary, ledger) => q(ids.secretary,
    `INSERT INTO bank_accounts (society_id, bank_name, account_number, ifsc_code, branch_name, is_primary, ledger_id)
     VALUES ($1,$2,$3,$4,'Baner',$5,$6)`, [ids.societyId, name, no, ifsc, primary, ledger]);
  await addBank('HDFC', '111', 'HDFC0000001', true, b1000);
  await addBank('ICICI', '222', 'ICIC0000001', false, icici);
  await q(ids.secretary, `SELECT public.generate_bills($1,'2026-10-01','2026-10-31','2026-10-10')`, [ids.societyId]);
  const bill = (await one('SELECT id FROM bills WHERE society_id=$1 AND unit_id=$2', [ids.societyId, ids.u106])).id;
  const bankNo = async () => (await val(ids.secretary, 'SELECT public.bill_document($1)', [bill])).society.bank.account_number;
  assert.equal(await bankNo(), '111', 'no default chosen yet: the primary account');
  await q(owner, 'SELECT public.set_default_banks($1,$2,$3)', [ids.societyId, icici, b1000]);
  assert.equal(await bankNo(), '222', 'the account on the ledger the CA receives into');
});

// ---------------------------------------------------------------- 4. a closed society is quiet
test('a deactivated society sends no notifications', async () => {
  const sec2 = (await one(`SELECT user_id FROM society_memberships WHERE society_id=$1 LIMIT 1`, [ids.society2])).user_id;
  const send = async (society, title) => (await one(
    `SELECT public.notify_users($1, ARRAY[$2]::uuid[], 'notice', $3, 'Body', NULL) AS n`, [society, sec2, title])).n;
  assert.equal(await send(ids.society2, 'While open'), 1);
  await db.query('UPDATE societies SET is_active = false WHERE id = $1', [ids.society2]);
  assert.equal(await send(ids.society2, 'After closing'), 0);
  assert.equal(await send(null, 'Not about a society'), 1, 'join results and other personal notices still arrive');
  await db.query('UPDATE societies SET is_active = true WHERE id = $1', [ids.society2]);
});
