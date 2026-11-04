// 030: an in-app inbox fed by bills, notices, complaints, payments and approvals; dues reminders; push subscriptions.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const inbox = async (user, kind) => (await q(user, `SELECT id, kind, title, link FROM notifications ${kind ? 'WHERE kind = $1' : ''} ORDER BY created_at`,
  kind ? [kind] : []));

before(async () => {
  db = await createDb();
  const secretary = await createUser(db, 'sec@notify.test');
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Notify Heights','Road','Pune','Maharashtra','411001','sec@notify.test','9876543210') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }, { unit_number: '102' }])]);
    await tx.query('UPDATE society_settings SET require_two_step_expense_approval = false WHERE society_id = $1', [id]);
    await tx.query(`INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Maintenance','flat_per_unit',1000)`, [id]);
    for (const [email, role, flat] of [['r1@notify.test', 'resident_owner', '101'], ['t1@notify.test', 'resident_tenant', '101'], ['r2@notify.test', 'resident_owner', '102']]) {
      await tx.query(`INSERT INTO member_invites (society_id,email,role,unit_id,invited_by)
        SELECT $1,$2,$3,id,$4 FROM units WHERE society_id=$1 AND unit_number=$5`, [id, email, role, secretary, flat]);
    }
    await tx.query(`INSERT INTO member_invites (society_id,email,role,invited_by) VALUES ($1,'tre@notify.test','treasurer',$2)`, [id, secretary]);
    return id;
  });
  const r1 = await createUser(db, 'r1@notify.test');
  const t1 = await createUser(db, 't1@notify.test');
  const r2 = await createUser(db, 'r2@notify.test');
  const treasurer = await createUser(db, 'tre@notify.test');
  for (const u of [r1, t1, r2, treasurer]) await asUser(db, u, (tx) => tx.query('SELECT public.claim_my_invites()'));
  const unit = async (n) => (await db.query('SELECT id FROM units WHERE society_id=$1 AND unit_number=$2', [societyId, n])).rows[0].id;
  const vendor = (await db.query(`INSERT INTO vendors (society_id, name, phone, pan) VALUES ($1,'Ram Electricals','9000000000','ABCPR1234K') RETURNING id`,
    [societyId])).rows[0].id;
  ids = { societyId, secretary, treasurer, r1, t1, r2, u101: await unit('101'), u102: await unit('102'), vendor };
});

const notice = (audience, title) => q(ids.secretary, `INSERT INTO notices (society_id, title, content, published_by, target_audience)
  VALUES ($1,$2,'Details inside',$3,$4)`, [ids.societyId, title, ids.secretary, audience]);

test('a new bill notifies its owner only', async () => {
  await q(ids.secretary, `SELECT public.generate_bills($1,'2026-11-01','2026-11-30','2026-11-10')`, [ids.societyId]);
  for (const owner of [ids.r1, ids.r2]) {
    const rows = await inbox(owner, 'bill');
    assert.equal(rows.length, 1);
    assert.match(rows[0].title, /^New bill /);
    assert.equal(rows[0].link, 'bills');
  }
  assert.equal((await inbox(ids.t1, 'bill')).length, 0, 'tenants see no dues');
});

test('a notice reaches its audience, not its publisher', async () => {
  await notice('all', 'Water cut on Sunday');
  for (const u of [ids.r1, ids.r2, ids.t1, ids.treasurer]) assert.equal((await inbox(u, 'notice')).length, 1);
  assert.equal((await inbox(ids.secretary, 'notice')).length, 0);
  await notice('tenants_only', 'Tenant verification forms');
  assert.equal((await inbox(ids.t1, 'notice')).length, 2);
  assert.equal((await inbox(ids.r1, 'notice')).length, 1);
});

test('a payment to verify reaches the committee; its result reaches the payer', async () => {
  const pay = await val(ids.r1, `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, status)
    VALUES ($1,$2,$3,'P-N1',1000,'412345678901','pending_verification') RETURNING id`, [ids.societyId, ids.u101, ids.r1]);
  for (const u of [ids.secretary, ids.treasurer]) {
    const rows = await inbox(u, 'payment_to_verify');
    assert.equal(rows.length, 1);
    assert.match(rows[0].title, /^Payment to verify: Flat 101/);
  }
  await q(ids.treasurer, 'SELECT public.verify_payment($1, true)', [pay]);
  const mine = await inbox(ids.r1, 'payment_result');
  assert.deepEqual(mine.map((r) => r.title), ['Payment verified']);
});

test('a vendor bill waiting for approval reaches the other committee admins', async () => {
  await q(ids.treasurer, `INSERT INTO expenses (society_id, vendor_id, category, title, subtotal, tds_amount, invoice_number, invoice_date)
    VALUES ($1,$2,'repairs','Pump repair',4000,0,'PR-1',current_date)`, [ids.societyId, ids.vendor]);
  assert.equal((await inbox(ids.secretary, 'bill_to_approve')).length, 1);
  assert.equal((await inbox(ids.treasurer, 'bill_to_approve')).length, 0);
});

