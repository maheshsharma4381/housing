import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let secretary;
let societyId;

const SOCIETY_ARGS = [
  'Palm Heights CHS', 'Sector 19A, Nerul', 'Navi Mumbai', 'Maharashtra', '400706',
  'secretary@palmheights.in', '+91 98200 00000',
];

before(async () => {
  db = await createDb();
  secretary = await createUser(db, 'secretary@palmheights.in', { fullName: 'Vikram Joshi' });
});

test('signup trigger creates a non-admin profile', async () => {
  const { rows } = await db.query('SELECT full_name, is_platform_admin FROM profiles WHERE id = $1', [secretary]);
  assert.equal(rows[0].full_name, 'Vikram Joshi');
  assert.equal(rows[0].is_platform_admin, false);
});

test('create_society: creator becomes committee member with settings + chart of accounts', async () => {
  societyId = await asUser(db, secretary, async (tx) => {
    const { rows } = await tx.query(
      `SELECT public.create_society($1, $2, $3, $4, $5, $6, $7) AS id`,
      SOCIETY_ARGS
    );
    return rows[0].id;
  });
  assert.ok(societyId);

  await asUser(db, secretary, async (tx) => {
    const soc = await tx.query('SELECT slug, subscription_status FROM societies WHERE id = $1', [societyId]);
    assert.equal(soc.rows[0].slug, 'palm-heights-chs');
    assert.equal(soc.rows[0].subscription_status, 'trial');

    const m = await tx.query('SELECT role FROM society_memberships WHERE society_id = $1 AND user_id = $2', [societyId, secretary]);
    assert.equal(m.rows[0].role, 'secretary');

    const s = await tx.query('SELECT due_day_of_month FROM society_settings WHERE society_id = $1', [societyId]);
    assert.equal(s.rows.length, 1);

    const a = await tx.query('SELECT count(*)::int AS n FROM accounts WHERE society_id = $1', [societyId]);
    assert.equal(a.rows[0].n, 33, 'chart of accounts v2 (013) incl. fixed assets and depreciation');
  });
});

test('create_society: duplicate name gets a unique slug', async () => {
  const other = await createUser(db, 'other@example.com');
  const slug = await asUser(db, other, async (tx) => {
    const { rows } = await tx.query(`SELECT public.create_society($1, $2, $3, $4, $5, $6, $7) AS id`, SOCIETY_ARGS);
    const s = await tx.query('SELECT slug FROM societies WHERE id = $1', [rows[0].id]);
    return s.rows[0].slug;
  });
  assert.match(slug, /^palm-heights-chs-[0-9a-f]{6}$/);
});

test('create_society: validates input and requires sign-in', async () => {
  await assert.rejects(
    asUser(db, secretary, (tx) =>
      tx.query(`SELECT public.create_society($1, $2, $3, $4, $5, $6, $7)`, [...SOCIETY_ARGS.slice(0, 4), '4007', ...SOCIETY_ARGS.slice(5)])
    ),
    /Pincode must be 6 digits/
  );
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE authenticated');
      await tx.query(`SELECT public.create_society($1, $2, $3, $4, $5, $6, $7)`, SOCIETY_ARGS);
    }),
    /must be signed in/
  );
});

test('bulk_upsert_units: imports, upserts and updates total_units', async () => {
  const units = [
    { building: 'Tower A', wing: 'A', floor: 1, unit_number: 'A-101', unit_type: '2BHK', carpet_area_sqft: 650 },
    { building: 'Tower A', wing: 'A', floor: 1, unit_number: 'A-102', unit_type: '3BHK', carpet_area_sqft: 900 },
    { building: 'Tower A', wing: 'B', floor: 2, unit_number: 'B-201' },
  ];
  const first = await asUser(db, secretary, async (tx) => {
    const { rows } = await tx.query('SELECT public.bulk_upsert_units($1, $2) AS r', [societyId, JSON.stringify(units)]);
    return rows[0].r;
  });
  assert.deepEqual(first, { inserted: 3, updated: 0, total_units: 3 });

  const second = await asUser(db, secretary, async (tx) => {
    const changed = [{ ...units[0], unit_type: '2BHK+Study' }, { building: 'Tower A', wing: 'B', floor: 2, unit_number: 'B-202' }];
    const { rows } = await tx.query('SELECT public.bulk_upsert_units($1, $2) AS r', [societyId, JSON.stringify(changed)]);
    return rows[0].r;
  });
  assert.deepEqual(second, { inserted: 1, updated: 1, total_units: 4 });

  await asUser(db, secretary, async (tx) => {
    const b = await tx.query('SELECT count(*)::int AS n FROM buildings WHERE society_id = $1', [societyId]);
    const w = await tx.query('SELECT count(*)::int AS n FROM wings WHERE society_id = $1', [societyId]);
    const u = await tx.query(`SELECT unit_type FROM units WHERE society_id = $1 AND unit_number = 'A-101'`, [societyId]);
    assert.equal(b.rows[0].n, 1);
    assert.equal(w.rows[0].n, 2);
    assert.equal(u.rows[0].unit_type, '2BHK+Study');
  });
});

