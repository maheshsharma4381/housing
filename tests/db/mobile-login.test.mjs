// 032: log in with a mobile. Phone-only accounts, invites by mobile, flats claimed by the login's phone,
// and the OTP limits and costs the Send SMS hook asks the database about.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const phoneUser = async (phone, { confirmed = true } = {}) => {
  const id = crypto.randomUUID();
  await db.query(`INSERT INTO auth.users (id, phone, phone_confirmed_at, raw_user_meta_data) VALUES ($1,$2,$3,'{}')`,
    [id, phone, confirmed ? new Date().toISOString() : null]);
  return id;
};
const claim = async (phone) => (await db.query('SELECT public.otp_claim($1) AS r', [phone])).rows[0].r;
// Move this number's earlier codes back two minutes, past the 60-second resend window
const age = (mobile) => db.query(`UPDATE otp_log SET created_at = created_at - interval '2 minutes' WHERE mobile = $1`, [mobile]);

before(async () => {
  db = await createDb();
  const secretary = await createUser(db, 'sec@mobile.test');
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Mobile Heights','Road','Pune','Maharashtra','411001','sec@mobile.test','9876500000') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }, { unit_number: '102' }])]);
    return id;
  });
  const unit = async (n) => (await db.query('SELECT id FROM units WHERE society_id=$1 AND unit_number=$2', [societyId, n])).rows[0].id;
  ids = { societyId, secretary, u101: await unit('101'), u102: await unit('102') };
  await q(secretary, 'SELECT public.set_flat_owner_contacts($1,$2)', [societyId, JSON.stringify([{ unit_id: ids.u101, name: 'Asha', mobile: '98765 43210' }])]);
  const admin = await createUser(db, 'owner@sahvaas.test');
  await db.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [admin]);
  ids.admin = admin;
});

test('numbers typed with + or 00 keep their own country code', async () => {
  const n = async (m) => (await db.query('SELECT public.normalize_mobile($1) AS v', [m])).rows[0].v;
  assert.equal(await n('+65 9123 4567'), '6591234567');
  assert.equal(await n('0065 9123 4567'), '6591234567');
  assert.equal(await n('+91 98765 43210'), '919876543210');
  assert.equal(await n('98765 43210'), '919876543210');
  assert.equal(await n('+12 345'), null);
  // what otp_claim receives from the hook is already international
  assert.equal((await claim('+6591234567')).foreign, true);
});

test('a foreign login phone never matches an Indian flat mobile', async () => {
  // Supabase stores phones as international digits: 6591234567 is Singapore, not 91 65912 34567
  await q(ids.secretary, 'SELECT public.set_flat_owner_contacts($1,$2)', [ids.societyId, JSON.stringify([{ unit_id: ids.u102, name: 'Indian Owner', mobile: '65912 34567' }])]);
  const sg = await phoneUser('6591234567');
  assert.deepEqual(await val(sg, 'SELECT public.claim_my_flats()'), []);
  await q(ids.secretary, 'SELECT public.set_flat_owner_contacts($1,$2)', [ids.societyId, JSON.stringify([{ unit_id: ids.u102, mobile: '' }])]);
});

test('a phone-only login gets a profile', async () => {
  const id = await phoneUser('919811100000');
  const p = (await db.query('SELECT full_name, email, phone FROM profiles WHERE id=$1', [id])).rows[0];
  assert.deepEqual([p.full_name, p.email, p.phone], ['Member', null, '919811100000']);
});

test('logging in with the flat owner mobile claims the flat', async () => {
  const asha = await phoneUser('919876543210');
  const r = await val(asha, 'SELECT public.claim_my_flats()');
  assert.deepEqual(r, [{ society_name: 'Mobile Heights', flat: '101' }]);
  // the name the committee typed, not "Member"
  assert.equal((await db.query('SELECT full_name FROM profiles WHERE id=$1', [asha])).rows[0].full_name, 'Asha');
  assert.equal((await db.query('SELECT owner_name FROM unit_ownerships WHERE unit_id=$1 AND to_date IS NULL', [ids.u101])).rows[0].owner_name, 'Asha');
  const m = (await db.query(`SELECT role FROM society_memberships WHERE user_id=$1 AND unit_id=$2 AND is_active`, [asha, ids.u101])).rows[0];
  assert.equal(m.role, 'resident_owner');
  assert.deepEqual(await val(asha, 'SELECT public.claim_my_flats()'), [], 'nothing new the second time');
});

