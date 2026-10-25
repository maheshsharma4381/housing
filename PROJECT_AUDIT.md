# Sahvaas (formerly Sahaniwas) — Project Audit

**Date:** 13 Oct 2026  
**Last update:** 13 Oct 2026 — P0 stabilize done (see §0)  
**Scope:** Poora repo (frontend, routing, auth, Supabase schema/RLS, build setup)  
**Purpose:** Kya bana hai, kya toota hai, kya baaki hai — taaki next developer (ya future you) seedha kaam shuru kar sake.

---

## 0. Progress log

### P0 — Stabilize ✅ (13 Oct 2026, commits `f9e41e9`, `e4ce6ee`)
| Audit item | Status |
|---|---|
| §5.0 Next 15.2.0 CVEs | ✅ Upgraded to **next 15.5.27** |
| §5.0 TS 7 hang | ✅ Pinned `typescript ~5.8.3` |
| §5.0 No git repo | ✅ `git init`, `.next/` ignored |
| §5.1 Vite + Next mix | ✅ Vite removed, `src/pages` → `src/views`, scripts = `next dev/build/start`, type+lint checks back on, ESLint flat config |
| §5.2 Login 404 | ✅ Redirects to `/platform`, `/society`, `/resident`, `/professional` |
| §5.3 Stale redirect state | ✅ `loadUserAuthorizations` returns fresh values |
| §5.4 Open redirect | ✅ `src/lib/safe-redirect.ts` |
| §5.5 RLS escalation holes | ✅ `004_rls_hardening.sql` (payments, complaints trigger, audit/access logs, bank accounts) |
| §5.6 Tables without policies | ✅ Policies added in 004 (+ societies insert for platform admin, society admins can read member profiles) |
| §5.7 Fake UPI / unit_id / UTR / payment no. | ✅ Real QR from `society_settings`, validation, errors shown |
| §5.7 Permission name mismatch, counts, route guards, redirect loop | ✅ |
| §5.8 Brand naming | ✅ **Sahvaas** everywhere in code |
| §5.8 Mojibake | ✅ False alarm — files are valid UTF-8 (it was a terminal display issue) |
| §5.8 Zoom blocked, README, env example | ✅ |

**Verified:** `tsc` ✅, `eslint` (0 errors) ✅, `next build` ✅ (17 routes), `next start` smoke test ✅ (/, /login, /society, /pricing 200; unknown → 404). All 4 migrations parse with libpg-query ✅.

**Not verified yet:** migrations have **not been run** on a real Supabase DB; no logged-in browser test (no Supabase project configured).

**Still open from §5:** `gst_2b_*` FOR ALL policies (kept intentionally — CA uploads 2B), membership role-change rules, `committee_member` gets `/society` UI but `is_society_admin()` excludes it (decide), `profiles.email NOT NULL` for phone signup, marketing copy vs real features, contact page placeholder details + "Sahvaas Technologies Pvt. Ltd." footer text, `mock-data.ts` → seed script, ~60 lint warnings (unused imports, hook deps), PWA service worker (removed with Vite — add `@serwist/next` later).

### P1 — Onboarding ✅ (14 Oct 2026, commit `7507cdc`)
| §6.1 item | Status |
|---|---|
| Signup page | ✅ `/signup` (email verification flow) |
| Create Society | ✅ `/onboarding` → `create_society()` RPC: society + settings + creator committee membership + default 19-account chart of accounts + audit log |
| Units bulk create + CSV import | ✅ Society → Flats → "Import Flats (CSV)" → `bulk_upsert_units()` (upsert by wing + flat no., max 2000 rows, row-numbered errors); client parser `src/lib/unit-csv.ts` with header aliases |
| Member invite | ✅ Society → Members: invite by email + role + flat; `member_invites` table; invitee auto-linked on login via `claim_my_invites()` (**verified emails only**); revoke invite, remove member |
| Society settings | ✅ Society → Society Rules: UPI ID/payee (feeds resident QR), due day, late fee, 2-step approval |
| Setup checklist | ✅ Home tab shows remaining steps |
| Seed | ✅ `src/db/seed/demo_seed.sql` (32 flats, bill, notices, expense, complaint); `mock-data.ts` deleted |
| Platform admin approve/suspend | ⏳ moved to P6 |

**Tests added:** `bun run test` → 27 tests. DB tests run all migrations on **real Postgres (PGlite/WASM)** with a Supabase `auth` stub (`tests/db/harness.mjs`) and verify RLS isolation, payment/complaint/audit-log hardening, onboarding RPCs and the seed. 004 is now run-tested, not just parsed.

**Still not verified:** migrations on the hosted Supabase project; email delivery (invites rely on the user signing up themselves — no invite email is sent yet).

