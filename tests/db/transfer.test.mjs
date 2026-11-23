// 043: sale and transfer of a flat (Phase 11D).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
const ids = {};

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const fails = async (promise, message) => assert.rejects(promise, (e) => { assert.ok(e.message.includes(message), `expected "${message}", got "${e.message}"`); return true; });
const member = async (email, role, unit, name) => {
  const id = await createUser(db, email, { fullName: name ?? email.split('@')[0] });
  await db.query('INSERT INTO society_memberships (society_id, user_id, role, unit_id) VALUES ($1,$2,$3,$4)', [ids.soc, id, role, unit]);
  return id;
};
const isoDays = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const journalFor = async (type, id) => (await db.query(
  `SELECT a.code, sum(l.amount)::numeric AS amount FROM ledger_entries l JOIN journal_entries j ON j.id = l.journal_entry_id
   JOIN accounts a ON a.id = l.account_id WHERE j.reference_event_type=$1 AND j.reference_event_id=$2 GROUP BY a.code ORDER BY a.code`, [type, id])).rows
  .map((r) => [r.code, Number(r.amount)]);
const dues = async (unit) => Number((await db.query('SELECT public.flat_dues_on($1, current_date + 30) AS d', [unit])).rows[0].d);

before(async () => {
  db = await createDb();
  await db.exec('CREATE SCHEMA IF NOT EXISTS extensions; ALTER EXTENSION pgcrypto SET SCHEMA extensions;');
  ids.sec = await createUser(db, 'sec@transfer.test', { fullName: 'Secretary' });
  ids.soc = await asUser(db, ids.sec, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Lake View CHS','4 Lake Road','Pune','Maharashtra','411004','sec@transfer.test','9876500300') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([
      { unit_number: '101', wing: 'A' }, { unit_number: '102', wing: 'A' }, { unit_number: '103', wing: 'A' },
      { unit_number: '104', wing: 'A' }, { unit_number: '101', wing: 'B' }])]);
    return id;
  });
  for (const n of ['101', '102', '103', '104']) {
    ids[`u${n}`] = (await db.query(`SELECT u.id FROM units u JOIN wings w ON w.id=u.wing_id WHERE u.society_id=$1 AND u.unit_number=$2 AND w.name='A'`, [ids.soc, n])).rows[0].id;
  }
  ids.owner = await member('asha@transfer.test', 'resident_owner', ids.u101, 'Asha Patil');
  ids.owner2 = await member('bina@transfer.test', 'resident_owner', ids.u102, 'Bina Shah');
  ids.tenant = await member('tara@transfer.test', 'resident_tenant', ids.u101, 'Tara Rao');
  ids.committee = await member('cm@transfer.test', 'committee_member', ids.u103, 'Committee Member');
  ids.owner4 = await member('dev@transfer.test', 'resident_owner', ids.u104, 'Dev Kale');
});

// ---------------------------------------------------------------- 1. ledgers, settings, checklist
test('transfer ledgers and charges', async () => {
  const bill = (await db.query('SELECT public.charge_flat($1,$2,$3) AS id', [ids.u102, JSON.stringify([
    { rule_key: 'transfer_fee', description: 'Transfer fee', amount: 500 },
    { rule_key: 'transfer_premium', description: 'Transfer premium', amount: 20000 }]), isoDays(7)])).rows[0].id;
  const accounts = (await db.query(`SELECT code, name, type FROM accounts WHERE society_id=$1 AND code IN ('4600','4700') ORDER BY code`, [ids.soc])).rows;
  assert.deepEqual(accounts.map((a) => [a.code, a.name, a.type]), [['4600', 'Transfer fees', 'income'], ['4700', 'Transfer premium', 'income']]);
  assert.deepEqual(await journalFor('bill.issued', bill), [['1200', 20500], ['4600', -500], ['4700', -20000]]);
  await q(ids.sec, `SELECT public.cancel_bill($1,'test charge')`, [bill]);
});

test('transfer settings', async () => {
  const row = async () => (await db.query('SELECT transfer_fee::numeric f, transfer_premium::numeric p, shifting_required r FROM society_settings WHERE society_id=$1', [ids.soc])).rows[0];
  const d = await row();
  assert.deepEqual([Number(d.f), Number(d.p), d.r], [500, 0, false]);
  const s = (o) => q(ids.sec, 'SELECT public.set_transfer_settings($1,$2)', [ids.soc, JSON.stringify(o)]);
  await fails(q(ids.owner, 'SELECT public.set_transfer_settings($1,$2)', [ids.soc, '{}']), 'Only the committee can change this');
  await fails(q(ids.committee, 'SELECT public.set_transfer_settings($1,$2)', [ids.soc, '{}']), 'Only the committee can change this');
  await fails(s({ transfer_premium: 25001 }), 'The transfer premium can be at most ₹25,000');
  await fails(s({ transfer_fee: -1 }), 'Amounts must be between ₹0 and ₹1,00,000');
  await fails(s({ transfer_fee: 'abc' }), 'Amounts must be between ₹0 and ₹1,00,000');
  await s({ transfer_premium: 25000 });
  await s({ transfer_fee: 1000 });
  const a = await row();
  assert.deepEqual([Number(a.f), Number(a.p), a.r], [1000, 25000, false]);
  await s({ shifting_required: true });
  assert.equal((await row()).r, true);
  await s({ transfer_fee: 500, transfer_premium: 0, shifting_required: false });
});

test('every society has the transfer checklist', async () => {
  const items = async (soc) => (await db.query(`SELECT checklist FROM request_checklists WHERE society_id=$1 AND kind='transfer'`, [soc])).rows[0]?.checklist ?? [];
  const c = await items(ids.soc);
  assert.equal(c.length, 9);
  assert.equal(c.filter((i) => i.required).length, 7);
  assert.deepEqual(c.map((i) => i.key), ['notice', 'membership', 'deed', 'index2', 'loan', 'buyer_id', 'buyer_photo', 'buyer_pan', 'nomination']);
  // a society from before 043 gets it from the backfill, which keeps a list the committee already changed
  await db.query(`DELETE FROM request_checklists WHERE society_id=$1 AND kind='transfer'`, [ids.soc]);
  await db.query(`UPDATE request_checklists SET checklist='[]' WHERE society_id=$1 AND kind='tenancy'`, [ids.soc]);
  await db.query('SELECT public.seed_request_checklists($1)', [ids.soc]);
  assert.equal((await items(ids.soc)).length, 9);
  assert.equal((await db.query(`SELECT jsonb_array_length(checklist) n FROM request_checklists WHERE society_id=$1 AND kind='tenancy'`, [ids.soc])).rows[0].n, 0);
  await db.query(`DELETE FROM request_checklists WHERE society_id=$1 AND kind='tenancy'`, [ids.soc]);
  await db.query('SELECT public.seed_request_checklists($1)', [ids.soc]);
});
