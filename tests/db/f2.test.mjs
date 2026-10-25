// 012: invite consent, read-only committee_member, society_summary, leads, notification limits.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;

const asAnon = (fn) => db.transaction(async (tx) => {
  await tx.exec('SET LOCAL ROLE anon');
  return fn(tx);
});
const invite = (tx, societyId, email, role, invitedBy, flat = null) => tx.query(
  `INSERT INTO member_invites (society_id,email,role,unit_id,invited_by)
   VALUES ($1,$2,$3,(SELECT id FROM units WHERE society_id=$1 AND unit_number=$4),$5) RETURNING id`,
  [societyId, email, role, flat, invitedBy]
).then((r) => r.rows[0].id);
const respond = (user, kind, id, accept) =>
  asUser(db, user, async (tx) => (await tx.query('SELECT public.respond_to_invite($1,$2,$3) AS r', [kind, id, accept])).rows[0].r);

before(async () => {
  db = await createDb();
  const admin = await createUser(db, 'sec@f2.test', { fullName: 'Asha Secretary' });
  const societyId = await asUser(db, admin, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('F2 Residency','Road','Pune','Maharashtra','411005','sec@f2.test','9876543210') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '1' }, { unit_number: '2' }])]);
    await tx.query(`INSERT INTO billing_rules (society_id,name,calculation_type,rate) VALUES ($1,'Maint','flat_per_unit',1500)`, [id]);
    return id;
  });
  ids = { admin, societyId };
});

test('H3: invitations wait for the invitee; declining keeps their profile private', async () => {
  const stranger = await createUser(db, 'stranger@f2.test');
  await db.query(`UPDATE profiles SET phone='9999911111' WHERE id=$1`, [stranger]);
  const inviteId = await asUser(db, ids.admin, (tx) => invite(tx, ids.societyId, 'Stranger@F2.test', 'resident_owner', ids.admin, '1'));

  const pending = await asUser(db, stranger, async (tx) => (await tx.query('SELECT kind, society_name, role, flat, invited_by_name FROM public.my_pending_invites()')).rows);
  assert.deepEqual(pending, [{ kind: 'member', society_name: 'F2 Residency', role: 'resident_owner', flat: '1', invited_by_name: 'Asha Secretary' }]);

  // Nothing happens until they respond
  const before = (await db.query('SELECT count(*)::int n FROM society_memberships WHERE user_id=$1', [stranger])).rows[0].n;
  assert.equal(before, 0);

  // Someone else cannot answer for them
  const other = await createUser(db, 'other@f2.test');
  await assert.rejects(respond(other, 'member', inviteId, true), /not found or no longer pending/);

  assert.deepEqual(await respond(stranger, 'member', inviteId, false), { kind: 'member', society_id: ids.societyId, accepted: false });
  assert.equal((await db.query('SELECT status FROM member_invites WHERE id=$1', [inviteId])).rows[0].status, 'declined');
  const phone = await asUser(db, ids.admin, async (tx) => (await tx.query('SELECT phone FROM profiles WHERE id=$1', [stranger])).rows[0]?.phone);
  assert.equal(phone, undefined, 'committee cannot read a stranger who declined');
  await assert.rejects(respond(stranger, 'member', inviteId, true), /no longer pending/);
});

test('H3: accepting links the flat; unverified users cannot respond', async () => {
  const owner = await createUser(db, 'owner@f2.test');
  const inviteId = await asUser(db, ids.admin, (tx) => invite(tx, ids.societyId, 'owner@f2.test', 'resident_owner', ids.admin, '2'));
  await respond(owner, 'member', inviteId, true);
  const m = (await db.query('SELECT role FROM society_memberships WHERE user_id=$1', [owner])).rows[0];
  assert.equal(m.role, 'resident_owner');
  assert.equal((await db.query(`SELECT current_owner_id FROM units WHERE society_id=$1 AND unit_number='2'`, [ids.societyId])).rows[0].current_owner_id, owner);
  ids.owner = owner;

  const unverified = await createUser(db, 'unverified@f2.test', { confirmed: false });
  const inv2 = await asUser(db, ids.admin, (tx) => invite(tx, ids.societyId, 'unverified@f2.test', 'resident_tenant', ids.admin));
  assert.equal((await asUser(db, unverified, async (tx) => (await tx.query('SELECT count(*)::int n FROM public.my_pending_invites()')).rows[0].n)), 0);
  await assert.rejects(respond(unverified, 'member', inv2, true), /Verify your email/);
});

test('H3: professional invites are accepted the same way', async () => {
  const ca = await createUser(db, 'ca@f2.test');
  const proInvite = (await asUser(db, ids.admin, (tx) => tx.query(
    `INSERT INTO professional_invites (society_id, invited_email, role, permissions, invited_by, expires_at)
     VALUES ($1,'ca@f2.test','ca','["view_reports"]',$2, now() + interval '7 days') RETURNING id`,
    [ids.societyId, ids.admin]))).rows[0].id;
  const list = await asUser(db, ca, async (tx) => (await tx.query('SELECT kind, permissions FROM public.my_pending_invites()')).rows);
  assert.deepEqual(list, [{ kind: 'professional', permissions: ['view_reports'] }]);
  await respond(ca, 'professional', proInvite, true);
  const g = (await db.query('SELECT status FROM society_professional_access WHERE professional_user_id=$1', [ca])).rows[0];
  assert.equal(g.status, 'active');
});

