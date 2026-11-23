# Phase 11C (shifting: charges and refundable deposits) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner or tenant books a move-in or move-out; on approval the society's shifting charge and refundable deposit are billed to the flat (charge as income, deposit as a liability); after the move the committee refunds the deposit in full or with a recorded deduction, all in the books.

**Architecture:** A `shifting` kind on the 11A request engine. Approval (redefined `decide_request`) bills the flat through a new one-off flat charge (a bill in a one-day "Flat charges" cycle) whose lines point at two hidden system billing rules crediting new ledgers 4400 "Shifting charges" (income) and 2400 "Deposits received" (liability); the existing bill posting does the rest. A refund posts its own journal: debit 2400, credit the bank (refund) and 4500 "Damage recovery" (deduction).

**Tech Stack:** Next.js 15, React 19, Tailwind v4, Supabase Postgres, PGlite DB tests, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-24-flat-changes-design.md` (section 5.4)

**Choices the spec left open, made here:**
- Ledgers are made on first use: `2400 Deposits received` (liability), `4400 Shifting charges` (income), `4500 Damage recovery` (income); the CA can rename them or move them between groups.
- System billing rules (`is_system`, never active, hidden from Maintenance bills) carry the ledger of each one-off line, so the existing bill posting, receipts, statements and bill page work unchanged.
- One bill per approved shifting, with up to two lines (charge, deposit); none when both are ₹0. Due in 7 days. Bill numbers `C{YYMM}-{nnnn}`.
- A refund needs the shifting bill fully paid (`The deposit has not been paid yet`). The refund is paid from the society's default payment bank ledger, dated the day it is recorded.
- Shifting date: today to 90 days ahead; time inside the society's hours (default 08:00–20:00, every day).
- Charges are read from the settings at approval and kept on the shifting record.

## Global Constraints

- Migration `src/db/migrations/042_shifting.sql` (Gate Lite moves to 043); `bun run db:bundle`. Never edit 001–041. `decide_request` is copied verbatim from 041 and changed only by the shifting branch.
- Applicants: an owner of the flat (`is_flat_owner`), an active tenant of the flat, or a managing role. Error: `Only someone living in this flat can book shifting`.
- Messages, exactly: `Choose moving in or moving out`, `Choose a date from today up to 90 days ahead`, `Shifting is allowed between {HH:MM} and {HH:MM}`, `Vehicle details can be up to 80 characters`, `Amounts must be between ₹0 and ₹1,00,000`, `Choose the shifting hours`, `The deposit has not been paid yet`, `This deposit has already been refunded`, `The amount kept can be at most the deposit`, `Write why part of the deposit is kept`, `Only the committee can refund deposits`.
- Settings warning on screen, exactly: `Charge only what your bye-laws or a general body resolution allow.`
- Notifications: managing roles on a booking (`Shifting booked for flat {label} on {DD Mon YYYY}`); applicant and owners on approval (`Shifting approved for flat {label} on {DD Mon YYYY}`), on refund (`Shifting deposit refunded: {₹}`).
- English UI; all plans. DB tests one file at a time with `TZ=UTC`. Branch `phase-11c-shifting`; commits with `git -c user.name=ved300406 -c user.email=ved300406@gmail.com`, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push; never `db:migrate --apply`.

## Review Focus

1. The deposit sits in "Deposits received", never in income; after a full refund that ledger is back to zero for the flat's deposit (Task 3).
2. A refund with ₹2,000 kept from ₹10,000: bank −8,000, Damage recovery +2,000, Deposits received −10,000, journal balanced (Task 3).
3. Charges of ₹0 make no bill; a charge-only society makes a one-line bill (Task 2).
4. Turning a system rule on, or it appearing in Maintenance bills, is impossible (Task 1).
5. A tenant books their own move-out; another flat's resident cannot (Task 2).

---

### Task 1: Ledgers, system rules, settings and the one-off flat charge

**Files:** Create `042_shifting.sql` (section 1); Test `tests/db/shifting.test.mjs`

**Produces:**
- `billing_rules.is_system BOOLEAN NOT NULL DEFAULT false` with `CHECK (NOT (is_system AND is_active))`.
- `ensure_flat_change_ledgers(p_society_id uuid) RETURNS void` (helper): the three accounts above (ON CONFLICT DO NOTHING; group from `default_account_group`).
- `system_rule(p_society_id uuid, p_key text) RETURNS uuid` (helper): keys `shifting_charge` (4400, "Shifting charges") and `shifting_deposit` (2400, "Shifting deposit (refundable)"); inactive, `calculation_type 'manual'`, rate 0, `is_system`.
- `charge_flat(p_unit_id uuid, p_lines jsonb, p_due_date date) RETURNS uuid` (helper): lines `[{rule_key, description, amount}]`, amounts > 0 only; finds or makes the cycle "Flat charges" for today (period today–today); bill `C{YYMM}-{nnnn}` to the flat's first joined owner; items with the system rule ids; returns the bill id or NULL when no line is above 0.
- `society_settings` columns: `move_in_charge, move_in_deposit, move_out_charge, move_out_deposit NUMERIC(10,2) DEFAULT 0` (0–100000), `shifting_from TIME DEFAULT '08:00'`, `shifting_to TIME DEFAULT '20:00'`; `set_shifting_settings(p_society_id uuid, p_settings jsonb)` (managing roles).

- [ ] Tests: `the one-off charge posts to the right ledgers` (charge 1000 + deposit 5000 → bill total 6000, journal: 1200 +6000, 4400 −1000, 2400 −5000, sums to 0; flat dues 6000); `nothing to charge makes no bill`; `system rules stay off and out of billing` (activating one raises; `generate_bills` ignores them); `shifting settings` (managing only; bad amounts and hours → messages).
- [ ] RED → implement → GREEN → commit `feat(shifting): deposits ledger, system rules and one-off flat charges (042)`.

### Task 2: Booking and approval

**Files:** Modify `042_shifting.sql` (section 2: `shiftings`, `create_shifting_request`, `decide_request` redefined); Test `tests/db/shifting.test.mjs`

**Produces:**
- `shiftings(id uuid pk, society_id, unit_id, request_id unique, direction varchar(3) check in ('in','out'), shift_date date, shift_time time, vehicle text, charge_amount numeric, deposit_amount numeric, bill_id uuid, deposit_status varchar(10) check in ('none','held','refunded'), kept_amount numeric, kept_reason text, refunded_on date, refund_journal_id uuid, created_at)`; RLS SELECT via `can_see_request(request_id)`.
- `create_shifting_request(p_unit_id uuid, p_details jsonb) RETURNS uuid` (`direction, date, time, vehicle`); checklist from `request_checklists` kind `shifting` (default empty).
- `decide_request` shifting branch on approve: reads the settings for the direction, `charge_flat`s the flat, inserts the `shiftings` row (`deposit_status` `held` when a deposit was billed, else `none`), notifies; returns `{status, shifting_id, bill_id}`.

- [ ] Tests: `an owner books a move-in and the committee is told`; `a tenant books their move-out; another flat cannot`; `booking checks` (direction, date range, outside hours, vehicle length); `approval bills the charges` (bill lines and amounts from the settings for the direction; shifting row with amounts and `held`); `free shifting makes no bill` (`bill_id` NULL, `deposit_status 'none'`).
- [ ] RED → implement → GREEN; `flat-requests.test.mjs` and `tenancy.test.mjs` → PASS; commit `feat(shifting): booking and approval bills the flat`.

### Task 3: Deposit refunds

**Files:** Modify `042_shifting.sql` (section 3); Test `tests/db/shifting.test.mjs`

**Produces:** `refund_shifting_deposit(p_shifting_id uuid, p_kept numeric, p_reason text) RETURNS uuid` (managing roles): bill fully paid; `p_kept` 0..deposit; reason (3–200) when `p_kept > 0`; posts `deposit.refunded` journal (2400 +deposit; bank −(deposit − kept); 4500 −kept), sets `refunded`, `kept_*`, `refunded_on`, `refund_journal_id`; event `deposit_refunded` on the request; notification. Returns the journal id.

- [ ] Tests: `an unpaid deposit cannot be refunded`; `a full refund` (after a verified payment: journal 2400 +5000, bank −5000; status refunded; 2400 balance for the society back to 0 when nothing else is held); `a refund with an amount kept` (2,000 of 10,000: bank −8,000, 4500 −2,000; reason required); `keeping the whole deposit` (no bank line); `checks` (twice → `This deposit has already been refunded`; kept > deposit; committee member and owner refused).
- [ ] RED → implement → GREEN; `bank-ledgers.test.mjs`, `ledger.test.mjs` → PASS; commit `feat(shifting): deposit refunds in the books`.

### Task 4: Helpers and screens

**Files:** Create `src/lib/shifting.ts`, `src/components/ShiftingForm.tsx`, `src/components/Shiftings.tsx`, `src/components/ShiftingSettings.tsx`; Modify `MyRequests.tsx` (Book shifting), `RequestDetail.tsx` (shifting details, bill link, deposit state), `FlatRequests.tsx` (a **Shifting** view: upcoming and recent shiftings, deposits held with **Refund deposit**, settings), `BillingTab.tsx` (hide `is_system` rules); Test `tests/unit/shifting.test.ts`

**Produces:** `shiftingDraftError(d, today, from, to)` mirroring the DB checks; `refundSplit(deposit, kept): {refund, kept}` with the DB's errors; `DIRECTION_LABELS` (`in` → `Moving in`, `out` → `Moving out`); `DEPOSIT_LABELS` (`none` → `No deposit`, `held` → `Deposit held`, `refunded` → `Deposit refunded`).

- [ ] Unit tests → RED → implement → GREEN; screens; typecheck, lint (0 errors), build; commit `feat(shifting): booking, refunds and settings screens`.

### Task 5: Bundle, docs, verification

- [ ] `bun run db:bundle`; every DB and unit test → 0 fail; typecheck, lint, build.
- [ ] Gate Lite docs: 042 → 043.
- [ ] Report section "Phase 11C — shifting charges and deposits (migration 042)"; next steps list 039–042.
- [ ] Commit `docs(report): Phase 11C (migration 042)`.
