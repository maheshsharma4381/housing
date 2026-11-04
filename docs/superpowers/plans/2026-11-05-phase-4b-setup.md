# Phase 4B — Setup in 6 short steps, then the first bill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A secretary sets up a society alone in a few minutes. The steps are: Society → Flats → Maintenance → UPI → Owners → Done, and Done issues the first bills and shares the joining link. Every step is recorded so the platform owner can see where people stop (Phase 6).

**Architecture:**
- Migration 034.
  - `create_society` accepts the short form: name, pincode, city, state and role. The address, email and phone become optional.
  - `setup_maintenance` turns the Maintenance screen into billing rules on the default ledgers, plus the due day and the reminder schedule.
  - `setup_events` records each step through `record_setup_step`.
  - `setup_status` tells the wizard and the dashboard what is done.
- Front end:
  - a `/setup` wizard;
  - a pure flat generator with a preview;
  - a pincode lookup through our own API route, with manual entry as the fallback.

**Tech Stack:** plpgsql, PGlite tests, Next.js 15 route handler, React client components, node:test.

**Spec:** `docs/superpowers/specs/2026-10-31-sahvaas-simplify-design.md` 9.1 (steps 1–7 and "My calls"), 11 item 2 (setup events).

## Global Constraints
- **Society step:** name, pincode (city and state filled in automatically), and "Your role" chips: Secretary / Chairman / Treasurer / Manager. Manager means society_admin. Address, registration number and contact details move to the Society profile screen for later.
- **Flats step:**
  - wing chips plus "Add wing", the number of floors, and flats per floor;
  - a preview such as "56 flats will be created: A-101 … A-704, B-101 … B-704", then create;
  - "Or upload from Excel" stays as an alternative.
- **Maintenance step:**
  - "Same for all" (₹ per flat per month) or "Per sq.ft". Per sq.ft asks the area per flat position ("all …01 flats = X sq.ft").
  - Extra charges as toggles with amounts: Sinking fund, Repair fund, Parking.
  - Due day of the month.
  - "Remind ___ days after the due date, then every ___ days" (defaults 3 and 7).
  - No ledgers or account codes on this screen.
  - Charges post to the default ledgers: Maintenance Charges 4000, Sinking Fund 3000, Repair & Maintenance Fund 3100, Other Income 4200.
  - Parking bills no flat until flats are assigned (033 `applies_to_selected`).
  - The late fee stays in Society settings.
- **UPI step:** the UPI ID and payee name, with a preview of the QR residents will see.
- **Owners step:** a table of flats with owner name and mobile, plus "Paste from Excel". **Skip** is allowed.
- **Done step:**
  - "Your society is ready";
  - a preview of the first month's bills (count and total) and **Send bills**;
  - "Share joining link in your society WhatsApp group";
  - optional "Invite your CA";
  - "Add your treasurer or chairman";
  - "Not now, go to dashboard".
- The pincode lookup uses a free public service, with manual entry as the fallback.
- App UI in English.

## Review Focus
1. **Resuming.** A secretary who leaves halfway and comes back resumes at the first unfinished step. No second society is created.
2. **Running Maintenance again.** It updates the rules setup made and never duplicates them. Rules the CA added are untouched.
3. **Flat generator edge cases:** one wing; flats per floor above 9 (A-110); a ground floor (G01 numbering is not used: floors start at 1). A wing name with spaces is refused.
4. **Pincode lookup down or slow.** Manual city and state entry still works within 3 seconds.
5. **Send bills before any owner has joined.** Bills are issued (033). The Done step then shows the joining link.

---

### Task 1: Database (migration 034)

**Files:** Create `src/db/migrations/034_setup.sql` and `tests/db/setup.test.mjs`. Modify `tests/db/onboarding.test.mjs` only where the old required-field messages are asserted.

**Interfaces:**
- **`create_society`** (redefined from 005, same signature):
  - `p_address_line1`, `p_contact_email` and `p_contact_phone` may be NULL or empty. When given, they are still validated with the same messages. Empty values are stored as ''.
  - It records the setup step 'society'.