test('an invite by mobile reaches only a confirmed phone', async () => {
  await assert.rejects(q(ids.secretary, `INSERT INTO member_invites (society_id, role, invited_by) VALUES ($1,'committee_member',$2)`,
    [ids.societyId, ids.secretary]), /check/i);
  await assert.rejects(q(ids.secretary, `INSERT INTO member_invites (society_id, mobile, role, invited_by) VALUES ($1,'123','committee_member',$2)`,
    [ids.societyId, ids.secretary]), /check/i);
  // a blank email would match every phone login's empty JWT email
  await assert.rejects(q(ids.secretary, `INSERT INTO member_invites (society_id, email, mobile, role, invited_by) VALUES ($1,'','98111 33333','committee_member',$2)`,
    [ids.societyId, ids.secretary]), /check/i);
  await q(ids.secretary, `INSERT INTO member_invites (society_id, mobile, full_name, role, invited_by) VALUES ($1,'98111 22222','Ravi','committee_member',$2)`,
    [ids.societyId, ids.secretary]);
  const ravi = await phoneUser('919811122222', { confirmed: false });
  assert.equal((await q(ravi, 'SELECT * FROM public.my_pending_invites()')).length, 0);
  await db.query('UPDATE auth.users SET phone_confirmed_at = now() WHERE id = $1', [ravi]);
  const inv = await q(ravi, 'SELECT * FROM public.my_pending_invites()');
  assert.deepEqual(inv.map((i) => i.role), ['committee_member']);
  await q(ravi, `SELECT public.respond_to_invite('member', $1, true)`, [inv[0].id]);
  const m = (await db.query(`SELECT role FROM society_memberships WHERE user_id=$1 AND is_active`, [ravi])).rows[0];
  assert.equal(m.role, 'committee_member');
  const nobody = await phoneUser(null);
  await assert.rejects(q(nobody, `SELECT public.respond_to_invite('member', $1, true)`, [inv[0].id]),
    /Verify your email or mobile before responding to invitations/);
});

test('an owner change can name the new owner by mobile alone', async () => {
  await assert.rejects(q(ids.secretary, `SELECT public.transfer_flat_owner($1,'Neha Joshi',NULL,NULL,current_date)`, [ids.u102]),
    /Enter the new owner's mobile or email — they join with it/);
  await q(ids.secretary, `SELECT public.transfer_flat_owner($1,'Neha Joshi',NULL,'98222 33333',current_date)`, [ids.u102]);
  const i = (await db.query(`SELECT email, mobile FROM member_invites WHERE unit_id=$1 AND status='pending'`, [ids.u102])).rows[0];
  assert.deepEqual([i.email, i.mobile], [null, '919822233333']);
});

test('codes: 60 seconds apart, 5 a day for a known number, refusals do not count', async () => {
  const known = '919876543210';
  assert.equal((await claim('+91 98765 43210')).allowed, true);
  const again = await claim(known);
  assert.deepEqual([again.allowed, again.reason], [false, 'Wait a minute before asking for another code']);
  for (let i = 0; i < 4; i += 1) {
    await age(known);
    assert.equal((await claim(known)).allowed, true, `code ${i + 2}`);
  }
  await age(known);
  const sixth = await claim(known);
  assert.deepEqual([sixth.allowed, sixth.reason], [false, 'Too many codes for this number today — try again tomorrow']);
  const row = (await db.query(`SELECT society_id FROM otp_log WHERE mobile=$1 AND status='claimed' LIMIT 1`, [known])).rows[0];
  assert.equal(row.society_id, ids.societyId, 'a known number counts against its society');
});

test('codes: 3 a day for a number nobody registered', async () => {
  const stranger = '919000011111';
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await claim(stranger)).allowed, true);
    await age(stranger);
  }
  assert.equal((await claim(stranger)).reason, 'Too many codes for this number today — try again tomorrow');
  assert.equal((await claim('123')).reason, 'Enter a valid mobile number');
});

test('a failed send does not use up the number', async () => {
  const n = '919000022222';
  for (let i = 0; i < 3; i += 1) {
    const c = await claim(n);
    await db.query(`SELECT public.otp_result($1,'whatsapp',false,'HTTP 500')`, [c.log_id]);
    await age(n);
  }
  assert.equal((await claim(n)).allowed, true);
});

test('the result records the channel and its cost', async () => {
  const cost = async (phone, channel) => {
    const c = await claim(phone);
    await db.query('SELECT public.otp_result($1,$2,true,NULL)', [c.log_id, channel]);
    return (await db.query('SELECT status, channel, cost::float AS cost, foreign_number FROM otp_log WHERE id=$1', [c.log_id])).rows[0];
  };
  assert.deepEqual(await cost('919000033333', 'whatsapp'), { status: 'sent', channel: 'whatsapp', cost: 0.115, foreign_number: false });
  assert.deepEqual(await cost('919000044444', 'sms'), { status: 'sent', channel: 'sms', cost: 0.2, foreign_number: false });
  assert.deepEqual(await cost('447700900123', 'whatsapp'), { status: 'sent', channel: 'whatsapp', cost: 0.8, foreign_number: true });
  assert.deepEqual(await cost('919000055555', 'console'), { status: 'sent', channel: 'console', cost: 0, foreign_number: false });
});

