// 042: shifting charges and refundable deposits (Phase 11C).
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

before(async () => {
  db = await createDb();
  await db.exec('CREATE SCHEMA IF NOT EXISTS extensions; ALTER EXTENSION pgcrypto SET SCHEMA extensions;');
  ids.sec = await createUser(db, 'sec@shift.test', { fullName: 'Secretary' });
  ids.soc = await asUser(db, ids.sec, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Hill View CHS','9 Hill Road','Pune','Maharashtra','411004','sec@shift.test','9876500200') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([
      { unit_number: '101', wing: 'A' }, { unit_number: '102', wing: 'A' }, { unit_number: '103', wing: 'A' }])]);
    await tx.query(`INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Maintenance','flat_per_unit',1500)`, [id]);
    return id;
  });
  for (const n of ['101', '102', '103']) {
    ids[`u${n}`] = (await db.query('SELECT id FROM units WHERE society_id=$1 AND unit_number=$2', [ids.soc, n])).rows[0].id;
  }
  ids.owner = await member('asha@shift.test', 'resident_owner', ids.u101, 'Asha Patil');
  ids.owner2 = await member('bina@shift.test', 'resident_owner', ids.u102, 'Bina Shah');
  ids.tenant = await member('tara@shift.test', 'resident_tenant', ids.u101, 'Tara Rao');
  ids.committee = await member('cm@shift.test', 'committee_member', ids.u103, 'Committee Member');
});

const journalFor = async (type, id) => (await db.query(
  `SELECT a.code, sum(l.amount)::numeric AS amount FROM ledger_entries l JOIN journal_entries j ON j.id = l.journal_entry_id
   JOIN accounts a ON a.id = l.account_id WHERE j.reference_event_type=$1 AND j.reference_event_id=$2 GROUP BY a.code ORDER BY a.code`, [type, id])).rows
  .map((r) => [r.code, Number(r.amount)]);
const chargeFlat = (unit, lines, due = isoDays(7)) => db.query('SELECT public.charge_flat($1,$2,$3) AS id', [unit, JSON.stringify(lines), due]).then((r) => r.rows[0].id);

// ---------------------------------------------------------------- 1. ledgers, system rules, settings, one-off charges
test('the one-off charge posts to the right ledgers', async () => {
  await db.query('SELECT public.ensure_flat_change_ledgers($1)', [ids.soc]);
  const accounts = (await db.query(`SELECT code, name, type FROM accounts WHERE society_id=$1 AND code IN ('2400','4400','4500') ORDER BY code`, [ids.soc])).rows;
  assert.deepEqual(accounts.map((a) => [a.code, a.name, a.type]),
    [['2400', 'Deposits received', 'liability'], ['4400', 'Shifting charges', 'income'], ['4500', 'Damage recovery', 'income']]);
  const bill = await chargeFlat(ids.u101, [{ rule_key: 'shifting_charge', description: 'Shifting charges (moving in)', amount: 1000 },
                                           { rule_key: 'shifting_deposit', description: 'Shifting deposit (refundable)', amount: 5000 }]);
  const b = (await db.query('SELECT bill_number, total_amount::numeric AS t, balance_due::numeric AS d, user_id FROM bills WHERE id=$1', [bill])).rows[0];
  assert.match(b.bill_number, /^C\d{4}-0001$/);
  assert.equal(Number(b.t), 6000);
  assert.equal(b.user_id, ids.owner);
  assert.deepEqual(await journalFor('bill.issued', bill), [['1200', 6000], ['2400', -5000], ['4400', -1000]]);
  // a second charge the same day uses the same cycle and the next number
  const bill2 = await chargeFlat(ids.u102, [{ rule_key: 'shifting_charge', description: 'Shifting charges', amount: 500 }]);
  assert.match((await db.query('SELECT bill_number FROM bills WHERE id=$1', [bill2])).rows[0].bill_number, /^C\d{4}-0002$/);
  ids.firstBill = bill;
});

test('nothing to charge makes no bill', async () => {
  assert.equal(await chargeFlat(ids.u101, [{ rule_key: 'shifting_charge', description: 'x', amount: 0 }]), null);
});

test('system rules stay off and out of monthly bills', async () => {
  // the charge rule credits an income ledger, so only the check stops it; the deposit rule is stopped earlier
  const charge = (await db.query(`SELECT id FROM billing_rules WHERE society_id=$1 AND is_system AND account_code='4400'`, [ids.soc])).rows[0].id;
  await fails(db.query('UPDATE billing_rules SET is_active=true WHERE id=$1', [charge]), 'chk_system_rule_off');
  const deposit = (await db.query(`SELECT id FROM billing_rules WHERE society_id=$1 AND is_system AND account_code='2400'`, [ids.soc])).rows[0].id;
  await assert.rejects(db.query('UPDATE billing_rules SET is_active=true WHERE id=$1', [deposit]));
  await q(ids.sec, `SELECT public.generate_bills($1,'2030-01-01','2030-01-31','2030-01-10')`, [ids.soc]);
  const items = (await db.query(`SELECT DISTINCT i.description FROM bill_items i JOIN bills b ON b.id=i.bill_id JOIN billing_cycles c ON c.id=b.cycle_id WHERE c.period_start='2030-01-01'`)).rows.map((r) => r.description);
  assert.deepEqual(items, ['Maintenance']);
});

