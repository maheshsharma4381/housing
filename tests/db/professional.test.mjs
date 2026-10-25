// CA / auditor portal: invite → claim → scoped access → expiry/revocation, remarks, GSTR-2B matching (009).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, createUser, asUser } from './harness.mjs';

let db;
let ids;
const GSTIN_A = '27AAPFU0939F1ZV';
const GSTIN_B = '29ABCDE1234F1Z5';

before(async () => {
  db = await createDb();
  const secretary = await createUser(db, 'secretary@pro.test');
  const societyId = await asUser(db, secretary, async (tx) => {
    const id = (await tx.query(
      `SELECT public.create_society('Pro Towers', 'Road 5', 'Mumbai', 'Maharashtra', '400001', 'secretary@pro.test', '9876543210') AS id`
    )).rows[0].id;
    await tx.query('SELECT public.bulk_upsert_units($1, $2)', [id, JSON.stringify([{ unit_number: '1' }])]);
    await tx.query(
      `INSERT INTO member_invites (society_id, email, role, unit_id, invited_by)
       SELECT $1, 'resident@pro.test', 'resident_owner', id, $2 FROM units WHERE society_id = $1`,
      [id, secretary]
    );
    return id;
  });
  const resident = await createUser(db, 'resident@pro.test');
  await asUser(db, resident, (tx) => tx.query('SELECT public.claim_my_invites()'));

  // Books: vendors with GSTIN and approved expenses (fixtures inserted as superuser)
  const vA = (await db.query(`INSERT INTO vendors (society_id, name, phone, gstin) VALUES ($1, 'Guard Co', '9000000001', $2) RETURNING id`, [societyId, GSTIN_A])).rows[0].id;
  const vB = (await db.query(`INSERT INTO vendors (society_id, name, phone, gstin) VALUES ($1, 'Lift Co', '9000000002', $2) RETURNING id`, [societyId, GSTIN_B])).rows[0].id;
  const exp = async (vendor, inv, date, subtotal, gst) =>
    db.query(
      `INSERT INTO expenses (society_id, vendor_id, category, title, invoice_number, invoice_date, subtotal, gst_amount, tds_amount, status)
       VALUES ($1, $2, 'security', $3, $4, $5, $6, $7, 0, 'approved')`,
      [societyId, vendor, `Bill ${inv}`, inv, date, subtotal, gst]
    );
  await exp(vA, 'SG/2026/0045', '2026-10-05', 10000, 1800); // exact match (normalised number)
  await exp(vB, 'LIFT-77', '2026-10-12', 5000, 900);        // amount differs in 2B -> partial
  await exp(vB, 'LIFT-78', '2026-10-20', 2000, 360);        // not in 2B -> missing_in_2b
  await exp(vA, 'SG/2026/0050', '2026-11-02', 1000, 180);   // other month -> ignored

  ids = { societyId, secretary, resident };
});

const inviteCa = (user, email, permissions, accessUntil = null) =>
  asUser(db, user, (tx) =>
    tx.query(
      `INSERT INTO professional_invites (society_id, invited_email, role, permissions, invited_by, expires_at, access_until)
       VALUES ($1, $2, 'ca', $3, $4, now() + interval '7 days', $5)`,
      [ids.societyId, email, JSON.stringify(permissions), user, accessUntil]
    )
  );

test('only the committee can invite, and only catalogued permissions are allowed', async () => {
  await assert.rejects(inviteCa(ids.resident, 'x@pro.test', ['view_reports']), /row-level security/);
  await assert.rejects(inviteCa(ids.secretary, 'x@pro.test', ['delete_everything']), /chk_invite_permissions/);
  await inviteCa(ids.secretary, 'CA.Firm@Pro.Test', ['view_reports', 'view_ledger', 'audit_gst', 'view_expenses'], '2027-03-31T23:59:59Z');
});

