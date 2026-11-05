// 035: the secretary's Home — four cards in one call, and one tap to remind every overdue flat.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];

before(async () => {
  db = await createDb();
  const secretary = await createUser(db, 'sec@home.test');
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Home Towers','Road','Pune','Maharashtra','411001','sec@home.test','9876500000') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify(['101', '102', '103', '104'].map((n) => ({ unit_number: n })))]);
    await tx.query(`INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Maintenance','flat_per_unit',1000)`, [id]);
    return id;
  });
  const unit = async (n) => (await db.query('SELECT id FROM units WHERE society_id=$1 AND unit_number=$2', [societyId, n])).rows[0].id;
  ids = { societyId, secretary };
  for (const n of ['101', '102', '103', '104']) ids[`u${n}`] = await unit(n);
  for (const [email, u] of [['o101@home.test', ids.u101], ['o102@home.test', ids.u102], ['o104@home.test', ids.u104]]) {
    await q(secretary, `INSERT INTO member_invites (society_id,email,role,unit_id,invited_by) VALUES ($1,$2,'resident_owner',$3,$4)`, [societyId, email, u, secretary]);
    const uid = await createUser(db, email);
    await asUser(db, uid, (tx) => tx.query('SELECT public.claim_my_invites()'));
    ids[email] = uid;
  }
  // two old months (overdue) and a month not yet due
  await q(secretary, `SELECT public.generate_bills($1,'2025-01-01','2025-01-31','2025-01-10')`, [societyId]);
  await q(secretary, `SELECT public.generate_bills($1,'2025-02-01','2025-02-28','2025-02-10')`, [societyId]);
  await q(secretary, `SELECT public.generate_bills($1,'2099-01-01','2099-01-31','2099-01-10')`, [societyId]);
  // 102 has a payment waiting for verification
  const bill102 = (await db.query(`SELECT id FROM bills WHERE unit_id=$1 ORDER BY due_date LIMIT 1`, [ids.u102])).rows[0].id;
  await asUser(db, ids['o102@home.test'], (tx) => tx.query(
    `INSERT INTO payments (society_id, unit_id, user_id, bill_id, payment_number, amount, transaction_reference_utr, status)
     VALUES ($1,$2,$3,$4,'PAY-H1',1000,'123456789012','pending_verification')`, [societyId, ids.u102, ids['o102@home.test'], bill102]));
  // vendor bills: one waiting for approval; one approved and unpaid (invoice 25 days ago: due within the week);
  // one approved with its invoice to follow (the attach-by date is not a payment due date)
  await db.query(`INSERT INTO expenses (society_id, category, title, subtotal, gst_amount, tds_amount, net_payable, status, created_by, payee_name, invoice_date)
                  VALUES ($1,'security','Guards',10000,1800,200,11600,'pending_approval',$2,'Guard Co', current_date - 3),
                         ($1,'housekeeping','Cleaning',5000,0,0,5000,'approved',$2,'Clean Co', current_date - 25)`, [societyId, secretary]);
  await db.query(`INSERT INTO expenses (society_id, category, title, subtotal, gst_amount, tds_amount, net_payable, status, created_by, payee_name, invoice_status)
                  VALUES ($1,'repairs','Plumber',2000,0,0,2000,'approved',$2,'Pipe Co','pending')`, [societyId, secretary]);
  const stranger = await createUser(db, 'joiner@home.test');
  await db.query(`INSERT INTO join_requests (society_id, user_id, full_name) VALUES ($1,$2,'Joiner')`, [societyId, stranger]);
  ids.readonly = await createUser(db, 'cm@home.test');
  await db.query(`INSERT INTO society_memberships (society_id, user_id, role) VALUES ($1,$2,'committee_member')`, [societyId, ids.readonly]);
});

test('the four Home cards in one call', async () => {
  const c = await val(ids.secretary, 'SELECT public.home_cards($1)', [ids.societyId]);
  assert.deepEqual(c.to_receive, { amount: 12000, flats: 4, overdue_flats: 4 });
  // the plumber's invoice-to-follow bill is due 30 days after it was recorded, not this week
  assert.deepEqual(c.to_pay, { amount: 7000, vendors: 2, due_this_week: 1 });
  assert.deepEqual(c.approvals, { vendor_bills: 1, adjustments: 0, opening_balance: 0, join_requests: 1, total: 2 });
  assert.equal(c.payments_to_verify, 1);
  // a read-only committee member sees the same cards
  assert.equal((await val(ids.readonly, 'SELECT public.home_cards($1)', [ids.societyId])).payments_to_verify, 1);
  await assert.rejects(q(ids['o101@home.test'], 'SELECT public.home_cards($1)', [ids.societyId]), /Only the society committee/);
});

test('one tap reminds each overdue flat at most once a day, counting the nightly reminder', async () => {
  await assert.rejects(q(ids.readonly, 'SELECT public.remind_overdue_flats($1)', [ids.societyId]), /Only the society committee can send reminders/);
  // the nightly job already reminded 101 today, about its February bill
  const feb101 = (await db.query(`SELECT id FROM bills WHERE unit_id=$1 AND due_date='2025-02-10'`, [ids.u101])).rows[0].id;
  await db.query(`INSERT INTO notifications (user_id, society_id, kind, title, ref_id, ref_date) VALUES ($1,$2,'dues_reminder','Reminder',$3,current_date)`,
    [ids['o101@home.test'], ids.societyId, feb101]);
  const r = await val(ids.secretary, 'SELECT public.remind_overdue_flats($1)', [ids.societyId]);
  // 104 reminded; 102 paid and waits for verification; 103 nobody joined; 101 already reminded today
  assert.deepEqual(r, { reminded: 1, payment_waiting: 1, not_joined: 1, already_today: 1 });
  const n = await q(ids['o104@home.test'], `SELECT title FROM notifications WHERE kind='dues_reminder'`);
  assert.deepEqual(n.map((x) => x.title), ['Maintenance due: Flat 104']);
  assert.equal((await q(ids['o101@home.test'], `SELECT count(*)::int n FROM notifications WHERE kind='dues_reminder'`))[0].n, 1, 'one reminder a day');
  assert.deepEqual(await val(ids.secretary, 'SELECT public.remind_overdue_flats($1)', [ids.societyId]),
    { reminded: 0, payment_waiting: 1, not_joined: 1, already_today: 2 }, 'not twice a day');
});
