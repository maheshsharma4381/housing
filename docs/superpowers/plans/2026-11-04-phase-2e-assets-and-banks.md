# Phase 2E: Fixed-Asset Ledgers, Sale Proceeds to a Chosen Bank, Moving an Entry to Another Bank — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CA or Accountant can do three new things:
- create fixed-asset ledgers (asset types) with their own depreciation rates and use them everywhere an asset type is chosen;
- choose the bank that receives asset sale money;
- move a receipt, vendor payment or TDS challan that was booked to the wrong bank, with committee approval.

**Architecture:** One migration, `028_assets_and_banks.sql`, built up across Tasks 1–3.
- **Asset types:**
  - "Asset type" becomes any active ledger in the Fixed Assets group except 1590 Accumulated Depreciation.
  - `accounts.dep_rate` holds the type's default rate.
  - Every hard-coded `'1500'…'1550'` list in the database is replaced by `is_asset_ledger`.
- **Disposal:** `dispose_asset` gains a bank choice.
- **Bank move:** a new `adjustment_proposals` kind, `bank_move`, carries the entry and the two banks. `decide_adjustment` posts the move journal and re-points the entry's `bank_ledger_id`, so it appears in Approvals like any adjustment.

**Tech Stack:** Next.js 15, React 19, Tailwind v4, Supabase Postgres (plpgsql, RLS), PGlite tests (`node --test`), Bun scripts.

**Spec:** `docs/superpowers/specs/2026-10-31-sahvaas-simplify-design.md`:
- 7.1: fixed-asset checks become "any active ledger of the right nature/group"; "Several bank accounts … anything else the CA moves by adjustment";
- 7.5: the authority table: "anything that changes posted entries" needs a committee approval; "fixed assets and depreciation" are the CA's directly.

## Phase 2 split (updated)

| Plan | Scope |
|---|---|
| 2A–2D | Done |
| **2E (this plan)** | Fixed-asset ledgers with depreciation rates; bank choice for asset sale money; moving an entry to another bank by approved adjustment |
| 2F | Owner change and ownership history |

## Decisions (taken on the product owner's behalf — "u decide")

1. **An asset type is a ledger.**
   - The six standard asset ledgers keep their income-tax WDV rates (1500: 15, 1510: 10, 1520: 10, 1530: 40, 1540: 15, 1550: 10).
   - A new asset type defaults to 10% until the CA sets its rate.
   - Changing a type's rate changes only assets added afterwards; each asset keeps its own rate, editable as today.
2. **Platform default bill types** (the rows with no society) keep the six standard asset codes, because they cannot name a society's ledgers. A society's own bill type may suggest any of its asset ledgers.
3. **Disposing of an asset stays with the CA / Accountant directly** (spec 7.5). The sale money goes to the chosen bank ledger; when none is chosen it goes to the society's default receiving bank (2B), and cash goes to Cash-in-Hand.
4. **A bank move is an adjustment the committee approves.**
   - It is dated on the entry's own date, so bank books match the statements.
   - An entry that is matched on a bank statement must be unlinked first.
   - A refund or void after a move reverses the entry in the bank where it was first booked. The CA moves that reversal too if it matters (rare).

## Global Constraints

- **Migrations:** new SQL goes only in `src/db/migrations/028_assets_and_banks.sql`. Never edit 001–027. Run `bun run db:bundle` after every SQL change. Never run `bun run db:migrate --apply`; the product owner does.
- **Redefined functions** are verbatim copies of the latest body plus the change, with a comment naming the source file. Build them with a script that extracts the body, as 2D did. Latest bodies:

  | Function | Latest in |
  |---|---|
  | `group_allows_ledgers` | 022 |
  | `expenses_accounting_checks`, `create_asset_for_expense` | 013 |
  | `add_existing_asset`, `dispose_asset`, `decide_adjustment` | 027 |
  | `propose_capitalisation` | 014 |
  | `trg_payment_bank` | 023 |