test('CA claims the invite only after verifying email; access is scoped to granted permissions', async () => {
  const unverified = await createUser(db, 'ca.firm@pro.test', { confirmed: false });
  assert.equal(await asUser(db, unverified, async (tx) => (await tx.query('SELECT public.claim_professional_invites() AS n')).rows[0].n), 0);
  await db.query('UPDATE auth.users SET email_confirmed_at = now() WHERE id = $1', [unverified]);
  ids.ca = unverified;

  assert.equal(await asUser(db, ids.ca, async (tx) => (await tx.query('SELECT public.claim_professional_invites() AS n')).rows[0].n), 1);
  const grant = (await db.query('SELECT status, permissions, expires_at, granted_by FROM society_professional_access WHERE professional_user_id = $1', [ids.ca])).rows[0];
  assert.equal(grant.status, 'active');
  assert.deepEqual(grant.permissions, ['view_reports', 'view_ledger', 'audit_gst', 'view_expenses']);
  assert.equal(grant.granted_by, ids.secretary);
  assert.ok(grant.expires_at);

  await asUser(db, ids.ca, async (tx) => {
    await tx.query('SELECT * FROM public.trial_balance($1)', [ids.societyId]);
    const exp = await tx.query('SELECT count(*)::int AS n FROM expenses');
    assert.equal(exp.rows[0].n, 4, 'view_expenses grants expense access');
    const bills = await tx.query('SELECT count(*)::int AS n FROM bills');
    assert.equal(bills.rows[0].n, 0, 'no view_bills, no bills');
    const profiles = await tx.query('SELECT email FROM profiles ORDER BY email');
    assert.deepEqual(profiles.rows.map((r) => r.email), ['ca.firm@pro.test', 'secretary@pro.test'], 'sees own + committee profiles, not residents');
    await tx.query(`INSERT INTO access_logs (society_id, professional_user_id, module_accessed, action_performed) VALUES ($1, $2, 'gst', 'view')`, [ids.societyId, ids.ca]);
  });

  // The committee can see who the CA is
  const seen = await asUser(db, ids.secretary, async (tx) => (await tx.query('SELECT email FROM profiles WHERE id = $1', [ids.ca])).rows);
  assert.equal(seen.length, 1);
});

