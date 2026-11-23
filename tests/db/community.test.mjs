// 039: notice read record, one-vote-per-flat polls, staff register.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
const ids = {};

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const fails = async (promise, message) => assert.rejects(promise, (e) => { assert.match(e.message, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); return true; });

const member = async (email, role, unit, { active = true } = {}) => {
  const id = await createUser(db, email, { fullName: email.split('@')[0] });
  await db.query('INSERT INTO society_memberships (society_id, user_id, role, unit_id, is_active) VALUES ($1,$2,$3,$4,$5)',
    [ids.soc, id, role, unit, active]);
  return id;
};

before(async () => {
  db = await createDb();
  await db.exec('CREATE SCHEMA IF NOT EXISTS extensions; ALTER EXTENSION pgcrypto SET SCHEMA extensions;');
  ids.sec = await createUser(db, 'sec@community.test', { fullName: 'Secretary' });
  ids.soc = await asUser(db, ids.sec, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Green Park','Road','Pune','Maharashtra','411001','sec@community.test','9876500000') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([
      { unit_number: '101', wing: 'A' }, { unit_number: '102', wing: 'A' }, { unit_number: '103', wing: 'A' },
      { unit_number: '104', wing: 'A' }, { unit_number: '105', wing: 'A' }])]);
    return id;
  });
  for (const n of ['101', '102', '103', '104', '105']) {
    ids[`u${n}`] = (await db.query('SELECT id FROM units WHERE society_id=$1 AND unit_number=$2', [ids.soc, n])).rows[0].id;
  }
  ids.ownerA = await member('asha@community.test', 'resident_owner', ids.u101);
  ids.ownerA2 = await member('arun@community.test', 'resident_owner', ids.u101); // joint owner of 101
  ids.ownerB = await member('bina@community.test', 'resident_owner', ids.u102);
  ids.ownerB3 = await member('bina3@community.test', 'resident_owner', ids.u103);
  await db.query('INSERT INTO society_memberships (society_id, user_id, role, unit_id) VALUES ($1,$2,$3,$4)', [ids.soc, ids.ownerB3, 'resident_owner', ids.u104]);
  ids.tenant = await member('tara@community.test', 'resident_tenant', ids.u103);
  ids.former = await member('old@community.test', 'resident_owner', ids.u105, { active: false });
  ids.committee = await member('cm@community.test', 'committee_member', ids.u105);
  // someone of another society
  ids.outsider = await createUser(db, 'out@community.test');
  ids.soc2 = await asUser(db, ids.outsider, async (tx) =>
    (await tx.query(`SELECT public.create_society('Other','Road','Pune','Maharashtra','411002','out@community.test','9876500001') AS id`)).rows[0].id);
});

const notice = async (audience = 'all') => val(ids.sec,
  `INSERT INTO notices (society_id, title, content, target_audience, published_by) VALUES ($1,'Water cut','No water on Sunday',$2,$3) RETURNING id`,
  [ids.soc, audience, ids.sec]);
const seen = (user, noticeIds) => val(user, 'SELECT public.mark_notices_seen($1::uuid[])', [noticeIds]);
const summary = (user, id) => val(user, 'SELECT public.notice_read_summary($1)', [id]);

// ---------------------------------------------------------------- 1. notice read record
test('seeing a notice is recorded once', async () => {
  const n = await notice();
  assert.equal(await seen(ids.ownerA, [n]), 1);
  assert.equal(await seen(ids.ownerA, [n]), 0);
  const s = await summary(ids.sec, n);
  assert.equal(s.seen, 1);
  // audience: ownerA, ownerA2, ownerB, ownerB3, tenant (committee member and secretary are not counted)
  assert.equal(s.total, 5);
  assert.deepEqual(s.not_seen.map((p) => p.name).sort(), ['arun', 'bina', 'bina3', 'tara']);
  assert.ok(s.not_seen.every((p) => p.unit_number && p.wing === 'A'));
});

