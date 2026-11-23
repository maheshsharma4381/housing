// 040: flat requests and NOC letters (Phase 11A).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
const ids = {};

const q = async (user, sql, params = []) => (await asUser(db, user, (tx) => tx.query(sql, params))).rows;
const val = async (user, sql, params = []) => Object.values((await q(user, sql, params))[0])[0];
const fails = async (promise, message) => assert.rejects(promise, (e) => { assert.ok(e.message.includes(message), `expected "${message}", got "${e.message}"`); return true; });

const member = async (email, role, unit, name) => {
  const id = await createUser(db, email, { fullName: name ?? email.split('@')[0] });
  await db.query('INSERT INTO society_memberships (society_id, user_id, role, unit_id) VALUES ($1,$2,$3,$4)', [ids.soc, id, role, unit]);
  return id;
};

before(async () => {
  db = await createDb();
  await db.exec('CREATE SCHEMA IF NOT EXISTS extensions; ALTER EXTENSION pgcrypto SET SCHEMA extensions;');
  ids.sec = await createUser(db, 'sec@noc.test', { fullName: 'Secretary' });
  ids.soc = await asUser(db, ids.sec, async (tx) => {
    const id = (await tx.query(`SELECT public.create_society('Green Park CHS','12 MG Road','Pune','Maharashtra','411001','sec@noc.test','9876500000') AS id`)).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1,$2)', [id, JSON.stringify([
      { unit_number: '101', wing: 'A' }, { unit_number: '102', wing: 'A' }, { unit_number: '103', wing: 'A' }, { unit_number: '104', wing: 'A' }])]);
    await tx.query(`INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Maintenance','flat_per_unit',1500)`, [id]);
    return id;
  });
  await db.query(`UPDATE societies SET registration_number = 'PNA/HSG/123/2001' WHERE id = $1`, [ids.soc]);
  for (const n of ['101', '102', '103', '104']) {
    ids[`u${n}`] = (await db.query('SELECT id FROM units WHERE society_id=$1 AND unit_number=$2', [ids.soc, n])).rows[0].id;
  }
  ids.owner = await member('asha@noc.test', 'resident_owner', ids.u101, 'Asha Patil');
  ids.joint = await member('arun@noc.test', 'resident_owner', ids.u101, 'Arun Patil');
  ids.owner2 = await member('bina@noc.test', 'resident_owner', ids.u102, 'Bina Shah');
  ids.tenant = await member('tara@noc.test', 'resident_tenant', ids.u101, 'Tara Rao');
  ids.tenant2 = await member('tom@noc.test', 'resident_tenant', ids.u102, 'Tom');
  ids.committee = await member('cm@noc.test', 'committee_member', ids.u104, 'Committee Member');
  ids.outsider = await createUser(db, 'out@noc.test');
  ids.soc2 = await asUser(db, ids.outsider, async (tx) =>
    (await tx.query(`SELECT public.create_society('Other','Road','Pune','Maharashtra','411002','out@noc.test','9876500001') AS id`)).rows[0].id);
});

const types = async (user, soc = ids.soc) => q(user, 'SELECT * FROM noc_types WHERE society_id=$1 ORDER BY sort', [soc]);
const typeId = async (code) => (await db.query('SELECT id FROM noc_types WHERE society_id=$1 AND code=$2', [ids.soc, code])).rows[0].id;
const saveType = (user, { id = null, name = 'Bank account', title = 'No Objection Certificate', body = 'This is to certify that {member_name} of flat {flat} is a member.', signatory = 'secretary', checklist = [], tenant = false, active = true } = {}) =>
  val(user, 'SELECT public.save_noc_type($1,$2,$3,$4,$5,$6,$7,$8,$9)', [ids.soc, id, name, title, body, signatory, JSON.stringify(checklist), tenant, active]);

// ---------------------------------------------------------------- 1. NOC types, share certificates
test('a new society has the seven NOC types', async () => {
  const t = await types(ids.sec);
  assert.deepEqual(t.map((x) => x.code), ['sale', 'home_loan', 'leave_licence', 'electricity', 'passport', 'gas', 'repairs']);
  assert.equal(t.find((x) => x.code === 'passport').tenant_can_ask, true);
  assert.equal(t.find((x) => x.code === 'sale').tenant_can_ask, false);
  assert.deepEqual(t.find((x) => x.code === 'leave_licence').checklist, [{ key: 'agreement', label: 'Draft or registered leave and licence agreement', required: true }]);
  assert.ok(t.every((x) => x.body.includes('{member_name}') && x.body.includes('{flat}')));
  // the other society got its own
  assert.equal((await types(ids.outsider, ids.soc2)).length, 7);
});

test('members read NOC types, outsiders do not', async () => {
  assert.equal((await types(ids.tenant)).length, 7);
  assert.equal((await types(ids.outsider)).length, 0);
});

