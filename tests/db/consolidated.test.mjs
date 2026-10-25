import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb, migrationFiles } from './harness.mjs';

test('ALL_MIGRATIONS_CONSOLIDATED.sql contains every migration and applies on a fresh DB', async () => {
  const consolidated = readFileSync(new URL('../../src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql', import.meta.url), 'utf8');
  for (const file of migrationFiles()) {
    const body = readFileSync(new URL(`../../src/db/migrations/${file}`, import.meta.url), 'utf8');
    assert.ok(consolidated.includes(body), `${file} is missing or out of date in the consolidated file — regenerate it`);
  }

  const db = await createDb({ consolidated: true });
  const { rows } = await db.query(
    `SELECT proname FROM pg_proc WHERE proname IN ('create_society', 'bulk_upsert_units', 'claim_my_invites', 'generate_bills', 'verify_payment', 'apply_late_fees') ORDER BY proname`
  );
  assert.deepEqual(rows.map((r) => r.proname), ['apply_late_fees', 'bulk_upsert_units', 'claim_my_invites', 'create_society', 'generate_bills', 'verify_payment']);
});
