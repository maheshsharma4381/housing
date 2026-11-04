// 027: a society without a CA makes a committee member its Accountant, who then has the CA's powers.
// Anything the Accountant submits is approved by a different committee member.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const setAcc = (by, who, on) => val(by, 'SELECT public.set_accountant($1,$2,$3)', [ids.societyId, who, on]);
const ledger = (by) => val(by, `SELECT public.create_ledger($1,(SELECT id FROM account_groups WHERE society_id=$1 AND system_key='expenses'),'Garden')`,
  [ids.societyId]);

before(async () => {
  db = await createDb();
  const secretary = await createUser(db, 'sec@acct.test');
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Accountant Heights','Road','Pune','Maharashtra','411001','sec@acct.test','9876543210') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }])]);
    await tx.query(`INSERT INTO member_invites (society_id,email,role,unit_id,invited_by)
      SELECT $1,'res@acct.test','resident_owner',id,$2 FROM units WHERE society_id=$1 AND unit_number='101'`, [id, secretary]);
    for (const [email, role] of [['tre@acct.test', 'treasurer'], ['cm@acct.test', 'committee_member']]) {
      await tx.query(`INSERT INTO member_invites (society_id,email,role,invited_by) VALUES ($1,$2,$3,$4)`, [id, email, role, secretary]);
    }
    return id;
  });
  const resident = await createUser(db, 'res@acct.test');
  const treasurer = await createUser(db, 'tre@acct.test');
  const cm = await createUser(db, 'cm@acct.test');
  for (const u of [resident, treasurer, cm]) await asUser(db, u, (tx) => tx.query('SELECT public.claim_my_invites()'));
  ids = { societyId, secretary, resident, treasurer, cm };
});

test('the committee makes one of its members the accountant; residents cannot be one', async () => {
  await assert.rejects(setAcc(ids.resident, ids.treasurer, true), /Only the society committee can choose the accountant/);
  await assert.rejects(setAcc(ids.cm, ids.treasurer, true), /Only the society committee can choose the accountant/);
  await assert.rejects(setAcc(ids.secretary, ids.resident, true), /Only an active committee member can be the society's accountant/);
  await assert.rejects(ledger(ids.treasurer), /Only the society's CA or accountant/);
  assert.deepEqual(await setAcc(ids.secretary, ids.treasurer, true), { user_id: ids.treasurer, is_accountant: true });
  const logs = await db.query(`SELECT count(*)::int n FROM audit_logs WHERE society_id=$1 AND action='member.accountant_on'`, [ids.societyId]);
  assert.equal(logs.rows[0].n, 1);
});

test('the accountant keeps the books but cannot approve their own opening balance', async () => {
  assert.match(await ledger(ids.treasurer), /^5/);
  await q(ids.treasurer, `SELECT public.save_opening_balance($1,'2026-03-31','2026-03-31',$2,'[]','[]','[]')`, [ids.societyId,
    JSON.stringify([{ code: '1000', amount: 5000 }, { code: '3000', amount: -5000 }])]);
  await q(ids.treasurer, 'SELECT public.submit_opening_balance($1)', [ids.societyId]);
  await assert.rejects(q(ids.treasurer, 'SELECT public.decide_opening_balance($1,true)', [ids.societyId]), /another committee member must approve/);
  assert.equal((await val(ids.secretary, 'SELECT public.decide_opening_balance($1,true)', [ids.societyId])).status, 'approved');
});

test('a read-only committee member can be the accountant but approves nothing', async () => {
  await setAcc(ids.secretary, ids.cm, true);
  assert.match(await val(ids.cm, `SELECT public.create_ledger($1,(SELECT id FROM account_groups WHERE society_id=$1 AND system_key='expenses'),'Lawn')`,
    [ids.societyId]), /^5/);
  const p = await val(ids.cm, `SELECT public.propose_adjustment($1,current_date,'Reclass garden spend',$2)`, [ids.societyId,
    JSON.stringify([{ code: '5900', amount: 100 }, { code: '5000', amount: -100 }])]);
  await assert.rejects(q(ids.cm, 'SELECT public.decide_adjustment($1,true)', [p.id]), /Only the society committee can approve/);
});

test('switching the accountant off, or leaving the committee, takes the books back at once', async () => {
  await setAcc(ids.secretary, ids.cm, false);
  await assert.rejects(val(ids.cm, `SELECT public.create_ledger($1,(SELECT id FROM account_groups WHERE society_id=$1 AND system_key='expenses'),'Hedge')`,
    [ids.societyId]), /Only the society's CA or accountant/);
  await db.query(`UPDATE society_memberships SET is_active=false WHERE society_id=$1 AND user_id=$2`, [ids.societyId, ids.treasurer]);
  await assert.rejects(val(ids.treasurer, `SELECT public.create_ledger($1,(SELECT id FROM account_groups WHERE society_id=$1 AND system_key='expenses'),'Shrubs')`,
    [ids.societyId]), /Only the society's CA or accountant/);
});
