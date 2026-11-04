// 026: the CA enters the opening balance (audited sheet, catch-up, flat-wise and vendor-wise balances at go-live);
// the committee approves it; only then does it reach the books.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';
import { inviteProfessional, approveOpening } from './opening-helpers.mjs';

let db;
let A;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];

/** A society with flats 101, 102, 103 (owners on 101 and 102 only), a secretary, a treasurer, a CA and one vendor. */
async function makeSociety(tag) {
  const secretary = await createUser(db, `sec@${tag}.ob.test`);
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society($1,'Road','Pune','Maharashtra','411001',$2,'9876543210') AS id`,
      [`Opening Heights ${tag}`, `sec@${tag}.ob.test`])).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }, { unit_number: '102' }, { unit_number: '103' }])]);
    for (const flat of ['101', '102']) {
      await tx.query(`INSERT INTO member_invites (society_id,email,role,unit_id,invited_by)
        SELECT $1,$2,'resident_owner',id,$3 FROM units WHERE society_id=$1 AND unit_number=$4`, [id, `r${flat}@${tag}.ob.test`, secretary, flat]);
    }
    await tx.query(`INSERT INTO member_invites (society_id,email,role,invited_by) VALUES ($1,$2,'treasurer',$3)`, [id, `tre@${tag}.ob.test`, secretary]);
    return id;
  });
  const r101 = await createUser(db, `r101@${tag}.ob.test`);
  const r102 = await createUser(db, `r102@${tag}.ob.test`);
  const treasurer = await createUser(db, `tre@${tag}.ob.test`);
  for (const u of [r101, r102, treasurer]) await asUser(db, u, (tx) => tx.query('SELECT public.claim_my_invites()'));
  const ca = await inviteProfessional(db, { societyId, inviter: secretary, email: `ca@${tag}.ob.test` });
  const unit = async (n) => (await db.query('SELECT id FROM units WHERE society_id=$1 AND unit_number=$2', [societyId, n])).rows[0].id;
  const vendor = (await db.query(`INSERT INTO vendors (society_id, name, phone, pan) VALUES ($1,'Shiv Lifts','9000000000','ABCPP1234K') RETURNING id`,
    [societyId])).rows[0].id;
  return { societyId, secretary, treasurer, r101, r102, ca, u101: await unit('101'), u102: await unit('102'), u103: await unit('103'), vendor };
}

const AUDITED = [
  { code: '3000', amount: -60000, side: 'liabilities', label: 'Sinking Fund' },
  { code: '3200', amount: -20000, side: 'liabilities', label: 'Reserve Fund' },
  { code: '2000', amount: -8000, side: 'liabilities' },
  { code: '2300', amount: -1000, side: 'liabilities' },
  { code: '1000', amount: 80000, side: 'assets' },
  { code: '1200', amount: 9000, side: 'assets' },
];
const CATCHUP = [
  { code: '4000', amount: -54000 }, { code: '5100', amount: 20000 }, { code: '1200', amount: -4000 },
  { code: '2300', amount: -500 }, { code: '2000', amount: 5000 }, { code: '1000', amount: 33500 },
];
const flatsA = () => [{ unit_id: A.u101, amount: 5000 }, { unit_id: A.u102, amount: -1500 }];
const vendorsA = () => [{ vendor_id: A.vendor, amount: 3000 }];

const save = (s, user, d) => val(user, 'SELECT public.save_opening_balance($1,$2,$3,$4,$5,$6,$7)', [s.societyId,
  d.audited_as_of ?? '2026-03-31', d.live_on ?? '2026-10-01', JSON.stringify(d.audited ?? []), JSON.stringify(d.catchup ?? []),
  JSON.stringify(d.flats ?? []), JSON.stringify(d.vendors ?? [])]);
const show = (s, user) => val(user, 'SELECT public.opening_balance($1)', [s.societyId]);

before(async () => {
  db = await createDb();
  A = await makeSociety('a');
});

test('only the CA prepares the opening balance; the committee reads it; residents cannot', async () => {
  await assert.rejects(save(A, A.secretary, { audited: AUDITED }), /Only the society's CA or accountant can prepare the opening balance/);
  await assert.rejects(show(A, A.r101), /do not have access/);
  const empty = await show(A, A.secretary);
  assert.equal(empty.status, 'none');
  assert.deepEqual(empty.flats.map((f) => [f.name, f.owner_name !== null]), [['Flat 101', true], ['Flat 102', true], ['Flat 103', false]]);
  assert.deepEqual(empty.vendors.map((v) => v.name), ['Shiv Lifts']);
});

test('a draft saves as entered, even unbalanced, and shows each difference', async () => {
  const d = await save(A, A.ca, { audited: [...AUDITED.filter((l) => l.code !== '1000'), { code: '1100', amount: 0, side: 'assets' }] });
  assert.equal(d.status, 'draft');
  assert.equal(d.audited_lines.length, 5, 'zero line dropped');
  assert.equal(Number(d.checks.audited_difference), -80000);
  assert.deepEqual([Number(d.checks.dues_expected), Number(d.checks.dues_entered)], [9000, 0]);
  const logs = await db.query(`SELECT count(*)::int n FROM audit_logs WHERE society_id=$1 AND action='opening_balance.saved'`, [A.societyId]);
  assert.ok(logs.rows[0].n >= 1);
});

test('a draft refuses impossible dates, ledgers, flats and vendors', async () => {
  await assert.rejects(save(A, A.ca, { audited_as_of: '2026-03-30' }), /must be a 31 March/);
  await assert.rejects(save(A, A.ca, { live_on: '2026-03-30' }), /on or after the audited balance sheet date/);
  await assert.rejects(save(A, A.ca, { live_on: '2999-01-01' }), /not in the future/);
  await assert.rejects(save(A, A.ca, { audited: [{ code: '9999', amount: 5, side: 'assets' }] }), /Unknown ledger 9999/);
  await assert.rejects(save(A, A.ca, { audited: [{ code: '4000', amount: -5, side: 'liabilities' }] }), /cannot use 4000/);
  await assert.rejects(save(A, A.ca, { flats: [{ unit_id: A.u101, amount: 1 }, { unit_id: A.u101, amount: 2 }] }), /Each flat appears once/);
  await assert.rejects(save(A, A.ca, { vendors: [{ vendor_id: A.vendor, amount: -5 }] }), /positive amounts/);
});

const submit = (s, user) => val(user, 'SELECT public.submit_opening_balance($1)', [s.societyId]);
const reopen = (s, user) => val(user, 'SELECT public.reopen_opening_balance($1)', [s.societyId]);

test('submit refuses until every part ties, then sends it to the committee', async () => {
  await save(A, A.ca, {});
  await assert.rejects(submit(A, A.ca), /Nothing to submit/);
  await save(A, A.ca, { audited: AUDITED.slice(1) });
  await assert.rejects(submit(A, A.ca), /The balance sheet does not tally — the two sides differ by ₹60,000\.00/);
  await save(A, A.ca, { audited: AUDITED, catchup: CATCHUP.slice(1) });
  await assert.rejects(submit(A, A.ca), /The catch-up entry does not tally/);
  await save(A, A.ca, { audited: AUDITED, catchup: CATCHUP, flats: [{ unit_id: A.u101, amount: 4000 }, { unit_id: A.u102, amount: -1500 }] });
  await assert.rejects(submit(A, A.ca), /Flat-wise dues add up to ₹4,000\.00 but Members' dues come to ₹5,000\.00/);
  await save(A, A.ca, { audited: AUDITED, catchup: CATCHUP, flats: [{ unit_id: A.u101, amount: 5000 }] });
  await assert.rejects(submit(A, A.ca), /Flat-wise advances add up to ₹0\.00 but Advances from members come to ₹1,500\.00/);
  await save(A, A.ca, { audited: AUDITED, catchup: CATCHUP, flats: flatsA(), vendors: [{ vendor_id: A.vendor, amount: 3500 }] });
  await assert.rejects(submit(A, A.ca), /more than Sundry Creditors of ₹3,000\.00/);
  await save(A, A.ca, { audited: AUDITED, catchup: CATCHUP, vendors: vendorsA(),
    flats: [{ unit_id: A.u101, amount: 4000 }, { unit_id: A.u103, amount: 1000 }, { unit_id: A.u102, amount: -1500 }] });
  await assert.rejects(submit(A, A.ca), /Flat 103 has no owner linked/);
  await assert.rejects(submit(A, A.secretary), /Only the society's CA or accountant/);

  await save(A, A.ca, { audited: AUDITED, catchup: CATCHUP, flats: flatsA(), vendors: vendorsA() });
  assert.equal((await submit(A, A.ca)).status, 'submitted');
});

test('a submitted opening balance is changed only after withdrawing it', async () => {
  await assert.rejects(save(A, A.ca, { audited: AUDITED }), /waiting for the committee — withdraw it/);
  await assert.rejects(reopen(A, A.secretary), /Only the society's CA or accountant/);
  assert.equal((await reopen(A, A.ca)).status, 'draft');
  await assert.rejects(reopen(A, A.ca), /Only a submitted opening balance can be withdrawn/);
  assert.equal((await submit(A, A.ca)).status, 'submitted');
});

const decide = (s, user, ok, note = null) => val(user, 'SELECT public.decide_opening_balance($1,$2,$3)', [s.societyId, ok, note]);
async function codeBalances(s, asOf) {
  const { rows } = await db.query(
    `SELECT a.code, sum(l.amount) AS bal FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
     WHERE l.society_id = $1 AND l.date <= $2 GROUP BY a.code HAVING sum(l.amount) <> 0 ORDER BY a.code`, [s.societyId, asOf]);
  return Object.fromEntries(rows.map((r) => [r.code, Number(r.bal)]));
}
const parties = (s, kind, asOf = null) => val(s.treasurer, 'SELECT public.party_balances($1,$2,$3)', [s.societyId, kind, asOf]);

test('the committee decides; rejecting needs a reason and sends it back to the CA', async () => {
  await assert.rejects(decide(A, A.ca, true), /Only the society committee can approve/);
  await assert.rejects(decide(A, A.r101, true), /Only the society committee can approve/);
  await assert.rejects(decide(A, A.secretary, false), /Give a reason/);
  const back = await decide(A, A.secretary, false, 'Sinking fund is from the draft audit');
  assert.equal(back.status, 'rejected');
  const d = await show(A, A.ca);
  assert.deepEqual([d.status, d.decision_note], ['draft', 'Sinking fund is from the draft audit']);
  await submit(A, A.ca);
});

test('a locked audited year stops approval and nothing is half-posted', async () => {
  const B = await makeSociety('b');
  await save(B, B.ca, { audited: AUDITED, catchup: CATCHUP, flats: [{ unit_id: B.u101, amount: 5000 }, { unit_id: B.u102, amount: -1500 }] });
  await submit(B, B.ca);
  await q(B.secretary, `SELECT public.lock_financial_year($1,'2026-03-31')`, [B.societyId]);
  await assert.rejects(decide(B, B.treasurer, true), /locked after audit/);
  assert.equal((await show(B, B.ca)).status, 'submitted');
  const n = await db.query(`SELECT (SELECT count(*) FROM journal_entries WHERE society_id=$1 AND reference_event_type LIKE 'opening.%')::int j,
    (SELECT count(*) FROM bills WHERE society_id=$1)::int b`, [B.societyId]);
  assert.deepEqual(n.rows[0], { j: 0, b: 0 });
});

test('approval posts the audited sheet on 31 March and the catch-up on the go-live date', async () => {
  const r = await decide(A, A.treasurer, true);
  assert.deepEqual([r.status, r.opening_bills], ['approved', 1]);
  assert.deepEqual(await codeBalances(A, '2026-03-31'), { 1000: 80000, 1200: 9000, 2000: -8000, 2300: -1000, 3000: -60000, 3200: -20000 });
  assert.deepEqual(await codeBalances(A, '2026-10-01'),
    { 1000: 113500, 1200: 5000, 2000: -3000, 2300: -1500, 3000: -60000, 3200: -20000, 4000: -54000, 5100: 20000 });
  const ob = (await db.query(`SELECT bill_number, bill_date::text d, total_amount, is_opening_balance FROM bills WHERE society_id=$1`, [A.societyId])).rows;
  assert.deepEqual(ob.map((b) => [b.bill_number, b.d, Number(b.total_amount), b.is_opening_balance]), [['OB-0001', '2026-10-01', 5000, true]]);
  await assert.rejects(save(A, A.ca, { audited: AUDITED }), /already approved — correct it with an adjustment/);
});

test('flat-wise and vendor-wise ledgers tie to the control ledgers before and after go-live', async () => {
  for (const asOf of ['2026-09-30', '2026-10-01']) {
    const f = await parties(A, 'flat', asOf);
    assert.equal(f.parties.reduce((s, p) => s + Number(p.dues), 0), Number(f.control.dues), asOf);
    assert.equal(f.parties.reduce((s, p) => s + Number(p.advance), 0), Number(f.control.advance), asOf);
  }
  const live = await parties(A, 'flat', '2026-10-01');
  assert.deepEqual(live.parties.filter((p) => Number(p.balance) !== 0).map((p) => [p.name, Number(p.dues), Number(p.advance)]),
    [['Flat 101', 5000, 0], ['Flat 102', 0, 1500]]);
  const v = await parties(A, 'vendor', '2026-10-01');
  assert.deepEqual(v.parties.filter((p) => Number(p.balance) !== 0).map((p) => [p.name, Number(p.balance)]), [['Shiv Lifts', 3000]]);
  assert.equal(Number(v.control.payable), 3000);
});

test('the secretary can no longer post opening balances directly', async () => {
  await assert.rejects(q(A.secretary, `SELECT public.post_opening_balances($1,'2026-03-31','[]','[]')`, [A.societyId]),
    /entered by the society's CA/);
});

test("a flat's opening advance pays its next bill first", async () => {
  await q(A.secretary, `INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Maintenance','flat_per_unit',1000)`, [A.societyId]);
  await q(A.secretary, `SELECT public.generate_bills($1,'2026-11-01','2026-11-30','2026-11-10')`, [A.societyId]);
  const b = (await db.query(`SELECT unit_id, balance_due, status FROM bills WHERE society_id=$1 AND NOT is_opening_balance`, [A.societyId])).rows;
  const byUnit = Object.fromEntries(b.map((r) => [r.unit_id, [Number(r.balance_due), r.status]]));
  assert.deepEqual(byUnit[A.u102], [0, 'paid']);
  assert.deepEqual(byUnit[A.u101], [1000, 'issued']);
  assert.equal(Number((await db.query(`SELECT remaining FROM opening_advances WHERE unit_id=$1`, [A.u102])).rows[0].remaining), 500);
  const f = await parties(A, 'flat');
  assert.equal(Number(f.parties.find((p) => p.name === 'Flat 102').advance), 500);
  assert.equal(f.parties.reduce((s, p) => s + Number(p.advance), 0), Number(f.control.advance));
});

