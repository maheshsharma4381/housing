// 015: trial, quotes, overrides, invoices, gateway / NEFT payments, lifecycle and plan features.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;
const SECRET = 'test-gateway-secret-0123456789abcdef';

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const asAnon = (sql, params = []) => db.transaction(async (tx) => {
  await tx.exec('SET LOCAL ROLE anon');
  return (await tx.query(sql, params)).rows;
});
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (d, n) => iso(new Date(new Date(d).getTime() + n * 86400000));
const today = iso(Date.now());
const sub = async (sid) => (await db.query(
  `SELECT p.tier_code, s.status, s.billing_term, s.current_period_start::text ps, s.current_period_end::text pe, s.trial_ends_on::text te,
          np.tier_code next FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
   LEFT JOIN subscription_plans np ON np.id = s.next_plan_id WHERE s.society_id = $1`, [sid])).rows[0];

async function society(email, name, flats) {
  const admin = await createUser(db, email);
  const id = await asUser(db, admin, async (tx) => {
    const sid = (await tx.query(`SELECT public.create_society($1,'Road','Pune','Maharashtra','411001',$2,'9876543210') AS id`, [name, email])).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [sid, JSON.stringify(Array.from({ length: flats }, (_, i) => ({ unit_number: String(101 + i) })))]);
    return sid;
  });
  return { admin, id };
}

before(async () => {
  db = await createDb();
  const owner = await createUser(db, 'owner@saas.test');
  await db.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [owner]);
  const A = await society('a@saas.test', 'Palm Heights', 32);
  const B = await society('b@saas.test', 'Small CHS', 5);
  const C = await society('c@saas.test', 'Lapsed CHS', 3);
  await asUser(db, A.admin, (tx) => tx.query(
    `INSERT INTO member_invites (society_id,email,role,unit_id,invited_by) SELECT $1,'res@saas.test','resident_owner',id,$2 FROM units WHERE society_id=$1 AND unit_number='101'`,
    [A.id, A.admin]));
  const resident = await createUser(db, 'res@saas.test');
  await asUser(db, resident, (tx) => tx.query('SELECT public.claim_my_invites()'));
  ids = { owner, A, B, C, resident };
});

test('every new society starts on a 30-day trial with all features and no ads', async () => {
  const s = await sub(ids.A.id);
  assert.deepEqual([s.tier_code, s.status, s.te], ['pro', 'trial', addDays(today, 29)]);
  const plan = await val(ids.A.admin, 'SELECT public.society_plan($1)', [ids.A.id]);
  assert.equal(plan.plan_code, 'trial');
  assert.equal(plan.in_trial, true);
  assert.equal(plan.show_ads, false);
  assert.equal(plan.features.length, 6);
  await assert.rejects(q(ids.resident, 'SELECT public.society_plan($1)', [ids.A.id]), /Only the society committee/);
});

test('quotes: per flat, 10 months for a year, minimum 20 flats, 18% GST', async () => {
  const quote = (who, sid, plan, term) => val(who, 'SELECT public.subscription_quote($1,$2,$3)', [sid, plan, term]);
  const yearly = await quote(ids.A.admin, ids.A.id, 'basic', 'annual');
  assert.deepEqual([yearly.billable_units, Number(yearly.gross), Number(yearly.gst), Number(yearly.total), Number(yearly.savings_vs_monthly)],
    [32, 3200, 576, 3776, 640]);
  const monthly = await quote(ids.A.admin, ids.A.id, 'basic', 'monthly');
  assert.equal(Number(monthly.total), 377.6);
  assert.equal(Number((await quote(ids.A.admin, ids.A.id, 'pro', 'annual')).taxable), 5760);
  const small = await quote(ids.B.admin, ids.B.id, 'basic', 'monthly');
  assert.deepEqual([small.units, small.billable_units, Number(small.taxable)], [5, 20, 200], 'minimum 20 billable flats');
  assert.equal(Number((await quote(ids.B.admin, ids.B.id, 'free', 'annual')).total), 0);
  await assert.rejects(quote(ids.resident, ids.A.id, 'basic', 'annual'), /Only the society committee/);
});

test('price override is platform-admin only and changes the quote', async () => {
  const set = (who) => q(who, `SELECT public.platform_set_pricing_override($1, 8, 10, 2, 0, NULL, 'Pilot society')`, [ids.B.id]);
  await assert.rejects(set(ids.B.admin), /Platform admin only/);
  await set(ids.owner);
  const qb = await val(ids.B.admin, `SELECT public.subscription_quote($1,'basic','annual')`, [ids.B.id]);
  assert.deepEqual([Number(qb.rate), Number(qb.gross), Number(qb.discount), Number(qb.taxable), qb.free_months], [8, 1600, 160, 1440, 2]);
});

