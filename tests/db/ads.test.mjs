// 016: sponsored cards only for residents of societies on a plan with ads; aggregate stats only.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const adsFor = async (user, sid, placement = 'home_feed') =>
  (await q(user, 'SELECT sponsor_name FROM public.ads_for_me($1,$2)', [sid, placement])).map((r) => r.sponsor_name);

async function society(tag, city, pincode) {
  const admin = await createUser(db, `sec-${tag}@ads.test`);
  const id = await asUser(db, admin, async (tx) => {
    const sid = (await tx.query(`SELECT public.create_society($1,'Road',$2,'Maharashtra',$3,$4,'9876543210') AS id`,
      [`${tag} CHS`, city, pincode, `sec-${tag}@ads.test`])).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [sid, JSON.stringify([{ unit_number: '101' }, { unit_number: '102' }])]);
    await tx.query(`INSERT INTO member_invites (society_id,email,role,unit_id,invited_by)
      SELECT $1,$2,'resident_owner',id,$3 FROM units WHERE society_id=$1 AND unit_number='101'`, [sid, `res-${tag}@ads.test`, admin]);
    return sid;
  });
  const resident = await createUser(db, `res-${tag}@ads.test`);
  await asUser(db, resident, (tx) => tx.query('SELECT public.claim_my_invites()'));
  return { id, admin, resident };
}

const setPlan = (sid, code, inTrial = false) => db.query(
  `UPDATE subscriptions SET plan_id = (SELECT id FROM subscription_plans WHERE tier_code = $2), status = $3,
     trial_ends_on = CASE WHEN $4 THEN current_date + 10 ELSE current_date - 1 END,
     current_period_start = current_date - 1, current_period_end = CASE WHEN $2 = 'free' THEN NULL ELSE current_date + 300 END
   WHERE society_id = $1`, [sid, code, inTrial ? 'trial' : 'active', inTrial]);

