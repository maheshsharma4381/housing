# Phase 2D: The CA Workspace — Accountant Role, Screens Move to the CA Login, Year Lock by Approval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- A society without a CA can make one committee member its Accountant.
- The CA or the Accountant keeps the asset register and the bank match directly.
- Locking a year needs a committee approval.
- Fixed Assets, Bank Reconciliation and Audit & Year Close leave the secretary's menu.

**Architecture:**
- One migration, `027_ca_workspace.sql`, built up across Tasks 1–3.
- `society_memberships.is_accountant` widens `can_manage_accounts`, so every 2A–2C RPC that the CA may call also accepts the Accountant.
- The asset and bank-match RPCs and their read policies accept `can_manage_accounts`.
- A year lock becomes an `adjustment_proposals` row of kind `year_lock`. `decide_adjustment` approves it, so it appears in Approvals with no new screen.
- UI:
  - the CA portal gains the moved screens;
  - the secretary's menu shows them only to the Accountant, in an "Accounts" group.

**Tech Stack:** Next.js 15, React 19, Tailwind v4, Supabase Postgres (plpgsql, RLS), PGlite tests (`node --test`), Bun scripts.

**Spec:** `docs/superpowers/specs/2026-10-31-sahvaas-simplify-design.md`:
- 7.5: the screens move; the authority table ("the CA / accountant does directly" vs. "needs a committee approval"); "societies without a CA on Sahvaas";
- 9.3: Removed from the secretary menu.

## Phase 2 split (updated)

| Plan | Scope |
|---|---|
| 2A, 2B, 2C | Done |
| **2D (this plan)** | Accountant role; the CA / Accountant does fixed assets, depreciation and bank match directly; year lock by committee approval; Fixed Assets / Bank Reconciliation / Audit & Year Close move to the CA login and the Accountant's "Accounts" menu |
| 2E | CA-created fixed-asset ledgers with depreciation rates (asset register on any fixed-asset ledger); bank choice for asset sale proceeds; "move to another bank" adjustment (2B review, Important 2) |
| 2F | Owner change and ownership history |

## Decisions (taken on the product owner's behalf — "u decide")

1. **The Accountant role is a switch on a committee membership**, not a new role: the treasurer stays treasurer and also becomes Accountant. Any active committee role may hold it, and a society may have more than one. Secretary, chairman, treasurer and society admin can switch it on or off.
2. **The Accountant has exactly the CA's `manage_accounts` powers**, everywhere `can_manage_accounts` is checked:
   - groups and ledgers;
   - bill types;
   - opening balance;
   - assets and depreciation;
   - bank match;
   - proposing adjustments and year locks.

   Approvals still need a different committee member (spec 7.5).
3. **The committee keeps its database powers** over assets and bank match, so no existing flow breaks. Only the menu moves, as the spec says ("leave the secretary's menu").
4. **The CA's bank match can point to a payment but never verify it** (spec 7.5). Verification (`verify_matched_payments`, `record_bank_receipt`) stays committee-only, and the CA portal hides those buttons.
5. **`lock_financial_year` now proposes**: it creates a `year_lock` proposal that a committee member other than the proposer approves in Approvals. Unlock stays Sahvaas support only.
6. **Bank Reconciliation in the CA portal follows the society's plan** (`society_has_feature(…, 'bank_match')`), as it does for the secretary.

## Global Constraints

- **Migrations:**
  - New SQL goes only in `src/db/migrations/027_ca_workspace.sql`; never edit 001–026.
  - After every SQL change, run `bun run db:bundle`.
  - Never run `bun run db:migrate --apply`; the product owner does.
- **Redefined functions** are verbatim copies of their latest body plus the change, with a comment naming the source file. Latest bodies:
  - `can_manage_accounts`: 019;
  - `can_propose_adjustment`, `lock_financial_year`, `decide_adjustment`: 014;
  - `add_existing_asset`, `update_asset`, `preview_depreciation`, `post_depreciation`: 013;
  - `dispose_asset`: 013 line 1245;
  - `import_bank_statement`, `bank_line_for_update`: 017.
