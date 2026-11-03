# Phase 2B — Banks, Bill Types and Party Ledgers: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** This plan delivers three things:
- A society can keep several bank accounts. The CA sets a default bank for receipts and one for payments, and the secretary can choose "Received in / Paid from".
- The CA maps each bill type to a ledger. TDS still follows the bill type, and "Other" bills ask one plain question to decide it.
- The CA sees vendor-wise and flat-wise ledgers that add up exactly to Sundry Creditors and Members' dues.

**Architecture:**
- **Banks.** A bank is any active ledger in the Bank Accounts group.
  - Resident receipts, vendor payments and TDS deposits record the bank ledger they went through (`bank_ledger_id`) and post there.
  - When nothing is chosen they use the CA's default receiving or paying bank, which falls back to `1000`.
  - Each bank statement account (`bank_accounts`) belongs to one bank ledger. Reconciliation balances and matches per ledger.
- **Bill types.** They stay in `expense_categories`, where a society's own row overrides the Sahvaas default. Only CA RPCs write society rows. Everyone reads one merged list through `bill_types()`.
- **Party ledgers.** These are not `accounts` rows.
  - Every line on `1200`, `2300` and `2000` is credited to a flat or a vendor through its journal's reference: the bill, payment, expense or vendor payment behind it.
  - Lines with no flat or vendor behind them show as "Not linked", so party totals always equal the control ledgers.