const campaign = (fields) => {
  const cols = { title: 'Offer', starts_on: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    ends_on: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), status: 'live', ...fields };
  const keys = Object.keys(cols);
  return q(ids.owner, `INSERT INTO ad_campaigns (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    keys.map((k) => cols[k])).then((r) => r[0].id);
};

before(async () => {
  db = await createDb();
  const owner = await createUser(db, 'owner@ads.test');
  await db.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [owner]);
  ids = { owner };
  ids.F = await society('free', 'Nashik', '422001');
  ids.T = await society('trial', 'Nashik', '422002');
  ids.P = await society('paid', 'Nashik', '422003');
  ids.M = await society('mumbai', 'Navi Mumbai', '400706');
  await setPlan(ids.F.id, 'free');
  await setPlan(ids.T.id, 'pro', true);
  await setPlan(ids.P.id, 'basic');
  await setPlan(ids.M.id, 'free');
});

test('only the platform admin manages campaigns; unsafe links and bad pincodes are refused', async () => {
  await assert.rejects(q(ids.F.resident, `INSERT INTO ad_campaigns (sponsor_name,title,starts_on,ends_on) VALUES ('x','x',current_date,current_date)`), /row-level security/);
  await assert.rejects(campaign({ sponsor_name: 'Bad', cta_url: 'javascript:alert(1)' }), /ad_campaigns_cta_url_check/);
  await assert.rejects(campaign({ sponsor_name: 'Bad', pincodes: ['4000'] }), /6 digits/);
  await assert.rejects(campaign({ sponsor_name: 'Bad', placements: ['payment_screen'] }), /ad_campaigns_placements_check/);

  ids.pest = await campaign({ sponsor_name: 'Godavari Pest Control', cities: [' NASHIK '], placements: ['home_feed', 'notices'],
    cta_label: 'WhatsApp', cta_url: 'https://wa.me/919800000000', priority: 5 });
  ids.house = await campaign({ sponsor_name: 'Sahvaas', is_house: true, placements: ['home_feed'] });
  ids.draft = await campaign({ sponsor_name: 'Draft Co', cities: ['nashik'], status: 'draft' });
  await campaign({ sponsor_name: 'Old Co', cities: ['nashik'], starts_on: '2026-01-01', ends_on: '2026-01-31' });
  ids.pin = await campaign({ sponsor_name: 'Vashi Tiffins', pincodes: ['400706'] });
  assert.deepEqual((await db.query('SELECT cities FROM ad_campaigns WHERE id=$1', [ids.pest])).rows[0].cities, ['nashik']);
});

test('residents of a Free society get sponsors first, house cards fill the slot', async () => {
  assert.deepEqual(await adsFor(ids.F.resident, ids.F.id), ['Godavari Pest Control', 'Sahvaas']);
  assert.deepEqual(await adsFor(ids.F.resident, ids.F.id, 'notices'), ['Godavari Pest Control']);
  assert.deepEqual(await adsFor(ids.M.resident, ids.M.id), ['Vashi Tiffins', 'Sahvaas'], 'pincode targeting; Nashik sponsor not shown in Navi Mumbai');
});

test('nobody else sees cards: committee, trial, paid plans, other societies', async () => {
  assert.deepEqual(await adsFor(ids.F.admin, ids.F.id), [], 'the committee never sees ads');
  assert.deepEqual(await adsFor(ids.T.resident, ids.T.id), [], 'no ads during the trial');
  assert.deepEqual(await adsFor(ids.P.resident, ids.P.id), [], 'no ads on paid plans');
  assert.deepEqual(await adsFor(ids.F.resident, ids.M.id), [], 'only for your own society');
  assert.equal(await val(ids.F.resident, 'SELECT count(*)::int FROM ad_campaigns'), 0, 'campaign table itself is not readable');
});

test('events are counted per society and day, with no user ids', async () => {
  const ev = (user, kind, sid = ids.F.id) => val(user, `SELECT public.record_ad_event($1,$2,'home_feed',$3)`, [ids.pest, sid, kind]);
  assert.equal(await ev(ids.F.resident, 'impression'), true);
  assert.equal(await ev(ids.F.resident, 'impression'), true);
  assert.equal(await ev(ids.F.resident, 'click'), true);
  assert.equal(await ev(ids.F.admin, 'impression'), false, 'committee views are not counted');
  assert.equal(await ev(ids.P.resident, 'impression', ids.P.id), false, 'paid society: ignored');
  assert.equal(await val(ids.F.resident, `SELECT public.record_ad_event($1,$2,'home_feed','impression')`, [ids.draft, ids.F.id]), false, 'drafts are not counted');

  const rows = (await db.query('SELECT impressions, clicks FROM ad_daily_stats WHERE campaign_id=$1', [ids.pest])).rows;
  assert.deepEqual(rows, [{ impressions: 2, clicks: 1 }]);
  const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='ad_daily_stats' ORDER BY ordinal_position`)).rows.map((r) => r.column_name);
  assert.deepEqual(cols, ['campaign_id', 'society_id', 'day', 'placement', 'impressions', 'clicks']);
  assert.equal(await val(ids.F.resident, 'SELECT count(*)::int FROM ad_daily_stats'), 0);
});

test('reach and report for the platform admin', async () => {
  const reach = await val(ids.owner, 'SELECT public.ad_reach($1)', [ids.pest]);
  assert.deepEqual(reach, { societies: 1, flats: 2 }, 'only the Free society in Nashik');
  assert.deepEqual(await val(ids.owner, 'SELECT public.ad_reach($1)', [ids.draft]), { societies: 1, flats: 2 }, 'drafts show reach before going live');
  const report = await q(ids.owner, `SELECT campaign_id, impressions, clicks, societies FROM public.platform_ad_report(current_date - 7, current_date)`);
  assert.deepEqual(report.map((r) => [r.campaign_id, Number(r.impressions), Number(r.clicks), Number(r.societies)]), [[ids.pest, 2, 1, 1]]);
  await assert.rejects(q(ids.F.admin, 'SELECT public.ad_reach($1)', [ids.pest]), /Platform admin only/);
});

test('cards stop as soon as the society upgrades', async () => {
  await setPlan(ids.F.id, 'basic');
  assert.deepEqual(await adsFor(ids.F.resident, ids.F.id), []);
  assert.equal(await val(ids.F.resident, `SELECT public.record_ad_event($1,$2,'home_feed','impression')`, [ids.pest, ids.F.id]), false);
});
