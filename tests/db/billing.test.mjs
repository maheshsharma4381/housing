// Money loop: billing rules -> generate bills -> resident pays -> treasurer verifies -> late fees
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let admin;
let societyId;
let r1;
let r2;
let r1Unit;

const PERIOD = ['2026-10-01', '2026-10-31', '2026-10-10'];
const num = (v) => Number(v);

before(async () => {
  db = await createDb();
  admin = await createUser(db, 'treasurer@example.com');
  societyId = await asUser(db, admin, async (tx) => {
    const { rows } = await tx.query(
      `SELECT public.create_society('Lake View CHS', 'Road 2', 'Thane', 'Maharashtra', '400601', 'treasurer@example.com', '9876543210', NULL, NULL, 'treasurer') AS id`
    );
    const id = rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1, $2)', [id, JSON.stringify([
      { unit_number: 'A-101', unit_type: '2BHK', carpet_area_sqft: 650 },
      { unit_number: 'A-102', unit_type: '3BHK', carpet_area_sqft: 900 },
      { unit_number: 'A-103', unit_type: '2BHK', carpet_area_sqft: 650 },
    ])]);
    for (const [email, flat] of [['r1@example.com', 'A-101'], ['r2@example.com', 'A-102']]) {
      await tx.query(
        `INSERT INTO member_invites (society_id, email, role, unit_id, invited_by)
         SELECT $1, $2, 'resident_owner', id, $3 FROM units WHERE society_id = $1 AND unit_number = $4`,
        [id, email, admin, flat]
      );
    }
    await tx.query(
      `INSERT INTO billing_rules (society_id, name, calculation_type, rate, tax_rate_percent, applies_to_unit_type) VALUES
         ($1, 'Maintenance charges', 'flat_per_unit', 2000, 18, NULL),
         ($1, 'Sinking fund', 'per_sqft', 0.5, 0, NULL),
         ($1, 'Large flat surcharge', 'flat_per_unit', 300, 0, '3BHK')`,
      [id]
    );
    return id;
  });

  r1 = await createUser(db, 'r1@example.com');
  r2 = await createUser(db, 'r2@example.com');
  for (const u of [r1, r2]) await asUser(db, u, (tx) => tx.query('SELECT public.claim_my_invites()'));
  r1Unit = (await db.query(`SELECT id FROM units WHERE unit_number = 'A-101'`)).rows[0].id;
});

const generate = (user, dryRun) =>
  asUser(db, user, async (tx) =>
    (await tx.query('SELECT public.generate_bills($1, $2, $3, $4, NULL, $5) AS r', [societyId, ...PERIOD, dryRun])).rows[0].r
  );

const submitPayment = (user, unitId, amount, utr, billId = null) =>
  asUser(db, user, async (tx) =>
    (await tx.query(
      `INSERT INTO payments (society_id, unit_id, user_id, bill_id, payment_number, amount, transaction_reference_utr, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_verification') RETURNING id`,
      [societyId, unitId, user, billId, `PAY-${crypto.randomUUID().slice(0, 8)}`, amount, utr]
    )).rows[0].id
  );

const verify = (user, paymentId, approve, notes = null) =>
  asUser(db, user, async (tx) =>
    (await tx.query('SELECT public.verify_payment($1, $2, $3) AS r', [paymentId, approve, notes])).rows[0].r
  );

test('dry run previews bills without writing, and skips flats without an owner', async () => {
  const r = await generate(admin, true);
  assert.equal(r.bills, 2);
  assert.equal(num(r.total_amount), 2685 + 3110);
  assert.deepEqual(r.skipped_units, [{ unit_number: 'A-103', reason: 'No owner linked' }]);
  assert.deepEqual(r.preview.map((p) => [p.unit_number, num(p.subtotal), num(p.tax), num(p.total)]), [
    ['A-101', 2325, 360, 2685],
    ['A-102', 2750, 360, 3110],
  ]);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM bills');
  assert.equal(rows[0].n, 0);
});

test('residents cannot generate bills', async () => {
  await assert.rejects(generate(r1, false), /Only the society committee/);
});

test('generate creates one cycle, bills with line items, and blocks duplicates', async () => {
  const r = await generate(admin, false);
  assert.equal(r.bills, 2);
  assert.ok(r.cycle_id);
  assert.equal(r.cycle_name, 'October 2026 Maintenance');

  const bills = (await db.query(`SELECT bill_number, total_amount, balance_due, status FROM bills ORDER BY bill_number`)).rows;
  assert.deepEqual(bills.map((b) => [b.bill_number, num(b.total_amount), num(b.balance_due), b.status]), [
    ['B2610-0001', 2685, 2685, 'issued'],
    ['B2610-0002', 3110, 3110, 'issued'],
  ]);
  const items = (await db.query(`SELECT b.bill_number, count(*)::int AS n FROM bill_items i JOIN bills b ON b.id = i.bill_id GROUP BY 1 ORDER BY 1`)).rows;
  assert.deepEqual(items, [{ bill_number: 'B2610-0001', n: 2 }, { bill_number: 'B2610-0002', n: 3 }]);

  await assert.rejects(generate(admin, false), /already been generated/);
});