### P2 — Money loop ✅ (19 Oct 2026, commit `77e19b0`)
| §6.2 / §6.3 item | Status |
|---|---|
| Billing rules CRUD | ✅ Society → Billing: per flat / per sq.ft, GST 0/18%, flat-type filter, pause/delete |
| Cycle → bills generate | ✅ `generate_bills()` with **dry-run preview**; one cycle per period; bill items per rule; flats without owner are listed as skipped |
| Late fee job | ✅ `apply_late_fees()` button (flat ₹ or % once per bill, marks overdue). ⏳ Not scheduled yet — needs pg_cron / Edge Function |
| Resident pays specific bill | ✅ (P0 QR) + duplicate-UTR guard |
| Treasurer verify/reject | ✅ `verify_payment()`: receipt `RCPT-YYYY-NNNNN`, FIFO allocation (`payment_allocations`), bill status/balance updated; reject needs reason |
| Receipt | ✅ `/receipt/[id]` print / Save as PDF, amount in words |
| Bill PDF / WhatsApp share | ⏳ |
| Bank statement CSV auto-match | ⏳ (P6) |

**Tests:** `bun run test` → 41 tests (billing flow end-to-end on PGlite, consolidated-SQL drift check, INR helpers).

**Known gaps:** overpayment ("advance") is shown on the receipt but **not auto-applied to the next bill**; tenant-only flats can't see the owner's bill; no ledger postings yet (P3).

### P3 — Ledger ✅ (19 Oct 2026)
| §6.4 item | Status |
|---|---|
| Default chart of accounts | ✅ `ensure_default_accounts()` (+ seeded by `create_society`) |
| Posting triggers | ✅ `007_ledger.sql`: bill issued (deferred trigger, after items exist) → Dr 1200 / Cr income-or-fund per rule `account_code` + 2100 GST; late fee → Dr 1200 / Cr 4100; payment verified → Dr 1000 (1100 cash) / Cr 1200 + 2300 advance; expense paid → Dr 5xxx (by category) / Cr 1000 + 2200 TDS. Idempotent per event; unbalanced journals are rejected |
| Ledger write only via triggers | ✅ No client write policies; `post_journal` not executable by clients |
| Reports | ✅ `trial_balance()`, `income_expenditure()`, `member_dues()` RPCs (committee / platform / CA with `view_reports` or `view_ledger`); Balance Sheet derived from TB; Journal view; CSV export. Society → Financial Reports and CA portal → Financial Reports |
| Billing rule → account | ✅ "Credit to" (Maintenance / Sinking / Repair / Reserve / Other income) |
| Backfill | ✅ 007 posts pre-existing bills, late fees, verified payments, paid expenses; re-run safe |

**Tests:** 53 total — ledger postings, every journal balanced, TB Dr = Cr, I&E numbers, access control, backfill from a 006-era DB.

**Known gaps:** bill cancellation has no reversal entry; advance (2300) is not auto-adjusted against later bills; one late fee per bill; opening balances for societies migrating from Tally/registers not supported yet (needs an "opening balance" journal screen).

### P4 — Daily operations ✅ (19 Oct 2026)
| §6.5 / §6.6 item | Status |
|---|---|
| Vendor CRUD | ✅ quick-add from the expense form (name, phone, GSTIN) — full vendor list/edit screen ⏳ |
| Expense + invoice upload | ✅ auto `EXP-NNNN`, net = taxable + GST − TDS computed in DB, PDF/image invoice to Storage |
| Two-step approval (maker/checker) | ✅ `decide_expense()`: creator can't approve, one decision per member, 2 approvals when "two-step" is on, reject needs reason; direct status/amount edits blocked by trigger |
| Mark paid + TDS | ✅ `mark_expense_paid()` → ledger posts Dr expense / Cr Bank + TDS Payable; paid expenses locked |
| Notices | ✅ Society → Notice Board: category, audience (all / owners / tenants / committee), expiry, pin; RLS enforces audience + expiry; publisher stamped |
| Complaints | ✅ Resident "New Ticket" (works now), auto `TKT-NNNN`, comment thread (`complaint_updates`), committee assigns / changes status / resolution notes, `resolved_at` tracked |
| Documents vault | ✅ private bucket `society-files` (10 MB, PDF/images), storage policies mirror `documents` RLS (committee-only docs hidden from residents), signed URLs, resident Docs tab |
| Push / WhatsApp / SMS | ⏳ (P6) |

**Tests:** 60 total. PGlite harness now stubs Supabase Storage (`storage.buckets`, `storage.objects`, `storage.foldername`) so storage policies are tested too.

**Notes for the hosted project:** 008 inserts the `society-files` bucket and creates policies on `storage.objects` — run it from the SQL Editor (postgres role). Demo seed's expense is "created" by the seeding user, so with only one committee member it stays pending (maker-checker working as designed — invite a second committee member to approve).

**Pilot-ready checklist:** onboarding ✅ billing ✅ payments ✅ receipts ✅ ledger/reports ✅ notices ✅ tickets ✅ documents ✅ expenses ✅. Remaining before a paid launch → P5 (CA invite flow, GSTR-2B), P6 (deploy, notifications, opening balances, subscriptions).

