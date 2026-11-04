// 033: bills belong to flats. Issued before anyone joins, claimed by the owner who joins; charges for chosen flats;
// a sole committee member approves their own vendor bills; the printable bill document.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const unit = async (n) => (await db.query('SELECT id FROM units WHERE society_id=$1 AND unit_number=$2', [ids.societyId, n])).rows[0].id;
const billsOf = async (unitId) => (await db.query('SELECT id, user_id, total_amount::float AS total, balance_due::float AS due FROM bills WHERE unit_id=$1 ORDER BY bill_date, bill_number', [unitId])).rows;
const invite = async (email, unitId) => {
  await q(ids.secretary, `INSERT INTO member_invites (society_id,email,role,unit_id,invited_by) VALUES ($1,$2,'resident_owner',$3,$4)`, [ids.societyId, email, unitId, ids.secretary]);
  const id = await createUser(db, email);
  await asUser(db, id, (tx) => tx.query('SELECT public.claim_my_invites()'));
  return id;
};

before(async () => {
  db = await createDb();
  const secretary = await createUser(db, 'sec@flatbills.test');
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Flat Bills CHS','Road','Pune','Maharashtra','411001','sec@flatbills.test','9876500000') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([
      { unit_number: '101', carpet_area_sqft: 600 }, { unit_number: '102', carpet_area_sqft: 800 }, { unit_number: '103', carpet_area_sqft: 700 },
    ])]);
    await tx.query(`INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Maintenance','flat_per_unit',1000)`, [id]);
    await tx.query(`UPDATE society_settings SET upi_id='flatbills@upi', upi_payee_name='Flat Bills CHS', late_fee_type='flat', late_fee_amount=100 WHERE society_id=$1`, [id]);
    return id;
  });
  ids = { societyId, secretary };
  Object.assign(ids, { u101: await unit('101'), u102: await unit('102'), u103: await unit('103') });
});

test('bills are issued for every flat, even before anyone has joined', async () => {
  const r = await val(ids.secretary, `SELECT public.generate_bills($1,'2026-10-01','2026-10-31','2026-10-10')`, [ids.societyId]);
  assert.equal(r.bills, 3);
  assert.deepEqual(r.skipped_units, []);
  for (const u of [ids.u101, ids.u102, ids.u103]) assert.equal((await billsOf(u))[0].user_id, null);
});

test('the owner who joins takes the flat\'s bills, with one notification', async () => {
  await q(ids.secretary, `SELECT public.generate_bills($1,'2026-11-01','2026-11-30','2026-11-10')`, [ids.societyId]);
  // money for the flat arrived before anyone joined (recorded from the bank statement)
  await db.query(`INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, status)
                  VALUES ($1,$2,NULL,'PAY-NOBODY',500,'999988887777','pending_verification')`, [ids.societyId, ids.u101]);
  const asha = await invite('asha@flatbills.test', ids.u101);
  const bills = await billsOf(ids.u101);
  assert.equal(bills.length, 2);
  assert.equal((await db.query(`SELECT user_id FROM payments WHERE payment_number='PAY-NOBODY'`)).rows[0].user_id, asha, 'the payment recorded before joining is hers');
  assert.ok(bills.every((b) => b.user_id === asha));
  const n = await q(asha, `SELECT title, body FROM notifications WHERE kind='bill'`);
  assert.deepEqual(n.map((x) => x.title), ['Bills for Flat 101']);
  assert.match(n[0].body, /2 bills · ₹2,000(\.00)? due/);
  assert.equal((await q(asha, 'SELECT count(*)::int n FROM bills'))[0].n, 2, 'the owner now sees them');
  ids.asha = asha;
});

test('a sold flat bills nobody until the buyer joins', async () => {
  const o102 = await invite('o102@flatbills.test', ids.u102);
  await db.query(`UPDATE unit_ownerships SET from_date = '2025-04-01' WHERE unit_id = $1`, [ids.u102]);
  await q(ids.secretary, `SELECT public.transfer_flat_owner($1,'Buyer B','buyer@flatbills.test',NULL,current_date)`, [ids.u102]);
  await q(ids.secretary, `SELECT public.generate_bills($1,'2026-12-01','2026-12-31','2026-12-10')`, [ids.societyId]);
  const dec = (await billsOf(ids.u102)).at(-1);
  assert.equal(dec.user_id, null, 'not the seller');
  assert.notEqual(dec.user_id, o102);
  const buyer = await createUser(db, 'buyer@flatbills.test');
  await asUser(db, buyer, (tx) => tx.query('SELECT public.claim_my_invites()'));
  assert.equal((await billsOf(ids.u102)).at(-1).user_id, buyer);
});