test('shifting settings', async () => {
  const s = (o) => q(ids.sec, 'SELECT public.set_shifting_settings($1,$2)', [ids.soc, JSON.stringify(o)]);
  await fails(q(ids.owner, 'SELECT public.set_shifting_settings($1,$2)', [ids.soc, '{}']), 'Only the committee can change this');
  await fails(q(ids.committee, 'SELECT public.set_shifting_settings($1,$2)', [ids.soc, '{}']), 'Only the committee can change this');
  await fails(s({ move_in_deposit: -1 }), 'Amounts must be between ₹0 and ₹1,00,000');
  await fails(s({ move_out_charge: 100001 }), 'Amounts must be between ₹0 and ₹1,00,000');
  await fails(s({ shifting_from: '21:00', shifting_to: '08:00' }), 'Choose the shifting hours');
  await s({ move_in_charge: 1000, move_in_deposit: 5000, move_out_charge: 500, move_out_deposit: 0, shifting_from: '09:00', shifting_to: '19:00' });
  const row = (await db.query('SELECT move_in_charge::numeric a, move_in_deposit::numeric b, move_out_charge::numeric c, shifting_from::text f, shifting_to::text t FROM society_settings WHERE society_id=$1', [ids.soc])).rows[0];
  assert.deepEqual([Number(row.a), Number(row.b), Number(row.c), row.f, row.t], [1000, 5000, 500, '09:00:00', '19:00:00']);
});

// ---------------------------------------------------------------- 2. booking and approval
const fmt = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${String(d).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`; };
const book = (user, unit, o = {}) => val(user, 'SELECT public.create_shifting_request($1,$2)',
  [unit, JSON.stringify({ direction: 'in', date: isoDays(3), time: '10:00', vehicle: 'Tempo MH12 AB 1234', ...o })]);
const decide = (user, req, d = 'approve', note = null) => val(user, 'SELECT public.decide_request($1,$2,$3)', [req, d, note]);
const shiftingOf = async (req) => (await db.query('SELECT * FROM shiftings WHERE request_id=$1', [req])).rows[0];

test('an owner books a move-in and the committee is told', async () => {
  const r = await book(ids.owner, ids.u101);
  const row = (await db.query('SELECT kind, details FROM flat_requests WHERE id=$1', [r])).rows[0];
  assert.equal(row.kind, 'shifting');
  assert.deepEqual(row.details, { direction: 'in', date: isoDays(3), time: '10:00', vehicle: 'Tempo MH12 AB 1234' });
  const told = (await db.query(`SELECT user_id, title FROM notifications WHERE ref_id=$1`, [r])).rows;
  assert.deepEqual(told.map((n) => [n.user_id, n.title]), [[ids.sec, `Shifting booked for flat 101 on ${fmt(isoDays(3))}`]]);
  ids.moveIn = r;
});

test('a tenant books their move-out; another flat cannot', async () => {
  ids.moveOut = await book(ids.tenant, ids.u101, { direction: 'out', vehicle: '' });
  await fails(book(ids.owner2, ids.u101), 'Only someone living in this flat can book shifting');
  await fails(book(ids.committee, ids.u101), 'Only someone living in this flat can book shifting');
});

test('booking checks', async () => {
  await fails(book(ids.owner, ids.u101, { direction: 'sideways' }), 'Choose moving in or moving out');
  await fails(book(ids.owner, ids.u101, { date: isoDays(-2) }), 'Choose a date from today up to 90 days ahead');
  await fails(book(ids.owner, ids.u101, { date: isoDays(93) }), 'Choose a date from today up to 90 days ahead');
  await fails(book(ids.owner, ids.u101, { time: '20:30' }), 'Shifting is allowed between 09:00 and 19:00');
  await fails(book(ids.owner, ids.u101, { time: 'noon' }), 'Shifting is allowed between 09:00 and 19:00');
  await fails(book(ids.owner, ids.u101, { vehicle: 'x'.repeat(81) }), 'Vehicle details can be up to 80 characters');
});

test('approval bills the shifting charges', async () => {
  const out = await decide(ids.sec, ids.moveIn);
  const s = await shiftingOf(ids.moveIn);
  assert.equal(out.shifting_id, s.id);
  assert.equal(out.bill_id, s.bill_id);
  assert.equal(s.direction, 'in');
  assert.deepEqual([Number(s.charge_amount), Number(s.deposit_amount), s.deposit_status], [1000, 5000, 'held']);
  const items = (await db.query('SELECT description, amount::numeric a FROM bill_items WHERE bill_id=$1 ORDER BY description', [s.bill_id])).rows;
  assert.deepEqual(items.map((i) => [i.description, Number(i.a)]), [['Shifting charges (moving in)', 1000], ['Shifting deposit (refundable)', 5000]]);
  const told = (await db.query(`SELECT user_id FROM notifications WHERE ref_id=$1 AND title=$2`, [ids.moveIn, `Shifting approved for flat 101 on ${fmt(isoDays(3))}`])).rows;
  assert.deepEqual(told.map((n) => n.user_id), [ids.owner]);
  ids.shiftIn = s.id;
  // the move-out carries only its charge
  await decide(ids.sec, ids.moveOut);
  const o = await shiftingOf(ids.moveOut);
  assert.deepEqual([Number(o.charge_amount), Number(o.deposit_amount), o.deposit_status], [500, 0, 'none']);
});

test('free shifting makes no bill', async () => {
  await q(ids.sec, 'SELECT public.set_shifting_settings($1,$2)', [ids.soc, JSON.stringify({ move_in_charge: 0, move_in_deposit: 0 })]);
  const r = await book(ids.owner2, ids.u102);
  const out = await decide(ids.sec, r);
  assert.equal(out.bill_id, null);
  const s = await shiftingOf(r);
  assert.equal(s.bill_id, null);
  assert.equal(s.deposit_status, 'none');
  await q(ids.sec, 'SELECT public.set_shifting_settings($1,$2)', [ids.soc, JSON.stringify({ move_in_charge: 1000, move_in_deposit: 5000 })]);
});
