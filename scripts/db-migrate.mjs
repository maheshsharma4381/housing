#!/usr/bin/env node
// Applies pending numbered migrations to a Postgres database (e.g. hosted Supabase).
//
//   SUPABASE_DB_URL=postgresql://... node scripts/db-migrate.mjs            -> show pending (dry run)
//   SUPABASE_DB_URL=postgresql://... node scripts/db-migrate.mjs --apply    -> apply them
//   ... --baseline 005   mark 001..005 as already applied (DBs set up by pasting SQL manually)
//
// SUPABASE_DB_URL may also live in .env.local (gitignored). Use the *Session pooler* URI from
// Supabase → Project Settings → Database → Connection string. Never commit it.
//
// Each migration runs in its own transaction; the run stops at the first failure.
// Applied files are recorded in public._sahvaas_migrations (name + sha256).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'src/db/migrations');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const baselineIdx = args.indexOf('--baseline');
const baseline = baselineIdx > -1 ? args[baselineIdx + 1] : null;

function dbUrl() {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  const envFile = join(root, '.env.local');
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/^SUPABASE_DB_URL\s*=\s*"?([^"\r\n]+)"?/m);
    if (m) return m[1];
  }
  return null;
}

const url = dbUrl();
if (!url) {
  console.error('SUPABASE_DB_URL is not set (env var or .env.local).');
  process.exit(1);
}
if (baseline && !/^\d{3}$/.test(baseline)) {
  console.error('--baseline needs a 3-digit migration number, e.g. --baseline 005');
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
const sha = (s) => createHash('sha256').update(s).digest('hex');

const client = new pg.Client({ connectionString: url, ssl: url.includes('localhost') ? false : { rejectUnauthorized: false } });
await client.connect();
try {
  const host = new URL(url).host;
  console.log(`Connected to ${host}`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS public._sahvaas_migrations (
      name TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE public._sahvaas_migrations ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public._sahvaas_migrations FROM PUBLIC;
  `);

  if (baseline) {
    for (const f of files.filter((x) => x.slice(0, 3) <= baseline)) {
      await client.query(
        'INSERT INTO public._sahvaas_migrations (name, sha256) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
        [f, sha(readFileSync(join(dir, f), 'utf8'))]
      );
    }
    console.log(`Baseline recorded up to ${baseline}.`);
  }

  const applied = new Map((await client.query('SELECT name, sha256 FROM public._sahvaas_migrations')).rows.map((r) => [r.name, r.sha256]));
  for (const [name, hash] of applied) {
    const f = files.find((x) => x === name);
    if (f && sha(readFileSync(join(dir, f), 'utf8')) !== hash) console.warn(`! ${name} changed after it was applied (not re-run).`);
  }

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log('Database is up to date.');
  } else if (!apply) {
    console.log(`Pending (${pending.length}): ${pending.join(', ')}`);
    console.log('Dry run only. Re-run with --apply to execute.');
  } else {
    for (const f of pending) {
      const sql = readFileSync(join(dir, f), 'utf8');
      process.stdout.write(`Applying ${f} ... `);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO public._sahvaas_migrations (name, sha256) VALUES ($1, $2)', [f, sha(sql)]);
        await client.query('COMMIT');
        console.log('ok');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.log('FAILED');
        console.error(`  ${err.message}${err.position ? ` (at character ${err.position})` : ''}`);
        process.exitCode = 1;
        break;
      }
    }
  }
} finally {
  await client.end();
}
