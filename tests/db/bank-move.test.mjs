// 028: a receipt, vendor payment or TDS challan booked to the wrong bank moves by an adjustment the committee approves.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';
import { inviteProfessional } from './opening-helpers.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const CA_PRESET = ['view_reports', 'view_ledger', 'view_expenses', 'audit_gst', 'view_bills', 'view_payments', 'view_documents', 'manage_accounts'];
const bal = async (code) => Number((await db.query(
  `SELECT coalesce(sum(l.amount),0) b FROM ledger_entries l JOIN accounts a ON a.id=l.account_id WHERE l.society_id=$1 AND a.code=$2`,
  [ids.societyId, code])).rows[0].b);
const ledgerId = async (code) => (await db.query(`SELECT id FROM accounts WHERE society_id=$1 AND code=$2`, [ids.societyId, code])).rows[0].id;

/** A resident payment for flat 101, verified by the treasurer. */
async function verifiedPayment(no, amount, utr, method = 'upi') {
  const id = await val(ids.resident, `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, payment_method, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_verification') RETURNING id`, [ids.societyId, ids.unit, ids.resident, no, amount, utr, method]);
  await q(ids.treasurer, 'SELECT public.verify_payment($1, true)', [id]);
  return id;
}

/** A statement for the 1000 bank with one credit line per [utr, amount], each linked to a payment. */
async function matchOn1000(pairs) {
  const today = (await db.query('SELECT current_date::text AS d')).rows[0].d;
  const rows = pairs.map(([utr, amount]) => ({ date: today, description: `UPI/${utr}/Flat 101`, credit: amount, debit: 0 }));
  await val(ids.secretary, `SELECT public.import_bank_statement($1,'stmt.csv','hdfc',$2)`, [ids.stmt1000, JSON.stringify(rows)]);
  for (const [utr, , payment] of pairs) {
    const line = (await db.query(`SELECT id, reconciled_payment_id FROM bank_transactions WHERE bank_account_id=$1 AND description LIKE $2`,
      [ids.stmt1000, `%${utr}%`])).rows[0];
    if (line.reconciled_payment_id !== payment) await q(ids.secretary, 'SELECT public.link_bank_line($1,$2,$3)', [line.id, 'payment', payment]);
  }
}

before(async () => {
  db = await createDb();
  const secretary = await createUser(db, 'sec@move.test');
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Move Heights','Road','Pune','Maharashtra','411001','sec@move.test','9876543210') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }])]);
    await tx.query('UPDATE society_settings SET require_two_step_expense_approval = false WHERE society_id = $1', [id]);
    await tx.query(`INSERT INTO member_invites (society_id,email,role,unit_id,invited_by)
      SELECT $1,'res@move.test','resident_owner',id,$2 FROM units WHERE society_id=$1 AND unit_number='101'`, [id, secretary]);
    await tx.query(`INSERT INTO member_invites (society_id,email,role,invited_by) VALUES ($1,'tre@move.test','treasurer',$2)`, [id, secretary]);
    return id;
  });
  const resident = await createUser(db, 'res@move.test');
  const treasurer = await createUser(db, 'tre@move.test');
  for (const u of [resident, treasurer]) await asUser(db, u, (tx) => tx.query('SELECT public.claim_my_invites()'));
  const ca = await inviteProfessional(db, { societyId, inviter: secretary, email: 'ca@move.test', permissions: CA_PRESET });
  const unit = (await db.query(`SELECT id FROM units WHERE society_id=$1`, [societyId])).rows[0].id;
  ids = { societyId, secretary, resident, treasurer, ca, unit };

  const banks = (await db.query(`SELECT id FROM account_groups WHERE society_id=$1 AND system_key='bank_accounts'`, [societyId])).rows[0].id;
  ids.hdfc = await val(ca, `SELECT public.create_ledger($1,$2,'HDFC Savings')`, [societyId, banks]);
  ids.hdfcId = await ledgerId(ids.hdfc);
  ids.repairsId = await ledgerId('5000');
  ids.stmt1000 = await val(secretary, `INSERT INTO bank_accounts (society_id, bank_name, account_number, ifsc_code, branch_name, is_primary, ledger_id)
    VALUES ($1,'SBI','10000000001','SBIN0000001','Baner',true,$2) RETURNING id`, [societyId, await ledgerId('1000')]);

  ids.pay = await verifiedPayment('PAY-1', 4170, '412345678901');
  ids.pay2 = await verifiedPayment('PAY-2', 3000, '412345678902');
  ids.cashPay = await verifiedPayment('PAY-3', 500, 'CASH-1', 'cash');
  ids.matchedPay = await verifiedPayment('PAY-4', 2000, '412345678904');
  await matchOn1000([['412345678904', 2000, ids.matchedPay]]);

  const vendor = (await db.query(`INSERT INTO vendors (society_id, name, phone, pan) VALUES ($1,'Ramesh Plumbing','9000000000','ABCPR1234K') RETURNING id`,
    [societyId])).rows[0].id;
  const bill = await val(treasurer, `INSERT INTO expenses (society_id, vendor_id, category, title, subtotal, tds_amount, invoice_number, invoice_date)
    VALUES ($1,$2,'repairs','Pipe repair',3000,0,'PR-1',current_date) RETURNING id`, [societyId, vendor]);
  await q(secretary, 'SELECT public.decide_expense($1, true)', [bill]);
  await q(treasurer, `SELECT public.record_vendor_payment($1,3000,0,'neft','UTR-V',current_date)`, [bill]);
  ids.vpay = (await db.query('SELECT id FROM vendor_payments WHERE expense_id=$1', [bill])).rows[0].id;
});

