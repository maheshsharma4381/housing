# Phase 2C: Opening Balance in the CA Login and Approvals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CA enters the last audited balance sheet, a catch-up entry and flat-wise / vendor-wise balances at go-live; the committee approves it in a new Approvals screen; only then does it reach the books, with party ledgers that tie at every date.

**Architecture:** One migration (`026_opening_balance.sql`), built up across Tasks 1–4. A draft lives in `opening_balances` (one row per society) and changes only through RPCs. Approval posts three journals: audited sheet on 31 March, catch-up on the go-live date, and a party journal that moves the go-live Members' dues / advances / creditors from the control ledgers onto flats and vendors. It also creates the sub-ledger rows behind them: opening bills, opening advances and opening vendor payables. Ledger lines carry a new `party_key` so party ledgers and the Tally export can attribute them.

**Tech Stack:** Next.js 15, React 19, Tailwind v4, Supabase Postgres (plpgsql, RLS), PGlite tests (`node --test`), Bun scripts.

**Spec:** `docs/superpowers/specs/2026-10-31-sahvaas-simplify-design.md`, sections 7.4, 7.5 (authority table), 9.3 (Approvals) and 12 (calls 1–3).

## Phase 2 split (updated)

| Plan | Scope |
|---|---|
| 2A, 2B | Done (groups & ledgers; banks, bill types, party ledgers) |
| **2C (this plan)** | Opening balance in the CA login (two dates, draft → submit → committee approval), secretary **Approvals** screen (opening balance + CA adjustments), old secretary opening-balance screen removed |
| 2D | Committee "Accountant" role; Fixed Assets / Bank Reconciliation / Audit & Year Close move to the CA login; year lock by committee approval; asset register on CA-created fixed-asset ledgers with depreciation rates; "move to another bank" adjustment (2B review, Important 2); bank choice for asset sale proceeds |
| 2E | Owner change and ownership history (was 2D) |

## Decisions (taken on the product owner's behalf — "u decide")

1. **Two dates, as the spec says.** Audited sheet dated the last 31 March; flat-wise dues, advances and vendor payables dated the go-live date; the catch-up entry is dated the go-live date. Go-live may equal the audited date (society starting on 1 April has an empty catch-up).
2. **No plug.** Nothing is posted to General Reserve automatically; submit is refused until each part ties.
3. **The audited sheet holds only asset, liability and fund ledgers.** Income and expense belong in the catch-up entry.
4. **Flat-wise dues need a linked owner** (`bills.user_id` is NOT NULL until Phase 4 makes bills belong to flats). Submit names the flat.
5. **Vendor-wise payables are optional** (spec call 3). Their total may be less than Sundry Creditors at go-live, never more; the rest shows as "Not linked to a vendor".
6. **A flat's opening advance is used automatically**, first on bills already issued after go-live (at approval), then on each new bill before any payment advance.
7. **Rejection sends the draft back to the CA with the reason.** The CA can withdraw a submitted draft to edit it.
8. **The old secretary function `post_opening_balances` is retired**: it raises a message pointing to the CA login.
9. **Until 2D, only a CA with "Manage accounts" (or the platform owner) prepares the opening balance.** The committee Accountant role comes in 2D.

## Global Constraints

- New SQL goes only in `src/db/migrations/026_opening_balance.sql`; never edit 001–025. After every SQL change run `bun run db:bundle`. Never run `bun run db:migrate --apply` (the product owner does).
- A redefined function is a verbatim copy of its latest body plus the change, with a comment naming the source file (`-- from 020_ledger_management.sql`). Latest bodies: `post_journal` 020, `party_entries` 025, `trg_journal_respect_lock` 014, `post_opening_balances` / `ledger_apply_advance` 010, `ledger_post_expense_accrual` 013, `void_expense` 013 (line 954).
- Every RPC is `SECURITY DEFINER SET search_path = public`; callable RPCs: `REVOKE ALL … FROM PUBLIC, anon; GRANT EXECUTE … TO authenticated`; internal helpers: `REVOKE ALL … FROM PUBLIC, anon, authenticated`.
- Amounts are stored debit positive, credit negative; money in messages uses `money_text(n)` (Task 1): `'₹' || to_char(abs(round(n, 2)), 'FM99,99,99,99,990.00')` → `₹1,50,000.00`.
- Every change writes `audit_logs` (`entity_type 'opening_balance'`, `entity_id` = society id).
- DB tests run one file at a time: `TZ=UTC node --test tests/db/<file>`. Full suite = every file in `tests/unit` and `tests/db`, one at a time.
- App UI is English only; amounts via `formatINR`. Explanations to the product owner are in Hinglish (not in the app).
- Commits: `git -c user.name=ved300406 -c user.email=ved300406@gmail.com commit …`, message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Review Focus

