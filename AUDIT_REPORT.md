# Sahvaas — Post-Build Audit (P0–P6)

**Date:** 19 Oct 2026  
**Scope:** everything built so far — 10 migrations (49 tables, 55 functions), Next.js app (4 portals + public site), `/api/notify`, scripts, CI, hosted Supabase state.  
**Method:**
1. Code review of every migration, page and component.
2. **Live probes:** each suspected issue was reproduced on a real Postgres (PGlite) with the exact migrations, acting as real users under RLS. "✅ Reproduced" below means the risky behaviour actually happened, not "might happen".
3. Read-only checks on the hosted Supabase DB (migrations 001–010 applied, RLS on all 49 tables, bucket + cron present).
4. Existing suite: 81 automated tests passing (`bun run test`), typecheck + lint clean, production build green.

---

## 0. Fix status

### F1 — done (19 Oct 2026, migration `011_integrity.sql`, applied to hosted Supabase)
| ID | Status | How |
|---|---|---|
| C1 | ✅ code side | `.env.example` is a placeholder-only template (user removed the real values). **Still recommended:** rotate DB password + service role key if the old file was ever shared |
| C2 | ✅ | `chk_expenses_document_in_society` (+ notices); storage read policy requires the record's society = folder society; uuid parsing never throws (`storage_society_id`) |
| H1 | ✅ | No client write policies on bills / bill_items / billing_cycles; flats deletable only without bills/payments/complaints; expenses deletable only before approval; bills/payments FKs no longer cascade. Corrections: `cancel_bill()` and `void_expense()` post reversal journals (UI: *Cancel bill*, *Void*) |
| H2 | ✅ | Client UPDATE removed for bills, bill_items, billing_cycles, payments — only the workflow RPCs change them |
| H4 | ✅ | Auth listener is synchronous, loads only on SIGNED_IN (new user) / USER_UPDATED, ignores hourly TOKEN_REFRESHED, keeps & remembers the selected society |
| M1 | ✅ | `trg_societies_guard_platform_fields` — subscription_status / is_active / slug / total_units only via platform/system functions |
| M2 | ✅ | Bill numbers continue after the month's highest number; a fully cancelled cycle can be regenerated |
| M8 | ✅ | `/dev/diagnostics` and the schema viewer removed |
| L3 | ✅ | Storage policies no longer depend on evaluation order |

**Verification:** `tests/db/integrity.test.mjs` turns the probes into regression tests (8 tests); full suite 89/89; re-running the audit probes now prints SAFE for P1–P6, P8–P10. Hosted DB checked read-only after applying 011 (no client write policies on money tables, no cascading FKs, guard trigger + RPCs present, `ledger_reverse` not callable by clients).

### F2 — done (19 Oct 2026, migration `012_consent_and_roles.sql`, applied to hosted Supabase)
| ID | Status | How |
|---|---|---|
| H3 | ✅ | The app no longer auto-claims invites. `my_pending_invites()` + `respond_to_invite(kind, id, accept)` (verified email only); **Accept / Decline** banner on every signed-in page; declined invites leave the committee with no access to the person's profile |
| M3 | ✅ | `society_summary()` computes dashboard + billing totals in the DB; list queries capped at 500 rows with stable ordering |
| M4 | ✅ | Resident portal uses the membership that has a flat; owners with several flats get a flat selector; bills/payments filtered per flat |
| M5 | ✅ | Mobile bottom bar has **More** → every module (13) reachable on a phone, with pending badges |
| M6 | ✅ | `committee_member` = read-only committee: 23 read policies + reports via `is_committee_viewer()`; dashboard shows a read-only banner; writes still need Secretary/Treasurer/Chairman/Admin |
| M7 | ✅ | Contact form saves to `leads` (anon insert, validated, 3/day per email, honeypot); Platform console → Demo Requests with status |
| M12 | ✅ | `notification_log` + `reserve_notification()`: same event emailed once per 24 h, ≤ 2000 emails/society/day, committee only; `/api/notify` checks it before sending |

**Verification:** `tests/db/f2.test.mjs` (7 tests) — full suite 96/96, build green; hosted DB checked read-only (12 migrations, 23 committee_read policies, RLS on every table, internal helper not callable by clients).

**Still open:** H5 SMTP + deploy → F3 (needs your accounts). M9–M11 and L-items → backlog.

---

## 1. Verdict