- **Messages:** existing messages stay word for word unless this plan gives new copy.
- **RPC security:** every RPC is `SECURITY DEFINER SET search_path = public`. Callable ones get `REVOKE ALL … FROM PUBLIC, anon; GRANT EXECUTE … TO authenticated`. Internal helpers are revoked from `authenticated` too.
- **DB tests** run one file at a time: `TZ=UTC node --test tests/db/<file>`. The full suite is every file in `tests/unit` and `tests/db`, one at a time.
- **App UI** is English only.
- **Commits:** `git -c user.name=ved300406 -c user.email=ved300406@gmail.com commit …`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Review Focus

1. **1590 as an asset type:** Accumulated Depreciation, or an inactive asset ledger, chosen as an asset type is refused everywhere: existing asset, capital bill, capitalisation (Task 1 test).
2. **A move after matching:** a payment matched on a bank statement after the move was proposed cannot be moved at approval, and nothing is posted (Task 3 test).
3. **A move after a change:** a payment refunded, or a vendor payment voided, after the move was proposed is refused at approval (Task 3 test).
4. **A moved receipt:** after the move, verifying or matching the payment on the new bank's statement works, and on the old one it is refused, through 023's bank checks (Task 3 test).
5. **Sale money to a non-bank ledger:** sending asset sale money to a ledger that is not a bank is refused (Task 2 test).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/migrations/028_assets_and_banks.sql` (new) | Asset ledgers and rates, disposal bank, bank-move proposals |
| `tests/db/asset-ledgers.test.mjs` (new) | Tasks 1–2 |
| `tests/db/bank-move.test.mjs` (new) | Task 3 |
| `src/types/database.ts` | `AssetAccountCode` becomes `string` |
| `src/components/AssetRegister.tsx` | Asset types card (rates, add a type); type selects from `asset_ledgers`; bank select on disposal |
| `src/components/AdjustmentsPanel.tsx` | Capitalise select from `asset_ledgers`; new "Move to another bank" kind |

---

### Task 1: Fixed-asset ledgers with their own depreciation rates

**Files:** Create `028_assets_and_banks.sql` and `tests/db/asset-ledgers.test.mjs`. Regenerate the bundle.

**Interfaces:**
- Consumes: `create_ledger` (020), `require_manage_accounts` (020), `can_keep_books` (027), `account_group_key` (019).
- Produces:
  - `accounts.dep_rate NUMERIC(5,2) NULL CHECK (dep_rate BETWEEN 0 AND 100)`. Backfill the six standard codes to their 013 rates.
  - `group_allows_ledgers(UUID)`: the 022 body without `'fixed_assets'` in its list.
  - `is_asset_ledger(p_society_id UUID, p_code TEXT) RETURNS BOOLEAN` (internal): true for an active ledger whose `account_group_key(group_id) = 'fixed_assets'` and whose code is not `'1590'`.
  - `asset_dep_rate(p_society_id UUID, p_code TEXT) RETURNS NUMERIC` (internal): `coalesce(accounts.dep_rate, default_dep_rate(p_code))`.
  - `asset_ledgers(p_society_id UUID) RETURNS JSONB` returns `[{ code, name, dep_rate }]`: every asset ledger by code, with `dep_rate` from `asset_dep_rate`. Access: `can_view_financials OR can_manage_accounts`, else `'You do not have access to this society''s accounts'`.
  - `add_asset_ledger(p_society_id UUID, p_name TEXT, p_rate NUMERIC) RETURNS TEXT` (the new code): `require_manage_accounts`; `create_ledger` in the society's `fixed_assets` group; then the rate. Audit `chart.asset_ledger_added`.
  - `set_ledger_dep_rate(p_society_id UUID, p_code TEXT, p_rate NUMERIC) RETURNS JSONB` returns `{ code, dep_rate }`. Audit `chart.dep_rate_set`. Messages:
    - `require_manage_accounts`' own message;
    - `'Choose a fixed-asset ledger'` when `NOT is_asset_ledger`;
    - `'Depreciation rate must be between 0 and 100'`.
  - Hard-coded lists replaced by `is_asset_ledger(society, code)`, with each message unchanged:
    - `expenses_accounting_checks` (013): "Pick an asset type for a purchase booked as an asset";
    - `add_existing_asset` (027): "Pick an asset type". It uses `asset_dep_rate` instead of `default_dep_rate`.
    - `propose_capitalisation` (014): "Pick an asset type".
  - `create_asset_for_expense` (013) uses `asset_dep_rate(v_exp.society_id, v_exp.asset_account_code)`.
  - Constraint changes:
    - drop `fixed_assets_account_code_check`;
    - replace `expense_categories_asset_account_code_check` with `CHECK (society_id IS NOT NULL OR asset_account_code IS NULL OR asset_account_code IN ('1500','1510','1520','1530','1540','1550'))`;
    - in `trg_bill_type_ledger` (024), an active society row with a non-null `asset_account_code` must satisfy `is_asset_ledger`. Message: `'Choose a fixed-asset ledger for the asset suggestion'`.

- [ ] **Step 1: Write the failing tests** (`tests/db/asset-ledgers.test.mjs`).

  Setup:
  - a society with a secretary, a treasurer, and a CA with the `ca` preset (via `inviteProfessional`);
  - a vendor;
  - `require_two_step_expense_approval = false`;
  - helpers `groupId(key)`, `ledgerId(code)` and `approveBill(fields)`. `approveBill` inserts the bill as the treasurer and has the secretary call `decide_expense(id, true)`, as `party-ledgers.test.mjs` does.

  ```js
  test('the CA adds an asset type with its own depreciation rate', async () => {
    ids.solar = await val(ids.ca, `SELECT public.add_asset_ledger($1,'Solar Panels',25)`, [ids.societyId]);
    const list = await val(ids.ca, 'SELECT public.asset_ledgers($1)', [ids.societyId]);
    assert.deepEqual(list.find((l) => l.code === ids.solar), { code: ids.solar, name: 'Solar Panels', dep_rate: 25 });
    assert.equal(Number(list.find((l) => l.code === '1530').dep_rate), 40);
    assert.ok(!list.some((l) => l.code === '1590'));
    await assert.rejects(q(ids.secretary, `SELECT public.set_ledger_dep_rate($1,$2,10)`, [ids.societyId, ids.solar]), /Only the society's CA or accountant/);
    await assert.rejects(q(ids.ca, `SELECT public.set_ledger_dep_rate($1,'5000',10)`, [ids.societyId]), /Choose a fixed-asset ledger/);
    await assert.rejects(q(ids.ca, `SELECT public.set_ledger_dep_rate($1,$2,120)`, [ids.societyId, ids.solar]), /between 0 and 100/);
    assert.match(await val(ids.ca, `SELECT public.create_ledger($1,$2,'Gym Equipment')`, [ids.societyId, await groupId('fixed_assets')]), /\w/);
  });

  test('an asset on a new type takes its rate; bills and capitalisation accept the type', async () => {
    const a = await val(ids.ca, `SELECT public.add_existing_asset($1,'Rooftop solar',$2,'2024-01-01',300000,250000,'2025-04-01')`, [ids.societyId, ids.solar]);
    assert.equal(Number((await db.query('SELECT dep_rate FROM fixed_assets WHERE id=$1', [a])).rows[0].dep_rate), 25);
    const bill = await approveBill({ category: 'electrical', title: 'Inverter', subtotal: 40000, expense_type: 'capital', asset_account_code: ids.solar });
    const debit = (await db.query(`SELECT a.code FROM journal_entries j JOIN ledger_entries l ON l.journal_entry_id=j.id JOIN accounts a ON a.id=l.account_id
      WHERE j.reference_event_type='expense.approved' AND j.reference_event_id=$1 AND l.amount > 0`, [bill])).rows.map((r) => r.code);
    assert.deepEqual(debit, [ids.solar]);
    assert.equal(Number((await db.query('SELECT dep_rate FROM fixed_assets WHERE expense_id=$1', [bill])).rows[0].dep_rate), 25);
    const repair = await approveBill({ category: 'repairs', title: 'Panel frame', subtotal: 9000 });
    await q(ids.ca, `SELECT public.propose_capitalisation($1,$2,'Frame is part of the solar plant')`, [repair, ids.solar]);
  });

  test('accumulated depreciation and inactive ledgers are not asset types', async () => {
    for (const code of ['1590', '5000']) {
      await assert.rejects(q(ids.ca, `SELECT public.add_existing_asset($1,'Pump',$2,'2024-01-01',1000,500,'2025-04-01')`, [ids.societyId, code]), /Pick an asset type/);
    }
    const gym = (await db.query(`SELECT code FROM accounts WHERE society_id=$1 AND name='Gym Equipment'`, [ids.societyId])).rows[0].code;
    await q(ids.ca, `SELECT public.set_ledger_active($1,$2,false)`, [ids.societyId, gym]);
    await assert.rejects(approveBill({ category: 'other', title: 'Treadmill', subtotal: 50000, expense_type: 'capital', asset_account_code: gym }),
      /Pick an asset type for a purchase booked as an asset/);
  });
  ```
- [ ] **Step 2: Run** `TZ=UTC node --test tests/db/asset-ledgers.test.mjs`. Expected: FAIL, `add_asset_ledger` does not exist.
- [ ] **Step 3: Implement** everything in the Interfaces block; then `bun run db:bundle`.
- [ ] **Step 4: Run** the file (3 pass), then `accounting`, `ca-workspace`, `ca-workspace-moves`, `chart-of-accounts` and `bill-types` one at a time. All pass. Where an old test asserted that Fixed Assets takes no CA ledgers (`chart-of-accounts`), update it to the new rule and ledger a Ruling.
- [ ] **Step 5: Commit:** `feat(assets): the CA adds asset types as fixed-asset ledgers with their own depreciation rates`.

---

### Task 2: Asset sale money goes to the chosen bank

**Files:** Modify `028_assets_and_banks.sql` and `tests/db/asset-ledgers.test.mjs`.

**Interfaces:**
- Consumes: `is_bank_ledger(UUID, UUID)` and `default_bank_ledger(UUID, TEXT) → UUID` (022).
- Produces:
  - `dispose_asset(p_asset_id UUID, p_disposed_on DATE, p_sale_amount NUMERIC DEFAULT 0, p_mode TEXT DEFAULT 'bank', p_reason TEXT DEFAULT NULL, p_bank_ledger_id UUID DEFAULT NULL) RETURNS JSONB`. Drop the old 5-argument version first.
  - The money line's code depends on the mode:
    - cash: `'1100'`;
    - bank: the code of `coalesce(p_bank_ledger_id, default_bank_ledger(society, 'receipt'))`.
  - New message: `'Choose a bank ledger of this society'` when `p_bank_ledger_id` is given and `NOT is_bank_ledger`. The rest of the 027 body stays as it is.

- [ ] **Step 1: Write the failing test** (append):
  ```js
  test('sale money from an asset lands in the bank the CA chooses', async () => {
    const hdfc = await val(ids.ca, `SELECT public.create_ledger($1,$2,'HDFC Savings')`, [ids.societyId, await groupId('bank_accounts')]);
    const add = (name) => val(ids.ca, `SELECT public.add_existing_asset($1,$2,'1520','2020-01-01',10000,4000,'2025-04-01')`, [ids.societyId, name]);
    const money = async (assetId) => (await db.query(`SELECT a.code, l.amount FROM journal_entries j JOIN ledger_entries l ON l.journal_entry_id=j.id
      JOIN accounts a ON a.id=l.account_id WHERE j.reference_event_type='asset.disposed' AND j.reference_event_id=$1 AND a.code IN ($2,'1000','1100')`,
      [assetId, hdfc])).rows.map((r) => [r.code, Number(r.amount)]);
    const a1 = await add('Old sofa');
    await q(ids.ca, `SELECT public.dispose_asset($1,current_date,3000,'bank','Sold to staff',$2)`, [a1, await ledgerId(hdfc)]);
    assert.deepEqual(await money(a1), [[hdfc, 3000]]);
    const a2 = await add('Old chairs');
    await q(ids.ca, `SELECT public.dispose_asset($1,current_date,500,'cash','Sold as scrap')`, [a2]);
    assert.deepEqual(await money(a2), [['1100', 500]]);
    const a3 = await add('Old desk');
    await q(ids.ca, `SELECT public.dispose_asset($1,current_date,800,'bank','Sold to a member')`, [a3]);
    assert.deepEqual(await money(a3), [['1000', 800]]);
    const a4 = await add('Old shelf');
    await assert.rejects(q(ids.ca, `SELECT public.dispose_asset($1,current_date,100,'bank','Sold',$2)`, [a4, await ledgerId('5000')]),
      /Choose a bank ledger of this society/);
  });
  ```
- [ ] **Step 2: Run.** Expected: FAIL, `function public.dispose_asset(…, uuid) does not exist`.
- [ ] **Step 3: Implement**, then `bun run db:bundle`.
- [ ] **Step 4: Run** `asset-ledgers`, `accounting` and `ca-workspace-moves` one at a time. All pass.
- [ ] **Step 5: Commit:** `feat(assets): sale money from an asset goes to the bank the CA chooses`.

---

### Task 3: Moving an entry to another bank, by approved adjustment

**Files:** Modify `028_assets_and_banks.sql`. Create `tests/db/bank-move.test.mjs`.

**Interfaces:**
- Consumes:
  - `can_propose_adjustment` (027), `check_adjustment_date` (014), `next_society_number` and `is_bank_ledger`;
  - `bank_transactions.reconciled_payment_id`, `reconciled_vendor_payment_id`, `reconciled_challan_id` (017).
- Produces:
  - **Constraint:** `adjustment_proposals.kind` CHECK becomes `('journal','capitalise','year_lock','bank_move')`.
  - **New columns:**
    - `adjustment_proposals.move_entity_type VARCHAR(16) CHECK (move_entity_type IN ('payment','vendor_payment','tds_challan'))`;
    - `move_entity_id UUID`;
    - `move_from_ledger_id UUID REFERENCES accounts(id)`;
    - `move_to_ledger_id UUID REFERENCES accounts(id)`.
  - **`propose_bank_move(p_society_id UUID, p_entity_type TEXT, p_entity_id UUID, p_to_ledger_id UUID, p_reason TEXT) RETURNS JSONB`** returns `{ id, proposal_number }`. Guards, in order:
    1. `'Only the committee or the society''s CA can propose adjustments'`
    2. `'Explain the adjustment (at least a few words)'` (reason under 5 characters)
    3. `'Entry not found'` (the entry is not of this society). The usable states are:
       - payment: `verified`;
       - vendor payment: `recorded`;
       - challan: any.
    4. `'This was received in cash — there is no bank to move'` (payment with `payment_method = 'cash'`). Its counterpart is `'This was paid in cash — there is no bank to move'` (vendor payment with `mode = 'cash'`).
    5. `'Choose a bank ledger of this society'`
    6. `'It is already in %'` (ledger name)
    7. `'Unlink it from the bank statement first'` (a `bank_transactions` row references the entry)
    8. `'A move for this entry is already waiting for the committee'`
    9. `check_adjustment_date(society, entry date)`, where the entry date is `payment_date` or `paid_on`.

    **Lines**, with `amount` = payment / vendor payment / challan `amount`, `from` = the entry's current `bank_ledger_id`'s code, and `to` = the target's code:
    - money in (payment): `[{to, +amount}, {from, −amount}]`;
    - money out (vendor payment, challan): `[{from, +amount}, {to, −amount}]`.

    The proposal is numbered `AP-NNNN` and dated on the entry's date. Audit `adjustment.proposed`.
  - **`decide_adjustment`**, redefined from the 027 body. On approve for `bank_move`:
    - re-check that the entry is still in its usable state, still has `bank_ledger_id = move_from_ledger_id`, and is not on a statement. Otherwise raise `'This entry has changed since the proposal — ask for a new one'`;
    - post the journal (the normal path);
    - set the entry's `bank_ledger_id` to `move_to_ledger_id`. For payments, wrap this in `set_config('sahvaas.bank_move','on',true)` … `'off'`.
  - **`trg_payment_bank`**, redefined from 023: its first guard is skipped while `sahvaas.bank_move` is `'on'`.

- [ ] **Step 1: Write the failing tests** (`tests/db/bank-move.test.mjs`).

  Setup:
  - a society with a secretary, a treasurer, the owner of flat 101, and a CA with the `ca` preset;
  - `hdfc` = `create_ledger` in `bank_accounts` named "HDFC Savings", by the CA, plus its id;
  - a verified UPI payment of 4170 from flat 101: the resident inserts it as `pending_verification` and the secretary calls `verify_payment(id, true)`. Its `bank_ledger_id` is the default, 1000;
  - an approved bill paid with `record_vendor_payment(bill, 3000, 0, 'neft', 'UTR-V', current_date)`;
  - helper `bal(code)` = the sum of that code's ledger lines.

  ```js
  test('a receipt booked to the wrong bank moves by an approved adjustment', async () => {
    const before = [await bal('1000'), await bal(ids.hdfc)];
    const p = await val(ids.ca, `SELECT public.propose_bank_move($1,'payment',$2,$3,'Paid into HDFC per statement')`, [ids.societyId, ids.pay, ids.hdfcId]);
    const row = (await db.query('SELECT kind, lines FROM adjustment_proposals WHERE id=$1', [p.id])).rows[0];
    assert.equal(row.kind, 'bank_move');
    assert.deepEqual(Object.fromEntries(row.lines.map((l) => [l.code, Number(l.amount)])), { [ids.hdfc]: 4170, 1000: -4170 });
    await assert.rejects(q(ids.ca, `SELECT public.propose_bank_move($1,'payment',$2,$3,'Again please')`, [ids.societyId, ids.pay, ids.hdfcId]),
      /already waiting for the committee/);
    await q(ids.secretary, 'SELECT public.decide_adjustment($1,true)', [p.id]);
    assert.equal((await db.query('SELECT bank_ledger_id FROM payments WHERE id=$1', [ids.pay])).rows[0].bank_ledger_id, ids.hdfcId);
    assert.deepEqual([await bal('1000'), await bal(ids.hdfc)], [before[0] - 4170, before[1] + 4170]);
    await assert.rejects(q(ids.ca, `SELECT public.propose_bank_move($1,'payment',$2,$3,'Once more')`, [ids.societyId, ids.pay, ids.hdfcId]),
      /already in HDFC Savings/);
  });

  test('a vendor payment moves the other way', async () => {
    const p = await val(ids.ca, `SELECT public.propose_bank_move($1,'vendor_payment',$2,$3,'Paid from HDFC per statement')`, [ids.societyId, ids.vpay, ids.hdfcId]);
    const row = (await db.query('SELECT lines FROM adjustment_proposals WHERE id=$1', [p.id])).rows[0];
    assert.deepEqual(Object.fromEntries(row.lines.map((l) => [l.code, Number(l.amount)])), { 1000: 3000, [ids.hdfc]: -3000 });
    await q(ids.treasurer, 'SELECT public.decide_adjustment($1,true)', [p.id]);
    assert.equal((await db.query('SELECT bank_ledger_id FROM vendor_payments WHERE id=$1', [ids.vpay])).rows[0].bank_ledger_id, ids.hdfcId);
  });

  test('cash, a non-bank ledger, a matched line or a resident stops a move', async () => {
    // a verified cash payment, a 5000 ledger as target, a payment linked to a statement line (import + link_bank_line as in bank-ledgers.test.mjs)
    await assert.rejects(q(ids.ca, `SELECT public.propose_bank_move($1,'payment',$2,$3,'Was it bank?')`, [ids.societyId, ids.cashPay, ids.hdfcId]), /received in cash/);
    await assert.rejects(q(ids.ca, `SELECT public.propose_bank_move($1,'payment',$2,$3,'Into expenses?')`, [ids.societyId, ids.pay2, ids.repairsId]), /Choose a bank ledger/);
    await assert.rejects(q(ids.ca, `SELECT public.propose_bank_move($1,'payment',$2,$3,'Matched one')`, [ids.societyId, ids.matchedPay, ids.hdfcId]), /Unlink it from the bank statement first/);
    await assert.rejects(q(ids.resident, `SELECT public.propose_bank_move($1,'payment',$2,$3,'Please move')`, [ids.societyId, ids.pay2, ids.hdfcId]), /Only the committee or the society's CA/);
  });

  test('approval re-checks the entry: matched or refunded after the proposal, nothing moves', async () => {
    const p = await val(ids.ca, `SELECT public.propose_bank_move($1,'payment',$2,$3,'Into HDFC')`, [ids.societyId, ids.pay2, ids.hdfcId]);
    // link pay2 to a 1000-bank statement line now (as in bank-ledgers.test.mjs)
    await assert.rejects(q(ids.secretary, 'SELECT public.decide_adjustment($1,true)', [p.id]), /changed since the proposal/);
    assert.equal((await db.query(`SELECT count(*)::int n FROM journal_entries WHERE reference_event_id=$1`, [p.id])).rows[0].n, 0);
  });
  ```
- [ ] **Step 2: Run** `TZ=UTC node --test tests/db/bank-move.test.mjs`. Expected: FAIL, `propose_bank_move` does not exist.
- [ ] **Step 3: Implement**, then `bun run db:bundle`.
- [ ] **Step 4: Run** `bank-move`, `bank-ledgers`, `bank-reconciliation`, `ca-workspace`, `ca-workspace-moves` and `opening-balance` one at a time. All pass.
- [ ] **Step 5: Commit:** `feat(banks): an entry booked to the wrong bank moves by an approved adjustment`.

---

### Task 4: Asset types on screen; disposal bank

**Files:** Modify `src/types/database.ts`, `src/components/AssetRegister.tsx` and `src/components/AdjustmentsPanel.tsx`.

**Interfaces:**
- Consumes:
  - `asset_ledgers`, `add_asset_ledger` and `set_ledger_dep_rate` (Task 1);
  - `dispose_asset(…, p_bank_ledger_id)` (Task 2);
  - `fetchBankLedgers` / `defaultBankId` (`src/lib/banks.ts`).
- Produces:
  - `export type AssetAccountCode = string;`
  - `AssetRegister` loads `asset_ledgers` and uses it for every asset-type select and label. When a code is not in the list, it falls back to `assetTypeLabel` from `lib/tds`.
  - New card "Asset types", shown when `canManage`:
    - a table of Type · Depreciation (%), with a number input and "Save" calling `set_ledger_dep_rate`;
    - "Add asset type" (name + rate) calls `add_asset_ledger`;
    - help: "Each asset type is a ledger under Fixed Assets. A new asset takes its type's rate; you can still change an asset's own rate."
  - The disposal form shows a "Received in" bank select when the mode is bank and the society has more than one bank, defaulting to `defaultBankId(banks,'receipt')`. It passes `p_bank_ledger_id`.
  - `AdjustmentsPanel`'s capitalise asset select uses `asset_ledgers` and defaults to its first entry.

- [ ] **Step 1:** Make the changes above.
- [ ] **Step 2: Verify:** `bun run typecheck`, then `bun run lint` with no errors in the touched files.
- [ ] **Step 3: Commit:** `feat(assets): asset types and their depreciation rates on screen; sale money's bank`.

---

### Task 5: "Move to another bank" in Adjustments

**Files:** Modify `src/components/AdjustmentsPanel.tsx`.

**Interfaces:**
- Consumes: `propose_bank_move` (Task 3); `fetchBankLedgers`.
- Produces:
  - **Kinds:** `Proposal.kind` gains `'bank_move'`. The kind picker gains "Move to another bank" next to "Journal entry" and "Move an expense to assets".
  - **The form has:**
    - Entry type: Receipt / Vendor payment / TDS challan;
    - an entry select listing the latest 100 entries of that type that have a `bank_ledger_id`, read from `payments` (status `verified`, method not cash), `vendor_payments` (status `recorded`, mode not cash) or `tds_challans`. Each option reads "{number or UTR} · {date} · {formatINR(amount)} · in {bank name}";
    - "Move to" (bank select, the entry's current bank excluded);
    - the reason.

    Submit calls `propose_bank_move`. The success notice reads "Sent to the committee for approval as {proposal_number}."
  - **The list:** a `bank_move` row reads "{number} · {date} · move to another bank". Its lines show as for a journal.

- [ ] **Step 1:** Make the changes above.
- [ ] **Step 2: Verify:**
  - `bun run typecheck` and `bun run lint` give no errors in the touched files;
  - run the full suite one file at a time; there are no FAIL lines;
  - `bunx next build` compiles.
- [ ] **Step 3: Commit:** `feat(banks): propose moving a receipt, vendor payment or challan to another bank from Adjustments`.
