// Regression tests for AUDIT_REPORT.md F1 (migration 011). Each test is a probe that
// reproduced a real problem before 011 and must now be blocked (or work correctly).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let A;
let B;
let r1;

const tryAs = async (user, fn) => {
  try {
    return { ok: true, value: await asUser(db, user, fn) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};
const tb = async (sid) => Object.fromEntries((await db.query(
  `SELECT a.code, sum(l.amount)::numeric bal FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
   WHERE l.society_id = $1 GROUP BY 1 HAVING sum(l.amount) <> 0`, [sid])).rows.map((r) => [r.code, Number(r.bal)]));

async function society(email, name) {
  const admin = await createUser(db, email);
  const id = await asUser(db, admin, async (tx) => {
    const sid = (await tx.query(`SELECT public.create_society($1,'Road','Pune','Maharashtra','411001',$2,'9876543210') AS id`, [name, email])).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [sid, JSON.stringify([{ unit_number: '101' }, { unit_number: '102' }, { unit_number: '103' }])]);
    await tx.query(`INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Maint','flat_per_unit',1000)`, [sid]);
    return sid;
  });
  return { admin, id };
}

before(async () => {
  db = await createDb();
  A = await society('a@int.test', 'Society A');
  B = await society('b@int.test', 'Society B');
  await asUser(db, A.admin, (tx) => tx.query(
    `INSERT INTO member_invites (society_id,email,role,unit_id,invited_by) SELECT $1,'r1@int.test','resident_owner',id,$2 FROM units WHERE society_id=$1 AND unit_number='101'`,
    [A.id, A.admin]));
  const user = await createUser(db, 'r1@int.test');
  await asUser(db, user, (tx) => tx.query('SELECT public.claim_my_invites()'));
  r1 = { user, unit: (await db.query(`SELECT id FROM units WHERE society_id=$1 AND unit_number='101'`, [A.id])).rows[0].id };
  await asUser(db, A.admin, (tx) => tx.query(`SELECT public.generate_bills($1,'2026-10-01','2026-10-31','2026-10-10')`, [A.id]));
});

test('C2: an expense cannot point at another society\'s file, and storage ignores such links', async () => {
  const path = `${A.id}/expenses/secret-invoice.pdf`;
  await asUser(db, A.admin, (tx) => tx.query(`INSERT INTO storage.objects (bucket_id,name) VALUES ('society-files',$1)`, [path]));
  const ins = await tryAs(B.admin, (tx) => tx.query(`INSERT INTO expenses (society_id,category,title,subtotal,document_url) VALUES ($1,'other','x',1,$2)`, [B.id, path]));
  assert.equal(ins.ok, false);
  assert.match(ins.error, /chk_expenses_document_in_society/);

  // Even a row smuggled in by a superuser must not unlock the file for Society B
  await db.query('ALTER TABLE expenses DROP CONSTRAINT chk_expenses_document_in_society');
  await db.query(`INSERT INTO expenses (society_id,category,title,subtotal,document_url) VALUES ($1,'other','x',1,$2)`, [B.id, path]);
  const seen = await asUser(db, B.admin, async (tx) => (await tx.query('SELECT count(*)::int n FROM storage.objects WHERE name=$1', [path])).rows[0].n);
  await db.query(`DELETE FROM expenses WHERE society_id=$1 AND document_url=$2`, [B.id, path]);
  await db.query(`ALTER TABLE expenses ADD CONSTRAINT chk_expenses_document_in_society CHECK (document_url IS NULL OR document_url LIKE society_id::text || '/%')`);
  assert.equal(seen, 0, 'storage policy checks the folder matches the record society');

  const own = await asUser(db, A.admin, async (tx) => (await tx.query('SELECT count(*)::int n FROM storage.objects WHERE name=$1', [path])).rows[0].n);
  assert.equal(own, 1, 'owning committee still sees its file');
});

test('H1: billing cycles, bills and flats with history cannot be deleted', async () => {
  const before = await tb(A.id);
  const cyc = (await db.query(`SELECT id FROM billing_cycles WHERE society_id=$1`, [A.id])).rows[0].id;
  const delCycle = await asUser(db, A.admin, async (tx) => (await tx.query('DELETE FROM billing_cycles WHERE id=$1', [cyc])).affectedRows);
  const delBills = await asUser(db, A.admin, async (tx) => (await tx.query('DELETE FROM bills WHERE society_id=$1', [A.id])).affectedRows);
  const delFlat = await asUser(db, A.admin, async (tx) => (await tx.query('DELETE FROM units WHERE id=$1', [r1.unit])).affectedRows);
  assert.deepEqual([delCycle, delBills, delFlat], [0, 0, 0]);
  assert.equal((await db.query('SELECT count(*)::int n FROM bills WHERE society_id=$1', [A.id])).rows[0].n, 1);
  assert.deepEqual(await tb(A.id), before);

  // A flat without history can still be removed (e.g. a typo in the import)
  const del103 = await asUser(db, A.admin, async (tx) => (await tx.query(`DELETE FROM units WHERE society_id=$1 AND unit_number='103'`, [A.id])).affectedRows);
  assert.equal(del103, 1);

  // Even the platform owner / superuser cannot delete a flat that has bills (FK no longer cascades)
  await assert.rejects(db.query('DELETE FROM units WHERE id=$1', [r1.unit]), /violates foreign key constraint/);
});

test('H2: bills, bill items and payments cannot be edited directly', async () => {
  const bill = (await db.query(`SELECT id FROM bills WHERE society_id=$1 AND unit_id=$2`, [A.id, r1.unit])).rows[0].id;
  const upd = await asUser(db, A.admin, async (tx) => (await tx.query(`UPDATE bills SET balance_due=0, status='paid' WHERE id=$1`, [bill])).affectedRows);
  assert.equal(upd, 0);
  const items = await asUser(db, A.admin, async (tx) => (await tx.query(`UPDATE bill_items SET amount=1 WHERE bill_id=$1`, [bill])).affectedRows);
  assert.equal(items, 0);
  const ins = await tryAs(A.admin, (tx) => tx.query(`INSERT INTO bill_items (bill_id, description, amount) VALUES ($1,'extra',500)`, [bill]));
  assert.equal(ins.ok, false);

  const pay = (await asUser(db, r1.user, (tx) => tx.query(
    `INSERT INTO payments (society_id,unit_id,user_id,payment_number,amount,transaction_reference_utr) VALUES ($1,$2,$3,'P-I1',1000,'121212121212') RETURNING id`,
    [A.id, r1.unit, r1.user]))).rows[0].id;
  const direct = await asUser(db, A.admin, async (tx) => (await tx.query(`UPDATE payments SET status='verified' WHERE id=$1`, [pay])).affectedRows);
  assert.equal(direct, 0, 'only verify_payment() can verify');

  const r = await asUser(db, A.admin, async (tx) => (await tx.query('SELECT public.verify_payment($1, true) AS r', [pay])).rows[0].r);
  assert.match(r.receipt_number, /^RCPT-/);
  const edit = await asUser(db, A.admin, async (tx) => (await tx.query('UPDATE payments SET amount=1 WHERE id=$1', [pay])).affectedRows);
  assert.equal(edit, 0, 'verified amount is immutable');
  assert.equal((await db.query('SELECT status FROM bills WHERE id=$1', [bill])).rows[0].status, 'paid');
});

test('H1: paid expenses cannot be deleted; void_expense reverses the ledger', async () => {
  const e = (await db.query(`INSERT INTO expenses (society_id,category,title,subtotal,status) VALUES ($1,'security','Guards',5000,'approved') RETURNING id`, [B.id])).rows[0].id;
  await asUser(db, B.admin, (tx) => tx.query('SELECT public.mark_expense_paid($1)', [e]));
  const del = await asUser(db, B.admin, async (tx) => (await tx.query('DELETE FROM expenses WHERE id=$1', [e])).affectedRows);
  assert.equal(del, 0);
  assert.equal((await tb(B.id))['5100'], 5000);

  await assert.rejects(asUser(db, B.admin, (tx) => tx.query('SELECT public.void_expense($1, $2)', [e, ''])), /reason is required/);
  const v = await asUser(db, B.admin, async (tx) => (await tx.query(`SELECT public.void_expense($1, 'Duplicate bill') AS r`, [e])).rows[0].r);
  assert.deepEqual(v, { status: 'voided', reversed: true });
  const b = await tb(B.id);
  assert.equal(b['5100'], undefined, 'expense reversed');
  assert.equal(b['1000'], undefined, 'bank reversed');

  // Pending expenses can still be deleted (nothing posted yet)
  const pending = (await asUser(db, B.admin, (tx) => tx.query(`INSERT INTO expenses (society_id,category,title,subtotal) VALUES ($1,'other','Draft',10) RETURNING id`, [B.id]))).rows[0].id;
  assert.equal(await asUser(db, B.admin, async (tx) => (await tx.query('DELETE FROM expenses WHERE id=$1', [pending])).affectedRows), 1);
});

test('cancel_bill: unpaid bills cancel with a reversal; paid bills cannot be cancelled', async () => {
  await asUser(db, B.admin, (tx) => tx.query(
    `INSERT INTO member_invites (society_id,email,role,unit_id,invited_by) SELECT $1,'rb@int.test','resident_owner',id,$2 FROM units WHERE society_id=$1 AND unit_number='101'`,
    [B.id, B.admin]));
  const rb = await createUser(db, 'rb@int.test');
  await asUser(db, rb, (tx) => tx.query('SELECT public.claim_my_invites()'));
  await asUser(db, B.admin, (tx) => tx.query(`SELECT public.generate_bills($1,'2026-10-01','2026-10-31','2026-10-10')`, [B.id]));
  const bill = (await db.query(`SELECT id, bill_number FROM bills WHERE society_id=$1`, [B.id])).rows[0];
  const before1200 = (await tb(B.id))['1200'];
  assert.equal(before1200, 1000);

  await assert.rejects(asUser(db, r1.user, (tx) => tx.query(`SELECT public.cancel_bill($1,'x')`, [bill.id])), /Only the society committee/);
  const c = await asUser(db, B.admin, async (tx) => (await tx.query(`SELECT public.cancel_bill($1,'Wrong rate') AS r`, [bill.id])).rows[0].r);
  assert.equal(c.status, 'cancelled');
  assert.equal((await tb(B.id))['1200'], undefined, 'receivable reversed');
  await assert.rejects(asUser(db, B.admin, (tx) => tx.query(`SELECT public.cancel_bill($1,'again')`, [bill.id])), /already cancelled/);

  // M2: the period can be billed again after cancellation, numbering continues
  await asUser(db, B.admin, (tx) => tx.query(`SELECT public.generate_bills($1,'2026-10-01','2026-10-31','2026-10-10')`, [B.id]));
  const numbers = (await db.query(`SELECT bill_number, status FROM bills WHERE society_id=$1 ORDER BY bill_number`, [B.id])).rows;
  assert.deepEqual(numbers, [{ bill_number: 'B2610-0001', status: 'cancelled' }, { bill_number: 'B2610-0002', status: 'issued' }]);

  const paidBill = (await db.query(`SELECT id FROM bills WHERE society_id=$1 AND unit_id=$2`, [A.id, r1.unit])).rows[0].id;
  await assert.rejects(asUser(db, A.admin, (tx) => tx.query(`SELECT public.cancel_bill($1,'oops')`, [paidBill])), /already has payments/);
});

test('M2: two billing cycles in the same month get distinct bill numbers', async () => {
  await asUser(db, A.admin, (tx) => tx.query(`SELECT public.generate_bills($1,'2026-11-01','2026-11-15','2026-11-10')`, [A.id]));
  await asUser(db, A.admin, (tx) => tx.query(`SELECT public.generate_bills($1,'2026-11-16','2026-11-30','2026-11-25')`, [A.id]));
  const nov = (await db.query(`SELECT bill_number FROM bills WHERE society_id=$1 AND bill_number LIKE 'B2611-%' ORDER BY 1`, [A.id])).rows.map((r) => r.bill_number);
  assert.deepEqual(nov, ['B2611-0001', 'B2611-0002']);
});

test('M1: committee cannot change subscription fields; platform RPCs and imports still can', async () => {
  const r = await tryAs(B.admin, (tx) => tx.query(`UPDATE societies SET subscription_status='active' WHERE id=$1`, [B.id]));
  assert.equal(r.ok, false);
  assert.match(r.error, /managed by Sahvaas/);
  const units = await tryAs(B.admin, (tx) => tx.query(`UPDATE societies SET total_units=999 WHERE id=$1`, [B.id]));
  assert.equal(units.ok, false);
  // Allowed: editing contact details
  await asUser(db, B.admin, (tx) => tx.query(`UPDATE societies SET contact_phone='9123456789' WHERE id=$1`, [B.id]));
  // bulk import (SECURITY DEFINER) still updates total_units
  await asUser(db, B.admin, (tx) => tx.query('SELECT public.bulk_upsert_units($1,$2)', [B.id, JSON.stringify([{ unit_number: '104' }])]));
  assert.equal((await db.query('SELECT total_units FROM societies WHERE id=$1', [B.id])).rows[0].total_units, 4);
  // platform owner can still change status
  const owner = await createUser(db, 'owner@int.test');
  await db.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [owner]);
  await asUser(db, owner, (tx) => tx.query(`SELECT public.platform_set_society_status($1,'active')`, [B.id]));
  assert.equal((await db.query('SELECT subscription_status FROM societies WHERE id=$1', [B.id])).rows[0].subscription_status, 'active');
});

test('L3: a second bucket with non-uuid folders does not break storage reads', async () => {
  await db.query(`INSERT INTO storage.buckets (id,name,public) VALUES ('public-assets','public-assets',true)`);
  await db.query(`INSERT INTO storage.objects (bucket_id,name) VALUES ('public-assets','logos/brand.png')`);
  const r = await tryAs(r1.user, (tx) => tx.query(`SELECT count(*)::int n FROM storage.objects`));
  assert.equal(r.ok, true);
});
