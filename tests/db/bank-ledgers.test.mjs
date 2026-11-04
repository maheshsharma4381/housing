// 022–023: several bank accounts. Default receiving / paying bank (CA), the bank a posting went through,
// and bank reconciliation per bank ledger.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const one = async (user, sql, params = []) => (await q(user, sql, params))[0];
const val = async (user, sql, params = []) => Object.values(await one(user, sql, params))[0];
const groupId = async (key, societyId = ids.societyId) => (await db.query(
  `SELECT id FROM account_groups WHERE society_id=$1 AND system_key=$2`, [societyId, key])).rows[0].id;
const createLedger = (user, group, name) => val(user, `SELECT public.create_ledger($1,$2,$3)`, [ids.societyId, group, name]);

const bankCodes = async (type, refId) => (await db.query(
  `SELECT a.code FROM journal_entries j JOIN ledger_entries l ON l.journal_entry_id = j.id JOIN accounts a ON a.id = l.account_id
   WHERE j.reference_event_type = $1 AND j.reference_event_id = $2
     AND account_group_key(a.group_id) IN ('bank_accounts','cash_in_hand')`, [type, refId])).rows.map((r) => r.code);
const ledgerId = async (code) => (await db.query('SELECT id FROM accounts WHERE society_id=$1 AND code=$2', [ids.societyId, code])).rows[0].id;
const setDefaults = (user, receipt, payment) => q(user, 'SELECT public.set_default_banks($1,$2,$3)', [ids.societyId, receipt, payment]);

async function inviteProfessional(societyId, secretary, email, permissions) {
  const user = await createUser(db, email);
  const inv = (await asUser(db, secretary, (tx) => tx.query(
    `INSERT INTO professional_invites (society_id, invited_email, role, permissions, invited_by, expires_at)
     VALUES ($1,$2,'ca',$3,$4, now() + interval '7 days') RETURNING id`,
    [societyId, email, JSON.stringify(permissions), secretary]))).rows[0].id;
  await asUser(db, user, (tx) => tx.query(`SELECT public.respond_to_invite('professional',$1,true)`, [inv]));
  return user;
}

/** A society with one flat, one bill and a verified payment of 1180 (posted before any default bank is set). */
async function societyWithPosting(database, tag) {
  const secretary = await createUser(database, `sec@${tag}.test`);
  const resident = await createUser(database, `res@${tag}.test`);
  const treasurer = await createUser(database, `tre@${tag}.test`);
  const societyId = await asUser(database, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society($1,'Road','Pune','Maharashtra','411001',$2,'9876543210') AS id`,
      [`${tag} Heights`, `sec@${tag}.test`])).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }])]);
    await tx.query(`INSERT INTO billing_rules (society_id,name,calculation_type,rate,tax_rate_percent) VALUES ($1,'Maint','flat_per_unit',1000,18)`, [id]);
    await tx.query('UPDATE society_settings SET require_two_step_expense_approval = false WHERE society_id = $1', [id]);
    for (const [email, role, unit] of [[`tre@${tag}.test`, 'treasurer', null], [`res@${tag}.test`, 'resident_owner', '101']]) {
      await tx.query(`INSERT INTO member_invites (society_id,email,role,unit_id,invited_by)
        VALUES ($1,$2,$3,(SELECT id FROM units WHERE society_id=$1 AND unit_number=$4),$5)`, [id, email, role, unit, secretary]);
    }
    return id;
  });
  for (const u of [treasurer, resident]) await asUser(database, u, (tx) => tx.query('SELECT public.claim_my_invites()'));
  await asUser(database, secretary, (tx) => tx.query(`SELECT public.generate_bills($1,'2026-10-01','2026-10-31','2026-10-10')`, [societyId]));
  const unit = (await database.query(`SELECT id FROM units WHERE society_id=$1`, [societyId])).rows[0].id;
  const payment = (await asUser(database, resident, (tx) => tx.query(
    `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, status)
     VALUES ($1,$2,$3,$4,1180,'625219401292','pending_verification') RETURNING id`, [societyId, unit, resident, `PAY-${tag}`]))).rows[0].id;
  await asUser(database, treasurer, (tx) => tx.query('SELECT public.verify_payment($1, true)', [payment]));
  return { societyId, secretary, resident, treasurer, unit, payment };
}

/** A pending resident payment. */
const newPayment = (no, amount, utr, method = 'upi') => val(ids.resident,
  `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, payment_method, status)
   VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_verification') RETURNING id`, [ids.societyId, ids.unit, ids.resident, no, amount, utr, method]);
