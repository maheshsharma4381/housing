# Phase 1 — Free = Basic minus ads: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Free plan the CA & auditor portal and the asset register so that Free and Basic differ only in ads, and make every plan message say so.

**Architecture:** Plan contents live in the `subscription_plans` table (`feature_keys`, `features_included`, `description`, `show_ads`), and entitlements are checked in Postgres by `society_has_feature()` / `require_feature()`. A new migration updates the Free and Basic rows and makes `require_feature()` name the plans from the table instead of a hard-coded "Basic and Pro". The React screens only change copy.

**Tech Stack:** Supabase Postgres (SQL migrations), PGlite DB tests (`node --test`), Next.js 15 / React 19 / TypeScript.

**Spec:** `docs/superpowers/specs/2026-10-31-sahvaas-simplify-design.md`, section 6 (Phase 1).

## Global Constraints

- Never edit migrations `001`–`017`. New schema/data changes go in `src/db/migrations/018_free_plan_features.sql`.
- After adding or changing a migration, regenerate the consolidated file with `bun run db:bundle`; `tests/db/consolidated.test.mjs` fails otherwise.
- All UI text is English.
- Pro is unchanged: `feature_keys = {ca_portal,asset_register,gst_recon,tds_register,bank_match,tally_export}`, ₹18/flat/month.
- Line endings are LF (the repo has `core.autocrlf=input`).
- Do not commit unless the user has said to; if they have, work on a branch, not `main`.
- Do not touch the live Supabase database except in Task 3, and only after the user says go.

## Review Focus

1. **Societies already on Free with paused CA grants** — after the migration their existing CA/auditor regains access with no re-invite (grants were kept, only paused). Pinned in Task 1 (`CA keeps access on Free`).
2. **A feature that no active plan includes** (the platform owner unticks it everywhere in Billing & Plans) — the error must read "… is not part of any current plan", never "part of the  plan". Pinned in Task 1.
3. **Pro row left alone** — the migration updates only `free` and `basic` by `tier_code`; Pro's features and text are unchanged. Pinned in Task 1.
4. **Downgrading from Pro to Free** — the confirm dialog must still warn that Pro features lock; from Basic it must only mention ads. Checked manually in Task 2.
5. **Public pricing page when the database is unreachable** — the fallback cards must match the new rows exactly. Checked manually in Task 2.

---

### Task 1: Database — Free gets the CA portal and asset register; plan names come from the table

**Files:**
- Create: `src/db/migrations/018_free_plan_features.sql`
- Modify: `src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql` (regenerated, not hand-edited)
- Test: `tests/db/saas-billing.test.mjs` (rewrite the test at lines 120–147; add two tests)

**Interfaces:**
- Consumes: `society_has_feature(uuid, text)`, `society_plan(uuid)`, `tds_register(uuid, date, date)`, `run_subscription_lifecycle()`, `choose_plan(uuid, text, text)`, `platform_mark_invoice_paid(uuid, text)` (all from `015`), test helpers `q`, `val`, `sub`, `ids` already in the file.
- Produces: `public.require_feature(p_society_id UUID, p_key TEXT, p_label TEXT) RETURNS VOID` with data-driven messages (same signature as today, so all callers in `015` and `017` keep working).

- [ ] **Step 1: Rewrite the lifecycle test for the new Free plan**

Replace the test titled `'trial over without paying: Free plan, ads on, CA portal and asset register locked; paying restores them'` with one titled `'trial over without paying: Free keeps the CA portal and asset register, shows ads and locks Pro; Basic removes ads'`. Keep its setup (CA invited and accepted during trial, one expense, trial ended, lifecycle run, `ids.ca = ca` at the end) and assert:

```js
const plan = await val(C.admin, 'SELECT public.society_plan($1)', [C.id]);
assert.deepEqual([plan.plan_code, plan.show_ads, plan.features], ['free', true, ['ca_portal', 'asset_register']]);
assert.equal(await val(ca, 'SELECT count(*)::int FROM expenses'), 1, 'CA keeps access on Free');
await q(C.admin, `INSERT INTO professional_invites (society_id, invited_email, role, permissions, invited_by, expires_at)
  VALUES ($1,'ca2@saas.test','ca','["view_reports"]',$2, now() + interval '7 days')`, [C.id, C.admin]); // must not throw
assert.equal(await val(C.admin, `SELECT public.society_has_feature($1,'asset_register')`, [C.id]), true);
await assert.rejects(q(C.admin, `SELECT * FROM public.tds_register($1, current_date - 30, current_date)`, [C.id]),
  /The TDS register is part of the Pro plan — upgrade under Plan & Billing/);

const r = await val(C.admin, `SELECT public.choose_plan($1,'basic','annual')`, [C.id]);
assert.equal(r.period_start, today, 'no trial left: the plan starts today');
await q(ids.owner, `SELECT public.platform_mark_invoice_paid($1,'NEFT-C1')`, [r.invoice_id]);
const basic = await val(C.admin, 'SELECT public.society_plan($1)', [C.id]);
assert.deepEqual([basic.plan_code, basic.show_ads], ['basic', false], 'Basic only removes ads');
assert.equal(await val(ca, 'SELECT count(*)::int FROM expenses'), 2, 'CA still sees everything (incl. the Sahvaas bill)');
```

