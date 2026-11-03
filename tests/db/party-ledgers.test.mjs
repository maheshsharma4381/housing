// 025: vendor-wise and flat-wise ledgers. Each line on Members Receivable (1200), Advance Maintenance (2300)
// and Sundry Creditors (2000) belongs to a flat or a vendor through its journal's reference, so the party
// totals always equal those ledgers.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const one = async (user, sql, params = []) => (await q(user, sql, params))[0];
const val = async (user, sql, params = []) => Object.values(await one(user, sql, params))[0];
const bal = async (code) => Number((await db.query(
  `SELECT coalesce(sum(l.amount),0) b FROM ledger_entries l JOIN accounts a ON a.id=l.account_id WHERE l.society_id=$1 AND a.code=$2`,
  [ids.societyId, code])).rows[0].b);
const unitId = async (no) => (await db.query(`SELECT id FROM units WHERE society_id=$1 AND unit_number=$2`, [ids.societyId, no])).rows[0].id;
const neg = (n) => 0 - n; // avoids -0 in strict comparisons
const balances = (user, kind) => val(user, `SELECT public.party_balances($1,$2)`, [ids.societyId, kind]);

async function inviteProfessional(email, permissions) {
  const user = await createUser(db, email);
  const inv = (await asUser(db, ids.secretary, (tx) => tx.query(
    `INSERT INTO professional_invites (society_id, invited_email, role, permissions, invited_by, expires_at)
     VALUES ($1,$2,'ca',$3,$4, now() + interval '7 days') RETURNING id`,
    [ids.societyId, email, JSON.stringify(permissions), ids.secretary]))).rows[0].id;
  await asUser(db, user, (tx) => tx.query(`SELECT public.respond_to_invite('professional',$1,true)`, [inv]));
  return user;
}

/** The treasurer records a bill, the secretary approves it. */
async function approvedBill(fields) {
  const cols = Object.keys(fields);
  const id = await val(ids.treasurer, `INSERT INTO expenses (society_id, ${cols.join(', ')})
    VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`, [ids.societyId, ...Object.values(fields)]);
  await q(ids.secretary, 'SELECT public.decide_expense($1, true)', [id]);
  return id;
}

