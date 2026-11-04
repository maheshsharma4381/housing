# Phase 4A — Bills belong to flats, the bill page, per-flat charges, a sole committee member Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The committee can issue bills before any owner has joined. Each owner sees the flat's bills as soon as they join. Every bill has a proper printable page. A charge such as parking can apply to chosen flats only. A society with a single committee member can approve its own vendor bills.

**Architecture:**
- Migration 033.
- `bills.user_id` becomes nullable. `generate_bills` bills every flat, and the payer is the flat's active owner or nobody yet. `attach_flat_owner` hands a joining owner the flat's unclaimed bills, with one notification.
- `billing_rule_units` lists the flats a selected-flats rule applies to.
- `decide_expense` lets the creator approve while they are the only active committee admin. Such bills are marked self-approved.
- `bill_document(p_bill_id)` returns everything the bill page prints. `/bill/[id]` follows the receipt page.

**Tech Stack:** plpgsql, PGlite tests, Next.js 15 client pages, node:test.

**Spec:** `docs/superpowers/specs/2026-10-31-sahvaas-simplify-design.md`:
- 9.1, "My calls": Parking per flat; step 7 issues bills before anyone joins.
- 9.2: bill page.
- 9.3: a society with one committee member.

## Global Constraints
- Bills belong to the flat. Each owner sees all their bills and dues as soon as they join through the joining link. Bills are never public links without login (9.1).
- Bill page:
  - **header:** society name, registration number, address;
  - **member:** name, flat, area, bill number, bill date, period;
  - **charges:** a breakup from `bill_items`;
  - **totals:** previous dues (arrears), the late fee as a line, less advance, then total payable and due date;
  - **footer:** a UPI QR for the exact amount, bank details, the late-fee rule (9.2).
- Self-approval only while the society has exactly **one** active committee admin. Such bills are marked "self-approved" in the audit trail. The normal rule returns when a second admin joins (9.3).
- A selected-flats charge bills no flat until the secretary assigns flats (9.1).
- App UI in English.

## Review Focus
1. **A sold flat with a waiting owner change.** New bills must not go to the seller; today `generate_bills` falls back to `units.current_owner_id`. Expected: nobody, until the buyer joins.
2. **First owner joins.** The flat's unclaimed bills and dues appear for them at once, with one notification, not one per bill.
3. **Member dues report.** A flat with no joined owner shows "Not joined yet", not "Unknown owner". The flat is one row, not split between NULL and owner bills.
4. **Two-step approval with one admin.** Self-approval completes the bill. When a second admin joins, the old rule returns.
5. **Bill page access.** The committee, the bill's owner and a CA with `view_bills` see it; another resident gets "Bill not found".

---

### Task 1: Database (migration 033)

**Files:**
- Create `src/db/migrations/033_flat_bills.sql`, `tests/db/flat-bills.test.mjs`.
- Modify the existing tests that assumed the skip:
  - billing.test.mjs:71-100;
  - integrity.test.mjs:73-78;
  - launch.test.mjs:94;
  - f2.test.mjs:91, :114;
  - operations.test.mjs:175.

**Interfaces:**
- **Bills belong to flats.**
  - `bills.user_id` is nullable, with its foreign key `ON DELETE SET NULL`.
  - `generate_bills` (from 011) takes the payer from the active `resident_owner` membership only, with no `current_owner_id` fallback, else NULL. No flat is skipped for having no owner. The zero-bills message becomes 'No bills to generate: check the billing rules'.
- **A joining owner takes the flat's bills.** `attach_flat_owner` (from 031):
  - in every branch, sets `user_id = p_uid` on bills of that unit whose `user_id IS NULL`;
  - when any were claimed, sends `notify_users(society, [uid], 'bill', 'Bills for Flat {n}', '{count} bills · ₹{due} due', 'bills')`.
- **Per-flat charges.**
  - `billing_rules.applies_to_selected BOOLEAN NOT NULL DEFAULT false`.
  - Table `billing_rule_units(rule_id, unit_id, PRIMARY KEY (rule_id, unit_id))`. RLS: select for `can_view_financials`; writes only through the RPC below.
  - `set_rule_flats(p_rule_id UUID, p_unit_ids UUID[]) RETURNS INT` is committee only and accepts only units of the rule's society. Messages: 'Only the society committee can change billing rules', 'Billing rule not found'.
  - In `generate_bills`, a selected-flats rule applies only to the listed flats.
- **Member dues report.** `member_dues` (from 007) keeps the same columns. It groups one row per flat. `owner_name` is the active owner's name, else the expected owner from `unit_owner_contacts`, else 'Not joined yet'.
- **Self-approval.**
  - `sole_committee_admin(p_society_id) RETURNS BOOLEAN`: true when exactly one active membership has a role in (society_admin, secretary, chairman, treasurer). Granted to authenticated.
  - `decide_expense` (from 008): the creator may decide only when `sole_committee_admin` is true. One approval is then enough, even with two-step approval on. The audit action is 'expense.self_approved'.
- **The bill page.** `bill_document(p_bill_id UUID) RETURNS JSONB`. Access: platform admin, `is_society_admin`, `is_committee_viewer`, the bill's `user_id`, or `has_professional_permission(society,'view_bills')`; otherwise 'Bill not found'. Returns:
  - society: name, registration_number, address, city, upi_id, payee name, bank details;
  - flat: number, wing, area;
  - member name: from the bill's user, else the expected owner;
  - bill: number, dates, period from the cycle, status, items, subtotal, tax, late fee, total, paid, balance;
  - arrears: the balance of the unit's other open bills dated before this bill;
  - advance: from `flat_balance`;
  - payable: balance + arrears − advance, at least 0;
  - late_fee_rule.

- [ ] Write `tests/db/flat-bills.test.mjs` (RED). Cases:
  - bills for a flat with no owner have user_id NULL;
  - the owner joins and claims the bills, with one notification;
  - a waiting owner change bills nobody;
  - a selected-flats rule bills only the listed flats, and none before any are listed;
  - member_dues shows "Not joined yet" as one row;
  - self-approval works with one admin and is refused with two;
  - bill_document returns the totals and refuses another resident.
- [ ] Implement 033 → GREEN. Update the listed tests for the new rule. Run billing, integrity, launch, f2, operations, notifications, joining-link, owner-change and opening-balance one at a time.
- [ ] Commit `feat(bills): bills belong to flats; per-flat charges; a sole committee member approves; bill document`.

### Task 2: Screens

**Files:**
- Create `src/app/bill/[id]/page.tsx` and `src/views/bill/BillPage.tsx`, following the ReceiptPage pattern and its UPI QR.
- Modify:
  - BillingTab: "Applies to: all flats / chosen flats" on a rule, with a flat picker that saves through `set_rule_flats`; skipped-unit reasons stay as they are;
  - ExpensesTab: the creator can decide when `sole_committee_admin`, and the copy says "You are the only committee member, so you approve your own bills";
  - ResidentDashboardPage, BillingTab and the notification link: link each bill to `/bill/{id}`;
  - FinancialReports: no change needed beyond the label;
  - `types/database.ts`: `Bill.user_id: string | null`.

- [ ] Typecheck, lint, the full suite one file at a time, `bunx next build` → commit `feat(bills): printable bill page, chosen-flat charges, self-approval for a sole committee member`.