### P5 — CA portal ✅ (19 Oct 2026)
| §6.7 item | Status |
|---|---|
| Invite → accept → grant | ✅ Society → CA & Auditor Access: email + role + permission checkboxes (role presets) + "access until"; `claim_professional_invites()` on login (verified email only); permission catalog enforced by CHECK constraint |
| Expiry / revoke | ✅ edit permissions, revoke (reason, `revoked_at` stamped), restore; expired grants stop working immediately (RLS + RPC checks) |
| Permission-scoped read-only views | ✅ CA portal: Financial Reports, GST, Expenses & TDS, Audit Vault (documents), locked tabs for un-granted modules |
| GSTR-2B upload + matching | ✅ client parser for official portal JSON (items summed, CDNR/amendments reported as skipped) and CSV (portal B2B sheet or template); `import_gstr2b()` matches supplier GSTIN + normalised invoice no. against expenses (±₹1) → Matched / Amount mismatch / Not in books / Not in 2B (ITC at risk); `gst_reconciliation_detail()`; CSV export; re-upload replaces the period |
| Review remarks | ✅ `audit_remarks`: CA writes (module, ref, severity), committee responds, CA closes; trigger stops either side editing the other's part |
| Access logs | ✅ every module the CA opens is logged; committee sees "Recent Professional Activity" |

**Tests:** 71 total (invite/claim/expiry/revoke, scoped access, remarks, 2B matching & validation; parser unit tests).

**Known gaps:** credit/debit notes (CDNR) and amendments in 2B are not reconciled; GST "review sign-off" uses `gst_reconciliations` table but has no UI yet; no invite emails are sent (CA signs up with the invited email); bank reconciliation module still a placeholder.

### P6 — Launch readiness ✅ (19 Oct 2026) — code side; deploy is a manual step
| Item | Status |
|---|---|
| Opening balances | ✅ `post_opening_balances()` once per society: TB lines + flat-wise arrears (become payable "OB-" bills, no income posted), difference → 3200 General Reserve. UI: Society Rules → Opening Balances |
| Advance auto-adjust | ✅ overpayments now settle the flat's next bill automatically (Dr 2300 / Cr 1200) |
| Scheduled late fees | ✅ `apply_late_fees_all()` + pg_cron job `sahvaas-late-fees` (00:30 IST) when pg_cron is enabled; opening arrears excluded |
| Suspension | ✅ all access helpers require `societies.is_active`; platform owner suspends/cancels (reason required) or reactivates by assigning a plan |
| Platform console | ✅ real overview (societies, flats, members, billed / collected this month), status + plan management, users, audit log. Plans seeded (₹12 / ₹18 / ₹25 per flat) |
| Notifications | ✅ `/api/notify` (member & CA invites, bills issued, receipts) via Resend when `RESEND_API_KEY` + `EMAIL_FROM` are set — committee-only, reads through caller's RLS; **WhatsApp share** links (invites, receipts) work with no setup |
| Security headers | ✅ X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, HSTS |
| CI | ✅ `.github/workflows/ci.yml`: typecheck, lint, 80 tests, build |
| Go-live guide | ✅ `DEPLOYMENT.md` (Supabase, pg_cron, auth URLs, SMTP, Vercel env, smoke test) |
| Deploy to Vercel / custom domain | ⏳ needs your Vercel + domain accounts (steps in DEPLOYMENT.md) |
| Error monitoring (Sentry) | ⏳ recommended before scale |
| PWA offline caching, push notifications | ⏳ |
| Bank statement auto-reconcile, GSTR-2B CDNR | ⏳ |
| Charging societies (subscription invoices / Razorpay) | ⏳ plan + period tracked only |

**Tests:** 80 total. Smoke-tested `next start`: security headers present, `/api/notify` → 401 when signed out, protected routes redirect to login.

---

## 0.2 Post-build audit (19 Oct 2026)

Full findings in **[AUDIT_REPORT.md](AUDIT_REPORT.md)**: 2 critical, 5 high, 12 medium, 12 low — 10 of them reproduced on real Postgres.

**F1 done** (migration `011_integrity.sql`, applied to hosted DB; 89 tests): C1, C2, H1, H2, H4, M1, M2, M8, L3 fixed — see AUDIT_REPORT §0. **F2 done** (migration `012_consent_and_roles.sql`, applied to hosted DB; 96 tests): H3, M3, M4, M5, M6, M7, M12 — see AUDIT_REPORT §0. **Next: F3 — go-live** (custom SMTP, Supabase auth URLs, Vercel deploy, Sentry, browser smoke test) — needs the owner's accounts.

Hosted Supabase (`ketutwhtrjduiknoadkl`): migrations 001–010 applied and verified on 19 Oct 2026 via `bun run db:migrate` (DB URL in `.env.local`).

## 0.1 Current state summary (19 Oct 2026)

**Code: feature-complete MVP (P0–P6).** Migrations 001–010 (`ALL_MIGRATIONS_CONSOLIDATED.sql`), 80 automated tests, CI.

**Not yet done by anyone:** running the migrations on the hosted Supabase project and a real browser walkthrough. Follow `DEPLOYMENT.md` §1–§4 — expect a round of small fixes from the first live run (things PGlite cannot catch: Supabase Storage internals, email redirects, SMTP).

