// 026: the CA enters the opening balance (audited sheet, catch-up, flat-wise and vendor-wise balances at go-live);
// the committee approves it; only then does it reach the books.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';
import { inviteProfessional, approveOpening } from './opening-helpers.mjs';

let db;
let A;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];

/** A society with flats 101, 102, 103 (owners on 101 and 102 only), a secretary, a treasurer, a CA and one vendor. */
async function makeSociety(tag) {
  const secretary = await createUser(db, `sec@${tag}.ob.test`);
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society($1,'Road','Pune','Maharashtra','411001',$2,'9876543210') AS id`,
      [`Opening Heights ${tag}`, `sec@${tag}.ob.test`])).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([{ unit_number: '101' }, { unit_number: '102' }, { unit_number: '103' }])]);
    for (const flat of ['101', '102']) {
      await tx.query(`INSERT INTO member_invites (society_id,email,role,unit_id,invited_by)
        SELECT $1,$2,'resident_owner',id,$3 FROM units WHERE society_id=$1 AND unit_number=$4`, [id, `r${flat}@${tag}.ob.test`, secretary, flat]);
    }
    await tx.query(`INSERT INTO member_invites (society_id,email,role,invited_by) VALUES ($1,$2,'treasurer',$3)`, [id, `tre@${tag}.ob.test`, secretary]);
    return id;
  });
  const r101 = await createUser(db, `r101@${tag}.ob.test`);
  const r102 = await createUser(db, `r102@${tag}.ob.test`);
  const treasurer = await createUser(db, `tre@${tag}.ob.test`);
  for (const u of [r101, r102, treasurer]) await asUser(db, u, (tx) => tx.query('SELECT public.claim_my_invites()'));
  const ca = await inviteProfessional(db, { societyId, inviter: secretary, email: `ca@${tag}.ob.test` });
  const unit = async (n) => (await db.query('SELECT id FROM units WHERE society_id=$1 AND unit_number=$2', [societyId, n])).rows[0].id;
  const vendor = (await db.query(`INSERT INTO vendors (society_id, name, phone, pan) VALUES ($1,'Shiv Lifts','9000000000','ABCPP1234K') RETURNING id`,
    [societyId])).rows[0].id;
  return { societyId, secretary, treasurer, r101, r102, ca, u101: await unit('101'), u102: await unit('102'), u103: await unit('103'), vendor };
}

const AUDITED = [
  { code: '3000', amount: -60000, side: 'liabilities', label: 'Sinking Fund' },
  { code: '3200', amount: -20000, side: 'liabilities', label: 'Reserve Fund' },
  { code: '2000', amount: -8000, side: 'liabilities' },
  { code: '2300', amount: -1000, side: 'liabilities' },
  { code: '1000', amount: 80000, side: 'assets' },
  { code: '1200', amount: 9000, side: 'assets' },
];
const CATCHUP = [
  { code: '4000', amount: -54000 }, { code: '5100', amount: 20000 }, { code: '1200', amount: -4000 },
  { code: '2300', amount: -500 }, { code: '2000', amount: 5000 }, { code: '1000', amount: 33500 },
];
const flatsA = () => [{ unit_id: A.u101, amount: 5000 }, { unit_id: A.u102, amount: -1500 }];
const vendorsA = () => [{ vendor_id: A.vendor, amount: 3000 }];

const save = (s, user, d) => val(user, 'SELECT public.save_opening_balance($1,$2,$3,$4,$5,$6,$7)', [s.societyId,
  d.audited_as_of ?? '2026-03-31', d.live_on ?? '2026-10-01', JSON.stringify(d.audited ?? []), JSON.stringify(d.catchup ?? []),
  JSON.stringify(d.flats ?? []), JSON.stringify(d.vendors ?? [])]);
const show = (s, user) => val(user, 'SELECT public.opening_balance($1)', [s.societyId]);

before(async () => {
  db = await createDb();
  A = await makeSociety('a');
});

test('only the CA prepares the opening balance; the committee reads it; residents cannot', async () => {
  await assert.rejects(save(A, A.secretary, { audited: AUDITED }), /Only the society's CA or accountant can prepare the opening balance/);
  await assert.rejects(show(A, A.r101), /do not have access/);
  const empty = await show(A, A.secretary);
  assert.equal(empty.status, 'none');
  assert.deepEqual(empty.flats.map((f) => [f.name, f.owner_name !== null]), [['Flat 101', true], ['Flat 102', true], ['Flat 103', false]]);
  assert.deepEqual(empty.vendors.map((v) => v.name), ['Shiv Lifts']);
});

test('a draft saves as entered, even unbalanced, and shows each difference', async () => {
  const d = await save(A, A.ca, { audited: [...AUDITED.filter((l) => l.code !== '1000'), { code: '1100', amount: 0, side: 'assets' }] });
  assert.equal(d.status, 'draft');
  assert.equal(d.audited_lines.length, 5, 'zero line dropped');
  assert.equal(Number(d.checks.audited_difference), -80000);
  assert.deepEqual([Number(d.checks.dues_expected), Number(d.checks.dues_entered)], [9000, 0]);
  const logs = await db.query(`SELECT count(*)::int n FROM audit_logs WHERE society_id=$1 AND action='opening_balance.saved'`, [A.societyId]);
  assert.ok(logs.rows[0].n >= 1);
});

test('a draft refuses impossible dates, ledgers, flats and vendors', async () => {
  await assert.rejects(save(A, A.ca, { audited_as_of: '2026-03-30' }), /must be a 31 March/);
  await assert.rejects(save(A, A.ca, { live_on: '2026-03-30' }), /on or after the audited balance sheet date/);
  await assert.rejects(save(A, A.ca, { live_on: '2999-01-01' }), /not in the future/);
  await assert.rejects(save(A, A.ca, { audited: [{ code: '9999', amount: 5, side: 'assets' }] }), /Unknown ledger 9999/);
  await assert.rejects(save(A, A.ca, { audited: [{ code: '4000', amount: -5, side: 'liabilities' }] }), /cannot use 4000/);
  await assert.rejects(save(A, A.ca, { flats: [{ unit_id: A.u101, amount: 1 }, { unit_id: A.u101, amount: 2 }] }), /Each flat appears once/);
  await assert.rejects(save(A, A.ca, { vendors: [{ vendor_id: A.vendor, amount: -5 }] }), /positive amounts/);
});

const submit = (s, user) => val(user, 'SELECT public.submit_opening_balance($1)', [s.societyId]);
const reopen = (s, user) => val(user, 'SELECT public.reopen_opening_balance($1)', [s.societyId]);

test('submit refuses until every part ties, then sends it to the committee', async () => {
  await save(A, A.ca, {});
  await assert.rejects(submit(A, A.ca), /Nothing to submit/);
  await save(A, A.ca, { audited: AUDITED.slice(1) });
  await assert.rejects(submit(A, A.ca), /The balance sheet does not tally — the two sides differ by ₹60,000\.00/);
  await save(A, A.ca, { audited: AUDITED, catchup: CATCHUP.slice(1) });
  await assert.rejects(submit(A, A.ca), /The catch-up entry does not tally/);
  await save(A, A.ca, { audited: AUDITED, catchup: CATCHUP, flats: [{ unit_id: A.u101, amount: 4000 }, { unit_id: A.u102, amount: -1500 }] });
  await assert.rejects(submit(A, A.ca), /Flat-wise dues add up to ₹4,000\.00 but Members' dues come to ₹5,000\.00/);
  await save(A, A.ca, { audited: AUDITED, catchup: CATCHUP, flats: [{ unit_id: A.u101, amount: 5000 }] });
  await assert.rejects(submit(A, A.ca), /Flat-wise advances add up to ₹0\.00 but Advances from members come to ₹1,500\.00/);
  await save(A, A.ca, { audited: AUDITED, catchup: CATCHUP, flats: flatsA(), vendors: [{ vendor_id: A.vendor, amount: 3500 }] });
  await assert.rejects(submit(A, A.ca), /more than Sundry Creditors of ₹3,000\.00/);
  await save(A, A.ca, { audited: AUDITED, catchup: CATCHUP, vendors: vendorsA(),
    flats: [{ unit_id: A.u101, amount: 4000 }, { unit_id: A.u103, amount: 1000 }, { unit_id: A.u102, amount: -1500 }] });
  await assert.rejects(submit(A, A.ca), /Flat 103 has no owner linked/);
  await assert.rejects(submit(A, A.secretary), /Only the society's CA or accountant/);

  await save(A, A.ca, { audited: AUDITED, catchup: CATCHUP, flats: flatsA(), vendors: vendorsA() });
  assert.equal((await submit(A, A.ca)).status, 'submitted');
});

test('a submitted opening balance is changed only after withdrawing it', async () => {
  await assert.rejects(save(A, A.ca, { audited: AUDITED }), /waiting for the committee — withdraw it/);
  await assert.rejects(reopen(A, A.secretary), /Only the society's CA or accountant/);
  assert.equal((await reopen(A, A.ca)).status, 'draft');
  await assert.rejects(reopen(A, A.ca), /Only a submitted opening balance can be withdrawn/);
  assert.equal((await submit(A, A.ca)).status, 'submitted');
});
