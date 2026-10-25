// Notices, complaints, documents/storage and the expense approval workflow (008).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;

async function invite(tx, societyId, email, role, invitedBy, unitNumber = null) {
  await tx.query(
    `INSERT INTO member_invites (society_id, email, role, unit_id, invited_by)
     VALUES ($1, $2, $3, (SELECT id FROM units WHERE society_id = $1 AND unit_number = $4), $5)`,
    [societyId, email, role, unitNumber, invitedBy]
  );
}

before(async () => {
  db = await createDb();
  const secretary = await createUser(db, 'secretary@ops.test');
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(
      `SELECT public.create_society('Ops Residency', 'Road 4', 'Nagpur', 'Maharashtra', '440001', 'secretary@ops.test', '9876543210') AS id`
    )).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1, $2)', [id, JSON.stringify([{ unit_number: '101' }, { unit_number: '102' }])]);
    await invite(tx, id, 'treasurer@ops.test', 'treasurer', secretary);
    await invite(tx, id, 'chairman@ops.test', 'chairman', secretary);
    await invite(tx, id, 'owner@ops.test', 'resident_owner', secretary, '101');
    await invite(tx, id, 'tenant@ops.test', 'resident_tenant', secretary, '102');
    return id;
  });
  const users = {};
  for (const name of ['treasurer', 'chairman', 'owner', 'tenant']) {
    users[name] = await createUser(db, `${name}@ops.test`);
    await asUser(db, users[name], (tx) => tx.query('SELECT public.claim_my_invites()'));
  }
  const unit101 = (await db.query(`SELECT id FROM units WHERE society_id = $1 AND unit_number = '101'`, [societyId])).rows[0].id;
  ids = { societyId, secretary, unit101, ...users };
});

const titlesVisibleTo = (user) =>
  asUser(db, user, async (tx) => (await tx.query('SELECT title FROM notices ORDER BY title')).rows.map((r) => r.title));

test('notices respect audience and expiry; publisher is stamped', async () => {
  await asUser(db, ids.secretary, (tx) =>
    tx.query(
      `INSERT INTO notices (society_id, title, content, target_audience, expires_at, published_by) VALUES
         ($1, 'All', 'x', 'all', NULL, $2),
         ($1, 'Owners', 'x', 'owners_only', NULL, $2),
         ($1, 'Tenants', 'x', 'tenants_only', NULL, $2),
         ($1, 'Committee', 'x', 'committee_only', NULL, $2),
         ($1, 'Expired', 'x', 'all', now() - interval '1 day', $2)`,
      [ids.societyId, ids.owner] // publisher spoofed as owner -> must be overwritten
    )
  );
  assert.deepEqual(await titlesVisibleTo(ids.owner), ['All', 'Owners']);
  assert.deepEqual(await titlesVisibleTo(ids.tenant), ['All', 'Tenants']);
  assert.deepEqual(await titlesVisibleTo(ids.secretary), ['All', 'Committee', 'Expired', 'Owners', 'Tenants']);

  const { rows } = await db.query('SELECT DISTINCT published_by FROM notices');
  assert.deepEqual(rows, [{ published_by: ids.secretary }]);

  await assert.rejects(
    asUser(db, ids.owner, (tx) => tx.query(`INSERT INTO notices (society_id, title, content, published_by) VALUES ($1, 'Spam', 'x', $2)`, [ids.societyId, ids.owner])),
    /row-level security/
  );
});