---

## 1. TL;DR (original audit snapshot — see §0 for what's fixed)

| Area | Status | Short verdict |
|---|---|---|
| Marketing website (Home, Features, Pricing, Security, Contact…) | ~90% | UI ready. Contact form kahin submit nahi hota. |
| Auth (login / forgot / reset password) | ~70% | Supabase auth wired. Login ke baad redirect broken (404). Signup UI nahi hai. |
| Database schema (40 tables) | ~85% | Bahut acha, India-specific (GST, UPI, TDS, fiscal April). |
| RLS / security policies | ~50% | Core tables covered; ~20 tables pe policy hi nahi; kuch policies privilege-escalation allow karti hain. |
| Society admin dashboard | ~25% | Sirf **read-only list** (units, bills, expenses, complaints). Koi create/edit/approve nahi. |
| Resident dashboard | ~35% | Bills/notices/complaints dekh sakte hain + UTR submit. "New Ticket" button dead. |
| Professional (CA) dashboard | ~10% | Shell + permission-based tabs. GST upload button dead. |
| Platform owner dashboard | ~25% | Societies + users list. Baaki 7 tabs placeholder. |
| Financial engine (bills, ledger, double-entry) | **0%** | Tables hain, logic/triggers bilkul nahi. |
| GST 2B reconciliation | **0%** | Sirf tables + UI placeholder. |
| PWA | ~70% | Manifest + install button + offline banner. Service worker sirf Vite build me. |
| Tests / CI / docs | 0% | Koi test nahi, README AI Studio template hai. |

**Overall: ~30–35% of a usable MVP.** Foundation (schema, auth, role model, UI shell) acha hai; actual business features (billing cycle, payment verification, expense approval, ledger, GST) abhi baaki hain.

---

## 2. Project kya hai

Multi-tenant **Housing Society Management SaaS** (India focus). 4 portals:

1. **Platform Owner** (`/platform`) — SaaS owner, sab societies manage karta hai.
2. **Society Committee** (`/society`) — Secretary / Chairman / Treasurer / Admin.
3. **Resident** (`/resident`) — Flat owner / tenant: bills, UPI payment UTR, notices, complaints.
4. **Professional** (`/professional`) — CA / Auditor / GST consultant, sirf society ke grant ke baad, permission-wise access.

Key product ideas (marketing pages me promise kiye gaye):
- UPI QR + UTR entry se payment (no gateway fee), treasurer verify kare
- Auto double-entry ledger har event pe
- GSTR-2B JSON/Excel upload se ITC reconciliation (no GST portal password)
- Per-unit pricing: ₹12 / ₹18 / ₹25 per unit per month
- Mobile-first PWA

Source: originally **Google AI Studio** se generate hua (README, `metadata.json`, `vite.config.ts` comments, `@google/genai` dependency).

---

## 3. Tech stack & structure

| Layer | Tech |
|---|---|
| Framework | **Next.js 15.2 (App Router)** + leftover **Vite 8** setup (dono ek saath — see §5.1) |
| UI | React 19, Tailwind v4, lucide-react icons, `motion` (installed, unused) |
| Backend | Supabase (Auth + Postgres + RLS). Koi custom API / server action nahi. |
| PWA | `vite-plugin-pwa` (sirf Vite build), `src/app/manifest.ts` (Next) |
| Unused deps | `@google/genai`, `express`, `dotenv`, `motion`, `tsx`, `esbuild` |

```
src/
  app/                 ← Next.js App Router routes (thin wrappers)
    page.tsx, login/, forgot-password/, reset-password/,
    features/, societies/, accountants/, security/, pricing/, contact/,
    platform/, society/, professional/, resident/, dev/diagnostics/,
    layout.tsx, error.tsx, not-found.tsx, manifest.ts
  pages/               ← actual page components (⚠ Next isse Pages Router samajh sakta hai)
    public/  society/  resident/  professional/  platform/  dev/
  components/          ← PublicHeader/Footer, ProtectedRoute, WorkspaceSelector, EmptyState, PWA, Offline
  context/AuthContext.tsx   ← saara auth + role/membership loading
  router/RouterContext.tsx  ← next/navigation ka thin adapter
  lib/supabase/        ← client.ts, server.ts, mock-data.ts (unused)
  db/migrations/       ← 001 schema, 002 RLS, 003 triggers, ALL_MIGRATIONS_CONSOLIDATED.sql (= 001+002+003)
  types/database.ts    ← TS types for all tables
  shells/DatabaseSchemaViewer.tsx ← /dev/diagnostics page
  App.tsx, main.tsx    ← Vite entry (legacy)
  middleware.ts        ← Supabase session check for protected routes
```

---

## 4. Kya ban chuka hai (DONE)

