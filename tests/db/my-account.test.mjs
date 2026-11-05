// 036: an owner's own flat statement (spec 10.2) — the same numbers as the CA's party ledger,
// starting at the transfer date with "Brought forward from previous owner" after an owner change.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const invite = async (email, unitId, role = 'resident_owner') => {
  await q(ids.secretary, `INSERT INTO member_invites (society_id,email,role,unit_id,invited_by) VALUES ($1,$2,$3,$4,$5)`, [ids.societyId, email, role, unitId, ids.secretary]);
  const id = await createUser(db, email);
  await asUser(db, id, (tx) => tx.query('SELECT public.claim_my_invites()'));
  return id;
};
// generate_bills dates bills today; move a flat's bills (and their journal entries) back in time
const backdate = async (unitId, days) => {
  const bills = (await db.query('SELECT id FROM bills WHERE unit_id=$1', [unitId])).rows.map((b) => b.id);
  await db.query(`UPDATE bills SET bill_date = current_date - $2::int WHERE id = ANY($1)`, [bills, days]);
  await db.query(`UPDATE journal_entries SET entry_date = current_date - $2::int WHERE reference_event_id = ANY($1)`, [bills, days]);
  await db.query(`UPDATE ledger_entries SET date = current_date - $2::int WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE reference_event_id = ANY($1))`, [bills, days]);
};
const range = ['2025-01-01', '2099-12-31'];

before(async () => {
  db = await createDb();
  const secretary = await createUser(db, 'sec@account.test');
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Account Court','Road','Pune','Maharashtra','411001','sec@account.test','9876500000') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }, { unit_number: '102' }])]);
    await tx.query(`INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Maintenance','flat_per_unit',1000)`, [id]);
    return id;
  });
  ids = { societyId, secretary };
  const unit = async (n) => (await db.query('SELECT id FROM units WHERE society_id=$1 AND unit_number=$2', [societyId, n])).rows[0].id;
  ids.u101 = await unit('101');
  ids.u102 = await unit('102');
  ids.seller = await invite('seller@account.test', ids.u101);
  ids.c102 = await invite('c102@account.test', ids.u102);
  ids.tenant = await invite('tenant@account.test', ids.u102, 'resident_tenant');
  await db.query(`UPDATE unit_ownerships SET from_date = current_date - 400 WHERE unit_id = ANY($1)`, [[ids.u101, ids.u102]]);
  await q(secretary, `SELECT public.generate_bills($1,'2026-10-01','2026-10-31','2026-10-10')`, [societyId]);
  await backdate(ids.u101, 30);
  await backdate(ids.u102, 30);
});

test('the only owner a flat has had sees it from the start, with links to the bills', async () => {
  const s = await val(ids.c102, 'SELECT public.my_flat_statement($1,$2,$3)', [ids.u102, ...range]);
  assert.equal(s.flat, '102');
  assert.equal(s.opening_label, 'Opening balance');
  assert.equal(Number(s.opening), 0);
  assert.equal(s.lines.length, 1);
  assert.equal(Number(s.lines[0].debit), 1000);
  assert.equal(s.lines[0].ref_type, 'bill.issued');
  const bill = (await db.query('SELECT id FROM bills WHERE unit_id=$1', [ids.u102])).rows[0].id;
  assert.equal(s.lines[0].ref_id, bill);
  assert.equal(Number(s.closing), 1000);
  // the same numbers as the CA's party ledger
  const ca = await val(ids.secretary, `SELECT public.party_statement($1,'flat',$2,$3,$4)`, [ids.societyId, ids.u102, ...range]);
  assert.equal(Number(ca.closing), Number(s.closing));
});

