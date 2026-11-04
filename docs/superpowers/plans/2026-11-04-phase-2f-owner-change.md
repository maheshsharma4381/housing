# Phase 2F: Owner Change and Ownership History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The secretary records an owner change for a flat (new owner's name, mobile, email, transfer date). The old owner loses access, the new owner is invited, the flat keeps its ledger and any dues, and every owner's period has its own statement.

**Architecture:**
- A new table `unit_ownerships` holds who owned each flat from when to when. Migration `029` backfills it from today's owners.
- `transfer_flat_owner` closes the current period and deactivates the old owner's membership. It invites the new owner and opens a new period that waits for them.
- When the new owner accepts the invite, `accept_member_invite_row` links them to the period and moves the flat's unpaid bills to them.
- Statements per owner reuse `party_statement` over the period's dates.

**Tech Stack:** Next.js 15, React 19, Tailwind v4, Supabase Postgres (plpgsql, RLS), PGlite tests (`node --test`), Bun scripts.

**Spec:** `docs/superpowers/specs/2026-10-31-sahvaas-simplify-design.md`:
- 7.6: owner change;
- 10.2: "After an owner change, the new owner's statement starts at the transfer date with 'Brought forward from previous owner'";
- 12, call 7: "The old owner loses access at transfer; the secretary can still download their period's statement".

## Decisions (taken on the product owner's behalf — "u decide")

1. **The new owner needs an email for now.** Login is email-based until Phase 3 brings mobile + WhatsApp OTP. The mobile number is stored on the ownership period.
2. **Unpaid bills follow the flat.** The flat's unpaid bills move to the new owner the moment they join (spec: "the dues stay with the flat and the new owner pays them"). Paid bills and receipts stay in the old owner's period.
3. **Until the new owner joins, bills are still raised** in the old owner's name. They stay hidden from the old owner, who has lost the flat, and move to the new owner on joining. `units.current_owner_id` is left as it is until then, so no month is skipped. Phase 4 makes bills belong to flats.
4. **An advance on the flat stays with the flat** and is used on its next bills, like dues. The secretary sees it in the warning before confirming.
5. **The transfer date must fall after the current owner's start date** and not in the future. A second change while one new owner has not joined yet is refused.
6. **Tenants are not touched** by an owner change.

## Global Constraints

- **Migrations:**
  - New SQL goes only in `src/db/migrations/029_owner_change.sql`; never edit 001–028.
  - After every SQL change, run `bun run db:bundle`.
  - Never run `bun run db:migrate --apply`; the product owner does.
- **Redefined functions** are verbatim copies plus the change, with a comment naming the source file. `accept_member_invite_row` is latest in 012. Build them with a script that extracts the body.
- **RPC security:**
  - Every RPC is `SECURITY DEFINER SET search_path = public`.
  - Callable RPCs: `REVOKE ALL … FROM PUBLIC, anon; GRANT EXECUTE … TO authenticated`.
  - Internal helpers: also revoked from `authenticated`.
- **DB tests** run one file at a time: `TZ=UTC node --test tests/db/<file>`. The full suite is every file in `tests/unit` and `tests/db`, one at a time.
- **App UI** is English only.
- **Commits:** `git -c user.name=ved300406 -c user.email=ved300406@gmail.com commit …`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Review Focus