test('resident sees only their own bill and its items', async () => {
  await asUser(db, r1, async (tx) => {
    const b = await tx.query('SELECT id, bill_number FROM bills');
    assert.deepEqual(b.rows.map((x) => x.bill_number), ['B2610-0001']);
    const i = await tx.query('SELECT description FROM bill_items ORDER BY description');
    assert.deepEqual(i.rows.map((x) => x.description), ['Maintenance charges', 'Sinking fund']);
  });
});

test('verify: partial payment issues receipt and allocates to the bill', async () => {
  const bill = (await db.query(`SELECT id FROM bills WHERE bill_number = 'B2610-0001'`)).rows[0].id;
  const payId = await submitPayment(r1, r1Unit, 2000, '111111111111', bill);

  await assert.rejects(verify(r1, payId, true), /Only the society committee/);

  const r = await verify(admin, payId, true);
  assert.equal(r.status, 'verified');
  assert.match(r.receipt_number, /^RCPT-\d{4}-00001$/);
  assert.equal(num(r.allocated), 2000);
  assert.equal(num(r.unallocated), 0);

  const b = (await db.query('SELECT amount_paid, balance_due, status FROM bills WHERE id = $1', [bill])).rows[0];
  assert.deepEqual([num(b.amount_paid), num(b.balance_due), b.status], [2000, 685, 'partially_paid']);

  // Resident can see their own allocation for the receipt
  const allocs = await asUser(db, r1, async (tx) => (await tx.query('SELECT amount FROM payment_allocations')).rows);
  assert.deepEqual(allocs.map((a) => num(a.amount)), [2000]);

  await assert.rejects(verify(admin, payId, true), /already verified/);
});

test('the same UTR cannot be submitted twice', async () => {
  await assert.rejects(submitPayment(r1, r1Unit, 685, '111111111111'), /duplicate key|uq_payment_utr_active/);
});

test('verify: overpayment clears the bill and reports the advance', async () => {
  const payId = await submitPayment(r1, r1Unit, 1000, '222222222222');
  const r = await verify(admin, payId, true);
  assert.match(r.receipt_number, /-00002$/);
  assert.equal(num(r.allocated), 685);
  assert.equal(num(r.unallocated), 315);
  const b = (await db.query(`SELECT balance_due, status FROM bills WHERE bill_number = 'B2610-0001'`)).rows[0];
  assert.deepEqual([num(b.balance_due), b.status], [0, 'paid']);
});

test('reject requires a reason and frees the UTR for resubmission', async () => {
  const payId = await submitPayment(r1, r1Unit, 500, '333333333333');
  await assert.rejects(verify(admin, payId, false), /reason is required/);
  const r = await verify(admin, payId, false, 'UTR not found in bank statement');
  assert.equal(r.status, 'rejected');
  const p = (await db.query('SELECT status, verification_notes, receipt_number FROM payments WHERE id = $1', [payId])).rows[0];
  assert.deepEqual(p, { status: 'rejected', verification_notes: 'UTR not found in bank statement', receipt_number: null });
  await submitPayment(r1, r1Unit, 500, '333333333333');
});

test('late fees: overdue bills get the percentage fee exactly once', async () => {
  const run = () =>
    asUser(db, admin, async (tx) => (await tx.query(`SELECT public.apply_late_fees($1, '2026-10-11') AS r`, [societyId])).rows[0].r);

  const first = await run();
  assert.equal(first.marked_overdue, 1);
  assert.equal(first.late_fees_applied, 1);
  assert.equal(num(first.late_fee_total), 62.2); // default 2% of 3110

  const b = (await db.query(`SELECT total_amount, balance_due, interest_or_late_fee, status FROM bills WHERE bill_number = 'B2610-0002'`)).rows[0];
  assert.deepEqual([num(b.total_amount), num(b.balance_due), num(b.interest_or_late_fee), b.status], [3172.2, 3172.2, 62.2, 'overdue']);

  const second = await run();
  assert.deepEqual([second.marked_overdue, second.late_fees_applied], [0, 0]);

  const paid = (await db.query(`SELECT status FROM bills WHERE bill_number = 'B2610-0001'`)).rows[0];
  assert.equal(paid.status, 'paid', 'paid bills are untouched');
});

test('residents cannot apply late fees', async () => {
  await assert.rejects(
    asUser(db, r1, (tx) => tx.query('SELECT public.apply_late_fees($1)', [societyId])),
    /Only the society committee/
  );
});
