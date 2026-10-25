// 010: opening balances, advance auto-adjustment, scheduled late fees, suspension, platform tools.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;
const num = (v) => Number(v);

async function balances(societyId) {
  const { rows } = await db.query(
    `SELECT a.code, sum(l.amount) AS bal FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
     WHERE l.society_id = $1 GROUP BY a.code HAVING sum(l.amount) <> 0 ORDER BY a.code`,
    [societyId]
  );
  return Object.fromEntries(rows.map((r) => [r.code, num(r.bal)]));
}

before(async () => {
  db = await createDb();
  const admin = await createUser(db, 'treasurer@launch.test');
  const societyId = await asUser(db, admin, async (tx) => {
    const id = (await tx.query(
      `SELECT public.create_society('Launch Park', 'Road 6', 'Pune', 'Maharashtra', '411004', 'treasurer@launch.test', '9876543210', NULL, NULL, 'treasurer') AS id`
    )).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1, $2)', [id, JSON.stringify([{ unit_number: '101' }, { unit_number: '102' }, { unit_number: '103' }])]);
    for (const [email, flat] of [['r1@launch.test', '101'], ['r2@launch.test', '102']]) {
      await tx.query(
        `INSERT INTO member_invites (society_id, email, role, unit_id, invited_by)
         SELECT $1, $2, 'resident_owner', id, $3 FROM units WHERE society_id = $1 AND unit_number = $4`,
        [id, email, admin, flat]
      );
    }
    return id;
  });
  const r1 = await createUser(db, 'r1@launch.test');
  const r2 = await createUser(db, 'r2@launch.test');
  for (const u of [r1, r2]) await asUser(db, u, (tx) => tx.query('SELECT public.claim_my_invites()'));
  const unit = async (n) => (await db.query('SELECT id FROM units WHERE society_id = $1 AND unit_number = $2', [societyId, n])).rows[0].id;
  const owner = await createUser(db, 'owner@sahvaas.test');
  await db.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [owner]);
  ids = { societyId, admin, r1, r2, owner, u101: await unit('101'), u102: await unit('102') };
});

const postOpening = (user, accounts, dues, asOf = '2026-03-31') =>
  asUser(db, user, async (tx) =>
    (await tx.query('SELECT public.post_opening_balances($1, $2, $3, $4) AS r', [ids.societyId, asOf, JSON.stringify(accounts), JSON.stringify(dues)])).rows[0].r
  );

test('opening balances: validation', async () => {
  await assert.rejects(postOpening(ids.r1, [{ code: '1000', amount: 1 }], []), /Only the society committee/);
  await assert.rejects(postOpening(ids.admin, [{ code: '1200', amount: 5000 }], []), /flat-wise/);
  await assert.rejects(postOpening(ids.admin, [{ code: '9999', amount: 5000 }], []), /Unknown account code 9999/);
  await assert.rejects(postOpening(ids.admin, [], [{ unit_number: '103', amount: 100 }]), /Flat 103 has no owner linked/);
  await assert.rejects(postOpening(ids.admin, [], [{ unit_number: '999', amount: 100 }]), /Flat 999 not found/);
  await assert.rejects(postOpening(ids.admin, [], [], '2999-01-01'), /today or earlier/);
});

test('opening balances: TB + flat arrears post once, balancing to General Reserve', async () => {
  const r = await postOpening(
    ids.admin,
    [{ code: '1000', amount: 150000 }, { code: '3000', amount: -100000 }],
    [{ unit_number: '101', amount: 4500 }, { unit_number: '102', amount: 4000 }]
  );
  assert.equal(num(r.member_dues_total), 8500);
  assert.equal(r.opening_bills, 2);
  assert.equal(num(r.balancing_to_general_reserve), -58500);
  assert.deepEqual(await balances(ids.societyId), { 1000: 150000, 1200: 8500, 3000: -100000, 3200: -58500 });

  const r1Bills = await asUser(db, ids.r1, async (tx) => (await tx.query('SELECT bill_number, balance_due, is_opening_balance FROM bills')).rows);
  assert.deepEqual(r1Bills.map((b) => [b.bill_number, num(b.balance_due), b.is_opening_balance]), [['OB-0001', 4500, true]]);

  await assert.rejects(postOpening(ids.admin, [{ code: '1000', amount: 1 }], []), /already been posted/);
});

