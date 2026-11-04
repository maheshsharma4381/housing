# Phase 4C — The secretary's menu, Home and Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- The menu has 12 items in 4 groups.
- On a phone, a bottom bar shows Home · Bills · Payments · Complaints · More.
- Home has four cards (To receive, To pay, Approvals, Payments to verify), and each opens a working list.
- Approvals collects everything the committee approves, vendor bills included.

**Architecture:**
- Migration 035 adds:
  - `remind_overdue_flats(society)`, which sends "Send reminder to N overdue flats" as in-app and push notifications, de-duplicated per bill per day like the nightly reminders;
  - `home_cards(society)`, which returns the four card figures in one call.
- `society-nav.ts` gets the grouped menu.
- The "Flats & residents" screen shows Flats and Members on one screen.
- New components: `HomeCards`, `ToReceiveList`, `ToPayList`, `PendingVendorBills`.

**Tech Stack:** plpgsql, PGlite tests, React, node:test.

**Spec:** `docs/superpowers/specs/2026-10-31-sahvaas-simplify-design.md` 9.3 (menu, Approvals, phone bar) and 9.4 (Home).

## Global Constraints
- **Menu groups:**
  - **(top):** Home, Approvals;
  - **Money:** Maintenance bills, Payments received, Vendor bills, Reports;
  - **Society:** Flats & residents (flats, members and owner change on one screen), Notices, Complaints, Documents;
  - **Settings:** Society settings, CA & auditor, Plan & billing.
- **Approvals:** vendor bills, CA adjustments, the opening balance, unknown join requests.
- **Phone:** a bottom bar with Home · Bills · Payments · Complaints · More. "More" opens the remaining items.
- **Home cards:**
  - **To receive:** amount, number of flats, how many are overdue;
  - **To pay:** amount, number of vendors, how many are due this week;
  - **Approvals:** count, with a breakdown;
  - **Payments to verify.**
- **"To receive"** opens a flat-wise list sorted by oldest due, with "Send reminder to N overdue flats" (in-app plus push).
- **"To pay"** opens a vendor-wise list with due dates and TDS already worked out, plus "Record a payment".
- The Accountant's Accounts group stays for a committee member who is the Accountant (2D).

## Review Focus
1. Old links such as `?tab=members` and notification links ('members', 'bills') still open the right screen.
2. The reminder button pressed twice in a day sends each owner one reminder, not two. Flats with nobody joined are counted as "not reachable", not as reminded.
3. A read-only committee member sees the cards and lists but no Send-reminder or Approve buttons.
4. The vendor bills in Approvals follow the same approval rules as the Vendor bills screen: a maker cannot approve their own bill unless they are the sole committee member.

---

### Task 1: Database (migration 035)

**Files:** Create `src/db/migrations/035_home.sql` and `tests/db/home.test.mjs`.

**Interfaces:**
- **`home_cards(p_society_id) RETURNS JSONB`.** Requires `can_view_financials` or a committee viewer. It returns:
  - `to_receive {amount, flats, overdue_flats}`;
  - `to_pay {amount, vendors, due_this_week}`: outstanding approved or partly paid vendor bills, with due within 7 days by `due_date` when present, else `bill_date` + 30;
  - `approvals {vendor_bills, adjustments, opening_balance, join_requests, total}`;
  - `payments_to_verify`.
- **`remind_overdue_flats(p_society_id) RETURNS JSONB {reminded, not_joined}`.** Committee admins only, with the message 'Only the society committee can send reminders'.
  - For every overdue open bill (due_date < today, balance > 0) whose user is an active owner of the flat, it inserts a notification of kind 'dues_reminder' with ref_id = bill and ref_date = today. ON CONFLICT DO NOTHING handles the dedupe.
  - `reminded` counts flats newly notified today. `not_joined` counts overdue flats with no owner joined.
  - It writes the audit entry 'dues.reminders_sent'.

- [ ] Tests (RED):
  - the cards' numbers on a small society: 3 flats, an overdue bill, a pending payment, a vendor bill pending approval and one approved and unpaid, a join request;
  - reminders sent once a day;
  - a flat nobody has joined is counted as not_joined;
  - a read-only member and an outsider are refused.
- [ ] Implement → GREEN; run notifications and flat-bills → commit `feat(home): home cards and one-tap reminders to overdue flats`.

### Task 2: Screens

**Files:**
- Modify:
  - `src/lib/society-nav.ts`: `NavItem.group` becomes 'top' | 'money' | 'society' | 'settings' | 'accounts', with the new labels; `societyTabFor(link)` maps old ids ('members' → 'flats') and notification links;
  - `tests/unit/society-nav.test.ts`;
  - `src/views/society/SocietyDashboardPage.tsx`: grouped sidebar, phone bar, Home cards, Flats & residents with Flats | Members sub-views;
  - the Approvals tab: PendingVendorBills first.
- Create `src/components/HomeCards.tsx` and `src/components/PendingVendorBills.tsx`.

**Unit tests:**
- `societyNav({isAccountant:false})` gives 12 items with groups [top×2, money×4, society×4, settings×3]... 2+4+4+3 = 13. Ruling: "12 items" in the spec counts Flats & residents as one, and Settings has three items (Society settings, CA & auditor, Plan & billing), so the list is 13. Take the spec's table as binding and the count as approximate.
- `societyTabFor('members')` is 'flats'; `societyTabFor('bills')` is 'billing'; `societyTabFor('nonsense')` is 'home'.
- The phone bar ids are ['home', 'billing', 'payments', 'complaints'].

- [ ] Unit tests RED → GREEN; typecheck, lint, the full suite, build → commit `feat(menu): grouped secretary menu, phone bar, Home cards and Approvals with vendor bills`.
