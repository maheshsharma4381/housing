// 019–021: Tally-style groups and ledgers that the society's CA / accountant manages.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser, applyMigration } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const one = async (user, sql, params = []) => (await q(user, sql, params))[0];
const val = async (user, sql, params = []) => Object.values(await one(user, sql, params))[0];
const groupId = async (key, societyId = ids.societyId) => (await db.query(
  `SELECT id FROM account_groups WHERE society_id=$1 AND system_key=$2`, [societyId, key])).rows[0].id;

async function inviteProfessional(societyId, secretary, email, permissions) {
  const user = await createUser(db, email);
  const inv = (await asUser(db, secretary, (tx) => tx.query(
    `INSERT INTO professional_invites (society_id, invited_email, role, permissions, invited_by, expires_at)
     VALUES ($1,$2,'ca',$3,$4, now() + interval '7 days') RETURNING id`,
    [societyId, email, JSON.stringify(permissions), secretary]))).rows[0].id;
  await asUser(db, user, (tx) => tx.query(`SELECT public.respond_to_invite('professional',$1,true)`, [inv]));
  return user;
}

/** A society with one flat, one bill and a verified payment (postings to 1000, 1200, 2100, 4000). */
async function societyWithPosting(database, tag) {
  const secretary = await createUser(database, `sec@${tag}.test`);
  const resident = await createUser(database, `res@${tag}.test`);
  const treasurer = await createUser(database, `tre@${tag}.test`);
  const societyId = await asUser(database, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society($1,'Road','Pune','Maharashtra','411001',$2,'9876543210') AS id`,
      [`${tag} Heights`, `sec@${tag}.test`])).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }])]);
    await tx.query(`INSERT INTO billing_rules (society_id,name,calculation_type,rate,tax_rate_percent) VALUES ($1,'Maint','flat_per_unit',1000,18)`, [id]);
    for (const [email, role, unit] of [[`tre@${tag}.test`, 'treasurer', null], [`res@${tag}.test`, 'resident_owner', '101']]) {
      await tx.query(`INSERT INTO member_invites (society_id,email,role,unit_id,invited_by)
        VALUES ($1,$2,$3,(SELECT id FROM units WHERE society_id=$1 AND unit_number=$4),$5)`, [id, email, role, unit, secretary]);
    }
    return id;
  });
  for (const u of [treasurer, resident]) await asUser(database, u, (tx) => tx.query('SELECT public.claim_my_invites()'));
  await asUser(database, secretary, (tx) => tx.query(`SELECT public.generate_bills($1,'2026-10-01','2026-10-31','2026-10-10')`, [societyId]));
  const unit = (await database.query(`SELECT id FROM units WHERE society_id=$1`, [societyId])).rows[0].id;
  const pay = (await asUser(database, resident, (tx) => tx.query(
    `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, status)
     VALUES ($1,$2,$3,$4,1180,'625219401292','pending_verification') RETURNING id`, [societyId, unit, resident, `PAY-${tag}`]))).rows[0].id;
  await asUser(database, treasurer, (tx) => tx.query('SELECT public.verify_payment($1, true)', [pay]));
  return { societyId, secretary, resident, treasurer };
}

before(async () => {
  db = await createDb();
  ids = await societyWithPosting(db, 'chart');
  ids.ca = await inviteProfessional(ids.societyId, ids.secretary, 'ca@chart.test', ['view_reports', 'manage_accounts']);
  ids.viewer = await inviteProfessional(ids.societyId, ids.secretary, 'viewer@chart.test', ['view_ledger']);
});

test('every society gets 7 primary groups and 7 system sub-groups, and each default ledger sits in its group', async () => {
  const groups = (await db.query(`SELECT system_key, parent_id FROM account_groups WHERE society_id=$1`, [ids.societyId])).rows;
  assert.equal(groups.length, 14);
  assert.equal(groups.filter((g) => g.parent_id === null).length, 7);
  const keyOf = async (code) => (await db.query(
    `SELECT g.system_key FROM accounts a JOIN account_groups g ON g.id=a.group_id WHERE a.society_id=$1 AND a.code=$2`,
    [ids.societyId, code])).rows[0]?.system_key;
  assert.deepEqual(
    [await keyOf('1000'), await keyOf('1590'), await keyOf('2200'), await keyOf('3000'), await keyOf('5100')],
    ['bank_accounts', 'fixed_assets', 'duties_taxes', 'capital_funds', 'expenses']);
  const orphans = (await db.query(`SELECT count(*)::int n FROM accounts WHERE group_id IS NULL`)).rows[0].n;
  assert.equal(orphans, 0);
});

test('a ledger’s nature must match its group', async () => {
  await assert.rejects(db.query(`INSERT INTO accounts (society_id, code, name, type, group_id, is_system) VALUES ($1,'9999','X','expense',$2,false)`,
    [ids.societyId, await groupId('bank_accounts')]), /nature must match its group/);
});

test('a ledger with postings cannot be deleted; a society still can be', async () => {
  await assert.rejects(db.query(`DELETE FROM accounts WHERE society_id=$1 AND code='1000'`, [ids.societyId]), /foreign key/);
  const other = await societyWithPosting(db, 'throwaway');
  const posted = (await db.query(`SELECT count(*)::int n FROM ledger_entries WHERE society_id=$1`, [other.societyId])).rows[0].n;
  assert.ok(posted > 0, 'the throwaway society has postings');
  await db.query(`DELETE FROM societies WHERE id=$1`, [other.societyId]);
  const left = (await db.query(`SELECT count(*)::int n FROM accounts WHERE society_id=$1`, [other.societyId])).rows[0].n;
  assert.equal(left, 0);
});

test('residents cannot read the chart; a view_ledger professional can', async () => {
  assert.equal(Number(await val(ids.resident, `SELECT count(*) FROM accounts`)), 0);
  assert.equal(Number(await val(ids.resident, `SELECT count(*) FROM account_groups`)), 0);
  assert.equal(Number(await val(ids.viewer, `SELECT count(*) FROM accounts WHERE society_id=$1`, [ids.societyId])), 33);
  assert.equal(Number(await val(ids.viewer, `SELECT count(*) FROM account_groups WHERE society_id=$1`, [ids.societyId])), 14);
});

test('manage_accounts is a valid professional permission', async () => {
  const r = await q(ids.secretary,
    `INSERT INTO professional_invites (society_id, invited_email, role, permissions, invited_by, expires_at)
     VALUES ($1,'acct@chart.test','accountant','["manage_accounts"]',$2, now() + interval '7 days') RETURNING id`,
    [ids.societyId, ids.secretary]);
  assert.equal(r.length, 1);
});

test('upgrade from 018 puts every existing ledger in a group', async () => {
  const old = await createDb({ upTo: '018' });
  try {
    const s = await societyWithPosting(old, 'upgrade');
    const tb = async () => (await asUser(old, s.secretary, (tx) => tx.query(
      `SELECT code, debit, credit FROM public.trial_balance($1) ORDER BY code`, [s.societyId]))).rows;
    const before018 = await tb();
    assert.ok(before018.length > 0);
    await applyMigration(old, '019_account_groups.sql');
    const orphans = (await old.query(`SELECT count(*)::int n FROM accounts WHERE group_id IS NULL`)).rows[0].n;
    assert.equal(orphans, 0);
    const groups = (await old.query(`SELECT count(*)::int n FROM account_groups WHERE society_id=$1`, [s.societyId])).rows[0].n;
    assert.equal(groups, 14);
    assert.deepEqual(await tb(), before018);
  } finally {
    await old.close();
  }
});
