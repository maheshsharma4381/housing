// A database that already has bills and payments when 007 is applied gets them posted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser, applyMigration, migrationFiles } from './harness.mjs';

test('007 backfills bills, late fees and verified payments created before the ledger existed', async () => {
  const db = await createDb({ upTo: '006' });
  const admin = await createUser(db, 'old.treasurer@example.com');
  const societyId = await asUser(db, admin, async (tx) => {
    const id = (await tx.query(
      `SELECT public.create_society('Old Society', 'Road', 'Pune', 'Maharashtra', '411003', 'old.treasurer@example.com', '9876543210', NULL, NULL, 'treasurer') AS id`
    )).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1, $2)', [id, JSON.stringify([{ unit_number: '1' }])]);
    await tx.query(
      `INSERT INTO society_memberships (society_id, user_id, role, unit_id) SELECT $1, $2, 'resident_owner', id FROM units WHERE society_id = $1`,
      [id, admin]
    );
    await tx.query(`INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1, 'Maintenance', 'flat_per_unit', 1000)`, [id]);
    await tx.query(`SELECT public.generate_bills($1, '2026-09-01', '2026-09-30', '2026-09-10')`, [id]);
    await tx.query(`SELECT public.apply_late_fees($1, '2026-09-20')`, [id]); // 2% -> 20
    const unit = (await tx.query('SELECT id FROM units WHERE society_id = $1', [id])).rows[0].id;
    const pay = (await tx.query(
      `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, status)
       VALUES ($1, $2, $3, 'P1', 600, '123412341234', 'pending_verification') RETURNING id`,
      [id, unit, admin]
    )).rows[0].id;
    await tx.query('SELECT public.verify_payment($1, true)', [pay]);
    return id;
  });

  for (const file of migrationFiles().filter((f) => f.slice(0, 3) > '006')) {
    await applyMigration(db, file);
  }

  const { rows } = await db.query(
    `SELECT a.code, sum(l.amount)::numeric AS bal FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
     WHERE l.society_id = $1 GROUP BY a.code ORDER BY a.code`,
    [societyId]
  );
  assert.deepEqual(rows.map((r) => [r.code, Number(r.bal)]), [
    ['1000', 600],
    ['1200', 420], // 1000 + 20 late fee - 600 paid
    ['4000', -1000],
    ['4100', -20],
  ]);

  // Re-applying 007 must not double-post
  await applyMigration(db, '007_ledger.sql');
  const n = (await db.query('SELECT count(*)::int AS n FROM journal_entries WHERE society_id = $1', [societyId])).rows[0].n;
  assert.equal(n, 3);
});
