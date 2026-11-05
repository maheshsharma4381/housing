# Phase 9 — Loose ends people would notice or that give a wrong number

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear ten deferred minors from `docs/superpowers/autonomous-run-report.md` that the product owner approved on 2026-11-05 ("HAAN"): the ones a person would notice, or that could print a wrong tax, bank or mobile.

**Architecture:** One new migration, `038_loose_ends.sql`, carries every database change. Redefined functions are copied verbatim from their latest migration with only the marked lines changed. Screen changes go through small pure helpers in `src/lib/` that have unit tests. No new tables.

**Tech Stack:** Next.js 15, React 19, Supabase Postgres (plpgsql, RLS), PGlite tests (`tests/db/harness.mjs`), `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-31-sahvaas-simplify-design.md`. In particular: 7.1 call 10 (the default receiving bank is set by the CA); 8.1 (mobile login, foreign numbers allowed); 8.2 (joining link); 8.3 (notifications); 9.1 (setup); 10.2 (My account).

## Global Constraints

- App UI copy in plain English. No new jargon.
- Migrations: `src/db/migrations/038_loose_ends.sql`, idempotent (`CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS`). Then `bun run db:bundle`. Never applied live by the builder.
- `SECURITY DEFINER SET search_path = public` on every new or redefined function. Helpers stay revoked from `authenticated`.
- DB tests: one file at a time with `TZ=UTC`.
- Commits on branch `phase-9-loose-ends` with `git -c user.name=ved300406 -c user.email=ved300406@gmail.com`. Never pushed without asking.

## Review Focus

1. Closing waiting requests and invites must stay inside one society and one person. Another society's request, or an invite to a different person for the same flat (a joint owner), stays open.
2. If the server's VAPID keys are wrong, every push answers 403 and every subscription is deleted. A browser must quietly save a fresh subscription on its next app open.
3. Old societies typed their state freely ("MH", "maharashtra ", "Orissa"). The GST split must still say CGST+SGST for the same state, and must fall back to the old name comparison for text it cannot place.
4. Going Back in the wizard after flats exist or bills were sent must never duplicate flats or issue bills again.
5. A number typed `+91 0 98765 43210` must match the same owner as `98765 43210` everywhere a mobile is compared: owner contacts, invites and the joining link.

---

### Task 1: Mobiles with a 0 after the country code

**Files:**
- Modify: `src/lib/mobile.ts` (`normalizeMobile`)
- Create: `src/db/migrations/038_loose_ends.sql` (section 1)
- Test: `tests/unit/mobile.test.ts`, `tests/db/loose-ends.test.mjs` (new)

**Interfaces:** Produces: `normalize_mobile(text)`, which now drops the trunk `0` after `91` (`+91 0…`, `0091 0…`). Rule: an international number of `91` + `0` + 10 digits becomes `91` + 10 digits. Both the TS and SQL versions follow it.

- [ ] Test (unit), `trunk zero after +91 is dropped`: `'+91 0 98765 43210'`, `'0091 098765 43210'` and `'+91 (0) 98765-43210'` all become `'919876543210'`. `'0091 98765 43210'` also becomes `'919876543210'` (a regression check: it already passes). `'+44 7700 900123'` stays `'447700900123'`.
- [ ] Test (db), `normalize_mobile drops the 0 after +91`: the same inputs through `public.normalize_mobile`. Also, a stored owner contact `9109876543210`, written by the old function, is rewritten to `919876543210` by the migration.
- [ ] Run both tests. Expected: FAIL on the new cases.
- [ ] Implement in TS and in 038 section 1. Copy `normalize_mobile` from 032 and change only the international branch. Add a data fix for the stored `^910[0-9]{10}$` values in `unit_owner_contacts.owner_mobile`, `unit_ownerships.owner_mobile`, `join_requests.mobile`, `member_invites.mobile` and `professional_invites.invited_mobile`.
- [ ] Run both tests. Expected: PASS. Commit.

### Task 2: Old invites and waiting requests close when the person has joined

**Files:**
- Modify: `038_loose_ends.sql` (section 2)
- Test: `tests/db/loose-ends.test.mjs`

**Interfaces:** Consumes the `attach_flat_owner` from 033 and the `join_society` from 031. Produces the trigger `trg_membership_closes_requests` on `society_memberships`.

- [ ] Tests (db):
  - `joining another way closes the waiting request`: X asks to join (pending), then is attached by a committee invite or a phone match. The request is `approved` with the flat, and `decide_join_request` on it raises `already approved`. A pending request by X in another society stays `pending`.
  - `a later phone match is not blocked by a waiting request`: X with an unverified phone asks. The phone is then confirmed, and the committee saves X's mobile on flat 103. `join_society` returns `joined`, and the request is closed.
  - `the owner's own invites are settled when they join by phone`: an owner invite to X's mobile or email for flat F becomes `accepted` (`accepted_user_id` = X) when X is attached to F. An owner invite to someone else for F stays `pending`.
  - `the owner-change invite closes when the change completes through the link`: after `transfer_flat_owner` to an email, Y (a different login) joins F through the link and the phone match. The period's invite is `revoked`, unless it was Y's own.
