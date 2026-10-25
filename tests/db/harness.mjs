// In-process Postgres (PGlite) harness that mimics the parts of Supabase our
// migrations rely on: the `auth` schema, auth.uid()/auth.jwt(), and the
// `authenticated` role with Supabase-style default grants.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations');

const SUPABASE_STUB = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (
    id UUID PRIMARY KEY,
    email TEXT,
    phone TEXT,
    raw_user_meta_data JSONB DEFAULT '{}'::jsonb,
    email_confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  CREATE FUNCTION auth.jwt() RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  $$;
  -- Minimal Supabase Storage schema (buckets, objects with RLS, foldername helper)
  CREATE SCHEMA storage;
  CREATE TABLE storage.buckets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    public BOOLEAN DEFAULT false,
    file_size_limit BIGINT,
    allowed_mime_types TEXT[],
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE storage.objects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id TEXT REFERENCES storage.buckets(id),
    name TEXT,
    owner UUID,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (bucket_id, name)
  );
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE FUNCTION storage.foldername(name TEXT) RETURNS TEXT[] LANGUAGE plpgsql IMMUTABLE AS $$
  DECLARE _parts TEXT[];
  BEGIN
    _parts := string_to_array(name, '/');
    RETURN _parts[1:array_length(_parts, 1) - 1];
  END $$;
  GRANT USAGE ON SCHEMA storage TO anon, authenticated;
  GRANT ALL ON storage.objects TO anon, authenticated;
  GRANT SELECT ON storage.buckets TO anon, authenticated;
  GRANT EXECUTE ON FUNCTION storage.foldername(TEXT) TO anon, authenticated;

  GRANT USAGE ON SCHEMA auth TO anon, authenticated;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated;
  GRANT USAGE ON SCHEMA public TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
`;

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.consolidated] apply ALL_MIGRATIONS_CONSOLIDATED.sql instead of the individual files
 * @param {string} [opts.upTo] only apply migrations whose 3-digit prefix is <= this (e.g. '006')
 */
export async function createDb({ consolidated = false, upTo } = {}) {
  const db = new PGlite({ extensions: { uuid_ossp, pgcrypto } });
  await db.exec(SUPABASE_STUB);
  const files = consolidated
    ? ['ALL_MIGRATIONS_CONSOLIDATED.sql']
    : migrationFiles().filter((f) => !upTo || f.slice(0, 3) <= upTo);
  for (const file of files) {
    await applyMigration(db, file);
  }
  return db;
}

export async function applyMigration(db, file) {
  try {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  } catch (err) {
    throw new Error(`Migration ${file} failed: ${err.message}`);
  }
}

/** Create an auth user (fires the handle_new_user trigger, like Supabase signup). */
export async function createUser(db, email, { confirmed = true, fullName } = {}) {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at)
     VALUES ($1, $2, $3, $4)`,
    [id, email, { full_name: fullName ?? email.split('@')[0] }, confirmed ? new Date().toISOString() : null]
  );
  return id;
}

/**
 * Run `fn(tx)` as the given user under the `authenticated` role, so RLS applies.
 * Everything runs in a transaction that is committed unless fn throws.
 */
export async function asUser(db, userId, fn) {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query('SELECT email FROM auth.users WHERE id = $1', [userId]);
    const claims = JSON.stringify({ sub: userId, email: rows[0]?.email, role: 'authenticated' });
    await tx.query(`SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [userId, claims]);
    await tx.exec('SET LOCAL ROLE authenticated');
    return fn(tx);
  });
}

/** Run as superuser (bypasses RLS) for fixtures. */
export async function asAdmin(db, fn) {
  return db.transaction(async (tx) => fn(tx));
}
