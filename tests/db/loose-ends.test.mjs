// 038: loose ends — mobiles with a 0 after +91, waiting requests and invites that close themselves,
// the CA's receiving bank on bills, and no notifications from a closed society.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser, applyMigration } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

before(async () => {
  db = await createDb();
  await db.exec('CREATE SCHEMA IF NOT EXISTS extensions; ALTER EXTENSION pgcrypto SET SCHEMA extensions;');
  const secretary = await createUser(db, 'sec@loose.test');
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Loose Ends','Road','Pune','Maharashtra','411001','sec@loose.test','9876543210') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }, { unit_number: '102' }, { unit_number: '103' }, { unit_number: '104' }])]);
    await tx.query(`INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Maintenance','flat_per_unit',1000)`, [id]);
    return id;
  });
  const unit = async (n) => (await db.query('SELECT id FROM units WHERE society_id=$1 AND unit_number=$2', [societyId, n])).rows[0].id;
  ids = { societyId, secretary, u101: await unit('101'), u102: await unit('102'), u103: await unit('103'), u104: await unit('104') };
});

// ---------------------------------------------------------------- 1. mobiles
test('normalize_mobile drops the 0 after +91', async () => {
  const n = async (m) => (await db.query('SELECT public.normalize_mobile($1) AS v', [m])).rows[0].v;
  for (const m of ['+91 0 98765 43210', '0091 098765 43210', '+91 (0) 98765-43210', '0091 98765 43210', '98765 43210']) {
    assert.equal(await n(m), '919876543210', m);
  }
  assert.equal(await n('+44 7700 900123'), '447700900123');
});

test('mobiles stored by the old rule are rewritten', async () => {
  // the old normalize_mobile kept "+91 0 98765 43210" as 13 digits
  await db.query(`INSERT INTO unit_owner_contacts (society_id, unit_id, owner_name, owner_mobile) VALUES ($1,$2,'Old Shape','9109876543211')
                  ON CONFLICT (unit_id) DO UPDATE SET owner_mobile = EXCLUDED.owner_mobile`, [ids.societyId, ids.u104]);
  await applyMigration(db, '038_loose_ends.sql');
  assert.equal((await one('SELECT owner_mobile FROM unit_owner_contacts WHERE unit_id=$1', [ids.u104])).owner_mobile, '919876543211');
  await db.query('DELETE FROM unit_owner_contacts WHERE unit_id=$1', [ids.u104]);
});