**Tech Stack:** Supabase Postgres (plpgsql, RLS), PGlite DB tests (`node --test`), Next.js 15 / React 19 / TypeScript, lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-10-31-sahvaas-simplify-design.md`, section 7.1 ("Several bank accounts"), 7.2 and 7.3. 2A (`docs/superpowers/plans/2026-11-02-phase-2a-groups-ledgers.md`, migrations 019–021) is merged on `main`.

## Decisions (the user delegated these on 2026-11-03: "u decide the best")

- **Duties & Taxes:** the CA may create ledgers here (e.g. Professional Tax Payable, Labour Cess Payable). The app still posts GST to `2100` and TDS to `2200`.
- **Advances from Members** stays automatic. Flat advances come only from payments.
- **Fixed Assets:** no CA ledgers until 2C connects the asset register to CA ledgers. Its six system ledgers stay.
- **Postings that stay on `1000` in 2B:**
  - `dispose_asset` sale proceeds; they get a bank choice in 2C, when asset disposal moves to the CA login;
  - the legacy cash-basis `ledger_post_expense`, which only covers expenses recorded before accrual accounting.
- **When parties appear:**
  - A vendor appears in the vendor-wise list as soon as its vendor record exists, which happens with its first bill. A flat appears as soon as it exists.
  - Balances come only from posted entries: a bill counts once it is approved.
- **Tally export:**
  - Lines on `1200` go to one party ledger per flat under Sundry Debtors; lines on `2000` go to one party ledger per vendor under Sundry Creditors.
  - `2300` Advance Maintenance Received stays one ledger.
- **Moving earlier bills** after a bill type is re-pointed:
  - It becomes a pre-filled adjustment proposal that the committee approves. It needs approval because it changes posted entries (spec 7.5).
  - It covers only the current financial year.

## Global Constraints

- **Migrations:**
  - New migrations only: `022_bank_ledgers.sql`, `023_bank_statement_ledgers.sql`, `024_bill_types.sql`, `025_party_ledgers.sql`. Never edit `001`–`021`. Run `bun run db:bundle` after each.
  - A function redefined in a new migration is its latest body, copied verbatim from the migration named in the step, with only the stated change.
  - A function whose parameters change is first dropped by its old signature (`DROP FUNCTION IF EXISTS ...`), and its `REVOKE`/`GRANT` lines are repeated for the new signature.
- **The secretary never picks a ledger.**
  - A bank is chosen by its name. The choice is shown only when the society has more than one active bank ledger.
  - A bill type is chosen by its type name.
- **Only `manage_accounts`** (CA / accountant) and the platform owner change default banks and bill-type mapping. These RPCs start with `PERFORM require_manage_accounts(p_society_id)` (020) and write `audit_logs`.
- **Cash** stays on `1100` in every posting.
- **UI text:** English only.
- **Git:**
  - Work on branch `phase-2b-banks-bill-types-parties`. Commit per task with `git -c user.name=ved300406 -c user.email=ved300406@gmail.com commit ...`.
  - Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.
- **Tests:**
  - On this machine (low RAM), run each DB test file alone: `TZ=UTC node --test tests/db/<file>`.
  - The full-suite check runs every file in `tests/unit` and `tests/db` individually.
  - New tests take dates from `current_date` and `fy_start_of(current_date)` wherever the financial year matters.
- **Static checks:** `bun run typecheck` and `npx eslint <changed files>`.
- **Live database:** it changes only when the user runs `bun run db:migrate --apply`.

## Review Focus

1. **Existing societies after the upgrade.** With no default set, every receipt, vendor payment and TDS deposit still posts to `1000`, and existing tests do not change. Pinned in Task 1 (`until the CA chooses…`) and by the existing `bank-reconciliation`, `accounting` and `ledger` suites in Tasks 1–2.
2. **A payment matched on one bank's statement while another bank is picked.** The pick is refused. A payment matched on a statement posts to that statement's bank, even when it differs from the default. Pinned in Task 2 (`matching stays inside one bank`).
3. **Party totals tie to the control ledgers for every kind of event.** The events are: opening arrears, bill, payment with excess, advance applied, cancelled bill, vendor bill, partial payment with TDS, voided bill, voucher without a vendor, and an opening creditor that is not linked to any vendor. Pinned in Task 6 (two tie-out tests and a per-flat check against unpaid bills).
4. **Deactivating a ledger that is a default bank or a bill type's ledger** is refused with a reason. Pinned in Task 1.
5. **Re-pointing a bill type.** Bills approved after the change go to the new ledger; earlier ones stay until the committee approves the move; last year's bills are never moved. Pinned in Task 4.

---

### Task 1: Default banks, bank on every posting, chart decisions

**Files:**
- Create: `src/db/migrations/022_bank_ledgers.sql`
- Modify: `src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql` (regenerated)
- Test: `tests/db/bank-ledgers.test.mjs` (new)
- Modify: `tests/db/chart-of-accounts.test.mjs`: tests `ledgers cannot be created in automatic groups` and `adjustments follow the groups`

**Interfaces:**
- Produces:
  - **Table `society_bank_defaults`:**
    - Columns: `society_id UUID PK → societies ON DELETE CASCADE`, `receipt_account_id UUID NULL → accounts`, `payment_account_id UUID NULL → accounts`, `updated_by UUID → profiles`, `updated_at TIMESTAMPTZ`.
    - RLS on. One SELECT policy: `is_platform_admin() OR is_committee_viewer(society_id) OR can_view_financials(society_id) OR can_manage_accounts(society_id)`. No client writes.
  - **Internal helpers** (revoked from `PUBLIC, anon, authenticated`):
    - `is_bank_ledger(p_society_id UUID, p_account_id UUID) RETURNS BOOLEAN`: true when the ledger is in that society, active, and `account_group_key(group_id) = 'bank_accounts'`.
    - `default_bank_ledger(p_society_id UUID, p_kind TEXT) RETURNS UUID`: `p_kind` is `'receipt'` or `'payment'`. Returns the chosen default if `is_bank_ledger`, else the society's `1000` ledger.
  - **Client RPCs** (granted to `authenticated`):
    - `bank_ledgers(p_society_id UUID) RETURNS JSONB`
      - Returns `[{id, code, name, is_default_receipt, is_default_payment}]`: active bank ledgers, ordered by code.
      - Allowed for `is_committee_viewer OR can_view_financials OR can_manage_accounts OR has_professional_permission(…, 'view_bank_reconciliation')`. Anyone else gets 'You do not have access to this society''s accounts'.
    - `set_default_banks(p_society_id UUID, p_receipt_ledger_id UUID, p_payment_ledger_id UUID) RETURNS VOID`
      - Upserts `society_bank_defaults`.
      - Each id must pass `is_bank_ledger`, else 'Choose a bank ledger of this society'.
      - Writes audit `chart.default_banks`, entity_type `society`, with old and new `{receipt, payment}` ledger names.
    - `set_payment_bank(p_payment_id UUID, p_bank_ledger_id UUID) RETURNS VOID`. Only `is_society_admin`; otherwise 'Only the society committee can verify payments'. It refuses:
      - a cash payment: 'Cash payments go to Cash-in-Hand';
      - a payment that is not `pending_verification`: 'This payment is already in the books — ask your CA to move it';
      - a payment that a `bank_transactions` row points to: 'This payment is matched to a bank statement line — that bank decides';
      - a ledger that is not a bank ledger: 'Choose a bank ledger of this society'.
  - **Columns:**
    - `payments.bank_ledger_id`, `vendor_payments.bank_ledger_id` and `tds_challans.bank_ledger_id`, each `UUID NULL → accounts`.
    - Backfill, before the triggers exist: rows already posted with a non-cash method get their society's `1000` ledger. Those are verified payments whose `payment_method <> 'cash'`, vendor payments whose `mode <> 'cash'`, and every challan.
  - **Trigger `trg_payment_bank`** (BEFORE INSERT OR UPDATE on `payments`):
    - A non-NULL `bank_ledger_id` that changes must pass `is_bank_ledger`. Changing it when `OLD.status = 'verified'` raises the "already in the books" message.
    - When the row becomes `verified`, is not cash and has no bank, fill it with `default_bank_ledger(society, 'receipt')`.
    - Task 2 redefines this trigger to look at statement accounts first.
  - **Trigger `trg_bank_ledger_default`** (BEFORE INSERT) on `vendor_payments` (non-cash rows only) and on `tds_challans`: fills a NULL `bank_ledger_id` with `default_bank_ledger(society, 'payment')`.
  - **Posting changes:**
    - `ledger_post_payment` (007 body): the non-cash debit uses the code of `bank_ledger_id`.
    - `record_vendor_payment` (013 body):
      - takes a new last parameter `p_bank_ledger_id UUID DEFAULT NULL`;
      - for a non-cash payment, a chosen ledger must pass `is_bank_ledger`, and an empty one uses `default_bank_ledger(…, 'payment')`;
      - stores the ledger in `vendor_payments.bank_ledger_id` and credits its code;
      - for cash, stores NULL and posts `1100`.
    - `record_tds_challan` (013 body): takes a new last parameter `p_bank_ledger_id UUID DEFAULT NULL` and follows the same rule as vendor payments.
  - **Chart changes:**
    - `group_allows_ledgers` (020) returns false for the keys `members_dues`, `sundry_creditors`, `member_advances` and `fixed_assets`. `duties_taxes` now allows CA ledgers.
    - `set_ledger_active` (020 body) adds two checks when deactivating:
      - 'This ledger is a default bank — choose another default bank first';
      - 'A bill type uses this ledger — point the bill type to another ledger first'. This fires when an active `expense_categories` row with `society_id = p_society_id` has `account_code = p_code`.

- [ ] **Step 1: Update the two 2A tests the chart decisions change**

In `tests/db/chart-of-accounts.test.mjs`:
- `ledgers cannot be created in automatic groups`:
  - creates its sub-group under `members_dues` (name `'Wing A dues'`) instead of `duties_taxes`;
  - also asserts that `createLedger(ids.ca, await groupId('fixed_assets'), 'Lift')` rejects with `/created by Sahvaas automatically/`.
- `adjustments follow the groups`: use the system ledger `'1510'` in place of the CA ledger `'Lift (old)'`. The proposal still rejects with `/kept by its own register/`, and `adj('1510')` is `false`.

- [ ] **Step 2: Write `tests/db/bank-ledgers.test.mjs`**

**Setup:**
- Copy `inviteProfessional` and `societyWithPosting` from `chart-of-accounts.test.mjs`. `societyWithPosting` verifies a 1180 payment before any default is set; keep its id as `ids.payment`.
- Add a CA with `['view_reports','manage_accounts']`.
- Add a vendor with PAN `'ABCPP1234K'`. Set `require_two_step_expense_approval = false`.
- Add an approved 5000 bill with `tds_amount` 100: the treasurer inserts it and the secretary approves it with `decide_expense`, as in `bank-reconciliation.test.mjs`.

**Helpers:**
```js
const bankCodes = async (type, refId) => (await db.query(
  `SELECT a.code FROM journal_entries j JOIN ledger_entries l ON l.journal_entry_id = j.id JOIN accounts a ON a.id = l.account_id
   WHERE j.reference_event_type = $1 AND j.reference_event_id = $2
     AND account_group_key(a.group_id) IN ('bank_accounts','cash_in_hand')`, [type, refId])).rows.map((r) => r.code);
const ledgerId = async (code) => (await db.query('SELECT id FROM accounts WHERE society_id=$1 AND code=$2', [ids.societyId, code])).rows[0].id;
const setDefaults = (user, receipt, payment) => q(user, 'SELECT public.set_default_banks($1,$2,$3)', [ids.societyId, receipt, payment]);
```
Also copy `q`, `val`, `groupId` and `createLedger(user, groupId, name)` (returns the new code) from `chart-of-accounts.test.mjs`.

**Tests:**
```js
test('until the CA chooses, every bank posting goes to 1000', async () => {
  assert.deepEqual(await bankCodes('payment.verified', ids.payment), ['1000']);
  const banks = await val(ids.secretary, 'SELECT public.bank_ledgers($1)', [ids.societyId]);
  assert.deepEqual(banks.map((b) => [b.code, b.is_default_receipt, b.is_default_payment]), [['1000', true, true]]);
  await assert.rejects(q(ids.resident, 'SELECT public.bank_ledgers($1)', [ids.societyId]), /do not have access/);
});

