// 037: the platform owner's dashboard (spec 11 items 2–5) — setup funnel, society health, revenue,
// a time-limited read-only support view the committee is told about, and announcements.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const society = async (email, name, state, flats) => {
  const sec = await createUser(db, email);
  const id = await asUser(db, sec, async (tx) => {
    const sid = (await tx.query(`SELECT public.create_society($1,NULL,'Pune',$2,'411001',NULL,NULL,NULL,NULL,'secretary') AS id`, [name, state])).rows[0].id;
    if (flats) await tx.query('SELECT public.bulk_upsert_units($1,$2)', [sid, JSON.stringify(flats.map((n) => ({ unit_number: n })))]);
    return sid;
  });
  return { sec, id };
};

before(async () => {
  db = await createDb();
  const owner = await createUser(db, 'owner@sahvaas.test');
  await db.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [owner]);
  const a = await society('a@plat.test', 'Alpha Heights', 'Maharashtra', ['101', '102']);
  const b = await society('b@plat.test', 'Beta Towers', 'Karnataka', null);
  // Alpha got as far as its first bill; Beta stopped after registering
  for (const step of ['flats', 'maintenance', 'upi', 'owners_skipped']) await q(a.sec, 'SELECT public.record_setup_step($1,$2)', [a.id, step]);
  await q(a.sec, `INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Maintenance','flat_per_unit',1000)`, [a.id]);
  await q(a.sec, `SELECT public.generate_bills($1,'2026-11-01','2026-11-30','2026-11-10')`, [a.id]);
  await q(a.sec, `SELECT public.record_setup_step($1,'first_bill')`, [a.id]);
  ids = { owner, a, b };
});

test('only the platform owner sees the platform numbers', async () => {
  for (const fn of ['platform_setup_funnel()', 'platform_revenue()']) {
    await assert.rejects(q(ids.a.sec, `SELECT public.${fn}`), /Only the platform owner/);
  }
  await assert.rejects(q(ids.a.sec, 'SELECT * FROM public.platform_society_health()'), /Only the platform owner/);
});

test('the setup funnel: how many reached each step, and where the rest stopped', async () => {
  const f = await val(ids.owner, 'SELECT public.platform_setup_funnel()');
  const reached = Object.fromEntries(f.steps.map((s) => [s.step, s.reached]));
  assert.deepEqual(reached, { society: 2, flats: 1, maintenance: 1, upi: 1, owners: 1, first_bill: 1 });
  assert.deepEqual(f.stopped_at, { flats: 1 });
  assert.equal(f.first_bill.societies, 1);
  assert.ok(f.first_bill.median_minutes >= 0);
});

test('society health: flats, owners joined, collection, CA, opening balance, activity', async () => {
  const rows = await q(ids.owner, 'SELECT * FROM public.platform_society_health()');
  const alpha = rows.find((r) => r.name === 'Alpha Heights');
  const beta = rows.find((r) => r.name === 'Beta Towers');
  assert.deepEqual([alpha.flats, Number(alpha.owners_joined_pct), Number(alpha.collection_pct), alpha.ca_invited, alpha.opening_approved],
    [2, 0, 0, false, false]);
  assert.ok(alpha.last_active);
  assert.equal(beta.flats, 0);
  // a society that has not issued its first bill a week after starting is stuck
  await db.query(`UPDATE societies SET created_at = now() - interval '10 days' WHERE id = $1`, [ids.b.id]);
  const again = await q(ids.owner, 'SELECT name, flag FROM public.platform_society_health()');
  assert.equal(again.find((r) => r.name === 'Beta Towers').flag, 'stuck');
  assert.equal(again.find((r) => r.name === 'Alpha Heights').flag, null);
});

test('revenue in one place', async () => {
  const r = await val(ids.owner, 'SELECT public.platform_revenue()');
  for (const k of ['plans', 'mrr', 'trials_ending_this_week', 'unpaid_invoices', 'ads_this_month', 'otp_cost_this_month']) assert.ok(k in r, k);
  assert.equal(Object.values(r.plans).reduce((x, y) => x + y, 0), 2);
});

test('support sees a society read-only for one hour, and the committee is told', async () => {
  await assert.rejects(q(ids.owner, 'SELECT public.support_snapshot($1)', [ids.a.id]), /Start a support session first/);
  await assert.rejects(q(ids.owner, `SELECT public.start_support_view($1,'')`, [ids.a.id]), /Say why you are opening this society/);
  await assert.rejects(q(ids.a.sec, `SELECT public.start_support_view($1,'curious')`, [ids.b.id]), /Only the platform owner/);
  const s = await val(ids.owner, `SELECT public.start_support_view($1,'Secretary called about bills')`, [ids.a.id]);
  assert.ok(s.expires_at);
  const snap = await val(ids.owner, 'SELECT public.support_snapshot($1)', [ids.a.id]);
  assert.equal(snap.society.name, 'Alpha Heights');
  assert.equal(snap.bills.length, 2);
  const n = await q(ids.a.sec, `SELECT title FROM notifications WHERE kind='support_view'`);
  assert.equal(n.length, 1);
  assert.match(n[0].title, /^Sahvaas support viewed your society on /);
  const views = (await db.query(`SELECT count(*)::int n FROM audit_logs WHERE society_id=$1 AND action LIKE 'support.%'`, [ids.a.id])).rows[0].n;
  assert.equal(views, 2, 'the start and the view are both in the audit log');
  await db.query(`UPDATE support_sessions SET expires_at = now() - interval '1 minute' WHERE society_id = $1`, [ids.a.id]);
  await assert.rejects(q(ids.owner, 'SELECT public.support_snapshot($1)', [ids.a.id]), /Start a support session first/);
});

test('announcements reach the secretaries, filtered by state', async () => {
  await assert.rejects(q(ids.a.sec, `SELECT public.platform_announce('Hi','There',NULL,NULL)`), /Only the platform owner/);
  assert.equal(await val(ids.owner, `SELECT public.platform_announce('New feature','Bills as PDF',NULL,'Karnataka')`), 1);
  assert.equal((await q(ids.b.sec, `SELECT count(*)::int n FROM notifications WHERE kind='announcement'`))[0].n, 1);
  assert.equal((await q(ids.a.sec, `SELECT count(*)::int n FROM notifications WHERE kind='announcement'`))[0].n, 0);
  assert.equal(await val(ids.owner, `SELECT public.platform_announce('Maintenance window','Sunday 2 am',NULL,NULL)`), 2);
});