**Feature-wise MVP complete hai, lekin abhi paying society ko dene layak nahi.** Foundation strong hai (tenant isolation, double-entry ledger, maker-checker, CA scoping), par **2 critical + 5 high** issues hain jo pilot se pehle fix hone chahiye. Zyada tar ek hi pattern se aate hain: *committee ke paas tables pe seedha write access hai, jo workflow (verify / approve / ledger) ko bypass kar deta hai.*

| Area | Score | Comment |
|---|---|---|
| Tenant isolation & auth | 7/10 | RLS on 49/49 tables, cross-society reads blocked — except one storage hole (C2) and forced invites (H3) |
| Financial integrity | 5/10 | Ledger always balances, but direct edits/deletes can make bills, payments and books disagree (H1, H2) |
| Features vs promise | 8/10 | Billing, UPI, receipts, ledger, reports, GST-2B, CA portal, ops all built |
| Frontend / UX | 6/10 | Works on desktop; mobile misses 7 modules; auth listener bug (H4) |
| Ops / launch readiness | 5/10 | CI, migrations runner, deploy guide ready; secrets hygiene + SMTP + monitoring pending |
| Tests | 7/10 | 81 strong DB/unit tests; zero browser/E2E tests |

---

## 2. Findings

Severity: 🔴 Critical (fix now) · 🟠 High (before pilot) · 🟡 Medium (before paid launch) · ⚪ Low (backlog)

### 🔴 Critical

**C1 — Real secrets in `.env.example` (tracked file)**
- File contains the **DB password (`SUPABASE_DB_URL`)**, **service role key** and anon key. `.env.example` is *not* gitignored (`!.env.example`), so one `git add .` / push publishes full database control.
- Status: never committed (verified each commit excludes it). Repo has no remote yet.
- **Fix:** put placeholders back in `.env.example` (real values already live in gitignored `.env.local`). If the file was shared anywhere → reset DB password + rotate service role key in Supabase. Add a pre-commit secret scan (e.g. gitleaks) to CI.

**C2 — Cross-society private file read via `expenses.document_url`** ✅ Reproduced (P1)
- Storage read policy allows a file if *any expense the caller can see* has `document_url = <path>`. Expenses have no constraint tying the path to their own society (documents do — `chk_documents_path_in_society`).
- Attack: Society B's committee creates an expense with `document_url = '<SocietyA-id>/expenses/<file>'` → can download Society A's invoice/bank document. Paths contain random UUIDs, but they leak via screenshots, shared links, CA exports.
- **Fix:** `CHECK (document_url IS NULL OR document_url LIKE society_id::text || '/%')` on expenses (and any future file column) + make the storage policy also require `(storage.foldername(name))[1] = <row's society_id>`.

### 🟠 High

**H1 — Committee can delete financial records** ✅ Reproduced (P2, P5, P8)
- `DELETE billing_cycles` → all its bills cascade away; the ledger still shows the receivable (P2).
- `DELETE units` (a flat) → its bills **and payments** are destroyed (P5).
- `DELETE expenses` on a *paid* expense → expense gone, ledger still debits 5100 (P8). Same for `bills`, `bill_items`.
- Impact: books and records disagree permanently; an auditor sees journal entries with no source document; a careless or malicious member can wipe history. No UI does this today — the API does.
- **Fix:** BEFORE DELETE triggers that block deletes once a record is posted/has dependants; replace with **cancel / void** workflows that post a reversal journal (bill cancel, credit note, expense void). Change `bills.unit_id`, `payments.unit_id`, `bills.cycle_id` FKs from `ON DELETE CASCADE` to `RESTRICT`.

**H2 — Direct UPDATEs bypass the money workflows** ✅ Reproduced (P3, P4, P4b)
- Bill set to `paid` by plain UPDATE → dues report says paid, receivable stays in the ledger (P3).
- Payment set to `verified` by plain UPDATE → no receipt number, no allocation, bill stays unpaid, whole amount lands in Advance (P4).
- A verified payment's `amount` can be edited afterwards (P4b). `bill_items` can be edited without totals changing.
- Expenses already have the right pattern (guard trigger + RPC flag). Bills / payments / bill_items don't.
- **Fix:** guard triggers: financial columns of `bills`, `payments`, `bill_items` change only inside `generate_bills / verify_payment / apply_late_fees / ledger_apply_advance` (session flag like `sahvaas.expense_workflow`).

**H3 — Invites auto-join without consent; leaks phone** ✅ Reproduced (P7)
- `claim_my_invites()` runs on every login and accepts **all** pending invites for the email. Any committee anywhere can invite any email → the person silently becomes a member → that committee can read their name, email **and phone** (`profiles_society_admin_read`).
- Also enables spam (unwanted societies in the switcher) and impersonation ("you are a member of X CHS").
- **Fix:** show pending invites after login with **Accept / Decline**; claim only the accepted invite. Same for professional invites.