test('after an owner change the new owner starts at the transfer date, brought forward', async () => {
  await q(ids.secretary, `SELECT public.transfer_flat_owner($1,'Buyer B','buyer@account.test',NULL,current_date - 5)`, [ids.u101]);
  const buyer = await createUser(db, 'buyer@account.test');
  await asUser(db, buyer, (tx) => tx.query('SELECT public.claim_my_invites()'));
  const s = await val(buyer, 'SELECT public.my_flat_statement($1,$2,$3)', [ids.u101, ...range]);
  assert.equal(s.opening_label, 'Brought forward from previous owner');
  assert.equal(Number(s.opening), 1000);
  assert.deepEqual(s.lines, []);
  const today = (await db.query(`SELECT (current_date - 5)::text d`)).rows[0].d;
  assert.equal(s.from, today);
  const ca = await val(ids.secretary, `SELECT public.party_statement($1,'flat',$2,$3,$4)`, [ids.societyId, ids.u101, today, range[1]]);
  assert.equal(Number(ca.closing), Number(s.closing), 'the CA sees the same balance for that period');
  await assert.rejects(q(ids.seller, 'SELECT public.my_flat_statement($1,$2,$3)', [ids.u101, ...range]), /Only the flat's owner can see its account/);
});

test('tenants and other flats see nothing', async () => {
  await assert.rejects(q(ids.tenant, 'SELECT public.my_flat_statement($1,$2,$3)', [ids.u102, ...range]), /Only the flat's owner can see its account/);
  await assert.rejects(q(ids.c102, 'SELECT public.my_flat_statement($1,$2,$3)', [ids.u101, ...range]), /Only the flat's owner can see its account/);
  await assert.rejects(q(ids.c102, `SELECT public.my_flat_statement($1,'2026-12-01','2026-01-01')`, [ids.u102]), /Choose a date range/);
});

test('a second owner of a sold flat starts at the transfer date too, and links only what they can open', async () => {
  // the buyer's spouse joins flat 101 as a second owner (Members invite)
  const spouse = await invite('spouse@account.test', ids.u101);
  // a bill after the transfer belongs to the buyer (the first owner) — the spouse sees the line but cannot open the bill
  await q(ids.secretary, `SELECT public.generate_bills($1,'2099-01-01','2099-01-31','2099-01-10')`, [ids.societyId]);
  const s = await val(spouse, 'SELECT public.my_flat_statement($1,$2,$3)', [ids.u101, ...range]);
  assert.equal(s.opening_label, 'Brought forward from previous owner');
  assert.ok(s.lines.every((l) => !/RCPT|seller/i.test(l.narration)), 'no line from before the transfer');
  assert.equal(s.lines.length, 1);
  assert.equal(s.lines[0].ref_id, null, "the bill is the buyer's to open");
  const buyerSt = await val(await (await db.query(`SELECT id FROM profiles WHERE email='buyer@account.test'`)).rows[0].id, 'SELECT public.my_flat_statement($1,$2,$3)', [ids.u101, ...range]);
  assert.ok(buyerSt.lines[0].ref_id, 'the buyer opens their own bill');
});

test('a sale whose seller never joined is still an owner change', async () => {
  const u103 = (await db.query(`SELECT id FROM units WHERE society_id=$1 AND unit_number='103'`, [ids.societyId])).rows[0]?.id
    ?? (await asUser(db, ids.secretary, async (tx) => {
      await tx.query('SELECT public.bulk_upsert_units($1,$2)', [ids.societyId, JSON.stringify([{ unit_number: '103' }])]);
      return (await tx.query(`SELECT id FROM units WHERE society_id=$1 AND unit_number='103'`, [ids.societyId])).rows[0].id;
    }));
  await q(ids.secretary, `SELECT public.generate_bills($1,'2026-09-01','2026-09-30','2026-09-10')`, [ids.societyId]);
  await backdate(u103, 60);
  await q(ids.secretary, `SELECT public.transfer_flat_owner($1,'Buyer D','buyerd@account.test',NULL,current_date - 5)`, [u103]);
  const buyerD = await createUser(db, 'buyerd@account.test');
  await asUser(db, buyerD, (tx) => tx.query('SELECT public.claim_my_invites()'));
  const s = await val(buyerD, 'SELECT public.my_flat_statement($1,$2,$3)', [u103, ...range]);
  assert.equal(s.opening_label, 'Brought forward from previous owner');
  assert.equal(Number(s.opening), 1000, 'the unpaid bill from before the sale is brought forward');
  // a period that ends before they bought the flat is refused, not printed back to front
  await assert.rejects(q(buyerD, `SELECT public.my_flat_statement($1,'2025-01-01', current_date - 30)`, [u103]), /You became the owner on/);
});
