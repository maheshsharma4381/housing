// 026 on a society that posted its opening balance the old way (010) before 026 was applied:
// its opening arrears stay on the flats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser, applyMigration } from './harness.mjs';

test('opening arrears posted the old way stay on their flat after 026', async () => {
  const db = await createDb({ upTo: '025' });
  const secretary = await createUser(db, 'sec@legacy.ob.test');
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Legacy Heights','Road','Pune','Maharashtra','411001','sec@legacy.ob.test','9876543210') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }])]);
    await tx.query(`INSERT INTO member_invites (society_id,email,role,unit_id,invited_by)
      SELECT $1,'r101@legacy.ob.test','resident_owner',id,$2 FROM units WHERE society_id=$1 AND unit_number='101'`, [id, secretary]);
    await tx.query(`INSERT INTO member_invites (society_id,email,role,invited_by) VALUES ($1,'tre@legacy.ob.test','treasurer',$2)`, [id, secretary]);
    return id;
  });
  const r101 = await createUser(db, 'r101@legacy.ob.test');
  const treasurer = await createUser(db, 'tre@legacy.ob.test');
  for (const u of [r101, treasurer]) await asUser(db, u, (tx) => tx.query('SELECT public.claim_my_invites()'));
  await asUser(db, secretary, (tx) => tx.query(`SELECT public.post_opening_balances($1,'2026-03-31',$2,$3)`,
    [societyId, JSON.stringify([{ code: '1000', amount: 4500 }]), JSON.stringify([{ unit_number: '101', amount: 4500 }])]));

  await applyMigration(db, '026_opening_balance.sql');
  const flats = async () => (await asUser(db, treasurer, (tx) => tx.query(`SELECT public.party_balances($1,'flat',NULL) r`, [societyId]))).rows[0].r
    .parties.filter((x) => Number(x.balance) !== 0).map((x) => [x.name, Number(x.dues)]);
  assert.deepEqual(await flats(), [['Flat 101', 4500]]);

  const unit = (await db.query(`SELECT id FROM units WHERE society_id=$1`, [societyId])).rows[0].id;
  const pay = (await asUser(db, r101, (tx) => tx.query(
    `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, status)
     VALUES ($1,$2,$3,'PAY-1',4500,'625219401299','pending_verification') RETURNING id`, [societyId, unit, r101]))).rows[0].id;
  await asUser(db, treasurer, (tx) => tx.query('SELECT public.verify_payment($1, true)', [pay]));
  assert.deepEqual(await flats(), [], 'paid in full: nothing left on the flat or "Not linked"');
});
