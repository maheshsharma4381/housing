// 017: bank statement import, auto-match (UTR / reference / TDS), suggestions, committee actions, summary.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const line = async (match) => (await db.query(
  `SELECT * FROM bank_transactions WHERE bank_account_id = $1 AND description LIKE $2`, [ids.bank, `%${match}%`])).rows[0];
const paymentStatus = async (id) => (await db.query('SELECT status FROM payments WHERE id = $1', [id])).rows[0].status;

const setPlan = (code) => db.query(
  `UPDATE subscriptions SET plan_id = (SELECT id FROM subscription_plans WHERE tier_code = $2), status = 'active',
     trial_ends_on = current_date - 1, current_period_start = current_date - 1,
     current_period_end = CASE WHEN $2 = 'free' THEN NULL ELSE current_date + 300 END
   WHERE society_id = $1`, [ids.societyId, code]);

const statement = [
  { date: '2026-10-14', description: 'UPI/412345678901/Flat 101 maintenance', credit: 4170, balance: 54170 },
  { date: '2026-10-15', description: 'NEFT-SHARMA R-OCT', credit: 2500, balance: 56670 },
  { date: '2026-10-16', description: 'NEFT/UTRVEND12345/Ramesh Plumbing', reference: 'UTRVEND12345', debit: 5000, balance: 51670 },
  { date: '2026-10-17', description: 'ITNS 281 TDS DEPOSIT', debit: 800, balance: 50870 },
  { date: '2026-10-18', description: 'IMPS/556677889900/Flat 101 extra', credit: 3000, balance: 53870 },
  { date: '2026-10-19', description: 'SMS CHARGES', debit: 17.7, balance: 53852.3 },
];
const rows = statement.map((r) => ({ debit: 0, credit: 0, ...r }));
const importIt = (user = ids.secretary, data = rows) =>
  val(user, `SELECT public.import_bank_statement($1,'oct.csv','hdfc',$2)`, [ids.bank, JSON.stringify(data)]);

before(async () => {
  db = await createDb();
  const secretary = await createUser(db, 'sec@bank.test');
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Bank Heights','Road','Pune','Maharashtra','411001','sec@bank.test','9876543210') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }, { unit_number: '102' }])]);
    await tx.query('UPDATE society_settings SET require_two_step_expense_approval = false WHERE society_id = $1', [id]);
    await tx.query(`INSERT INTO member_invites (society_id,email,role,unit_id,invited_by)
      SELECT $1,'res@bank.test','resident_owner',id,$2 FROM units WHERE society_id=$1 AND unit_number='101'`, [id, secretary]);
    await tx.query(`INSERT INTO member_invites (society_id,email,role,invited_by) VALUES ($1,'tre@bank.test','treasurer',$2)`, [id, secretary]);
    return id;
  });
  const resident = await createUser(db, 'res@bank.test');
  const treasurer = await createUser(db, 'tre@bank.test');
  for (const u of [resident, treasurer]) await asUser(db, u, (tx) => tx.query('SELECT public.claim_my_invites()'));
  const unit101 = (await db.query(`SELECT id FROM units WHERE society_id=$1 AND unit_number='101'`, [societyId])).rows[0].id;
  const unit102 = (await db.query(`SELECT id FROM units WHERE society_id=$1 AND unit_number='102'`, [societyId])).rows[0].id;
  ids = { societyId, secretary, resident, unit101, unit102 };

  ids.bank = await val(secretary, `INSERT INTO bank_accounts (society_id, bank_name, account_number, ifsc_code, branch_name, is_primary)
    VALUES ($1,'HDFC Bank','50100012345678','HDFC0000123','Baner',true) RETURNING id`, [societyId]);

  const payment = (no, amount, utr, date) => db.query(
    `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, payment_date, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_verification') RETURNING id`, [societyId, unit101, resident, no, amount, utr, date]).then((r) => r.rows[0].id);
  ids.p1 = await payment('P-1', 4170, '412345678901', '2026-10-14');
  ids.p2 = await payment('P-2', 2500, 'HAND-ENTERED', '2026-10-14');

  const vendor = (await db.query(`INSERT INTO vendors (society_id, name, phone, pan) VALUES ($1,'Ramesh Plumbing','9000000000','ABCPP1234K') RETURNING id`, [societyId])).rows[0].id;
  const expense = await val(treasurer, `INSERT INTO expenses (society_id, vendor_id, category, title, subtotal, invoice_number, invoice_date)
    VALUES ($1,$2,'plumbing','Pipe repair',5000,'RP-9','2026-10-10') RETURNING id`, [societyId, vendor]);
  await val(secretary, 'SELECT public.decide_expense($1, true)', [expense]);
  ids.vp = (await val(secretary, `SELECT public.record_vendor_payment($1,5000,NULL,'neft','UTRVEND12345','2026-10-16')`, [expense])).vendor_payment_id
    ?? (await db.query('SELECT id FROM vendor_payments WHERE expense_id = $1', [expense])).rows[0].id;
  ids.challan = (await db.query(`INSERT INTO tds_challans (society_id, challan_number, paid_on, period_month, amount)
    VALUES ($1,'CH-77','2026-10-17','2026-09-01',800) RETURNING id`, [societyId])).rows[0].id;
});

test('statement match is a Pro feature; residents cannot import or read lines', async () => {
  await setPlan('basic');
  await assert.rejects(importIt(), /Bank statement match/);
  await setPlan('pro');
  await assert.rejects(importIt(ids.resident), /Bank account not found/);
  await assert.rejects(q(ids.secretary, `INSERT INTO bank_transactions (society_id, bank_account_id, transaction_date, value_date, description, type, amount)
    VALUES ($1,$2,current_date,current_date,'x','credit',1)`, [ids.societyId, ids.bank]), /row-level security/);
  await assert.rejects(importIt(ids.secretary, [{ date: '2026-10-01', description: 'both', debit: 1, credit: 1 }]), /exactly one of debit or credit/);
});

