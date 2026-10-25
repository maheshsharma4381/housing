// scripts/db-migrate.mjs against a real Postgres wire connection (PGlite socket server),
// starting from a database that already has 001-005 applied by hand (like the hosted project).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createDb, migrationFiles } from './harness.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../scripts/db-migrate.mjs', import.meta.url));
const PORT = 54329;
let server;

after(async () => {
  await server?.stop();
});

const migrate = (...args) =>
  run(process.execPath, [script, ...args], {
    env: { ...process.env, SUPABASE_DB_URL: `postgresql://postgres:postgres@localhost:${PORT}/postgres` },
  }).then(({ stdout }) => stdout, (err) => { err.message += `\n${err.stdout}\n${err.stderr}`; throw err; });

test('runner baselines a hand-migrated DB, applies only pending files, and is idempotent', async () => {
  const db = await createDb({ upTo: '005' });
  server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1' });
  await server.start();

  const pending = migrationFiles().filter((f) => f.slice(0, 3) > '005');
  const dry = await migrate('--baseline', '005');
  assert.match(dry, /Baseline recorded up to 005/);
  assert.ok(dry.includes(`Pending (${pending.length}): ${pending.join(', ')}`), dry);
  assert.match(dry, /Dry run only/);

  const out = await migrate('--apply');
  for (const f of pending) {
    assert.ok(out.includes(`Applying ${f} ... ok`), out);
  }

  const { rows } = await db.query('SELECT name FROM public._sahvaas_migrations ORDER BY name');
  assert.deepEqual(rows.map((r) => r.name), migrationFiles());
  const tables = await db.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('payment_allocations', 'audit_remarks', 'expense_approvals')`);
  assert.equal(tables.rows[0].n, 3);

  assert.match(await migrate('--apply'), /Database is up to date/);
});