**H4 — Auth listener can deadlock and resets the selected society** (code review)
- `onAuthStateChange(async …)` awaits Supabase queries inside the callback (`AuthContext.tsx:275-281`). Supabase documents that awaiting other Supabase calls inside this callback can dead-lock the client → users stuck on "Verifying… permissions" spinner.
- The listener also reloads on every `TOKEN_REFRESHED` (~hourly) without keeping the chosen society → a CA or multi-society user is silently switched back to the first society mid-work.
- Startup and login also load authorizations twice (initSession + INITIAL_SESSION/SIGNED_IN).
- **Fix:** keep the callback synchronous; dispatch loading with `setTimeout(…, 0)`; react only to `SIGNED_IN` / `SIGNED_OUT` / `USER_UPDATED`; preserve `activeSociety`.

**H5 — Email delivery is not production-ready** (ops)
- The whole access model depends on **verified email** (signup, invites, CA access, password reset). Supabase's built-in mailer sends only a handful of emails per hour and is meant for testing → at pilot scale, verification mails won't arrive and nobody can join.
- **Fix:** configure custom SMTP (Resend / SES / Zoho) in Supabase Auth before inviting a real society; set `RESEND_API_KEY` + `EMAIL_FROM` for app notifications.

### 🟡 Medium

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| M1 | Committee can self-upgrade: `UPDATE societies SET subscription_status='active', total_units=…` succeeds | ✅ P6 | Column guard: subscription_status / is_active / slug / total_units changeable only by platform RPCs or system functions |
| M2 | Second billing cycle in the same month fails — bill numbers `BYYMM-NNNN` collide | ✅ P9 | Number from max existing per society (like TKT/EXP) or include cycle sequence |
| M3 | Dashboards fetch whole tables (`bills`, `units`, `expenses`…) without paging; Supabase API returns max **1000 rows** by default → summaries and lists silently wrong for bigger societies (100 flats × 10 months) | code `SocietyDashboardPage.tsx:79-83` | Aggregate RPCs for totals; paginate lists |
| M4 | Resident portal uses the *first* membership of the society; a user who is committee **and** owner (e.g. secretary living there, the demo seed user) may get the committee membership → "flat not linked", Pay button fails | code `AuthContext.tsx:498` | Resident page picks the membership with a `unit_id`; support multiple flats |
| M5 | Mobile: sidebar is hidden below `md`; bottom bar has 5 items → **Flats, Members, Notices, Documents, CA access, Reports, Settings unreachable on a phone** (app is marketed mobile-first) | code `SocietyDashboardPage.tsx:153,433` | "More" sheet in the bottom bar |
| M6 | `committee_member` role gets the committee dashboard but RLS gives it no data (bills/payments invisible) | ✅ P11 | Decide: read-only committee access (add to read policies) or treat as resident |
| M7 | Contact / "Schedule a demo" form only shows "Thank you" — leads are thrown away | code `ContactPage.tsx` | Store in a `leads` table + email the platform owner |
| M8 | `/dev/diagnostics` (schema viewer) is public, no auth | code `app/dev/diagnostics/page.tsx` | Remove from production build or restrict to platform admin |
| M9 | Accounting gaps: no voucher for paying GST/TDS to government, bank charges, interest earned, fund transfers; no bill cancel / credit note / refund; no financial-year lock. GST/TDS payable grow forever → CA cannot close the year in-app | design | Journal voucher screen (committee + maker-checker), statutory payments, cancel/credit note, FY close & lock |
| M10 | Late fee = one-time % per bill. Most bye-laws charge **simple interest p.a.** on arrears (often up to 21% p.a.) | design | Configurable: one-time fee vs monthly interest at X% p.a. |
| M11 | No Content-Security-Policy header | `next.config.mjs` | Add CSP (self + Supabase URL) |
| M12 | `/api/notify`: no rate limit / dedupe (committee can resend endlessly; invite email can target any address from your domain); `bills_issued` silently caps at 500 | code | `notification_log` table, one email per event, daily cap per society |

### ⚪ Low / backlog