test('a receipt booked to the wrong bank moves by an approved adjustment', async () => {
  const before = [await bal('1000'), await bal(ids.hdfc)];
  const p = await val(ids.ca, `SELECT public.propose_bank_move($1,'payment',$2,$3,'Paid into HDFC per statement')`, [ids.societyId, ids.pay, ids.hdfcId]);
  const row = (await db.query('SELECT kind, lines FROM adjustment_proposals WHERE id=$1', [p.id])).rows[0];
  assert.equal(row.kind, 'bank_move');
  assert.deepEqual(Object.fromEntries(row.lines.map((l) => [l.code, Number(l.amount)])), { [ids.hdfc]: 4170, 1000: -4170 });
  assert.equal((await db.query('SELECT bank_ledger_id FROM payments WHERE id=$1', [ids.pay])).rows[0].bank_ledger_id, await ledgerId('1000'),
    'nothing moves until the committee approves');
  await assert.rejects(q(ids.ca, `SELECT public.propose_bank_move($1,'payment',$2,$3,'Again please')`, [ids.societyId, ids.pay, ids.hdfcId]),
    /already waiting for the committee/);
  await q(ids.secretary, 'SELECT public.decide_adjustment($1,true)', [p.id]);
  assert.equal((await db.query('SELECT bank_ledger_id FROM payments WHERE id=$1', [ids.pay])).rows[0].bank_ledger_id, ids.hdfcId);
  assert.deepEqual([await bal('1000'), await bal(ids.hdfc)], [before[0] - 4170, before[1] + 4170]);
  await assert.rejects(q(ids.ca, `SELECT public.propose_bank_move($1,'payment',$2,$3,'Once more')`, [ids.societyId, ids.pay, ids.hdfcId]),
    /already in HDFC Savings/);
});

test('a vendor payment moves the other way', async () => {
  const p = await val(ids.ca, `SELECT public.propose_bank_move($1,'vendor_payment',$2,$3,'Paid from HDFC per statement')`, [ids.societyId, ids.vpay, ids.hdfcId]);
  const row = (await db.query('SELECT lines FROM adjustment_proposals WHERE id=$1', [p.id])).rows[0];
  assert.deepEqual(Object.fromEntries(row.lines.map((l) => [l.code, Number(l.amount)])), { 1000: 3000, [ids.hdfc]: -3000 });
  await q(ids.treasurer, 'SELECT public.decide_adjustment($1,true)', [p.id]);
  assert.equal((await db.query('SELECT bank_ledger_id FROM vendor_payments WHERE id=$1', [ids.vpay])).rows[0].bank_ledger_id, ids.hdfcId);
});

