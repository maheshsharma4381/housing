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
  // the seller's period, as joining makes it (attach_flat_owner)
  await db.query(`INSERT INTO unit_ownerships (society_id, unit_id, owner_user_id, owner_name, from_date) VALUES ($1,$2,$3,'Asha Patil', current_date - 400)`, [ids.soc, ids.u101, ids.owner]);
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

// ---------------------------------------------------------------- 2. applying, fees and cancellation
const buyer = { buyer_name: '  Neha   Joshi ', buyer_mobile: '98765 43210', buyer_email: ' Neha@Buyer.TEST ', deed_date: isoDays(-3), deed_number: 'HVL-1234-2026' };
const apply = (user, unit, d = buyer) => val(user, 'SELECT public.create_transfer_request($1,$2)', [unit, JSON.stringify(d)]);
const billFees = (user, r, fee, premium) => val(user, 'SELECT public.bill_transfer_fees($1,$2,$3)', [r, fee, premium]);
const details = async (r) => (await db.query('SELECT details FROM flat_requests WHERE id=$1', [r])).rows[0].details;
let payNo = 0;
const payAll = async (user, unit) => {
  const due = Number((await db.query(`SELECT coalesce(sum(balance_due),0)::numeric d FROM bills WHERE unit_id=$1 AND status <> 'cancelled'`, [unit])).rows[0].d);
  payNo += 1;
  const p = await val(user, `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, status)
    VALUES ($1,$2,$3,$4,$5,$6,'pending_verification') RETURNING id`, [ids.soc, unit, user, `PAY-TR-${payNo}`, due, String(625219500000 + payNo)]);
  await q(ids.sec, 'SELECT public.verify_payment($1, true)', [p]);
};

test('an owner applies to transfer the flat', async () => {
  ids.req = await apply(ids.owner, ids.u101);
  const r = (await db.query('SELECT kind, status, applicant_id, details, jsonb_array_length(checklist) n FROM flat_requests WHERE id=$1', [ids.req])).rows[0];
  assert.deepEqual([r.kind, r.status, r.applicant_id, r.n], ['transfer', 'submitted', ids.owner, 9]);
  assert.deepEqual(r.details, { buyer_name: 'Neha Joshi', buyer_mobile: '919876543210', buyer_email: 'neha@buyer.test', deed_date: isoDays(-3), deed_number: 'HVL-1234-2026' });
  const n = (await db.query(`SELECT title FROM notifications WHERE user_id=$1 AND ref_id=$2`, [ids.sec, ids.req])).rows.map((x) => x.title);
  assert.deepEqual(n, ['Transfer requested for flat A-101']);
});

test('who can apply', async () => {
  for (const u of [ids.tenant, ids.owner2, ids.committee]) {
    await fails(apply(u, ids.u101), 'Only an owner of this flat can apply for a transfer');
  }
  const r = await apply(ids.sec, ids.u104, { ...buyer, buyer_mobile: '9811111111', buyer_email: '' });
  assert.equal((await details(r)).buyer_email, undefined);
  await q(ids.sec, 'SELECT public.withdraw_request($1)', [r]);
});

test('application checks', async () => {
  const bad = (o, m) => fails(apply(ids.owner2, ids.u102, { ...buyer, ...o }), m);
  await bad({ buyer_name: ' N ' }, "Enter the buyer's name");
  await bad({ buyer_mobile: '' }, "Enter the buyer's mobile number");
  await bad({ buyer_mobile: '12345' }, 'Mobile 12345 is not a valid number');
  await bad({ buyer_email: 'neha' }, 'Enter a valid email for the buyer');
  await db.query('UPDATE profiles SET phone=$2 WHERE id=$1', [ids.owner2, '9822222222']);
  await bad({ buyer_mobile: '9822222222' }, 'This mobile belongs to an owner of this flat');
  await bad({ deed_date: '' }, 'Enter the sale deed date');
  await bad({ deed_date: isoDays(2) }, 'The sale deed date cannot be in the future');
  await bad({ deed_number: 'x'.repeat(41) }, 'The registration number can be up to 40 characters');
});

test('one open transfer per flat', async () => {
  await fails(apply(ids.owner, ids.u101), 'A transfer request for this flat is already open');
});