1. **A bill raised between transfer and joining** is not lost. It moves to the new owner when they join (Task 2 test).
2. **The old owner's payment made before the transfer** but verified after it still settles the flat's dues (Task 2 test).
3. **A tenant on the flat keeps access** through an owner change (Task 2 test).
4. **Bad dates and double changes:** a same-day-as-start or future transfer date, and a second change while one is waiting, are refused clearly (Task 2 test).
5. **The old owner can no longer act on the flat:** a new payment from them for the flat is refused (Task 2 test).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/migrations/029_owner_change.sql` (new) | `unit_ownerships`, backfill, `flat_balance`, `flat_owner_periods`, `transfer_flat_owner`, invite acceptance hook |
| `tests/db/owner-change.test.mjs` (new) | Tasks 1–2 |
| `src/components/OwnerChange.tsx` (new) | The owner-change form with the dues / advance warning |
| `src/components/OwnerHistory.tsx` (new) | Owners of a flat, each with a printable statement |
| `src/views/society/tabs/UnitsTab.tsx`, `src/views/society/SocietyDashboardPage.tsx` | "Owner change" and "Owners" per flat |

---

### Task 1: Ownership history

**Files:** Create `029_owner_change.sql` and `tests/db/owner-change.test.mjs`; regenerate the bundle.

**Interfaces:**
- Produces:
  - `unit_ownerships` table, with RLS on and a SELECT policy of `can_view_financials(society_id)`:
    - `id UUID PK`;
    - `society_id UUID NOT NULL → societies ON DELETE CASCADE`;
    - `unit_id UUID NOT NULL → units ON DELETE CASCADE`;
    - `owner_user_id UUID NULL → profiles`;
    - `owner_name TEXT NOT NULL`, `owner_email TEXT`, `owner_mobile TEXT`;
    - `from_date DATE NOT NULL`, `to_date DATE NULL`, with `CHECK (to_date IS NULL OR to_date >= from_date)`;
    - `invite_id UUID NULL → member_invites`;
    - `created_by UUID`, `created_at TIMESTAMPTZ`;
    - a unique partial index on `unit_id` where `to_date IS NULL`, so a flat has at most one open period.
  - **Backfill:** one open period per flat that has an owner today. The owner is the earliest active `resident_owner` membership, else `units.current_owner_id`. The name is `coalesce(full_name, email)` from `profiles`, the email is the profile's, and `from_date` is `coalesce(joined_date, created_at::date)`.
  - **`accept_member_invite_row`**, redefined from 012. After the existing work, for a `resident_owner` invite on a unit:
    - if a period has this `invite_id` and no owner yet, set `owner_user_id`, and move the flat's unpaid bills (`balance_due > 0`, status in issued / partially_paid / overdue) to the new owner: `bills.user_id`;
    - otherwise, if the flat has no open period, insert one from `current_date`.
  - **`flat_owner_periods(p_unit_id UUID) RETURNS JSONB`:** `[{ id, owner_name, owner_email, owner_mobile, from_date, to_date, joined }]`, oldest first. `joined` = `owner_user_id IS NOT NULL`. Access: `can_view_financials` of the unit's society, else `'You do not have access to this society''s accounts'`.

- [ ] **Step 1: Write the failing tests.** Setup:
  - a society with flats 101 and 102, a secretary, a treasurer and a read-only `committee_member` (`cm`);
  - `r1` joins as owner of 101 through `member_invites` and `claim_my_invites`;
  - a tenant `t1` joins as `resident_tenant` of 101.

  Task 2 adds the October bill for 101 (`generate_bills`) and a pending payment by `r1` (`ids.oldPay`, before the transfer) to this setup. Then:

  ```js
  test('the first owner who joins starts the flat's ownership history', async () => {
    const periods = await val(ids.secretary, 'SELECT public.flat_owner_periods($1)', [ids.u101]);
    assert.deepEqual(periods.map((p) => [p.owner_email, p.to_date, p.joined]), [['r1@owners.test', null, true]]);
    assert.deepEqual(await val(ids.secretary, 'SELECT public.flat_owner_periods($1)', [ids.u102]), []);
    await assert.rejects(q(ids.t1, 'SELECT public.flat_owner_periods($1)', [ids.u101]), /do not have access/);
  });
  ```
  Also add `tests/db/owner-change.test.mjs` coverage of the backfill: create a DB with `createDb({ upTo: '028' })`, join an owner, `applyMigration(db, '029_owner_change.sql')`, and expect one open period for that flat.
- [ ] **Step 2: Run** `TZ=UTC node --test tests/db/owner-change.test.mjs` → expected FAIL, because `flat_owner_periods` does not exist.
- [ ] **Step 3: Implement** the table, the policy, the backfill, `accept_member_invite_row` and `flat_owner_periods`; then `bun run db:bundle`.
- [ ] **Step 4: Run** the file, then `onboarding`, `rls`, `professional` and `launch` one at a time → all pass.
- [ ] **Step 5: Commit:** `feat(flats): every flat keeps its ownership history`.

---

### Task 2: The secretary records an owner change

**Files:** Modify `029_owner_change.sql` and `tests/db/owner-change.test.mjs`.

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - **`flat_balance(p_unit_id UUID) RETURNS JSONB`** → `{ dues, advance }`.
    - `dues` = the sum of `balance_due` of the flat's unpaid bills.
    - `advance` = the unallocated amount of its verified payments plus `opening_advances.remaining`.
    - Access: `can_view_financials`.
  - **`transfer_flat_owner(p_unit_id UUID, p_new_owner_name TEXT, p_new_owner_email TEXT, p_new_owner_mobile TEXT, p_transfer_date DATE) RETURNS JSONB`** → `{ ownership_id, invite_id, dues, advance }`. Guards, in order:
    1. `'Only the society committee can record an owner change'` (not `is_platform_admin()` / `is_society_admin`)
    2. `'Flat not found'`
    3. `'Enter the new owner''s name'` (under 2 characters)
    4. `'Enter the new owner''s email — they join with it'` (no `@`)
    5. `'The transfer date cannot be in the future'`
    6. `'The transfer date must be after % (when the current owner''s period began)'`, with the date formatted `DD Mon YYYY`
    7. `'This flat already has a new owner waiting to join'` (an open period with no `owner_user_id`)

    **Effects**, in this order:
    - close the open period (`to_date = p_transfer_date - 1`);
    - set `is_active = false` on every active `resident_owner` membership of the flat;
    - revoke pending `resident_owner` invites for the flat;
    - insert a `member_invites` row (email, full name, `resident_owner`, the unit, `invited_by = auth.uid()`);
    - insert the new open period (name, email, mobile, `from_date = p_transfer_date`, `invite_id`);
    - write audit `unit.owner_changed`, including the dues and advance.

- [ ] **Step 1: Write the failing tests** (append). Before these tests, `generate_bills` gives flat 101 an unpaid bill.

  ```js
  test('the secretary records an owner change; the old owner loses the flat; the new owner is invited', async () => {
    const before = await val(ids.secretary, 'SELECT public.flat_balance($1)', [ids.u101]);
    assert.ok(Number(before.dues) > 0);
    await assert.rejects(q(ids.cm, `SELECT public.transfer_flat_owner($1,'Neha Shah','neha@owners.test','9876500000',current_date)`, [ids.u101]),
      /Only the society committee can record an owner change/);
    await assert.rejects(q(ids.secretary, `SELECT public.transfer_flat_owner($1,'Neha Shah','neha@owners.test','9876500000',current_date + 1)`, [ids.u101]),
      /cannot be in the future/);
    const r = await val(ids.secretary, `SELECT public.transfer_flat_owner($1,'Neha Shah','neha@owners.test','9876500000',current_date)`, [ids.u101]);
    assert.equal(Number(r.dues), Number(before.dues));
    const m = (await db.query(`SELECT is_active FROM society_memberships WHERE user_id=$1 AND unit_id=$2`, [ids.r1, ids.u101])).rows[0];
    assert.equal(m.is_active, false);
    const tenant = (await db.query(`SELECT is_active FROM society_memberships WHERE user_id=$1 AND unit_id=$2`, [ids.t1, ids.u101])).rows[0];
    assert.equal(tenant.is_active, true, 'the tenant keeps the flat');
    await assert.rejects(q(ids.r1, `INSERT INTO payments (society_id, unit_id, user_id, payment_number, amount, transaction_reference_utr, status)
      VALUES ($1,$2,$3,'P-OLD',100,'111111111111','pending_verification')`, [ids.societyId, ids.u101, ids.r1]), /row-level security/);
    await assert.rejects(q(ids.secretary, `SELECT public.transfer_flat_owner($1,'Someone Else','else@owners.test',NULL,current_date)`, [ids.u101]),
      /already has a new owner waiting to join/);
    const periods = await val(ids.secretary, 'SELECT public.flat_owner_periods($1)', [ids.u101]);
    assert.deepEqual(periods.map((p) => [p.owner_name, p.joined]), [[periods[0].owner_name, true], ['Neha Shah', false]]);
  });

  test('bills raised before the new owner joins, and the old dues, move to the new owner', async () => {
    // a bill raised for the next month while Neha has not joined yet
    await q(ids.secretary, `SELECT public.generate_bills($1,'2026-12-01','2026-12-31','2026-12-10')`, [ids.societyId]);
    const neha = await createUser(db, 'neha@owners.test');
    await asUser(db, neha, (tx) => tx.query('SELECT public.claim_my_invites()'));
    const open = (await db.query(`SELECT user_id FROM bills WHERE unit_id=$1 AND balance_due > 0`, [ids.u101])).rows;
    assert.ok(open.length >= 2);
    assert.ok(open.every((b) => b.user_id === neha));
    const seen = await asUser(db, neha, async (tx) => (await tx.query('SELECT count(*)::int n FROM bills WHERE balance_due > 0')).rows[0].n);
    assert.equal(seen, open.length);
    const periods = await val(ids.secretary, 'SELECT public.flat_owner_periods($1)', [ids.u101]);
    assert.equal(periods[1].joined, true);
  });

  test("the new owner's statement starts with what the flat brought forward", async () => {
    const periods = await val(ids.secretary, 'SELECT public.flat_owner_periods($1)', [ids.u101]);
    const st = await val(ids.secretary, `SELECT public.party_statement($1,'flat',$2,$3,current_date)`, [ids.societyId, ids.u101, periods[1].from_date]);
    assert.ok(Number(st.opening) > 0, 'the previous owner left dues on the flat');
  });

  test("the old owner's payment, verified after the transfer, still settles the flat's dues", async () => {
    // a pending payment the old owner submitted before the transfer (insert it before the owner-change test runs; keep its id in ids.oldPay)
    await q(ids.treasurer, 'SELECT public.verify_payment($1, true)', [ids.oldPay]);
    const after = await val(ids.secretary, 'SELECT public.flat_balance($1)', [ids.u101]);
    assert.ok(Number(after.dues) < Number(ids.duesAtTransfer));
  });
  ```
  The `transfer_date must be after` refusal is tested on flat 102 after giving it an owner who joined today: transferring on `current_date` → `/must be after/`.
- [ ] **Step 2: Run** → expected FAIL, because `flat_balance` does not exist.
- [ ] **Step 3: Implement** `flat_balance` and `transfer_flat_owner`; then `bun run db:bundle`.
- [ ] **Step 4: Run** `owner-change`, `billing`, `launch` and `party-ledgers` one at a time → all pass.
- [ ] **Step 5: Commit:** `feat(flats): the secretary records an owner change; dues stay with the flat`.

---

### Task 3: Owner change and owners' statements on screen

**Files:**
- Create: `src/components/OwnerChange.tsx`, `src/components/OwnerHistory.tsx`
- Modify: `src/views/society/tabs/UnitsTab.tsx`, `src/views/society/SocietyDashboardPage.tsx`

**Interfaces:**
- Consumes: `flat_balance`, `transfer_flat_owner`, `flat_owner_periods`, `party_statement(p_society_id, 'flat', unit_id, p_from, p_to)` (025).
- Produces:
  - **`OwnerChange`** `{ societyId: string; unitId: string; unitLabel: string; onDone: () => void }`.
    - It loads `flat_balance` and shows a warning when dues are above 0: "{unitLabel} has ₹X due. Usually the old owner clears dues before selling; if not, the dues stay with the flat and the new owner pays them."
    - It shows a note when an advance is above 0: "{unitLabel} has ₹Y paid in advance; it stays with the flat."
    - Fields: "New owner's name", "Mobile", "Email (they join with it)", "Transfer date" (max today).
    - Button "Record owner change". Success notice: "Owner change recorded. {name} gets an invite at {email}." Errors go in a `Banner`.
  - **`OwnerHistory`** `{ societyId: string; unitId: string }`.
    - It lists periods as "{name} · {from} – {to or 'now'}{joined ? '' : ' · invited'}".
    - Each period has "Statement", which loads `party_statement` for `from_date`…`to_date ?? today`.
    - The statement table is Date · Entry · Narration · Debit · Credit · Balance. Its first row is labelled "Brought forward from previous owner" for every period but the first, and "Opening balance" for the first.
    - A "Print" button (`window.print()`) lets the secretary save the statement as a PDF.
  - **`UnitsTab`** gains the prop `canManage: boolean`. Each flat row gets:
    - "Owners", which toggles `OwnerHistory` under the row, for every committee member;
    - "Owner change", which toggles `OwnerChange`, only when `canManage`.

    The dashboard passes `canManage={!readOnly}`.

- [ ] **Step 1:** Make the changes above.
- [ ] **Step 2: Verify:**
  - `bun run typecheck` and `bun run lint` show no errors in the touched files;
  - run the full suite one file at a time; there must be no FAIL lines;
  - `bunx next build` compiles.
- [ ] **Step 3: Commit:** `feat(flats): owner change and each owner's statement on the Flats screen`.