- **Messages:** existing messages stay word for word unless this plan gives new copy.
- **RPC security:** every RPC is `SECURITY DEFINER SET search_path = public`. Callable ones get `REVOKE ALL … FROM PUBLIC, anon; GRANT EXECUTE … TO authenticated`.
- **DB tests** run one file at a time: `TZ=UTC node --test tests/db/<file>`. The full suite is every file in `tests/unit` and `tests/db`, one at a time.
- **App UI** is English only.
- **Commits:** `git -c user.name=ved300406 -c user.email=ved300406@gmail.com commit …`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Review Focus

1. **A former Accountant.** An Accountant whose membership is deactivated, or whose switch is turned off, loses the powers at once (Task 1 test).
2. **Self-approval.** An Accountant cannot approve their own opening balance; a member who proposed a year lock cannot approve it (Tasks 1 and 3 tests).
3. **A read-only Accountant.** A `committee_member` who is Accountant keeps the books but cannot approve anything (Task 1 test).
4. **A CA verifying.** A CA using "record as payment" or "verify matched payments" is refused, and no payment row is left behind (Task 2 test).
5. **An adjustment raised after a lock proposal.** An adjustment proposed for the year after the lock was proposed blocks the approval with the count of pending adjustments (Task 3 test).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/migrations/027_ca_workspace.sql` (new) | Accountant switch, wider `can_manage_accounts`, CA powers for assets and bank match, year lock proposals |
| `tests/db/accountant-role.test.mjs` (new) | Task 1 |
| `tests/db/ca-workspace-moves.test.mjs` (new) | Tasks 2–3 |
| `tests/db/ca-workspace.test.mjs`, `tests/db/opening-balance.test.mjs` | Their year-lock steps move to propose + approve |
| `src/lib/society-nav.ts` (new), `tests/unit/society-nav.test.ts` (new) | The secretary's menu, with the Accounts group only for the Accountant |
| `src/components/BankReconciliation.tsx`, `YearLockPanel.tsx`, `AdjustmentsPanel.tsx` | `canVerify`; the lock is proposed; year-lock proposals displayed |
| `src/views/professional/ProfessionalDashboardPage.tsx` | Bank Reconciliation tab; Fixed Assets managed by the CA; "Audit & Year Close" tab |
| `src/views/society/SocietyDashboardPage.tsx`, `src/views/society/tabs/MembersTab.tsx`, `src/context/AuthContext.tsx`, `src/types/database.ts` | Menu from `society-nav`; Accountant switch; `is_accountant` loaded |

---

### Task 1: The Accountant switch

**Files:**
- Create: `027_ca_workspace.sql`, `tests/db/accountant-role.test.mjs`
- Regenerate: the bundle

**Interfaces:**
- Consumes:
  - `can_manage_accounts(UUID)`, which every 2A–2C manage RPC calls;
  - `decide_opening_balance` (026), which already refuses the submitter.
- Produces:
  - `society_memberships.is_accountant BOOLEAN NOT NULL DEFAULT false`, plus `CHECK (NOT is_accountant OR role IN ('society_admin','secretary','chairman','treasurer','committee_member'))`.
  - `can_manage_accounts(p_society_id UUID)` redefined: platform admin, OR the professional `manage_accounts` permission, OR an active membership in an active society with `is_accountant`.
  - `can_propose_adjustment(p_society_id UUID)` redefined: the 014 body `OR can_manage_accounts(p_society_id)`.
  - `set_accountant(p_society_id UUID, p_user_id UUID, p_on BOOLEAN) RETURNS JSONB` → `{ user_id, is_accountant }`. Guards:
    - `'Only the society committee can choose the accountant'` (not `is_platform_admin()` / `is_society_admin`);
    - `'Only an active committee member can be the society''s accountant'` (no active committee membership for that user).

    It sets the flag on that committee membership and writes audit `member.accountant_on` or `member.accountant_off`.

- [ ] **Step 1: Write the failing tests** (`tests/db/accountant-role.test.mjs`). Setup:
  - a society created by a secretary, with flat 101;
  - a treasurer, a `committee_member` (`cm`) and the flat 101 owner (`resident`), all joined through `member_invites` + `claim_my_invites`;
  - no CA.

  Helpers:
  - `setAcc(by, who, on) => val(by, 'SELECT public.set_accountant($1,$2,$3)', [societyId, who, on])`;
  - `ledger(by) => val(by, "SELECT public.create_ledger($1,(SELECT id FROM account_groups WHERE society_id=$1 AND system_key='expenses'),'Garden')", [societyId])`.

  ```js
  test('the committee makes one of its members the accountant; residents cannot be one', async () => {
    await assert.rejects(setAcc(ids.resident, ids.treasurer, true), /Only the society committee can choose the accountant/);
    await assert.rejects(setAcc(ids.cm, ids.treasurer, true), /Only the society committee can choose the accountant/);
    await assert.rejects(setAcc(ids.secretary, ids.resident, true), /Only an active committee member can be the society's accountant/);
    await assert.rejects(ledger(ids.treasurer), /Only the society's CA or accountant/);
    assert.deepEqual(await setAcc(ids.secretary, ids.treasurer, true), { user_id: ids.treasurer, is_accountant: true });
    const logs = await db.query(`SELECT count(*)::int n FROM audit_logs WHERE society_id=$1 AND action='member.accountant_on'`, [ids.societyId]);
    assert.equal(logs.rows[0].n, 1);
  });

  test('the accountant keeps the books but cannot approve their own opening balance', async () => {
    assert.match(await ledger(ids.treasurer), /^5/);
    await q(ids.treasurer, `SELECT public.save_opening_balance($1,'2026-03-31','2026-03-31',$2,'[]','[]','[]')`, [ids.societyId,
      JSON.stringify([{ code: '1000', amount: 5000 }, { code: '3000', amount: -5000 }])]);
    await q(ids.treasurer, 'SELECT public.submit_opening_balance($1)', [ids.societyId]);
    await assert.rejects(q(ids.treasurer, 'SELECT public.decide_opening_balance($1,true)', [ids.societyId]), /another committee member must approve/);
    assert.equal((await val(ids.secretary, 'SELECT public.decide_opening_balance($1,true)', [ids.societyId])).status, 'approved');
  });

  test('a read-only committee member can be the accountant but approves nothing', async () => {
    await setAcc(ids.secretary, ids.cm, true);
    assert.match(await ledger(ids.cm), /^5/);
    const p = await val(ids.cm, `SELECT public.propose_adjustment($1,current_date,'Reclass garden spend',$2)`, [ids.societyId,
      JSON.stringify([{ code: '5900', amount: 100 }, { code: '5000', amount: -100 }])]);
    await assert.rejects(q(ids.cm, 'SELECT public.decide_adjustment($1,true)', [p.id]), /Only the society committee can approve/);
  });

  test('switching the accountant off, or leaving the committee, takes the books back at once', async () => {
    await setAcc(ids.secretary, ids.cm, false);
    await assert.rejects(ledger(ids.cm), /Only the society's CA or accountant/);
    await db.query(`UPDATE society_memberships SET is_active=false WHERE society_id=$1 AND user_id=$2`, [ids.societyId, ids.treasurer]);
    await assert.rejects(ledger(ids.treasurer), /Only the society's CA or accountant/);
  });
  ```
- [ ] **Step 2: Run** `TZ=UTC node --test tests/db/accountant-role.test.mjs`. Expected: FAIL, because `set_accountant` does not exist.
- [ ] **Step 3: Implement** the column, constraint, the two redefinitions, `set_accountant` and its privileges; then `bun run db:bundle`.
- [ ] **Step 4: Run** the file (4 pass), then `chart-of-accounts`, `bill-types`, `opening-balance` and `professional` one at a time. All pass.
- [ ] **Step 5: Commit**: `feat(accounts): the committee can make a member its Accountant, with the CA's powers`.

---

### Task 2: The CA keeps the asset register and the bank match

**Files:** Modify `027_ca_workspace.sql`. Create `tests/db/ca-workspace-moves.test.mjs`.

**Interfaces:**
- Consumes: `can_manage_accounts` (Task 1).
- Produces:
  - `can_keep_books(p_society_id UUID) RETURNS BOOLEAN` (internal) = `is_platform_admin() OR is_society_admin(p_society_id) OR can_manage_accounts(p_society_id)`.
  - Redefined so their permission check uses `can_keep_books`, with messages unchanged: `add_existing_asset`, `update_asset`, `post_depreciation`, `dispose_asset`, `import_bank_statement`, `bank_line_for_update` (the last one serves link, confirm, ignore, unlink and record).
  - `preview_depreciation`: its read check also accepts `can_manage_accounts`.
  - Policies, recreated with `OR can_manage_accounts(society_id)` added:
    - `bank_accounts_select` and `bank_accounts_admin_write` (both USING and WITH CHECK);
    - the SELECT policies on `bank_statement_imports` and `bank_transactions`.
  - Verification stays committee-only. `verify_matched_payments` is unchanged, and `record_bank_receipt` stays refused for a CA through `verify_payment`'s own committee check. The test proves that no payment row survives.

- [ ] **Step 1: Write the failing tests.**

  Setup: a helper `makeSociety(tag)` builds each society; `before` uses it for the main society, and Task 3 reuses it. Each society has:
  - a secretary, treasurer, flat 101 owner and resident;
  - a CA invited with the `ROLE_PRESETS.ca` permissions: `['view_reports','view_ledger','view_expenses','audit_gst','view_bills','view_payments','view_documents','manage_accounts']`, using `inviteProfessional` from `opening-helpers.mjs`;
  - the society on a plan with `bank_match`, set the way `tests/db/bank-reconciliation.test.mjs` does.

  Bank statement rows are shaped as in `tests/db/bank-reconciliation.test.mjs`.

  ```js
  test('the CA keeps the asset register and posts depreciation directly', async () => {
    const id = await val(ids.ca, `SELECT public.add_existing_asset($1,'Old DG set','1500','2019-01-01',100000,50000,'2025-04-01')`, [ids.societyId]);
    await q(ids.ca, `SELECT public.update_asset($1,'DG set','Basement',20,'wdv','Per audit')`, [id]);
    assert.ok(Number((await val(ids.ca, `SELECT public.post_depreciation($1,'2026-03-31')`, [ids.societyId])).total) > 0);
    await assert.rejects(q(ids.resident, `SELECT public.add_existing_asset($1,'Pump','1500','2019-01-01',1000,500,'2025-04-01')`, [ids.societyId]),
      /Only the society committee can add assets/);
  });

  test('the CA matches bank lines but never verifies a payment', async () => {
    const bank = await val(ids.ca, `INSERT INTO bank_accounts (society_id, …) VALUES (…) RETURNING id`, …); // columns as BankReconciliation.tsx inserts
    const imp = await val(ids.ca, `SELECT public.import_bank_statement($1,'oct.csv','hdfc',$2)`, [bank, JSON.stringify(ROWS)]);
    const line = (await db.query(`SELECT id FROM bank_transactions WHERE bank_account_id=$1 AND type='credit' LIMIT 1`, [bank])).rows[0].id;
    await assert.rejects(q(ids.ca, 'SELECT public.record_bank_receipt($1,$2)', [line, ids.unit101]));
    assert.equal((await db.query(`SELECT count(*)::int n FROM payments WHERE society_id=$1`, [ids.societyId])).rows[0].n, 0);
    await assert.rejects(q(ids.ca, 'SELECT public.verify_matched_payments($1)', [ids.societyId]), /Only the society committee can verify payments/);
    await q(ids.ca, `SELECT public.ignore_bank_line($1,'Bank charges reversal')`, [line]);
    await assert.rejects(q(ids.resident, `SELECT public.unlink_bank_line($1)`, [line]));
  });
  ```
- [ ] **Step 2: Run** `TZ=UTC node --test tests/db/ca-workspace-moves.test.mjs`. Expected: FAIL with "Only the society committee can add assets" for the CA.
- [ ] **Step 3: Implement** `can_keep_books`, the redefinitions and the policies; then `bun run db:bundle`.
- [ ] **Step 4: Run** the file, then `accounting`, `bank-reconciliation`, `bank-ledgers` and `rls` one at a time. All pass.
- [ ] **Step 5: Commit**: `feat(accounts): the CA or Accountant keeps the asset register and matches bank lines; verifying stays with the committee`.

---

### Task 3: A year lock is proposed and the committee approves it

**Files:** Modify `027_ca_workspace.sql`, `tests/db/ca-workspace-moves.test.mjs`, `tests/db/ca-workspace.test.mjs`, `tests/db/opening-balance.test.mjs`.

**Interfaces:**
- Consumes: `can_keep_books` (Task 2) and `adjustment_proposals` (014).
- Produces:
  - `adjustment_proposals.kind` CHECK now allows `'year_lock'` (drop the constraint and recreate it with the extra value). A year-lock row has `lines = '[]'`, `entry_date = fy_end`, and `reason` = the note, or `'Lock the books up to DD Mon YYYY'` when there is none.
  - `lock_financial_year(p_society_id UUID, p_fy_end DATE, p_note TEXT DEFAULT NULL) RETURNS JSONB` keeps its signature. It now creates the proposal and returns `{ id, proposal_number, status: 'pending' }` (number `AP-NNNN` as in `propose_adjustment`). Guards, in this order:
    - `'Only the committee or the society''s CA can propose a year lock'` (`can_keep_books` is false);
    - the 014 "has ended", "already locked" and "pending adjustment(s)" checks, word for word. Year-lock rows do not count as pending adjustments.
    - `'A lock for this year is already waiting for the committee'`.

    Audit `books.year_lock_proposed`.
  - `decide_adjustment` is redefined from the 014 body. For kind `year_lock` it:
    - re-runs "already locked" and the pending-adjustment count;
    - inserts `financial_year_locks (society_id, fy_end, locked_by = proposed_by, note = reason)`;
    - writes the 014 audit `books.year_locked`;
    - posts no journal; `journal_id` stays NULL.

    Every other kind behaves as before. The proposer-cannot-decide rule applies to all kinds.

- [ ] **Step 1: Write the failing tests** (append to `ca-workspace-moves.test.mjs`; `locked = () => val(ids.ca, 'SELECT public.books_locked_until($1)::text', [ids.societyId])`):

  ```js
  test('a year lock is proposed, then a committee member approves it', async () => {
    const p = await val(ids.ca, `SELECT public.lock_financial_year($1,'2026-03-31','Audited by Priya CA')`, [ids.societyId]);
    assert.equal(p.status, 'pending');
    assert.equal(await locked(), null);
    await assert.rejects(q(ids.ca, `SELECT public.lock_financial_year($1,'2026-03-31')`, [ids.societyId]), /already waiting for the committee/);
    await q(ids.secretary, 'SELECT public.decide_adjustment($1,true)', [p.id]);
    assert.equal(await locked(), '2026-03-31');
    await assert.rejects(q(ids.ca, `SELECT public.lock_financial_year($1,'2026-03-31')`, [ids.societyId]), /already locked/);
    await assert.rejects(q(ids.resident, `SELECT public.lock_financial_year($1,'2027-03-31')`, [ids.societyId]), /Only the committee or the society's CA/);
  });

  test('an adjustment raised after the lock was proposed blocks the approval', async () => {
    // a second society, or 2027-03-31 once that year has ended — use a fresh society from the same setup helper
    const S = await makeSociety('lock2');
    const lock = await val(S.secretary, `SELECT public.lock_financial_year($1,'2026-03-31')`, [S.societyId]);
    await assert.rejects(q(S.secretary, 'SELECT public.decide_adjustment($1,true)', [lock.id]), /another committee member must decide/);
    await q(S.ca, `SELECT public.propose_adjustment($1,'2026-03-15','Year-end provision',$2)`, [S.societyId,
      JSON.stringify([{ code: '5300', amount: 1500 }, { code: '5900', amount: -1500 }])]);
    await assert.rejects(q(S.treasurer, 'SELECT public.decide_adjustment($1,true)', [lock.id]), /Decide the 1 pending adjustment/);
  });
  ```
  - `ca-workspace.test.mjs` "locking an audited year…":
    - the CA's refusal becomes `/Only the committee or the society's CA/` if that file's CA lacks `manage_accounts`; otherwise the CA proposes;
    - the secretary's direct lock becomes a proposal approved by the treasurer, then `books_locked_until` is `'2026-03-31'`;
    - the rest is unchanged.
  - `opening-balance.test.mjs` "a locked audited year…": `B.secretary` proposes and `B.treasurer` approves before `decide_opening_balance`, which `B.secretary` then calls. Ledger a Ruling for each changed assertion.
- [ ] **Step 2: Run** the new file. Expected: FAIL, because `status` is undefined: the lock is still immediate.
- [ ] **Step 3: Implement** the constraint change, `lock_financial_year` and `decide_adjustment`; then `bun run db:bundle`.
- [ ] **Step 4: Run** `ca-workspace-moves`, `ca-workspace`, `opening-balance`, `accounting` and `bill-types` one at a time. All pass.
- [ ] **Step 5: Commit**: `feat(accounts): locking a year is proposed and approved by another committee member`.

---

### Task 4: The CA portal gets the moved screens

**Files:** Modify `src/components/BankReconciliation.tsx`, `YearLockPanel.tsx`, `AdjustmentsPanel.tsx`, `src/views/professional/ProfessionalDashboardPage.tsx`.

**Interfaces:**
- Consumes: Tasks 2–3 RPCs; `society_has_feature(p_society_id, p_key) → boolean` (015).
- Produces:
  - `BankReconciliation` props: `{ societyId: string; canManage: boolean; canVerify?: boolean }`. `canVerify` defaults to `canManage`. "Verify matched payments" and "Record as payment" render only when `canVerify` is true.
  - `YearLockPanel` keeps its props. The button reads "Propose lock". On success it shows "Sent to the committee for approval as {proposal_number}.", and a pending year-lock proposal shows "Waiting for the committee to approve the lock up to {date}." The intro copy says a committee member approves the lock.
  - `AdjustmentsPanel`: `Proposal.kind` gains `'year_lock'`. Such a row reads "{number} · lock the books up to {DD Mon YYYY}" and shows no lines and no surplus effect.

- [ ] **Step 1:** Make the component changes above.
- [ ] **Step 2: CA portal tab changes.**
  - `assets`: `canManage={permissions.includes('manage_accounts')}`.
  - New tab `'bank'`, labelled "Bank Reconciliation" with icon `Landmark` from lucide (rename the existing `Landmark` used by Financial Reports to `BarChart3` if both clash).
    - Allowed when `manage_accounts || view_bank_reconciliation`, and the plan check `society_has_feature(activeSociety.id, 'bank_match')` is true (loaded once per society).
    - Renders `<BankReconciliation canManage={manage_accounts} canVerify={false} />`.
    - When the plan lacks the feature, the tab is disabled with the title "Bank statement match is part of the Pro plan".
  - `'adjustments'` is relabelled "Audit & Year Close". It renders, in this order:
    - `AdjustmentsPanel` (unchanged props);
    - `<YearLockPanel canLock={permissions.includes('manage_accounts')} />`;
    - `PriorYearEditor` (unchanged).
- [ ] **Step 3: Verify:** `bun run typecheck` and `bun run lint` give no errors in the touched files.
- [ ] **Step 4: Commit**: `feat(ca): Bank Reconciliation, Fixed Assets and Audit & Year Close in the CA login`.

---

### Task 5: The secretary's menu: Accounts only for the Accountant; the Accountant switch

**Files:**
- Create: `src/lib/society-nav.ts`, `tests/unit/society-nav.test.ts`
- Modify: `src/views/society/SocietyDashboardPage.tsx`, `src/views/society/tabs/MembersTab.tsx`, `src/context/AuthContext.tsx`, `src/types/database.ts`

**Interfaces:**
- Consumes: `set_accountant` (Task 1); `ChartOfAccounts`, `PartyLedgers`, `BillTypes`, `OpeningBalanceEditor`, `AssetRegister`, `BankReconciliation`, `AdjustmentsPanel`, `YearLockPanel`, `PriorYearEditor`.
- Produces (`src/lib/society-nav.ts`, pure, no React imports; icons are attached in the page):
  ```ts
  export type SocietyTab = 'home' | 'approvals' | 'members' | 'flats' | 'billing' | 'payments' | 'expenses' | 'documents' | 'notices'
    | 'complaints' | 'professionals' | 'reports' | 'settings' | 'plan'
    | 'ledgers' | 'billtypes' | 'opening' | 'assets' | 'bank' | 'audit';
  export interface NavItem { id: SocietyTab; label: string; group: 'main' | 'accounts' }
  export function societyNav(opts: { isAccountant: boolean }): NavItem[];
  ```
  - The `main` items keep today's labels and order, without `assets`, `bank` and `audit`.
  - When `isAccountant`, `accounts` items follow, in this order:
    - "Groups & Ledgers" (`ledgers`);
    - "Bill Types" (`billtypes`);
    - "Opening Balance" (`opening`);
    - "Fixed Assets" (`assets`);
    - "Bank Reconciliation" (`bank`);
    - "Audit & Year Close" (`audit`).
  - `SocietyMembership` (types) gains `is_accountant?: boolean`. `AuthContext` selects `is_accountant` in its memberships query.

- [ ] **Step 1: Write the failing unit tests:**
  ```ts
  test('the secretary menu has no accounting screens', () => {
    const ids = societyNav({ isAccountant: false }).map(i => i.id);
    for (const moved of ['assets', 'bank', 'audit', 'ledgers', 'billtypes', 'opening']) assert.ok(!ids.includes(moved as never), moved);
    assert.deepEqual(ids.slice(0, 2), ['home', 'approvals']);
  });
  test('the accountant sees the Accounts group after the main items', () => {
    const nav = societyNav({ isAccountant: true });
    assert.deepEqual(nav.filter(i => i.group === 'accounts').map(i => i.id), ['ledgers', 'billtypes', 'opening', 'assets', 'bank', 'audit']);
    assert.equal(nav.findIndex(i => i.group === 'accounts'), nav.filter(i => i.group === 'main').length);
  });
  ```
- [ ] **Step 2: Run** `node --test tests/unit/society-nav.test.ts`. Expected: FAIL, module not found. Implement it, then run again: PASS.
- [ ] **Step 3: The dashboard.**
  - `NAV_ITEMS` becomes `societyNav({ isAccountant: Boolean(committeeMembership?.is_accountant) })`, with icons from a local `id → icon` map.
  - The sidebar renders an "Accounts" heading before the first `accounts` item. The mobile "More" list includes the Accounts items.
  - New tab bodies:
    - `ledgers`: `<ChartOfAccounts canManage /><PartyLedgers />`;
    - `billtypes`: `<BillTypes canManage />`;
    - `opening`: `<OpeningBalanceEditor canManage />`.
  - Existing bodies with new props:
    - `assets`: `canManage`;
    - `bank`: `canManage canVerify={!readOnly}`, keeping the FeatureGate;
    - `audit`: as today, but `AdjustmentsPanel canPropose`, `YearLockPanel canLock` and `PriorYearEditor canEdit` all true for the Accountant.
  - A non-Accountant who lands on an accounts tab (an old link) goes to `home`.
- [ ] **Step 4: The Members screen.**
  - Each active committee member row shows a switch "Accountant (keeps the books in Sahvaas)" to secretary / chairman / treasurer / society admin. It calls `set_accountant` and then reloads.
  - Help text: "The Accountant gets the CA's screens: ledgers, bill types, opening balance, assets, bank match and year close. Another committee member approves what they submit."
  - Errors go to the screen's existing error banner.
  - After switching yourself, call `refreshProfile`, or whatever `AuthContext` exposes to reload memberships, so the menu updates without signing out.
- [ ] **Step 5: Verify:**
  - `bun run typecheck` and `bun run lint` give no errors in touched files.
  - Run the full suite one file at a time with no FAIL lines.
  - `bunx next build` compiles `/society` and `/professional`.
- [ ] **Step 6: Commit**: `feat(society): accounting screens leave the secretary menu; the Accountant gets an Accounts group; Accountant switch on Members`.