test('M6: committee_member reads committee data but cannot act', async () => {
  const cm = await createUser(db, 'cm@f2.test');
  const inv = await asUser(db, ids.admin, (tx) => invite(tx, ids.societyId, 'cm@f2.test', 'committee_member', ids.admin));
  await respond(cm, 'member', inv, true);

  await asUser(db, ids.admin, (tx) => tx.query(`SELECT public.generate_bills($1,'2026-10-01','2026-10-31','2026-10-10')`, [ids.societyId]));
  await asUser(db, cm, async (tx) => {
    assert.equal((await tx.query('SELECT count(*)::int n FROM bills')).rows[0].n, 1);
    assert.equal((await tx.query('SELECT count(*)::int n FROM bill_items')).rows[0].n, 1);
    const tb = (await tx.query('SELECT * FROM public.trial_balance($1)', [ids.societyId])).rows;
    assert.ok(tb.length > 0, 'financial reports visible');
    const names = (await tx.query('SELECT full_name FROM profiles ORDER BY full_name')).rows.length;
    assert.ok(names >= 3, 'member names visible');
  });
  await assert.rejects(
    asUser(db, cm, (tx) => tx.query(`SELECT public.generate_bills($1,'2026-11-01','2026-11-30','2026-11-10')`, [ids.societyId])),
    /Only the society committee/
  );
  await assert.rejects(
    asUser(db, cm, (tx) => tx.query(`INSERT INTO notices (society_id,title,content,published_by) VALUES ($1,'x','y',$2)`, [ids.societyId, cm])),
    /row-level security/
  );
  ids.cm = cm;
});

test('M3: society_summary aggregates in the database; residents are refused', async () => {
  const s = await asUser(db, ids.cm, async (tx) => (await tx.query('SELECT public.society_summary($1) AS s', [ids.societyId])).rows[0].s);
  assert.equal(s.units, 2);
  assert.equal(Number(s.billed), 1500);
  assert.equal(Number(s.outstanding), 1500);
  assert.equal(s.bills, 1);
  assert.equal(s.upi_configured, false);
  await assert.rejects(asUser(db, ids.owner, (tx) => tx.query('SELECT public.society_summary($1)', [ids.societyId])), /Only the society committee/);
});

test('M7: anyone can submit a lead; only the platform owner can read them', async () => {
  const lead = { name: 'Vikram Joshi', email: 'vj@palm.in', phone: '+91 98200 00000', society_name: 'Palm Heights CHS', city: 'Navi Mumbai', units: 96 };
  const insert = (l) => asAnon((tx) => tx.query(
    'INSERT INTO leads (name,email,phone,society_name,city,units) VALUES ($1,$2,$3,$4,$5,$6)',
    [l.name, l.email, l.phone, l.society_name, l.city, l.units]
  ));
  await insert(lead);
  await assert.rejects(insert({ ...lead, email: 'not-an-email' }), /leads_email_check/);
  await insert(lead);
  await insert(lead);
  await assert.rejects(insert(lead), /already have your request/);

  assert.equal((await asAnon(async (tx) => (await tx.query('SELECT count(*)::int n FROM leads')).rows[0].n)), 0);
  assert.equal((await asUser(db, ids.admin, async (tx) => (await tx.query('SELECT count(*)::int n FROM leads')).rows[0].n)), 0);
  const owner = await createUser(db, 'owner@sahvaas.test');
  await db.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [owner]);
  assert.equal((await asUser(db, owner, async (tx) => (await tx.query('SELECT count(*)::int n FROM leads')).rows[0].n)), 3);
});

test('M12: notifications are deduplicated per event and capped per day', async () => {
  const reserve = (user, ref, n, type = 'bills_issued') =>
    asUser(db, user, async (tx) => (await tx.query('SELECT public.reserve_notification($1,$2,$3,$4) AS r', [ids.societyId, type, ref, n])).rows[0].r);
  const ref = crypto.randomUUID();
  assert.deepEqual(await reserve(ids.admin, ref, 10), { allowed: true });
  assert.deepEqual(await reserve(ids.admin, ref, 10), { allowed: false, reason: 'Already emailed in the last 24 hours' });
  assert.deepEqual(await reserve(ids.admin, crypto.randomUUID(), 1995), { allowed: false, reason: 'Daily email limit reached for this society' });
  assert.equal((await reserve(ids.owner, crypto.randomUUID(), 1)).allowed, false, 'residents cannot send');
  assert.equal((await reserve(ids.cm, crypto.randomUUID(), 1)).allowed, false, 'read-only committee cannot send');
});