### 4.1 Database schema — `src/db/migrations/001_initial_schema.sql`
40 tables, well-designed, har tenant table pe `society_id`:
- **Platform:** platform_admins, platform_settings, platform_features, support_access_sessions, subscription_plans, subscriptions, usage_metrics
- **Society structure:** societies, society_settings (due day, late fee, UPI ID, fiscal year), buildings, wings, floors, units, parking_slots
- **People:** profiles, society_memberships (7 roles), family_members, vehicles
- **Professionals:** professional_profiles, society_professional_access (JSONB permissions, expiry), professional_invites, access_logs
- **Billing:** billing_rules (flat/per_sqft/metered, GST, HSN/SAC), billing_cycles, bills, bill_items
- **Money:** bank_accounts, payments (UTR, verification), bank_transactions (reconciliation)
- **Expenses:** vendors (GSTIN/PAN/bank), expenses (GST, TDS, approval status)
- **Accounting:** accounts (chart of accounts), journal_entries, ledger_entries, funds
- **GST:** gst_profiles, gst_2b_uploads, gst_2b_invoices, gst_reconciliations
- **Ops:** notices, complaints, documents, audit_logs
- Indexes on main multi-tenant lookups.

### 4.2 RLS & helpers — `002_rls_policies.sql`, `003_auth_security_and_triggers.sql`
- RLS **enabled** on all 40 tables.
- Helper functions: `is_platform_admin()`, `is_society_admin(id)`, `has_society_membership(id)`, `has_professional_permission(id, perm)`.
- Policies for: societies, units, profiles, memberships, professional access, bills, payments, bank_accounts, expenses, ledger, accounts, GST, notices, complaints, documents, audit_logs.
- `handle_new_user()` trigger: signup pe profile auto-create, `is_platform_admin=false` forced.
- Profile self-update policy jo `is_platform_admin` change block karti hai.
- RPCs: `get_user_authorized_societies()`, `get_professional_authorized_societies()` (abhi frontend use nahi karta).

### 4.3 Auth — `src/context/AuthContext.tsx`
- Supabase email/password login, logout, forgot password, reset password.
- Login ke baad: profile, platform-admin status, memberships (+society join), professional grants load hote hain.
- Active society switcher (`WorkspaceSelector`) — sirf authorized societies me switch.
- `effectiveRole` derive hota hai.
- `middleware.ts` — protected prefixes pe server-side session check, `/login?returnUrl=` redirect.
- `ProtectedRoute` — client-side portal-level guard.

### 4.4 UI
- 7 public marketing pages + 3 auth pages — dark theme, responsive, polished.
- 4 dashboards with sidebar + mobile bottom nav + empty states.
- Resident: outstanding due banner, bills, payments history, notices, complaints list, **UTR submit modal (insert into payments)** — yeh hi ek "write" feature hai poore app me.
- `/dev/diagnostics` — schema viewer page.
- PWA install button (Android + iOS guide), offline indicator.

### 4.5 Build status (13 Oct 2026, verified)
- `tsc --noEmit` ✅ pass (0 errors)
- `vite build` ✅ compiles (670 KB single JS chunk) — lekin runtime crash (§5.1)
- `next build` ⚠️ "Compiled successfully", phir **atak jaata hai**: Next 15.2 `typescript@^7` ko pehchanta nahi, "TypeScript not installed" bolke yarn se install karne lagta hai (§5.0)

---

## 5. Kya toota hua hai (BUGS — fix first)

Priority: 🔴 critical / 🟠 high / 🟡 medium

### 5.0 🔴 Next.js 15.2.0 me known critical CVEs + build blocker
- **CVE-2025-29927** (middleware auth bypass — `x-middleware-subrequest` header se `middleware.ts` ka login check skip ho jaata hai). Fixed in 15.2.3.
- **CVE-2025-66478** (React Server Components RCE). Install ke time npm/yarn khud warning deta hai. Fixed in 15.2.6+.
- **Fix:** `next` ko latest patched 15.x (ya 16.x) pe upgrade karo — deploy se pehle mandatory.
- `typescript: ^7.0.2` (native Go compiler) Next 15.2 ke saath kaam nahi karta → `next build` hang. **Fix:** `typescript@^5.8` pin karo jab tak Next TS 7 support na kare.
- Project **git repo nahi hai** (`.git` nahi). `git init` + first commit karo. `.gitignore` me `.next/` aur `next-env.d.ts` add karo (abhi sirf `dist/` hai).