test('the committee edits a type and adds its own', async () => {
  const sale = await typeId('sale');
  await saveType(ids.sec, { id: sale, name: 'Sale of flat (resale)', checklist: [{ label: 'Sale agreement draft', required: true }] });
  const row = (await types(ids.sec)).find((x) => x.code === 'sale');
  assert.equal(row.name, 'Sale of flat (resale)');
  assert.deepEqual(row.checklist, [{ key: 'd1', label: 'Sale agreement draft', required: true }]);
  // an existing key is kept when the item is edited
  await saveType(ids.sec, { id: sale, name: 'Sale of flat', checklist: [{ key: 'd1', label: 'Draft sale agreement', required: false }, { label: 'Bank NOC', required: false }] });
  assert.deepEqual((await types(ids.sec)).find((x) => x.code === 'sale').checklist.map((c) => c.key), ['d1', 'd2']);
  const custom = await saveType(ids.sec, {});
  assert.equal((await db.query('SELECT code FROM noc_types WHERE id=$1', [custom])).rows[0].code, 'custom-1');
  await fails(saveType(ids.owner, {}), 'Only the committee can change NOC letters');
  await fails(saveType(ids.committee, {}), 'Only the committee can change NOC letters');
  await fails(saveType(ids.sec, { name: 'X' }), 'Name the NOC (2 to 80 characters)');
  await fails(saveType(ids.sec, { body: 'Too short' }), 'Write the letter (20 to 4000 characters)');
  await fails(saveType(ids.sec, { checklist: Array.from({ length: 11 }, (_, i) => ({ label: `Doc ${i}`, required: false })) }), 'Up to 10 documents, each with a name');
  await fails(saveType(ids.sec, { checklist: [{ label: 'X', required: true }] }), 'Up to 10 documents, each with a name');
  await fails(saveType(ids.sec, { signatory: 'guard' }), 'Choose who signs');
});

test('share certificate numbers', async () => {
  await q(ids.sec, 'SELECT public.set_share_certificate($1,$2)', [ids.u101, ' SC-12 ']);
  assert.equal((await db.query('SELECT share_certificate_no FROM units WHERE id=$1', [ids.u101])).rows[0].share_certificate_no, 'SC-12');
  await fails(q(ids.owner, 'SELECT public.set_share_certificate($1,$2)', [ids.u101, 'SC-99']), 'Only the committee can do this');
  await q(ids.sec, 'SELECT public.set_share_certificate($1,$2)', [ids.u102, 'SC-13']);
  await q(ids.sec, 'SELECT public.set_share_certificate($1,$2)', [ids.u102, '']);
  assert.equal((await db.query('SELECT share_certificate_no FROM units WHERE id=$1', [ids.u102])).rows[0].share_certificate_no, null);
});

// ---------------------------------------------------------------- 2. requests, documents, history
const ask = (user, code, { unit = ids.u101, purpose = 'Selling the flat', addressee = 'The Manager, HDFC Bank' } = {}) =>
  typeId(code).then((t) => val(user, 'SELECT public.create_noc_request($1,$2,$3,$4)', [unit, t, purpose, addressee]));
const addDoc = (user, req, key, path, name = 'file.pdf') => val(user, 'SELECT public.add_request_document($1,$2,$3,$4)', [req, key, path, name]);
const docPath = (req, f = 'a.pdf') => `${ids.soc}/${req}/${f}`;
const count = async (user, table, req) => (await q(user, `SELECT count(*)::int AS n FROM ${table} WHERE ${table === 'flat_requests' ? 'id' : 'request_id'} = $1`, [req]))[0].n;

test('an owner asks for a sale NOC and the committee is told', async () => {
  const r = await ask(ids.owner, 'sale');
  const row = (await db.query('SELECT * FROM flat_requests WHERE id=$1', [r])).rows[0];
  assert.equal(row.status, 'submitted');
  assert.equal(row.kind, 'noc');
  assert.equal(row.applicant_id, ids.owner);
  assert.deepEqual(row.details, { purpose: 'Selling the flat', addressee: 'The Manager, HDFC Bank' });
  const told = (await db.query(`SELECT user_id, title, link FROM notifications WHERE ref_id=$1 AND kind='request'`, [r])).rows;
  assert.deepEqual(told.map((n) => n.user_id), [ids.sec]);
  assert.equal(told[0].title, 'NOC request: Sale of flat for flat 101');
  assert.equal(told[0].link, 'requests');
  assert.deepEqual((await db.query('SELECT action FROM request_events WHERE request_id=$1', [r])).rows.map((e) => e.action), ['submitted']);
});

test('a tenant asks only for the types tenants may ask for', async () => {
  const r = await ask(ids.tenant, 'passport', { purpose: 'Passport address proof', addressee: '' });
  assert.ok(r);
  await fails(ask(ids.tenant, 'sale'), 'Only an owner of this flat can ask for this NOC');
  await fails(ask(ids.owner, 'sale', { unit: ids.u102 }), 'Only an owner of this flat can ask for this NOC');
  await fails(ask(ids.outsider, 'sale'), 'Only an owner of this flat can ask for this NOC');
  // the committee can ask on someone's behalf
  assert.ok(await ask(ids.sec, 'electricity', { unit: ids.u102 }));
  // an inactive type is not available
  await db.query(`UPDATE noc_types SET is_active=false WHERE society_id=$1 AND code='gas'`, [ids.soc]);
  await fails(ask(ids.owner, 'gas'), 'This NOC is not available');
  await db.query(`UPDATE noc_types SET is_active=true WHERE society_id=$1 AND code='gas'`, [ids.soc]);
});

