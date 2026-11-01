# Phase 2A — Groups & Ledgers: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every society a Tally-style chart of accounts — fixed primary groups, CA-created sub-groups and ledgers — that the CA/accountant manages, and make the app's rules, reports and Tally export follow the chart instead of hard-coded account codes.

**Architecture:** A new `account_groups` table holds 7 fixed primary groups and 7 system sub-groups per society; every `accounts` row (a "ledger") gets a `group_id`, an `is_active` flag and keeps its immutable `code`. All chart changes go through SECURITY DEFINER RPCs gated by a new professional permission `manage_accounts`. Rules that listed codes (billing-rule credit accounts, adjustment blocking, "what counts as cash") now ask which group a ledger is in. Reports keep their SQL functions; the UI groups their rows using a `chart_of_accounts()` RPC and a pure `src/lib/chart.ts` helper.

**Tech Stack:** Supabase Postgres (plpgsql, RLS), PGlite DB tests (`node --test`), Next.js 15 / React 19 / TypeScript, lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-10-31-sahvaas-simplify-design.md`, section 7.1 (plus the `manage_accounts` call in 7.4).

## Sub-plan split (Phase 2)

| Plan | Scope |
|---|---|
| **2A (this plan)** | Groups, ledgers, CA screen, data-driven rules, group-wise reports and Tally export |
| 2B | Several bank accounts (default receiving/paying bank, per-bank postings and reconciliation), bill types → ledger mapping and the "Other" TDS question, vendor and flat party ledgers |
| 2C | Opening balance in the CA login (two dates, draft → approval), CA authority and Approvals, committee "Accountant" role, Fixed Assets / Bank Reconciliation / Year close moved to the CA login, asset register on CA-created fixed-asset ledgers with depreciation rates |
| 2D | Owner change and ownership history |

## Global Constraints

- New migrations only: `019_account_groups.sql`, `020_ledger_management.sql`, `021_ledger_rules.sql`. Never edit `001`–`018`. Regenerate the bundle with `bun run db:bundle` after each.
- **Account codes never change once created.** `prior_year_balances` and every posting refer to codes. CA-created ledgers get a generated code: the nature digit (asset `1`, liability `2`, equity `3`, income `4`, expense `5`), then `C`, then a 3-digit sequence per nature (`1C001`, `1C002`, `5C001`). These codes are at most 5 characters, which fits `billing_rules.account_code VARCHAR(8)`.
- **Ledgers are never deleted**, only deactivated, and only when their balance is zero.
- **Only the CA / accountant** (professional permission `manage_accounts`) and the platform owner change groups and ledgers. The secretary and committee never do. The committee "Accountant" role is 2C.
- **Primary groups** are fixed: their names, natures and places cannot change.
- **System ledgers** (the 33 defaults, `is_system = true`) can be renamed only.
- All UI text is English.
- Work on branch `phase-2a-groups-ledgers`. Commit per task. Never push.
- Tests on this machine (low RAM): run DB test files one at a time with `TZ=UTC node --test tests/db/<file>`. The full-suite check runs every file in `tests/unit` and `tests/db` individually.
- The live database changes only when the user runs `bun run db:migrate --apply`.

## Review Focus

1. **Societies that already exist** (the live DB was created on 001–018): after 019 every existing ledger has a group, no posting changes and no report total moves. Pinned in Task 1 (`upgrade from 018`).
2. **Deleting a society still works, deleting a used ledger never does.** Today `ledger_entries.account_id` cascades, so a ledger delete silently erases postings. Pinned in Task 1.
3. **A CA-created bank ledger and a transfer between two banks** — Receipts & Payments must treat both as cash: no receipt, no payment, both in opening/closing. Pinned in Task 3.
4. **A report row whose code is missing from the chart** (data drift) — it must appear under "Unclassified", never be dropped from the totals. Pinned in Task 4 (unit test).
5. **Code generation with gaps or a manually inserted code** — the next CA ledger takes max+1 for its nature and never collides. Pinned in Task 2.

---

### Task 1: Groups table, ledger columns, permission, safety

**Files:**
- Create: `src/db/migrations/019_account_groups.sql`
- Modify: `src/lib/professional-permissions.ts:4-36` (new key, presets)
- Modify: `src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql` (regenerated)
- Test: `tests/db/chart-of-accounts.test.mjs` (new)

**Interfaces:**
- Produces (SQL, all `SECURITY DEFINER SET search_path = public`):
  - table `account_groups(id UUID PK, society_id UUID NOT NULL → societies ON DELETE CASCADE, parent_id UUID NULL → account_groups, name VARCHAR(128) NOT NULL, nature VARCHAR(16) NOT NULL CHECK IN ('asset','liability','equity','income','expense'), system_key VARCHAR(32) NULL, sort_order INT NOT NULL DEFAULT 100, created_at TIMESTAMPTZ)`, `UNIQUE(society_id, system_key)`, unique index on `(society_id, lower(name))`.
  - `accounts` gains `group_id UUID NOT NULL → account_groups`, `is_active BOOLEAN NOT NULL DEFAULT true`, `updated_at TIMESTAMPTZ`, and a unique index on `(society_id, lower(name))`.
  - `ensure_account_groups(p_society_id UUID) RETURNS VOID`: idempotent; revoked from `PUBLIC, anon, authenticated`.
  - `account_group_key(p_group_id UUID) RETURNS TEXT`: nearest `system_key` walking up from the group itself (a CA sub-group under Bank Accounts → `'bank_accounts'`).
  - `default_account_group(p_society_id UUID, p_code TEXT, p_type TEXT) RETURNS UUID`.
  - `can_manage_accounts(p_society_id UUID) RETURNS BOOLEAN` = `is_platform_admin() OR has_professional_permission(p_society_id, 'manage_accounts')`.
  - `valid_professional_permissions(p JSONB)` also accepts `'manage_accounts'`.
- Produces (TS): `PROFESSIONAL_PERMISSIONS` gains `{ key: 'manage_accounts', label: 'Manage accounts', hint: 'Groups, ledgers and opening balance' }`; `ROLE_PRESETS.ca` and `ROLE_PRESETS.accountant` include it.

Groups created per society by `ensure_account_groups`:

| system_key | name | nature | parent | sort |
|---|---|---|---|---|
| capital_funds | Capital & Funds | equity | — | 10 |
| current_liabilities | Current Liabilities | liability | — | 20 |
| sundry_creditors | Sundry Creditors | liability | current_liabilities | 21 |
| duties_taxes | Duties & Taxes | liability | current_liabilities | 22 |
| member_advances | Advances from Members | liability | current_liabilities | 23 |
| fixed_assets | Fixed Assets | asset | — | 30 |
| investments | Investments | asset | — | 40 |
| current_assets | Current Assets | asset | — | 50 |
| bank_accounts | Bank Accounts | asset | current_assets | 51 |
| cash_in_hand | Cash-in-Hand | asset | current_assets | 52 |
| members_dues | Members' Dues | asset | current_assets | 53 |
| loans_advances | Loans & Advances | asset | current_assets | 54 |
| income | Income | income | — | 60 |
| expenses | Expenses | expense | — | 70 |

Default ledger → group (`default_account_group`):
- 1000 → `bank_accounts`
- 1100 → `cash_in_hand`
- 1200 → `members_dues`
- 1300, 1400 → `loans_advances`
- codes matching `^15\d\d$` (including 1590) → `fixed_assets`
- 2000 → `sundry_creditors`
- 2100, 2200 → `duties_taxes`
- 2300 → `member_advances`
- anything else by type: asset → `current_assets`, liability → `current_liabilities`, equity → `capital_funds`, income → `income`, expense → `expenses`

- [ ] **Step 1: Create the branch**

Run: `git switch -c phase-2a-groups-ledgers`
Expected: `Switched to a new branch 'phase-2a-groups-ledgers'`

- [ ] **Step 2: Write the failing tests** in `tests/db/chart-of-accounts.test.mjs`

Use the setup pattern of `tests/db/ca-workspace.test.mjs`: secretary creates a society, a resident joins, and a CA accepts an invite with `["view_reports","manage_accounts"]`. In the same `before`, a second professional accepts with `["view_ledger"]` only. Tests:
- `'every society gets 7 primary groups and 7 system sub-groups, and each default ledger sits in its group'`
  - 14 rows in `account_groups` for the society
  - group `system_key` of 1000 = `bank_accounts`, 1590 = `fixed_assets`, 2200 = `duties_taxes`, 3000 = `capital_funds`, 5100 = `expenses`
  - `count(*) WHERE group_id IS NULL` = 0
- `'a ledger’s nature must match its group'` (superuser): inserting `('9999','X','expense', <bank_accounts group>)` rejects with `/nature must match its group/`.
- `'a ledger with postings cannot be deleted; a society still can be'` (superuser):
  - after one posting to 1000 (insert a payment the way `tests/db/ledger.test.mjs` does), `DELETE FROM accounts WHERE code='1000'` rejects with `/foreign key/`
  - `DELETE FROM societies WHERE id=<a second throwaway society with a posting>` succeeds
- `'residents cannot read the chart; a view_ledger professional can'`:
  - resident `SELECT count(*) FROM accounts` = 0 and `FROM account_groups` = 0
  - view_ledger professional: accounts = 33, groups = 14
- `'manage_accounts is a valid professional permission'`: an invite insert with `["manage_accounts"]` succeeds.
- `'upgrade from 018 puts every existing ledger in a group'`:
  - `createDb({ upTo: '018' })`, create a society with a posting, then `applyMigration(db, '019_account_groups.sql')`
  - no `accounts.group_id` is NULL; the trial balance before and after is deep-equal

- [ ] **Step 3: Run and see them fail**

Run: `TZ=UTC node --test tests/db/chart-of-accounts.test.mjs`
Expected: FAIL. `relation "account_groups" does not exist` and the manage_accounts invite violates `chk_invite_permissions`.

- [ ] **Step 4: Write `019_account_groups.sql`**

In this order:
1. The table and helpers listed in Interfaces.
2. `ALTER TABLE accounts ADD COLUMN …`, with `group_id` nullable for now.
3. A BEFORE INSERT OR UPDATE trigger `trg_account_group` on `accounts`:
   - if `group_id` is NULL, call `ensure_account_groups` and set it from `default_account_group`;
   - then raise `'Ledger nature must match its group'` if the group's `nature <> NEW.type` or the group belongs to another society;
   - set `updated_at` on UPDATE.
4. Backfill: `ensure_account_groups` for every society, then fill `group_id`, then `ALTER COLUMN group_id SET NOT NULL`.
5. The unique name indexes.
6. Replace the FK on `ledger_entries.account_id`: drop it by looking up its name in `pg_constraint`, then add `fk_ledger_entries_account … REFERENCES accounts(id)` with no `ON DELETE` action (NO ACTION, so a society delete that also cascades `ledger_entries` still passes).
7. Replace `valid_professional_permissions` with the 10 keys from `009` plus `'manage_accounts'`.
8. RLS:
   - drop `accounts_admin_write` (no client writes);
   - replace `accounts_select` with `USING (is_platform_admin() OR is_society_admin(society_id) OR can_view_financials(society_id) OR can_manage_accounts(society_id))`;
   - enable RLS on `account_groups` with a SELECT policy using the same expression;
   - no INSERT, UPDATE or DELETE policies on either table.
9. Header comment in the style of `018`.

Also add the key and presets in `src/lib/professional-permissions.ts`.

- [ ] **Step 5: Bundle and run**

Run: `bun run db:bundle && TZ=UTC node --test tests/db/chart-of-accounts.test.mjs`
Expected: all pass.

- [ ] **Step 6: Check nothing else broke**

Run, one at a time: `TZ=UTC node --test tests/db/onboarding.test.mjs`, then `accounting.test.mjs`, `ledger.test.mjs`, `ca-workspace.test.mjs`, `launch.test.mjs` and `consolidated.test.mjs`.
Expected: each `ℹ fail 0`. These pin the 33-account chart and the opening balance, which reads codes.

- [ ] **Step 7: Commit**

```bash
git add src/db/migrations/019_account_groups.sql src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql src/lib/professional-permissions.ts tests/db/chart-of-accounts.test.mjs
git commit -m "feat(accounts): Tally-style groups for every ledger; manage_accounts permission; ledgers with postings can't be deleted"
```

---

### Task 2: CA chart management RPCs

**Files:**
- Create: `src/db/migrations/020_ledger_management.sql`
- Modify: `src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql` (regenerated)
- Test: `tests/db/chart-of-accounts.test.mjs` (add tests)

**Interfaces:**
- Consumes: Task 1 (`account_groups`, `account_group_key`, `can_manage_accounts`).
- Produces (all raise `'Only the society''s CA or accountant can change groups and ledgers'` unless `can_manage_accounts`):
  - `create_account_group(p_society_id UUID, p_parent_id UUID, p_name TEXT) RETURNS UUID`
    - The parent must belong to the society.
    - Nature is inherited from the parent.
    - The trimmed name must be 2–128 characters.
  - `update_account_group(p_group_id UUID, p_name TEXT, p_parent_id UUID) RETURNS VOID`
    - Primary groups (`parent_id IS NULL`) raise `'Primary groups cannot be changed'`.
    - System sub-groups can be renamed but not moved.
    - CA groups can be renamed or moved under a group of the same nature, but not inside themselves (`'A group cannot move inside itself'`).
  - `group_allows_ledgers(p_group_id UUID) RETURNS BOOLEAN`: false when `account_group_key` is one of `members_dues`, `sundry_creditors`, `member_advances` or `duties_taxes`.
  - `create_ledger(p_society_id UUID, p_group_id UUID, p_name TEXT) RETURNS TEXT` (the new code)
    - Refuses a group where `group_allows_ledgers` is false, with `'Ledgers in % are created by Sahvaas automatically'` (the group name).
    - The code is the nature digit + `C` + `lpad(max+1, 3, '0')` over existing `^<digit>C\d{3}$` codes, generated under `SELECT … FROM societies WHERE id = p_society_id FOR UPDATE`.
    - Sets `is_system = false`, and `type` = the group's nature.
  - `update_ledger(p_society_id UUID, p_code TEXT, p_name TEXT, p_group_id UUID) RETURNS VOID`
    - A NULL argument means "unchanged".
    - System ledgers: rename only; moving raises `'Sahvaas posts to this ledger automatically — you can rename it but not move it'`.
    - Other ledgers move only to a group of the same nature where `group_allows_ledgers` is true; otherwise `'A ledger can only move to a group of the same nature'`.
  - `set_ledger_active(p_society_id UUID, p_code TEXT, p_active BOOLEAN) RETURNS VOID`
    - System ledgers raise `'This ledger cannot be deactivated'`.
    - Deactivating raises `'Move its balance to another ledger first'` when the balance is not 0.
    - It also raises `'A maintenance charge uses this ledger'` when an active `billing_rules` row points to it.
  - `chart_of_accounts(p_society_id UUID) RETURNS JSONB` = `{ groups: [{id, parent_id, name, nature, system_key, sort_order, allows_ledgers}], ledgers: [{code, name, nature, group_id, is_system, is_active, balance, adjustable}] }`
    - Allowed for `can_view_financials OR can_manage_accounts`; anyone else gets `'You do not have access to this society''s accounts'`.
    - `adjustable` = `NOT adjustment_blocked_code(code)` for now; Task 3 replaces it.
  - `post_journal(...)`: same signature and body as `007_ledger.sql:63-131`, plus `'Ledger % is inactive'` when a line's account has `is_active = false`.

- [ ] **Step 1: Write the failing tests** (append to `chart-of-accounts.test.mjs`)

- `'the CA creates a sub-group and ledgers; codes follow the nature'`:
  - group `'FDs'` under `investments` → nature `asset`
  - ledger `'SBI FD 2026'` in it → `'1C001'`, then `'HDFC FD'` → `'1C002'`
  - ledger `'Lift AMC'` in Expenses → `'5C001'`
- `'the next code skips a manually inserted one'`: superuser inserts `('1C007','Manual','asset', <current_assets group>, is_system false)`; the next asset ledger is `'1C008'`.
- `'the secretary and a view_ledger professional cannot change the chart'`: both `create_ledger` calls reject with `/CA or accountant/`.
- `'duplicate names are refused'`: a second `'Lift AMC'` → `/duplicate key|already exists/`.
- `'ledgers cannot be created in automatic groups'`: in Sundry Creditors → `/created by Sahvaas automatically/`.
- `'system ledgers can be renamed, not moved or deactivated'`:
  - `update_ledger('1000','HDFC Savings',NULL)` succeeds;
  - moving 1000 rejects `/rename it but not move it/`;
  - `set_ledger_active('1000', false)` rejects `/cannot be deactivated/`.
- `'a ledger moves only within its nature'`: `'1C001'` → Expenses rejects `/same nature/`.
- `'deactivation needs a zero balance; inactive ledgers take no postings'`:
  - give `'5C001'` a balance with `post_journal` as superuser; deactivating rejects `/Move its balance/`;
  - deactivate a zero-balance ledger;
  - `post_journal` to it rejects `/is inactive/`.
- `'primary groups are fixed; a group cannot move inside itself'`.
- `'the committee reads the chart; residents cannot'`:
  - `chart_of_accounts` as the secretary has 14+ groups, and each ledger has `group_id` and `adjustable`;
  - as the resident it rejects `/do not have access/`.

- [ ] **Step 2: Run and see them fail**

Run: `TZ=UTC node --test tests/db/chart-of-accounts.test.mjs`
Expected: the new tests FAIL with `function public.create_account_group(...) does not exist`; Task 1 tests still pass.

- [ ] **Step 3: Write `020_ledger_management.sql`** with the functions above.

Grant EXECUTE to `authenticated` on the six client RPCs: `create_account_group`, `update_account_group`, `create_ledger`, `update_ledger`, `set_ledger_active`, `chart_of_accounts`. Keep `post_journal` revoked, as in `007`.

- [ ] **Step 4: Bundle and run**

Run: `bun run db:bundle && TZ=UTC node --test tests/db/chart-of-accounts.test.mjs`
Expected: all pass.

- [ ] **Step 5: Regression for `post_journal`**

Run, one at a time: `TZ=UTC node --test tests/db/ledger.test.mjs`, then `ledger-backfill.test.mjs`, `accounting.test.mjs`, `integrity.test.mjs`, `operations.test.mjs`.
Expected: each `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/020_ledger_management.sql src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql tests/db/chart-of-accounts.test.mjs
git commit -m "feat(accounts): CA creates, renames, moves and deactivates groups and ledgers"
```

---

### Task 3: Rules follow the chart, not code lists

**Files:**
- Create: `src/db/migrations/021_ledger_rules.sql`
- Modify: `src/components/AdjustmentsPanel.tsx:30,67,162` (drop `BLOCKED`; list ledgers from `chart_of_accounts` where `is_active && adjustable`)
- Modify: `src/views/society/tabs/BillingTab.tsx:28-35,298-299` (credit-account options from `chart_of_accounts`: active ledgers of nature `income` or `equity`)
- Modify: `src/types/database.ts:324-325` (`BillingRule.account_code: string`)
- Modify: `src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql` (regenerated)
- Test: `tests/db/chart-of-accounts.test.mjs` (add tests)

**Interfaces:**
- Consumes: Task 1 (`account_group_key`), Task 2 (`create_ledger`, `chart_of_accounts`).
- Produces:
  - `ledger_blocked_for_adjustment(p_society_id UUID, p_code TEXT) RETURNS BOOLEAN`: true when the ledger is inactive, or its code is in `('1200','2000','2300','1590')`, or `account_group_key(group_id)` is in `('fixed_assets','members_dues','sundry_creditors','member_advances')`. This blocks everything `adjustment_blocked_code` blocks today, plus CA ledgers in those groups.
  - `validate_adjustment_lines` (latest body at `014_ca_workspace.sql:411`), with the code-list check replaced by `ledger_blocked_for_adjustment(p_society_id, code)`. The existing error message stays word-for-word, because `ca-workspace.test.mjs:122` expects it.
  - `chart_of_accounts`: `adjustable` = `NOT ledger_blocked_for_adjustment(...)`.
  - `billing_rules`:
    - drop `chk_billing_rules_account_code`;
    - add a BEFORE INSERT OR UPDATE trigger `trg_billing_rule_account` that raises `'Maintenance charges can only go to an active income or fund ledger'` unless the code is an active ledger of the society with type `income` or `equity`.
  - `receipts_payments` (latest at `014_ca_workspace.sql:216`): "cash" = ledgers whose `account_group_key` is `bank_accounts` or `cash_in_hand`, instead of `code IN ('1000','1100')`. Same signature and columns.

- [ ] **Step 1: Write the failing tests**

- `'maintenance charges can post to a CA-created income ledger'`:
  - CA creates `'Parking Charges'` in Income (`'4C001'`);
  - the secretary inserts a billing rule with `account_code '4C001'`, rate 500, 0% GST;
  - issue bills the way `tests/db/ledger.test.mjs` does;
  - the `'4C001'` balance = −500 × flats.
- `'a maintenance charge cannot go to an expense or inactive ledger'`: a rule on `'5100'` → `/active income or fund ledger/`.
- `'adjustments follow the groups'`:
  - CA ledger `'Lift (old)'` in Fixed Assets → `propose_adjustment` touching it rejects with the existing blocked message;
  - an adjustment between `'5C001'` and `'5900'` is accepted.
- `'a transfer between two banks is neither a receipt nor a payment'`:
  - CA creates `'HDFC Savings'` in Bank Accounts;
  - an approved adjustment moves 1,000 from 1000 to it (`propose_adjustment` then `decide_adjustment` by the treasurer, as in `ca-workspace.test.mjs`);
  - `receipts_payments` for the period has no `receipt` or `payment` row for either ledger;
  - the `closing` rows include the new code;
  - the closing total is unchanged.

- [ ] **Step 2: Run and see them fail**

Run: `TZ=UTC node --test tests/db/chart-of-accounts.test.mjs`
Expected: FAIL. The billing rule violates `chk_billing_rules_account_code`, the Fixed Assets CA ledger is not blocked, and the transfer shows as a payment/receipt.

- [ ] **Step 3: Write `021_ledger_rules.sql`**, and change the TS files listed above.

- [ ] **Step 4: Bundle and run**

Run: `bun run db:bundle && TZ=UTC node --test tests/db/chart-of-accounts.test.mjs`
Expected: all pass.

- [ ] **Step 5: Regression**

Run, one at a time: `TZ=UTC node --test tests/db/ca-workspace.test.mjs`, then `ledger.test.mjs`, `launch.test.mjs`, `bank-reconciliation.test.mjs`. Then `bun run typecheck`.
Expected: each `ℹ fail 0`; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/021_ledger_rules.sql src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql tests/db/chart-of-accounts.test.mjs src/components/AdjustmentsPanel.tsx src/views/society/tabs/BillingTab.tsx src/types/database.ts
git commit -m "feat(accounts): billing charges, adjustments and cash in Receipts & Payments follow the chart"
```

