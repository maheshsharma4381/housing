// Shared steps for tests that need a CA or an approved opening balance (026).
import { createUser, asUser } from './harness.mjs';

/** The committee member `inviter` invites `email` as a CA with `permissions`; returns the CA's user id. */
export async function inviteProfessional(db, { societyId, inviter, email, permissions = ['view_reports', 'manage_accounts'] }) {
  const user = await createUser(db, email);
  const inv = (await asUser(db, inviter, (tx) => tx.query(
    `INSERT INTO professional_invites (society_id, invited_email, role, permissions, invited_by, expires_at)
     VALUES ($1,$2,'ca',$3,$4, now() + interval '7 days') RETURNING id`,
    [societyId, email, JSON.stringify(permissions), inviter]))).rows[0].id;
  await asUser(db, user, (tx) => tx.query(`SELECT public.respond_to_invite('professional',$1,true)`, [inv]));
  return user;
}

const call = async (db, user, sql, params) =>
  Object.values((await asUser(db, user, (tx) => tx.query(sql, params))).rows[0])[0];

/** The CA saves and submits an opening balance; `approver` (a committee member) approves it. Returns opening_balance(). */
export async function approveOpening(db, {
  societyId, ca, approver, auditedAsOf = '2026-03-31', liveOn, audited = [], catchup = [], flats = [], vendors = [],
}) {
  await call(db, ca, 'SELECT public.save_opening_balance($1,$2,$3,$4,$5,$6,$7)', [societyId, auditedAsOf, liveOn ?? auditedAsOf,
    JSON.stringify(audited), JSON.stringify(catchup), JSON.stringify(flats), JSON.stringify(vendors)]);
  await call(db, ca, 'SELECT public.submit_opening_balance($1)', [societyId]);
  await call(db, approver, 'SELECT public.decide_opening_balance($1,true)', [societyId]);
  return call(db, approver, 'SELECT public.opening_balance($1)', [societyId]);
}