### 5.1 🔴 Do frameworks ek saath (Vite + Next.js)
- `package.json` scripts **Vite** chalate hain (`npm run dev` = `vite`), lekin code **Next.js** ke `next/navigation` pe depend karta hai (`src/router/RouterContext.tsx`).
- Vite mode me `useRouter()` from `next/navigation` throw karta hai: **"invariant expected app router to be mounted"** → har page blank / crash. (Verified in `node_modules/next/dist/client/components/navigation.js:119`.)
- `src/pages/` folder ka naam Next.js ke reserved **Pages Router** directory se match karta hai — Next isme ki files ko routes (jaise `/public/HomePage`) treat karega; files named exports use karti hain, default export nahi. Build ke "collect page data" step pe error/junk routes ka risk (build hang ki wajah se yeh step verify nahi ho paaya).
- `next.config.mjs` me `typescript.ignoreBuildErrors: true` aur `eslint.ignoreDuringBuilds: true` — errors chhup jaate hain.
- **Fix:** Next.js choose karo (code already Next-first hai).
  1. `src/pages/` → `src/views/` (ya `src/features/`) rename, imports update.
  2. `package.json` scripts: `"dev": "next dev"`, `"build": "next build"`, `"start": "next start"`.
  3. Delete: `index.html`, `src/main.tsx`, `src/App.tsx`, `src/index.css`, `vite.config.ts`, Vite/PWA-plugin deps. PWA ke liye `@serwist/next` ya `next-pwa`.
  4. `ignoreBuildErrors` hatao.
  5. `package.json` name `react-example` → `sahaniwas`.

### 5.2 🔴 Login ke baad 404
- `computeRedirectPath()` (`AuthContext.tsx:76`) `/platform/dashboard`, `/society/dashboard`, `/resident/dashboard`, `/professional/dashboard` return karta hai — lekin Next routes sirf `/platform`, `/society`, … hain (`src/app/*/page.tsx`). Result: login → **Page Not Found**.
- **Fix:** paths `/platform`, `/society`, … karo (ya `app/*/dashboard/page.tsx` banao).

### 5.3 🔴 Login redirect stale state use karta hai
- `login()` (`AuthContext.tsx:312`) `computeRedirectPath(isPlatformOwner, societyMemberships, professionalGrants)` ko purani state values ke saath call karta hai (React setState async hai). Pehli login pe hamesha fallback `/society/dashboard` milega — platform owner / CA / resident galat portal me jaayenge.
- **Fix:** `loadUserAuthorizations` se computed values return karo aur unhi se path nikaalo.

### 5.4 🔴 Open redirect
- `LoginPage.tsx` `returnUrl` query param ko bina validate kiye `navigate()` karta hai. `/login?returnUrl=https://evil.com` → phishing.
- **Fix:** sirf `/` se shuru hone wale aur `//` se nahi shuru hone wale relative paths allow karo.

### 5.5 🔴 RLS — privilege escalation holes
| Policy | Problem | Fix |
|---|---|---|
| `payments_resident_insert` | Resident `status='verified'`, koi bhi `amount`, kisi bhi `bill_id` ke saath insert kar sakta hai → khud ko "paid" mark. | WITH CHECK me `status = 'pending_verification' AND verified_by IS NULL AND verified_at IS NULL` add karo. |
| `complaints_update` | Resident apni complaint ka `status`, `assigned_to`, `resolution_notes` kuch bhi set kar sakta hai. | Resident ke liye sirf limited columns (column-level GRANT ya trigger) ya update policy sirf admin. |
| `audit_logs_insert` | Koi bhi user fake audit log likh sakta hai (any society_id). | Client insert band karo; sirf triggers / SECURITY DEFINER function se likho. |
| `access_logs_insert` | Professional kisi bhi society ke naam pe log daal sakta hai. | `has_professional_permission(...)` / active grant check add karo. |
| `bank_accounts_policy` (FOR ALL) | Professional with `view_bank_reconciliation` permission bank account **edit/delete** kar sakta hai (FOR ALL). | SELECT aur write policies alag karo. |
| `gst_2b_*_policy` (FOR ALL) | Same: view permission = full write. | Intentional ho to theek, warna split. |
| `memberships_admin_write` | Society admin kisi bhi user ko `society_admin` bana sakta hai, including khud ko doosri society me? (`society_id` check hai, ok) — lekin admin apna role chairman → society_admin badal sakta hai. | Role change rules decide karo. |

### 5.6 🔴 RLS enabled lekin **koi policy nahi** (= sab ke liye blocked)
In tables pe client se read/write **impossible** hai abhi:
`society_settings, buildings, wings, floors, parking_slots, family_members, vehicles, professional_invites, billing_rules, billing_cycles, bill_items, bank_transactions, vendors, journal_entries, funds, gst_reconciliations, subscription_plans, subscriptions, usage_metrics, platform_features (sirf select hai)`.
Aur **`societies` pe INSERT policy nahi** → society onboarding client se possible nahi; **`profiles`** pe society admin apne members ka naam/phone nahi dekh sakta (sirf self + platform admin).