before(async () => {
  db = await createDb();
  const secretary = await createUser(db, 'sec@party.test');
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Party Heights','Road','Pune','Maharashtra','411001','sec@party.test','9876543210') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }, { unit_number: '102' }])]);
    await tx.query(`INSERT INTO billing_rules (society_id,name,calculation_type,rate,tax_rate_percent) VALUES ($1,'Maint','flat_per_unit',1000,18)`, [id]);
    await tx.query('UPDATE society_settings SET require_two_step_expense_approval = false WHERE society_id = $1', [id]);
    for (const [email, role, unit] of [['res1@party.test', 'resident_owner', '101'], ['res2@party.test', 'resident_owner', '102'], ['tre@party.test', 'treasurer', null]]) {
      await tx.query(`INSERT INTO member_invites (society_id,email,role,unit_id,invited_by)
        VALUES ($1,$2,$3,(SELECT id FROM units WHERE society_id=$1 AND unit_number=$4),$5)`, [id, email, role, unit, secretary]);
    }
    return id;
  });
  const res1 = await createUser(db, 'res1@party.test');
  const res2 = await createUser(db, 'res2@party.test');
  const treasurer = await createUser(db, 'tre@party.test');
  for (const u of [res1, res2, treasurer]) await asUser(db, u, (tx) => tx.query('SELECT public.claim_my_invites()'));
  ids = { societyId, secretary, res1, res2, treasurer };
  ids.ca = await inviteProfessional('ca@party.test', ['view_reports', 'manage_accounts']);

  // 1. Opening balances: a creditor nobody can name yet, and arrears on flat 102
  await q(secretary, `SELECT public.post_opening_balances($1,'2026-09-30',$2,$3)`, [societyId,
    JSON.stringify([{ code: '2000', amount: -4000 }, { code: '1000', amount: 4000 }]),
    JSON.stringify([{ unit_number: '102', amount: 2500 }])]);
  // 2. October bills
  await q(secretary, `SELECT public.generate_bills($1,'2026-10-01','2026-10-31','2026-10-10')`, [societyId]);
  // 3. Flat 101 pays 1500 against 1180: 320 becomes an advance
  ids.unit101 = await unitId('101');
  ids.unit102 = await unitId('102');
  const pay = await val(res1, `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, payment_date, status)
    VALUES ($1,$2,$3,'P-101',1500,'412345678901','2026-10-20','pending_verification') RETURNING id`, [societyId, ids.unit101, res1]);
  await q(treasurer, 'SELECT public.verify_payment($1, true)', [pay]);
  // 4. November bills (101's advance is applied); 5. 102's November bill is cancelled
  await q(secretary, `SELECT public.generate_bills($1,'2026-11-01','2026-11-30','2026-11-10')`, [societyId]);
  const nov102 = (await db.query(`SELECT id FROM bills WHERE unit_id=$1 AND bill_date >= '2026-11-01' AND NOT is_opening_balance`, [ids.unit102])).rows[0].id;
  await q(secretary, `SELECT public.cancel_bill($1,'Raised by mistake')`, [nov102]);

  // 6. Vendors: a bill paid in part with TDS, and a voided bill
  ids.shiv = (await db.query(`INSERT INTO vendors (society_id, name, phone, pan) VALUES ($1,'Shiv Lifts','9000000000','ABCPP1234K') RETURNING id`, [societyId])).rows[0].id;
  ids.clean = (await db.query(`INSERT INTO vendors (society_id, name, phone) VALUES ($1,'Clean Co','9000000001') RETURNING id`, [societyId])).rows[0].id;
  const billA = await approvedBill({ vendor_id: ids.shiv, category: 'lift_amc', title: 'Lift AMC Q3', subtotal: 5000, tds_amount: 100, invoice_number: 'SL-1', invoice_date: '2026-10-05' });
  await q(secretary, `SELECT public.record_vendor_payment($1,1900,100,'neft','VREF000001','2026-10-25')`, [billA]);
  const billB = await approvedBill({ vendor_id: ids.shiv, category: 'lift_amc', title: 'Lift AMC Q3 (again)', subtotal: 3000, tds_amount: 0, invoice_number: 'SL-2', invoice_date: '2026-10-06' });
  await q(secretary, `SELECT public.void_expense($1,'Duplicate bill')`, [billB]);
  // 8. A voucher without a vendor
  await approvedBill({ category: 'repairs', title: 'Tap washer', subtotal: 800, tds_amount: 0, invoice_status: 'none', payee_name: 'Raju',
    document_url: `${societyId}/v.jpg` });
  // 9. A flat added later, with nothing in the books
  await q(secretary, 'SELECT public.bulk_upsert_units($1,$2)', [societyId, JSON.stringify([{ unit_number: '103' }])]);
});

test("flat-wise dues and advances add up to Members' dues and advance maintenance", async () => {
  const r = await balances(ids.ca, 'flat');
  const by = Object.fromEntries(r.parties.map((p) => [p.name, p]));
  assert.deepEqual([Number(by['Flat 101'].advance), Number(by['Flat 103'].balance)], [0, 0]);
  assert.ok(Number(by['Flat 102'].dues) >= 2500, 'flat 102 carries its opening arrears');
  assert.equal(r.parties.reduce((s, p) => s + Number(p.dues), 0), await bal('1200'));
  assert.equal(r.parties.reduce((s, p) => s + Number(p.advance), 0), neg(await bal('2300')));
  assert.deepEqual([Number(r.control.dues), Number(r.control.advance)], [await bal('1200'), neg(await bal('2300'))]);

  // Every flat's dues are exactly its unpaid bills
  const unpaid = Object.fromEntries((await db.query(
    `SELECT unit_id, sum(balance_due) d FROM bills WHERE society_id=$1 AND status <> 'cancelled' GROUP BY unit_id`, [ids.societyId]))
    .rows.map((x) => [x.unit_id, Number(x.d)]));
  for (const p of r.parties.filter((x) => x.key !== 'unlinked')) assert.equal(Number(p.dues), unpaid[p.key] ?? 0, p.name);
});

