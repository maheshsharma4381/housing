# Phase 11B (tenant registration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner registers a tenant with the agreement, police papers and ID through the 11A request system; on approval the tenancy is recorded and the tenant is invited; owners and the committee are reminded before the agreement ends; ending a tenancy removes the tenant's access; a society may add non-occupancy charges (≤ 10%) to let flats' bills.

**Architecture:** A `tenancy` kind on the existing `flat_requests` engine, with its checklist in a new per-society `request_checklists` table; approval (in a redefined `decide_request`) creates a `tenancies` row and a `resident_tenant` invite. A daily job reminds 30 days before the end date. `generate_bills` (redefined from 033) adds one "Non-occupancy charges" line for flats with a tenancy overlapping the bill period.

**Tech Stack:** Next.js 15, React 19, Tailwind v4, Supabase Postgres + pg_cron, PGlite DB tests, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-24-flat-changes-design.md` (section 5.3)

**Choices the spec left open, made here:**
- One active tenancy per flat. A second registration while one is active is refused unless it renews it.
- Renewal is a new tenancy request that names the tenancy it renews; on approval the old one becomes `renewed` and no new invite is sent.
- Agreement length 1 day to 60 months (the usual leave and licence maximum is 60 months).
- The tenant invite uses the tenant's mobile (and email if given). If an active tenant membership on the flat already has that mobile, no invite is sent.
- Ending a tenancy switches off every active `resident_tenant` membership of the flat and revokes pending tenant invites for it.
- Non-occupancy charges: a society setting (0–10%, default 0) on `society_settings`; base = the flat's charges from billing rules not marked "municipal tax"; no GST on the line; it posts to the default maintenance income ledger (4000), like other lines without a rule. A tenancy counts for a bill if it overlaps the bill period and is `active` or `renewed`.

## Global Constraints

- Migration `src/db/migrations/041_tenancy.sql` (Gate Lite moves to 042); `bun run db:bundle`. Never edit 001–040. Redefined functions are copied verbatim from their latest migration (`decide_request`: 040; `generate_bills`: 033) and changed only where this plan says.
- Owner rule, managing roles and committee viewers as in 11A (`is_flat_owner`, `is_society_admin`, `is_committee_viewer`); owners see only tenancies and requests since the current ownership began (`current_ownership_since`).
- Messages, exactly:
  - `Only an owner of this flat can register a tenant`
  - `Enter the tenant's name (2 to 80 characters)`, `Enter a valid mobile number`, `Enter a valid email address`, `Number of people living there: 1 to 20`, `The agreement must end after it starts, within 60 months`, `The police reference can be up to 60 characters`
  - `This flat already has a tenant. End that tenancy or renew it.`
  - `Choose the tenancy this renews`
  - `Only an owner of this flat or the committee can end the tenancy`, `This tenancy has already ended`
  - `Non-occupancy charges can be at most 10% of service charges`
- Notifications: managing roles on submission (`Tenant registration for flat {label}`, link `requests`); applicant and owners on approval (`Tenant registered for flat {label}`); owners + managing roles 30 days before the end (`Tenancy of flat {label} ends on {DD Mon YYYY}`, kind `tenancy`, link `requests`), once per tenancy.
- Default tenancy checklist (keys fixed): `agreement` "Registered leave and licence agreement" (required); `police` "Police intimation or verification acknowledgement" (required); `tenant_id` "Tenant's photo ID" (required); `tenant_photo` "Tenant's photograph" (optional); `undertaking` "Owner's undertaking in the society's format" (optional).
- English UI only; all plans. DB tests one file at a time with `TZ=UTC`. Branch `phase-11b-tenancy`; commits with `git -c user.name=ved300406 -c user.email=ved300406@gmail.com`, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push; never `db:migrate --apply`.

## Review Focus

1. A flat is let from the 15th: the bill for the whole month gets the non-occupancy line (overlap rule), and a flat whose tenancy ended last month does not (Task 4).
2. Property tax marked "municipal tax" is left out of the base; a society at 0% adds nothing (Task 4).
3. The tenant moves out: the tenant can no longer open the flat's notices or polls (membership off), and a pending invite cannot be accepted (Task 3).
4. A renewal keeps the tenant's access without a second invite (Task 3).
5. The buyer of a let flat does not see the seller's tenancy papers (Task 2).