test('bulk_upsert_units: rejects bad rows with row number and non-committee callers', async () => {
  await assert.rejects(
    asUser(db, secretary, (tx) =>
      tx.query('SELECT public.bulk_upsert_units($1, $2)', [societyId, JSON.stringify([{ unit_number: 'X-1' }, { wing: 'C' }])])
    ),
    /Row 2: unit_number is required/
  );
  const outsider = await createUser(db, 'outsider@example.com');
  await assert.rejects(
    asUser(db, outsider, (tx) =>
      tx.query('SELECT public.bulk_upsert_units($1, $2)', [societyId, JSON.stringify([{ unit_number: 'Z-1' }])])
    ),
    /Only the society committee/
  );
});

test('invites: committee invites, verified invitee claims membership + flat ownership', async () => {
  const unitId = await asUser(db, secretary, async (tx) => {
    const { rows } = await tx.query(`SELECT id FROM units WHERE society_id = $1 AND unit_number = 'A-102'`, [societyId]);
    await tx.query(
      `INSERT INTO member_invites (society_id, email, role, unit_id, invited_by) VALUES ($1, $2, 'resident_owner', $3, $4)`,
      [societyId, 'Resident@Example.com', rows[0].id, secretary]
    );
    return rows[0].id;
  });

  const resident = await createUser(db, 'resident@example.com');
  const invites = await asUser(db, resident, async (tx) => (await tx.query('SELECT status FROM member_invites')).rows);
  assert.equal(invites.length, 1, 'invitee can see their own invite');

  const claimed = await asUser(db, resident, async (tx) => (await tx.query('SELECT public.claim_my_invites() AS n')).rows[0].n);
  assert.equal(claimed, 1);

  await asUser(db, resident, async (tx) => {
    const m = await tx.query('SELECT role, unit_id FROM society_memberships WHERE user_id = $1', [resident]);
    assert.equal(m.rows[0].role, 'resident_owner');
    assert.equal(m.rows[0].unit_id, unitId);
    const again = await tx.query('SELECT public.claim_my_invites() AS n');
    assert.equal(again.rows[0].n, 0, 'claim is idempotent');
  });

  const { rows } = await db.query('SELECT current_owner_id FROM units WHERE id = $1', [unitId]);
  assert.equal(rows[0].current_owner_id, resident);
});

test('invites: unverified email cannot claim', async () => {
  await asUser(db, secretary, (tx) =>
    tx.query(`INSERT INTO member_invites (society_id, email, role, invited_by) VALUES ($1, 'sneaky@example.com', 'resident_owner', $2)`, [societyId, secretary])
  );
  const sneaky = await createUser(db, 'sneaky@example.com', { confirmed: false });
  const claimed = await asUser(db, sneaky, async (tx) => (await tx.query('SELECT public.claim_my_invites() AS n')).rows[0].n);
  assert.equal(claimed, 0);
});

test('invites: residents cannot create invites', async () => {
  const resident = (await db.query(`SELECT id FROM auth.users WHERE email = 'resident@example.com'`)).rows[0].id;
  await assert.rejects(
    asUser(db, resident, (tx) =>
      tx.query(`INSERT INTO member_invites (society_id, email, role, invited_by) VALUES ($1, 'friend@example.com', 'society_admin', $2)`, [societyId, resident])
    ),
    /row-level security/
  );
});