test('the committee is not counted', async () => {
  const n = await notice();
  assert.equal(await seen(ids.sec, [n]), 0);
  assert.equal(await seen(ids.committee, [n]), 0);
  assert.equal((await summary(ids.sec, n)).seen, 0);
});

test('an owners-only notice leaves tenants out', async () => {
  const n = await notice('owners_only');
  assert.equal(await seen(ids.tenant, [n]), 0);
  const s = await summary(ids.sec, n);
  assert.equal(s.total, 4);
  assert.ok(!s.not_seen.some((p) => p.name === 'tara'));
});

test('someone of another society cannot mark it', async () => {
  const n = await notice();
  assert.equal(await seen(ids.outsider, [n]), 0);
  assert.equal(await seen(ids.former, [n]), 0);
});

test('only the committee sees the summary', async () => {
  const n = await notice();
  await fails(summary(ids.ownerA, n), 'Only the committee can see this');
  assert.equal((await summary(ids.committee, n)).total, 5);
});

// ---------------------------------------------------------------- 2. polls
const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const createPoll = (user, { question = 'Repair the lift for Rs 4 lakh?', details = '', options = ['Yes', 'No'], closes = inHours(48) } = {}) =>
  val(user, 'SELECT public.create_poll($1,$2,$3,$4::text[],$5)', [ids.soc, question, details, options, closes]);
const vote = (user, poll, unit, option) => q(user, 'SELECT public.cast_poll_vote($1,$2,$3)', [poll, unit, option]);
const view = (user, poll) => val(user, 'SELECT public.poll_view($1)', [poll]);

test('the committee opens a poll and owners are told', async () => {
  const p = await createPoll(ids.sec);
  const told = (await db.query(`SELECT user_id FROM notifications WHERE ref_id=$1 AND kind='poll'`, [p])).rows.map((r) => r.user_id).sort();
  assert.deepEqual(told, [ids.ownerA, ids.ownerA2, ids.ownerB, ids.ownerB3].sort());
  const t = (await db.query(`SELECT title, link FROM notifications WHERE ref_id=$1 LIMIT 1`, [p])).rows[0];
  assert.deepEqual(t, { title: 'Poll: Repair the lift for Rs 4 lakh?', link: 'polls' });
  await fails(createPoll(ids.ownerA), 'Only the committee');
});

test('poll checks', async () => {
  await fails(createPoll(ids.sec, { question: 'Lift' }), 'Write the question (5 to 200 characters)');
  await fails(createPoll(ids.sec, { details: 'x'.repeat(1001) }), 'Details can be up to 1000 characters');
  await fails(createPoll(ids.sec, { options: ['Yes'] }), 'Give 2 to 6 options, each up to 80 characters');
  await fails(createPoll(ids.sec, { options: ['1', '2', '3', '4', '5', '6', '7'] }), 'Give 2 to 6 options, each up to 80 characters');
  await fails(createPoll(ids.sec, { options: ['Yes', 'n'.repeat(81)] }), 'Give 2 to 6 options, each up to 80 characters');
  await fails(createPoll(ids.sec, { closes: inHours(0.5) }), 'Close the poll between 1 hour and 60 days from now');
  await fails(createPoll(ids.sec, { closes: inHours(61 * 24) }), 'Close the poll between 1 hour and 60 days from now');
});

test('one vote per flat, the last one counts', async () => {
  const p = await createPoll(ids.sec);
  await vote(ids.ownerA, p, ids.u101, 0);
  await vote(ids.ownerA2, p, ids.u101, 1);
  const v = await view(ids.sec, p);
  assert.deepEqual(v.counts, [0, 1]);
  assert.equal(v.voted, 1);
  assert.equal(v.eligible, 4);
});