test('expired or revoked access stops working immediately', async () => {
  await asUser(db, ids.secretary, (tx) =>
    tx.query(`UPDATE society_professional_access SET expires_at = now() - interval '1 minute' WHERE professional_user_id = $1`, [ids.ca])
  );
  await assert.rejects(asUser(db, ids.ca, (tx) => tx.query('SELECT * FROM public.trial_balance($1)', [ids.societyId])), /do not have access/);

  await asUser(db, ids.secretary, (tx) =>
    tx.query(`UPDATE society_professional_access SET expires_at = NULL, status = 'revoked', revocation_reason = 'Audit done' WHERE professional_user_id = $1`, [ids.ca])
  );
  const g = (await db.query('SELECT status, revoked_at FROM society_professional_access WHERE professional_user_id = $1', [ids.ca])).rows[0];
  assert.equal(g.status, 'revoked');
  assert.ok(g.revoked_at);
  const n = await asUser(db, ids.ca, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM expenses')).rows[0].n);
  assert.equal(n, 0);

  // Re-activate for the remaining tests
  await asUser(db, ids.secretary, (tx) => tx.query(`UPDATE society_professional_access SET status = 'active' WHERE professional_user_id = $1`, [ids.ca]));
  assert.equal((await db.query('SELECT revoked_at FROM society_professional_access WHERE professional_user_id = $1', [ids.ca])).rows[0].revoked_at, null);
});

test('audit remarks: CA writes, committee responds, roles cannot cross', async () => {
  const remarkId = await asUser(db, ids.ca, async (tx) =>
    (await tx.query(
      `INSERT INTO audit_remarks (society_id, author_id, module, reference, remark, severity)
       VALUES ($1, $2, 'expenses', 'EXP-0002', 'Lift AMC invoice lacks a signed work order', 'major') RETURNING id`,
      [ids.societyId, ids.ca]
    )).rows[0].id
  );
  await assert.rejects(
    asUser(db, ids.resident, (tx) =>
      tx.query(`INSERT INTO audit_remarks (society_id, author_id, remark) VALUES ($1, $2, 'hello there')`, [ids.societyId, ids.resident])
    ),
    /row-level security/
  );
  await assert.rejects(
    asUser(db, ids.ca, (tx) => tx.query(`UPDATE audit_remarks SET response = 'self-answer' WHERE id = $1`, [remarkId])),
    /Only the society committee can respond/
  );
  await assert.rejects(
    asUser(db, ids.secretary, (tx) => tx.query(`UPDATE audit_remarks SET remark = 'edited' WHERE id = $1`, [remarkId])),
    /Only the professional who wrote/
  );
  await asUser(db, ids.secretary, (tx) => tx.query(`UPDATE audit_remarks SET response = 'Work order attached in Documents' WHERE id = $1`, [remarkId]));
  let r = (await db.query('SELECT status, responded_by FROM audit_remarks WHERE id = $1', [remarkId])).rows[0];
  assert.deepEqual(r, { status: 'responded', responded_by: ids.secretary });

  await asUser(db, ids.ca, (tx) => tx.query(`UPDATE audit_remarks SET status = 'closed' WHERE id = $1`, [remarkId]));
  r = (await db.query('SELECT status FROM audit_remarks WHERE id = $1', [remarkId])).rows[0];
  assert.equal(r.status, 'closed');

  const residentSees = await asUser(db, ids.resident, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM audit_remarks')).rows[0].n);
  assert.equal(residentSees, 0);
});

const portalInvoices = [
  { supplier_gstin: GSTIN_A, supplier_name: 'GUARD CO', invoice_number: 'SG-2026-45', invoice_date: '2026-10-05', taxable_value: 10000, cgst: 900, sgst: 900 },
  { supplier_gstin: GSTIN_B, supplier_name: 'LIFT CO', invoice_number: 'lift-77', invoice_date: '2026-10-12', taxable_value: 5500, igst: 990 },
  { supplier_gstin: GSTIN_A, supplier_name: 'GUARD CO', invoice_number: 'SG-2026-99', invoice_date: '2026-10-28', taxable_value: 3000, cgst: 270, sgst: 270 },
];

const importAs = (user, invoices = portalInvoices, period = '102026') =>
  asUser(db, user, async (tx) =>
    (await tx.query(`SELECT public.import_gstr2b($1, $2, 'gstr2b.json', 'json', $3) AS r`, [ids.societyId, period, JSON.stringify(invoices)])).rows[0].r
  );

test('GSTR-2B import matches portal invoices against books', async () => {
  // Invoice numbers match ignoring case and separators: "sg 2026 0045" == "SG/2026/0045"
  portalInvoices[0].invoice_number = 'sg 2026 0045';
  const r = await importAs(ids.ca);
  assert.equal(r.invoices, 3);
  assert.equal(r.exact_match, 1);
  assert.equal(r.partial_match, 1);
  assert.equal(r.missing_in_books, 1);
  assert.equal(r.missing_in_2b, 1);
  assert.equal(Number(r.itc_at_risk), 360);
  assert.equal(Number(r.total_taxable), 18500);

  const detail = await asUser(db, ids.ca, async (tx) => (await tx.query('SELECT side, status, invoice_number, expense_number FROM public.gst_reconciliation_detail($1)', [r.upload_id])).rows);
  assert.deepEqual(detail.map((d) => [d.side, d.status, d.invoice_number, d.expense_number]), [
    ['portal', 'exact_match', 'sg 2026 0045', 'EXP-0001'],
    ['books', 'missing_in_2b', 'LIFT-78', 'EXP-0003'],
    ['portal', 'missing_in_books', 'SG-2026-99', null],
    ['portal', 'partial_match', 'lift-77', 'EXP-0002'],
  ]);
});

test('re-uploading a period replaces it; validation and permissions are enforced', async () => {
  const r = await importAs(ids.ca, portalInvoices.slice(0, 1));
  assert.equal(r.invoices, 1);
  const uploads = (await db.query(`SELECT count(*)::int AS n FROM gst_2b_uploads WHERE society_id = $1`, [ids.societyId])).rows[0].n;
  assert.equal(uploads, 1);
  const recon = (await db.query(`SELECT count(*)::int AS n FROM gst_reconciliations WHERE society_id = $1`, [ids.societyId])).rows[0].n;
  assert.equal(recon, 1, 'old reconciliation summary removed with its upload');

  await assert.rejects(importAs(ids.ca, [{ ...portalInvoices[0], supplier_gstin: 'BADGSTIN' }]), /GSTIN "BADGSTIN" is invalid/);
  await assert.rejects(importAs(ids.ca, portalInvoices, '132026'), /Return period must be MMYYYY/);
  await assert.rejects(importAs(ids.resident), /GST audit permission/);
});