- [ ] Run. Expected: FAIL.
- [ ] Implement:
  - An `AFTER INSERT OR UPDATE OF is_active` trigger on `society_memberships`, `WHEN (NEW.is_active)`. It marks that user's pending `join_requests` in that society `approved`, with `unit_id`/`role` coalesced from the membership and `decided_at` now.
  - `attach_flat_owner` (copied from 033), with two additions. The pending `resident_owner` invites for the flat that match the person's email or verified phone become `accepted`. The completed period's `invite_id`, if still pending and not theirs, becomes `revoked`.
  - `join_society` (copied from 031): the phone match runs before the "already waiting" early return.
- [ ] Run. Expected: PASS. Run `joining-link`, `mobile-login` and `owner-change` too. Commit.

### Task 3: The bill shows the CA's default receiving bank

**Files:**
- Modify: `038_loose_ends.sql` (section 3)
- Test: `tests/db/loose-ends.test.mjs`

- [ ] Test (db), `the bill names the bank the CA receives into`: two `bank_accounts` exist, the primary one on ledger 1000 and a second on a new bank ledger. `set_default_banks(receipt = second ledger)` is called. `bill_document(bill)->'bank'->>'account_number'` is the second account's number. With no default set, it is the primary one.
- [ ] Run. Expected: FAIL.
- [ ] Implement: copy `bill_document` from 033 and order the bank pick by `(ledger_id = default_bank_ledger(society, 'receipt')) DESC, is_primary DESC, created_at`.
- [ ] Run. Expected: PASS. Run `flat-bills` too. Commit.

### Task 4: No notifications for a closed society, and dead pushes are cleaned up

**Files:**
- Modify: `038_loose_ends.sql` (section 4), `src/lib/web-push.ts` (`deadSubscription`), `src/lib/push-sync.ts` (new `sameServerKey`), `src/lib/push-client.ts` (`enablePush`)
- Test: `tests/db/loose-ends.test.mjs`, `tests/unit/web-push.test.ts`, `tests/unit/push-client.test.ts`

**Interfaces:** Produces `sameServerKey(existing: ArrayBuffer | null | undefined, publicKeyB64url: string): boolean`.

- [ ] Tests:
  - (db) `a deactivated society sends nothing`: `notify_users(society, [member], …)` returns 0 once `societies.is_active = false`. A `NULL` society (join results) still sends.
  - (unit) `403 means the subscription is dead`: `deadSubscription(403)` is true; 404 and 410 are still true; 500 is false.
  - (unit) `a subscription made with another key is replaced`: `sameServerKey` compares the bytes. A `null` key counts as not the same.
- [ ] Run. Expected: FAIL.
- [ ] Implement:
  - `notify_users` (copied from 030) skips inactive societies.
  - `deadSubscription` includes 403.
  - `enablePush` unsubscribes an existing subscription whose `options.applicationServerKey` is not the same key, then subscribes again.
- [ ] Run. Expected: PASS. Run `notifications` too. Commit.

### Task 5: The GST split goes by state code; setup picks the state from a list

**Files:**
- Create: `src/lib/india-states.ts`
- Modify: `src/lib/billing.ts` (`gstSplit`), `src/views/setup/SetupWizard.tsx` (`SocietyStep`)
- Test: `tests/unit/india-states.test.ts`

**Interfaces:** Produces:
- `INDIAN_STATES: { code: string; name: string }[]`, with the GST state codes 01–38 and 97;
- `stateCode(input: string | null | undefined): string | null`, which accepts a name, an old name (Orissa, Pondicherry, Uttaranchal), `&`/`and`, case and spaces, a two-letter code (MH, KA, DL, TN, TS/TG…) or a GSTIN;
- `canonicalState(input): string | null`.

- [ ] Tests (unit):
  - `stateCode` maps `'Maharashtra'`, `' maharashtra '`, `'MH'` and `'27AAACS1234F1Z5'` to `'27'`; `'Orissa'` to `'21'`; `'Jammu & Kashmir'` to `'01'`; `'Atlantis'` to `null`.
  - `gstSplit` gives CGST+SGST for seller `'Maharashtra'` and buyer `'MH'`. It gives IGST for Maharashtra and Karnataka. When either GSTIN is present, the code is taken from it. For two unknown states it falls back to comparing the names.
- [ ] Run. Expected: FAIL.
- [ ] Implement:
  - the helpers and `gstSplit`;
  - in `SocietyStep`, State becomes a `<select>` of `INDIAN_STATES` names; the pincode fill sets `canonicalState(place.state) ?? ''`.