- [ ] **Step 2: Add a test that pins the plan rows**

Test `'plans: Free and Basic differ only in ads; Pro unchanged'`, querying `subscription_plans` as `db` (superuser):

```js
const rows = Object.fromEntries((await db.query(
  `SELECT tier_code, feature_keys, features_included, description, show_ads FROM subscription_plans WHERE tier_code IN ('free','basic','pro')`
)).rows.map((p) => [p.tier_code, p]));
assert.deepEqual(rows.free.feature_keys, ['ca_portal', 'asset_register']);
assert.deepEqual(rows.basic.feature_keys, ['ca_portal', 'asset_register']);
assert.deepEqual([rows.free.show_ads, rows.basic.show_ads], [true, false]);
assert.deepEqual(rows.free.features_included, ['Billing & UPI collection', 'Receipts', 'Notices & tickets', 'Double-entry books', 'CA & auditor portal', 'Asset register & depreciation']);
assert.equal(rows.free.description, 'Everything to run the society, including the CA portal. Residents see a few local offers.');
assert.deepEqual(rows.basic.features_included, ['Everything in Free', 'No ads']);
assert.equal(rows.basic.description, 'Everything in Free, without ads.');
assert.equal(rows.pro.feature_keys.length, 6);
assert.equal(rows.pro.features_included[0], 'Everything in Basic');
```

- [ ] **Step 3: Add a test for a feature no plan includes**

Test `'a feature no active plan includes says so'`, placed right after the lifecycle test so society C is on Basic: in a `try/finally`, remove `tds_register` from every plan (`UPDATE subscription_plans SET feature_keys = array_remove(feature_keys, 'tds_register')`), call `tds_register` for society C (now on Basic), and assert it rejects with `/The TDS register is not part of any current plan/`; in `finally`, restore Pro's keys to the six listed in Global Constraints.

- [ ] **Step 4: Run the tests and see them fail**

Run: `node --test tests/db/saas-billing.test.mjs`
Expected: FAIL. Free `features` is `[]`, the invite raises "part of the Basic and Pro plan", and the plan-row and no-plan tests fail.

- [ ] **Step 5: Write `018_free_plan_features.sql`**

- `UPDATE subscription_plans` for `tier_code = 'free'` and `'basic'` to the exact `feature_keys`, `features_included` (jsonb) and `description` values in Step 2. Leave `show_ads`, prices and the Pro row alone.
- `CREATE OR REPLACE FUNCTION public.require_feature(p_society_id UUID, p_key TEXT, p_label TEXT) RETURNS VOID`, same `LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public` as in `015`. If `society_has_feature()` is false, read the names of active plans whose `feature_keys` contain `p_key`, ordered by `sort_order`. Format them as `A`, `A and B`, or `A, B and C`, then raise either `'<label> is part of the <names> plan — upgrade under Plan & Billing'` or, if no plan has the feature, `'<label> is not part of any current plan'`.
- Re-apply the `REVOKE ALL … FROM PUBLIC, anon, authenticated` that `015` sets on `require_feature`. Check the `REVOKE`/`GRANT` block at the end of `015` and copy what it does for this function.
- Header comment in the style of `015`: what changed and why (Free = Basic minus ads).

- [ ] **Step 6: Regenerate the consolidated file**

Run: `bun run db:bundle`
Expected: prints `ALL_MIGRATIONS_CONSOLIDATED.sql <- 001_… , 018_free_plan_features.sql`

- [ ] **Step 7: Run the DB tests and see them pass**

Run: `node --test tests/db/saas-billing.test.mjs tests/db/consolidated.test.mjs`
Expected: all pass, 0 fail.

- [ ] **Step 8: Run the full suite**

Run: `bun run test`
Expected: `ℹ fail 0`. The total should be 163: the 161 existing tests plus the 2 new ones.

- [ ] **Step 9: Commit (only if the user has approved commits)**

