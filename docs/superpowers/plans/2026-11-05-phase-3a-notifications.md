# Phase 3A: Notification Inbox, Dues Reminders, Web Push — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every user gets an in-app notification inbox (bell with an unread badge) fed by the events of spec 8.3. The committee sets when dues reminders go out, and a nightly job sends them. Phones that allow it get a free web push whose lock-screen text is generic.

**Architecture:**
- **Migration** `030_notifications.sql`: a `notifications` table that only database triggers and functions write. A user reads and marks only their own rows.
- **Reminders:** `send_dues_reminders()` runs nightly through pg_cron next to the late-fee job.
- **Push:**
  - Push subscriptions live in `push_subscriptions`.
  - An API route sends a payload-free Web Push (VAPID JWT signed with `node:crypto`; no new dependency) to each user with unpushed notifications.
  - The service worker shows a generic message.

**Tech Stack:** Next.js 15, React 19, Tailwind v4, Supabase Postgres (plpgsql, RLS, pg_cron), PGlite tests, `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-10-31-sahvaas-simplify-design.md` — 8.3; 9.1 step 4 (reminder schedule, defaults 3 and 7); 13 (how push is sent is the builder's call).

## Phase 3 split

| Plan | Scope |
|---|---|
| **3A (this plan)** | Inbox, event notifications, dues reminders, web push |
| 3B | Owners' mobile numbers on flats; the society joining link; unknown numbers to Approvals |
| 3C | Mobile + OTP login (WhatsApp first, SMS backup) behind a provider interface; OTP limits; platform OTP dashboard (spec 11 item 1); log out of all devices |

## Decisions (made on the product owner's behalf; the user said "u decide, don't wait")

1. **Who is notified, on which event:**

   | Event | Notified | Link |
   |---|---|---|
   | New bill | The bill's holder | `bills` |
   | Notice | Its audience (all / owners / tenants / committee), not the publisher | `notices` |
   | Complaint status change, or a committee reply | The resident who raised it | `complaints` |
   | Payment verified / rejected | The payer | `payments` |
   | Resident payment waiting | Committee admins | `payments` |
   | Vendor bill waiting for approval | Committee admins other than its creator | `expenses` |
   | CA adjustment, year lock or bank move proposed | Committee admins other than the proposer | `approvals` |
   | Opening balance submitted | Committee admins | `approvals` |

   A committee admin is anyone with role `society_admin`, `secretary`, `chairman` or `treasurer`.
2. **Reminders:** on day `first` after the due date, then every `every` days, while the bill is unpaid. Each bill gets at most one reminder per day.
3. **Push carries no payload,** so no amount or name ever reaches the lock screen and no encryption library is needed. The notification reads "Sahvaas: You have a new message", because the service worker cannot know the society without a payload. The inbox shows the details after login.
4. **Push is sent when `/api/push/send-pending` runs.** That route needs `CRON_SECRET`. A pg_cron job can call it every 5 minutes when the `pg_net` extension and the `app.push_url` setting exist; this is documented in `.env.example` and the migration. The app also calls it, fire-and-forget, after the secretary issues bills or publishes a notice.
5. **No PNG icons are generated.** The existing SVG icon is used, because no image tool is available. iPhone Home Screen icons stay a known gap.

## Global Constraints

- **Migrations:** new SQL goes only in `src/db/migrations/030_notifications.sql`. Never edit 001–029. Run `bun run db:bundle` after every SQL change. Never run `--apply`.
- **Notification writes:** notification and trigger functions are `SECURITY DEFINER SET search_path = public`. Internal helpers are revoked from `authenticated`. Users cannot INSERT or DELETE notifications.
- **Tests:** DB tests run one file at a time (`TZ=UTC node --test tests/db/<file>`). Unit tests are `node --test tests/unit/<file>`.
- **App UI is English only.**
- **Commits:** `git -c user.name=ved300406 -c user.email=ved300406@gmail.com commit …` with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Review Focus

1. **Tenants:** a tenant gets notices meant for tenants and all members, but never a bill or dues notification (spec 5: tenants see no dues) (Task 1 test).
2. **Other people's rows:** a user cannot read or mark another user's notifications (Task 1 test).
3. **Repeat runs:** running the reminder job twice on the same day sends one reminder per bill. A paid bill gets none (Task 2 test).
4. **Removed members:** a member removed from the society stops receiving society notifications (Task 1 test).
5. **Dead subscriptions:** a push endpoint that answers 404 or 410 is deleted and the rest still get their push (Task 3 unit test on the sender's result handling).

---

### Task 1: The inbox and event notifications

**Files:**
- Create: `030_notifications.sql`, `tests/db/notifications.test.mjs`
- Regenerate: the bundle

**Interfaces:**
- **`notifications` table** (RLS: SELECT `user_id = auth.uid()`; no write policies):
  - `id UUID PK`;
  - `user_id UUID NOT NULL → profiles ON DELETE CASCADE`;
  - `society_id UUID → societies ON DELETE CASCADE`;
  - `kind VARCHAR(32) NOT NULL`;
  - `title TEXT NOT NULL`, `body TEXT`, `link VARCHAR(32)`;
  - `ref_id UUID`;
  - `created_at TIMESTAMPTZ`, `read_at TIMESTAMPTZ`, `pushed_at TIMESTAMPTZ`;
  - index `(user_id, created_at DESC)`.
- **`notify_users(p_society_id UUID, p_user_ids UUID[], p_kind TEXT, p_title TEXT, p_body TEXT, p_link TEXT, p_ref_id UUID DEFAULT NULL) RETURNS INT`** (internal): inserts one row per distinct non-null user who still has an active membership in the society. A platform-level call (`p_society_id` NULL) skips that check.
- **`committee_admin_ids(p_society_id UUID) RETURNS UUID[]`** (internal).
- **`mark_notifications_read(p_ids UUID[] DEFAULT NULL) RETURNS INT`:** marks the caller's own rows read; NULL means all of them.
- **`unread_notification_count() RETURNS INT`.**
- **AFTER triggers**, one per Decision 1 row, with their titles:
  - bills (insert, status issued): "New bill {bill_number}" with body "Flat {unit} · {₹ total} due {DD Mon}". Holders who are only tenants are never notified: the bill's `user_id` is the owner.
  - notices (insert): "Notice: {title}".
  - complaints (status update): "Complaint {ticket} is {status}".
  - complaint_updates (insert by someone other than the raiser): "New reply on complaint {ticket}". Read `008_operations.sql:111` for the author column.
  - payments (update to verified or rejected): "Payment verified" or "Payment rejected", body with the amount; insert as pending_verification: "Payment to verify: Flat {unit} · {₹}".
  - expenses (insert or update into pending_approval): "Vendor bill to approve: {title}".
  - adjustment_proposals (insert pending): "Approval needed: {proposal_number}".
  - opening_balances (update to submitted): "Opening balance to approve".

- [ ] **Step 1: Failing tests** (`tests/db/notifications.test.mjs`).

  Setup:
  - a society with a secretary, a treasurer, the owner of flat 101 (`r1`), a tenant of 101 (`t1`) and the owner of flat 102 (`r2`);
  - a billing rule;
  - `two_step` off.

  Tests:
  - `a new bill notifies its owner only`: `generate_bills` gives `r1` and `r2` one "New bill …" each with link `bills`; `t1` has none.
  - `a notice reaches its audience, not its publisher`:
    - insert notices as the secretary with audience `all`: `r1`, `r2`, `t1` and the treasurer get one, the secretary none;
    - with `tenants_only`: only `t1`.
  - `a payment to verify reaches the committee; its result reaches the payer`:
    - `r1` inserts a pending payment: the secretary and treasurer get "Payment to verify…";
    - the treasurer verifies it: `r1` gets "Payment verified".
  - `a vendor bill waiting for approval reaches the other committee admins`: the treasurer inserts an expense, so it is pending; the secretary gets one and the treasurer none.
  - `users read and mark only their own notifications`:
    - `r2` selecting `r1`'s rows by id gets 0 rows;
    - `mark_notifications_read(ARRAY[r1's id])` as `r2` returns 0;
    - as `r1` it returns 1;
    - `unread_notification_count()` drops by one.
  - `a removed member gets no new notifications`: set `r2`'s membership inactive, publish a notice, and `r2` gets 0 new rows.
- [ ] **Step 2:** run → FAIL, because the table does not exist.
- [ ] **Step 3:** implement; then `bun run db:bundle`.
- [ ] **Step 4:** run the file, then `billing`, `operations`, `accounting`, `bank-reconciliation` and `opening-balance` one at a time → all pass.
- [ ] **Step 5: commit** `feat(notifications): an in-app inbox fed by bills, notices, complaints, payments and approvals`.

### Task 2: Dues reminders on the committee's schedule

**Files:** modify `030_notifications.sql` and `tests/db/notifications.test.mjs`.

**Interfaces:**
- `society_settings.reminder_first_days INT NOT NULL DEFAULT 3 CHECK (BETWEEN 1 AND 60)`.
- `society_settings.reminder_every_days INT NOT NULL DEFAULT 7 CHECK (BETWEEN 1 AND 60)`.
- `set_reminder_schedule(p_society_id UUID, p_first INT, p_every INT) RETURNS JSONB`, returning `{ first, every }`.
  - Only a committee admin may call it: `'Only the society committee can set reminders'`.
  - Out-of-range values raise `'Reminders run between 1 and 60 days'`.
  - Writes the audit row `settings.reminders`.
- `send_dues_reminders(p_as_of DATE DEFAULT current_date) RETURNS INT` (count sent; revoked from `authenticated`; system context like `apply_late_fees_all`).
  - It considers every unpaid bill: `balance_due > 0`, status in issued, partially_paid or overdue, and `due_date < p_as_of`.
  - Let `d = p_as_of - due_date`. A bill is due a reminder when `d = first`, or when `d > first` and `(d - first) % every = 0`.
  - The notification is `kind 'dues_reminder'`, `ref_id = bill id`, `title 'Reminder: {₹ balance} due for Flat {unit}'`, `link 'bills'`.
  - It skips a bill that already has a `dues_reminder` for that `ref_id` created on `p_as_of`.
- A pg_cron job `sahvaas-dues-reminders` at `'30 19 * * *'`, guarded like 010's late-fee job.

- [ ] **Step 1: Failing tests (append).**
  - `the committee sets the reminder schedule`:
    - the defaults are 3 and 7;
    - `r1` calling it is refused;
    - 0 is refused;
    - the secretary sets 2 and 5.
  - `reminders follow the schedule, once a day, never for paid bills`:
    - Setup: a bill due `2026-10-10`, plus a second flat's bill paid in full. Dates are pinned by passing `p_as_of`, and `due_date` is set by an UPDATE in setup.
    - `send_dues_reminders('2026-10-12')` sends 1, and running it again that day sends 0.
    - `'2026-10-13'` sends 0; `'2026-10-17'` sends 1, since 7 = 2 + 5.
    - The paid bill never gets a reminder.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement; then bundle.
- [ ] **Step 4:** run `notifications` and `launch` → pass.
- [ ] **Step 5: commit** `feat(notifications): nightly dues reminders on the committee's schedule`.

### Task 3: Web push without a payload

**Files:**
- Modify: `030_notifications.sql`, `.env.example`
- Create: `src/lib/web-push.ts`, `tests/unit/web-push.test.ts`, `src/app/api/push/send-pending/route.ts`

**Interfaces:**
- **`push_subscriptions` table:**
  - columns `id`, `user_id → profiles ON DELETE CASCADE`, `endpoint TEXT UNIQUE NOT NULL`, `p256dh TEXT`, `auth TEXT`, `created_at`;
  - RLS: SELECT and DELETE own;
  - `save_push_subscription(p_endpoint TEXT, p_p256dh TEXT, p_auth TEXT) RETURNS VOID` (upsert for `auth.uid()`; refuses anonymous callers).
- **`src/lib/web-push.ts`:**
  - `vapidJwt(audience: string, subject: string, privateKeyPem: string, expiresInSec = 12 * 3600, now = Date.now()): string`: ES256 via `crypto.sign('sha256', …, { key, dsaEncoding: 'ieee-p1363' })`, base64url.
  - `pushHeaders(jwt: string, publicKeyB64url: string): Record<string, string>`: `Authorization: vapid t=…, k=…` and `TTL: 86400`.
  - `deadSubscription(status: number): boolean`: true for 404 and 410.
- **`POST /api/push/send-pending`:**
  - It requires `Authorization: Bearer ${CRON_SECRET}`.
  - With the service role it reads up to 500 notifications with `pushed_at IS NULL`, finds their users' subscriptions, POSTs an empty body to each endpoint with `pushHeaders`, deletes dead ones, and sets `pushed_at = now()` on the rows it handled.
  - It returns `{ users, sent, removed }`.
  - With no VAPID keys configured it only marks rows pushed and returns `{ skipped: 'no VAPID keys' }`.
- **Env:** `VAPID_PRIVATE_KEY` (PEM), `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (base64url raw P-256), `VAPID_SUBJECT` (mailto:), `CRON_SECRET`. All are placeholders in `.env.example`, with a one-line `node -e` key-generation hint.

- [ ] **Step 1: Failing unit tests:**
  - `vapidJwt`'s header is `{ typ: 'JWT', alg: 'ES256' }`;
  - the claims carry the given `aud`, `sub` and `exp = floor(now/1000) + expires`;
  - the signature verifies with the matching public key (`crypto.verify` with `ieee-p1363`);
  - `deadSubscription(410)` and `(404)` are true, `(201)` is false;
  - `pushHeaders` contains `vapid t=` and `k=`.
- [ ] **Step 2:** run → FAIL (module not found).
- [ ] **Step 3:** implement the library, the table and RPC (DB test: a user saves a subscription and cannot see another user's), the route and the env placeholders.
- [ ] **Step 4:** run the unit tests, `notifications` and typecheck → pass.
- [ ] **Step 5: commit** `feat(notifications): free web push without a payload`.

### Task 4: The bell, the service worker, the reminder setting

**Files:**
- Create: `src/components/NotificationBell.tsx`, `public/sw.js`, `src/lib/push-client.ts`
- Modify: `src/views/society/SocietyDashboardPage.tsx`, `src/views/resident/ResidentDashboardPage.tsx`, `src/views/society/tabs/SettingsTab.tsx`

**Interfaces:**
- **`NotificationBell`** `{ onOpen?: (link: string) => void }`:
  - a bell icon with an unread badge (`unread_notification_count`, refreshed every 60 s and on open);
  - a dropdown of the latest 30 notifications (title, body, relative time; unread in bold);
  - "Mark all read" calls `mark_notifications_read(null)`;
  - clicking an item marks it read and calls `onOpen(link)`;
  - a footer button "Turn on phone notifications", shown when `'PushManager' in window` and permission is not granted, calls `enablePush()`.
- **`push-client.ts`** `enablePush(): Promise<'enabled' | 'denied' | 'unsupported' | 'not-configured'>`: registers `/sw.js`, asks permission, subscribes with `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, and saves the subscription through `save_push_subscription`.
- **`public/sw.js`:**
  - `push` → `showNotification('Sahvaas', { body: 'You have a new message', icon: '/icon.svg', tag: 'sahvaas' })`;
  - `notificationclick` → focus an open client, or open `/`.
- **The dashboards** put the bell in the header. The society dashboard's `onOpen` calls `goTo(link)` when the link is a known tab; the resident dashboard switches its own view where one exists.
- **`SettingsTab`** gets the section "Dues reminders": "Remind [n] days after the due date, then every [m] days", with Save calling `set_reminder_schedule`, read-only for viewers. The secretary's bill issuing and notice publishing call `fetch('/api/push/send-pending', { method: 'POST' })`. This fails silently without the secret, because the route refuses; the cron path is the real sender. Ledger a Ruling.

- [ ] **Step 1:** implement.
- [ ] **Step 2:** verify:
  - typecheck and lint are clean on the touched files;
  - the full suite, one file at a time, has no FAIL;
  - `bunx next build` compiles.
- [ ] **Step 3: commit** `feat(notifications): bell and inbox in the app, phone notifications, reminder schedule in Society settings`.
