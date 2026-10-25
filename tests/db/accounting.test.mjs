// 013: chart of accounts v2, TDS rules, accrual on approval, partial vendor payments,
// TDS challans, no-invoice vouchers, fixed assets and depreciation.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser, applyMigration, migrationFiles } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const one = async (user, sql, params = []) => (await q(user, sql, params))[0];
const tb = async (sid) => Object.fromEntries((await db.query(
  `SELECT a.code, sum(l.amount)::numeric bal FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
   WHERE l.society_id = $1 GROUP BY 1 HAVING sum(l.amount) <> 0`, [sid])).rows.map((r) => [r.code, Number(r.bal)]));
const respond = (user, kind, id) => q(user, 'SELECT public.respond_to_invite($1,$2,true)', [kind, id]);

const vendor = (name, gstin, pan = null) => db.query(
  `INSERT INTO vendors (society_id, name, phone, gstin, pan) VALUES ($1,$2,'9000000000',$3,$4) RETURNING id, pan`,
  [ids.societyId, name, gstin, pan]).then((r) => r.rows[0]);

// Maker = treasurer, approver = secretary (single-step approval for brevity)
const addExpense = (fields) => {
  const cols = { society_id: ids.societyId, category: 'repairs', title: 'Bill', subtotal: 0, ...fields };
  const keys = Object.keys(cols);
  return one(ids.treasurer,
    `INSERT INTO expenses (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
    keys.map((k) => cols[k]));
};
const approve = (id) => one(ids.secretary, 'SELECT public.decide_expense($1, true) AS r', [id]);
const pay = (id, amount, tds = null, mode = 'neft', paidOn = '2026-10-16') =>
  one(ids.treasurer, 'SELECT public.record_vendor_payment($1,$2,$3,$4,$5,$6) AS r', [id, amount, tds, mode, 'UTR-1', paidOn]).then((r) => r.r);
const suggest = (vendorId, category, taxable, date = '2026-10-14') =>
  one(ids.treasurer, 'SELECT public.suggest_tds($1,$2,$3,$4,$5) AS r', [ids.societyId, vendorId, category, taxable, date]).then((r) => r.r);

before(async () => {
  db = await createDb();
  const secretary = await createUser(db, 'sec@acc.test');
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Acc Heights','Road','Pune','Maharashtra','411001','sec@acc.test','9876543210') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }])]);
    await tx.query('UPDATE society_settings SET require_two_step_expense_approval = false WHERE society_id = $1', [id]);
    for (const [email, role, unit] of [['tre@acc.test', 'treasurer', null], ['res@acc.test', 'resident_owner', '101']]) {
      await tx.query(
        `INSERT INTO member_invites (society_id,email,role,unit_id,invited_by)
         VALUES ($1,$2,$3,(SELECT id FROM units WHERE society_id=$1 AND unit_number=$4),$5)`, [id, email, role, unit, secretary]);
    }
    return id;
  });
  const treasurer = await createUser(db, 'tre@acc.test');
  const resident = await createUser(db, 'res@acc.test');
  for (const u of [treasurer, resident]) await asUser(db, u, (tx) => tx.query('SELECT public.claim_my_invites()'));
  ids = { societyId, secretary, treasurer, resident };
});

test('chart of accounts v2 is seeded for new societies', async () => {
  const codes = (await db.query('SELECT code FROM accounts WHERE society_id=$1', [ids.societyId])).rows.map((r) => r.code);
  assert.equal(codes.length, 33);
  for (const c of ['1300', '1540', '1590', '4300', '5600', '5800', '5850']) assert.ok(codes.includes(c), `has ${c}`);
});

test('vendor PAN comes from the GSTIN; the 4th letter decides the TDS rate', async () => {
  const company = await vendor('SecureVision Systems Pvt Ltd', '27aakcs5521p1z6');
  assert.equal(company.pan, 'AAKCS5521P');
  ids.company = company.id;

  const s = await suggest(company.id, 'cctv', 100000);
  assert.equal(s.applies, true);
  assert.equal(s.reason, 'single_bill');
  assert.equal(s.section, '194C');
  assert.equal(s.entity, 'other');
  assert.equal(Number(s.rate), 2);
  assert.equal(Number(s.amount), 2000);

  const person = await vendor('Ramesh Pawar', null, 'ABCPP1234K');
  ids.person = person.id;
  const small = await suggest(person.id, 'plumbing', 1800);
  assert.deepEqual([small.applies, small.reason, Number(small.amount)], [false, 'below_limits', 0]);

  const noPan = await vendor('Cash Painter', null);
  const np = await suggest(noPan.id, 'painting', 40000);
  assert.deepEqual([np.rate_source, Number(np.rate), Number(np.amount)], ['no_pan', 20, 8000]);

  const goods = await suggest(company.id, 'furniture', 90000);
  assert.deepEqual([goods.applies, goods.reason], [false, 'goods']);
  const fees = await suggest(person.id, 'legal_audit', 40000);
  assert.deepEqual([fees.applies, fees.reason], [false, 'below_limits'], '194J limit is ₹50,000 a year');

  await assert.rejects(q(ids.resident, 'SELECT public.suggest_tds($1,$2,$3,$4)', [ids.societyId, company.id, 'cctv', 100000]),
    /Only the society committee/);
});

test('crossing the yearly limit deducts TDS on the year\'s earlier untaxed bills too', async () => {
  const guard = await vendor('Solo Guard', null, 'AAAPG1111A');
  for (const [i, d] of ['2026-06-10', '2026-07-10', '2026-08-10', '2026-09-10'].entries()) {
    const e = await addExpense({ vendor_id: guard.id, category: 'security', title: `Guard ${i}`, subtotal: 25000, invoice_number: `G-${i}`, invoice_date: d });
    await approve(e.id);
  }
  const s = await suggest(guard.id, 'security', 25000, '2026-10-10');
  assert.equal(s.reason, 'annual_total');
  assert.equal(Number(s.fy_total), 125000);
  assert.equal(Number(s.base), 125000, 'current bill + ₹1,00,000 earlier bills without TDS');
  assert.equal(Number(s.amount), 1250, '1% individual');
});

test('lower-deduction certificate overrides the rate until it expires', async () => {
  await db.query(`UPDATE vendors SET tds_override_rate = 0.5, tds_override_valid_till = '2027-03-31' WHERE id = $1`, [ids.company]);
  const s = await suggest(ids.company, 'cctv', 100000);
  assert.deepEqual([s.rate_source, Number(s.amount)], ['certificate', 500]);
  await db.query(`UPDATE vendors SET tds_override_valid_till = '2026-09-30' WHERE id = $1`, [ids.company]);
  assert.equal(Number((await suggest(ids.company, 'cctv', 100000)).amount), 2000);
  await db.query(`UPDATE vendors SET tds_override_rate = NULL, tds_override_valid_till = NULL WHERE id = $1`, [ids.company]);
});

test('changing the suggested TDS needs a reason; duplicate invoices are blocked', async () => {
  await assert.rejects(
    addExpense({ vendor_id: ids.company, category: 'repairs', subtotal: 50000, tds_amount: 0, tds_suggested: 1000, invoice_number: 'X-1' }),
    /differs from the suggested/
  );
  const ok = await addExpense({ vendor_id: ids.company, category: 'repairs', subtotal: 50000, tds_amount: 0, tds_suggested: 1000,
    tds_override_reason: 'Material only, no labour', invoice_number: 'X-1' });
  assert.equal(ok.status, 'pending_approval');
  await assert.rejects(addExpense({ vendor_id: ids.company, category: 'repairs', subtotal: 10, invoice_number: ' x-1 ' }),
    /already recorded as EXP-/);
});

test('a capital purchase posts to the asset account and creates the fixed asset on approval', async () => {
  const e = await addExpense({
    vendor_id: ids.company, category: 'cctv', title: 'CCTV 8 cameras + NVR', expense_type: 'capital',
    subtotal: 100000, gst_amount: 18000, tds_amount: 2000, tds_suggested: 2000, invoice_number: 'SVS/1187', invoice_date: '2026-10-14',
    asset_location: 'Gate + lobbies',
  });
  assert.equal(e.asset_account_code, '1540', 'asset type taken from the category');
  const before = await tb(ids.societyId);
  await approve(e.id);

  const lines = (await db.query(
    `SELECT a.code, l.amount FROM ledger_entries l JOIN accounts a ON a.id=l.account_id JOIN journal_entries j ON j.id=l.journal_entry_id
     WHERE j.reference_event_type='expense.approved' AND j.reference_event_id=$1 ORDER BY a.code`, [e.id])).rows.map((r) => [r.code, Number(r.amount)]);
  assert.deepEqual(lines, [['1540', 118000], ['2000', -118000]]);

  const fa = (await db.query('SELECT asset_number, cost, dep_rate, put_to_use_date::text d, location FROM fixed_assets WHERE expense_id=$1', [e.id])).rows[0];
  assert.deepEqual([fa.asset_number, Number(fa.cost), Number(fa.dep_rate), fa.d, fa.location], ['FA-0001', 118000, 15, '2026-10-14', 'Gate + lobbies']);

  const ie = await q(ids.secretary, `SELECT code FROM public.income_expenditure($1,'2026-04-01','2027-03-31')`, [ids.societyId]);
  assert.ok(!ie.some((r) => r.code === '1540'), 'an asset is not in Income & Expenditure');
  assert.equal(before['5000'] ?? 0, (await tb(ids.societyId))['5000'] ?? 0, 'repairs head untouched');
  ids.cctv = e.id;

  // Locked after approval
  await assert.rejects(q(ids.treasurer, `UPDATE expenses SET expense_type='revenue' WHERE id=$1`, [e.id]), /cannot be edited/);
});

test('claimable GST goes to GST input instead of the asset cost', async () => {
  const e = await addExpense({ vendor_id: ids.company, category: 'generator', title: 'DG set', expense_type: 'capital',
    subtotal: 50000, gst_amount: 9000, gst_claimable: true, tds_amount: 1000, invoice_number: 'SVS/1200', invoice_date: '2026-10-01' });
  await approve(e.id);
  const lines = (await db.query(
    `SELECT a.code, l.amount FROM ledger_entries l JOIN accounts a ON a.id=l.account_id JOIN journal_entries j ON j.id=l.journal_entry_id
     WHERE j.reference_event_id=$1 ORDER BY a.code`, [e.id])).rows.map((r) => [r.code, Number(r.amount)]);
  assert.deepEqual(lines, [['1300', 9000], ['1500', 50000], ['2000', -59000]]);
  assert.equal(Number((await db.query('SELECT cost FROM fixed_assets WHERE expense_id=$1', [e.id])).rows[0].cost), 50000);
});

test('partial payments: TDS once, no overpaying, final payment clears the creditor', async () => {
  await assert.rejects(pay(ids.cctv, 50000, 2500), /at most ₹2000/);
  await assert.rejects(pay(ids.cctv, 120000, 0), /more than the ₹118000/);
  await assert.rejects(pay(ids.cctv, 1000, 0, 'neft', '2099-01-01'), /future/);
  await assert.rejects(q(ids.resident, 'SELECT public.record_vendor_payment($1,1)', [ids.cctv]), /Only the society committee/);

  const first = await pay(ids.cctv, 58000, 2000);
  assert.deepEqual([first.status, Number(first.outstanding), first.payment_number], ['partial', 58000, 'VP-0001']);
  const row = (await db.query('SELECT status, payment_status, amount_settled, tds_deducted FROM expenses WHERE id=$1', [ids.cctv])).rows[0];
  assert.deepEqual([row.status, row.payment_status, Number(row.amount_settled), Number(row.tds_deducted)], ['approved', 'partial', 60000, 2000]);

  await assert.rejects(q(ids.treasurer, 'UPDATE expenses SET amount_settled = 0 WHERE id=$1', [ids.cctv]), /payment workflow/);
  await assert.rejects(q(ids.treasurer, `INSERT INTO vendor_payments (society_id, expense_id, payment_number, paid_on, amount, mode)
    VALUES ($1,$2,'VP-9','2026-10-16',1,'neft')`, [ids.societyId, ids.cctv]), /row-level security/);

  const final = await pay(ids.cctv, 58000, null, 'upi', '2026-10-18');
  assert.deepEqual([final.status, Number(final.outstanding)], ['paid', 0]);
  const b = await tb(ids.societyId);
  assert.equal(b['1540'], 118000);
  assert.equal(b['2200'], -2000);
  assert.equal(b['1000'], -116000);
});

test('the final payment must carry any TDS still due', async () => {
  const e = await addExpense({ vendor_id: ids.company, category: 'lift_amc', title: 'Lift AMC', subtotal: 40000, tds_amount: 800, invoice_number: 'AMC-1', invoice_date: '2026-10-02' });
  await approve(e.id);
  await assert.rejects(pay(e.id, 40000, 0), /Deduct the remaining TDS ₹800/);
  await assert.rejects(pay(e.id, 40000, 800), /more than the ₹40000/);
  const r = await pay(e.id, 39200);
  assert.equal(r.status, 'paid', 'TDS defaults to what is still due');
});

test('TDS challans clear TDS payable and cannot exceed it', async () => {
  const payable = -(await tb(ids.societyId))['2200'];
  await assert.rejects(q(ids.secretary, `SELECT public.record_tds_challan($1,'CH-1',$2,'2026-10-19','2026-10-01','194C')`, [ids.societyId, payable + 1]),
    /waiting to be deposited/);
  const r = await one(ids.secretary, `SELECT public.record_tds_challan($1,'CH-1',$2,'2026-10-19','2026-10-01','194C') AS r`, [ids.societyId, payable]);
  assert.equal(Number(r.r.remaining), 0);
  assert.equal((await tb(ids.societyId))['2200'], undefined);
});

test('no-invoice voucher: payee + proof required, PV number, no GST, cash limit', async () => {
  const proof = `${ids.societyId}/expenses/work-photo.jpg`;
  await assert.rejects(addExpense({ invoice_status: 'none', category: 'plumbing', subtotal: 1800, document_url: proof }), /payee name/);
  await assert.rejects(addExpense({ invoice_status: 'none', category: 'plumbing', subtotal: 1800, payee_name: 'Ramesh' }), /photo of the work/);
  await assert.rejects(addExpense({ invoice_status: 'none', category: 'plumbing', subtotal: 1800, gst_amount: 324, payee_name: 'Ramesh', document_url: proof }),
    /tax invoice/);
  const v = await addExpense({ invoice_status: 'none', category: 'plumbing', title: 'Burst pipe', subtotal: 1800, payee_name: 'Ramesh Pawar', document_url: proof });
  assert.equal(v.voucher_number, 'PV-0001');
  await approve(v.id);
  assert.equal((await pay(v.id, 1800, 0, 'cash')).status, 'paid');

  const big = await addExpense({ invoice_status: 'none', category: 'repairs', title: 'Big cash job', subtotal: 9000, payee_name: 'Mukesh', document_url: proof });
  await approve(big.id);
  await assert.rejects(pay(big.id, 9000, 0, 'cash'), /limited to ₹5000/);
  assert.equal((await pay(big.id, 9000, 0, 'upi')).status, 'paid');
  assert.equal(Number((await tb(ids.societyId))['1100']), -1800, 'cash voucher paid from cash in hand');
});

test('invoice comes later: record now, attach after payment', async () => {
  const e = await addExpense({ invoice_status: 'pending', vendor_id: ids.person, category: 'electrical', title: 'Emergency wiring', subtotal: 6000 });
  assert.ok(e.invoice_due_by, 'due date set (7 days)');
  await approve(e.id);
  await pay(e.id, 6000, 0);
  await assert.rejects(q(ids.treasurer, 'SELECT public.attach_expense_invoice($1,$2)', [e.id, 'other-society/x.pdf']), /Upload the invoice/);
  await q(ids.treasurer, `SELECT public.attach_expense_invoice($1,$2,'EL-55','2026-10-17')`, [e.id, `${ids.societyId}/expenses/el-55.pdf`]);
  const r = (await db.query('SELECT invoice_status, invoice_number, status FROM expenses WHERE id=$1', [e.id])).rows[0];
  assert.deepEqual([r.invoice_status, r.invoice_number, r.status], ['invoice', 'EL-55', 'paid']);
});

test('voiding after a partial payment reverses the payment and the accrual', async () => {
  const before = await tb(ids.societyId);
  const e = await addExpense({ vendor_id: ids.company, category: 'pump_motor', title: 'Pump', expense_type: 'capital', subtotal: 30000, invoice_number: 'P-1', invoice_date: '2026-10-05' });
  await approve(e.id);
  await pay(e.id, 10000, 0);
  const v = await one(ids.secretary, `SELECT public.void_expense($1,'Wrong vendor') AS r`, [e.id]);
  assert.deepEqual(v.r, { status: 'voided', reversed: true });
  assert.deepEqual(await tb(ids.societyId), before);
  assert.equal((await db.query('SELECT status FROM fixed_assets WHERE expense_id=$1', [e.id])).rows[0].status, 'voided');
  assert.equal((await db.query(`SELECT count(*)::int n FROM vendor_payments WHERE expense_id=$1 AND status='voided'`, [e.id])).rows[0].n, 1);
});

test('depreciation: preview, half rate for new assets, once per year, then disposal', async () => {
  const gen = (await one(ids.secretary,
    `SELECT public.add_existing_asset($1,'Old generator','1500','2019-06-01',300000,100000,'2025-04-01') AS id`, [ids.societyId])).id;

  const p26 = await q(ids.secretary, `SELECT asset_number, opening_wdv, additions, rate, half_rate, depreciation, closing_wdv
                                      FROM public.preview_depreciation($1,'2027-03-31')`, [ids.societyId]);
  const cctv = p26.find((r) => Number(r.additions) === 118000);
  assert.deepEqual([cctv.half_rate, Number(cctv.depreciation), Number(cctv.closing_wdv)], [true, 8850, 109150], 'used < 180 days: 7.5%');
  const dg = p26.find((r) => Number(r.additions) === 50000);
  assert.deepEqual([dg.half_rate, Number(dg.depreciation)], [false, 7500], 'used 182 days: full 15%');

  await assert.rejects(q(ids.secretary, `SELECT public.post_depreciation($1,'2027-03-31')`, [ids.societyId]), /can be posted from/);
  await assert.rejects(q(ids.secretary, `SELECT public.post_depreciation($1,'2026-03-30')`, [ids.societyId]), /ends on 31 March/);
  await assert.rejects(q(ids.resident, `SELECT * FROM public.preview_depreciation($1,'2026-03-31')`, [ids.societyId]), /do not have access/);

  const run = (await one(ids.secretary, `SELECT public.post_depreciation($1,'2026-03-31') AS r`, [ids.societyId])).r;
  assert.deepEqual([Number(run.total), run.assets], [15000, 1], 'only the generator existed in FY 2025-26');
  const b = await tb(ids.societyId);
  assert.equal(b['5800'], 15000);
  assert.equal(b['1590'], -15000);
  await assert.rejects(q(ids.secretary, `SELECT public.post_depreciation($1,'2026-03-31')`, [ids.societyId]), /already posted/);

  const next = await q(ids.secretary, `SELECT opening_wdv, depreciation FROM public.preview_depreciation($1,'2027-03-31') WHERE asset_id=$2`, [ids.societyId, gen]);
  assert.deepEqual([Number(next[0].opening_wdv), Number(next[0].depreciation)], [85000, 12750]);

  // Rate change needs a reason
  await assert.rejects(q(ids.secretary, `SELECT public.update_asset($1,'Old generator',NULL,20,'wdv')`, [gen]), /reason/);

  // Sold for 70,000: book value 85,000 -> loss 15,000
  const d = (await one(ids.secretary, `SELECT public.dispose_asset($1,'2026-10-19',70000,'bank','Sold to scrap dealer') AS r`, [gen])).r;
  assert.deepEqual([Number(d.book_value), Number(d.gain)], [85000, -15000]);
  const after = await tb(ids.societyId);
  assert.equal(after['4300'], 15000, 'loss is a debit on 4300');
  assert.equal(after['1590'], undefined, 'accumulated depreciation removed with the asset');
});

test('assets with posted depreciation cannot be voided', async () => {
  const e = await addExpense({ vendor_id: ids.company, category: 'computers', title: 'Office PC', expense_type: 'capital', subtotal: 40000, invoice_number: 'PC-1', invoice_date: '2025-05-10' });
  await approve(e.id);
  // Simulate an earlier year's run on this asset
  const fa = (await db.query('SELECT id FROM fixed_assets WHERE expense_id=$1', [e.id])).rows[0].id;
  const run = (await db.query(`INSERT INTO depreciation_runs (society_id, fy_start, fy_end, total) VALUES ($1,'2024-04-01','2025-03-31',1) RETURNING id`, [ids.societyId])).rows[0].id;
  await db.query(`INSERT INTO depreciation_lines (run_id, society_id, asset_id, opening_wdv, additions, rate, half_rate, amount, closing_wdv)
                  VALUES ($1,$2,$3,0,40000,40,false,1,39999)`, [run, ids.societyId, fa]);
  await assert.rejects(q(ids.secretary, `SELECT public.void_expense($1,'oops')`, [e.id]), /record a disposal instead/);
});

test('who can see the new records', async () => {
  const ca = await createUser(db, 'ca@acc.test');
  const inv = (await one(ids.secretary,
    `INSERT INTO professional_invites (society_id, invited_email, role, permissions, invited_by, expires_at)
     VALUES ($1,'ca@acc.test','ca','["view_expenses"]',$2, now() + interval '7 days') RETURNING id`, [ids.societyId, ids.secretary])).id;
  await respond(ca, 'professional', inv);
  const counts = async (user) => one(user, `SELECT (SELECT count(*)::int FROM vendor_payments) vp, (SELECT count(*)::int FROM fixed_assets) fa,
                                                   (SELECT count(*)::int FROM tds_challans) ch, (SELECT count(*)::int FROM tds_rules) rules`);
  const caSees = await counts(ca);
  assert.ok(caSees.vp > 0 && caSees.fa > 0 && caSees.ch > 0, 'CA with view_expenses reads payments, assets, challans');
  const res = await counts(ids.resident);
  assert.deepEqual([res.vp, res.fa, res.ch], [0, 0, 0]);
  assert.equal(res.rules, 5, 'tax rules are public reference data');
  const changed = await asUser(db, ids.secretary, async (tx) => (await tx.query('UPDATE tds_rules SET rate_other = 5')).affectedRows);
  assert.equal(changed, 0, 'only the platform admin edits tax rules');
});

test('approved but unpaid expenses become payables when 013 is applied to an existing database', async () => {
  const old = await createDb({ upTo: '012' });
  const admin = await createUser(old, 'old@acc.test');
  const sid = await asUser(old, admin, async (tx) =>
    (await tx.query(`SELECT public.create_society('Old CHS','Road','Pune','Maharashtra','411001','old@acc.test','9876543210') AS id`)).rows[0].id);
  const e = (await old.query(`INSERT INTO expenses (society_id, category, title, subtotal, gst_amount, status) VALUES ($1,'security','Guards',10000,1800,'approved') RETURNING id`, [sid])).rows[0].id;
  const paid = (await old.query(`INSERT INTO expenses (society_id, category, title, subtotal, status, payment_status, paid_date) VALUES ($1,'housekeeping','Cleaning',3000,'paid','paid','2026-09-30') RETURNING id`, [sid])).rows[0].id;
  for (const f of migrationFiles().filter((x) => x.slice(0, 3) > '012')) await applyMigration(old, f);

  const j = (await old.query(`SELECT reference_event_type t FROM journal_entries WHERE reference_event_id=$1`, [e])).rows.map((r) => r.t);
  assert.deepEqual(j, ['expense.approved']);
  const p = (await old.query('SELECT amount_settled FROM expenses WHERE id=$1', [paid])).rows[0];
  assert.equal(Number(p.amount_settled), 3000, 'already-paid rows count as settled');
  assert.equal((await old.query('SELECT count(*)::int n FROM accounts WHERE society_id=$1', [sid])).rows[0].n, 33);
});