test('an opening advance clears bills issued before the approval', async () => {
  const C = await makeSociety('c');
  await q(C.secretary, `INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Maintenance','flat_per_unit',1000)`, [C.societyId]);
  await q(C.secretary, `SELECT public.generate_bills($1,'2026-10-01','2026-10-31','2026-10-10')`, [C.societyId]);
  await approveOpening(db, { societyId: C.societyId, ca: C.ca, approver: C.treasurer, liveOn: '2026-10-01',
    audited: [{ code: '2300', amount: -1500, side: 'liabilities' }, { code: '1000', amount: 1500, side: 'assets' }],
    flats: [{ unit_id: C.u102, amount: -1500 }] });
  const bill = (await db.query(`SELECT balance_due, status FROM bills WHERE unit_id=$1`, [C.u102])).rows[0];
  assert.deepEqual([Number(bill.balance_due), bill.status], [0, 'paid']);
  const j = await db.query(`SELECT count(*)::int n FROM journal_entries WHERE society_id=$1 AND reference_event_type='opening_advance.applied'`, [C.societyId]);
  assert.equal(j.rows[0].n, 1);
  const f = await parties(C, 'flat');
  assert.equal(f.parties.reduce((s, p) => s + Number(p.dues), 0), Number(f.control.dues));
  assert.equal(f.parties.reduce((s, p) => s + Number(p.advance), 0), Number(f.control.advance));
});

