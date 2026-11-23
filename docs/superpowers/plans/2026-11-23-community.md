# Phase 10 (notice read record, polls, staff register) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Committees see who has seen each notice, ask owners one-vote-per-flat polls before the AGM, and keep a register of domestic staff.

**Architecture:** One migration adds three small modules, each a table set with RLS (default deny) and `SECURITY DEFINER` RPCs for every write and for anything that must hide data (per-flat votes, other flats' staff mobiles). The UI adds a read hook to the resident Notices screen, a seen panel to the committee Notices screen, and Polls and Staff screens to both portals.

**Tech Stack:** Next.js 15, React 19, Tailwind v4, Supabase Postgres + Storage, PGlite DB tests, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-23-community-design.md`

## Global Constraints

- Migration `src/db/migrations/039_community.sql`; `bun run db:bundle` after. Never edit 001–038.
- New functions `SECURITY DEFINER SET search_path = public`; helpers revoked from `PUBLIC, anon, authenticated`; RPCs granted to `authenticated`.
- "Managing roles" = `is_society_admin(society_id)`; "committee viewer" = `is_committee_viewer(society_id)`.
- English UI only; all plans; no ad slots on the new screens.
- Poll footnote, exactly: `This poll shows members' views. Decisions are taken in the general body meeting.`
- Staff kinds, exactly: `maid, driver, cook, cleaner, nanny, other` (labels Maid, Driver, Cook, Cleaner, Nanny, Other).
- DB tests one file at a time: `TZ=UTC node --test tests/db/<file>.test.mjs`. Unit: `node --test tests/unit/<file>.test.ts`.
- Branch `phase-10-community`; commits `git -c user.name=ved300406 -c user.email=ved300406@gmail.com commit ...` ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push; never `db:migrate --apply`.

## Review Focus

1. Joint owners of one flat both vote: one vote counts (the last), the count never shows 2 for one flat (Task 2).
2. An owner who sold the flat (membership inactive) tries to vote or change the flat's vote: refused (Task 2).
3. A tenant opens the poll: can read it but cannot vote (Task 2).
4. A resident links staff by a mobile typed as `+91 98765-43210` that the society stored as `919876543210`: the existing staff is found, no duplicate (Task 3).
5. A notice for "Owners only": tenants are not in "not seen yet", and a tenant's read of it cannot be recorded (Task 1).

---

### Task 1: Notice read record (DB)

**Files:** Create `src/db/migrations/039_community.sql` (section 1); Test `tests/db/community.test.mjs`

**Interfaces — Produces:**
- `notice_reads(notice_id uuid fk notices on delete cascade, user_id uuid fk profiles on delete cascade, seen_at timestamptz default now(), primary key (notice_id, user_id))`, RLS on, no policies.
- helper `notice_audience(p_notice_id uuid) RETURNS TABLE(user_id uuid, unit_id uuid)`: active memberships matching the notice's `target_audience` exactly as `trg_notify_notice` (030), excluding committee roles and the publisher.
- `mark_notices_seen(p_notice_ids uuid[]) RETURNS int`: inserts (ON CONFLICT DO NOTHING) only for ids where the caller is in `notice_audience`; returns rows inserted.
- `notice_read_summary(p_notice_id uuid) RETURNS jsonb` (committee viewer only, else error `Only the committee can see this`): `{seen: int, total: int, not_seen: [{name, wing, unit_number}]}` ordered by wing, unit number.

- [ ] **Step 1: Failing tests** in `tests/db/community.test.mjs`:
  - `seeing a notice is recorded once`: owner calls `mark_notices_seen([n])` twice → 1 then 0; summary `{seen:1,total:2}` with the other owner in `not_seen`.
  - `the committee is not counted`: a secretary's `mark_notices_seen` returns 0 and `total` excludes committee roles.
  - `an owners-only notice leaves tenants out`: tenant's `mark_notices_seen` returns 0; `total` counts owners only; tenant not in `not_seen`.
  - `someone of another society cannot mark it`: returns 0.
  - `only the committee sees the summary`: an owner calling `notice_read_summary` gets `Only the committee can see this`; a committee member gets the summary.
- [ ] **Step 2:** `TZ=UTC node --test tests/db/community.test.mjs` → FAIL (`relation "notice_reads" does not exist`).
- [ ] **Step 3:** Implement section 1.
- [ ] **Step 4:** Same command → PASS (5).
- [ ] **Step 5:** Commit `feat(notices): who has seen a notice (039)`.

### Task 2: Polls (DB)

**Files:** Modify `039_community.sql` (section 2); Test `tests/db/community.test.mjs`

**Interfaces — Produces:**
- `polls(id uuid pk, society_id uuid fk cascade, question varchar(200), details text, options text[] not null, closes_at timestamptz not null, closed_at timestamptz, created_by uuid fk profiles, created_at timestamptz default now())`.
- `poll_votes(poll_id uuid fk polls cascade, unit_id uuid fk units cascade, option_index int not null, voted_by uuid fk profiles, voted_at timestamptz default now(), primary key (poll_id, unit_id))`. RLS on both; `polls` SELECT for `has_society_membership(society_id)`; `poll_votes` no policies.
- `poll_is_open(p polls) RETURNS boolean` = `closed_at IS NULL AND closes_at > now()`.
- `create_poll(p_society_id uuid, p_question text, p_details text, p_options text[], p_closes_at timestamptz) RETURNS uuid` (managing roles). Errors: `Write the question (5 to 200 characters)`, `Details can be up to 1000 characters`, `Give 2 to 6 options, each up to 80 characters`, `Close the poll between 1 hour and 60 days from now`. Notifies every active `resident_owner` of the society: kind `poll`, title `Poll: {question}`, link `polls`.
- `cast_poll_vote(p_poll_id uuid, p_unit_id uuid, p_option_index int) RETURNS void`: caller must hold an active `resident_owner` membership for `p_unit_id` in the poll's society; poll open; index in range. Upsert; `voted_by`, `voted_at` updated. Errors: `Only an owner of this flat can vote`, `This poll is closed`, `Choose one of the options`.
- `close_poll(p_poll_id uuid) RETURNS void` (managing roles; sets `closed_at`, error `This poll is closed` if already closed).
- `delete_poll(p_poll_id uuid) RETURNS void` (managing roles; only with no votes, else `A poll with votes cannot be deleted`).
- `poll_view(p_poll_id uuid) RETURNS jsonb`: `{open, my_flats:[{unit_id, wing, unit_number, choice}], counts:[int]|null, voted:int, eligible:int}`; `counts` is filled for committee viewers always and for others only when closed; `my_flats` are the caller's owner flats.
- `poll_flats(p_poll_id uuid) RETURNS TABLE(wing text, unit_number text, voted boolean)` (committee viewers only): every eligible flat, never the choice.

- [ ] **Step 1: Failing tests**:
  - `the committee opens a poll and owners are told`: `create_poll` → id; each owner has a `poll` notification; tenants do not.
  - `poll checks`: question of 4 chars, 1 option, 7 options, an 81-char option, closing in 30 minutes, closing in 61 days → each the exact error above.
  - `one vote per flat, the last one counts`: joint owners A and B of flat 101 vote 0 then 1 → committee `counts` = `[0,1]`, `voted` = 1.
  - `a tenant and a former owner cannot vote`: tenant → `Only an owner of this flat can vote`; owner with inactive membership → same.
  - `an owner of two flats votes for each`: `voted` = 2.
  - `residents see counts only after closing`: owner `poll_view.counts` is null while open, an array after `close_poll`; `my_flats[0].choice` is their flat's choice.
  - `nobody reads another flat's choice`: `SELECT * FROM poll_votes` as committee and owner returns 0 rows; `poll_flats` gives `voted` booleans only.
  - `a closed poll takes no votes, a voted poll cannot be deleted`: `cast_poll_vote` after close → `This poll is closed`; `delete_poll` with votes → error; without votes → deleted.
  - `a poll past its closing time is closed`: update `closes_at` into the past (as admin) → vote refused, counts visible to owners.
- [ ] **Step 2:** run → new tests FAIL.
- [ ] **Step 3:** Implement section 2.
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5:** Commit `feat(polls): one-vote-per-flat polls before the AGM`.

### Task 3: Staff register (DB + storage)

**Files:** Modify `039_community.sql` (section 3); Test `tests/db/community.test.mjs`

**Interfaces — Produces:**
- `staff(id uuid pk, society_id uuid fk cascade, name varchar(80) not null, kind varchar(16) check in the six, mobile varchar(16), photo_path text, id_proof_path text, police_verified_on date, notes text, is_active bool default true, created_by uuid, created_at timestamptz)`; unique index `(society_id, mobile) WHERE is_active AND mobile IS NOT NULL`.
- `staff_flats(staff_id uuid fk staff cascade, unit_id uuid fk units cascade, added_by uuid, primary key (staff_id, unit_id))`.
- RLS on both, no direct policies; reads through RPCs.
- helper `my_household_units(p_society_id uuid) RETURNS SETOF uuid`: units of the caller's active `resident_owner`/`resident_tenant` memberships.
- `staff_list(p_society_id uuid) RETURNS jsonb`: array of `{id, name, kind, photo_path, police_verified, flats:[{unit_id,wing,unit_number}], mobile, notes, id_proof, mine}`; for committee viewers every field; for residents `mobile` only when `mine` (works in one of their units), `notes` and `id_proof` always null, `flats` only their own units; inactive staff only for committee viewers.
- `save_staff(p_society_id uuid, p_id uuid, p_name text, p_kind text, p_mobile text, p_unit_ids uuid[]) RETURNS uuid`: insert when `p_id` null, else update. Residents: `p_unit_ids` must be a subset of their household units; may update only staff linked solely to their units. If `p_id` is null and an active staff with the same normalized mobile exists, link the units to it and return its id. Errors: `Enter the name (1 to 80 characters)`, `Choose what they do`, `Enter a valid mobile number`, `You can add staff only for your own flat`, `Only the committee can change this person`.
- `unlink_staff(p_staff_id uuid, p_unit_id uuid) RETURNS void`: household of the unit or committee.
- `set_staff_verified(p_staff_id uuid, p_verified_on date) RETURNS void`, `set_staff_notes(p_staff_id uuid, p_notes text)`, `set_staff_active(p_staff_id uuid, p_active boolean)`: managing roles.
- `set_staff_file(p_staff_id uuid, p_kind text /* 'photo'|'id' */, p_path text) RETURNS void`: path must be `{society_id}/{staff_id}/photo-…` or `/id-…`; photo by anyone who may edit the staff; id by the committee or the resident who created the staff.
- bucket `staff-files` (private, 5 MB). Storage policies: INSERT when the caller may edit the staff of the path's second folder; SELECT for `photo-*` when `has_society_membership(storage_society_id(name))`, for `id-*` only `is_committee_viewer(storage_society_id(name))`.

- [ ] **Step 1: Failing tests**:
  - `a resident adds their maid`: owner `save_staff(soc,null,'Sunita','maid','98765 43210',[myUnit])` → id; `staff_list` for that owner shows mobile `919876543210`, `mine:true`.
  - `the same mobile links, not duplicates`: another flat's tenant `save_staff(..., '+91 98765-43210', [theirUnit])` returns the same id; committee sees 2 flats on her.
  - `residents see less`: a resident of a third flat sees Sunita with `mobile:null`, `notes:null`, `id_proof:null`, `flats:[]`.
  - `residents add only for their own flats`: owner passing another unit → `You can add staff only for your own flat`.
  - `a resident cannot change shared staff`: once linked to two households, the first owner's update → `Only the committee can change this person`; the committee can.
  - `only the committee verifies, notes and removes`: owner calling `set_staff_verified` errors; committee sets it; `police_verified:true` visible to residents; `set_staff_active(false)` hides her from residents.
  - `ID proof is for the committee`: `set_staff_file(id,'id', path)` by the creating resident works; a `storage.objects` row at that path is selectable by the committee member and not by the resident; a photo object is selectable by any member.
  - `field checks`: empty name, kind `gardener`, mobile `123` → the exact errors.
- [ ] **Step 2:** run → new tests FAIL.
- [ ] **Step 3:** Implement section 3.
- [ ] **Step 4:** run → PASS; then `TZ=UTC node --test tests/db/rls.test.mjs` → PASS.
- [ ] **Step 5:** Commit `feat(staff): the society's staff register`.

### Task 4: Shared UI helpers and menus

**Files:** Create `src/lib/polls.ts`, `src/lib/staff.ts`; Modify `src/lib/society-nav.ts`; Tests `tests/unit/polls.test.ts`, `tests/unit/staff.test.ts`, `tests/unit/society-nav.test.ts`

**Interfaces — Produces:**
- `polls.ts`: `POLL_FOOTNOTE` (the exact sentence); `pollDraftError(d: {question: string; details: string; options: string[]; closesAt: Date}, now: Date): string | null` mirroring the DB errors (options trimmed, blanks dropped); `pollResultCsv(poll: {question: string; options: string[]}, counts: number[], flats: {label: string; voted: boolean}[]): string` with rows `Question`, one `Option,Votes` row each, then `Flat,Voted` rows (`Yes`/`No`).
- `staff.ts`: `STAFF_KINDS: {id: StaffKind; label: string}[]`, `type StaffKind`, `staffKindLabel(k: string): string` (unknown → `Other`).
- `society-nav.ts`: tabs `polls` (`Polls`) and `staff` (`Staff`) in group `society`, after `notices`; `societyTabFor('polls'|'staff')` returns them.

- [ ] **Step 1: Failing tests**: draft errors for each DB rule (same messages); `pollResultCsv` exact output for a 2-option poll with 2 flats; `STAFF_KINDS` labels in order; nav order `… notices, polls, staff, complaints …`.
- [ ] **Step 2:** run the three unit files → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** run → PASS; `bun run typecheck` clean.
- [ ] **Step 5:** Commit `feat(community): poll and staff helpers, menu entries`.

### Task 5: Notice read record UI

**Files:** Modify `src/views/resident/ResidentDashboardPage.tsx` (when the Notices tab shows notices, call `mark_notices_seen` with the shown ids once per load), `src/views/society/tabs/NoticesTab.tsx` (under each notice: "Seen by N of M" button that loads `notice_read_summary` and lists "Not seen yet" as `Name · Flat A-101`)

- [ ] **Step 1:** Implement both. Failures of `mark_notices_seen` are ignored silently (never block reading).
- [ ] **Step 2:** `bun run typecheck`, `bun run build` → clean, compiled.
- [ ] **Step 3:** Commit `feat(notices): seen counts for the committee`.

### Task 6: Polls UI

**Files:** Create `src/views/society/tabs/PollsTab.tsx`, `src/views/resident/ResidentPolls.tsx`; Modify `SocietyDashboardPage.tsx`, `ResidentDashboardPage.tsx` (tab `polls`, notification link `polls`)

- Committee: "New poll" form (question, details, options with add/remove up to 6, closing date-time; `pollDraftError` before the RPC); list open then closed polls; each shows counts as bars, "Voted X of Y flats", flats not voted, Close now (confirm), Delete (only with no votes), Download (`pollResultCsv` via `downloadCsv`). `POLL_FOOTNOTE` under every poll.
- Resident: open polls first; for each owner flat a choice list and Vote / Change vote; tenants see the question with "Only owners vote"; closed polls show counts and "Your flat chose …". `POLL_FOOTNOTE` under every poll.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** `bun run typecheck`, `bun run lint`, `bun run build` → clean, compiled.
- [ ] **Step 3:** Commit `feat(polls): poll screens for the committee and owners`.

### Task 7: Staff UI

**Files:** Create `src/views/society/tabs/StaffTab.tsx`, `src/views/resident/ResidentStaff.tsx`, `src/lib/staff-files.ts` (`uploadStaffFile(societyId, staffId, kind: 'photo'|'id', file): Promise<string>` → `staff-files` bucket path, then `set_staff_file`; `openStaffFile(path)` signed URL 120 s); Modify both dashboards (tab `staff`).

- Committee: list with photo, name, kind, flats, mobile, Police verified (date picker), notes, Remove/Restore, Add (any flats or none), ID proof view/upload.
- Resident: "My staff" (linked to my flats: edit, photo, ID upload once, Unlink) and "Society staff" (name, kind, photo, verified badge). Add: mobile first; if the RPC links an existing person, say `Already in the register — linked to your flat`.
- Uploads: images ≤ 5 MB; PDF allowed for ID; errors shown.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** `bun run typecheck`, `bun run lint`, `bun run build` → clean, compiled.
- [ ] **Step 3:** Commit `feat(staff): staff screens for the committee and residents`.

### Task 8: Bundle, docs, verification

- [ ] **Step 1:** `bun run db:bundle`; `TZ=UTC node --test tests/db/consolidated.test.mjs` → PASS.
- [ ] **Step 2:** Every `tests/db/*.test.mjs` (TZ=UTC, one at a time) and every `tests/unit/*.test.ts` → 0 fail.
- [ ] **Step 3:** `bun run typecheck`, `bun run lint` (0 errors), `bun run build` (compiled).
- [ ] **Step 4:** Gate Lite spec and plan: migration number 039 → 040.
- [ ] **Step 5:** `docs/superpowers/autonomous-run-report.md`: section "Phase 10 — notice read record, polls, staff register (migration 039)" with what was built, rulings, deferred minors; "What you need to do next" mentions 039.
- [ ] **Step 6:** Commit `docs(report): Phase 10 (migration 039)`.
