// Double-entry engine: every money event posts a balanced journal to the right accounts.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let admin;
let societyId;
let resident;
let unitId;
let billId;

const num = (v) => Number(v);

/** Balance per account code (debit positive). */
async function balances() {
  const { rows } = await db.query(
    `SELECT a.code, coalesce(sum(l.amount), 0) AS bal
     FROM accounts a LEFT JOIN ledger_entries l ON l.account_id = a.id
     WHERE a.society_id = $1 GROUP BY a.code HAVING coalesce(sum(l.amount), 0) <> 0 ORDER BY a.code`,
    [societyId]
  );
  return Object.fromEntries(rows.map((r) => [r.code, num(r.bal)]));
}

async function assertAllJournalsBalanced() {
  const { rows } = await db.query(
    `SELECT j.entry_number, sum(l.amount) AS diff FROM journal_entries j JOIN ledger_entries l ON l.journal_entry_id = j.id
     GROUP BY j.entry_number HAVING sum(l.amount) <> 0`
  );
  assert.deepEqual(rows, [], 'every journal must have debits == credits');
}

before(async () => {
  db = await createDb();
  admin = await createUser(db, 'treasurer@ledger.test');
  resident = await createUser(db, 'owner@ledger.test');
  societyId = await asUser(db, admin, async (tx) => {
    const { rows } = await tx.query(
      `SELECT public.create_society('Ledger Heights', 'Road 3', 'Pune', 'Maharashtra', '411002', 'treasurer@ledger.test', '9876543210', NULL, NULL, 'treasurer') AS id`
    );
    const id = rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1, $2)', [id, JSON.stringify([{ unit_number: '101', carpet_area_sqft: 800 }])]);
    await tx.query(
      `INSERT INTO member_invites (society_id, email, role, unit_id, invited_by)
       SELECT $1, 'owner@ledger.test', 'resident_owner', id, $2 FROM units WHERE society_id = $1`,
      [id, admin]
    );
    await tx.query(
      `INSERT INTO billing_rules (society_id, name, calculation_type, rate, tax_rate_percent, account_code) VALUES
         ($1, 'Maintenance charges', 'flat_per_unit', 2000, 18, '4000'),
         ($1, 'Sinking fund', 'per_sqft', 0.5, 0, '3000'),
         ($1, 'Repair fund', 'flat_per_unit', 250, 0, '3100')`,
      [id]
    );
    return id;
  });
  await asUser(db, resident, (tx) => tx.query('SELECT public.claim_my_invites()'));
  unitId = (await db.query('SELECT id FROM units WHERE society_id = $1', [societyId])).rows[0].id;
});

test('issuing bills posts Receivable vs income, funds and GST', async () => {
  await asUser(db, admin, (tx) =>
    tx.query(`SELECT public.generate_bills($1, '2026-10-01', '2026-10-31', '2026-10-10')`, [societyId])
  );
  billId = (await db.query('SELECT id, total_amount FROM bills WHERE society_id = $1', [societyId])).rows[0].id;

  // 2000 + 18% GST (360) + sinking 400 + repair 250 = 3010
  assert.deepEqual(await balances(), { 1200: 3010, 2100: -360, 3000: -400, 3100: -250, 4000: -2000 });
  await assertAllJournalsBalanced();

  const j = (await db.query(`SELECT entry_number, reference_event_type FROM journal_entries WHERE society_id = $1`, [societyId])).rows;
  assert.deepEqual(j, [{ entry_number: 'JV-000001', reference_event_type: 'bill.issued' }]);
});

test('late fee posts to interest income', async () => {
  await asUser(db, admin, (tx) => tx.query(`SELECT public.apply_late_fees($1, '2026-10-15')`, [societyId]));
  const b = await balances();
  assert.equal(b['4100'], -60.2); // 2% of 3010
  assert.equal(b['1200'], 3070.2);
  await assertAllJournalsBalanced();
});

test('verified payment debits bank, clears receivable and books the excess as advance', async () => {
  const payId = await asUser(db, resident, async (tx) =>
    (await tx.query(
      `INSERT INTO payments (society_id, unit_id, user_id, bill_id, payment_number, amount, transaction_reference_utr, status)
       VALUES ($1, $2, $3, $4, 'PAY-L1', 3100, '999999999999', 'pending_verification') RETURNING id`,
      [societyId, unitId, resident, billId]
    )).rows[0].id
  );
  await asUser(db, admin, (tx) => tx.query('SELECT public.verify_payment($1, true)', [payId]));

  const b = await balances();
  assert.equal(b['1000'], 3100);
  assert.equal(b['1200'], undefined, 'receivable fully cleared');
  assert.equal(b['2300'], -29.8, 'excess 3100 - 3070.20 is an advance liability');
  await assertAllJournalsBalanced();

  // Re-running the poster is a no-op (idempotent)
  await db.query('SELECT public.ledger_post_payment($1)', [payId]);
  const count = (await db.query(`SELECT count(*)::int AS n FROM journal_entries WHERE reference_event_type = 'payment.verified'`)).rows[0].n;
  assert.equal(count, 1);
});