test('fees are billed once', async () => {
  await fails(billFees(ids.owner, ids.req, 500, 0), 'Only the committee can do this');
  await fails(billFees(ids.committee, ids.req, 500, 0), 'Only the committee can do this');
  await fails(billFees(ids.sec, ids.req, 500, 25001), 'The transfer premium can be at most ₹25,000');
  await fails(billFees(ids.sec, ids.req, -5, 0), 'Amounts must be between ₹0 and ₹1,00,000');
  const bill = await billFees(ids.sec, ids.req, 500, 20000);
  const lines = (await db.query('SELECT description, amount::numeric a FROM bill_items WHERE bill_id=$1 ORDER BY amount', [bill])).rows.map((l) => [l.description, Number(l.a)]);
  assert.deepEqual(lines, [['Transfer fee', 500], ['Transfer premium', 20000]]);
  assert.equal(await dues(ids.u101), 20500);
  const d = await details(ids.req);
  assert.deepEqual([d.fee, d.premium, d.fee_bill_id], [500, 20000, bill]);
  assert.ok(d.fees_billed_at);
  const n = (await db.query(`SELECT title FROM notifications WHERE user_id=$1 AND ref_id=$2`, [ids.owner, ids.req])).rows.map((x) => x.title);
  assert.deepEqual(n, ['Transfer fees billed for flat A-101: ₹20,500']);
  await fails(billFees(ids.sec, ids.req, 500, 0), 'The transfer fees are already billed');
  ids.feeBill = bill;
});

test('no fees makes no bill', async () => {
  const r = await apply(ids.owner4, ids.u104, { ...buyer, buyer_mobile: '9833333333', buyer_email: 'om@buyer.test' });
  assert.equal(await billFees(ids.sec, r, 0, 0), null);
  const d = await details(r);
  assert.ok(d.fees_billed_at);
  assert.equal(d.fee_bill_id, null);
  ids.req104 = r;
});

test('withdrawing cancels an unpaid fee bill', async () => {
  const r = await apply(ids.owner2, ids.u102, { ...buyer, buyer_mobile: '9844444444', buyer_email: 'pia@buyer.test' });
  const bill = await billFees(ids.sec, r, 500, 1000);
  assert.equal(await dues(ids.u102), 1500);
  await q(ids.owner2, 'SELECT public.withdraw_request($1)', [r]);
  assert.equal((await db.query('SELECT status FROM bills WHERE id=$1', [bill])).rows[0].status, 'cancelled');
  assert.equal(await dues(ids.u102), 0);
  const j = await journalFor('bill.cancelled', bill);
  assert.deepEqual(j, [['1200', -1500], ['4600', 500], ['4700', 1000]]);
  assert.equal(j.reduce((s, [, a]) => s + a, 0), 0);
});

test('a paid fee bill stays when the request is rejected', async () => {
  const r = await apply(ids.owner2, ids.u102, { ...buyer, buyer_mobile: '9855555555', buyer_email: 'raj@buyer.test' });
  const bill = await billFees(ids.sec, r, 500, 0);
  await payAll(ids.owner2, ids.u102);
  await q(ids.sec, `SELECT public.decide_request($1,'reject','Buyer did not apply')`, [r]);
  assert.equal((await db.query('SELECT status FROM bills WHERE id=$1', [bill])).rows[0].status, 'paid');
  assert.equal(await dues(ids.u102), 0);
});

// ---------------------------------------------------------------- 3. approval runs the owner change
const REQUIRED = ['notice', 'membership', 'deed', 'index2', 'buyer_id', 'buyer_photo', 'buyer_pan'];
const addDocs = async (user, req) => {
  for (const k of REQUIRED) await q(user, 'SELECT public.add_request_document($1,$2,$3,$4)', [req, k, `${ids.soc}/${req}/${k}.pdf`, `${k}.pdf`]);
};
const approve = (user, r) => q(user, `SELECT public.decide_request($1,'approve',NULL) AS r`, [r]).then((x) => x[0].r);
const handover = (user, r, o) => q(user, 'SELECT public.save_transfer_handover($1,$2)', [r, JSON.stringify(o)]);
const today = async () => (await db.query('SELECT current_date::text d')).rows[0].d;

test('the committee records the share certificate', async () => {
  await fails(handover(ids.owner, ids.req, { certificate_received: true }), 'Only the committee can do this');
  await fails(handover(ids.committee, ids.req, { certificate_received: true }), 'Only the committee can do this');
  await fails(handover(ids.sec, ids.req, { share_certificate_no: 'x'.repeat(41) }), 'The share certificate number can be up to 40 characters');
  await fails(handover(ids.sec, ids.req, { transfer_date: isoDays(3) }), 'The transfer date cannot be in the future');
  await handover(ids.sec, ids.req, { share_certificate_no: ' SC-17 ' });
  const d = await details(ids.req);
  assert.equal(d.share_certificate_no, 'SC-17');
  assert.equal(d.certificate_received, undefined);
});

