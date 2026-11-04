// 028: an asset type is any active ledger under Fixed Assets (except Accumulated Depreciation), with its own
// depreciation rate; asset sale money goes to the bank the CA chooses.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';
import { inviteProfessional } from './opening-helpers.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const groupId = async (key) => (await db.query(`SELECT id FROM account_groups WHERE society_id=$1 AND system_key=$2`, [ids.societyId, key])).rows[0].id;
const ledgerId = async (code) => (await db.query(`SELECT id FROM accounts WHERE society_id=$1 AND code=$2`, [ids.societyId, code])).rows[0].id;
const CA_PRESET = ['view_reports', 'view_ledger', 'view_expenses', 'audit_gst', 'view_bills', 'view_payments', 'view_documents', 'manage_accounts'];

let billNo = 0;
/** The treasurer records a bill, the secretary approves it. */
async function approveBill(fields) {
  billNo += 1;
  const row = { vendor_id: ids.vendor, tds_amount: 0, invoice_number: `AL-${billNo}`, invoice_date: '2026-10-15', ...fields };
  const cols = Object.keys(row);
  const id = await val(ids.treasurer, `INSERT INTO expenses (society_id, ${cols.join(', ')})
    VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`, [ids.societyId, ...Object.values(row)]);
  await q(ids.secretary, 'SELECT public.decide_expense($1, true)', [id]);
  return id;
}

before(async () => {
  db = await createDb();
  const secretary = await createUser(db, 'sec@assets.test');
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Asset Heights','Road','Pune','Maharashtra','411001','sec@assets.test','9876543210') AS id`)).rows[0].id;
    await tx.query('UPDATE society_settings SET require_two_step_expense_approval = false WHERE society_id = $1', [id]);
    await tx.query(`INSERT INTO member_invites (society_id,email,role,invited_by) VALUES ($1,'tre@assets.test','treasurer',$2)`, [id, secretary]);
    return id;
  });
  const treasurer = await createUser(db, 'tre@assets.test');
  await asUser(db, treasurer, (tx) => tx.query('SELECT public.claim_my_invites()'));
  const ca = await inviteProfessional(db, { societyId, inviter: secretary, email: 'ca@assets.test', permissions: CA_PRESET });
  const vendor = (await db.query(`INSERT INTO vendors (society_id, name, phone, pan) VALUES ($1,'Surya Solar','9000000000','ABCPS1234K') RETURNING id`,
    [societyId])).rows[0].id;
  ids = { societyId, secretary, treasurer, ca, vendor };
});

test('the CA adds an asset type with its own depreciation rate', async () => {
  ids.solar = await val(ids.ca, `SELECT public.add_asset_ledger($1,'Solar Panels',25)`, [ids.societyId]);
  const list = await val(ids.ca, 'SELECT public.asset_ledgers($1)', [ids.societyId]);
  const solar = list.find((l) => l.code === ids.solar);
  assert.deepEqual([solar.name, Number(solar.dep_rate)], ['Solar Panels', 25]);
  assert.equal(Number(list.find((l) => l.code === '1530').dep_rate), 40);
  assert.ok(!list.some((l) => l.code === '1590'));
  await assert.rejects(q(ids.secretary, `SELECT public.set_ledger_dep_rate($1,$2,10)`, [ids.societyId, ids.solar]), /Only the society's CA or accountant/);
  await assert.rejects(q(ids.ca, `SELECT public.set_ledger_dep_rate($1,'5000',10)`, [ids.societyId]), /Choose a fixed-asset ledger/);
  await assert.rejects(q(ids.ca, `SELECT public.set_ledger_dep_rate($1,$2,120)`, [ids.societyId, ids.solar]), /between 0 and 100/);
  assert.match(await val(ids.ca, `SELECT public.create_ledger($1,$2,'Gym Equipment')`, [ids.societyId, await groupId('fixed_assets')]), /\w/);
});

test('an asset on a new type takes its rate; bills and capitalisation accept the type', async () => {
  const a = await val(ids.ca, `SELECT public.add_existing_asset($1,'Rooftop solar',$2,'2024-01-01',300000,250000,'2025-04-01')`, [ids.societyId, ids.solar]);
  assert.equal(Number((await db.query('SELECT dep_rate FROM fixed_assets WHERE id=$1', [a])).rows[0].dep_rate), 25);
  const bill = await approveBill({ category: 'electrical', title: 'Inverter', subtotal: 40000, expense_type: 'capital', asset_account_code: ids.solar });
  const debit = (await db.query(`SELECT a.code FROM journal_entries j JOIN ledger_entries l ON l.journal_entry_id=j.id JOIN accounts a ON a.id=l.account_id
    WHERE j.reference_event_type='expense.approved' AND j.reference_event_id=$1 AND l.amount > 0`, [bill])).rows.map((r) => r.code);
  assert.deepEqual(debit, [ids.solar]);
  assert.equal(Number((await db.query('SELECT dep_rate FROM fixed_assets WHERE expense_id=$1', [bill])).rows[0].dep_rate), 25);
  const repair = await approveBill({ category: 'repairs', title: 'Panel frame', subtotal: 9000 });
  await q(ids.ca, `SELECT public.propose_capitalisation($1,$2,'Frame is part of the solar plant')`, [repair, ids.solar]);
});

test('accumulated depreciation and inactive ledgers are not asset types', async () => {
  for (const code of ['1590', '5000']) {
    await assert.rejects(q(ids.ca, `SELECT public.add_existing_asset($1,'Pump',$2,'2024-01-01',1000,500,'2025-04-01')`, [ids.societyId, code]), /Pick an asset type/);
  }
  const gym = (await db.query(`SELECT code FROM accounts WHERE society_id=$1 AND name='Gym Equipment'`, [ids.societyId])).rows[0].code;
  await q(ids.ca, `SELECT public.set_ledger_active($1,$2,false)`, [ids.societyId, gym]);
  await assert.rejects(approveBill({ category: 'other', title: 'Treadmill', subtotal: 50000, expense_type: 'capital', asset_account_code: gym }),
    /Pick an asset type for a purchase booked as an asset/);
});
