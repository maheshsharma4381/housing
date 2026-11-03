// 024: bill types. The secretary picks a type; the CA maps each type to a ledger; TDS follows the type,
// and "Other" bills take their TDS type from one plain question.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const one = async (user, sql, params = []) => (await q(user, sql, params))[0];
const val = async (user, sql, params = []) => Object.values(await one(user, sql, params))[0];
const groupId = async (key) => (await db.query(
  `SELECT id FROM account_groups WHERE society_id=$1 AND system_key=$2`, [ids.societyId, key])).rows[0].id;
const types = (user = ids.secretary) => val(user, 'SELECT public.bill_types($1)', [ids.societyId]);
const setType = (user, key, label, code, nature) => val(user, 'SELECT public.set_bill_type($1,$2,$3,$4,$5)',
  [ids.societyId, key, label, code, nature]);

async function inviteProfessional(email, permissions) {
  const user = await createUser(db, email);
  const inv = (await asUser(db, ids.secretary, (tx) => tx.query(
    `INSERT INTO professional_invites (society_id, invited_email, role, permissions, invited_by, expires_at)
     VALUES ($1,$2,'ca',$3,$4, now() + interval '7 days') RETURNING id`,
    [ids.societyId, email, JSON.stringify(permissions), ids.secretary]))).rows[0].id;
  await asUser(db, user, (tx) => tx.query(`SELECT public.respond_to_invite('professional',$1,true)`, [inv]));
  return user;
}

let billNo = 0;
/** The treasurer records a bill, the secretary approves it; dated `dateSql` (an SQL date expression). */
async function approveBill(category, subtotal, dateSql = 'current_date') {
  billNo += 1;
  const id = await val(ids.treasurer, `INSERT INTO expenses (society_id, vendor_id, category, title, subtotal, tds_amount, invoice_number, invoice_date)
    VALUES ($1,$2,$3,'Bill ' || $4,$5,0,'INV-' || $4, ${dateSql}) RETURNING id`, [ids.societyId, ids.vendor, category, billNo, subtotal]);
  await q(ids.secretary, 'SELECT public.decide_expense($1, true)', [id]);
  return id;
}
const debitCodes = async (expenseId) => (await db.query(
  `SELECT a.code FROM journal_entries j JOIN ledger_entries l ON l.journal_entry_id = j.id JOIN accounts a ON a.id = l.account_id
   WHERE j.reference_event_type = 'expense.approved' AND j.reference_event_id = $1 AND a.type = 'expense'`, [expenseId])).rows.map((r) => r.code);
const thisYear = async (code) => Number((await db.query(
  `SELECT coalesce(sum(l.amount),0) b FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
   WHERE l.society_id = $1 AND a.code = $2 AND l.date >= fy_start_of(current_date)`, [ids.societyId, code])).rows[0].b);

before(async () => {
  db = await createDb();
  const secretary = await createUser(db, 'sec@billtype.test');
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Billtype Heights','Road','Pune','Maharashtra','411001','sec@billtype.test','9876543210') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }])]);
    await tx.query('UPDATE society_settings SET require_two_step_expense_approval = false WHERE society_id = $1', [id]);
    await tx.query(`INSERT INTO member_invites (society_id,email,role,unit_id,invited_by)
      SELECT $1,'res@billtype.test','resident_owner',id,$2 FROM units WHERE society_id=$1 AND unit_number='101'`, [id, secretary]);
    await tx.query(`INSERT INTO member_invites (society_id,email,role,invited_by) VALUES ($1,'tre@billtype.test','treasurer',$2)`, [id, secretary]);
    return id;
  });
  const resident = await createUser(db, 'res@billtype.test');
  const treasurer = await createUser(db, 'tre@billtype.test');
  for (const u of [resident, treasurer]) await asUser(db, u, (tx) => tx.query('SELECT public.claim_my_invites()'));
  ids = { societyId, secretary, resident, treasurer };
  ids.ca = await inviteProfessional('ca@billtype.test', ['view_reports', 'manage_accounts']);
  ids.vendor = (await db.query(`INSERT INTO vendors (society_id, name, phone, pan) VALUES ($1,'Shiv Lifts','9000000000','ABCPP1234K') RETURNING id`,
    [societyId])).rows[0].id;
});

test('the committee sees one list of bill types', async () => {
  const list = await types();
  assert.equal(list.length, 23);
  assert.equal(new Set(list.map((t) => t.key)).size, 23);
  const lift = list.find((t) => t.key === 'lift_amc');
  assert.deepEqual([lift.account_code, lift.ledger_name, lift.tds_nature, lift.is_custom], ['5000', 'Repairs & Maintenance', 'contract', false]);
  await assert.rejects(types(ids.resident), /do not have access/);
});