test('overpayment is held as advance and auto-adjusted against the next bill', async () => {
  const payId = await asUser(db, ids.r1, async (tx) =>
    (await tx.query(
      `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, status)
       VALUES ($1, $2, $3, 'P-ADV', 6000, '555555555555', 'pending_verification') RETURNING id`,
      [ids.societyId, ids.u101, ids.r1]
    )).rows[0].id
  );
  const v = await asUser(db, ids.admin, async (tx) => (await tx.query('SELECT public.verify_payment($1, true) AS r', [payId])).rows[0].r);
  assert.equal(num(v.unallocated), 1500);
  assert.equal((await balances(ids.societyId))['2300'], -1500);

  await asUser(db, ids.admin, async (tx) => {
    await tx.query(`INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1, 'Maintenance', 'flat_per_unit', 1000)`, [ids.societyId]);
    await tx.query(`SELECT public.generate_bills($1, '2026-04-01', '2026-04-30', '2026-04-10')`, [ids.societyId]);
  });

  const bills = (await db.query(
    `SELECT u.unit_number, b.balance_due, b.status FROM bills b JOIN units u ON u.id = b.unit_id
     WHERE b.society_id = $1 AND NOT b.is_opening_balance ORDER BY u.unit_number`,
    [ids.societyId]
  )).rows;
  assert.deepEqual(bills.map((b) => [b.unit_number, num(b.balance_due), b.status]), [['101', 0, 'paid'], ['102', 1000, 'issued']]);

  const b = await balances(ids.societyId);
  assert.equal(b['2300'], -500, '1500 advance - 1000 adjusted');
  assert.equal(b['1200'], 8500 - 4500 + 2000 - 1000, 'opening 8500 - paid 4500 + billed 2000 - advance 1000');
  const allocated = (await db.query('SELECT sum(amount) AS s FROM payment_allocations WHERE payment_id = $1', [payId])).rows[0].s;
  assert.equal(num(allocated), 5500);
});

test('nightly late-fee runner skips opening arrears and is not callable by clients', async () => {
  await assert.rejects(asUser(db, ids.admin, (tx) => tx.query('SELECT public.apply_late_fees_all()')), /permission denied/);
  await db.query(`SELECT public.apply_late_fees_all('2026-04-20')`); // system context (pg_cron)
  const rows = (await db.query(
    `SELECT bill_number, status, interest_or_late_fee FROM bills WHERE society_id = $1 AND unit_id = $2 ORDER BY bill_number`,
    [ids.societyId, ids.u102]
  )).rows;
  assert.deepEqual(rows.map((r) => [r.bill_number, r.status, num(r.interest_or_late_fee)]), [
    ['B2604-0002', 'overdue', 20], // 2% of 1000
    ['OB-0002', 'issued', 0],
  ]);
});

test('platform owner: overview, suspension cuts access, plan assignment restores it', async () => {
  await assert.rejects(asUser(db, ids.admin, (tx) => tx.query('SELECT * FROM public.platform_society_overview()')), /Platform admin only/);

  const overview = await asUser(db, ids.owner, async (tx) => (await tx.query('SELECT name, total_units, members, subscription_status FROM public.platform_society_overview()')).rows);
  assert.deepEqual(overview, [{ name: 'Launch Park', total_units: 3, members: 3, subscription_status: 'trial' }]);

  await assert.rejects(
    asUser(db, ids.owner, (tx) => tx.query(`SELECT public.platform_set_society_status($1, 'suspended')`, [ids.societyId])),
    /reason is required/
  );
  await asUser(db, ids.owner, (tx) => tx.query(`SELECT public.platform_set_society_status($1, 'suspended', 'Payment overdue')`, [ids.societyId]));

  const r1Units = await asUser(db, ids.r1, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM units')).rows[0].n);
  assert.equal(r1Units, 0, 'members of a suspended society see nothing');
  await assert.rejects(
    asUser(db, ids.admin, (tx) => tx.query(`SELECT public.generate_bills($1, '2026-05-01', '2026-05-31', '2026-05-10')`, [ids.societyId])),
    /Only the society committee/
  );

  await asUser(db, ids.owner, (tx) => tx.query(`SELECT public.platform_assign_plan($1, 'basic', 'annual')`, [ids.societyId]));
  const s = (await db.query('SELECT is_active, subscription_status FROM societies WHERE id = $1', [ids.societyId])).rows[0];
  assert.deepEqual(s, { is_active: true, subscription_status: 'active' });
  const sub = (await db.query(`SELECT sp.tier_code, s.unit_count FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id WHERE s.society_id = $1`, [ids.societyId])).rows[0];
  assert.deepEqual(sub, { tier_code: 'basic', unit_count: 3 }, 'plans are Free / Basic / Pro since 015');
  const back = await asUser(db, ids.r1, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM units')).rows[0].n);
  assert.equal(back, 3);
});