- **`setup_events`** table: `(society_id, step, user_id, created_at)`, unique (society_id, step).
  - `record_setup_step(p_society_id UUID, p_step TEXT)`. The steps are society, flats, maintenance, upi, owners, owners_skipped, first_bill.
  - It is committee only, idempotent, and rejects an unknown step with 'Unknown setup step'.
- **`billing_rules.setup_key`** (TEXT NULL) with a unique index on (society_id, setup_key) where not null.
- **`setup_maintenance(p_society_id, p_mode TEXT, p_rate NUMERIC, p_extras JSONB, p_due_day INT, p_first INT, p_every INT) RETURNS INT`:**
  - `p_mode` is 'flat' or 'sqft'.
  - `p_extras` is `[{key:'sinking'|'repair'|'parking', amount}]`. A key that is absent turns that rule inactive.
  - It upserts the rules by setup_key:
    - maintenance → 'Maintenance', 4000, flat_per_unit or per_sqft;
    - sinking → 'Sinking Fund', 3000, flat;
    - repair → 'Repair Fund', 3100, flat;
    - parking → 'Parking', 4200, flat, `applies_to_selected` true.
  - It sets `society_settings.due_day_of_month` and calls `set_reminder_schedule`.
  - It records 'maintenance' and returns the count of active setup rules.
  - Messages:
    - 'Only the society committee can set up maintenance'
    - 'Enter the maintenance amount'
    - 'Due day must be between 1 and 28'
- **`setup_status(p_society_id) RETURNS JSONB`:** `{steps: text[], flats, rules, upi, owners_entered, bills, joined_owners}`. Committee viewers only.
- **`generate_bills`:** no change. Instead, the Done step calls `record_setup_step('first_bill')` after a successful send.

- [ ] Tests (RED):
  - the short-form create works for a phone-only user (no email or phone);
  - an invalid email given is still refused;
  - steps are recorded and idempotent;
  - setup_maintenance creates 4 rules with the right codes, parking applies to selected flats, a second run updates rather than duplicates, and a CA's own rule is untouched;
  - setup_status counts.
- [ ] Implement → GREEN. Run onboarding, billing and flat-bills one at a time.
- [ ] Commit `feat(setup): short society form, maintenance setup, setup steps recorded`.

### Task 2: The wizard

**Files:**
- Create:
  - `src/lib/flat-generator.ts`: `generateFlats({wings, floors, perFloor, areaByPosition?}) → {rows, preview}`, where rows match `bulk_upsert_units`;
  - `tests/unit/flat-generator.test.ts`;
  - `src/lib/pincode.ts` (`parsePincodeReply`) with `tests/unit/pincode.test.ts`;
  - `src/app/api/pincode/[pin]/route.ts`;
  - `src/app/setup/page.tsx` and `src/views/setup/SetupWizard.tsx`.
- Modify:
  - `OnboardingPage`: "Register your society" goes to `/setup`;
  - `SocietyDashboardPage`: the old checklist becomes a "Finish setup" card linking to `/setup` while steps remain.

**Unit tests:**
- `generateFlats({wings:['A','B'], floors:7, perFloor:4})` gives 56 rows. The preview is "56 flats will be created: A-101 … A-704, B-101 … B-704". perFloor 12 gives A-112. One wing with an empty name gives 101…. Area by position applies to every "…01" flat.
- `parsePincodeReply`, from the api.postalpincode.in shape, returns `{city: District, state: State}` or null.

**Wizard:**
- **Resume:** it reads `setup_status` to pick the first unfinished step; the Society step is done once the society exists.
- **Each step:** saves, records its step, then moves on.
- **Done:** a `generate_bills` dry run for the current month gives the count and total. Send bills runs the real one and records first_bill. Share link uses JoinLinkCard.

- [ ] Unit tests RED → GREEN; typecheck, lint, the full suite, build → commit `feat(setup): six-step setup wizard with flat generator, pincode lookup and first bills`.