---

### Task 1: Tenancy checklist per society

**Files:** Create `041_tenancy.sql` (section 1); Test `tests/db/tenancy.test.mjs`

**Produces:**
- `request_checklists(society_id uuid, kind varchar(16) check in ('tenancy','shifting','transfer'), checklist jsonb not null, primary key (society_id, kind))`; RLS SELECT for members and committee viewers.
- `seed_request_checklists(p_society_id uuid)` (helper): the tenancy default above; called for every existing society and by an AFTER INSERT trigger on `societies`.
- `normalize_checklist(p_old jsonb, p_new jsonb) RETURNS jsonb` (helper): the 11A key rules (≤ 10 items, label 2–120, kept keys, new `dN`), error `Up to 10 documents, each with a name`.
- `save_request_checklist(p_society_id uuid, p_kind text, p_checklist jsonb) RETURNS jsonb` (managing roles; `Only the committee can change this`).

- [ ] Tests: `a society starts with the tenant document list` (5 items, keys and required flags as above, for an existing and a new society); `the committee edits it` (a new item gets `d1`, a kept key stays); `only managing roles edit it`.
- [ ] RED → implement → GREEN → commit `feat(tenancy): tenant document list per society (041)`.

### Task 2: Tenancy requests and the tenancies register

**Files:** Modify `041_tenancy.sql` (section 2); Test `tests/db/tenancy.test.mjs`

**Produces:**
- `tenancies(id uuid pk, society_id, unit_id, request_id uuid unique, tenant_name, tenant_mobile, tenant_email, occupants int, start_date date, end_date date, police_ref text, status varchar(12) check in ('active','ended','renewed'), ended_on date, renews_id uuid null, invite_id uuid null, reminded_at timestamptz, created_at)`; unique `(unit_id) WHERE status = 'active'`.
- RLS SELECT on `tenancies`: committee viewers; owners of the flat for tenancies created since the current ownership; the tenant (an active `resident_tenant` membership on the flat).
- `create_tenancy_request(p_unit_id uuid, p_details jsonb) RETURNS uuid` with `details` keys `tenant_name, tenant_mobile, tenant_email, occupants, start_date, end_date, police_ref, renews_id`; stores the cleaned details (mobile normalized, email lowercased); snapshots the society's tenancy checklist; event and notification as in 11A.

- [ ] Tests: `an owner registers a tenant` (request kind `tenancy`, details cleaned, checklist snapshot, managers told); `the checks` (each message above); `a tenant cannot register themself` and `another flat's owner cannot`; `one tenant at a time` (with an active tenancy a new request is refused unless `renews_id` is that tenancy; a wrong `renews_id` → `Choose the tenancy this renews`); `the buyer of a let flat sees neither the old request nor the old tenancy`.
- [ ] RED → implement → GREEN → commit `feat(tenancy): tenant registration requests`.

### Task 3: Approval, renewal and ending

**Files:** Modify `041_tenancy.sql` (section 3: `decide_request` redefined, `end_tenancy`); Test `tests/db/tenancy.test.mjs`

**Produces:**
- `decide_request` (copied from 040): for `kind = 'tenancy'`, after the existing checks, inserts the tenancy (`status 'active'`); a renewal marks the old one `renewed`, copies its `invite_id`, sends no invite; otherwise inserts a `member_invites` row (`role 'resident_tenant'`, the flat, tenant name, mobile, email) unless an active tenant membership on the flat has that mobile; notifies the applicant and the flat's owners. Returns `{status, tenancy_id}`.
- `end_tenancy(p_tenancy_id uuid, p_end_date date) RETURNS void`: owners (since ownership) or managing roles; sets `ended`, `ended_on` (default today, not before `start_date`); switches off active `resident_tenant` memberships of the flat; revokes pending tenant invites of the flat; adds a `tenancy_ended` event to its request; notifies managing roles.