const verify = (payment) => q(ids.treasurer, 'SELECT public.verify_payment($1, true)', [payment]);
const setPaymentBank = (user, payment, ledger) => q(user, 'SELECT public.set_payment_bank($1,$2)', [payment, ledger]);

before(async () => {
  db = await createDb();
  ids = await societyWithPosting(db, 'banks');
  ids.ca = await inviteProfessional(ids.societyId, ids.secretary, 'ca@banks.test', ['view_reports', 'manage_accounts']);
  ids.vendor = (await db.query(`INSERT INTO vendors (society_id, name, phone, pan) VALUES ($1,'Shiv Lifts','9000000000','ABCPP1234K') RETURNING id`,
    [ids.societyId])).rows[0].id;
  ids.bill = await val(ids.treasurer, `INSERT INTO expenses (society_id, vendor_id, category, title, subtotal, tds_amount, invoice_number, invoice_date)
    VALUES ($1,$2,'lift_amc','Lift service',5000,100,'SL-1',current_date) RETURNING id`, [ids.societyId, ids.vendor]);
  await q(ids.secretary, 'SELECT public.decide_expense($1, true)', [ids.bill]);
  ids.b1000 = await ledgerId('1000');
});

test('until the CA chooses, every bank posting goes to 1000', async () => {
  assert.deepEqual(await bankCodes('payment.verified', ids.payment), ['1000']);
  const banks = await val(ids.secretary, 'SELECT public.bank_ledgers($1)', [ids.societyId]);
  assert.deepEqual(banks.map((b) => [b.code, b.is_default_receipt, b.is_default_payment]), [['1000', true, true]]);
  await assert.rejects(q(ids.resident, 'SELECT public.bank_ledgers($1)', [ids.societyId]), /do not have access/);
});