```bash
git add src/db/migrations/018_free_plan_features.sql src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql tests/db/saas-billing.test.mjs
git commit -m "feat(plans): Free includes CA portal and asset register; plan names in feature errors come from the plans table"
```

---

### Task 2: Screens — every plan message matches "Basic only removes ads"

**Files:**
- Modify: `src/lib/billing.ts:3-13` (`FEATURES`, `featurePlan`)
- Modify: `src/views/society/SocietyDashboardPage.tsx:159-163` (plan banner), `:458`, `:497`, `:503` (`FeatureGate planName`)
- Modify: `src/components/PlanBilling.tsx:65` (switch-to-Free confirm), `:118` (Free plan line)
- Modify: `src/views/public/PricingPage.tsx:11-18` (`FALLBACK`)

**Interfaces:**
- Consumes: the plan rows from Task 1 (the fallback must copy them exactly).
- Produces: `FEATURES: { key: PlanFeature; label: string; plan: 'every plan' | 'Pro' }[]` and `featurePlan(key: string): 'every plan' | 'Pro'` (default `'Pro'`) in `src/lib/billing.ts`.

- [ ] **Step 1: `src/lib/billing.ts`**

Change the `plan` union to `'every plan' | 'Pro'` and set `ca_portal` and `asset_register` to `'every plan'`. The other four stay `'Pro'`.

- [ ] **Step 2: `SocietyDashboardPage.tsx`**

- Pass `planName={featurePlan('asset_register')}`, `planName={featurePlan('ca_portal')}` and `planName={featurePlan('bank_match')}` to the three `FeatureGate`s, importing `featurePlan` next to `daysUntil`.
- Replace the two banner texts with:
  - trial ≤ 7 days: `` `Free trial ends in ${trialLeft} day${trialLeft === 1 ? '' : 's'}. After that you move to Free: residents see a few local offers and Pro tools (GSTR-2B, TDS register, bank statement match, Tally export) lock. Choose Basic to stay ad-free, or Pro to keep them.` `` (amended after final review: the trial has Pro features, so ads are not the only change)
  - on Free: `'You are on the Free plan — residents see a few local offers. Choose Basic to remove them.'`

- [ ] **Step 3: `PlanBilling.tsx`**

- Confirm text when switching to Free:
  - if `plan?.paid_plan_code === 'pro'`: `'Switch to the Free plan? Residents will see a few local offers, and Pro features (GSTR-2B, TDS register, bank statement match, Tally export) will be locked. No data is deleted.'`
  - otherwise: `'Switch to the Free plan? Residents will see a few local offers. No data is deleted.'`
- Free plan status line: `'Residents see a few local offers. Choose Basic to remove them.'`

- [ ] **Step 4: `PricingPage.tsx` fallback**

Set the `free` and `basic` entries' `description` and `features_included` to the exact values pinned in Task 1 Step 2. Leave Pro unchanged.

- [ ] **Step 5: Static checks**

Run: `bun run typecheck && bun run lint`
Expected: both exit 0 with no errors.

- [ ] **Step 6: Check the copy is gone**

Run: `grep -rnE "unlock the CA|Basic and Pro|For societies that work with a CA" src --include=*.tsx --include=*.ts`
Expected: no output.

- [ ] **Step 7: Manual check in the running app**

Start `bun run dev`. Then check:
- `/pricing`: the Free card lists "CA & auditor portal" and "Asset register & depreciation"; the Basic card lists only "Everything in Free" and "No ads".
- Committee login → Plan & Billing: both confirm dialogs read as in Step 3. To see the Pro one, set a test society to Pro the same way `tests/db/ads.test.mjs` does with `setPlan`. Cancel each dialog without confirming.

- [ ] **Step 8: Commit (only if the user has approved commits)**

```bash
git add src/lib/billing.ts src/views/society/SocietyDashboardPage.tsx src/components/PlanBilling.tsx src/views/public/PricingPage.tsx
git commit -m "feat(plans): plan copy says Basic only removes ads"
```

---

### Task 3: Apply to the live Supabase database (only after the user says go)

**Files:** none changed.

- [ ] **Step 1: Dry run**

Run: `bun run db:migrate`
Expected: `Connected to db.…supabase.co:5432` and exactly one pending migration, `018_free_plan_features.sql`.

- [ ] **Step 2: Ask the user, then apply**

Run (after the user's OK): `bun run db:migrate --apply`
Expected: `018_free_plan_features.sql` applied; a second dry run says `Database is up to date.`

- [ ] **Step 3: Verify live**

With `bun run dev` running, `/pricing` shows the new Free and Basic cards from the live database. To confirm they came from the database rather than the fallback, check that the network request to `subscription_plans` returns the new `features_included`.