- [ ] Tests: `approval records the tenancy and invites the tenant` (invite row with role, unit, mobile; tenancy active; required documents enforced as in 11A); `a tenant already on the flat gets no second invite`; `renewal keeps access` (old `renewed`, new active, invite count unchanged); `ending removes the tenant` (membership off, pending invite revoked, the old tenant sees 0 notices of the society); `only an owner or the committee ends it` and `an ended tenancy cannot be ended again`.
- [ ] RED → implement → GREEN; then `flat-requests.test.mjs` → PASS; commit `feat(tenancy): approval invites the tenant; renewal and ending`.

### Task 4: Reminders and non-occupancy charges

**Files:** Modify `041_tenancy.sql` (section 4: `tenancy_reminders`, cron, settings, `generate_bills` redefined); Test `tests/db/tenancy.test.mjs`

**Produces:**
- `tenancy_reminders() RETURNS int`: active tenancies with `end_date <= today + 30` and `reminded_at IS NULL` → notification to owners and managing roles, `reminded_at = now()`; cron `sahvaas-tenancy-reminders` at `0 4 * * *` (09:30 IST) with the 030 guard.
- `ALTER TABLE society_settings ADD non_occupancy_percent NUMERIC(4,2) NOT NULL DEFAULT 0 CHECK (0..10)`; `set_non_occupancy_percent(p_society_id uuid, p_percent numeric)` (managing roles).
- `ALTER TABLE billing_rules ADD is_municipal_tax BOOLEAN NOT NULL DEFAULT false`.
- `generate_bills` (copied from 033): after the rules subtotal, when the setting is above 0 and a tenancy of the flat (`active` or `renewed`) overlaps `[p_period_start, p_period_end]`: `v_noc := round(base * pct / 100, 2)` where base is the flat's rule amounts (before tax) from rules not marked municipal tax; adds it to the subtotal and the preview, and inserts a bill item `Non-occupancy charges` (rule NULL, quantity 1, tax 0).

- [ ] Tests: `a reminder goes once, 30 days before the end` (end in 20 days → owners and managers told once; second run → 0; end in 40 days → nothing); `non-occupancy charges` (10% → a let flat's bill gets 150.00 on 1500; an unlet flat none; 0% → none; 11% refused with the message; a municipal-tax rule of 300 is left out of the base; a tenancy that ended before the period → none; a tenancy starting mid-period → charged); `the bill posts and balances` (journal for the bill sums to zero; the flat's dues include the line).
- [ ] RED → implement → GREEN; then `billing.test.mjs`, `flat-bills.test.mjs`, `home.test.mjs` → PASS; commit `feat(tenancy): end-date reminders and non-occupancy charges`.

### Task 5: Helpers and screens

**Files:** Create `src/lib/tenancy.ts`, `src/components/TenancyForm.tsx`, `src/components/Tenancies.tsx`; Modify `src/components/MyRequests.tsx` (Register a tenant; my flat's tenancy with Renew and "Tenant moved out"), `src/components/FlatRequests.tsx` (a **Tenants** view: active, ending in 30 days, expired, ended; End; the tenant document list editor; the non-occupancy % setting), `src/components/RequestDetail.tsx` (tenancy details block), `src/views/society/tabs/BillingTab.tsx` (a "Municipal tax" tick per rule, with "No non-occupancy charge on this"); Test `tests/unit/tenancy.test.ts`

**Produces:** `tenancyState(t: {status; start_date; end_date}, today: string): 'active' | 'ending' | 'expired' | 'ended' | 'renewed'` (`ending` = active and ≤ 30 days left; `expired` = active and past the end date); `tenancyDraftError(d, today)` mirroring the DB checks; `TENANCY_STATE_LABELS` (`Active`, `Ends soon`, `Agreement expired`, `Ended`, `Renewed`).

- [ ] Unit tests for both functions (exact labels and messages) → RED → implement → GREEN.
- [ ] Screens; `bun run typecheck`, `bun run lint` (0 errors), `bun run build` (compiled); commit `feat(tenancy): tenant screens for owners and the committee`.

### Task 6: Bundle, docs, verification

- [ ] `bun run db:bundle`; consolidated test PASS; every DB and unit test → 0 fail; typecheck, lint, build.
- [ ] Gate Lite docs: migration 041 → 042.
- [ ] Report section "Phase 11B — tenant registration (migration 041)"; "What you need to do next" lists 039–041.
- [ ] Commit `docs(report): Phase 11B (migration 041)`.
