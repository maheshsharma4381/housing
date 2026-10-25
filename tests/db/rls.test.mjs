// Tenant-isolation and privilege-escalation checks for 002/004 policies.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ctx;

async function setupSociety(adminEmail, name) {
  const admin = await createUser(db, adminEmail);
  const societyId = await asUser(db, admin, async (tx) => {
    const { rows } = await tx.query(
      `SELECT public.create_society($1, 'Road 1', 'Pune', 'Maharashtra', '411001', $2, '9876543210') AS id`,
      [name, adminEmail]
    );
    await tx.query('SELECT public.bulk_upsert_units($1, $2)', [rows[0].id, JSON.stringify([{ unit_number: '101' }, { unit_number: '102' }])]);
    return rows[0].id;
  });
  return { admin, societyId };
}

async function addResident(email, societyId, admin, unitNumber) {
  await asUser(db, admin, async (tx) => {
    const u = await tx.query('SELECT id FROM units WHERE society_id = $1 AND unit_number = $2', [societyId, unitNumber]);
    await tx.query(
      `INSERT INTO member_invites (society_id, email, role, unit_id, invited_by) VALUES ($1, $2, 'resident_owner', $3, $4)`,
      [societyId, email, u.rows[0].id, admin]
    );
  });
  const user = await createUser(db, email);
  await asUser(db, user, (tx) => tx.query('SELECT public.claim_my_invites()'));
  const { rows } = await db.query('SELECT unit_id FROM society_memberships WHERE user_id = $1', [user]);
  return { user, unitId: rows[0].unit_id };
}

before(async () => {
  db = await createDb();
  const a = await setupSociety('admin-a@example.com', 'Society A');
  const b = await setupSociety('admin-b@example.com', 'Society B');
  const r1 = await addResident('r1@example.com', a.societyId, a.admin, '101');
  const r2 = await addResident('r2@example.com', a.societyId, a.admin, '102');
  ctx = { a, b, r1, r2 };
});

test('admins only see their own society', async () => {
  const names = await asUser(db, ctx.a.admin, async (tx) => (await tx.query('SELECT name FROM societies')).rows.map((r) => r.name));
  assert.deepEqual(names, ['Society A']);
  const units = await asUser(db, ctx.a.admin, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM units WHERE society_id = $1', [ctx.b.societyId])).rows[0].n);
  assert.equal(units, 0);
});

test('society admin can read member profiles, residents cannot read each other', async () => {
  const seen = await asUser(db, ctx.a.admin, async (tx) => (await tx.query('SELECT email FROM profiles ORDER BY email')).rows.map((r) => r.email));
  assert.deepEqual(seen, ['admin-a@example.com', 'r1@example.com', 'r2@example.com']);
  const residentSees = await asUser(db, ctx.r1.user, async (tx) => (await tx.query('SELECT email FROM profiles')).rows.map((r) => r.email));
  assert.deepEqual(residentSees, ['r1@example.com']);
});

test('residents can read society_settings (UPI) of their own society only', async () => {
  const own = await asUser(db, ctx.r1.user, async (tx) => (await tx.query('SELECT society_id FROM society_settings')).rows);
  assert.equal(own.length, 1);
  assert.equal(own[0].society_id, ctx.a.societyId);
});

test('resident can submit a pending payment for own unit', async () => {
  await asUser(db, ctx.r1.user, (tx) =>
    tx.query(
      `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, status)
       VALUES ($1, $2, $3, 'PAY-OK1', 3500, '123456789012', 'pending_verification')`,
      [ctx.a.societyId, ctx.r1.unitId, ctx.r1.user]
    )
  );
});

test('resident cannot self-verify a payment', async () => {
  await assert.rejects(
    asUser(db, ctx.r1.user, (tx) =>
      tx.query(
        `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, status)
         VALUES ($1, $2, $3, 'PAY-BAD1', 3500, '123456789013', 'verified')`,
        [ctx.a.societyId, ctx.r1.unitId, ctx.r1.user]
      )
    ),
    /row-level security/
  );
});

test("resident cannot pay against another resident's unit", async () => {
  await assert.rejects(
    asUser(db, ctx.r1.user, (tx) =>
      tx.query(
        `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, status)
         VALUES ($1, $2, $3, 'PAY-BAD2', 100, '123456789014', 'pending_verification')`,
        [ctx.a.societyId, ctx.r2.unitId, ctx.r1.user]
      )
    ),
    /row-level security/
  );
});

test('resident cannot verify payments via UPDATE', async () => {
  const updated = await asUser(db, ctx.r1.user, async (tx) => {
    const r = await tx.query(`UPDATE payments SET status = 'verified' WHERE payment_number = 'PAY-OK1'`);
    return r.affectedRows;
  });
  assert.equal(updated, 0);
});

test('complaints: resident can raise and edit text but not change status', async () => {
  // ticket_number is assigned by the database (client value is ignored)
  const ticket = await asUser(db, ctx.r1.user, async (tx) =>
    (await tx.query(
      `INSERT INTO complaints (society_id, unit_id, user_id, ticket_number, title, description)
       VALUES ($1, $2, $3, 'IGNORED', 'Leak', 'Bathroom leak') RETURNING ticket_number`,
      [ctx.a.societyId, ctx.r1.unitId, ctx.r1.user]
    )).rows[0].ticket_number
  );
  assert.equal(ticket, 'TKT-0001');
  await asUser(db, ctx.r1.user, (tx) => tx.query(`UPDATE complaints SET description = 'Bathroom ceiling leak' WHERE ticket_number = $1`, [ticket]));
  await assert.rejects(
    asUser(db, ctx.r1.user, (tx) => tx.query(`UPDATE complaints SET status = 'closed' WHERE ticket_number = $1`, [ticket])),
    /Only the society committee/
  );
  await asUser(db, ctx.a.admin, (tx) => tx.query(`UPDATE complaints SET status = 'in_progress' WHERE ticket_number = $1`, [ticket]));
  const { rows } = await db.query(`SELECT status, description FROM complaints WHERE ticket_number = $1`, [ticket]);
  assert.deepEqual(rows[0], { status: 'in_progress', description: 'Bathroom ceiling leak' });
});

test('clients cannot forge audit logs', async () => {
  await assert.rejects(
    asUser(db, ctx.r1.user, (tx) =>
      tx.query(
        `INSERT INTO audit_logs (society_id, user_id, action, entity_type, entity_id) VALUES ($1, $2, 'fake', 'x', '1')`,
        [ctx.a.societyId, ctx.r1.user]
      )
    ),
    /row-level security/
  );
});

test('resident cannot promote themselves to platform admin', async () => {
  const r = await asUser(db, ctx.r1.user, async (tx) => {
    try {
      await tx.query('UPDATE profiles SET is_platform_admin = true WHERE id = $1', [ctx.r1.user]);
    } catch (err) {
      return err.message;
    }
    return 'updated';
  });
  const { rows } = await db.query('SELECT is_platform_admin FROM profiles WHERE id = $1', [ctx.r1.user]);
  assert.equal(rows[0].is_platform_admin, false, `escalation must not persist (got: ${r})`);
});

test('resident cannot grant themselves committee role', async () => {
  const affected = await asUser(db, ctx.r1.user, async (tx) =>
    (await tx.query(`UPDATE society_memberships SET role = 'society_admin' WHERE user_id = $1`, [ctx.r1.user])).affectedRows
  );
  assert.equal(affected, 0);
});