test('the purpose and addressee are checked', async () => {
  await fails(ask(ids.owner, 'sale', { purpose: 'ab' }), 'Write the purpose (3 to 300 characters)');
  await fails(ask(ids.owner, 'sale', { purpose: 'x'.repeat(301) }), 'Write the purpose (3 to 300 characters)');
  await fails(ask(ids.owner, 'sale', { addressee: 'x'.repeat(161) }), 'The addressee can be up to 160 characters');
});

test('who sees a request', async () => {
  const r = await ask(ids.owner, 'home_loan', { purpose: 'Home loan top-up' });
  for (const u of [ids.owner, ids.joint, ids.committee, ids.sec]) {
    for (const t of ['flat_requests', 'request_events']) assert.equal(await count(u, t, r), 1, `${t} for ${u}`);
  }
  for (const u of [ids.owner2, ids.tenant, ids.tenant2, ids.outsider]) {
    for (const t of ['flat_requests', 'request_events']) assert.equal(await count(u, t, r), 0, `${t} hidden`);
  }
  // a tenant's own request is theirs and the flat owners'
  const t = await ask(ids.tenant, 'passport', { purpose: 'Passport' });
  assert.equal(await count(ids.tenant, 'flat_requests', t), 1);
  assert.equal(await count(ids.owner, 'flat_requests', t), 1);
});

test('documents go against checklist items', async () => {
  const r = await ask(ids.owner, 'leave_licence', { purpose: 'Letting the flat' });
  await fails(addDoc(ids.owner, r, 'nope', docPath(r)), 'Choose a document from the list');
  await fails(addDoc(ids.owner, r, 'agreement', `${ids.soc}/${crypto.randomUUID()}/a.pdf`), 'That file does not belong to this request');
  await fails(addDoc(ids.owner2, r, 'agreement', docPath(r)), 'Only the applicant or the committee can do this');
  const d = await addDoc(ids.joint, r, 'agreement', docPath(r), 'agreement.pdf');
  assert.equal(await count(ids.committee, 'request_documents', r), 1);
  assert.equal(await count(ids.owner2, 'request_documents', r), 0);
  await q(ids.owner, 'SELECT public.remove_request_document($1)', [d]);
  assert.equal(await count(ids.sec, 'request_documents', r), 0);
  assert.deepEqual((await db.query('SELECT action FROM request_events WHERE request_id=$1 ORDER BY at, action', [r])).rows.map((e) => e.action).sort(),
    ['document_added', 'document_removed', 'submitted']);
});

test('withdrawn requests are closed', async () => {
  const r = await ask(ids.owner, 'gas', { purpose: 'New gas line' });
  await fails(q(ids.owner2, 'SELECT public.withdraw_request($1)', [r]), 'Only the applicant or the committee can do this');
  await q(ids.joint, 'SELECT public.withdraw_request($1)', [r]);
  assert.equal((await db.query('SELECT status FROM flat_requests WHERE id=$1', [r])).rows[0].status, 'withdrawn');
  await fails(addDoc(ids.owner, r, 'x', docPath(r)), 'This request can no longer be changed');
  await fails(q(ids.owner, 'SELECT public.withdraw_request($1)', [r]), 'This request can no longer be changed');
  await fails(q(ids.owner, `INSERT INTO storage.objects (bucket_id, name) VALUES ('request-files',$1)`, [docPath(r, 'late.pdf')]), 'row-level security');
});

test('storage follows the request', async () => {
  const r = await ask(ids.owner, 'repairs', { purpose: 'Kitchen work' });
  await q(ids.owner, `INSERT INTO storage.objects (bucket_id, name) VALUES ('request-files',$1)`, [docPath(r, 'quote.pdf')]);
  await fails(q(ids.owner2, `INSERT INTO storage.objects (bucket_id, name) VALUES ('request-files',$1)`, [docPath(r, 'x.pdf')]), 'row-level security');
  await fails(q(ids.owner, `INSERT INTO storage.objects (bucket_id, name) VALUES ('request-files',$1)`, [`${ids.soc2}/${r}/x.pdf`]), 'row-level security');
  const sel = async (u) => (await q(u, `SELECT name FROM storage.objects WHERE bucket_id='request-files' AND name=$1`, [docPath(r, 'quote.pdf')])).length;
  assert.equal(await sel(ids.committee), 1);
  assert.equal(await sel(ids.joint), 1);
  assert.equal(await sel(ids.owner2), 0);
  assert.equal(await sel(ids.outsider), 0);
});

test('the request bucket takes PDFs and images up to 10 MB', async () => {
  const b = (await db.query(`SELECT allowed_mime_types, file_size_limit, public FROM storage.buckets WHERE id='request-files'`)).rows[0];
  assert.deepEqual(b.allowed_mime_types, ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
  assert.equal(Number(b.file_size_limit), 10485760);
  assert.equal(b.public, false);
});