test('the opening-payable mark is set only by the approved opening balance', async () => {
  const e = (await db.query(`SELECT id FROM expenses WHERE society_id=$1 AND is_opening_balance`, [A.societyId])).rows[0];
  await assert.rejects(q(A.secretary, `UPDATE expenses SET is_opening_balance = false WHERE id = $1`, [e.id]),
    /set only by the approved opening balance/);
  const id = await val(A.treasurer, `INSERT INTO expenses (society_id, vendor_id, category, title, subtotal, tds_amount, invoice_number, invoice_date, is_opening_balance)
    VALUES ($1,$2,'repairs','Pump repair',1000,0,'PR-1',current_date,true) RETURNING id`, [A.societyId, A.vendor]);
  assert.equal((await db.query(`SELECT is_opening_balance FROM expenses WHERE id=$1`, [id])).rows[0].is_opening_balance, false);
});

test('a vendor-wise opening payable is paid in the app and cannot be voided', async () => {
  const e = (await db.query(`SELECT id, status, subtotal FROM expenses WHERE society_id=$1 AND is_opening_balance`, [A.societyId])).rows[0];
  assert.deepEqual([e.status, Number(e.subtotal)], ['approved', 3000]);
  const acc = await db.query(`SELECT count(*)::int n FROM journal_entries WHERE reference_event_type='expense.approved' AND reference_event_id=$1`, [e.id]);
  assert.equal(acc.rows[0].n, 0);
  const bankBefore = (await codeBalances(A, '2999-12-31'))['1000'];
  await q(A.treasurer, `SELECT public.record_vendor_payment($1,3000,0,'neft','UTR-OB','2026-11-01')`, [e.id]);
  assert.equal((await codeBalances(A, '2999-12-31'))['1000'], bankBefore - 3000, 'the bank moves once, by the payment');
  const paid = await db.query(`SELECT count(*)::int n FROM journal_entries WHERE reference_event_type='expense.paid' AND reference_event_id=$1`, [e.id]);
  assert.equal(paid.rows[0].n, 0, 'no cash-basis expense is booked for an opening payable');
  const v = await parties(A, 'vendor');
  assert.equal(Number(v.control.payable), 0);
  assert.equal(v.parties.filter((p) => Number(p.balance) !== 0).length, 0);
  await assert.rejects(q(A.secretary, `SELECT public.void_expense($1,'wrong')`, [e.id]), /opening payable cannot be voided/);
});
