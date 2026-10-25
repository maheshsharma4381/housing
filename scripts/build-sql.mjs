#!/usr/bin/env node
// Builds SQL bundles from the numbered migrations.
//   node scripts/build-sql.mjs                 -> regenerates src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql
//   node scripts/build-sql.mjs --from 006      -> also writes sql-bundles/upgrade_006_to_<last>.sql
//                                                 (for a database that already has the earlier files)
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'src/db/migrations');
const files = readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();

const header = (title, list) =>
  [
    '-- ============================================================================',
    `-- SAHVAAS: ${title} (${list.map((f) => f.slice(0, 3)).join(' + ')})`,
    '-- Generated from the individual files - edit those, then regenerate this file.',
    '-- ============================================================================',
    '',
    '',
  ].join('\n');

const bundle = (list) => list.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n\n');

const consolidated = header('ALL MIGRATIONS CONSOLIDATED', files).replace(
  '-- ============================================================================\n\n',
  '-- Run once on a FRESH Supabase project (SQL Editor).\n-- ============================================================================\n\n'
) + bundle(files);
writeFileSync(join(dir, 'ALL_MIGRATIONS_CONSOLIDATED.sql'), consolidated);
console.log(`ALL_MIGRATIONS_CONSOLIDATED.sql <- ${files.join(', ')}`);

const fromIdx = process.argv.indexOf('--from');
if (fromIdx > -1) {
  const from = process.argv[fromIdx + 1];
  if (!/^\d{3}$/.test(from ?? '')) throw new Error('--from needs a 3-digit migration number, e.g. --from 006');
  const list = files.filter((f) => f.slice(0, 3) >= from);
  if (list.length === 0) throw new Error(`No migrations at or after ${from}`);
  const outDir = join(root, 'sql-bundles');
  mkdirSync(outDir, { recursive: true });
  const name = `upgrade_${from}_to_${list.at(-1).slice(0, 3)}.sql`;
  writeFileSync(join(outDir, name), header(`UPGRADE BUNDLE — run in SQL Editor on a DB that already has migrations before ${from}`, list) + bundle(list));
  console.log(`sql-bundles/${name} <- ${list.join(', ')}`);
}
