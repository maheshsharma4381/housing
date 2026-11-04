# Phase 3B: Owners' Mobiles on Flats and One Society Joining Link — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The secretary records each flat's owner name and mobile and shares one joining link in the society's WhatsApp group. A member who opens it while logged in with a verified mobile that matches a flat is attached to that flat automatically. Anyone else lands in the secretary's Approvals.

**Architecture:**
- Migration `031_joining_link.sql`:
  - flats get `owner_name` / `owner_mobile` (normalised digits with country code);
  - societies get a random `join_code`;
  - `join_society(code)` either attaches the caller to their flat or files a `join_requests` row.
- The owner-attach steps from 029's invite hook move into one function, `attach_flat_owner`, which both the invite flow and the joining link use, so the ownership history, unpaid bills and receipts follow the flat either way.
- A mobile is trusted only when it is the login's own verified number (`auth.users.phone`, set by phone OTP in Supabase). A typed number never attaches anyone.

**Spec:** `docs/superpowers/specs/2026-10-31-sahvaas-simplify-design.md` 8.2, 9.1 step 6 (owners table, paste from Excel), 9.3 (Approvals collects unknown join requests), 8.1 (joining link rate-limited).

## Decisions (autonomous run)

1. **Mobiles** are stored as digits with the country code: 10 Indian digits get `91` in front, and a leading `+` or `0` is dropped. `normalize_mobile` in SQL and `normalizeMobile` in TS follow the same rules.
2. **Matching:**
   - Auto-attach happens only for a logged-in user whose `auth.users.phone` (Supabase sets it only after OTP) matches a flat's `owner_mobile` in that society, or the mobile of a waiting owner change (029).
   - Until 3C ships phone login, everyone goes through Approvals.
3. **Join requests:** a request names the person, their mobile (as typed, unverified) and the flat they say. The committee approves with a flat and a role (owner or tenant) or rejects with a reason. At most 30 new requests per society per day ("Too many join requests today — ask your secretary").
4. **The link** is `/join/<code>`. The secretary can make a new link; the old one then stops working.

## Global Constraints

Same as 3A:
- new SQL only in `031_joining_link.sql`; run `bun run db:bundle`; never `--apply`;
- `SECURITY DEFINER`, with internal helpers revoked;
- DB tests one file at a time with `TZ=UTC`;
- English UI;
- commits with the ved300406 identity and the Co-Authored-By trailer; never push.

## Review Focus

1. **Spoofing:** a user who types someone else's mobile into the join form is never attached; it becomes a request (Task 1 test).
2. **A changed link:** an old code after "new link" is refused with "This joining link has changed — ask your secretary for the new one" (Task 1 test).
3. **Same person twice:** a person already in the society who opens the link gets "You are already a member of …" and no duplicate request (Task 1 test).
4. **Approving a tenant:** the tenant gets no bills or dues. The owner flow moves bills only for an owner (Task 1 test).
5. **Owner change, then the link:** a waiting owner change (029) completes when the new owner joins through the link with the verified mobile entered at the transfer (Task 1 test).

---

### Task 1: Database

**Files:**
- Create: `031_joining_link.sql`, `tests/db/joining-link.test.mjs`
- Regenerate: the bundle

**Interfaces:**
- **Helpers:**
  - `normalize_mobile(p TEXT) RETURNS TEXT` (IMMUTABLE; NULL for fewer than 10 digits).
  - `attach_flat_owner(p_society_id UUID, p_unit_id UUID, p_uid UUID, p_invite_id UUID DEFAULT NULL) RETURNS VOID` (internal):
    - the 029 hook body: fill a waiting period, move unpaid bills and receipts, or start the first period;
    - plus `units.current_owner_id = p_uid`.
  - `accept_member_invite_row`: redefined from the 029 body so that its ownership block calls `attach_flat_owner`.
- **Owner contacts:**
  - Columns `units.owner_name TEXT` and `units.owner_mobile TEXT`.
  - `set_flat_owner_contacts(p_society_id UUID, p_rows JSONB) RETURNS INT`:
    - rows look like `[{unit_id, name, mobile}]`;
    - only the committee may call it: `'Only the society committee can change flats'`;
    - an invalid mobile raises `'Mobile % is not a valid number'`;
    - an empty mobile clears it;
    - audit `units.owner_contacts`.
  - `transfer_flat_owner` stores the new owner's normalised mobile on `units.owner_mobile`. This is a one-line addition in a redefinition from 029.
- **The link:**
  - `societies.join_code VARCHAR(16) UNIQUE`.
  - `society_join_code(p_society_id UUID) RETURNS TEXT` creates the code if missing; committee only.
  - `new_join_code(p_society_id UUID) RETURNS TEXT`; audit `society.join_link_changed`.
- **Join requests:**
  - `join_requests` table: `id`, `society_id`, `user_id → profiles`, `full_name`, `mobile`, `flat_hint`, `status` (pending / approved / rejected), `unit_id`, `role`, `decided_by`, `decided_at`, `decision_note`, `created_at`.
  - RLS: SELECT by the requester (own) and by the committee (`is_committee_viewer`).
- **`join_society(p_code TEXT, p_name TEXT, p_mobile TEXT, p_flat_hint TEXT) RETURNS JSONB`**, returning `{ status: 'joined' | 'requested', society_name, flat }`. Checks, in order:
  1. `'Log in first'`
  2. `'This joining link has changed — ask your secretary for the new one'`
  3. `'You are already a member of %'`
  4. a pending request by the same user already exists → return `requested`
  5. verified-phone match → `attach_flat_owner` (as `resident_owner`) → `joined`
  6. otherwise the daily cap (`'Too many join requests today — ask your secretary'`), then insert a request, notify the committee admins (`kind 'join_request'`, link `approvals`, title `'Join request: {name}'`) → `requested`
