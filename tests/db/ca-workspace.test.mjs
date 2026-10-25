// 014: comparatives, Receipts & Payments, account ledger, payables, TDS register, GST summary,
// CA adjustment proposals and financial-year locks.
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
const expense = (fields) => {
  const cols = { society_id: ids.societyId, category: 'repairs', title: 'Bill', subtotal: 0, status: 'approved', ...fields };
  const keys = Object.keys(cols);
  return db.query(`INSERT INTO expenses (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    keys.map((k) => cols[k])).then((r) => r.rows[0].id);
};

before(async () => {
  db = await createDb();
  const secretary = await createUser(db, 'sec@ca.test', { fullName: 'Vikram Secretary' });
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('CA Heights','Road','Pune','Maharashtra','411001','sec@ca.test','9876543210') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }])]);
    await tx.query(`INSERT INTO billing_rules (society_id,name,calculation_type,rate,tax_rate_percent) VALUES ($1,'Maint','flat_per_unit',1000,18)`, [id]);
    for (const [email, role, unit] of [['tre@ca.test', 'treasurer', null], ['res@ca.test', 'resident_owner', '101']]) {
      await tx.query(`INSERT INTO member_invites (society_id,email,role,unit_id,invited_by)
        VALUES ($1,$2,$3,(SELECT id FROM units WHERE society_id=$1 AND unit_number=$4),$5)`, [id, email, role, unit, secretary]);
    }
    return id;
  });
  const treasurer = await createUser(db, 'tre@ca.test');
  const resident = await createUser(db, 'res@ca.test');
  for (const u of [treasurer, resident]) await asUser(db, u, (tx) => tx.query('SELECT public.claim_my_invites()'));

  const ca = await createUser(db, 'ca@ca.test', { fullName: 'Priya CA' });
  const inv = (await asUser(db, secretary, (tx) => tx.query(
    `INSERT INTO professional_invites (society_id, invited_email, role, permissions, invited_by, expires_at)
     VALUES ($1,'ca@ca.test','ca','["view_reports","view_ledger","view_expenses"]',$2, now() + interval '7 days') RETURNING id`,
    [societyId, secretary]))).rows[0].id;
  await asUser(db, ca, (tx) => tx.query(`SELECT public.respond_to_invite('professional',$1,true)`, [inv]));
  ids = { societyId, secretary, treasurer, resident, ca };

  // Activity this year: a bill with GST, the resident pays it, a vendor bill paid with TDS
  await asUser(db, secretary, (tx) => tx.query(`SELECT public.generate_bills($1,'2026-10-01','2026-10-31','2026-10-10')`, [societyId]));
  const unit = (await db.query(`SELECT id FROM units WHERE society_id=$1`, [societyId])).rows[0].id;
  const pay = (await asUser(db, resident, (tx) => tx.query(
    `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, status)
     VALUES ($1,$2,$3,'PAY-CA1',1180,'625219401292','pending_verification') RETURNING id`, [societyId, unit, resident]))).rows[0].id;
  await asUser(db, treasurer, (tx) => tx.query('SELECT public.verify_payment($1, true)', [pay]));

  ids.guard = (await db.query(`INSERT INTO vendors (society_id,name,phone,gstin) VALUES ($1,'Eagle Guards','9000000001','27AAEFE9921Q1Z8') RETURNING id`, [societyId])).rows[0].id;
  const sec = await expense({ vendor_id: ids.guard, category: 'security', title: 'Guards Oct', subtotal: 40000, gst_amount: 7200, gst_claimable: true,
    tds_amount: 800, tds_section: '194C', tds_rate: 2, invoice_number: 'EG-1', invoice_date: '2026-10-05' });
  await asUser(db, treasurer, (tx) => tx.query(`SELECT public.record_vendor_payment($1,46400,800,'neft','UTR9','2026-10-15')`, [sec]));
});

test('last year\'s audited figures feed the comparative I&E and Balance Sheet', async () => {
  const lines = JSON.stringify([{ code: '4000', amount: -1000000 }, { code: '5100', amount: 400000 }, { code: '1000', amount: 600000 }]);
  await assert.rejects(q(ids.resident, `SELECT public.save_prior_year_balances($1,'2026-03-31',$2)`, [ids.societyId, lines]), /committee or the society's CA/);
  await assert.rejects(q(ids.ca, `SELECT public.save_prior_year_balances($1,'2027-03-31',$2)`, [ids.societyId, lines]), /has ended/);
  const saved = await val(ids.ca, `SELECT public.save_prior_year_balances($1,'2026-03-31',$2)`, [ids.societyId, lines]);
  assert.deepEqual([saved.lines, Number(saved.difference)], [3, 0]);

  const ie = await q(ids.ca, `SELECT code, current, previous, previous_source FROM public.income_expenditure_compare($1,'2026-04-01','2027-03-31')`, [ids.societyId]);
  const row = (c) => ie.find((r) => r.code === c);
  assert.deepEqual([Number(row('4000').current), Number(row('4000').previous), row('4000').previous_source], [1000, 1000000, 'audited']);
  assert.deepEqual([Number(row('5100').current), Number(row('5100').previous)], [40000, 400000], 'GST claimed is not in the expense head');

  const bs = await q(ids.ca, `SELECT code, current, previous, previous_as_of::text d FROM public.balance_sheet_compare($1)`, [ids.societyId]);
  const bank = bs.find((r) => r.code === '1000');
  assert.deepEqual([Number(bank.current), Number(bank.previous), bank.d], [1180 - 46400, 600000, '2026-03-31']);

  // A year without audited figures falls back to the books
  const old = await q(ids.ca, `SELECT DISTINCT previous_source FROM public.income_expenditure_compare($1,'2027-04-01','2028-03-31')`, [ids.societyId]);
  assert.deepEqual(old.map((r) => r.previous_source), ['books']);
  await assert.rejects(q(ids.resident, `SELECT * FROM public.income_expenditure_compare($1,'2026-04-01','2027-03-31')`, [ids.societyId]), /do not have access/);
});

test('Receipts & Payments ties to the bank and cash balance', async () => {
  const rp = await q(ids.ca, `SELECT section, code, amount FROM public.receipts_payments($1,'2026-04-01','2027-03-31')`, [ids.societyId]);
  const get = (s, c) => Number(rp.find((r) => r.section === s && r.code === c)?.amount ?? NaN);
  assert.equal(get('receipt', '1200'), 1180, 'members paid their bill');
  assert.equal(get('payment', '2000'), 46400, 'vendor paid; TDS withheld is not a cash payment');
  const opening = Number(rp.find((r) => r.section === 'opening').amount);
  const closing = Number(rp.find((r) => r.section === 'closing').amount);
  const receipts = rp.filter((r) => r.section === 'receipt').reduce((s, r) => s + Number(r.amount), 0);
  const payments = rp.filter((r) => r.section === 'payment').reduce((s, r) => s + Number(r.amount), 0);
  assert.equal(closing, opening + receipts - payments);
  assert.equal(closing, (await bal('1000')) + (await bal('1100')));
});

test('account ledger: opening row then entries with a running balance', async () => {
  const rows = await q(ids.ca, `SELECT entry_number, narration, debit, credit, balance FROM public.account_ledger($1,'1000','2026-04-01','2027-03-31')`, [ids.societyId]);
  assert.equal(rows[0].narration, 'Opening balance');
  assert.equal(Number(rows[0].balance), 0);
  assert.equal(Number(rows.at(-1).balance), await bal('1000'));
  assert.ok(rows.slice(1).every((r) => r.entry_number?.startsWith('JV-')));
  await assert.rejects(q(ids.ca, `SELECT * FROM public.account_ledger($1,'9999','2026-04-01','2027-03-31')`, [ids.societyId]), /Unknown account/);
});

test('payables ageing, TDS register and GST summary', async () => {
  await expense({ vendor_id: ids.guard, category: 'housekeeping', title: 'Cleaning Aug', subtotal: 8000, invoice_number: 'EG-2', invoice_date: '2026-08-01' });
  const ageing = await q(ids.ca, `SELECT expense_number, payee, outstanding, bucket FROM public.payables_ageing($1,'2026-10-20')`, [ids.societyId]);
  assert.deepEqual(ageing.map((r) => [r.payee, Number(r.outstanding), r.bucket]), [['Eagle Guards', 8000, '61-90']]);

  const tds = await q(ids.ca, `SELECT reference, vendor, pan, entity, section, tds FROM public.tds_register($1,'2026-04-01','2027-03-31')`, [ids.societyId]);
  assert.deepEqual(tds.map((r) => [r.vendor, r.pan, r.entity, r.section, Number(r.tds)]), [['Eagle Guards', 'AAEFE9921Q', 'other', '194C', 800]]);

  await expense({ category: 'repairs', title: 'Paint (no ITC)', subtotal: 10000, gst_amount: 1800, invoice_date: '2026-09-01' });
  const gst = await val(ids.ca, `SELECT public.gst_summary($1,'2026-04-01','2027-03-31')`, [ids.societyId]);
  assert.deepEqual([gst.output_gst, gst.input_claimed, gst.input_not_claimed, gst.net_payable].map(Number), [180, 7200, 1800, -7020]);
});

test('CA proposes a journal; the committee approves it once', async () => {
  const bad = (lines, date = '2026-10-18') => q(ids.ca, `SELECT public.propose_adjustment($1,$2,'Reclassify paint to other',$3)`, [ids.societyId, date, JSON.stringify(lines)]);
  await assert.rejects(bad([{ code: '5900', amount: 500 }, { code: '5000', amount: -400 }]), /must be equal/);
  await assert.rejects(bad([{ code: '1200', amount: 500 }, { code: '4000', amount: -500 }]), /own register/);
  await assert.rejects(bad([{ code: '5900', amount: 500 }, { code: '5000', amount: -500 }], '2099-01-01'), /today or earlier/);
  await assert.rejects(q(ids.resident, `SELECT public.propose_adjustment($1,'2026-10-18','Something here',$2)`,
    [ids.societyId, JSON.stringify([{ code: '5900', amount: 1 }, { code: '5000', amount: -1 }])]), /committee or the society's CA/);

  const p = await val(ids.ca, `SELECT public.propose_adjustment($1,'2026-10-18','Paint is a minor repair, move to other',$2)`,
    [ids.societyId, JSON.stringify([{ code: '5900', amount: 500 }, { code: '5000', amount: -500 }])]);
  assert.equal(p.proposal_number, 'AP-0001');
  const before = { other: await bal('5900'), repairs: await bal('5000') };

  // Nothing is posted until the committee decides; the CA cannot decide or write directly
  assert.equal(await bal('5900'), before.other);
  await assert.rejects(q(ids.ca, 'SELECT public.decide_adjustment($1,true)', [p.id]), /Only the society committee/);
  await assert.rejects(q(ids.ca, `UPDATE adjustment_proposals SET status='approved' WHERE id=$1 RETURNING id`, [p.id]).then((r) => {
    if (r.length === 0) throw new Error('blocked');
  }), /blocked/);

  const d = await val(ids.treasurer, 'SELECT public.decide_adjustment($1,true)', [p.id]);
  assert.equal(d.status, 'approved');
  assert.equal(await bal('5900'), before.other + 500);
  assert.equal(await bal('5000'), before.repairs - 500);
  const j = (await db.query('SELECT reference_event_type t, narration FROM journal_entries WHERE id=$1', [d.journal_id])).rows[0];
  assert.equal(j.t, 'adjustment.approved');
  assert.match(j.narration, /^AP-0001 \(Priya CA\): Paint is a minor repair/);
  await assert.rejects(q(ids.secretary, 'SELECT public.decide_adjustment($1,true)', [p.id]), /already approved/);
});

test('committee proposals need another member; rejections need a reason; CAs can withdraw', async () => {
  const lines = JSON.stringify([{ code: '5900', amount: 100 }, { code: '5000', amount: -100 }]);
  const own = await val(ids.secretary, `SELECT public.propose_adjustment($1,'2026-10-18','Secretary correction',$2)`, [ids.societyId, lines]);
  await assert.rejects(q(ids.secretary, 'SELECT public.decide_adjustment($1,true)', [own.id]), /another committee member/);
  await assert.rejects(q(ids.treasurer, 'SELECT public.decide_adjustment($1,false)', [own.id]), /reason for rejecting/);
  assert.equal((await val(ids.treasurer, `SELECT public.decide_adjustment($1,false,'Not needed')`, [own.id])).status, 'rejected');

  const w = await val(ids.ca, `SELECT public.propose_adjustment($1,'2026-10-18','Will redo this one',$2)`, [ids.societyId, lines]);
  await assert.rejects(q(ids.secretary, 'SELECT public.withdraw_adjustment($1)', [w.id]), /not found/);
  assert.equal((await val(ids.ca, 'SELECT public.withdraw_adjustment($1)', [w.id])).status, 'withdrawn');
});

test('capitalising a repair moves it to assets and creates the asset on approval', async () => {
  const pump = await expense({ category: 'repairs', title: 'Replacement 5 HP pump motor', subtotal: 38000, invoice_number: 'AP/552', invoice_date: '2026-10-16' });
  const repairsBefore = await bal('5000');
  const p = await val(ids.ca, `SELECT public.propose_capitalisation($1,'1500','New motor lasts years — capital item')`, [pump]);
  assert.equal(Number(p.amount), 38000);
  await assert.rejects(q(ids.ca, `SELECT public.propose_capitalisation($1,'1500','Same again please')`, [pump]), /already a pending proposal/);

  await val(ids.secretary, 'SELECT public.decide_adjustment($1,true)', [p.id]);
  assert.equal(await bal('5000'), repairsBefore - 38000);
  assert.equal(await bal('1500'), 38000);
  const e = (await db.query('SELECT expense_type, asset_account_code FROM expenses WHERE id=$1', [pump])).rows[0];
  assert.deepEqual([e.expense_type, e.asset_account_code], ['capital', '1500']);
  const fa = (await db.query('SELECT name, cost, put_to_use_date::text d FROM fixed_assets WHERE expense_id=$1', [pump])).rows[0];
  assert.deepEqual([fa.name, Number(fa.cost), fa.d], ['Replacement 5 HP pump motor', 38000, '2026-10-16']);
  await assert.rejects(q(ids.ca, `SELECT public.propose_capitalisation($1,'1500','Again after approval')`, [pump]), /regular expense/);
});

test('locking an audited year: manual entries refused, late system entries move to the open year', async () => {
  // A bill dated last year, recorded before the lock
  await expense({ category: 'repairs', title: 'March repair', subtotal: 2000, invoice_date: '2026-03-10' });

  const lastYear = (lines) => q(ids.ca, `SELECT public.propose_adjustment($1,'2026-03-15','Year-end provision',$2)`, [ids.societyId, JSON.stringify(lines)]);
  const pending = (await lastYear([{ code: '5300', amount: 1500 }, { code: '5900', amount: -1500 }]))[0].propose_adjustment;

  await assert.rejects(q(ids.ca, `SELECT public.lock_financial_year($1,'2026-03-31')`, [ids.societyId]), /Only the society committee/);
  await assert.rejects(q(ids.secretary, `SELECT public.lock_financial_year($1,'2027-03-31')`, [ids.societyId]), /has ended/);
  await assert.rejects(q(ids.secretary, `SELECT public.lock_financial_year($1,'2026-03-31')`, [ids.societyId]), /pending adjustment/);
  await val(ids.treasurer, `SELECT public.decide_adjustment($1,false,'Provision not required')`, [pending.id]);

  const locked = await val(ids.secretary, `SELECT public.lock_financial_year($1,'2026-03-31','Audited by Priya CA')`, [ids.societyId]);
  assert.equal(locked.locked_until, '2026-03-31');
  await assert.rejects(q(ids.secretary, `SELECT public.lock_financial_year($1,'2026-03-31')`, [ids.societyId]), /already locked/);

  // Manual entries into the locked year are refused
  await assert.rejects(lastYear([{ code: '5300', amount: 1 }, { code: '5900', amount: -1 }]), /locked after audit/);
  await q(ids.secretary, `SELECT public.add_existing_asset($1,'Old DG set','1500','2019-01-01',100000,50000,'2025-04-01')`, [ids.societyId]);
  await assert.rejects(q(ids.secretary, `SELECT public.post_depreciation($1,'2026-03-31')`, [ids.societyId]), /locked after audit/);

  // A late vendor bill dated in the locked year lands on 1 April with a note
  const late = await expense({ category: 'repairs', title: 'Late March bill', subtotal: 3000, invoice_date: '2026-03-20' });
  const j = (await db.query(`SELECT entry_date::text d, narration FROM journal_entries WHERE reference_event_id=$1`, [late])).rows[0];
  assert.equal(j.d, '2026-04-01');
  assert.match(j.narration, /\[dated 20-Mar-2026; that year is locked\]/);
  const lineDates = (await db.query(`SELECT DISTINCT l.date::text d FROM ledger_entries l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.reference_event_id=$1`, [late])).rows;
  assert.deepEqual(lineDates, [{ d: '2026-04-01' }], 'ledger lines follow the journal date');

  // The committee cannot unlock
  await assert.rejects(q(ids.secretary, `SELECT public.unlock_financial_year($1,'2026-03-31','oops')`, [ids.societyId]), /Sahvaas support/);
  assert.equal(await val(ids.ca, 'SELECT public.books_locked_until($1)::text', [ids.societyId]), '2026-03-31');
});