test('cash, a non-bank ledger, a matched line or a resident stops a move', async () => {
  await assert.rejects(q(ids.ca, `SELECT public.propose_bank_move($1,'payment',$2,$3,'Was it bank?')`, [ids.societyId, ids.cashPay, ids.hdfcId]),
    /received in cash/);
  await assert.rejects(q(ids.ca, `SELECT public.propose_bank_move($1,'payment',$2,$3,'Into expenses?')`, [ids.societyId, ids.pay2, ids.repairsId]),
    /Choose a bank ledger of this society/);
  await assert.rejects(q(ids.ca, `SELECT public.propose_bank_move($1,'payment',$2,$3,'Matched one')`, [ids.societyId, ids.matchedPay, ids.hdfcId]),
    /Unlink it from the bank statement first/);
  await assert.rejects(q(ids.resident, `SELECT public.propose_bank_move($1,'payment',$2,$3,'Please move')`, [ids.societyId, ids.pay2, ids.hdfcId]),
    /Only the committee or the society's CA/);
});

test('approval re-checks the entry: matched after the proposal, nothing moves', async () => {
  const p = await val(ids.ca, `SELECT public.propose_bank_move($1,'payment',$2,$3,'Into HDFC')`, [ids.societyId, ids.pay2, ids.hdfcId]);
  await matchOn1000([['412345678902', 3000, ids.pay2]]);
  await assert.rejects(q(ids.secretary, 'SELECT public.decide_adjustment($1,true)', [p.id]), /changed since the proposal/);
  assert.equal((await db.query(`SELECT count(*)::int n FROM journal_entries WHERE reference_event_id=$1`, [p.id])).rows[0].n, 0);
  assert.equal((await db.query('SELECT bank_ledger_id FROM payments WHERE id=$1', [ids.pay2])).rows[0].bank_ledger_id, await ledgerId('1000'));
});

/** Import one credit line into a statement account and make sure it is linked to `payment` (auto-match or by hand). */
async function matchOn(account, utr, amount, payment) {
  const today = (await db.query('SELECT current_date::text AS d')).rows[0].d;
  await val(ids.secretary, `SELECT public.import_bank_statement($1,'stmt.csv','hdfc',$2)`,
    [account, JSON.stringify([{ date: today, description: `UPI/${utr}/moved`, credit: amount, debit: 0 }])]);
  const line = (await db.query(`SELECT id, reconciled_payment_id FROM bank_transactions WHERE bank_account_id=$1 AND description LIKE $2`,
    [account, `%${utr}/moved%`])).rows[0];
  if (line.reconciled_payment_id !== payment) await q(ids.secretary, 'SELECT public.link_bank_line($1,$2,$3)', [line.id, 'payment', payment]);
  return (await db.query('SELECT reconciled_payment_id FROM bank_transactions WHERE id=$1', [line.id])).rows[0].reconciled_payment_id;
}

test("a moved receipt is matched on its new bank's statement, not the old one", async () => {
  // ids.pay moved to HDFC Savings in the first test
  await assert.rejects(matchOn(ids.stmt1000, '412345678901', 4170, ids.pay), /is in HDFC Savings in the books/);
  const stmtHdfc = await val(ids.secretary, `INSERT INTO bank_accounts (society_id, bank_name, account_number, ifsc_code, branch_name, is_primary, ledger_id)
    VALUES ($1,'HDFC','20000000002','HDFC0000001','Baner',false,$2) RETURNING id`, [ids.societyId, ids.hdfcId]);
  assert.equal(await matchOn(stmtHdfc, '412345678901', 4170, ids.pay), ids.pay);
});

test('a vendor payment voided after the move was proposed is not moved', async () => {
  const vendor = (await db.query(`SELECT id FROM vendors WHERE society_id=$1 LIMIT 1`, [ids.societyId])).rows[0].id;
  const bill = await val(ids.treasurer, `INSERT INTO expenses (society_id, vendor_id, category, title, subtotal, tds_amount, invoice_number, invoice_date)
    VALUES ($1,$2,'repairs','Tap repair',2000,0,'PR-2',current_date) RETURNING id`, [ids.societyId, vendor]);
  await q(ids.secretary, 'SELECT public.decide_expense($1, true)', [bill]);
  await q(ids.treasurer, `SELECT public.record_vendor_payment($1,2000,0,'neft','UTR-V2',current_date)`, [bill]);
  const vp = (await db.query('SELECT id FROM vendor_payments WHERE expense_id=$1', [bill])).rows[0].id;
  const p = await val(ids.ca, `SELECT public.propose_bank_move($1,'vendor_payment',$2,$3,'Paid from HDFC')`, [ids.societyId, vp, ids.hdfcId]);
  await q(ids.secretary, `SELECT public.void_expense($1,'Wrong vendor')`, [bill]);
  await assert.rejects(q(ids.secretary, 'SELECT public.decide_adjustment($1,true)', [p.id]), /changed since the proposal/);
  assert.equal((await db.query(`SELECT count(*)::int n FROM journal_entries WHERE reference_event_id=$1`, [p.id])).rows[0].n, 0);
});

test('a TDS challan moves out of the old bank', async () => {
  // TDS of 800 deducted on a vendor payment is waiting to be deposited
  const vendor = (await db.query(`SELECT id FROM vendors WHERE society_id=$1 LIMIT 1`, [ids.societyId])).rows[0].id;
  const bill = await val(ids.treasurer, `INSERT INTO expenses (society_id, vendor_id, category, title, subtotal, tds_amount, invoice_number, invoice_date)
    VALUES ($1,$2,'repairs','Tank cleaning',40000,800,'PR-3',current_date) RETURNING id`, [ids.societyId, vendor]);
  await q(ids.secretary, 'SELECT public.decide_expense($1, true)', [bill]);
  await q(ids.treasurer, `SELECT public.record_vendor_payment($1,39200,800,'neft','UTR-V3',current_date)`, [bill]);
  await q(ids.treasurer, `SELECT public.record_tds_challan($1,'CH-1',800,current_date,date_trunc('month', current_date)::date,'194C')`, [ids.societyId]);
  const ch = (await db.query(`SELECT id FROM tds_challans WHERE society_id=$1 AND challan_number='CH-1'`, [ids.societyId])).rows[0].id;
  const p = await val(ids.ca, `SELECT public.propose_bank_move($1,'tds_challan',$2,$3,'Paid from HDFC per challan')`, [ids.societyId, ch, ids.hdfcId]);
  const row = (await db.query('SELECT lines FROM adjustment_proposals WHERE id=$1', [p.id])).rows[0];
  assert.deepEqual(Object.fromEntries(row.lines.map((l) => [l.code, Number(l.amount)])), { 1000: 800, [ids.hdfc]: -800 });
  await q(ids.treasurer, 'SELECT public.decide_adjustment($1,true)', [p.id]);
  assert.equal((await db.query('SELECT bank_ledger_id FROM tds_challans WHERE id=$1', [ch])).rows[0].bank_ledger_id, ids.hdfcId);
});

test('an entry dated in a locked year cannot be moved', async () => {
  const old = await val(ids.resident, `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, payment_method, payment_date, status)
    VALUES ($1,$2,$3,'PAY-OLD',1000,'412345678999','upi','2026-03-15','pending_verification') RETURNING id`, [ids.societyId, ids.unit, ids.resident]);
  await q(ids.treasurer, 'SELECT public.verify_payment($1, true)', [old]);
  const lock = await val(ids.ca, `SELECT public.lock_financial_year($1,'2026-03-31','Audited')`, [ids.societyId]);
  await q(ids.secretary, 'SELECT public.decide_adjustment($1,true)', [lock.id]);
  await assert.rejects(q(ids.ca, `SELECT public.propose_bank_move($1,'payment',$2,$3,'Into HDFC')`, [ids.societyId, old, ids.hdfcId]), /locked after audit/);
});