### 5.7 🟠 Data bugs
- `ResidentDashboardPage.tsx:101` — `unit_id: activeMembership?.unit_id || null`, lekin `payments.unit_id` **NOT NULL** hai → bina unit wale resident ka insert fail. Aur error silently ignore hota hai (user ko kuch nahi dikhta).
- `ResidentDashboardPage.tsx:103` — amount `outstandingTotal || 4000` hardcoded fallback; payment kisi `bill_id` se link nahi hoti.
- `ResidentDashboardPage.tsx:389` — UPI QR fake hai: `{slug}@icici` dikhata hai. Real `society_settings.upi_id` / `qr_code_url` use hona chahiye. **Galat UPI ID pe paisa ja sakta hai — production se pehle zaroor fix.**
- `payment_number` = `PAY-` + last 6 digits of timestamp → collisions (unique constraint fail).
- Outstanding total sirf `issued`/`overdue` count karta hai, `partially_paid` miss.
- Society dashboard "Open Complaints" = saari complaints count (closed bhi).
- Professional permission names mismatch: UI `reconcile_bank` check karta hai, RLS `view_bank_reconciliation`.
- `ProtectedRoute`: `resident` portal ka koi check nahi; `society` portal me resident bhi ghus sakta hai (sirf "koi membership" check). RLS data protect karta hai, lekin UI admin screens dikhata hai.
- Bina membership wala user → `getRedirectPath()` fallback `/society/dashboard` → "No membership" screen → button wapas same path → **loop**.
- `useEffect` deps missing (`loadSocietyData`, `loadResidentData`) — lint warnings, stale closures.

### 5.8 🟡 Cleanup / consistency
- Brand naam inconsistent: **Sahaniwas** vs **Sahanivas** (manifest, layout, UI). Ek decide karo.
- Mojibake: `â€¢`, `â€”` (UTF-8 galat decode) — `PlatformDashboardPage.tsx`, `LoginPage.tsx`, `ContactPage.tsx`, `index.html`, `vite.config.ts`.
- Login page `VITE_SUPABASE_URL` bolta hai, `.env.example` `NEXT_PUBLIC_SUPABASE_URL` — message update karo.
- `ALL_MIGRATIONS_CONSOLIDATED.sql` idempotent nahi (`CREATE POLICY` bina `DROP IF EXISTS`) — dobara run karne pe fail. Supabase CLI migrations (`supabase/migrations/`) pe shift karo.
- SECURITY DEFINER functions me `SET search_path = public` missing (Supabase advisor warning, hijack risk).
- `profiles.email UNIQUE NOT NULL` — phone-only signup pe trigger fail hoga.
- `lib/supabase/mock-data.ts` unused — seed script me convert karo ya delete.
- Unused deps hatao (`@google/genai`, `express`, `dotenv`, `motion`, `tsx`).
- `viewport userScalable: false` — accessibility issue (zoom block).
- Marketing claims (auto-ledger, GST engine, "read receipts", "Cross-Society Data Contamination is Impossible", 30-day trial) abhi product me nahi hain — launch se pehle ya to feature banao ya copy soften karo.
- Contact page fake details (`+91 (022) 2780-9900`, Nerul address, `contact@sahanivas.in`) — real details daalo.
- README AI Studio template hai — real setup steps likho.
- Vite bundle 670 KB single chunk — route-level code split (Next migration ke baad automatic).

---

## 6. Kya baaki hai (TODO — feature-wise)

### 6.1 Society onboarding (BLOCKER — iske bina koi data hi nahi aayega)
- [ ] Signup page (AuthContext me `signUp` hai, UI nahi)
- [ ] "Create Society" flow: society + society_settings + creator ko `society_admin` membership (SECURITY DEFINER RPC best)
- [ ] Buildings / wings / floors / units bulk create + CSV import
- [ ] Member invite (email/phone) → membership + unit link
- [ ] Platform admin: society approve/suspend, subscription assign
- [ ] Seed script (mock-data.ts se) for dev/demo

### 6.2 Billing (core revenue feature)
- [ ] Billing rules CRUD (flat / per sqft / metered, GST %)
- [ ] Billing cycle create → bills + bill_items generate (Postgres function)
- [ ] Late fee / interest job (pg_cron or Edge Function)
- [ ] Bill PDF / share on WhatsApp
- [ ] Resident: pay against a specific bill

### 6.3 Payments & reconciliation
- [ ] Treasurer "Payment Verifications" tab: list pending UTRs → verify/reject → bill `amount_paid/balance_due/status` update (trigger)
- [ ] Receipt number + receipt PDF
- [ ] Real society UPI QR (`upi://pay?pa=...&am=...&tn=BillNo`) from settings
- [ ] Bank statement upload (CSV) → bank_transactions → auto-match UTR

### 6.4 Accounting engine (marketing ka main promise)
- [ ] Default chart of accounts on society create
- [ ] Triggers: bill issued → Dr Members Receivable / Cr Maintenance Income (+GST payable); payment verified → Dr Bank / Cr Receivable; expense paid → Dr Expense / Cr Bank (+TDS payable)
- [ ] Journal/ledger RLS write via triggers only
- [ ] Reports: Trial balance, Income & Expenditure, Balance sheet, member-wise outstanding, defaulters

### 6.5 Expenses & vendors
- [ ] Vendor CRUD
- [ ] Expense create with invoice upload (Supabase Storage)
- [ ] Two-step approval (`require_two_step_expense_approval`) — maker/checker
- [ ] Mark paid + TDS

### 6.6 Communication
- [ ] Notice create (admin), target audience, pin, attachment
- [ ] Complaint create (resident — "New Ticket" button dead hai), assign, status flow, comments
- [ ] Push notifications (Web Push) / WhatsApp / SMS
- [ ] Documents vault upload + committee-only flag (Storage + RLS on storage bucket)

