// 034: a secretary sets up alone — the short society form, maintenance in one screen, every step recorded.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const rules = async () => (await db.query(
  `SELECT name, account_code, calculation_type, rate::float AS rate, applies_to_selected AS selected, is_active AS active
   FROM billing_rules WHERE society_id=$1 ORDER BY name`, [ids.societyId])).rows;

before(async () => {
  db = await createDb();
  const secretary = crypto.randomUUID();
  await db.query(`INSERT INTO auth.users (id, phone, phone_confirmed_at, raw_user_meta_data) VALUES ($1,'919876500001',now(),'{}')`, [secretary]);
  ids = { secretary };
});

test('a society starts from the short form, even for a mobile-only account', async () => {
  await assert.rejects(q(ids.secretary, `SELECT public.create_society('Setup Heights',NULL,'Pune','Maharashtra','411001','not-an-email',NULL,NULL,NULL,'secretary')`),
    /A valid contact email is required/);
  ids.societyId = await val(ids.secretary, `SELECT public.create_society('Setup Heights',NULL,'Pune','Maharashtra','411001',NULL,NULL,NULL,NULL,'chairman')`);
  const m = (await db.query('SELECT role FROM society_memberships WHERE user_id=$1', [ids.secretary])).rows[0];
  assert.equal(m.role, 'chairman');
  const st = await val(ids.secretary, 'SELECT public.setup_status($1)', [ids.societyId]);
  assert.deepEqual(st.steps, ['society']);
});

test('steps are recorded once, and only known steps', async () => {
  await q(ids.secretary, 'SELECT public.bulk_upsert_units($1,$2)', [ids.societyId, JSON.stringify([
    { wing: 'A', unit_number: 'A-101', floor: 1, carpet_area_sqft: 600 }, { wing: 'A', unit_number: 'A-102', floor: 1, carpet_area_sqft: 800 },
  ])]);
  await q(ids.secretary, `SELECT public.record_setup_step($1,'flats')`, [ids.societyId]);
  await q(ids.secretary, `SELECT public.record_setup_step($1,'flats')`, [ids.societyId]);
  await assert.rejects(q(ids.secretary, `SELECT public.record_setup_step($1,'party')`, [ids.societyId]), /Unknown setup step/);
  const stranger = await createUser(db, 'stranger@setup.test');
  await assert.rejects(q(stranger, `SELECT public.record_setup_step($1,'flats')`, [ids.societyId]), /Only the society committee/);
  assert.equal((await db.query(`SELECT count(*)::int n FROM setup_events WHERE society_id=$1 AND step='flats'`, [ids.societyId])).rows[0].n, 1);
});

test('maintenance in one screen: default ledgers, parking for chosen flats, run again without duplicates', async () => {
  await assert.rejects(q(ids.secretary, `SELECT public.setup_maintenance($1,'flat',0,'[]',10,3,7)`, [ids.societyId]), /Enter the maintenance amount/);
  await assert.rejects(q(ids.secretary, `SELECT public.setup_maintenance($1,'flat',1500,'[]',31,3,7)`, [ids.societyId]), /Due day must be between 1 and 28/);
  const n = await val(ids.secretary, `SELECT public.setup_maintenance($1,'flat',1500,$2,5,4,10)`,
    [ids.societyId, JSON.stringify([{ key: 'sinking', amount: 200 }, { key: 'repair', amount: 100 }, { key: 'parking', amount: 500 }])]);
  assert.equal(n, 4);
  assert.deepEqual(await rules(), [
    { name: 'Maintenance', account_code: '4000', calculation_type: 'flat_per_unit', rate: 1500, selected: false, active: true },
    { name: 'Parking', account_code: '4200', calculation_type: 'flat_per_unit', rate: 500, selected: true, active: true },
    { name: 'Repair Fund', account_code: '3100', calculation_type: 'flat_per_unit', rate: 100, selected: false, active: true },
    { name: 'Sinking Fund', account_code: '3000', calculation_type: 'flat_per_unit', rate: 200, selected: false, active: true },
  ]);
  const s = (await db.query('SELECT due_day_of_month, reminder_first_days, reminder_every_days FROM society_settings WHERE society_id=$1', [ids.societyId])).rows[0];
  assert.deepEqual([s.due_day_of_month, s.reminder_first_days, s.reminder_every_days], [5, 4, 10]);

  // the CA's own charge is never touched by setup
  await q(ids.secretary, `INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Water','flat_per_unit',150)`, [ids.societyId]);
  assert.equal(await val(ids.secretary, `SELECT public.setup_maintenance($1,'sqft',2.5,$2,10,3,7)`,
    [ids.societyId, JSON.stringify([{ key: 'sinking', amount: 250 }])]), 2);
  const after = await rules();
  assert.deepEqual(after.map((r) => [r.name, r.calculation_type, r.rate, r.active]), [
    ['Maintenance', 'per_sqft', 2.5, true],
    ['Parking', 'flat_per_unit', 500, false],
    ['Repair Fund', 'flat_per_unit', 100, false],
    ['Sinking Fund', 'flat_per_unit', 250, true],
    ['Water', 'flat_per_unit', 150, true],
  ]);
  const preview = await val(ids.secretary, `SELECT public.generate_bills($1,'2026-11-01','2026-11-30','2026-11-10',NULL,true)`, [ids.societyId]);
  assert.deepEqual(preview.preview.map((p) => [p.unit_number, Number(p.total)]), [['A-101', 1900], ['A-102', 2400]], '2.5 × area + 250 + 150');
});