test('a charge for chosen flats bills only those flats', async () => {
  const ruleId = (await q(ids.secretary, `INSERT INTO billing_rules (society_id, name, calculation_type, rate, applies_to_selected) VALUES ($1,'Parking','flat_per_unit',500,true) RETURNING id`, [ids.societyId]))[0].id;
  const jan = await val(ids.secretary, `SELECT public.generate_bills($1,'2027-01-01','2027-01-31','2027-01-10',NULL,true)`, [ids.societyId]);
  assert.ok(jan.preview.every((p) => Number(p.total) === 1000), 'no flat is charged before flats are chosen');
  await assert.rejects(q(ids.asha, 'SELECT public.set_rule_flats($1,$2)', [ruleId, [ids.u101]]), /Only the society committee can change billing rules/);
  assert.equal(await val(ids.secretary, 'SELECT public.set_rule_flats($1,$2)', [ruleId, [ids.u101, ids.u103]]), 2);
  const r = await val(ids.secretary, `SELECT public.generate_bills($1,'2027-01-01','2027-01-31','2027-01-10',NULL,true)`, [ids.societyId]);
  const by = Object.fromEntries(r.preview.map((p) => [p.unit_number, Number(p.total)]));
  assert.deepEqual(by, { 101: 1500, 102: 1000, 103: 1500 });
});

test('member dues show one row per flat and who has not joined', async () => {
  const rows = await q(ids.secretary, `SELECT unit_number, owner_name, bills_count FROM public.member_dues($1)`, [ids.societyId]);
  const by = Object.fromEntries(rows.map((r) => [r.unit_number, r]));
  assert.equal(rows.filter((r) => r.unit_number === '102').length, 1, 'one row per flat');
  assert.equal(by['103'].owner_name, 'Not joined yet');
  assert.equal(by['101'].owner_name, 'asha');
});

test('a society with one committee member approves its own vendor bills', async () => {
  const create = (user) => asUser(db, user, async (tx) => (await tx.query(
    `INSERT INTO expenses (society_id, category, title, subtotal, gst_amount, tds_amount, net_payable, status)
     VALUES ($1,'security','Guards',1000,0,0,1000,'pending_approval') RETURNING id`, [ids.societyId])).rows[0].id);
  assert.equal(await val(ids.secretary, 'SELECT public.sole_committee_admin($1)', [ids.societyId]), true);
  const e1 = await create(ids.secretary);
  const r = await val(ids.secretary, 'SELECT public.decide_expense($1,true,NULL)', [e1]);
  assert.equal(r.status, 'approved', 'one approval is enough even with two-step approval on');
  const audit = (await db.query(`SELECT action FROM audit_logs WHERE entity_id=$1 AND action LIKE 'expense.%'`, [e1])).rows.map((a) => a.action);
  assert.deepEqual(audit, ['expense.self_approved']);
  // a bill Sahvaas itself created (no maker) — one approval from the only member is enough
  const e0 = (await db.query(`INSERT INTO expenses (society_id, category, title, subtotal, gst_amount, tds_amount, net_payable, status)
    VALUES ($1,'other','Sahvaas plan',500,90,0,590,'pending_approval') RETURNING id`, [ids.societyId])).rows[0].id;
  assert.equal((await val(ids.secretary, 'SELECT public.decide_expense($1,true,NULL)', [e0])).status, 'approved');

  const treasurer = await createUser(db, 'tre@flatbills.test');
  await db.query(`INSERT INTO society_memberships (society_id, user_id, role) VALUES ($1,$2,'treasurer')`, [ids.societyId, treasurer]);
  assert.equal(await val(ids.secretary, 'SELECT public.sole_committee_admin($1)', [ids.societyId]), false);
  const e2 = await create(ids.secretary);
  await assert.rejects(q(ids.secretary, 'SELECT public.decide_expense($1,true,NULL)', [e2]), /another committee member must approve/);
});

test('the bill document has the breakup, arrears and the payable amount, for the right people only', async () => {
  await q(ids.secretary, `SELECT public.apply_late_fees($1,'2026-11-11')`, [ids.societyId]);
  const [oct, nov] = await billsOf(ids.u101);
  const d = await val(ids.asha, 'SELECT public.bill_document($1)', [nov.id]);
  assert.equal(d.society.name, 'Flat Bills CHS');
  assert.equal(d.society.upi_id, 'flatbills@upi');
  assert.equal(d.flat.number, '101');
  assert.equal(Number(d.flat.area), 600);
  assert.equal(d.member_name, 'asha');
  assert.deepEqual(d.bill.items.map((i) => [i.description, Number(i.amount)]), [['Maintenance', 1000]]);
  assert.equal(Number(d.bill.late_fee), 100);
  assert.equal(Number(d.arrears), Number(oct.due), 'the October bill is still open');
  assert.equal(Number(d.payable), Math.max(1100 + Number(oct.due) - Number(d.advance), 0));
  assert.equal(d.late_fee_rule, '₹100 after the due date');
  assert.equal(d.bill.period, 'November 2026 Maintenance');

  const other = await createUser(db, 'other@flatbills.test');
  await assert.rejects(q(other, 'SELECT public.bill_document($1)', [nov.id]), /Bill not found/);
  assert.equal((await val(ids.secretary, 'SELECT public.bill_document($1)', [nov.id])).flat.number, '101');
});