test('only the CA maps a bill type, only to an active expense ledger; new bills follow the mapping', async () => {
  await assert.rejects(q(ids.secretary, `INSERT INTO expense_categories (society_id, key, label, account_code, tds_nature)
    VALUES ($1,'lift_amc','Lift AMC','5900','contract')`, [ids.societyId]), /row-level security/);
  await assert.rejects(setType(ids.secretary, 'lift_amc', 'Lift AMC', '5900', 'contract'), /Only the society's CA or accountant/);

  ids.earlier = await approveBill('lift_amc', 12000);
  assert.deepEqual(await debitCodes(ids.earlier), ['5000']);
  ids.lastYear = await approveBill('lift_amc', 3000, 'fy_start_of(current_date) - 10');
  assert.deepEqual(await debitCodes(ids.lastYear), ['5000']);
  ids.repairs = await approveBill('repairs', 4000);
  assert.deepEqual(await debitCodes(ids.repairs), ['5000']);

  assert.equal(await val(ids.ca, `SELECT public.create_ledger($1,$2,'Lift AMC')`, [ids.societyId, await groupId('expenses')]), '5C001');
  assert.equal(await setType(ids.ca, 'lift_amc', 'Lift AMC', '5C001', 'contract'), 'lift_amc');
  await assert.rejects(setType(ids.ca, 'lift_amc', 'Lift AMC', '4000', 'contract'), /active expense ledger/);
  await assert.rejects(setType(ids.ca, 'lift_amc', 'Lift AMC', '5C001', 'bogus'), /Unknown TDS type/);

  const lift = (await types()).find((t) => t.key === 'lift_amc');
  assert.deepEqual([lift.account_code, lift.ledger_name], ['5C001', 'Lift AMC']);
  const audit = await db.query(`SELECT count(*)::int n FROM audit_logs WHERE society_id=$1 AND action='bill_type.updated'`, [ids.societyId]);
  assert.equal(audit.rows[0].n, 1);

  const later = await approveBill('lift_amc', 8000);
  assert.deepEqual(await debitCodes(later), ['5C001']);
  assert.deepEqual(await debitCodes(ids.earlier), ['5000'], 'bills already in the books stay where they are');
});

test('moving earlier bills is an adjustment the committee approves', async () => {
  const move = (user) => val(user, `SELECT public.propose_bill_type_move($1,'lift_amc')`, [ids.societyId]);
  await assert.rejects(move(ids.secretary), /Only the society's CA or accountant/);
  const r = await move(ids.ca);
  const proposal = (await db.query('SELECT lines, status, bill_type_key FROM adjustment_proposals WHERE id = $1', [r.id])).rows[0];
  const lines = Object.fromEntries(proposal.lines.map((l) => [l.code, Number(l.amount)]));
  assert.deepEqual(lines, { '5C001': 12000, '5000': -12000 }, "only this year's lift bill: not last year's, not the repairs bill");
  assert.deepEqual([proposal.status, proposal.bill_type_key], ['pending', 'lift_amc']);
  await assert.rejects(move(ids.ca), /already waiting for the committee/);

  await q(ids.treasurer, 'SELECT public.decide_adjustment($1, true)', [r.id]);
  assert.equal(await thisYear('5C001'), 12000 + 8000);
  assert.equal(await thisYear('5000'), 4000);
  await assert.rejects(move(ids.ca), /already in Lift AMC/);
});

test('the CA adds a bill type and can turn it off; standard types stay on', async () => {
  assert.equal(await setType(ids.ca, null, 'Water tanker', '5400', 'contract'), 'water_tanker');
  assert.equal(await setType(ids.ca, null, 'Water-tanker', '5400', 'contract'), 'water_tanker_2');
  await assert.rejects(setType(ids.ca, null, 'water TANKER', '5400', 'none'), /already exists/);
  await q(ids.ca, `SELECT public.set_bill_type_active($1,'water_tanker',false)`, [ids.societyId]);
  const tanker = (await types()).find((t) => t.key === 'water_tanker');
  assert.deepEqual([tanker.is_active, tanker.is_custom, tanker.label], [false, true, 'Water tanker']);
  await assert.rejects(q(ids.ca, `SELECT public.set_bill_type_active($1,'security',false)`, [ids.societyId]),
    /standard bill types cannot be turned off/);
});

test('"Other" bills take their TDS type from the plain question', async () => {
  const s = (cat, nature) => val(ids.secretary, 'SELECT public.suggest_tds($1,$2,$3,40000,current_date,NULL,$4)',
    [ids.societyId, ids.vendor, cat, nature]);
  const c = await s('other', 'contract');
  assert.deepEqual([c.nature, c.applies, Number(c.amount), c.section], ['contract', true, 400, '194C']);
  assert.equal((await s('other', null)).nature, 'none');
  assert.equal((await s('other', 'professional')).nature, 'professional');
  assert.equal((await s('security', 'professional')).nature, 'contract');
  await assert.rejects(s('other', 'rent_building'), /Choose work, professional or goods/);
});