test('choosing a plan in the trial: invoice starts after the trial, paid through the gateway', async () => {
  const r = await val(ids.A.admin, `SELECT public.choose_plan($1,'basic','annual')`, [ids.A.id]);
  const trialEnd = (await sub(ids.A.id)).te;
  assert.deepEqual([r.kind, r.period_start, Number(r.total), r.due_on], ['new', addDays(trialEnd, 1), 3776, addDays(today, 15)]);
  assert.match(r.invoice_number, /^SV-\d{4}-0001$/);
  await assert.rejects(q(ids.A.admin, 'SELECT public.platform_set_gateway_secret($1)', [SECRET]), /Platform admin only/);

  const pay = (secret, amount, paymentId = 'pay_A1') => asAnon('SELECT public.gateway_record_payment($1,$2,$3,$4,$5) AS r', [secret, r.invoice_id, 'order_A1', paymentId, amount]);
  await assert.rejects(pay(SECRET, 377600), /Not authorised/, 'no secret configured yet');
  await q(ids.owner, 'SELECT public.platform_set_gateway_secret($1)', [SECRET]);
  await assert.rejects(pay('wrong-secret', 377600), /Not authorised/);
  await assert.rejects(pay(SECRET, 100), /does not match/);
  assert.equal((await pay(SECRET, 377600))[0].r.status, 'paid');
  assert.equal((await pay(SECRET, 377600))[0].r.already, true, 'webhook + browser both reporting is fine');

  const s = await sub(ids.A.id);
  assert.deepEqual([s.tier_code, s.status, s.ps], ['basic', 'active', addDays(trialEnd, 1)]);
  const plan = await val(ids.A.admin, 'SELECT public.society_plan($1)', [ids.A.id]);
  assert.equal(plan.in_trial, true, 'trial features continue until the paid period starts');

  const bills = (await db.query(`SELECT e.title, e.subtotal, e.gst_amount, e.status, e.invoice_number, v.name FROM expenses e JOIN vendors v ON v.id = e.vendor_id
    WHERE e.society_id = $1 AND e.category = 'software'`, [ids.A.id])).rows;
  assert.equal(bills.length, 1);
  assert.deepEqual([Number(bills[0].subtotal), Number(bills[0].gst_amount), bills[0].status, bills[0].invoice_number, bills[0].name],
    [3200, 576, 'pending_approval', r.invoice_number, 'Sahvaas']);
});

test('NEFT payments are marked by the platform admin; free months extend the period', async () => {
  const r = await val(ids.B.admin, `SELECT public.choose_plan($1,'basic','annual')`, [ids.B.id]);
  assert.equal(Number(r.total), 1699.2);
  const start = r.period_start;
  assert.equal(r.period_end, iso(new Date(new Date(start).setMonth(new Date(start).getMonth() + 14)) - 86400000));
  await assert.rejects(q(ids.B.admin, `SELECT public.platform_mark_invoice_paid($1,'UTR1')`, [r.invoice_id]), /Platform admin only/);
  await assert.rejects(q(ids.owner, `SELECT public.platform_mark_invoice_paid($1,'')`, [r.invoice_id]), /UTR/);
  assert.equal((await val(ids.owner, `SELECT public.platform_mark_invoice_paid($1,'HDFC0001')`, [r.invoice_id])).status, 'paid');
  assert.equal((await sub(ids.B.id)).tier_code, 'basic');
});

test('trial over without paying: Free plan, ads on, CA portal and asset register locked; paying restores them', async () => {
  const C = ids.C;
  const ca = await createUser(db, 'ca@saas.test');
  const inv = (await q(C.admin, `INSERT INTO professional_invites (society_id, invited_email, role, permissions, invited_by, expires_at)
    VALUES ($1,'ca@saas.test','ca','["view_expenses","view_reports"]',$2, now() + interval '7 days') RETURNING id`, [C.id, C.admin]))[0].id;
  await q(ca, `SELECT public.respond_to_invite('professional',$1,true)`, [inv]);
  await db.query(`INSERT INTO expenses (society_id, category, title, subtotal) VALUES ($1,'repairs','Pump repair',500)`, [C.id]);
  assert.equal(await val(ca, 'SELECT count(*)::int FROM expenses'), 1, 'CA works during the trial');

  await db.query(`UPDATE subscriptions SET trial_ends_on = current_date - 1, current_period_end = current_date - 1 WHERE society_id = $1`, [C.id]);
  await assert.rejects(q(C.admin, 'SELECT public.run_subscription_lifecycle()'), /Platform admin only/);
  const run = await val(ids.owner, 'SELECT public.run_subscription_lifecycle()');
  assert.ok(run.trials_ended >= 1);

  const plan = await val(C.admin, 'SELECT public.society_plan($1)', [C.id]);
  assert.deepEqual([plan.plan_code, plan.show_ads, plan.features], ['free', true, []]);
  assert.equal(await val(ca, 'SELECT count(*)::int FROM expenses'), 0, 'grant kept, access paused');
  await assert.rejects(q(C.admin, `INSERT INTO professional_invites (society_id, invited_email, role, permissions, invited_by, expires_at)
    VALUES ($1,'ca2@saas.test','ca','["view_reports"]',$2, now() + interval '7 days')`, [C.id, C.admin]), /part of the Basic and Pro plan/);
  await assert.rejects(q(C.admin, `SELECT public.add_existing_asset($1,'Old pump','1500','2020-01-01',10000,5000,'2025-04-01')`, [C.id]), /asset register/);
  assert.equal(await val(C.admin, 'SELECT count(*)::int FROM expenses'), 1, 'the society keeps all its data');

  const r = await val(C.admin, `SELECT public.choose_plan($1,'basic','annual')`, [C.id]);
  assert.equal(r.period_start, today, 'no trial left: the plan starts today');
  await q(ids.owner, `SELECT public.platform_mark_invoice_paid($1,'NEFT-C1')`, [r.invoice_id]);
  assert.equal(await val(ca, 'SELECT count(*)::int FROM expenses'), 2, 'CA access is back (incl. the Sahvaas bill)');
  ids.ca = ca;
});