test('users read and mark only their own notifications', async () => {
  const mine = (await inbox(ids.r1))[0];
  assert.equal((await q(ids.r2, 'SELECT id FROM notifications WHERE id = $1', [mine.id])).length, 0);
  assert.equal(await val(ids.r2, 'SELECT public.mark_notifications_read($1)', [[mine.id]]), 0);
  const before = await val(ids.r1, 'SELECT public.unread_notification_count()');
  assert.equal(await val(ids.r1, 'SELECT public.mark_notifications_read($1)', [[mine.id]]), 1);
  assert.equal(await val(ids.r1, 'SELECT public.unread_notification_count()'), before - 1);
  await assert.rejects(q(ids.r1, `INSERT INTO notifications (user_id, kind, title) VALUES ($1,'x','spoof')`, [ids.r2]), /row-level security/);
});

test('a removed member gets no new notifications', async () => {
  await db.query(`UPDATE society_memberships SET is_active = false WHERE user_id = $1`, [ids.r2]);
  const before = (await inbox(ids.r2)).length;
  await notice('all', 'Lift maintenance');
  assert.equal((await inbox(ids.r2)).length, before);
});

const remind = async (asOf) => (await db.query('SELECT public.send_dues_reminders($1) AS n', [asOf])).rows[0].n;

test('the committee sets the reminder schedule', async () => {
  const s = (await db.query('SELECT reminder_first_days f, reminder_every_days e FROM society_settings WHERE society_id=$1', [ids.societyId])).rows[0];
  assert.deepEqual([s.f, s.e], [3, 7]);
  await assert.rejects(q(ids.r1, 'SELECT public.set_reminder_schedule($1,2,5)', [ids.societyId]), /Only the society committee can set reminders/);
  await assert.rejects(q(ids.secretary, 'SELECT public.set_reminder_schedule($1,0,5)', [ids.societyId]), /between 1 and 60 days/);
  assert.deepEqual(await val(ids.secretary, 'SELECT public.set_reminder_schedule($1,2,5)', [ids.societyId]), { first: 2, every: 5 });
  await assert.rejects(q(ids.r1, `SELECT public.send_dues_reminders('2026-10-12')`), /permission denied/);
});

test('reminders follow the schedule, once a day, never for paid bills', async () => {
  // r1's November bill was paid in full earlier; a December bill for r1 stays unpaid
  await q(ids.secretary, `SELECT public.generate_bills($1,'2026-12-01','2026-12-31','2026-12-10')`, [ids.societyId]);
  await db.query(`UPDATE bills SET bill_date = '2026-10-01', due_date = '2026-10-10' WHERE society_id = $1 AND unit_id = $2`, [ids.societyId, ids.u101]);
  const unpaid = (await db.query(`SELECT count(*)::int n FROM bills WHERE unit_id = $1 AND balance_due > 0`, [ids.u101])).rows[0].n;
  assert.equal(unpaid, 1, 'one unpaid bill, one paid bill on flat 101');
  assert.equal(await remind('2026-10-12'), 1);
  assert.equal(await remind('2026-10-12'), 0, 'once a day');
  assert.equal(await remind('2026-10-13'), 0);
  assert.equal(await remind('2026-10-17'), 1);
  const rows = await inbox(ids.r1, 'dues_reminder');
  assert.equal(rows.length, 2);
  assert.match(rows[0].title, /^Reminder: ₹1,000\.00 due for Flat 101$/);
  assert.equal((await inbox(ids.t1, 'dues_reminder')).length, 0);
});

test('a browser push subscription belongs to the user logged in on it', async () => {
  await q(ids.r1, `SELECT public.save_push_subscription('https://fcm.googleapis.com/fcm/send/r1-phone','pk','au')`);
  assert.equal((await q(ids.r1, 'SELECT endpoint FROM push_subscriptions')).length, 1);
  assert.equal((await q(ids.t1, 'SELECT endpoint FROM push_subscriptions')).length, 0, 'nobody sees another user’s subscriptions');
  await assert.rejects(q(ids.r1, `SELECT public.save_push_subscription('http://evil.example/x','pk','au')`), /Not a push endpoint/);
  // the same phone, now logged in as t1
  await q(ids.t1, `SELECT public.save_push_subscription('https://fcm.googleapis.com/fcm/send/r1-phone','pk2','au2')`);
  assert.equal((await q(ids.r1, 'SELECT endpoint FROM push_subscriptions')).length, 0);
  assert.equal((await q(ids.t1, 'SELECT endpoint FROM push_subscriptions')).length, 1);
});