test('the platform owner blocks numbers and caps the day', async () => {
  await assert.rejects(q(ids.secretary, `SELECT public.block_mobile('+44 7700 900999','spam')`), /Only the platform owner can see OTP costs/);
  await q(ids.admin, `SELECT public.block_mobile('+44 7700 900999','spam')`);
  assert.equal((await claim('447700900999')).reason, 'This mobile number is blocked — contact Sahvaas support');
  await q(ids.admin, `SELECT public.unblock_mobile('447700900999')`);
  assert.equal((await claim('447700900999')).allowed, true);

  const used = (await db.query(`SELECT count(*)::int n FROM otp_log WHERE status IN ('claimed','sent') AND created_at > now() - interval '1 day'`)).rows[0].n;
  await assert.rejects(q(ids.secretary, `SELECT public.set_otp_settings($1)`, [JSON.stringify({ platform_daily_cap: used })]), /Only the platform owner/);
  await q(ids.admin, `SELECT public.set_otp_settings($1)`, [JSON.stringify({ platform_daily_cap: 0 })]);
  assert.equal((await claim('919000066666')).reason, 'Mobile login is busy right now — try again later');
  // the cap for unregistered numbers never locks out a registered resident
  await q(ids.secretary, 'SELECT public.set_flat_owner_contacts($1,$2)', [ids.societyId, JSON.stringify([{ unit_id: ids.u102, name: 'Bina', mobile: '98222 44444' }])]);
  assert.equal((await claim('919822244444')).allowed, true);
  await q(ids.admin, `SELECT public.set_otp_settings($1)`, [JSON.stringify({ platform_daily_cap: 2000 })]);
  // a society's registered numbers have their own daily bound: 2 per flat + 20
  const soc = (await db.query(`SELECT count(*)::int n FROM otp_log WHERE society_id=$1 AND status IN ('claimed','sent') AND created_at > now() - interval '1 day'`, [ids.societyId])).rows[0].n;
  for (let i = soc; i < 24; i += 1) {
    await db.query(`INSERT INTO otp_log (mobile, society_id, known, status, created_at) VALUES ('919800000000',$1,true,'sent', now() - interval '1 hour')`, [ids.societyId]);
  }
  await age('919822244444');
  assert.equal((await claim('919822244444')).reason, 'Too many codes for your society today — try again tomorrow');
});

test('a resend goes by SMS when WhatsApp did not reach an Indian number', async () => {
  const c1 = await claim('919000077777');
  assert.equal(c1.prefer_sms, false);
  await db.query(`SELECT public.otp_result($1,'whatsapp',true,NULL)`, [c1.log_id]);
  await age('919000077777');
  assert.equal((await claim('919000077777')).prefer_sms, true);
  const f = await claim('447700900555');
  await db.query(`SELECT public.otp_result($1,'whatsapp',true,NULL)`, [f.log_id]);
  await age('447700900555');
  assert.equal((await claim('447700900555')).prefer_sms, false, 'foreign numbers are WhatsApp only');
});

test('the overview splits channels and flags a society over 5 codes per flat a year', async () => {
  await assert.rejects(q(ids.secretary, 'SELECT public.otp_overview(30)'), /Only the platform owner can see OTP costs/);
  for (let i = 0; i < 11; i += 1) {
    await db.query(`INSERT INTO otp_log (mobile, society_id, known, foreign_number, status, channel, cost) VALUES ('919876543210',$1,true,false,'sent','whatsapp',0.115)`, [ids.societyId]);
  }
  const o = await val(ids.admin, 'SELECT public.otp_overview(30)');
  // three separate buckets: WhatsApp to Indian numbers, SMS, and foreign numbers
  assert.ok(o.totals.whatsapp >= 12 && o.totals.sms >= 1 && o.totals.foreign >= 1, JSON.stringify(o.totals));
  const s = o.societies.find((x) => x.society_id === ids.societyId);
  assert.equal(s.flats, 2);
  assert.equal(s.alert, true);
  assert.equal(o.settings.per_number_daily, 5);
  assert.equal(o.settings.known_daily_cap, 20000);
});

test('only the server may claim a code', async () => {
  await assert.rejects(q(ids.secretary, `SELECT public.otp_claim('919876543210')`), /permission denied/);
  await assert.rejects(q(ids.secretary, `SELECT public.otp_result(gen_random_uuid(),'sms',true,NULL)`), /permission denied/);
  await assert.rejects(q(ids.secretary, 'SELECT * FROM otp_log'), /permission denied/);
});