1. **Bad dates**: audited date not a 31 March, go-live before it or in the future → clear refusal on save (Task 1 test).
2. **A flat with dues but no owner** → submit refused naming the flat; nothing posted (Task 2 test).
3. **Bills issued between go-live and approval** for a flat with an opening advance → the advance pays them at approval and the party ledger still ties (Task 4 test).
4. **Editing after submit** → refused with "withdraw it"; withdraw, edit, resubmit works (Task 2 test).
5. **A locked year covering the audited date** → approval refused with the lock message; status stays `submitted`; no journals, bills or advances half-created (Task 3 test).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/migrations/026_opening_balance.sql` (new) | Draft table, read/save/submit/withdraw/decide RPCs, party tags, opening advances, opening payables, retired old function |
| `tests/db/opening-helpers.mjs` (new) | `inviteProfessional`, `approveOpening` for any DB test |
| `tests/db/opening-balance.test.mjs` (new) | The rules of this plan |
| `tests/db/launch.test.mjs`, `tests/db/party-ledgers.test.mjs` | Move their opening step to the new flow |
| `src/lib/opening-balance.ts` (new) | Types, starting-line template, sign helpers, FY-end and catch-up labels |
| `tests/unit/opening-balance.test.ts` (new) | Pure helpers |
| `src/components/OpeningBalanceEditor.tsx` (new) | CA screen |
| `src/components/OpeningBalanceReview.tsx` (new) | Committee approval card |
| `src/views/professional/ProfessionalDashboardPage.tsx` | "Opening Balance" tab |
| `src/views/society/SocietyDashboardPage.tsx` | "Approvals" tab + badge |
| `src/views/society/tabs/SettingsTab.tsx`, `src/views/society/tabs/OpeningBalances.tsx` (delete) | Old secretary screen removed |

---

### Task 1: Draft storage, read and save

**Files:**
- Create: `src/db/migrations/026_opening_balance.sql`, `tests/db/opening-helpers.mjs`, `tests/db/opening-balance.test.mjs`
- Regenerate: `src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql`

**Interfaces:**
- Consumes: `can_manage_accounts(UUID)` (019), `can_view_financials(UUID)` (012), `party_name(UUID, TEXT, TEXT)` (025, returns e.g. `'Flat 101'`).
- Produces:
  - table `opening_balances(society_id UUID PK → societies ON DELETE CASCADE, audited_as_of DATE NOT NULL CHECK 31 March, live_on DATE NOT NULL, audited_lines JSONB NOT NULL DEFAULT '[]', catchup_lines JSONB NOT NULL DEFAULT '[]', flat_lines JSONB NOT NULL DEFAULT '[]', vendor_lines JSONB NOT NULL DEFAULT '[]', status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK IN ('draft','submitted','approved'), decision_note TEXT, prepared_by UUID, updated_at TIMESTAMPTZ, submitted_by UUID, submitted_at TIMESTAMPTZ, decided_by UUID, decided_at TIMESTAMPTZ)`; RLS on; one SELECT policy `can_view_financials(society_id) OR can_manage_accounts(society_id)`; no write policies.
  - Line shapes: audited `{code, amount, side: 'liabilities'|'assets', label?}`; catch-up `{code, amount}`; flats `{unit_id, amount}` (dues +, advance −); vendors `{vendor_id, amount}` (payable, > 0).
  - `money_text(p NUMERIC) RETURNS TEXT` (internal, IMMUTABLE).
  - `opening_balance(p_society_id UUID) RETURNS JSONB`:
    ```
    { status: 'none'|'draft'|'submitted'|'approved', audited_as_of, live_on, audited_lines, catchup_lines, flat_lines, vendor_lines,
      decision_note, prepared_by_name, submitted_by_name, submitted_at, decided_at,
      checks: { audited_difference, catchup_difference, dues_expected, dues_entered, advance_expected, advance_entered,
                creditors_expected, vendors_entered },
      flats: [{ unit_id, name, owner_name }],   -- every flat, ordered by wing name then unit_number
      vendors: [{ vendor_id, name }] }           -- every vendor, by name
    ```
    `audited_difference` = sum of audited amounts; `catchup_difference` = sum of catch-up amounts. `dues_expected` = sum of audited and catch-up amounts on `1200`; `dues_entered` = sum of positive flat amounts. `advance_expected` = −(sum on `2300`); `advance_entered` = −(sum of negative flat amounts). `creditors_expected` = −(sum on `2000`); `vendors_entered` = sum of vendor amounts. Access: `can_view_financials OR can_manage_accounts`, else `'You do not have access to this society''s accounts'`.
  - `save_opening_balance(p_society_id UUID, p_audited_as_of DATE, p_live_on DATE, p_audited_lines JSONB, p_catchup_lines JSONB, p_flat_lines JSONB, p_vendor_lines JSONB) RETURNS JSONB` returns `opening_balance(p_society_id)`. It inserts or updates (status stays or becomes `draft`, `decision_note` kept), drops zero-amount lines, rounds to 2 places, fills a missing `side` from the sign (negative → `liabilities`), and writes audit `opening_balance.saved`. Messages, checked in this order:
    - `'Only the society''s CA or accountant can prepare the opening balance'`
    - `'The opening balance is waiting for the committee — withdraw it to make changes'` (status submitted)
    - `'The opening balance is already approved — correct it with an adjustment'` (status approved)
    - `'Opening balances are already in the books for this society'` (a legacy `opening.balance` journal exists)
    - `'The audited balance sheet date must be a 31 March'`
    - `'The go-live date must be on or after the audited balance sheet date and not in the future'`
    - `'Unknown ledger %'` (code not in this society)
    - `'A balance sheet line cannot use % (an income or expense ledger) — put it in the catch-up entry'`
    - `'Flat not found in this society'`, `'Each flat appears once'`
    - `'Vendor not found in this society'`, `'Each vendor appears once'`, `'Vendor payables are entered as positive amounts'`

- [ ] **Step 1: Write the shared helpers** — `tests/db/opening-helpers.mjs` exports:
  - `inviteProfessional(db, { societyId, inviter, email, permissions = ['view_reports', 'manage_accounts'] })`: same steps as `inviteProfessional` in `tests/db/bill-types.test.mjs`; returns the user id.
  - `approveOpening(db, { societyId, ca, approver, auditedAsOf = '2026-03-31', liveOn, audited, catchup = [], flats = [], vendors = [] })`: save as `ca`, `submit_opening_balance` as `ca`, `decide_opening_balance(…, true)` as `approver`; returns `opening_balance()` (Tasks 2–3 make it usable).

- [ ] **Step 2: Write the failing tests** in `tests/db/opening-balance.test.mjs`.

  Setup: `makeSociety(tag)` creates a society with flats 101, 102, 103, a secretary (creator) and a treasurer. It links owners to 101 and 102 only, invites a CA with `inviteProfessional`, inserts vendor `Shiv Lifts` (PAN `ABCPP1234K`), and returns `{ societyId, secretary, treasurer, r101, r102, ca, u101, u102, u103, vendor }`. Society **A** is created in `before`. Shared fixtures:

  ```js
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
  ```

  ```js
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
  ```

- [ ] **Step 3: Run to verify they fail** — `TZ=UTC node --test tests/db/opening-balance.test.mjs` → FAIL (`function public.save_opening_balance … does not exist`).
- [ ] **Step 4: Implement** the table, policy, `money_text`, `opening_balance`, `save_opening_balance` and the privileges in `026_opening_balance.sql`; `bun run db:bundle`.
- [ ] **Step 5: Run to verify they pass** — same command → 3 pass.
- [ ] **Step 6: Commit** — `feat(accounts): the CA drafts the opening balance; the committee can read it`.

---

### Task 2: Submit, the tie-out checks, and withdraw

**Files:** Modify `026_opening_balance.sql`, `tests/db/opening-balance.test.mjs`.

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `opening_balance_problem(p_society_id UUID) RETURNS TEXT` (internal): NULL when the stored draft may be posted; otherwise the first problem, in this order:
    1. `'Nothing to submit — enter the balance sheet first'` (audited, catch-up and flat lines all empty)
    2. `'Ledger % is inactive — choose an active ledger'` (any audited or catch-up code)
    3. `'The balance sheet does not tally — the two sides differ by %'`
    4. `'The catch-up entry does not tally — debits and credits differ by %'`
    5. `'Flat-wise dues add up to % but Members'' dues come to %'`
    6. `'Flat-wise advances add up to % but Advances from members come to %'`
    7. `'Vendor-wise payables add up to % — more than Sundry Creditors of %'`
    8. `'% has no owner linked — ask the secretary to invite the owner first'` (`party_name` of the first flat, in wing / unit order, with positive dues and neither an active `resident_owner` membership nor `units.current_owner_id`)
  - `submit_opening_balance(p_society_id UUID) RETURNS JSONB` (manage accounts; status must be `draft`, else `'Only a draft can be submitted'`; raises the problem text; sets `submitted_by/at`, clears nothing else; audit `opening_balance.submitted`; returns `opening_balance()`).
  - `reopen_opening_balance(p_society_id UUID) RETURNS JSONB` (manage accounts; status must be `submitted`, else `'Only a submitted opening balance can be withdrawn'`; back to `draft`; audit `opening_balance.withdrawn`).

- [ ] **Step 1: Write the failing tests**

  ```js
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
  ```
- [ ] **Step 2: Run to verify they fail** (`submit_opening_balance` does not exist).
- [ ] **Step 3: Implement** `opening_balance_problem`, `submit_opening_balance`, `reopen_opening_balance`; `bun run db:bundle`.
- [ ] **Step 4: Run** the file → 5 pass.
- [ ] **Step 5: Commit** — `feat(accounts): the opening balance is submitted only when every part ties`.

---

### Task 3: Committee approval posts the books; party tags; old flow retired

**Files:** Modify `026_opening_balance.sql`, `tests/db/opening-balance.test.mjs`, `tests/db/launch.test.mjs`, `tests/db/party-ledgers.test.mjs`.

**Interfaces:**
- Consumes: Tasks 1–2, `post_journal` (020), `party_entries` / `party_balances` (025).
- Produces:
  - `ledger_entries.party_key TEXT` (nullable). `post_journal` is redefined to store `nullif(v_line ->> 'party', '')` there.
  - `party_entries` is redefined: a line's `party_key` wins (kind `flat` for 1200/2300, `vendor` for 2000). The old "split the opening 1200 line by opening bills" branch and the "Opening balance not split by flat" branch are removed; untagged opening lines fall to `'unlinked'`.
  - `trg_journal_respect_lock` is redefined: the manual list becomes `('adjustment.approved', 'opening.balance', 'opening.catchup', 'opening.parties', 'opening_advance.applied', 'depreciation.run')`.
  - `post_opening_balances(UUID, DATE, JSONB, JSONB)` is redefined to only `RAISE EXCEPTION 'Opening balances are now entered by the society''s CA under Opening Balance in the CA login'`.
  - `decide_opening_balance(p_society_id UUID, p_approve BOOLEAN, p_note TEXT DEFAULT NULL) RETURNS JSONB`:
    - Guards, in order:
      - `'Only the society committee can approve the opening balance'` (not `is_platform_admin()` / `is_society_admin`);
      - `'There is no opening balance waiting for approval'`;
      - `'You submitted this opening balance; another committee member must approve it'` (`submitted_by = auth.uid()`);
      - `'Give a reason for rejecting'`.
    - Reject: the row goes back to status `draft` with `decision_note` = the reason and `decided_by/at` set; audit `opening_balance.rejected`; returns `{ status: 'rejected' }`.
    - Approve: raise `opening_balance_problem` if any, then post, in this order:
      1. `post_journal(…, audited_as_of, 'opening.balance', society_id, 'Opening balances as on DD-Mon-YYYY (audited balance sheet)', audited lines as {code, amount})`.
      2. `post_journal(…, live_on, 'opening.catchup', society_id, 'Catch-up entry from DD-Mon-YYYY to DD-Mon-YYYY', catch-up lines)`. The range is `audited_as_of + 1` to `live_on - 1`; nothing is posted when the catch-up is empty.
      3. One billing cycle `'Opening balance (dues)'`, plus an opening bill per flat with positive dues. Bills are numbered `OB-0001`… in wing-name / unit-number order. Bill date and due date are `live_on`; `is_opening_balance` is true; the owner is resolved as in 010; the bill item reads `'Opening balance (dues as on DD-Mon-YYYY)'`.
      4. `post_journal(…, live_on, 'opening.parties', society_id, 'Opening dues, advances and payables by flat and vendor as on DD-Mon-YYYY', lines)` with these lines:
         - **Members' dues:** `1200` `−total dues` with narration `'Members'' dues moved to flats'`, then `+dues` per flat with `party` = unit id.
         - **Advances:** `2300` `+total advances`, then `−advance` per flat with `party` = unit id.
         - **Creditors:** `2000` `+total vendor payables`, then `−payable` per vendor with `party` = vendor id.
      - Status `approved`, `decided_by/at`; audit `opening_balance.approved`; returns `{ status: 'approved', opening_bills }`.

- [ ] **Step 1: Write the failing tests** (`decide = (s, user, ok, note = null) => val(user, 'SELECT public.decide_opening_balance($1,$2,$3)', [s.societyId, ok, note])`; `codeBalances(s, asOf)` = `{code: sum(amount)}` of non-zero balances up to `asOf`; `parties(s, kind, asOf)` = `party_balances` as treasurer).

  ```js
  test('the committee decides; rejecting needs a reason and sends it back to the CA', async () => {
    await assert.rejects(decide(A, A.ca, true), /Only the society committee can approve/);
    await assert.rejects(decide(A, A.r101, true), /Only the society committee can approve/);
    await assert.rejects(decide(A, A.secretary, false), /Give a reason/);
    const back = await decide(A, A.secretary, false, 'Sinking fund is from the draft audit');
    assert.equal(back.status, 'rejected');
    const d = await show(A, A.ca);
    assert.deepEqual([d.status, d.decision_note], ['draft', 'Sinking fund is from the draft audit']);
    await submit(A, A.ca);
  });

  test('a locked audited year stops approval and nothing is half-posted', async () => {
    const B = await makeSociety('b');
    await save(B, B.ca, { audited: AUDITED, catchup: CATCHUP, flats: [{ unit_id: B.u101, amount: 5000 }, { unit_id: B.u102, amount: -1500 }] });
    await submit(B, B.ca);
    await q(B.secretary, `SELECT public.lock_financial_year($1,'2026-03-31')`, [B.societyId]);
    await assert.rejects(decide(B, B.treasurer, true), /locked after audit/);
    assert.equal((await show(B, B.ca)).status, 'submitted');
    const n = await db.query(`SELECT (SELECT count(*) FROM journal_entries WHERE society_id=$1 AND reference_event_type LIKE 'opening.%')::int j,
      (SELECT count(*) FROM bills WHERE society_id=$1)::int b`, [B.societyId]);
    assert.deepEqual(n.rows[0], { j: 0, b: 0 });
  });

  test('approval posts the audited sheet on 31 March and the catch-up on the go-live date', async () => {
    const r = await decide(A, A.treasurer, true);
    assert.deepEqual([r.status, r.opening_bills], ['approved', 1]);
    assert.deepEqual(await codeBalances(A, '2026-03-31'), { 1000: 80000, 1200: 9000, 2000: -8000, 2300: -1000, 3000: -60000, 3200: -20000 });
    assert.deepEqual(await codeBalances(A, '2026-10-01'),
      { 1000: 113500, 1200: 5000, 2000: -3000, 2300: -1500, 3000: -60000, 3200: -20000, 4000: -54000, 5100: 20000 });
    const ob = (await db.query(`SELECT bill_number, bill_date::text d, total_amount, is_opening_balance FROM bills WHERE society_id=$1`, [A.societyId])).rows;
    assert.deepEqual(ob.map((b) => [b.bill_number, b.d, Number(b.total_amount), b.is_opening_balance]), [['OB-0001', '2026-10-01', 5000, true]]);
    await assert.rejects(save(A, A.ca, { audited: AUDITED }), /already approved — correct it with an adjustment/);
  });

  test('flat-wise and vendor-wise ledgers tie to the control ledgers before and after go-live', async () => {
    for (const asOf of ['2026-09-30', '2026-10-01']) {
      const f = await parties(A, 'flat', asOf);
      assert.equal(f.parties.reduce((s, p) => s + Number(p.dues), 0), Number(f.control.dues), asOf);
      assert.equal(f.parties.reduce((s, p) => s + Number(p.advance), 0), Number(f.control.advance), asOf);
    }
    const live = await parties(A, 'flat', '2026-10-01');
    assert.deepEqual(live.parties.filter((p) => Number(p.balance) !== 0).map((p) => [p.name, Number(p.dues), Number(p.advance)]),
      [['Flat 101', 5000, 0], ['Flat 102', 0, 1500]]);
    const v = await parties(A, 'vendor', '2026-10-01');
    assert.deepEqual(v.parties.filter((p) => Number(p.balance) !== 0).map((p) => [p.name, Number(p.balance)]), [['Shiv Lifts', 3000]]);
    assert.equal(Number(v.control.payable), 3000);
  });

  test('the secretary can no longer post opening balances directly', async () => {
    await assert.rejects(q(A.secretary, `SELECT public.post_opening_balances($1,'2026-03-31','[]','[]')`, [A.societyId]),
      /entered by the society's CA/);
  });
  ```
  - `tests/db/launch.test.mjs`:
    - Replace the `postOpening` helper and the test `'opening balances: validation'` with `'opening balances: the committee can no longer post them directly'` (asserts the message above).
    - In `'opening balances: TB + flat arrears post once…'`, invite a CA (`inviteProfessional`) and call `approveOpening` with approver `ids.admin`, `liveOn: '2026-03-31'`, audited `[1000 +150000, 3000 −100000, 1200 +8500, 3200 −58500]` (sides by sign) and flats `[{u101: 4500}, {u102: 4000}]`. The balances and `OB-0001` assertions stay. The "already posted" assertion becomes a `save_opening_balance` call that rejects with `/already approved/`. Later tests in the file must pass unchanged.
  - `tests/db/party-ledgers.test.mjs` step 1:
    - Use `approveOpening` with audited `[2000 −4000, 1000 +4000, 1200 +2500, 3200 −2500]`, `liveOn: '2026-09-30'` and flats `[{102: 2500}]`, with no vendors, so the creditor stays "Not linked to a vendor".
    - Reuse the file's CA, or invite one.
    - If a Tally line-count expectation changes because of the new journals, update it and ledger a Ruling.
- [ ] **Step 2: Run to verify they fail** (`decide_opening_balance` does not exist).
- [ ] **Step 3: Implement** `party_key`, `post_journal`, `party_entries`, `trg_journal_respect_lock`, `post_opening_balances` (retired), `decide_opening_balance`; `bun run db:bundle`.
- [ ] **Step 4: Run** `opening-balance`, `launch`, `party-ledgers` and `accounting` test files one at a time → all pass.
- [ ] **Step 5: Commit** — `feat(accounts): the committee approves the opening balance; dues, advances and payables land on flats and vendors`.

---

### Task 4: Opening advances get used; opening payables get paid

**Files:** Modify `026_opening_balance.sql`, `tests/db/opening-balance.test.mjs`.

**Interfaces:**
- Consumes: Task 3 (`decide_opening_balance` is edited in place in the same migration).
- Produces:
  - Table `opening_advances(id UUID PK, society_id UUID NOT NULL, unit_id UUID NOT NULL → units, amount NUMERIC(12,2) NOT NULL CHECK (amount > 0), remaining NUMERIC(12,2) NOT NULL CHECK (remaining >= 0 AND remaining <= amount), as_of DATE NOT NULL, created_at TIMESTAMPTZ)`. RLS select: `can_view_financials(society_id)`.
  - `ledger_apply_advance` is redefined so the bill's flat's `opening_advances.remaining` (oldest first, `FOR UPDATE`) is used before payments. Its single `advance.applied` journal covers both.
  - `decide_opening_balance` (approve) also:
    - inserts an `opening_advances` row per negative flat line;
    - uses each advance on that flat's open bills: status in `issued`, `partially_paid` or `overdue`, `balance_due > 0`, oldest `due_date` first;
    - when anything is used, posts `post_journal(…, current_date, 'opening_advance.applied', advance id, 'Opening advance adjusted against bills of <flat name>', [2300 +used party unit, 1200 −used party unit])`.
  - `expenses.is_opening_balance BOOLEAN NOT NULL DEFAULT false`.
  - `decide_opening_balance` (approve) inserts one expense per vendor line, with `sahvaas.expense_workflow` on. Columns: `vendor_id`, category `'other'`, title `'Opening balance (payable as on DD-Mon-YYYY)'`, `subtotal` = amount, `gst_amount 0`, `tds_amount 0`, invoice number `OB-0001`…, invoice date `live_on`, `expense_type 'revenue'`, status `'approved'`, `approved_by` = approver, `approved_at` now, `is_opening_balance true`. If an insert check asks for another column, set it and ledger a Ruling.
  - `ledger_post_expense_accrual` is redefined to `RETURN NULL` for an opening payable (its amount is already in the party journal).
  - `void_expense` is redefined to refuse an opening payable with `'An opening payable cannot be voided — it came from the approved opening balance'`.

- [ ] **Step 1: Write the failing tests**

  ```js
  test("a flat's opening advance pays its next bill first", async () => {
    await q(A.secretary, `INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Maintenance','flat_per_unit',1000)`, [A.societyId]);
    await q(A.secretary, `SELECT public.generate_bills($1,'2026-11-01','2026-11-30','2026-11-10')`, [A.societyId]);
    const b = (await db.query(`SELECT unit_id, balance_due, status FROM bills WHERE society_id=$1 AND NOT is_opening_balance`, [A.societyId])).rows;
    const byUnit = Object.fromEntries(b.map((r) => [r.unit_id, [Number(r.balance_due), r.status]]));
    assert.deepEqual(byUnit[A.u102], [0, 'paid']);
    assert.deepEqual(byUnit[A.u101], [1000, 'issued']);
    assert.equal(Number((await db.query(`SELECT remaining FROM opening_advances WHERE unit_id=$1`, [A.u102])).rows[0].remaining), 500);
    const f = await parties(A, 'flat');
    assert.equal(Number(f.parties.find((p) => p.name === 'Flat 102').advance), 500);
    assert.equal(f.parties.reduce((s, p) => s + Number(p.advance), 0), Number(f.control.advance));
  });

  test('an opening advance clears bills issued before the approval', async () => {
    const C = await makeSociety('c');
    await q(C.secretary, `INSERT INTO billing_rules (society_id, name, calculation_type, rate) VALUES ($1,'Maintenance','flat_per_unit',1000)`, [C.societyId]);
    await q(C.secretary, `SELECT public.generate_bills($1,'2026-10-01','2026-10-31','2026-10-10')`, [C.societyId]);
    await approveOpening(db, { societyId: C.societyId, ca: C.ca, approver: C.treasurer, liveOn: '2026-10-01',
      audited: [{ code: '2300', amount: -1500, side: 'liabilities' }, { code: '1000', amount: 1500, side: 'assets' }],
      flats: [{ unit_id: C.u102, amount: -1500 }] });
    const bill = (await db.query(`SELECT balance_due, status FROM bills WHERE unit_id=$1`, [C.u102])).rows[0];
    assert.deepEqual([Number(bill.balance_due), bill.status], [0, 'paid']);
    const j = await db.query(`SELECT count(*)::int n FROM journal_entries WHERE society_id=$1 AND reference_event_type='opening_advance.applied'`, [C.societyId]);
    assert.equal(j.rows[0].n, 1);
    const f = await parties(C, 'flat');
    assert.equal(f.parties.reduce((s, p) => s + Number(p.dues), 0), Number(f.control.dues));
    assert.equal(f.parties.reduce((s, p) => s + Number(p.advance), 0), Number(f.control.advance));
  });

  test('a vendor-wise opening payable is paid in the app and cannot be voided', async () => {
    const e = (await db.query(`SELECT id, status, subtotal FROM expenses WHERE society_id=$1 AND is_opening_balance`, [A.societyId])).rows[0];
    assert.deepEqual([e.status, Number(e.subtotal)], ['approved', 3000]);
    const acc = await db.query(`SELECT count(*)::int n FROM journal_entries WHERE reference_event_type='expense.approved' AND reference_event_id=$1`, [e.id]);
    assert.equal(acc.rows[0].n, 0);
    await q(A.treasurer, `SELECT public.record_vendor_payment($1,3000,0,'neft','UTR-OB','2026-11-01')`, [e.id]);
    const v = await parties(A, 'vendor');
    assert.equal(Number(v.control.payable), 0);
    assert.equal(v.parties.filter((p) => Number(p.balance) !== 0).length, 0);
    await assert.rejects(q(A.secretary, `SELECT public.void_expense($1,'wrong')`, [e.id]), /opening payable cannot be voided/);
  });
  ```
- [ ] **Step 2: Run to verify they fail** (`relation "opening_advances" does not exist`).
- [ ] **Step 3: Implement** the table, column, the redefinitions and the additions to `decide_opening_balance`; `bun run db:bundle`.
- [ ] **Step 4: Run** `opening-balance`, `launch`, `accounting`, `bank-ledgers`, `party-ledgers` one at a time → all pass.
- [ ] **Step 5: Commit** — `feat(accounts): opening advances pay the next bills; opening payables are paid in the app`.

---

### Task 5: The CA's Opening Balance screen

**Files:**
- Create: `src/lib/opening-balance.ts`, `tests/unit/opening-balance.test.ts`, `src/components/OpeningBalanceEditor.tsx`
- Modify: `src/views/professional/ProfessionalDashboardPage.tsx`

**Interfaces:**
- Consumes: RPCs from Tasks 1–3; `chart_of_accounts` RPC and `Chart` types (`src/lib/chart.ts`); `create_ledger(p_society_id, p_group_id, p_name) → code`.
- Produces (`src/lib/opening-balance.ts`):
  ```ts
  export type Side = 'liabilities' | 'assets';
  export interface AuditedLine { code: string; amount: number; side: Side; label?: string }
  export interface TemplateLine { side: Side; label: string; code?: string; groupKey?: string; pickFrom?: 'fixed_assets' | 'bank_accounts' }
  export interface OpeningBalance { /* the opening_balance() JSON of Task 1 */ }
  export const OPENING_TEMPLATE: TemplateLine[];
  export function signed(side: Side, amount: number): number;      // liabilities → −amount; assets → +amount (its own inverse)
  export function sideTotal(lines: AuditedLine[], side: Side): number; // sum of signed(side, amount) for lines on that side
  export function fyEnds(today: Date, count?: number): string[];   // 31 Marches strictly before today, newest first, default 3
  export function catchupLabel(auditedAsOf: string, liveOn: string): string | null;
  ```
  `OPENING_TEMPLATE`, in this order.
  - **Liabilities & funds:**
    - Share Capital (`groupKey 'capital_funds'`)
    - Reserve Fund (`code '3200'`)
    - Sinking Fund (`'3000'`)
    - Repair Fund (`'3100'`)
    - Building Fund (`capital_funds`)
    - Income & Expenditure Account (`capital_funds`)
    - Sundry Creditors (`'2000'`)
    - Advance maintenance received (`'2300'`)
    - Deposits from members (`current_liabilities`)
    - GST payable (`'2100'`)
    - TDS payable (`'2200'`)
  - **Assets:**
    - Fixed assets (net of depreciation) (`pickFrom 'fixed_assets'`)
    - Fixed deposits (`investments`)
    - Bank (`pickFrom 'bank_accounts'`; the screen shows one line per active bank ledger)
    - Cash in hand (`'1100'`)
    - Members' dues (`'1200'`)
    - MSEB / water deposits (`loans_advances`)
    - Interest accrued on FDs (`current_assets`)
    - TDS receivable (`loans_advances`)
    - Advances to vendors (`'1400'`)

- [ ] **Step 1: Write the failing unit tests** (`tests/unit/opening-balance.test.ts`):
  - `signed('liabilities', 500) === -500`, `signed('assets', 500) === 500`, `signed('liabilities', signed('liabilities', 7)) === 7`;
  - `sideTotal([{code:'3000',amount:-60000,side:'liabilities'},{code:'1000',amount:80000,side:'assets'},{code:'1590',amount:-5000,side:'assets'}], 'assets') === 75000`;
  - `fyEnds(new Date('2026-11-03'))` → `['2026-03-31','2025-03-31','2024-03-31']`; `fyEnds(new Date('2027-03-31'))[0] === '2026-03-31'`; `fyEnds(new Date('2027-04-01'))[0] === '2027-03-31'`;
  - `catchupLabel('2026-03-31','2026-10-01') === 'Catch-up from 1 Apr 2026 to 30 Sep 2026'`; `catchupLabel('2026-03-31','2026-04-01') === null`;
  - every template line has exactly one of `code`, `groupKey`, `pickFrom`.
- [ ] **Step 2: Run** `node --test tests/unit/opening-balance.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `src/lib/opening-balance.ts`; run → PASS.
- [ ] **Step 4: Build `OpeningBalanceEditor`** (`{ societyId: string; canManage: boolean }`). It loads `opening_balance` and `chart_of_accounts`. Copy, exactly:
  - Intro: "Enter the last audited balance sheet exactly as it is, then each flat's dues on the day the society started using Sahvaas. The committee approves it before anything reaches the books."
  - Dates: "Audited balance sheet as on" (select from `fyEnds`) and "Started using Sahvaas on" (date; min = audited date, max = today).
  - "1. Audited balance sheet": two columns, "Liabilities & funds" and "Assets". Each row has a label, a ledger select (only asset/liability/equity ledgers) and an amount; "+ Add line". The footer shows each side's total and either "Both sides match" (emerald) or "Difference: ₹X" (rose).
  - "2. {catchupLabel}": help "One summary entry for the months between the audit and go-live: income, expenses, collections and payments for that period." Rows are ledger · Debit · Credit, with a difference line. When the label is null, show "Nothing to enter — you started on 1 April." instead of the rows.
  - "3. Flat-wise dues on {live date}": every flat from `flats`, columns Flat · Owner · Dues · Advance. The footer reads "Members' dues on {date}: ₹X (balance sheet ₹A + catch-up ₹B)", and likewise for "Advance maintenance", each with Matches/Differs styling as in `PartyLedgers.tsx`.
  - "4. Vendor-wise payables on {live date} (optional)": rows are vendor select · amount; help "Sundry Creditors on {date}: ₹X. Anything not given to a vendor stays as “Not linked to a vendor”."
  - Buttons:
    - "Save draft".
    - "Submit for approval", disabled while any check differs, and only for `canManage`.
    - Banners:
      - draft with a note: "The committee sent this back: {note}";
      - submitted: "Waiting for the committee's approval (submitted {date})." with a "Withdraw to edit" button;
      - approved: "Approved on {date}. Corrections now go through Adjustments." The whole screen is read-only.
  - Saving a template line that has an amount but no ledger first calls `create_ledger` in its group, with the line's label as the name, then saves with the returned code. Lines with zero amounts are skipped.
- [ ] **Step 5: Add the tab** in `ProfessionalDashboardPage.tsx`:
  - `Tab` gains `'opening'`, with label "Opening Balance" and icon `BookOpen`, placed after "Bill Types".
  - `allowed.opening = manage_accounts || view_reports || view_ledger`; it is added to the first-allowed order after `billtypes`.
  - It renders `<OpeningBalanceEditor societyId canManage={permissions.includes('manage_accounts')} />`.
- [ ] **Step 6: Verify** — `bun run typecheck` and `bun run lint` → no errors; unit test passes.
- [ ] **Step 7: Commit** — `feat(ca): Opening Balance screen in the CA login`.

---

### Task 6: Secretary Approvals; old opening screen removed

**Files:**
- Create: `src/components/OpeningBalanceReview.tsx`
- Modify: `src/views/society/SocietyDashboardPage.tsx`, `src/views/society/tabs/SettingsTab.tsx`
- Delete: `src/views/society/tabs/OpeningBalances.tsx`

**Interfaces:**
- Consumes: `opening_balance`, `decide_opening_balance`; `AdjustmentsPanel` (`canDecide`, `canPropose`, `currentUserId`).
- Produces: `OpeningBalanceReview` (`{ societyId: string; canDecide: boolean; onDecided?: () => void }`).

- [ ] **Step 1: Build `OpeningBalanceReview`**, a card titled "Opening balance":
  - status `none`/`draft`: "Your CA has not submitted the opening balance yet.";
  - `submitted`:
    - "Prepared by {prepared_by_name}, submitted {date}";
    - the audited sheet as two lists (label or ledger name, amount) with totals;
    - the catch-up lines (ledger, Debit, Credit);
    - a flats table (Flat, Owner, Dues, Advance) with totals;
    - vendor payables;
    - buttons "Approve" (confirm: "Approve the opening balance? It goes into the books and flat-wise dues become bills the owners can pay.") and "Send back". "Send back" needs a reason; its placeholder is "What should the CA correct?".
    - When `!canDecide`: "A secretary, chairman or treasurer approves this." and no buttons. Server errors (e.g. the submitter rule) show in a `Banner`.
  - `approved`: "Approved on {date}."
- [ ] **Step 2: Add the Approvals tab** in `SocietyDashboardPage.tsx`:
  - `Tab` gains `'approvals'`, with label "Approvals" and icon `ListChecks`, placed right after `home` in `NAV_ITEMS`.
  - It renders `<OpeningBalanceReview canDecide={!readOnly} onDecided={loadSocietyData} />` and then `<AdjustmentsPanel canDecide={!readOnly} canPropose={false} currentUserId={user?.id} />`.
  - Badge: pending adjustments (`adjustment_proposals` with status `pending`, count via a `head: true` query), plus 1 when the `opening_balances` row is `submitted`. Both are loaded in `loadSocietyData`; the badge uses the same style as the expenses badge.
- [ ] **Step 3: Remove** the `OpeningBalances` import and render from `SettingsTab.tsx` and delete `OpeningBalances.tsx`; `grep -rn "OpeningBalances" src` → no matches outside the new components.
- [ ] **Step 4: Verify**:
  - `bun run typecheck` and `bun run lint` → no errors.
  - Full suite, one file at a time:
    ```bash
    for f in tests/unit/*.test.ts tests/db/*.test.mjs; do TZ=UTC node --test "$f" > /tmp/t.log 2>&1 || echo "FAIL $f"; done
    ```
    → no FAIL lines.
  - `bun run dev` on port 3001: the society page and the professional page compile and render without console errors.
- [ ] **Step 5: Commit** — `feat(society): Approvals screen for the opening balance and CA adjustments; opening balance leaves Society Rules`.