---

### Task 4: Group-wise reports and Tally groups

**Files:**
- Create: `src/lib/chart.ts`
- Create: `tests/unit/chart.test.ts`
- Modify: `src/lib/tally-xml.ts` (whole file), `tests/unit/tally-xml.test.ts`
- Modify: `src/components/FinancialReports.tsx:91,150-172,234-243,311-329,355` (load `chart_of_accounts`; render I&E, Balance Sheet and Trial Balance by group; Tally export call)

**Interfaces:**
- Consumes: `chart_of_accounts` JSON from Task 2/3.
- Produces in `src/lib/chart.ts`:

```ts
export type Nature = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export interface ChartGroup { id: string; parent_id: string | null; name: string; nature: Nature; system_key: string | null; sort_order: number; allows_ledgers: boolean }
export interface ChartLedger { code: string; name: string; nature: Nature; group_id: string; is_system: boolean; is_active: boolean; balance: number; adjustable: boolean }
export interface Chart { groups: ChartGroup[]; ledgers: ChartLedger[] }
export interface GroupNode<T> { group: ChartGroup; rows: T[]; children: GroupNode<T>[]; total: number }
/** Primary groups in sort_order with nested sub-groups; empty branches pruned; rows whose code is not in the chart go under a synthetic primary group named "Unclassified" (id 'unclassified', last). */
export function groupTree<T extends { code: string }>(chart: Chart, rows: T[], amount: (row: T) => number): GroupNode<T>[];
```