test('rejected payments post nothing', async () => {
  const payId = await asUser(db, resident, async (tx) =>
    (await tx.query(
      `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, status)
       VALUES ($1, $2, $3, 'PAY-L2', 500, '888888888888', 'pending_verification') RETURNING id`,
      [societyId, unitId, resident]
    )).rows[0].id
  );
  const before = (await db.query('SELECT count(*)::int AS n FROM journal_entries')).rows[0].n;
  await asUser(db, admin, (tx) => tx.query(`SELECT public.verify_payment($1, false, 'Not in statement')`, [payId]));
  const after = (await db.query('SELECT count(*)::int AS n FROM journal_entries')).rows[0].n;
  assert.equal(after, before);
});

test('paid expense debits the expense head, credits bank and TDS payable', async () => {
  // Fixture inserted as an already-approved expense (approval workflow is covered in operations tests)
  const expenseId = (await db.query(
    `INSERT INTO expenses (society_id, category, title, subtotal, gst_amount, tds_amount, status)
     VALUES ($1, 'security', 'Guards October', 10000, 1800, 200, 'approved') RETURNING id`,
    [societyId]
  )).rows[0].id;
  const b0 = await db.query(`SELECT count(*)::int AS n FROM journal_entries WHERE reference_event_type = 'expense.paid'`);
  assert.equal(b0.rows[0].n, 0, 'approved but unpaid expense does not post');
  await asUser(db, admin, (tx) => tx.query(`SELECT public.mark_expense_paid($1, '2026-10-20', 'NEFT-1')`, [expenseId]));
  const b = await balances();
  assert.equal(b['5100'], 11800);
  assert.equal(b['2200'], -200);
  assert.equal(b['1000'], 3100 - 11600);
  await assertAllJournalsBalanced();
});

test('trial balance totals match and income & expenditure shows the surplus', async () => {
  const { tb, ie } = await asUser(db, admin, async (tx) => ({
    tb: (await tx.query(`SELECT * FROM public.trial_balance($1)`, [societyId])).rows,
    ie: (await tx.query(`SELECT * FROM public.income_expenditure($1, '2026-04-01', '2027-03-31')`, [societyId])).rows,
  }));
  const dr = tb.reduce((s, r) => s + num(r.debit), 0);
  const cr = tb.reduce((s, r) => s + num(r.credit), 0);
  assert.ok(Math.abs(dr - cr) < 0.001, `TB must balance (Dr ${dr} vs Cr ${cr})`);

  assert.deepEqual(ie.map((r) => [r.type, r.code, num(r.amount)]), [
    ['income', '4000', 2000],
    ['income', '4100', 60.2],
    ['expense', '5100', 11800],
  ]);
});

test('member dues lists outstanding flats; residents cannot read reports or ledger', async () => {
  await asUser(db, admin, async (tx) => {
    const dues = (await tx.query(`SELECT * FROM public.member_dues($1)`, [societyId])).rows;
    assert.deepEqual(dues, [], 'the only bill is fully paid');
  });

  await assert.rejects(
    asUser(db, resident, (tx) => tx.query(`SELECT * FROM public.trial_balance($1)`, [societyId])),
    /do not have access/
  );
  const rows = await asUser(db, resident, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM ledger_entries')).rows[0].n);
  assert.equal(rows, 0);
  await assert.rejects(
    asUser(db, admin, (tx) => tx.query(`SELECT public.post_journal($1, current_date, 'x', gen_random_uuid(), 'x', '[]')`, [societyId])),
    /permission denied/
  );
});

test('clients cannot write ledger entries directly', async () => {
  await assert.rejects(
    asUser(db, admin, async (tx) => {
      const acc = (await tx.query(`SELECT id FROM accounts WHERE society_id = $1 AND code = '1000'`, [societyId])).rows[0].id;
      const je = (await tx.query(`SELECT id FROM journal_entries WHERE society_id = $1 LIMIT 1`, [societyId])).rows[0].id;
      await tx.query(
        `INSERT INTO ledger_entries (society_id, account_id, journal_entry_id, date, amount, narration) VALUES ($1, $2, $3, current_date, 1000000, 'fake')`,
        [societyId, acc, je]
      );
    }),
    /row-level security/
  );
});

test('demo seed and pre-existing data are posted (backfill/deferred trigger)', async () => {
  const fresh = await createDb();
  await createUser(fresh, 'seed@ledger.test');
  const seed = readFileSync(new URL('../../src/db/seed/demo_seed.sql', import.meta.url), 'utf8').replace("'you@example.com'", "'seed@ledger.test'");
  await fresh.exec(seed);
  const { rows } = await fresh.query(
    `SELECT a.code, sum(l.amount)::numeric AS bal FROM ledger_entries l JOIN accounts a ON a.id = l.account_id GROUP BY a.code ORDER BY a.code`
  );
  assert.deepEqual(rows.map((r) => [r.code, num(r.bal)]), [['1200', 3500], ['4000', -3500]]);
});
