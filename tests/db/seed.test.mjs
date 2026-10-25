import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, createUser, asUser } from './harness.mjs';

test('demo seed builds a complete demo society visible to the seeding user', async () => {
  const db = await createDb();
  const uid = await createUser(db, 'demo.secretary@example.com');
  const seed = readFileSync(new URL('../../src/db/seed/demo_seed.sql', import.meta.url), 'utf8')
    .replace("'you@example.com'", "'demo.secretary@example.com'");
  await db.exec(seed);

  await asUser(db, uid, async (tx) => {
    const counts = await tx.query(`
      SELECT
        (SELECT total_units FROM societies) AS total_units,
        (SELECT count(*)::int FROM units) AS units,
        (SELECT count(*)::int FROM society_memberships WHERE user_id = $1) AS memberships,
        (SELECT count(*)::int FROM bills WHERE user_id = $1) AS bills,
        (SELECT count(*)::int FROM notices) AS notices,
        (SELECT count(*)::int FROM expenses WHERE status = 'pending_approval') AS pending_expenses,
        (SELECT upi_id FROM society_settings) AS upi_id
    `, [uid]);
    assert.deepEqual(counts.rows[0], {
      total_units: 32, units: 32, memberships: 2, bills: 1, notices: 2, pending_expenses: 1,
      upi_id: 'palmheights.demo@icici',
    });
  });
});

test('demo seed fails clearly when the user has not signed up', async () => {
  const db = await createDb();
  const seed = readFileSync(new URL('../../src/db/seed/demo_seed.sql', import.meta.url), 'utf8');
  await assert.rejects(db.exec(seed), /Sign up in the app first/);
});