test('upgrade now is prorated; cheaper plans wait for the period end', async () => {
  const C = ids.C;
  const up = await val(C.admin, `SELECT public.choose_plan($1,'pro','annual')`, [C.id]);
  // 3 flats -> 20 billable; ₹8 difference x 20 x 12 months left x 10/12
  assert.deepEqual([up.kind, Number(up.total)], ['upgrade', 1888]);
  await q(ids.owner, `SELECT public.platform_mark_invoice_paid($1,'NEFT-C2')`, [up.invoice_id]);
  const s = await sub(C.id);
  assert.equal(s.tier_code, 'pro');
  await assert.rejects(q(C.admin, `SELECT public.choose_plan($1,'pro','annual')`, [C.id]), /already on Pro/);

  const down = await val(C.admin, `SELECT public.choose_plan($1,'basic','annual')`, [C.id]);
  assert.deepEqual([down.scheduled, down.effective_on], [true, addDays(s.pe, 1)]);
  assert.deepEqual([(await sub(C.id)).tier_code, (await sub(C.id)).next], ['pro', 'basic']);
});

test('who sees invoices and the billing overview', async () => {
  assert.equal(await val(ids.resident, 'SELECT count(*)::int FROM platform_invoices'), 0);
  assert.equal(await val(ids.A.admin, 'SELECT count(*)::int FROM platform_invoices'), 1, 'only their own society');
  await assert.rejects(q(ids.A.admin, 'SELECT * FROM public.platform_billing_overview()'), /Platform admin only/);
  const rows = await q(ids.owner, 'SELECT society_id, plan_code, monthly_value, has_override FROM public.platform_billing_overview()');
  const b = rows.find((r) => r.society_id === ids.B.id);
  assert.deepEqual([b.plan_code, Number(b.monthly_value), b.has_override], ['basic', 120, true]);
  assert.equal(await val(ids.A.admin, 'SELECT count(*)::int FROM platform_secrets'), 0, 'secret hashes are not readable');
});

test('renewal invoice, grace period, move to Free, and paying the renewal brings the plan back', async () => {
  const A = ids.A;
  const end = (await sub(A.id)).pe;
  const runOn = (d) => val(ids.owner, 'SELECT public.run_subscription_lifecycle($1)', [d]);

  await runOn(addDays(end, -20));
  assert.equal(await val(ids.owner, `SELECT count(*)::int FROM platform_invoices WHERE society_id=$1 AND kind='renewal'`, [A.id]), 0, 'not yet');
  const renewDay = addDays(end, -10);
  await runOn(renewDay);
  await runOn(renewDay);
  const ren = (await db.query(`SELECT id, issued_on::text, period_start::text, total FROM platform_invoices WHERE society_id=$1 AND kind='renewal'`, [A.id])).rows;
  assert.equal(ren.length, 1, 'one renewal invoice, however often the job runs');
  assert.deepEqual([ren[0].issued_on, ren[0].period_start, Number(ren[0].total)], [renewDay, addDays(end, 1), 3776]);

  await runOn(addDays(end, 1));
  assert.deepEqual([(await sub(A.id)).tier_code, (await sub(A.id)).status], ['basic', 'past_due'], 'grace: still Basic');
  await runOn(addDays(renewDay, 31));
  const lapsed = await sub(A.id);
  assert.deepEqual([lapsed.tier_code, lapsed.status, lapsed.pe], ['free', 'active', null]);

  await q(ids.owner, `SELECT public.platform_mark_invoice_paid($1,'LATE-NEFT')`, [ren[0].id]);
  const back = await sub(A.id);
  assert.deepEqual([back.tier_code, back.ps], ['basic', addDays(end, 1)]);
});