### 6.7 Professional (CA) portal
- [ ] Society admin: invite professional (professional_invites + token email) → accept → grant with permissions
- [ ] Grant expiry/revoke UI
- [ ] Read-only financial views per permission
- [ ] GSTR-2B JSON/Excel parser → gst_2b_invoices → match with expenses (GSTIN + invoice no + taxable value)
- [ ] Review remarks
- [ ] access_logs har view pe

### 6.8 Platform owner
- [ ] Subscriptions/plans management, invoicing societies
- [ ] Usage metrics job
- [ ] Support access sessions (time-boxed impersonation with reason)
- [ ] Audit log viewer with filters

### 6.9 Engineering
- [ ] Next.js-only cleanup (§5.1)
- [ ] `supabase gen types typescript` se types generate (hand-written `types/database.ts` drift karega)
- [ ] Data fetching layer (React Query / server actions) instead of raw `useEffect`
- [ ] Error toasts (abhi errors `console.warn` me chhupe hain)
- [ ] Tests: RLS tests (pgTAP / supabase test), Vitest for utils, Playwright for login→dashboard
- [ ] CI (GitHub Actions: typecheck, lint, build)
- [ ] ESLint config
- [ ] Env validation (zod) at boot
- [ ] Deploy (Vercel + Supabase), custom domain, Sentry

---

## 7. Recommended roadmap

| Phase | Kaam | Est. |
|---|---|---|
| **P0 — Stabilize** | §5.0 Next upgrade + TS 5 pin, §5.1 framework cleanup, §5.2–5.4 auth bugs, §5.5–5.6 RLS fixes, brand/mojibake, git init + first commit, README | 2–3 din |
| **P1 — Onboarding** | Signup, create society, units import, member invite, seed data | 4–5 din |
| **P2 — Money loop** | Billing rules → cycle → bills; resident pay with real UPI QR; treasurer verify; receipts | 1–1.5 hafta |
| **P3 — Ledger** | Chart of accounts + posting triggers + 4 core reports | 1 hafta |
| **P4 — Ops** | Notices, complaints CRUD, documents upload, expenses + approval | 1 hafta |
| **P5 — CA portal** | Invite/grant flow, read-only reports, GSTR-2B matching | 1–1.5 hafta |
| **P6 — SaaS** | Subscriptions, platform admin tools, notifications, tests, CI, deploy | 1–2 hafta |

**MVP launch (1 pilot society)** = P0 + P1 + P2 + notices/complaints from P4 ≈ **3–4 hafte**.

---

## 8. Kya kar sakte hai (opportunities)

- **WhatsApp-first:** bill + payment link + receipt WhatsApp pe (Indian societies isi pe chalti hain). Biggest adoption lever.
- **UPI deep-link with amount + bill no.** in `tn` field → UTR matching almost automatic.
- **Bank statement auto-reconcile** (CSV/PDF parse) — treasurer ka sabse bada pain.
- **Gemini/LLM use (dependency already hai):** invoice OCR for expenses, notice drafting in Hindi/Marathi, complaint auto-categorize, AGM minutes summary.
- **Visitor / gate management** (guard app) — competitors (MyGate, NoBrokerHood) ka core feature; add-on tier ban sakta hai.
- **Facility booking** (clubhouse, hall) + amenity charges billing me.
- **Maharashtra Co-op Society Act compliance:** I-Register, J-Register, share certificates, nomination forms — CA portal ke saath strong differentiator.
- **Multi-language** (Hindi, Marathi, Gujarati).
- **CA marketplace:** professionals multiple societies handle karte hain — CA ko acquisition channel banao (referral).

---

## 9. Setup (current, for dev)

```bash
bun install            # ya npm install
cp .env.example .env.local   # NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY bharo
# Supabase SQL editor me run: src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql (sirf ek baar, fresh DB pe)
npx next dev           # ⚠ `npm run dev` (Vite) abhi crash karta hai — §5.1
                       # ⚠ `next build` ke liye pehle typescript@5 pin karo — §5.0
```
Platform owner banane ke liye manually: `insert into platform_admins(user_id) values ('<auth user id>');`

---

## 10. File reference (quick map)

| Kaam | File |
|---|---|
| Routes kahan define | `src/app/*/page.tsx` (+ legacy `src/App.tsx`) |
| Auth / roles / active society | `src/context/AuthContext.tsx` |
| Route guard | `src/components/ProtectedRoute.tsx`, `src/middleware.ts` |
| Supabase client | `src/lib/supabase/client.ts`, `server.ts` |
| Schema | `src/db/migrations/001_initial_schema.sql` |
| RLS | `src/db/migrations/002_rls_policies.sql`, `003_auth_security_and_triggers.sql` |
| Types | `src/types/database.ts` |
| Dashboards | `src/pages/{society,resident,professional,platform}/*DashboardPage.tsx` |
| Marketing pages | `src/pages/public/*` |