test('approval waits for the fees, the certificate and the dues', async () => {
  // fees first, on a request where they were never billed
  const r = await apply(ids.owner2, ids.u102, { ...buyer, buyer_mobile: '9866666666', buyer_email: 'sam@buyer.test' });
  await addDocs(ids.owner2, r);
  await fails(approve(ids.sec, r), 'Bill the transfer fees first (₹0 if none)');
  await q(ids.owner2, 'SELECT public.withdraw_request($1)', [r]);

  await fails(approve(ids.sec, ids.req), 'Add "Seller\'s notice of transfer (society form)" before approving');
  await addDocs(ids.owner, ids.req);
  await fails(approve(ids.sec, ids.req), 'Tick that the original share certificate is received');
  await handover(ids.sec, ids.req, { certificate_received: true });
  const ev = (await db.query(`SELECT count(*)::int n FROM request_events WHERE request_id=$1 AND action='certificate_received'`, [ids.req])).rows[0].n;
  assert.equal(ev, 1);
  await handover(ids.sec, ids.req, { certificate_received: true });
  assert.equal((await db.query(`SELECT count(*)::int n FROM request_events WHERE request_id=$1 AND action='certificate_received'`, [ids.req])).rows[0].n, 1);
  await fails(approve(ids.sec, ids.req), 'Clear dues of ₹20,500 before the transfer');
});

test('a refused approval changes nothing', async () => {
  assert.equal((await db.query('SELECT status FROM flat_requests WHERE id=$1', [ids.req])).rows[0].status, 'submitted');
  const m = (await db.query(`SELECT is_active FROM society_memberships WHERE user_id=$1 AND unit_id=$2`, [ids.owner, ids.u101])).rows[0];
  assert.equal(m.is_active, true);
  assert.equal((await db.query(`SELECT count(*)::int n FROM member_invites WHERE unit_id=$1 AND role='resident_owner'`, [ids.u101])).rows[0].n, 0);
});

test('approval transfers the flat', async () => {
  await payAll(ids.owner, ids.u101);
  const res = await approve(ids.sec, ids.req);
  assert.equal(res.status, 'approved');
  assert.ok(res.ownership_id && res.invite_id);
  const m = (await db.query(`SELECT is_active FROM society_memberships WHERE user_id=$1 AND unit_id=$2 AND role='resident_owner'`, [ids.owner, ids.u101])).rows[0];
  assert.equal(m.is_active, false);
  const own = (await db.query(`SELECT owner_name, owner_mobile, from_date::text f FROM unit_ownerships WHERE unit_id=$1 AND to_date IS NULL`, [ids.u101])).rows[0];
  assert.deepEqual([own.owner_name, own.owner_mobile, own.f], ['Neha Joshi', '919876543210', await today()]);
  const inv = (await db.query(`SELECT id, mobile, email, status FROM member_invites WHERE unit_id=$1 AND role='resident_owner'`, [ids.u101])).rows;
  assert.deepEqual(inv.map((i) => [i.id, i.mobile, i.email, i.status]), [[res.invite_id, '919876543210', 'neha@buyer.test', 'pending']]);
  assert.equal((await db.query('SELECT share_certificate_no FROM units WHERE id=$1', [ids.u101])).rows[0].share_certificate_no, 'SC-17');
  const d = await details(ids.req);
  assert.deepEqual([d.transfer_date, d.endorsed_on, d.share_certificate_no, d.ownership_id, d.invite_id],
    [await today(), await today(), 'SC-17', res.ownership_id, res.invite_id]);
  assert.equal((await q(ids.owner, 'SELECT count(*)::int n FROM flat_requests WHERE id=$1', [ids.req]))[0].n, 1);
  assert.equal((await q(ids.sec, 'SELECT jsonb_array_length(public.flat_owner_periods($1)) AS n', [ids.u101]))[0].n, 2);
  const n = (await db.query(`SELECT user_id FROM notifications WHERE ref_id=$1 AND title='Transfer approved for flat A-101'`, [ids.req])).rows.map((x) => x.user_id);
  assert.ok(n.includes(ids.owner));
});