test('complaints: sequential tickets, comment thread and resolution timestamp', async () => {
  const raise = (title) =>
    asUser(db, ids.owner, async (tx) =>
      (await tx.query(
        `INSERT INTO complaints (society_id, unit_id, user_id, ticket_number, category, title, description)
         VALUES ($1, $2, $3, '', 'plumbing', $4, 'details') RETURNING id, ticket_number`,
        [ids.societyId, ids.unit101, ids.owner, title]
      )).rows[0]
  );
  const t1 = await raise('Leak');
  const t2 = await raise('Lift noise');
  assert.deepEqual([t1.ticket_number, t2.ticket_number], ['TKT-0001', 'TKT-0002']);

  await asUser(db, ids.owner, (tx) =>
    tx.query(`INSERT INTO complaint_updates (society_id, complaint_id, author_id, message) VALUES ($1, $2, $3, 'Still leaking')`, [ids.societyId, t1.id, ids.owner])
  );
  await asUser(db, ids.secretary, (tx) =>
    tx.query(`INSERT INTO complaint_updates (society_id, complaint_id, author_id, message) VALUES ($1, $2, $3, 'Plumber visiting tomorrow')`, [ids.societyId, t1.id, ids.secretary])
  );
  // The tenant cannot comment on (or read) someone else's ticket
  await assert.rejects(
    asUser(db, ids.tenant, (tx) =>
      tx.query(`INSERT INTO complaint_updates (society_id, complaint_id, author_id, message) VALUES ($1, $2, $3, 'hi')`, [ids.societyId, t1.id, ids.tenant])
    ),
    /row-level security/
  );
  const tenantSees = await asUser(db, ids.tenant, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM complaint_updates')).rows[0].n);
  assert.equal(tenantSees, 0);
  const ownerSees = await asUser(db, ids.owner, async (tx) => (await tx.query('SELECT message FROM complaint_updates ORDER BY created_at')).rows.map((r) => r.message));
  assert.deepEqual(ownerSees, ['Still leaking', 'Plumber visiting tomorrow']);

  await asUser(db, ids.secretary, (tx) => tx.query(`UPDATE complaints SET status = 'resolved', resolution_notes = 'Pipe replaced' WHERE id = $1`, [t1.id]));
  const resolved = (await db.query('SELECT resolved_at FROM complaints WHERE id = $1', [t1.id])).rows[0];
  assert.ok(resolved.resolved_at, 'resolved_at is set');
  await asUser(db, ids.secretary, (tx) => tx.query(`UPDATE complaints SET status = 'open' WHERE id = $1`, [t1.id]));
  assert.equal((await db.query('SELECT resolved_at FROM complaints WHERE id = $1', [t1.id])).rows[0].resolved_at, null, 'reopening clears it');
});

test('documents: committee uploads into own folder; members read per visibility', async () => {
  const path = (name) => `${ids.societyId}/documents/${name}`;
  await asUser(db, ids.secretary, async (tx) => {
    for (const name of ['bylaws.pdf', 'minutes.pdf']) {
      await tx.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('society-files', $1)`, [path(name)]);
    }
    await tx.query(
      `INSERT INTO documents (society_id, category, title, file_url, uploaded_by, is_restricted_to_committee) VALUES
         ($1, 'bylaws', 'Bye-laws', $2, $4, false),
         ($1, 'agm_minutes', 'Committee minutes', $3, $4, true)`,
      [ids.societyId, path('bylaws.pdf'), path('minutes.pdf'), ids.owner]
    );
  });

  const filesFor = (user) =>
    asUser(db, user, async (tx) => (await tx.query(`SELECT name FROM storage.objects ORDER BY name`)).rows.map((r) => r.name.split('/').pop()));
  assert.deepEqual(await filesFor(ids.owner), ['bylaws.pdf']);
  assert.deepEqual(await filesFor(ids.treasurer), ['bylaws.pdf', 'minutes.pdf']);

  // Residents cannot upload; nobody can upload into another society's folder
  await assert.rejects(
    asUser(db, ids.owner, (tx) => tx.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('society-files', $1)`, [path('evil.pdf')])),
    /row-level security/
  );
  const other = await createUser(db, 'other-admin@ops.test');
  const otherSociety = await asUser(db, other, async (tx) =>
    (await tx.query(`SELECT public.create_society('Other CHS', 'Road', 'Pune', 'Maharashtra', '411001', 'other-admin@ops.test', '9876543210') AS id`)).rows[0].id
  );
  await assert.rejects(
    asUser(db, other, (tx) => tx.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('society-files', $1)`, [path('x.pdf')])),
    /row-level security/
  );
  assert.deepEqual(await filesFor(other), []);
  // A document row cannot point outside its own society folder
  await assert.rejects(
    asUser(db, other, (tx) =>
      tx.query(`INSERT INTO documents (society_id, title, file_url, uploaded_by) VALUES ($1, 'steal', $2, $3)`, [otherSociety, path('bylaws.pdf'), other])
    ),
    /chk_documents_path_in_society/
  );
  // uploaded_by is stamped with the real uploader
  const uploaders = (await db.query('SELECT DISTINCT uploaded_by FROM documents WHERE society_id = $1', [ids.societyId])).rows;
  assert.deepEqual(uploaders, [{ uploaded_by: ids.secretary }]);
});

const createExpense = (user, extra = {}) =>
  asUser(db, user, async (tx) =>
    (await tx.query(
      `INSERT INTO expenses (society_id, category, title, subtotal, gst_amount, tds_amount, net_payable, status, approved_by)
       VALUES ($1, 'security', $2, $3, $4, $5, 1, $6, $7) RETURNING id, expense_number, net_payable, status, created_by, approved_by`,
      [ids.societyId, extra.title ?? 'Guards', extra.subtotal ?? 10000, extra.gst ?? 1800, extra.tds ?? 200, extra.status ?? 'approved', extra.approvedBy ?? user]
    )).rows[0]
  );

const decide = (user, id, approve, notes = null) =>
  asUser(db, user, async (tx) => (await tx.query('SELECT public.decide_expense($1, $2, $3) AS r', [id, approve, notes])).rows[0].r);

test('expenses: numbering, computed net and forced pending status on create', async () => {
  const e = await createExpense(ids.treasurer);
  assert.equal(e.expense_number, 'EXP-0001');
  assert.equal(Number(e.net_payable), 11600, 'net = subtotal + GST - TDS (client value ignored)');
  assert.equal(e.status, 'pending_approval', 'client cannot create an already-approved expense');
  assert.equal(e.approved_by, null);
  assert.equal(e.created_by, ids.treasurer);
  await assert.rejects(createExpense(ids.owner), /row-level security/);
});

test('expenses: maker cannot approve; two-step needs two other committee members', async () => {
  const e = (await db.query(`SELECT id FROM expenses WHERE expense_number = 'EXP-0001'`)).rows[0];
  await assert.rejects(decide(ids.treasurer, e.id, true), /another committee member must approve/);

  const first = await decide(ids.secretary, e.id, true);
  assert.deepEqual(first, { status: 'pending_approval', approvals: 1, required: 2 });
  await assert.rejects(decide(ids.secretary, e.id, true), /already recorded/);

  // Direct status edits are blocked
  await assert.rejects(
    asUser(db, ids.secretary, (tx) => tx.query(`UPDATE expenses SET status = 'approved' WHERE id = $1`, [e.id])),
    /approval workflow/
  );

  const second = await decide(ids.chairman, e.id, true);
  assert.deepEqual(second, { status: 'approved', approvals: 2, required: 2 });

  await assert.rejects(
    asUser(db, ids.treasurer, (tx) => tx.query(`UPDATE expenses SET subtotal = 99999 WHERE id = $1`, [e.id])),
    /Approved expenses cannot be edited/
  );
});

test('expenses: paying an approved expense posts to the ledger and locks it', async () => {
  const e = (await db.query(`SELECT id FROM expenses WHERE expense_number = 'EXP-0001'`)).rows[0];
  await assert.rejects(
    asUser(db, ids.owner, (tx) => tx.query('SELECT public.mark_expense_paid($1)', [e.id])),
    /Only the society committee/
  );
  const r = await asUser(db, ids.treasurer, async (tx) => (await tx.query(`SELECT public.mark_expense_paid($1, '2026-10-15', 'NEFT123') AS r`, [e.id])).rows[0].r);
  assert.equal(r.status, 'paid');

  // Accrual on approval (013): Dr expense / Cr creditors; the payment then clears creditors
  const lines = async (where, id) => (await db.query(
    `SELECT a.code, l.amount FROM ledger_entries l JOIN accounts a ON a.id = l.account_id
     JOIN journal_entries j ON j.id = l.journal_entry_id WHERE ${where} ORDER BY a.code`,
    [id]
  )).rows.map((x) => [x.code, Number(x.amount)]);
  assert.deepEqual(await lines('j.reference_event_id = $1', e.id), [['2000', -11800], ['5100', 11800]]);
  assert.deepEqual(
    await lines(`j.reference_event_id IN (SELECT id FROM vendor_payments WHERE expense_id = $1)`, e.id),
    [['1000', -11600], ['2000', 11800], ['2200', -200]]
  );

  await assert.rejects(
    asUser(db, ids.treasurer, (tx) => tx.query(`UPDATE expenses SET title = 'changed' WHERE id = $1`, [e.id])),
    /Paid expenses are locked/
  );
});

test('expenses: rejection needs a reason; single-step societies need one approver', async () => {
  const e2 = await createExpense(ids.treasurer, { title: 'Paint' });
  await assert.rejects(decide(ids.secretary, e2.id, false), /reason is required/);
  assert.equal((await decide(ids.secretary, e2.id, false, 'Quote too high')).status, 'rejected');

  await asUser(db, ids.secretary, (tx) => tx.query('UPDATE society_settings SET require_two_step_expense_approval = false WHERE society_id = $1', [ids.societyId]));
  const e3 = await createExpense(ids.treasurer, { title: 'Bulbs' });
  assert.equal((await decide(ids.chairman, e3.id, true)).status, 'approved');
});