test('a tenant and a former owner cannot vote', async () => {
  const p = await createPoll(ids.sec);
  await fails(vote(ids.tenant, p, ids.u103, 0), 'Only an owner of this flat can vote');
  await fails(vote(ids.former, p, ids.u105, 0), 'Only an owner of this flat can vote');
  await fails(vote(ids.ownerA, p, ids.u102, 0), 'Only an owner of this flat can vote');
  await fails(vote(ids.ownerA, p, ids.u101, 2), 'Choose one of the options');
});

test('an owner of two flats votes for each', async () => {
  const p = await createPoll(ids.sec);
  await vote(ids.ownerB3, p, ids.u103, 0);
  await vote(ids.ownerB3, p, ids.u104, 1);
  assert.equal((await view(ids.sec, p)).voted, 2);
  assert.deepEqual((await view(ids.ownerB3, p)).my_flats.map((f) => f.choice), [0, 1]);
});

test('residents see counts only after closing', async () => {
  const p = await createPoll(ids.sec);
  await vote(ids.ownerA, p, ids.u101, 1);
  let v = await view(ids.ownerA, p);
  assert.equal(v.counts, null);
  assert.equal(v.open, true);
  assert.equal(v.my_flats[0].choice, 1);
  assert.equal(v.my_flats[0].unit_number, '101');
  await q(ids.sec, 'SELECT public.close_poll($1)', [p]);
  v = await view(ids.ownerA, p);
  assert.deepEqual(v.counts, [0, 1]);
  assert.equal(v.open, false);
  // a tenant can read the poll, with no flat to vote for
  const t = await view(ids.tenant, p);
  assert.deepEqual(t.my_flats, []);
});

test('nobody reads another flat\'s choice', async () => {
  const p = await createPoll(ids.sec);
  await vote(ids.ownerB, p, ids.u102, 0);
  assert.equal((await q(ids.sec, 'SELECT * FROM poll_votes')).length, 0);
  assert.equal((await q(ids.ownerB, 'SELECT * FROM poll_votes')).length, 0);
  const flats = await q(ids.committee, 'SELECT * FROM public.poll_flats($1)', [p]);
  assert.equal(flats.length, 4);
  assert.deepEqual(Object.keys(flats[0]).sort(), ['unit_number', 'voted', 'wing']);
  assert.equal(flats.find((f) => f.unit_number === '102').voted, true);
  await fails(q(ids.ownerA, 'SELECT * FROM public.poll_flats($1)', [p]), 'Only the committee can see this');
});

test('a closed poll takes no votes, a voted poll cannot be deleted', async () => {
  const p = await createPoll(ids.sec);
  await vote(ids.ownerA, p, ids.u101, 0);
  await fails(q(ids.sec, 'SELECT public.delete_poll($1)', [p]), 'A poll with votes cannot be deleted');
  await q(ids.sec, 'SELECT public.close_poll($1)', [p]);
  await fails(vote(ids.ownerA, p, ids.u101, 1), 'This poll is closed');
  await fails(q(ids.sec, 'SELECT public.close_poll($1)', [p]), 'This poll is closed');
  const empty = await createPoll(ids.sec);
  await q(ids.sec, 'SELECT public.delete_poll($1)', [empty]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM polls WHERE id=$1', [empty])).rows[0].n, 0);
});

test('a poll past its closing time is closed', async () => {
  const p = await createPoll(ids.sec);
  await vote(ids.ownerA, p, ids.u101, 0);
  await db.query(`UPDATE polls SET closes_at = now() - interval '1 minute' WHERE id=$1`, [p]);
  await fails(vote(ids.ownerA, p, ids.u101, 1), 'This poll is closed');
  assert.deepEqual((await view(ids.ownerB, p)).counts, [1, 0]);
});

test('polls are visible to members only', async () => {
  const p = await createPoll(ids.sec);
  assert.equal((await q(ids.tenant, 'SELECT id FROM polls WHERE id=$1', [p])).length, 1);
  assert.equal((await q(ids.outsider, 'SELECT id FROM polls WHERE id=$1', [p])).length, 0);
  await fails(view(ids.outsider, p), 'This poll is not in your society');
});