test("the buyer cannot read the seller's papers", async () => {
  ids.buyer = await createUser(db, 'neha@buyer.test', { fullName: 'Neha Joshi' });
  await asUser(db, ids.buyer, (tx) => tx.query('SELECT public.claim_my_invites()'));
  assert.equal((await db.query(`SELECT is_active FROM society_memberships WHERE user_id=$1 AND unit_id=$2 AND role='resident_owner'`, [ids.buyer, ids.u101])).rows[0].is_active, true);
  assert.equal(await val(ids.buyer, 'SELECT public.can_see_request($1)', [ids.req]), false);
  assert.equal((await q(ids.buyer, 'SELECT count(*)::int n FROM request_documents WHERE request_id=$1', [ids.req]))[0].n, 0);
  assert.equal((await q(ids.buyer, 'SELECT count(*)::int n FROM flat_requests WHERE id=$1', [ids.req]))[0].n, 0);
});

// ---------------------------------------------------------------- 4. shifting before tenancy or transfer
const tenancy = (user, unit, mobile) => val(user, 'SELECT public.create_tenancy_request($1,$2)', [unit, JSON.stringify({
  tenant_name: 'Ravi Kumar', tenant_mobile: mobile, occupants: 2, start_date: isoDays(0), end_date: isoDays(330), police_ref: 'PNA/2026/9' })]);
const tenancyDocs = async (user, r) => {
  for (const k of ['agreement', 'police', 'tenant_id']) await q(user, 'SELECT public.add_request_document($1,$2,$3,$4)', [r, k, `${ids.soc}/${r}/${k}.pdf`, `${k}.pdf`]);
};
const book = (user, unit, direction) => val(user, 'SELECT public.create_shifting_request($1,$2)', [unit, JSON.stringify({ direction, date: isoDays(1), time: '10:00', vehicle: '' })]);
const gate = (on) => q(ids.sec, 'SELECT public.set_transfer_settings($1,$2)', [ids.soc, JSON.stringify({ shifting_required: on })]);

test('the shifting gate is off by default', async () => {
  const r = await tenancy(ids.owner4, ids.u104, '9877700001');
  await tenancyDocs(ids.owner4, r);
  assert.equal((await approve(ids.sec, r)).status, 'approved');
});

test('with the gate on, a tenancy needs a move-in booking', async () => {
  await gate(true);
  const r = await tenancy(ids.owner2, ids.u102, '9877700002');
  await tenancyDocs(ids.owner2, r);
  await fails(approve(ids.sec, r), 'Book the move-in shifting for this flat first');
  await book(ids.owner2, ids.u102, 'out');
  await fails(approve(ids.sec, r), 'Book the move-in shifting for this flat first');
  await book(ids.owner2, ids.u102, 'in');
  assert.equal((await approve(ids.sec, r)).status, 'approved');
});

test('with the gate on, a transfer needs a move-out booking', async () => {
  await addDocs(ids.owner4, ids.req104);
  await handover(ids.sec, ids.req104, { certificate_received: true });
  await fails(approve(ids.sec, ids.req104), 'Book the move-out shifting for this flat first');
  const s = await book(ids.owner4, ids.u104, 'out');
  await q(ids.sec, `SELECT public.decide_request($1,'reject','Wrong day')`, [s]);
  await fails(approve(ids.sec, ids.req104), 'Book the move-out shifting for this flat first');
  await book(ids.owner4, ids.u104, 'out');
  assert.equal((await approve(ids.sec, ids.req104)).status, 'approved');
  await gate(false);
});

// ---------------------------------------------------------------- 5. what the screens read
test('the request shows the flat dues while it is open', async () => {
  const r = await apply(ids.owner2, ids.u102, { ...buyer, buyer_mobile: '9877700009', buyer_email: 'zed@buyer.test' });
  await billFees(ids.sec, r, 750, 0);
  assert.equal(Number(await val(ids.sec, 'SELECT public.request_flat_dues($1)', [r])), 750);
  assert.equal(Number(await val(ids.owner2, 'SELECT public.request_flat_dues($1)', [r])), 750);
  assert.equal(await val(ids.owner4, 'SELECT public.request_flat_dues($1)', [r]), null, 'another flat sees nothing');
  await q(ids.owner2, 'SELECT public.withdraw_request($1)', [r]);
  assert.equal(await val(ids.owner2, 'SELECT public.request_flat_dues($1)', [r]), null, 'a closed request shows nothing');
});