- **L1** Dates use UTC `current_date`; actions between 00:00–05:30 IST are dated the previous day (payment_date, bill_date, receipts).
- **L2** Residents can read all flats incl. `current_owner_id` / `current_tenant_id` UUIDs (no names).
- **L3** Storage policy casts folder → uuid; safe in tests (P10) but depends on evaluation order — guard with a regex before the cast.
- **L4** Building code derived from name: "Tower A" and "TowerA" merge into one building.
- **L5** `src/types/database.ts` is hand-written — generate from the DB (`supabase gen types --db-url`) to avoid drift.
- **L6** Accessibility: most text is 10–12 px (`text-xs`, `text-[10px]`) — hard for older committee members; raise base size, check contrast.
- **L7** No profile screen (name / phone) → WhatsApp links can't pre-fill the number; `profiles.email NOT NULL` blocks phone-only signup.
- **L8** Footer says "Sahvaas Technologies Pvt. Ltd." and contact page shows placeholder phone/address — legal/brand risk if not real.
- **L9** Opening "Advance received" (2300) is a society total, not per flat → not auto-adjusted against bills.
- **L10** Receipt numbers continue across years (`RCPT-2027-00045`); auditors usually expect FY-wise series.
- **L11** PWA: manifest only, no service worker / offline cache; no error monitoring (Sentry) yet.
- **L12** Abuse: unlimited signups, 3 societies/user/day — fine for pilot, add CAPTCHA before public launch.

---

## 3. What is solid (keep as is)

- **RLS on 49/49 tables**, verified on the hosted DB; tenant isolation, resident privacy and CA scoping covered by tests.
- **Double-entry ledger** posts automatically from events; every journal balances (enforced in `post_journal`), idempotent per event, clients cannot write ledger rows.
- **Maker-checker** for expenses; reject reasons; paid expenses locked.
- **Payment flow**: duplicate-UTR guard, FIFO allocation, receipts, advance auto-adjust.
- **Invites claim only verified emails**; CA access is time-boxed, permission-catalogued, revocable, logged.
- **Security basics**: patched Next.js, open-redirect fix, SECURITY DEFINER functions with fixed `search_path`, internal functions not callable by clients, security headers, secrets never committed.
- **Engineering**: numbered + tracked migrations (`bun run db:migrate`), consolidated-SQL drift test, real-Postgres tests incl. the runner over the wire protocol, CI pipeline, deploy guide.

---

## 4. Recommended plan

### F1 — Integrity & security fixes (≈ 1–2 days) ← **next**
1. C1 placeholders in `.env.example` + secret scan in CI (you: rotate keys if the file was shared).
2. Migration `011_integrity.sql`: C2 path constraints, H1 delete guards + RESTRICT FKs, H2 update guards for bills / payments / bill_items, M1 society column guard, M2 bill numbering.
3. H4 AuthContext listener rewrite.
4. M8 remove `/dev/diagnostics`.
5. Turn every probe in this report into a regression test (they currently prove the bug; after the fix they must prove it is blocked).

### F2 — Product fixes before pilot (≈ 2–3 days)
H3 invite accept/decline screen · M3 aggregate RPCs + pagination · M4 resident membership pick · M5 mobile "More" menu · M6 committee_member decision · M7 leads table · M12 notification log/limits · bill cancel / credit note (part of M9).

### F3 — Go-live ops (your accounts needed)
H5 custom SMTP · Supabase auth redirect URLs · Vercel deploy + domain · Sentry · Playwright smoke test of the full flow on the deployed site · backups (Pro plan).

### Later
Journal vouchers, statutory payments, FY lock (M9) · interest on arrears (M10) · CSP (M11) · L-items · bank reconciliation · GSTR-2B credit notes · subscription payments (Razorpay).

---

## Appendix — probe results (local Postgres, migrations 001–010)

```
CONFIRMED P1  Society B admin can read Society A's private file by pointing an expense at its path
CONFIRMED P2  Committee can DELETE a billing cycle → bills vanish, ledger keeps the receivable
CONFIRMED P3  Committee can UPDATE a bill to paid directly → ledger still shows receivable
CONFIRMED P4  Committee can set payment "verified" directly → no receipt, bill unpaid, amount to Advance
CONFIRMED P4b Committee can change the amount of an already-verified payment
CONFIRMED P5  Committee can DELETE a flat → its bills and payments are destroyed
CONFIRMED P6  Committee can set its own subscription_status=active / total_units
CONFIRMED P7  Any committee can add a stranger (by email) without consent and read their phone
CONFIRMED P8  Committee can DELETE a paid expense → ledger still shows it
CONFIRMED P9  A second billing cycle in the same month fails (bill number collision)
SAFE      P10 Storage listing with a non-uuid-folder bucket (works today; harden anyway)
CONFIRMED P11 committee_member gets the dashboard but sees no bills/payments
```