test('setup status counts what is done', async () => {
  await q(ids.secretary, `UPDATE society_settings SET upi_id='setup@upi' WHERE society_id=$1`, [ids.societyId]);
  const u101 = (await db.query(`SELECT id FROM units WHERE society_id=$1 AND unit_number='A-101'`, [ids.societyId])).rows[0].id;
  await q(ids.secretary, 'SELECT public.set_flat_owner_contacts($1,$2)', [ids.societyId, JSON.stringify([{ unit_id: u101, name: 'Asha', mobile: '9876543210' }])]);
  const st = await val(ids.secretary, 'SELECT public.setup_status($1)', [ids.societyId]);
  assert.deepEqual([...st.steps].sort(), ['flats', 'maintenance', 'society']);
  assert.deepEqual([st.flats, st.rules, st.upi, st.owners_entered, st.bills, st.joined_owners], [2, 3, true, 1, 0, 0]);
  const stranger = await createUser(db, 'nosy@setup.test');
  await assert.rejects(q(stranger, 'SELECT public.setup_status($1)', [ids.societyId]), /Only the society committee/);
});

test('areas for per-sq.ft change only the area — never the flat\'s building, floor, type or occupancy', async () => {
  await q(ids.secretary, 'SELECT public.bulk_upsert_units($1,$2)', [ids.societyId, JSON.stringify([
    { building: 'Tower A', wing: 'T', unit_number: 'T-101', floor: 1, unit_type: '3BHK', occupancy_status: 'tenant_occupied', carpet_area_sqft: 0 },
  ])]);
  const t = (await db.query(`SELECT id FROM units WHERE society_id=$1 AND unit_number='T-101'`, [ids.societyId])).rows[0].id;
  const stranger = await createUser(db, 'area-stranger@setup.test');
  await assert.rejects(q(stranger, 'SELECT public.set_unit_areas($1,$2)', [ids.societyId, JSON.stringify([{ unit_id: t, carpet_area_sqft: 750 }])]),
    /Only the society committee/);
  assert.equal(await val(ids.secretary, 'SELECT public.set_unit_areas($1,$2)', [ids.societyId, JSON.stringify([{ unit_id: t, carpet_area_sqft: 750 }])]), 1);
  const rows = (await db.query(`SELECT u.carpet_area_sqft::float a, u.unit_type, u.occupancy_status, u.floor_id IS NOT NULL has_floor, b.name building
                                FROM units u JOIN wings w ON w.id = u.wing_id JOIN buildings b ON b.id = w.building_id
                                WHERE u.society_id=$1 AND u.unit_number='T-101'`, [ids.societyId])).rows;
  assert.deepEqual(rows, [{ a: 750, unit_type: '3BHK', occupancy_status: 'tenant_occupied', has_floor: true, building: 'Tower A' }]);
});

test('only the committee\'s admins set up maintenance; "UPI later" is a known step', async () => {
  const cm = await createUser(db, 'cm@setup.test');
  await db.query(`INSERT INTO society_memberships (society_id, user_id, role) VALUES ($1,$2,'committee_member')`, [ids.societyId, cm]);
  await assert.rejects(q(cm, `SELECT public.setup_maintenance($1,'flat',1500,'[]',10,3,7)`, [ids.societyId]), /Only the society committee can set up maintenance/);
  await q(ids.secretary, `SELECT public.record_setup_step($1,'upi_skipped')`, [ids.societyId]);
});
