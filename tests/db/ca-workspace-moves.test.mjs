// 027: the CA (or the society's Accountant) keeps the asset register and matches bank lines directly;
// verifying payments stays with the committee; a year lock is proposed and another committee member approves it.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';
import { inviteProfessional } from './opening-helpers.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const CA_PRESET = ['view_reports', 'view_ledger', 'view_expenses', 'audit_gst', 'view_bills', 'view_payments', 'view_documents', 'manage_accounts'];

const ROWS = [
  { date: '2026-10-14', description: 'UPI/412345678901/Flat 101 maintenance', credit: 4170, balance: 54170 },
  { date: '2026-10-19', description: 'SMS CHARGES', debit: 17.7, balance: 54152.3 },
].map((r) => ({ debit: 0, credit: 0, ...r }));

/** A society with a secretary, a treasurer, the owner of flat 101 and a CA with the standard CA permissions. */
async function makeSociety(tag) {
  const secretary = await createUser(db, `sec@${tag}.ws.test`);
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society($1,'Road','Pune','Maharashtra','411001',$2,'9876543210') AS id`,
      [`Workspace Heights ${tag}`, `sec@${tag}.ws.test`])).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }])]);
    await tx.query(`INSERT INTO member_invites (society_id,email,role,unit_id,invited_by)
      SELECT $1,$2,'resident_owner',id,$3 FROM units WHERE society_id=$1 AND unit_number='101'`, [id, `res@${tag}.ws.test`, secretary]);
    await tx.query(`INSERT INTO member_invites (society_id,email,role,invited_by) VALUES ($1,$2,'treasurer',$3)`, [id, `tre@${tag}.ws.test`, secretary]);
    return id;
  });
  const resident = await createUser(db, `res@${tag}.ws.test`);
  const treasurer = await createUser(db, `tre@${tag}.ws.test`);
  for (const u of [resident, treasurer]) await asUser(db, u, (tx) => tx.query('SELECT public.claim_my_invites()'));
  const ca = await inviteProfessional(db, { societyId, inviter: secretary, email: `ca@${tag}.ws.test`, permissions: CA_PRESET });
  const unit101 = (await db.query(`SELECT id FROM units WHERE society_id=$1 AND unit_number='101'`, [societyId])).rows[0].id;
  return { societyId, secretary, treasurer, resident, ca, unit101 };
}

before(async () => {
  db = await createDb();
  ids = await makeSociety('main');
});

test('the CA keeps the asset register and posts depreciation directly', async () => {
  const id = await val(ids.ca, `SELECT public.add_existing_asset($1,'Old DG set','1500','2019-01-01',100000,50000,'2025-04-01')`, [ids.societyId]);
  await q(ids.ca, `SELECT public.update_asset($1,'DG set','Basement',20,'wdv','Per audit')`, [id]);
  assert.ok(Number((await val(ids.ca, `SELECT public.post_depreciation($1,'2026-03-31')`, [ids.societyId])).total) > 0);
  await assert.rejects(q(ids.resident, `SELECT public.add_existing_asset($1,'Pump','1500','2019-01-01',1000,500,'2025-04-01')`, [ids.societyId]),
    /Only the society committee can add assets/);
});

test('the CA matches bank lines but never verifies a payment', async () => {
  const bank = await val(ids.ca, `INSERT INTO bank_accounts (society_id, bank_name, account_number, ifsc_code, branch_name, is_primary)
    VALUES ($1,'HDFC Bank','50100012345678','HDFC0000123','Baner',true) RETURNING id`, [ids.societyId]);
  await val(ids.ca, `SELECT public.import_bank_statement($1,'oct.csv','hdfc',$2)`, [bank, JSON.stringify(ROWS)]);
  const credit = (await db.query(`SELECT id FROM bank_transactions WHERE bank_account_id=$1 AND type='credit'`, [bank])).rows[0].id;
  const charges = (await db.query(`SELECT id FROM bank_transactions WHERE bank_account_id=$1 AND type='debit'`, [bank])).rows[0].id;

  await assert.rejects(q(ids.ca, 'SELECT public.record_bank_receipt($1,$2)', [credit, ids.unit101]));
  assert.equal((await db.query(`SELECT count(*)::int n FROM payments WHERE society_id=$1`, [ids.societyId])).rows[0].n, 0);
  await assert.rejects(q(ids.ca, 'SELECT public.verify_matched_payments($1)', [ids.societyId]), /Only the society committee can verify payments/);

  await q(ids.ca, `SELECT public.ignore_bank_line($1,'Bank SMS charges')`, [charges]);
  assert.equal((await db.query(`SELECT match_kind FROM bank_transactions WHERE id=$1`, [charges])).rows[0].match_kind, 'ignored');
  await assert.rejects(q(ids.resident, 'SELECT public.unlink_bank_line($1)', [charges]));
  assert.ok((await q(ids.ca, `SELECT id FROM bank_transactions WHERE bank_account_id=$1`, [bank])).length === 2, 'the CA reads the statement');
});