- Produces in `src/lib/tally-xml.ts`: `tallyParentName(chart: Chart, groupId: string): string` and `buildTallyXml(company: string, chart: Chart, journals: TallyJournal[]): string`. Remove the old `tallyGroup(code, type)` and `TallyLedger`.

Tally mapping by `system_key`:

| system_key | Tally group |
|---|---|
| capital_funds | Reserves & Surplus |
| current_liabilities | Current Liabilities |
| sundry_creditors | Sundry Creditors |
| duties_taxes | Duties & Taxes |
| fixed_assets | Fixed Assets |
| investments | Investments |
| current_assets | Current Assets |
| bank_accounts | Bank Accounts |
| cash_in_hand | Cash-in-Hand |
| members_dues | Sundry Debtors |
| loans_advances | Loans & Advances (Asset) |
| income | Indirect Incomes |
| expenses | Indirect Expenses |

`member_advances` and every CA sub-group are emitted as `<GROUP>` masters with their own name, `PARENT` set to the parent's Tally name, before the ledger masters.

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/chart.test.ts`, using a small chart fixture (two primary groups, one sub-group, three ledgers):
- `groupTree` nests a sub-group under its primary group;
- totals roll up (child total included in the parent total);
- empty groups are pruned;
- a row with code `'9999'` lands in `'Unclassified'` and counts in its total.

`tests/unit/tally-xml.test.ts`, rewritten to the new signature:
- the old expectations still hold: 1000 → Bank Accounts, 1540 → Fixed Assets, 2200 → Duties & Taxes, 3000 → Reserves & Surplus, 5100 → Indirect Expenses, and signs, escaping and unused-ledger skipping are unchanged;
- a CA sub-group `'FDs'` under Investments is emitted as `<GROUP NAME="FDs">` with `<PARENT>Investments</PARENT>`, before a ledger `'SBI FD'` whose `PARENT` is `FDs`.

- [ ] **Step 2: Run and see them fail**

Run: `node --test tests/unit/chart.test.ts tests/unit/tally-xml.test.ts`
Expected: FAIL. `chart.ts` is missing and `buildTallyXml` has the wrong arity.

- [ ] **Step 3: Implement `src/lib/chart.ts` and the new `tally-xml.ts`**

- [ ] **Step 4: Run and see them pass**

Run: `node --test tests/unit/chart.test.ts tests/unit/tally-xml.test.ts`
Expected: all pass.

- [ ] **Step 5: Use them in `FinancialReports.tsx`**

- Load `chart_of_accounts` next to the existing account load.
- I&E: Income and Expenditure sections are rendered with `groupTree`.
- Balance Sheet:
  - Liabilities side: Capital & Funds, Current Liabilities and the existing I&E surplus line.
  - Assets side: Fixed Assets (1590 Accumulated Depreciation appears inside it as a negative line), Investments and Current Assets.
  - Each group shows a subtotal.
- Trial Balance: grouped by primary group with subtotals.
- The Tally export passes the chart.
- The SQL report functions are unchanged.

- [ ] **Step 6: Static checks**

Run: `bun run typecheck && npx eslint src/lib/chart.ts src/lib/tally-xml.ts src/components/FinancialReports.tsx`
Expected: exit 0, no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/chart.ts src/lib/tally-xml.ts tests/unit/chart.test.ts tests/unit/tally-xml.test.ts src/components/FinancialReports.tsx
git commit -m "feat(reports): balance sheet, I&E and trial balance by group; Tally export emits groups"
```