test('import auto-matches UTRs, vendor references and the TDS deposit; suggests by amount + date', async () => {
  const r = await importIt();
  assert.deepEqual([r.rows, r.new, r.duplicates, r.matched, r.suggested, r.from, r.to], [6, 6, 0, 3, 1, '2026-10-14', '2026-10-19']);

  assert.deepEqual([(await line('412345678901')).reconciled_payment_id, (await line('412345678901')).match_method], [ids.p1, 'utr']);
  assert.equal((await line('UTRVEND')).reconciled_vendor_payment_id, ids.vp);
  assert.equal((await line('ITNS')).reconciled_challan_id, ids.challan);
  const s = await line('SHARMA');
  assert.deepEqual([s.match_kind, s.suggested_kind, s.suggested_id], [null, 'payment', ids.p2]);
  assert.equal(Number((await db.query('SELECT current_balance FROM bank_accounts WHERE id=$1', [ids.bank])).rows[0].current_balance), 53852.3);

  assert.equal(await val(ids.resident, 'SELECT count(*)::int FROM bank_transactions'), 0);
});

test('uploading the same statement again adds nothing', async () => {
  const r = await importIt();
  assert.deepEqual([r.new, r.duplicates], [0, 6]);
  assert.equal(Number((await db.query('SELECT count(*) FROM bank_transactions WHERE bank_account_id=$1', [ids.bank])).rows[0].count), 6);
});

test('verify all matched: UTRs found in the bank are verified with a receipt', async () => {
  const r = await val(ids.secretary, 'SELECT public.verify_matched_payments($1)', [ids.societyId]);
  assert.equal(r.verified, 1);
  assert.equal(await paymentStatus(ids.p1), 'verified');
  await assert.rejects(q(ids.resident, 'SELECT public.verify_matched_payments($1)', [ids.societyId]), /Only the society committee/);

  const sharma = await line('SHARMA');
  await val(ids.secretary, 'SELECT public.confirm_bank_suggestion($1)', [sharma.id]);
  assert.equal((await line('SHARMA')).reconciled_payment_id, ids.p2);
  assert.equal((await val(ids.secretary, 'SELECT public.verify_matched_payments($1)', [ids.societyId])).verified, 1);
  assert.equal(await paymentStatus(ids.p2), 'verified');
});

test('an unknown credit is recorded as the flat\'s payment; charges are ignored with a reason', async () => {
  const extra = await line('IMPS');
  await assert.rejects(val(ids.secretary, 'SELECT public.record_bank_receipt($1,$2)', [extra.id, ids.unit102]), /no owner linked/);
  const r = await val(ids.secretary, 'SELECT public.record_bank_receipt($1,$2)', [extra.id, ids.unit101]);
  assert.equal(r.status, 'verified');
  const p = (await db.query('SELECT amount, transaction_reference_utr, payment_method, unit_id FROM payments WHERE id=$1', [r.payment_id])).rows[0];
  assert.deepEqual([Number(p.amount), p.transaction_reference_utr, p.payment_method, p.unit_id], [3000, '556677889900', 'neft_rtgs', ids.unit101]);
  await assert.rejects(val(ids.secretary, 'SELECT public.unlink_bank_line($1)', [extra.id]), /recorded from the statement/);

  const sms = await line('SMS');
  await assert.rejects(val(ids.secretary, 'SELECT public.ignore_bank_line($1,$2)', [sms.id, '']), /Say why/);
  await val(ids.secretary, 'SELECT public.ignore_bank_line($1,$2)', [sms.id, 'Bank charges']);
});

test('manual link checks the amount and direction; unlink reopens the line', async () => {
  const vend = await line('UTRVEND');
  await assert.rejects(val(ids.secretary, 'SELECT public.link_bank_line($1,$2,$3)', [vend.id, 'payment', ids.p1]), /already matched/);
  await val(ids.secretary, 'SELECT public.unlink_bank_line($1)', [vend.id]);
  await assert.rejects(val(ids.secretary, 'SELECT public.link_bank_line($1,$2,$3)', [vend.id, 'payment', ids.p1]), /money coming in/);
  await assert.rejects(val(ids.secretary, 'SELECT public.link_bank_line($1,$2,$3)', [vend.id, 'tds_challan', ids.challan]), /Amounts differ/);
  await val(ids.secretary, `SELECT public.link_bank_line($1,'vendor_payment',$2,'Plumber October')`, [vend.id, ids.vp]);
  assert.deepEqual([(await line('UTRVEND')).match_method, (await line('UTRVEND')).match_note], ['manual', 'Plumber October']);
});

test('summary: statement vs book balance, nothing left open', async () => {
  const s = await val(ids.secretary, 'SELECT public.bank_reconciliation_summary($1)', [ids.bank]);
  assert.deepEqual([Number(s.statement_balance), s.statement_date, s.lines, s.matched, s.ignored, s.open_credits, s.open_debits, s.ready_to_verify],
    [53852.3, '2026-10-19', 6, 5, 1, 0, 0, 0]);
  // Book: three resident receipts (4170 + 2500 + 3000) minus the vendor payment (5000)
  assert.equal(Number(s.book_balance), 4670);
  await assert.rejects(q(ids.resident, 'SELECT public.bank_reconciliation_summary($1)', [ids.bank]), /Bank account not found/);
});