test('vendor-wise balances add up to Sundry Creditors', async () => {
  const r = await balances(ids.ca, 'vendor');
  const by = Object.fromEntries(r.parties.map((p) => [p.name, Number(p.balance)]));
  assert.deepEqual([by['Shiv Lifts'], by['Clean Co'], by['Other payees'], by['Not linked to a vendor']], [3000, 0, 800, 4000]);
  assert.equal(Object.values(by).reduce((s, b) => s + b, 0), neg(await bal('2000')));
  assert.equal(Number(r.control.payable), neg(await bal('2000')));
});

test('a party statement runs from its opening balance to its closing balance', async () => {
  // Bills are dated the day they are generated (today), so before 21 Oct only the 1500 paid on 20 Oct is in the books
  const flat = await val(ids.ca, `SELECT public.party_statement($1,'flat',$2,'2026-10-21',current_date)`, [ids.societyId, ids.unit101]);
  assert.equal(Number(flat.opening), -1500);
  const flatBalance = (await balances(ids.ca, 'flat')).parties.find((p) => p.key === ids.unit101).balance;
  assert.equal(Number(flat.closing), Number(flatBalance));
  let running = Number(flat.opening);
  for (const l of flat.lines) {
    running += Number(l.debit ?? 0) - Number(l.credit ?? 0);
    assert.equal(Number(l.balance), running);
  }

  const shiv = await val(ids.ca, `SELECT public.party_statement($1,'vendor',$2,'2026-04-01',current_date)`, [ids.societyId, ids.shiv]);
  assert.equal(shiv.name, 'Shiv Lifts');
  assert.equal(Number(shiv.opening), 0);
  assert.deepEqual(shiv.lines.map((l) => Number(l.credit ?? 0)).filter(Boolean).sort((a, b) => a - b), [3000, 5000]);
  assert.deepEqual(shiv.lines.map((l) => Number(l.debit ?? 0)).filter(Boolean).sort((a, b) => a - b), [2000, 3000]);
  assert.equal(Number(shiv.closing), 3000);
});

test("Tally gets a party for every Members' dues and Sundry Creditors line", async () => {
  const rows = await val(ids.ca, `SELECT public.party_lines($1,'2026-04-01',current_date)`, [ids.societyId]);
  const entries = (await db.query(
    `SELECT l.id, l.amount, a.code, j.reference_event_type FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
     JOIN journal_entries j ON j.id = l.journal_entry_id
     WHERE l.society_id = $1 AND a.code IN ('1200','2000') AND l.date BETWEEN '2026-04-01' AND current_date`, [ids.societyId])).rows;
  assert.ok(entries.length > 0);
  for (const e of entries) {
    const mine = rows.filter((r) => r.ledger_entry_id === e.id);
    assert.ok(mine.length > 0, `entry on ${e.code} (${e.reference_event_type}) has a party`);
    assert.equal(mine.reduce((s, r) => s + Number(r.amount), 0), Number(e.amount));
  }
  const opening = entries.find((e) => e.code === '1200' && e.reference_event_type === 'opening.balance');
  assert.deepEqual(rows.filter((r) => r.ledger_entry_id === opening.id).map((r) => [r.name, Number(r.amount)]), [['Flat 102', 2500]]);
  const names = new Set(rows.map((r) => r.name));
  for (const n of ['Flat 101', 'Shiv Lifts', 'Other payees', 'Not linked to a vendor']) assert.ok(names.has(n), n);
});

test('only people who can see the accounts see party ledgers', async () => {
  await assert.rejects(balances(ids.res1, 'flat'), /do not have access/);
  assert.ok((await balances(ids.secretary, 'vendor')).parties.length >= 4);
  await assert.rejects(balances(ids.ca, 'bogus'), /Unknown party type/);
});