- [ ] Run. Expected: PASS. Commit.

### Task 6: The same flat number in two wings

**Files:**
- Create: `src/lib/flat-label.ts`
- Modify: `src/components/HomeCards.tsx` (dues list)
- Test: `tests/unit/flat-label.test.ts`

**Interfaces:** Produces:
- `flatKey(r: { wing: string | null; unit_number: string }): string`;
- `flatLabels(rows): string[]`. The wing is added only to a number that appears in two or more wings, and never twice (`A-101` stays `A-101`).

- [ ] Tests (unit): `101` in wings A and B gives `A-101` and `B-101`; `102`, only in A, stays `102`; `A-101`, `B-101` from the generator stay as they are; the keys differ.
- [ ] Run. Expected: FAIL. Implement. Use them in the HomeCards dues rows (`DueRow` gains `wing`). Run. Expected: PASS. Commit.

### Task 7: People with only a mobile

**Files:**
- Modify: `src/lib/mobile.ts` (new `contactText`, `contactLine`), plus these screens:
  - `PlatformDashboardPage.tsx` (sidebar and users table);
  - `ProfessionalDashboardPage.tsx` and `SocietyDashboardPage.tsx` (sidebar);
  - `MembersTab.tsx`, `PaymentsTab.tsx` and `ProfessionalsTab.tsx` (with `phone` in the select);
  - `PublicHeader.tsx`.
- Test: `tests/unit/mobile.test.ts`

**Interfaces:** Produces:
- `contactText(p: { email?: string | null; phone?: string | null } | null | undefined): string`: the email, else the formatted mobile, else `''`;
- `contactLine(p)`: both, joined by ` · `.

A stored phone with more than 10 digits, or starting with `+`, is already international (Supabase stores it that way). Ten digits get `91`.

- [ ] Tests (unit): email only gives the email. Phone `919876543210` gives `+91 98765 43210`; phone `9876543210` gives the same; `6591234567X` stays international. Both give `email · +91 98765 43210`. Neither gives `''`.
- [ ] Run. Expected: FAIL. Implement and use on the screens. No screen prints `()` or `• ` with nothing after it. Run. Expected: PASS. Commit.

### Task 8: The pincode lookup needs a login and has a limit

**Files:**
- Create: `src/lib/rate-limit.ts`
- Modify: `src/app/api/pincode/[pin]/route.ts`
- Test: `tests/unit/rate-limit.test.ts`

**Interfaces:** Produces `createRateLimiter(limit: number, windowMs: number): (key: string, now?: number) => boolean`. It allows up to `limit` hits per key in a sliding window and forgets keys whose hits are all old.

- [ ] Tests (unit): 3 per minute: the first three are allowed, the fourth is refused, and the fourth is allowed again 60 s after the first. Keys are independent.
- [ ] Run. Expected: FAIL. Implement.
- [ ] Route: no login gives 401 `Log in first`. More than 20 lookups in 10 minutes per user gives 429. The wizard already treats any non-OK answer as manual entry.
- [ ] Run. Expected: PASS. Commit.

### Task 9: Back in the setup wizard

**Files:**
- Modify: `src/lib/setup.ts` (new `previousSetupStep`), `src/views/setup/SetupWizard.tsx`
- Test: `tests/unit/setup-steps.test.ts`

**Interfaces:** Produces `previousSetupStep(step: SetupStep): SetupStep | null`:
- `society` and `flats` give `null` (the society exists; flats are kept);
- `maintenance` gives `flats`, `upi` gives `maintenance`, `owners` gives `upi`, `done` gives `owners`.

- [ ] Test (unit): the mapping above.
- [ ] Run. Expected: FAIL. Implement.
- [ ] Wizard:
  - a "Back" button above the step card, whenever `previousSetupStep(step)` is not null;
  - in Maintenance, when `status.rules > 0`, a "Keep saved charges" button goes on to UPI without saving;
  - UPI pre-fills the saved `upi_id` and payee.
  - Flats, with existing flats, already offers Continue, which creates nothing. Done, after bills were sent, already shows them as sent.
- [ ] Run. Expected: PASS. Commit.

### Task 10: "This year" on My account ends today

**Files:**
- Modify: `src/lib/fy.ts`, `src/components/FlatStatement.tsx`
- Test: `tests/unit/fy.test.ts`

- [ ] Test (unit): `fyRange('this', 5 Nov 2026)` gives `{ from: '2026-04-01', to: '2026-11-05' }`. `fyRange('this', 31 Mar 2027)` ends on `2027-03-31`. `'last'` is unchanged.
- [ ] Run. Expected: FAIL. Implement: `to` is the earlier of 31 March and today (a local date).
- [ ] In `FlatStatement`, a period ending today or later reads "Balance today".
- [ ] Run. Expected: PASS. Commit.