test('the CA sets default banks; only active bank ledgers qualify', async () => {
  assert.equal(await createLedger(ids.ca, await groupId('bank_accounts'), 'ICICI Current'), '1C001');
  ids.icici = await ledgerId('1C001');
  await assert.rejects(setDefaults(ids.secretary, ids.icici, ids.b1000), /Only the society's CA or accountant/);
  await assert.rejects(setDefaults(ids.ca, await ledgerId('1300'), ids.b1000), /Choose a bank ledger of this society/);
  await setDefaults(ids.ca, ids.icici, ids.b1000);
  const banks = await val(ids.secretary, 'SELECT public.bank_ledgers($1)', [ids.societyId]);
  assert.deepEqual(banks.map((b) => [b.code, b.name, b.is_default_receipt, b.is_default_payment]),
    [['1000', 'Bank Accounts', false, true], ['1C001', 'ICICI Current', true, false]]);
  const audit = await db.query(`SELECT new_value FROM audit_logs WHERE society_id=$1 AND action='chart.default_banks'`, [ids.societyId]);
  assert.equal(audit.rows.length, 1);
  assert.deepEqual(audit.rows[0].new_value, { receipt: 'ICICI Current', payment: 'Bank Accounts' });
});

test('a verified payment goes to the bank the secretary picked, else the default receiving bank', async () => {
  ids.pA = await newPayment('P-A', 1000, 'UTR-A');
  ids.pB = await newPayment('P-B', 500, 'UTR-B');
  ids.pC = await newPayment('P-C', 300, 'CASH-1', 'cash');
  await verify(ids.pA);
  assert.deepEqual(await bankCodes('payment.verified', ids.pA), ['1C001']);
  await setPaymentBank(ids.secretary, ids.pB, ids.b1000);
  await verify(ids.pB);
  assert.deepEqual(await bankCodes('payment.verified', ids.pB), ['1000']);
  await assert.rejects(setPaymentBank(ids.secretary, ids.pC, ids.b1000), /Cash payments go to Cash-in-Hand/);
  await verify(ids.pC);
  assert.deepEqual(await bankCodes('payment.verified', ids.pC), ['1100']);
  await assert.rejects(setPaymentBank(ids.secretary, ids.pA, ids.b1000), /already in the books/);
  const pD = await newPayment('P-D', 200, 'UTR-D');
  await assert.rejects(setPaymentBank(ids.resident, pD, ids.b1000), /Only the society committee/);
  await assert.rejects(setPaymentBank(ids.secretary, pD, await ledgerId('1300')), /Choose a bank ledger/);
});

test('vendor payments and TDS deposits post to the chosen bank, else the default paying bank', async () => {
  const pay = (args) => val(ids.secretary, `SELECT public.record_vendor_payment(${args})`, [ids.bill]);
  const r1 = await pay(`$1,1900,100,'neft','VENDREF001',NULL,NULL,NULL,'${ids.icici}'`);
  assert.deepEqual(await bankCodes('vendor_payment.recorded', r1.payment_id), ['1C001']);
  const stored = async (id) => (await db.query('SELECT bank_ledger_id FROM vendor_payments WHERE id=$1', [id])).rows[0].bank_ledger_id;
  assert.equal(await stored(r1.payment_id), ids.icici);
  ids.vpIcici = r1.payment_id;
  const r2 = await pay(`$1,1000,0,'neft','VENDREF002'`);
  assert.deepEqual(await bankCodes('vendor_payment.recorded', r2.payment_id), ['1000']);
  ids.vp1000 = r2.payment_id;
  const r3 = await pay(`$1,500,0,'cash'`);
  assert.deepEqual(await bankCodes('vendor_payment.recorded', r3.payment_id), ['1100']);
  assert.equal(await stored(r3.payment_id), null);
  ids.vpCash = r3.payment_id;
  await assert.rejects(pay(`$1,100,0,'neft','VENDREF003',NULL,NULL,NULL,'${await ledgerId('1300')}'`), /Choose a bank ledger/);

  const challan = await val(ids.secretary, `SELECT public.record_tds_challan($1,'CH-1',100,current_date,current_date,'194C',NULL,$2)`,
    [ids.societyId, ids.icici]);
  assert.deepEqual(await bankCodes('tds.deposited', challan.id), ['1C001']);
});

test('a default bank or a bill type ledger cannot be deactivated', async () => {
  await assert.rejects(q(ids.ca, `SELECT public.set_ledger_active($1,'1C001',false)`, [ids.societyId]), /default bank/);
  assert.equal(await createLedger(ids.ca, await groupId('expenses'), 'Lift AMC'), '5C001');
  await db.query(`INSERT INTO expense_categories (society_id, key, label, account_code, tds_nature)
    VALUES ($1,'lift_amc','Lift AMC','5C001','contract')`, [ids.societyId]);
  await assert.rejects(q(ids.ca, `SELECT public.set_ledger_active($1,'5C001',false)`, [ids.societyId]), /A bill type uses this ledger/);
});

test('CA ledgers can go in Duties & Taxes and (since 028) in Fixed Assets', async () => {
  assert.equal(await createLedger(ids.ca, await groupId('duties_taxes'), 'Professional Tax Payable'), '2C001');
  assert.ok(await createLedger(ids.ca, await groupId('fixed_assets'), 'Lift'), '028: asset types are fixed-asset ledgers');
  const chart = await val(ids.ca, `SELECT public.chart_of_accounts($1)`, [ids.societyId]);
  const allows = (key) => chart.groups.find((g) => g.system_key === key).allows_ledgers;
  assert.deepEqual([allows('duties_taxes'), allows('fixed_assets'), allows('members_dues')], [true, true, false]);
});

// ---------------------------------------------------------------------------
// 023: bank reconciliation per bank ledger
// ---------------------------------------------------------------------------
const setPlan = (code) => db.query(
  `UPDATE subscriptions SET plan_id = (SELECT id FROM subscription_plans WHERE tier_code = $2), status = 'active',
     trial_ends_on = current_date - 1, current_period_start = current_date - 1,
     current_period_end = CASE WHEN $2 = 'free' THEN NULL ELSE current_date + 300 END
   WHERE society_id = $1`, [ids.societyId, code]);
const balOf = async (code) => Number((await db.query(
  `SELECT coalesce(sum(l.amount),0) b FROM ledger_entries l JOIN accounts a ON a.id=l.account_id WHERE l.society_id=$1 AND a.code=$2`,
  [ids.societyId, code])).rows[0].b);
const addStatementAccount = (accountNo, ledger) => one(ids.secretary,
  `INSERT INTO bank_accounts (society_id, bank_name, account_number, ifsc_code, branch_name, is_primary, ledger_id)
   VALUES ($1,'Bank',$2,'ICIC0000001','Baner',false,$3) RETURNING id, ledger_id`, [ids.societyId, accountNo, ledger]);
const importInto = async (account, rows) => {
  const today = (await db.query('SELECT current_date::text AS d')).rows[0].d;
  return val(ids.secretary, `SELECT public.import_bank_statement($1,'stmt.csv','hdfc',$2)`,
    [account, JSON.stringify(rows.map((r) => ({ date: today, debit: 0, credit: 0, ...r })))]);
};
const lineOf = async (account, text) => (await db.query(
  `SELECT * FROM bank_transactions WHERE bank_account_id=$1 AND description LIKE $2`, [account, `%${text}%`])).rows[0];

// Statement lines in the first two tests match nothing in the books.
test('each statement account belongs to one bank ledger', async () => {
  await setPlan('pro');
  const a = await addStatementAccount('111', null);
  assert.equal(a.ledger_id, ids.icici, 'no choice → the default receiving bank');
  ids.stmtIcici = a.id;
  await assert.rejects(addStatementAccount('222', await ledgerId('1300')), /Choose a bank ledger of this society/);
  ids.stmt1000 = (await addStatementAccount('333', ids.b1000)).id;
});

test("the book balance is that bank ledger's own balance", async () => {
  await importInto(ids.stmtIcici, [{ description: 'OPENING CHECK', credit: 1, balance: 1 }]);
  await importInto(ids.stmt1000, [{ description: 'OPENING CHECK', credit: 1, balance: 1 }]);
  const book = async (account) => Number((await val(ids.secretary, 'SELECT public.bank_reconciliation_summary($1)', [account])).book_balance);
  assert.notEqual(await balOf('1C001'), await balOf('1000'));
  assert.equal(await book(ids.stmtIcici), await balOf('1C001'));
  assert.equal(await book(ids.stmt1000), await balOf('1000'));
});

test('matching stays inside one bank', async () => {
  const pX = await newPayment('P-X', 777, '998877665544');
  await importInto(ids.stmt1000, [
    { description: 'UPI/998877665544/Flat 101', credit: 777 },
    { description: 'NEFT/VENDREF002/Lift', debit: 1000 },
    { description: 'NEFT/VENDREF001/Lift', debit: 1900 },
    { description: 'NEFT-SHARMA', credit: 1000 },
    { description: 'CASH WDL', debit: 500 },
  ]);
  assert.equal((await lineOf(ids.stmt1000, '998877665544')).reconciled_payment_id, pX);
  assert.equal((await lineOf(ids.stmt1000, 'VENDREF002')).reconciled_vendor_payment_id, ids.vp1000);
  assert.equal((await lineOf(ids.stmt1000, 'VENDREF001')).match_kind, null, 'paid from ICICI, not from this bank');
  await assert.rejects(setPaymentBank(ids.secretary, pX, ids.icici), /matched to a bank statement line/);
  const link = async (text, kind, target) => q(ids.secretary, 'SELECT public.link_bank_line($1,$2,$3)',
    [(await lineOf(ids.stmt1000, text)).id, kind, target]);
  await assert.rejects(link('VENDREF001', 'vendor_payment', ids.vpIcici), /paid from ICICI Current in the books/);
  await assert.rejects(link('NEFT-SHARMA', 'payment', ids.pA), /is in ICICI Current in the books/);
  await assert.rejects(link('CASH WDL', 'vendor_payment', ids.vpCash), /paid in cash/);
  await q(ids.secretary, 'SELECT public.verify_matched_payments($1)', [ids.societyId]);
  assert.deepEqual(await bankCodes('payment.verified', pX), ['1000'], 'the statement decides, not the default receiving bank');
});

test('a statement account moves to another bank ledger unless its matched entries are in a different bank', async () => {
  const repoint = (account, ledger) => q(ids.secretary, 'UPDATE bank_accounts SET ledger_id = $2 WHERE id = $1', [account, ledger]);
  await assert.rejects(repoint(ids.stmt1000, ids.icici), /matched to entries in Bank Accounts/);
  // The ICICI statement has no matched lines: the CA's own ledger for that bank account can take it over
  const code = await createLedger(ids.ca, await groupId('bank_accounts'), 'ICICI Current (new)');
  await repoint(ids.stmtIcici, await ledgerId(code));
  const summary = await val(ids.secretary, 'SELECT public.bank_reconciliation_summary($1)', [ids.stmtIcici]);
  assert.equal(Number(summary.book_balance), await balOf(code));
  await assert.rejects(repoint(ids.stmtIcici, await ledgerId('1300')), /Choose a bank ledger of this society/);
});
