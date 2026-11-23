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

// ---------------------------------------------------------------- 3. decisions and the NOC letter
const decide = (user, req, decision, note = null) => val(user, 'SELECT public.decide_request($1,$2,$3)', [req, decision, note]);
const letter = async (req) => (await db.query('SELECT * FROM noc_letters WHERE request_id=$1', [req])).rows[0];
const todayIst = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date()).replace(/Sept/, 'Sep');
const fyNow = () => {
  const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date()).split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};

test('approving issues a numbered letter', async () => {
  const r1 = await ask(ids.owner, 'electricity', { purpose: 'MSEDCL meter transfer', addressee: 'The Executive Engineer, MSEDCL' });
  const out = await decide(ids.sec, r1, 'approve');
  assert.equal(out.number, `NOC/${fyNow()}/001`);
  const l = await letter(r1);
  assert.equal(l.number, `NOC/${fyNow()}/001`);
  assert.equal(l.issued_to, 'Asha Patil');
  assert.equal(l.flat_label, '101');
  assert.equal(l.signatory, 'secretary');
  assert.ok(!l.body.includes('{'), 'every placeholder is filled');
  assert.ok(l.body.startsWith('The Executive Engineer, MSEDCL'));
  assert.ok(l.body.includes('Green Park CHS (Registration No. PNA/HSG/123/2001), 12 MG Road, Pune, Maharashtra 411001'));
  assert.ok(l.body.includes('share certificate No. SC-12'));
  assert.equal((await db.query('SELECT status FROM flat_requests WHERE id=$1', [r1])).rows[0].status, 'approved');
  const r2 = await ask(ids.tenant, 'passport', { purpose: 'Passport', addressee: '' });
  await addDoc(ids.tenant, r2, 'id', docPath(r2, 'pan.jpg'));
  assert.equal((await decide(ids.sec, r2, 'approve')).number, `NOC/${fyNow()}/002`);
  const l2 = await letter(r2);
  assert.ok(l2.body.startsWith('To whomsoever it may concern'));
  assert.equal(l2.issued_to, 'Tara Rao');
  // the applicant is told
  const n = (await db.query(`SELECT title FROM notifications WHERE ref_id=$1 AND user_id=$2`, [r2, ids.tenant])).rows.map((x) => x.title);
  assert.deepEqual(n, ['NOC approved: Passport / address proof']);
});

test('the number restarts each financial year', async () => {
  assert.equal((await db.query(`SELECT public.noc_letter_number($1,'2027-04-01') AS n`, [ids.soc])).rows[0].n, 'NOC/2027-28/001');
  assert.equal((await db.query(`SELECT public.noc_letter_number($1,'2027-03-31') AS n`, [ids.soc])).rows[0].n, 'NOC/2026-27/003');
});

test('the dues line follows the flat\'s account', async () => {
  await q(ids.sec, `SELECT public.generate_bills($1,'2026-10-01','2026-10-31','2026-10-10')`, [ids.soc]);
  const due = (await db.query(`SELECT sum(balance_due)::numeric AS d FROM bills WHERE unit_id=$1`, [ids.u102])).rows[0].d;
  const r = await ask(ids.owner2, 'gas', { unit: ids.u102, purpose: 'Gas line' });
  const preview = await val(ids.committee, 'SELECT public.noc_preview($1)', [r]);
  assert.ok(preview.body.includes(`Dues of ₹${Number(due).toLocaleString('en-IN')} are outstanding as on ${todayIst()}.`), preview.body);
  await decide(ids.sec, r, 'approve');
  assert.equal(Number((await letter(r)).dues_amount), Number(due));
  // pay more than is due: an advance is not "dues of ₹-…"
  const pay = await val(ids.owner2, `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, status)
    VALUES ($1,$2,$3,'PAY-NOC-1',$4,'625219401299','pending_verification') RETURNING id`, [ids.soc, ids.u102, ids.owner2, Number(due) + 500]);
  await q(ids.sec, 'SELECT public.verify_payment($1, true)', [pay]);
  const r2 = await ask(ids.owner2, 'gas', { unit: ids.u102, purpose: 'Second gas line' });
  await decide(ids.sec, r2, 'approve');
  const body = (await letter(r2)).body;
  assert.ok(body.includes(`There are no dues outstanding as on ${todayIst()}.`), body);
  assert.ok(!body.includes('₹-'));
});

test('a missing required document blocks approval', async () => {
  const r = await ask(ids.owner, 'leave_licence', { purpose: 'Letting the flat' });
  await fails(decide(ids.sec, r, 'approve'), 'Add "Draft or registered leave and licence agreement" before approving');
});

test('ask for changes, then resubmit', async () => {
  const r = await ask(ids.owner, 'repairs', { purpose: 'Bathroom work' });
  await fails(decide(ids.sec, r, 'changes', ''), 'Write what needs to change');
  await decide(ids.sec, r, 'changes', 'Attach the contractor quote');
  assert.equal((await db.query('SELECT status, committee_note FROM flat_requests WHERE id=$1', [r])).rows[0].status, 'changes_asked');
  await fails(decide(ids.sec, r, 'approve'), 'Wait for the applicant to send the changes');
  assert.ok((await db.query(`SELECT 1 FROM notifications WHERE ref_id=$1 AND user_id=$2 AND title='Changes needed: Repairs / renovation'`, [r, ids.owner])).rows.length);
  await addDoc(ids.owner, r, 'scope', docPath(r, 'quote.pdf'));
  await q(ids.owner, 'SELECT public.resubmit_request($1,$2)', [r, 'Quote attached']);
  assert.equal((await db.query('SELECT status FROM flat_requests WHERE id=$1', [r])).rows[0].status, 'submitted');
  await decide(ids.sec, r, 'approve');
  const steps = (await db.query('SELECT action FROM request_events WHERE request_id=$1 ORDER BY at', [r])).rows.map((e) => e.action);
  assert.deepEqual(steps, ['submitted', 'changes_asked', 'document_added', 'resubmitted', 'approved']);
});

test('only managing roles decide; a decided request stays decided', async () => {
  const r = await ask(ids.owner, 'sale', { purpose: 'Selling' });
  await fails(decide(ids.committee, r, 'approve'), 'Only the committee can decide requests');
  await fails(decide(ids.owner, r, 'approve'), 'Only the committee can decide requests');
  await fails(decide(ids.sec, r, 'reject', ''), 'Write the reason');
  await decide(ids.sec, r, 'reject', 'Dues pending');
  assert.ok((await db.query(`SELECT 1 FROM notifications WHERE ref_id=$1 AND title='NOC request declined: Sale of flat'`, [r])).rows.length);
  await fails(decide(ids.sec, r, 'approve'), 'This request has already been decided');
  await fails(decide(ids.sec, r, 'maybe', 'x'), 'Choose approve, changes or reject');
});

test('the letter is visible to those who see the request', async () => {
  const r = await ask(ids.owner, 'electricity', { purpose: 'Meter' });
  await decide(ids.sec, r, 'approve');
  const n = async (u) => (await q(u, 'SELECT count(*)::int AS n FROM noc_letters WHERE request_id=$1', [r]))[0].n;
  assert.equal(await n(ids.joint), 1);
  assert.equal(await n(ids.committee), 1);
  assert.equal(await n(ids.owner2), 0);
  assert.equal(await n(ids.outsider), 0);
});

test('the share certificate number appears when recorded', async () => {
  const r = await ask(ids.owner2, 'electricity', { unit: ids.u102, purpose: 'Meter' });
  await decide(ids.sec, r, 'approve');
  assert.ok((await letter(r)).body.includes('share certificate No. not recorded'));
});