test('the CA sets default banks; only active bank ledgers qualify', async () => {
  // CA creates 'ICICI Current' in Bank Accounts → code '1C001'; ids.icici = its accounts.id; ids.b1000 = ledgerId('1000')
  await assert.rejects(setDefaults(ids.secretary, ids.icici, ids.b1000), /Only the society's CA or accountant/);
  await assert.rejects(setDefaults(ids.ca, await ledgerId('1300'), ids.b1000), /Choose a bank ledger of this society/);
  await setDefaults(ids.ca, ids.icici, ids.b1000);
  // bank_ledgers: 1C001 is_default_receipt, 1000 is_default_payment; one audit row with action 'chart.default_banks'
});

test('a verified payment goes to the bank the secretary picked, else the default receiving bank', async () => {
  // new pending payments as the resident: pA 1000 'UTR-A', pB 500 'UTR-B', pC 300 payment_method 'cash'
  // verify pA as treasurer → bankCodes = ['1C001']
  // set_payment_bank(pB, ids.b1000) as secretary, then verify → ['1000']
  // set_payment_bank(pC, …) rejects /Cash payments go to Cash-in-Hand/; verify pC → ['1100']
  // set_payment_bank(pA, ids.b1000) rejects /already in the books/
  // as resident rejects /Only the society committee/; with ledgerId('1300') rejects /Choose a bank ledger/
});

test('vendor payments and TDS deposits post to the chosen bank, else the default paying bank', async () => {
  // record_vendor_payment(bill, 1900, 100, 'neft', 'VENDREF001', NULL, NULL, NULL, ids.icici) → ['1C001'], vendor_payments.bank_ledger_id = ids.icici
  // record_vendor_payment(bill, 1000, 0, 'neft', 'VENDREF002') → ['1000']
  // record_vendor_payment(bill, 500, 0, 'cash') → ['1100'], bank_ledger_id NULL
  // the p_bank_ledger_id of ledger 1300 rejects /Choose a bank ledger/
  // record_tds_challan(society, 'CH-1', 100, current_date, current_date, '194C', NULL, ids.icici) → bankCodes('tds.deposited', id) = ['1C001']
});

test('a default bank or a bill type ledger cannot be deactivated', async () => {
  await assert.rejects(q(ids.ca, `SELECT public.set_ledger_active($1,'1C001',false)`, [ids.societyId]), /default bank/);
  // CA creates expense ledger 'Lift AMC' → '5C001'; as superuser insert expense_categories (society_id, key 'lift_amc', label 'Lift AMC', account_code '5C001', tds_nature 'contract')
  await assert.rejects(q(ids.ca, `SELECT public.set_ledger_active($1,'5C001',false)`, [ids.societyId]), /A bill type uses this ledger/);
});

test('CA ledgers can go in Duties & Taxes, not in Fixed Assets', async () => {
  // createLedger(duties_taxes, 'Professional Tax Payable') returns '2C001'
  // createLedger(fixed_assets, 'Lift') rejects /created by Sahvaas automatically/
  // chart_of_accounts: allows_ledgers is true for duties_taxes, false for fixed_assets and members_dues
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `TZ=UTC node --test tests/db/bank-ledgers.test.mjs`
Expected: FAIL. `bank_ledgers` does not exist.

- [ ] **Step 4: Write `022_bank_ledgers.sql` as described in Interfaces**

Order inside the file:
1. tables and columns;
2. backfill;
3. helpers;
4. triggers;
5. redefined functions (`ledger_post_payment`, `record_vendor_payment`, `record_tds_challan`, `group_allows_ledgers`, `set_ledger_active`);
6. new RPCs;
7. REVOKE / GRANT. Drop the old 8-argument `record_vendor_payment` and 7-argument `record_tds_challan`.

`mark_expense_paid` (013) calls `record_vendor_payment` with 6 positional arguments, which still resolves to the new function.

- [ ] **Step 5: Run the tests to see them pass**

Run: `bun run db:bundle && TZ=UTC node --test tests/db/bank-ledgers.test.mjs`, then `TZ=UTC node --test tests/db/chart-of-accounts.test.mjs`
Expected: both `ℹ fail 0`.

- [ ] **Step 6: Regression check**

Run, one at a time: `TZ=UTC node --test tests/db/bank-reconciliation.test.mjs`, then `accounting.test.mjs`, `ledger.test.mjs`, `operations.test.mjs`, `integrity.test.mjs`, `consolidated.test.mjs`.
Expected: each `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/db/migrations/022_bank_ledgers.sql src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql tests/db/bank-ledgers.test.mjs tests/db/chart-of-accounts.test.mjs
git commit -m "feat(accounts): default banks; receipts, vendor payments and TDS deposits post to the chosen bank ledger"
```

---

### Task 2: Bank reconciliation per bank ledger

**Files:**
- Create: `src/db/migrations/023_bank_statement_ledgers.sql`
- Modify: `src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql` (regenerated)
- Test: `tests/db/bank-ledgers.test.mjs` (append)

**Interfaces:**
- Consumes: `is_bank_ledger`, `default_bank_ledger`, `payments.bank_ledger_id`, `vendor_payments.bank_ledger_id` and `tds_challans.bank_ledger_id` from Task 1.
- Produces:
  - **`bank_accounts.ledger_id UUID NOT NULL → accounts`.**
    - Backfill: the society's `1000` ledger.
    - Trigger `trg_bank_account_ledger` (BEFORE INSERT OR UPDATE OF ledger_id):
      - fills NULL with `default_bank_ledger(society, 'receipt')`;
      - requires `is_bank_ledger`, else 'Choose a bank ledger of this society';
      - refuses to change the ledger once the account has `bank_transactions`: 'This account already has statement lines'.
  - **`trg_payment_bank`, redefined.** A verified non-cash payment with no bank takes the first of:
    1. the ledger of the statement account whose line points to it (`bank_transactions.reconciled_payment_id` → `bank_accounts.ledger_id`);
    2. the ledger of `NEW.bank_account_id`'s statement account (`record_bank_receipt` sets it);
    3. `default_bank_ledger(society, 'receipt')`.
  - **`bank_reconciliation_summary` (017 body):** `book_balance` is the balance of `v_acc.ledger_id` instead of code `1000`.
  - **`match_bank_lines` (017 body):** each line uses its own account's ledger (`v_ledger`). Candidates:
    - payments: `(p.bank_ledger_id = v_ledger OR (p.status = 'pending_verification' AND p.bank_ledger_id IS NULL))`;
    - vendor payments: `vp.bank_ledger_id = v_ledger`;
    - challans: `c.bank_ledger_id = v_ledger`.
  - **`link_bank_line` (017 body):** adds the same bank check, with clear messages:
    - payment: 'This payment is in % in the books — match it on that bank''s statement';
    - vendor payment or challan: 'This was paid from % in the books — match it on that bank''s statement';
    - cash vendor payment (`bank_ledger_id IS NULL`): 'This was paid in cash'.
    - `%` is the ledger's name.

- [ ] **Step 1: Append the failing tests**

Copy `setPlan` from `bank-reconciliation.test.mjs` and call `setPlan('pro')` first.

```js
Statement lines in the first two tests use descriptions that match nothing in the books, e.g. `'OPENING CHECK'`, credit 1.

test('each statement account belongs to one bank ledger', async () => {
  // ids.stmtIcici = INSERT bank_accounts (no ledger_id) → its ledger_id = ids.icici (the default receiving bank)
  // INSERT with ledger_id = ledgerId('1300') rejects /Choose a bank ledger of this society/
  // ids.stmt1000 = INSERT with ledger_id = ids.b1000 (another account_number)
});

test('the book balance is that bank ledger's own balance', async () => {
  // import one line dated current_date into each account, then check:
  // bank_reconciliation_summary(stmtIcici).book_balance = sum of ledger_entries on 1C001; the same for stmt1000 and 1000
  // UPDATE bank_accounts SET ledger_id = ids.b1000 WHERE id = stmtIcici rejects /already has statement lines/
});

test('matching stays inside one bank', async () => {
  // pending payment pX 777, UTR '998877665544', bank not chosen
  // import into stmt1000: credit 777 'UPI/998877665544/Flat 101', debit 1000 'NEFT/VENDREF002/Lift',
  //   debit 1900 'NEFT/VENDREF001/Lift', credit 1000 'NEFT-SHARMA', debit 500 'CASH WDL'
  // the 777 line → matched to pX; the VENDREF002 line → matched; the VENDREF001 line → still open (paid from ICICI Current)
  // set_payment_bank(pX, ids.icici) rejects /matched to a bank statement line/
  // link_bank_line(VENDREF001 line, 'vendor_payment', ICICI vendor payment) rejects /paid from ICICI Current in the books/
  // link_bank_line('NEFT-SHARMA' line, 'payment', pA, verified into ICICI) rejects /is in ICICI Current in the books/
  // link_bank_line('CASH WDL' line, 'vendor_payment', the cash vendor payment) rejects /paid in cash/
  // verify_matched_payments(society) → bankCodes('payment.verified', pX) = ['1000'], although the default receiving bank is ICICI
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `TZ=UTC node --test tests/db/bank-ledgers.test.mjs`
Expected: FAIL. Column `ledger_id` does not exist.

- [ ] **Step 3: Write `023_bank_statement_ledgers.sql` as described in Interfaces**

- [ ] **Step 4: Run the tests to see them pass**

Run: `bun run db:bundle && TZ=UTC node --test tests/db/bank-ledgers.test.mjs`
Expected: `ℹ fail 0`.

- [ ] **Step 5: Regression check**

Run, one at a time: `TZ=UTC node --test tests/db/bank-reconciliation.test.mjs`, then `chart-of-accounts.test.mjs` and `consolidated.test.mjs`.
Expected: each `ℹ fail 0`, with the 7 bank-reconciliation tests unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/023_bank_statement_ledgers.sql src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql tests/db/bank-ledgers.test.mjs
git commit -m "feat(bank): statement accounts belong to a bank ledger; balance and matching per bank"
```

---

### Task 3: Bank choices in the app

**Files:**
- Create: `src/lib/banks.ts`
- Modify: `src/components/ChartOfAccounts.tsx` (Default banks card)
- Modify: `src/views/society/tabs/PaymentsTab.tsx` (Received in)
- Modify: `src/views/society/tabs/ExpensesTab.tsx` (Paid from, for vendor payments and TDS deposits)
- Modify: `src/components/BankReconciliation.tsx` (bank ledger of a new statement account)

**Interfaces:**
- Consumes: `bank_ledgers`, `set_default_banks`, `set_payment_bank`, `record_vendor_payment(… p_bank_ledger_id)`, `record_tds_challan(… p_bank_ledger_id)` and `bank_accounts.ledger_id`.
- Produces, in `src/lib/banks.ts`:
  - `export interface BankLedger { id: string; code: string; name: string; is_default_receipt: boolean; is_default_payment: boolean }`
  - `export async function fetchBankLedgers(client: SupabaseClient, societyId: string): Promise<BankLedger[]>`
  - `export function defaultBankId(banks: BankLedger[], kind: 'receipt' | 'payment'): string | null`

- [ ] **Step 1: Write `src/lib/banks.ts`**

- [ ] **Step 2: Default banks card, in `ChartOfAccounts`**

- Placed above the tree. Title "Default banks".
- Two selects, "Money comes into" and "Bills are paid from", listing the bank ledgers by name.
- When `canManage`, a Save button calls `set_default_banks`. Otherwise both selects are read-only.
- Help line: "Add a ledger under Bank Accounts for each bank account first."

- [ ] **Step 3: Choices for the secretary**

Each select appears only when `banks.length > 1`.
- **PaymentsTab:**
  - For a non-cash payment, show a "Received in" select next to Verify. It defaults to the default receiving bank.
  - On Verify, call `set_payment_bank` and then `verify_payment`.
  - If `set_payment_bank` fails with the "matched to a bank statement line" message, skip it and verify anyway: the statement's bank decides.
- **ExpensesTab:**
  - In the pay form, show "Paid from" when the mode is not cash. It defaults to the default paying bank and is passed as `p_bank_ledger_id`.
  - Show "Paid from" in the TDS deposit form too.
- **BankReconciliation:**
  - The add-account form gets a "Bank in the books" select, which defaults to the first bank ledger that no statement account uses yet. Send it as `ledger_id`.
  - Each account in the list shows its ledger name.

- [ ] **Step 4: Static checks**

Run: `bun run typecheck && npx eslint src/lib/banks.ts src/components/ChartOfAccounts.tsx src/views/society/tabs/PaymentsTab.tsx src/views/society/tabs/ExpensesTab.tsx src/components/BankReconciliation.tsx`
Expected: exit 0, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/banks.ts src/components/ChartOfAccounts.tsx src/views/society/tabs/PaymentsTab.tsx src/views/society/tabs/ExpensesTab.tsx src/components/BankReconciliation.tsx
git commit -m "feat(bank): default banks for the CA; Received in / Paid from for the secretary"
```

---

### Task 4: Bill types the CA maps to ledgers

**Files:**
- Create: `src/db/migrations/024_bill_types.sql`
- Modify: `src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql` (regenerated)
- Test: `tests/db/bill-types.test.mjs` (new)

**Interfaces:**
- Consumes: `require_manage_accounts`, `create_ledger` (020); `propose_adjustment` and `decide_adjustment` (014); `fy_start_of`.
- Produces:
  - **RLS on `expense_categories`:**
    - The write policy becomes platform admin only, for any row. Society rows are written only by the RPCs below.
    - The select policy also allows `can_manage_accounts(society_id)`.
  - **Trigger `trg_bill_type_ledger`** (BEFORE INSERT OR UPDATE, rows with `society_id IS NOT NULL`): `account_code` must be an active ledger of that society with `type = 'expense'`, else 'A bill type can only point to an active expense ledger'.
  - **`bill_types(p_society_id UUID) RETURNS JSONB`**
    - Returns one entry per key: the society row if there is one, else the default.
    - Each entry: `{key, label, account_code, ledger_name, tds_nature, asset_account_code, asset_threshold, sort_order, is_custom, is_active}`. `is_custom` is true when no default row has that key.
    - Includes inactive custom types. Ordered by `sort_order`, then label.
    - Allowed for `is_committee_viewer OR can_view_expenses OR can_manage_accounts`. Anyone else gets 'You do not have access to this society''s accounts'.
  - **`set_bill_type(p_society_id UUID, p_key TEXT, p_label TEXT, p_account_code TEXT, p_tds_nature TEXT) RETURNS TEXT`** — returns the key.
    - When `p_key IS NULL`, it creates a custom type:
      - key = the label in lower case, every run of non-alphanumerics replaced by `_`, trimmed of `_` and cut to 40 characters;
      - if that key exists, add `_2`, `_3` and so on;
      - `sort_order` 800.
    - Otherwise it upserts the society row for that existing key. A new override copies `asset_account_code`, `asset_threshold` and `sort_order` from the default row.
    - The label is 2–96 characters after trimming. It must be unique (case-insensitive) in the merged list apart from the type itself: 'A bill type named % already exists'.
    - `p_tds_nature` must be one of `none, goods, contract, professional, technical, rent_building, rent_machinery`, else 'Unknown TDS type %'.
    - Audit: `bill_type.created` or `bill_type.updated`, entity_type `bill_type`, entity_id = key, old and new `{label, account_code, tds_nature}`.
  - **`set_bill_type_active(p_society_id UUID, p_key TEXT, p_active BOOLEAN) RETURNS VOID`**
    - Only for custom types: 'Sahvaas''s standard bill types cannot be turned off'.
    - Audit `bill_type.activated` or `bill_type.deactivated`.
  - **`adjustment_proposals.bill_type_key VARCHAR(48) NULL`**: set on proposals made by the RPC below.
  - **`propose_bill_type_move(p_society_id UUID, p_key TEXT) RETURNS JSONB`**
    - Requires `manage_accounts`.
    - Refuses while a `pending` proposal with this `bill_type_key` exists: 'A move for this bill type is already waiting for the committee'.
    - The target is the type's current `account_code`.
    - It works out how much of this type sits on each expense ledger this financial year (dates ≥ `fy_start_of(current_date)`). That is the sum of two things:
      - ledger lines on expense-type ledgers in `expense.approved`, `expense.voided` and `expense.paid` journals that reference an expense of the society with `category = p_key`;
      - the `lines` of `approved` proposals with `bill_type_key = p_key` and `entry_date` in this financial year (earlier moves).
    - Lines: `{code: old, amount: -net}` for every ledger other than the target with a non-zero net, plus `{code: target, amount: <their total>}`.
    - When there is nothing to move: 'Earlier bills of this type are already in %' (the target ledger's name).
    - Then it calls `propose_adjustment(p_society_id, current_date, 'Move earlier <label> bills to <target name>', lines)`, sets `bill_type_key` on the new row and returns `propose_adjustment`'s result.
  - **`suggest_tds`**
    - Drop the 6-argument version and recreate it from the 013 body with a new last parameter, `p_tds_nature TEXT DEFAULT NULL`.
    - When the resolved category key is `'other'`, use `p_tds_nature`; it must be `contract`, `professional` or `goods`, else 'Choose work, professional or goods for an Other bill'. With NULL, an `'other'` bill keeps nature `none`.
    - For every other category, `p_tds_nature` is ignored.

- [ ] **Step 1: Write `tests/db/bill-types.test.mjs`**

**Setup:**
- Society `'billtype'`: secretary, treasurer, a resident and a CA with `['view_reports','manage_accounts']`. Set `require_two_step_expense_approval = false`.
- A vendor with PAN `'ABCPP1234K'`.

**Helpers:**
- `approveBill(category, subtotal, date)`: the treasurer inserts the expense with `tds_amount` 0 and `invoice_date` = date, and the secretary approves it with `decide_expense`. Returns the expense id.
- `debitCodes(expenseId)`: the expense-type ledger codes in that expense's `expense.approved` journal.

```js
test('the committee sees one list of bill types', async () => {
  const list = await val(ids.secretary, 'SELECT public.bill_types($1)', [ids.societyId]);
  assert.equal(list.length, 23);
  assert.equal(new Set(list.map((t) => t.key)).size, 23);
  const lift = list.find((t) => t.key === 'lift_amc');
  assert.deepEqual([lift.account_code, lift.ledger_name, lift.tds_nature, lift.is_custom], ['5000', 'Repairs & Maintenance', 'contract', false]);
  await assert.rejects(q(ids.resident, 'SELECT public.bill_types($1)', [ids.societyId]), /do not have access/);
});

test('only the CA maps a bill type, only to an active expense ledger; new bills follow the mapping', async () => {
  // the secretary's direct INSERT of a society row into expense_categories rejects /row-level security/
  // set_bill_type as the secretary rejects /Only the society's CA or accountant/
  // ids.earlier = approveBill('lift_amc', 12000, current_date) → debitCodes ['5000']
  // ids.lastYear = approveBill('lift_amc', 3000, fy_start_of(current_date) - 10) → ['5000']
  // ids.repairs = approveBill('repairs', 4000, current_date) → ['5000']
  // the CA creates expense ledger 'Lift AMC' → '5C001'; set_bill_type(society, 'lift_amc', 'Lift AMC', '5C001', 'contract') returns 'lift_amc'
  // mapping to '4000' rejects /active expense ledger/; nature 'bogus' rejects /Unknown TDS type/
  // bill_types: lift_amc has account_code '5C001' and ledger_name 'Lift AMC'; one audit row 'bill_type.updated'
  // approveBill('lift_amc', 8000, current_date) → ['5C001']; ids.earlier still ['5000']
});

test('moving earlier bills is an adjustment the committee approves', async () => {
  // propose_bill_type_move as the secretary rejects /Only the society's CA or accountant/
  // r = propose_bill_type_move(society, 'lift_amc') as the CA → the adjustment_proposals row lines are
  //   [{code:'5C001', amount:12000}, {code:'5000', amount:-12000}]
  //   (this year's lift bill only: neither the 3000 bill from last year nor the 4000 repairs bill); status 'pending'
  // propose again while pending rejects /already waiting for the committee/
  // the treasurer approves with decide_adjustment(r.id, true) → 5C001 this year = 12000 + 8000
  // propose again rejects /already in Lift AMC/
});

test('the CA adds a bill type and can turn it off; standard types stay on', async () => {
  // set_bill_type(society, NULL, 'Water tanker', '5400', 'contract') returns 'water_tanker'
  // set_bill_type(society, NULL, 'Water-tanker', '5400', 'contract') returns 'water_tanker_2'
  // set_bill_type(society, NULL, 'water TANKER', '5400', 'none') rejects /already exists/
  // set_bill_type_active(society, 'water_tanker', false) → bill_types has that entry with is_active false
  // set_bill_type_active(society, 'security', false) rejects /standard bill types cannot be turned off/
});

test('"Other" bills take their TDS type from the plain question', async () => {
  const s = (cat, nature) => val(ids.secretary, 'SELECT public.suggest_tds($1,$2,$3,40000,current_date,NULL,$4)', [ids.societyId, ids.vendor, cat, nature]);
  const c = await s('other', 'contract');
  assert.deepEqual([c.nature, c.applies, Number(c.amount), c.section], ['contract', true, 400, '194C']);
  assert.equal((await s('other', null)).nature, 'none');
  assert.equal((await s('other', 'professional')).nature, 'professional');
  assert.equal((await s('security', 'professional')).nature, 'contract');
  await assert.rejects(s('other', 'rent_building'), /Choose work, professional or goods/);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `TZ=UTC node --test tests/db/bill-types.test.mjs`
Expected: FAIL. `bill_types` does not exist.

- [ ] **Step 3: Write `024_bill_types.sql` as described in Interfaces**

- [ ] **Step 4: Run the tests to see them pass**

Run: `bun run db:bundle && TZ=UTC node --test tests/db/bill-types.test.mjs`
Expected: `ℹ fail 0`.

- [ ] **Step 5: Regression check**

Run, one at a time: `TZ=UTC node --test tests/db/accounting.test.mjs`, then `ca-workspace.test.mjs`, `operations.test.mjs`, `bank-ledgers.test.mjs`, `consolidated.test.mjs`.
Expected: each `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/024_bill_types.sql src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql tests/db/bill-types.test.mjs
git commit -m "feat(expenses): the CA maps bill types to ledgers; Other bills ask the TDS question; earlier bills move by approval"
```

---

### Task 5: Bill Types screen and the "Other" question

**Files:**
- Create: `src/components/BillTypes.tsx`
- Modify: `src/views/professional/ProfessionalDashboardPage.tsx` (tab `'billtypes'`, label `'Bill Types'`, lucide icon `Tags`)
- Modify: `src/types/database.ts` (add `BillType`)
- Modify: `src/lib/tds.ts` (`suggestsAsset` accepts `Pick<BillType, 'asset_account_code' | 'asset_threshold'>`)
- Modify: `src/views/society/tabs/ExpensesTab.tsx` (load `bill_types` and drop `mergeCategories`)
- Modify: `src/views/society/tabs/ExpenseBillForm.tsx` (the "Bill type" label, the Other question, `p_tds_nature`)

**Interfaces:**
- Consumes: `bill_types`, `set_bill_type`, `set_bill_type_active`, `propose_bill_type_move`, `suggest_tds(… p_tds_nature)` and `chart_of_accounts` (to list active expense ledgers).
- Produces:
  - `BillType { key: string; label: string; account_code: string; ledger_name: string | null; tds_nature: TdsNature; asset_account_code: AssetAccountCode | null; asset_threshold: number | null; sort_order: number; is_custom: boolean; is_active: boolean }`
  - `BillTypes: React.FC<{ societyId: string; canManage: boolean }>`

- [ ] **Step 1: `BillTypes.tsx`**

- **Intro:** "The secretary picks a bill type. The type decides the ledger and the TDS. Point a type to another ledger and new bills go there."
- **Table columns:** Bill type | Ledger | TDS.
  - Ledger is a select of active expense ledgers.
  - TDS is a select with these labels: `none` "No TDS", `goods` "Goods (no TDS)", `contract` "Contract work (194C)", `professional` "Professional fees (194J)", `technical` "Technical services (194J)", `rent_building` "Rent — building (194I)", `rent_machinery` "Rent — machinery (194I)".
- **Changed row:** Save calls `set_bill_type`.
- **"Move earlier bills"** on every row calls `propose_bill_type_move` and shows "Sent to the committee for approval as <proposal_number>."
- **Custom types** get Turn off / Turn on.
- **"Add bill type"** form: name, ledger, TDS.
- **Display:** read-only when `!canManage`; errors use `Banner`.
- **Tab:** visible when the grant has `manage_accounts` or `view_expenses`. `canManage` = the grant includes `manage_accounts`.

- [ ] **Step 2: The secretary's bill form**

- `ExpensesTab` loads `bill_types` through the RPC and passes the active types.
- The field label "Category" becomes "Bill type".
- When the bill type is `other`, show this question as three radio buttons:
  - Question: "Is this for work or a service (contractor, AMC, repair), a professional (CA, lawyer, architect), or goods you bought?"
  - Options: "Work or a service" → `contract`, "A professional" → `professional`, "Goods" → `goods`.
- The answer is passed to `suggest_tds` as `p_tds_nature`. Submit refuses without an answer: "Answer what this bill is for, so TDS is worked out correctly."

- [ ] **Step 3: Static checks**

Run: `bun run typecheck && npx eslint src/components/BillTypes.tsx src/views/professional/ProfessionalDashboardPage.tsx src/types/database.ts src/lib/tds.ts src/views/society/tabs/ExpensesTab.tsx src/views/society/tabs/ExpenseBillForm.tsx`
Then: `TZ=UTC node --test tests/unit/tds.test.ts`
Expected: exit 0; `ℹ fail 0`.

- [ ] **Step 4: Commit**

```bash
git add src/components/BillTypes.tsx src/views/professional/ProfessionalDashboardPage.tsx src/types/database.ts src/lib/tds.ts src/views/society/tabs/ExpensesTab.tsx src/views/society/tabs/ExpenseBillForm.tsx
git commit -m "feat(ca): Bill Types screen; the secretary's Other bills ask the TDS question"
```

---

### Task 6: Vendor-wise and flat-wise ledgers

**Files:**
- Create: `src/db/migrations/025_party_ledgers.sql`
- Modify: `src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql` (regenerated)
- Test: `tests/db/party-ledgers.test.mjs` (new)

**Interfaces:**
- Produces:
  - **`party_entries(p_society_id UUID)`** — internal SQL, revoked from clients.
    - Returns `TABLE (kind TEXT, party_key TEXT, ledger_entry_id UUID, code TEXT, entry_date DATE, entry_number TEXT, narration TEXT, amount NUMERIC)`.
    - `kind = 'flat'` covers codes `1200` and `2300`. `party_key` is `units.id::text`, taken from:
      - `bills.unit_id` for `bill.issued`, `bill.cancelled`, `bill.late_fee`, `bill.late_fee_cancelled` and `advance.applied`;
      - `payments.unit_id` for `payment.verified`.
    - The `1200` line of `opening.balance` is split into one row per bill with `is_opening_balance`, each with that bill's `total_amount`. Any difference becomes a row with `party_key = 'unlinked'`.
    - `kind = 'vendor'` covers code `2000`. `party_key` is `expenses.vendor_id::text`, or `'payee'` when the expense has no vendor. It comes through:
      - the expense for `expense.approved`, `expense.voided` and `expense.paid`;
      - `vendor_payments.expense_id` for `vendor_payment.recorded` and `vendor_payment.voided`.
    - Every other line on those codes has `party_key = 'unlinked'`.
  - **`party_name(p_society_id UUID, p_kind TEXT, p_key TEXT) RETURNS TEXT`** — internal.
    - Flat: `'Flat ' || unit_number`, written as `'Flat ' || wing || '-' || unit_number` when another unit in the society has the same number.
    - Vendor: the vendor's name, with `' (' || coalesce(pan, left(id::text, 8)) || ')'` added when another vendor in the society has the same `lower(trim(name))`.
    - `'payee'` → 'Other payees'; `'unlinked'` → 'Not linked to a flat' or 'Not linked to a vendor'.
  - **`party_balances(p_society_id UUID, p_kind TEXT, p_as_of DATE DEFAULT current_date) RETURNS JSONB`**
    - Flats: `{parties:[{key, name, owner_name, dues, advance, balance}], control:{dues, advance}}`.
      - `dues` is the `1200` part and `advance` is minus the `2300` part; `balance = dues - advance`.
      - Every unit is listed, with zeros if it has no entries.
    - Vendors: `{parties:[{key, name, balance}], control:{payable}}`, where `balance` = minus the `2000` part (amount payable).
      - Every vendor of the society is listed, plus 'Other payees' and 'Not linked to a vendor' when they are non-zero.
    - `control` holds the ledgers' own balances as of `p_as_of`.
  - **`party_statement(p_society_id UUID, p_kind TEXT, p_key TEXT, p_from DATE, p_to DATE) RETURNS JSONB`**
    - Returns `{name, opening, lines:[{date, entry_number, narration, debit, credit, balance}], closing}`.
    - Lines are ordered by date, entry number and ledger entry id.
    - The running balance is debit-positive for flats and credit-positive for vendors.
  - **`party_lines(p_society_id UUID, p_from DATE, p_to DATE) RETURNS JSONB`** — for the Tally export.
    - Returns `[{ledger_entry_id, kind, key, name, amount}]` for lines on `1200` and `2000` only.
  - **Access** to all three client RPCs: `can_view_financials OR can_manage_accounts`. Anyone else gets 'You do not have access to this society''s accounts'. An unknown kind gets 'Unknown party type %'.

- [ ] **Step 1: Write `tests/db/party-ledgers.test.mjs`**

**Setup, in `before`:**
- Society `'party'` with flats 101 and 102. A billing rule: `flat_per_unit` 1000 with 18% tax.
- Owners res1 (101) and res2 (102), a treasurer, and a CA with `['view_reports','manage_accounts']`. Set `require_two_step_expense_approval = false`.

**Event sequence:**
1. `post_opening_balances(society, '2026-09-30', [{code:'2000',amount:-4000},{code:'1000',amount:4000}], [{unit_number:'102',amount:2500}])` as the secretary.
2. `generate_bills(society, '2026-10-01', '2026-10-31', '2026-10-10')`.
3. res1 pays 1500 with `payment_date '2026-10-20'`, verified (1180 allocated, 320 advance).
4. `generate_bills(society, '2026-11-01', '2026-11-30', '2026-11-10')`. 101's advance is applied automatically.
5. `cancel_bill` on 102's November bill, reason 'Raised by mistake'.
6. Vendor 'Shiv Lifts' (PAN `'ABCPP1234K'`): bill A, 5000 with `tds_amount` 100, approved and then paid with `record_vendor_payment(A, 1900, 100, 'neft', 'VREF000001')`. Bill B, 3000, approved and then voided with `void_expense(B, 'Duplicate bill')`.
7. Vendor 'Clean Co' with no bills.
8. A voucher, approved: `invoice_status 'none'`, `payee_name 'Raju'`, `document_url = '<societyId>/v.jpg'`, subtotal 800, category `'repairs'`.
9. Add flat 103 with `bulk_upsert_units`.

**Helper:**
- `bal(code)`: the sum of `ledger_entries.amount` for that code in the society.

```js
test('flat-wise dues and advances add up to Members' dues and advance maintenance', async () => {
  const r = await val(ids.ca, `SELECT public.party_balances($1,'flat')`, [ids.societyId]);
  const by = Object.fromEntries(r.parties.map((p) => [p.name, p]));
  assert.deepEqual([by['Flat 101'].advance, by['Flat 103'].balance].map(Number), [0, 0]);
  assert.equal(r.parties.reduce((s, p) => s + Number(p.dues), 0), await bal('1200'));
  assert.equal(r.parties.reduce((s, p) => s + Number(p.advance), 0), -(await bal('2300')));
  // for every flat, dues = the sum of balance_due on its bills whose status is not 'cancelled'
  //   (this covers any late fee or arrears line the billing rules add, so no hard-coded bill totals)
  // Flat 102's dues include its 2500 opening arrears: dues >= 2500
});

test('vendor-wise balances add up to Sundry Creditors', async () => {
  const r = await val(ids.ca, `SELECT public.party_balances($1,'vendor')`, [ids.societyId]);
  const by = Object.fromEntries(r.parties.map((p) => [p.name, Number(p.balance)]));
  assert.deepEqual([by['Shiv Lifts'], by['Clean Co'], by['Other payees'], by['Not linked to a vendor']], [3000, 0, 800, 4000]);
  assert.equal(Object.values(by).reduce((s, b) => s + b, 0), -(await bal('2000')));
});

test('a party statement runs from its opening balance to its closing balance', async () => {
  // party_statement(flat, <101 key>, '2026-11-01', current_date): opening -320 (the October bill of 1180 less the 1500 paid);
  //   closing = Flat 101's balance from party_balances; every line's balance = the previous one + debit - credit
  // party_statement(vendor, <Shiv Lifts key>, '2026-04-01', current_date): opening 0, credits 5000 and 3000, debits 2000 and 3000, closing 3000
});

test('Tally gets a party for every Members' dues and Sundry Creditors line', async () => {
  // party_lines(society, '2026-04-01', current_date): for every ledger entry on 1200 or 2000 in that range,
  //   the amounts of its party rows sum to the entry's amount;
  //   the opening 1200 line has exactly one row, 'Flat 102' with 2500
});

test('only people who can see the accounts see party ledgers', async () => {
  // party_balances as res1 rejects /do not have access/; as the secretary it works; kind 'bogus' rejects /Unknown party type/
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `TZ=UTC node --test tests/db/party-ledgers.test.mjs`
Expected: FAIL. `party_balances` does not exist.

- [ ] **Step 3: Write `025_party_ledgers.sql` as described in Interfaces**

- [ ] **Step 4: Run the tests to see them pass**

Run: `bun run db:bundle && TZ=UTC node --test tests/db/party-ledgers.test.mjs`
Expected: `ℹ fail 0`. If the per-flat check against unpaid bills fails, find which event breaks the tie with superpowers:systematic-debugging. Never loosen the assertion.

- [ ] **Step 5: Regression check**

Run, one at a time: `TZ=UTC node --test tests/db/launch.test.mjs`, then `ledger.test.mjs`, `integrity.test.mjs`, `consolidated.test.mjs`.
Expected: each `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/025_party_ledgers.sql src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql tests/db/party-ledgers.test.mjs
git commit -m "feat(accounts): vendor-wise and flat-wise ledgers that tie to Sundry Creditors and Members' dues"
```

---

### Task 7: Party ledgers on screen and in the Tally export

**Files:**
- Create: `src/components/PartyLedgers.tsx`
- Modify: `src/views/professional/ProfessionalDashboardPage.tsx` (render it below `ChartOfAccounts` in the `'ledgers'` tab)
- Modify: `src/lib/tally-xml.ts`
- Modify: `src/components/FinancialReports.tsx` (`loadJournal` also selects `ledger_entries (id, …)`; the export calls `party_lines`)
- Test: `tests/unit/tally-xml.test.ts` (append)

**Interfaces:**
- Consumes: `party_balances`, `party_statement` and `party_lines` (Task 6).
- Produces, in `src/lib/tally-xml.ts`:
  - `export interface PartyLine { ledger_entry_id: string; kind: 'flat' | 'vendor'; key: string; name: string; amount: number }`
  - `TallyJournal.lines` becomes `{ code: string; amount: number; party?: string }[]`.
  - `export function splitPartyLines(lines: { id: string; code: string; amount: number }[], parties: PartyLine[]): { code: string; amount: number; party?: string }[]`
    - A line with party rows becomes one line per row: same code, the row's amount, `party` = the row's name.
    - Other lines pass through unchanged.
  - `buildTallyXml` behaviour for party lines:
    - A line with `party` uses the party name as `LEDGERNAME`.
    - Each used party gets a LEDGER master whose PARENT is `tallyParentName(chart, <control ledger>.group_id)`, i.e. Sundry Debtors or Sundry Creditors.
    - A party name equal (case-insensitive) to a used ledger or group name is written as `<name> (Party)` everywhere.
    - A control ledger whose every line has a party gets no master.
  - `PartyLedgers: React.FC<{ societyId: string }>`

- [ ] **Step 1: Append the failing unit tests**

```ts
test('party lines become Sundry Debtors and Sundry Creditors ledgers', () => {
  // chart with 1200 in members_dues, 2000 in sundry_creditors, 4000 in income; one journal:
  // [{code:'1200', amount:1180, party:'Flat 101'}, {code:'4000', amount:-1180}]
  // xml has <LEDGER NAME="Flat 101" ...><PARENT>Sundry Debtors</PARENT>, the voucher's LEDGERNAME is Flat 101,
  // and there is no LEDGER master for the 1200 ledger's own name
});
test('a party named like a ledger gets a suffix', () => {
  // ledger 5C001 'Lift AMC' and party 'Lift AMC' (vendor) are used in the same export → the party master is named 'Lift AMC (Party)'
});
test('splitPartyLines splits one entry across its parties', () => {
  // [{id:'e1', code:'1200', amount:2500}, {id:'e2', code:'3200', amount:-2500}] with parties
  // [{ledger_entry_id:'e1', name:'Flat 102', amount:1500, …}, {ledger_entry_id:'e1', name:'Flat 103', amount:1000, …}]
  // → [{code:'1200', amount:1500, party:'Flat 102'}, {code:'1200', amount:1000, party:'Flat 103'}, {code:'3200', amount:-2500}]
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `TZ=UTC node --test tests/unit/tally-xml.test.ts`
Expected: FAIL. `splitPartyLines` is not exported.

- [ ] **Step 3: Implement the `tally-xml.ts` changes and the FinancialReports export**

- [ ] **Step 4: Run the tests to see them pass**

Run: `TZ=UTC node --test tests/unit/tally-xml.test.ts`
Expected: `ℹ fail 0`, including the 3 existing tests.

- [ ] **Step 5: `PartyLedgers.tsx`**

- Two sections, "Members (flat-wise)" and "Vendors".
- **Members:** flat, owner, dues, advance. **Vendors:** name, payable.
- A total row, then "Matches Members' dues" or "Matches Sundry Creditors" when the total equals `control`. Otherwise show the difference in red.
- Clicking a row opens its statement: `party_statement` with from/to (default: the current financial year), showing date, entry, narration, debit, credit and balance.

- [ ] **Step 6: Static checks**

Run: `bun run typecheck && npx eslint src/components/PartyLedgers.tsx src/views/professional/ProfessionalDashboardPage.tsx src/lib/tally-xml.ts src/components/FinancialReports.tsx`
Expected: exit 0, no errors.

- [ ] **Step 7: Full verification**

Run every test file on its own: `TZ=UTC node --test <file>` for each of `tests/unit/*.test.ts` and `tests/db/*.test.mjs`.
Expected: every file `ℹ fail 0`. The total is the 191 tests from before plus the new bank, bill-type, party and Tally tests.

- [ ] **Step 8: Commit**

```bash
git add src/components/PartyLedgers.tsx src/views/professional/ProfessionalDashboardPage.tsx src/lib/tally-xml.ts src/components/FinancialReports.tsx tests/unit/tally-xml.test.ts
git commit -m "feat(ca): flat-wise and vendor-wise ledgers on screen; Tally export emits party ledgers"
```

- [ ] **Step 9: Live database (only after the user says go)**

The user runs `bun run db:migrate`. The dry run should list `022`–`025`, plus `019`–`021` if those are not applied yet. Then they run `bun run db:migrate --apply`.

Afterwards, verify with read-only queries:
- every `bank_accounts.ledger_id` is set;
- `_sahvaas_migrations` has rows 022–025.