- **`decide_join_request(p_request_id UUID, p_approve BOOLEAN, p_unit_id UUID DEFAULT NULL, p_role TEXT DEFAULT 'resident_owner', p_note TEXT DEFAULT NULL) RETURNS JSONB`.** Messages:
  - `'Only the society committee can decide join requests'`
  - `'This request is already %'`
  - `'Choose the flat'` (approval with no unit)
  - `'Role must be owner or tenant'`
  - `'Give a reason for rejecting'`

  On approval as an owner: membership plus `attach_flat_owner`. On approval as a tenant: a `resident_tenant` membership, `units.current_tenant_id` and occupancy, as in 012's invite branch. Either way the requester is notified (`kind 'join_result'`).

- [ ] **Step 1: Failing tests** (`tests/db/joining-link.test.mjs`).

  Setup:
  - a society with flats 101, 102 and 103 and a secretary;
  - `set_flat_owner_contacts` gives 101 the contact "Asha Rao, 98765 43210";
  - helper `withPhone(email, phone)` = `createUser` plus `UPDATE auth.users SET phone`.

  Tests:
  - **`mobiles are kept as digits with the country code`:** `normalize_mobile('+91 98765-43210')`, `'098765 43210'` and `'9876543210'` all give `'919876543210'`, and `'12345'` gives NULL.
  - **`only the committee records owner contacts`:** a resident is refused, and a bad mobile is refused.
  - **`the owner whose verified mobile matches joins their flat`:**
    - Asha (phone `919876543210`) calls `join_society(code, 'Asha Rao', NULL, NULL)` → `joined`, flat `101`;
    - she now has an active `resident_owner` membership on 101 and a `unit_ownerships` open period;
    - calling it again → `/You are already a member of/`.
  - **`a typed mobile never attaches anyone`:** a user with no phone types `'9876543210'` → `requested`; no membership; the secretary gets a `join_request` notification.
  - **`the secretary approves a tenant and rejects a stranger`:**
    - approving the request with unit 102 and `resident_tenant` gives a tenant membership; generating bills then gives that user no bill;
    - rejecting without a note fails; with a note it succeeds;
    - the requester gets `join_result`.
  - **`a new link retires the old one`:** after `new_join_code`, the old code fails with `/has changed/`.
  - **`a waiting owner change completes through the link`:**
    - `transfer_flat_owner(103, 'Vikram', 'vikram@x.test', '9811111111', current_date)`, after giving 103 an owner with an earlier start;
    - Vikram, created with phone `919811111111`, joins via the link → `joined`;
    - the period is joined and the open bills are his.
  - **`requests are capped per society per day`:** 30 requests are fine, and the 31st is refused. Insert 30 rows directly, then make one call.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement; then bundle.
- [ ] **Step 4:** run the file, then `owner-change`, `onboarding`, `notifications` and `rls` one at a time → pass.
- [ ] **Step 5:** commit `feat(join): owners' mobiles on flats and one society joining link`.

### Task 2: Screens

**Files:**
- Create: `src/lib/mobile.ts` (`normalizeMobile`, the same rules as SQL) with `tests/unit/mobile.test.ts`, `src/components/JoinLinkCard.tsx`, `src/components/JoinRequests.tsx`, `src/app/join/[code]/page.tsx`, `src/views/join/JoinPage.tsx`
- Modify: `src/views/society/tabs/UnitsTab.tsx`, `src/views/society/tabs/MembersTab.tsx`, `src/views/society/SocietyDashboardPage.tsx` (Approvals)

**Interfaces and copy:**
- **Unit tests for `normalizeMobile`:** the same four cases as SQL.
- **`UnitsTab`:**
  - Each card shows "Owner: {name} · {mobile}" when set.
  - A committee user can edit the owner name and mobile inline (Save calls `set_flat_owner_contacts` with one row).
  - "Paste owners from Excel" opens a textarea. Each line is `flat number <TAB or comma> owner name <TAB or comma> mobile`. A preview counts matched flats and lists unknown flat numbers. "Save owners" sends all matched rows.
- **`JoinLinkCard`** (top of Members, for the committee):
  - It shows `${origin}/join/${code}` with "Copy" and "Share on WhatsApp", which opens `https://wa.me/?text=` plus an encoded "Join {society} on Sahvaas: {link}".
  - "Make a new link" asks to confirm with "The old link will stop working." first.
  - Help: "Post this link in your society's WhatsApp group. Owners whose mobile you entered join their flat straight away; anyone else comes to Approvals."
- **`JoinPage` (`/join/[code]`):**
  - Not logged in: "Log in to join" goes to `/login?next=/join/<code>`. If the login page ignores `next`, add that support there.
  - Logged in: a form with "Your name", "Your mobile" and "Your flat (e.g. A-101)", and a "Join" button that calls `join_society`.
  - Result copy:
    - joined: "You have joined {society} — Flat {flat}." with a "Go to my flat" link to `/resident`;
    - requested: "Your request has gone to the {society} committee. You will get a notification when they approve it."
- **`JoinRequests`** in the Approvals tab, before the opening balance:
  - pending requests show name, mobile, the flat they said and the time;
  - Approve: choose the flat (a select of flats) and "Owner" or "Tenant";
  - Reject: requires a reason;
  - it is read-only for a viewer (`canDecide`).

- [ ] **Step 1:** unit test for `normalizeMobile` → RED; implement → GREEN.
- [ ] **Step 2:** build the screens.
- [ ] **Step 3:** verify: typecheck and lint clean on touched files; the full suite one file at a time; `bunx next build`.
- [ ] **Step 4:** commit `feat(join): joining link card, join page, owners from Excel, join requests in Approvals`.