---

### Task 5: "Groups & Ledgers" screen in the CA login

**Files:**
- Create: `src/components/ChartOfAccounts.tsx`
- Modify: `src/views/professional/ProfessionalDashboardPage.tsx:20,28-33,61-68` (tab `'ledgers'`, label `'Groups & Ledgers'`, lucide icon `ListTree`)

**Interfaces:**
- Consumes: the RPCs from Task 2 and `Chart` / `groupTree` from Task 4.
- Produces: `ChartOfAccounts: React.FC<{ societyId: string; canManage: boolean }>`.

- [ ] **Step 1: Build `ChartOfAccounts.tsx`**

- A tree of groups with each ledger's name, code and balance (`formatINR`).
- Inactive ledgers are greyed and labelled "Inactive".
- When `canManage`:
  - **Add group** under any group;
  - **Add ledger** in groups where `allows_ledgers` is true; the others show "Created automatically";
  - **Rename** for every ledger and every non-primary group;
  - **Move** for CA ledgers and CA groups, with a group picker limited to the same nature;
  - **Deactivate / Activate** for non-system ledgers.
- Errors from the RPCs are shown with the existing `Banner` component, as in `PlanBilling.tsx`. Reload `chart_of_accounts` after each change.
- Follow the dark styling of the other professional tabs.

- [ ] **Step 2: Add the tab**

- Visible when the grant has `manage_accounts`, `view_reports` or `view_ledger`.
- `canManage` = the grant includes `manage_accounts`.

- [ ] **Step 3: Static checks**

Run: `bun run typecheck && npx eslint src/components/ChartOfAccounts.tsx src/views/professional/ProfessionalDashboardPage.tsx`
Expected: exit 0, no errors.

- [ ] **Step 4: Full verification**

Run every test file individually: `TZ=UTC node --test <file>` for each of `tests/unit/*.test.ts` and `tests/db/*.test.mjs`.
Expected: every file `ℹ fail 0`. The total is the 163 tests from before plus the new chart, unit and Tally tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/ChartOfAccounts.tsx src/views/professional/ProfessionalDashboardPage.tsx
git commit -m "feat(ca): Groups & Ledgers screen in the CA login"
```

- [ ] **Step 6: Live database (only after the user says go)**

The user runs `bun run db:migrate --apply`; the dry run beforehand should list `019`, `020` and `021`. Then verify with read-only queries:
- every `accounts.group_id` is set;
- 14 groups per society;
- `_sahvaas_migrations` has 019–021.
