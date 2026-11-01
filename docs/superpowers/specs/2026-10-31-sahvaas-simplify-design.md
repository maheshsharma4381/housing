# Sahvaas: simpler plans, CA-owned accounting, and a secretary app people can set up alone

Date: 2026-10-31
Status: design, awaiting approval
Owner: product owner (repo user); builder: whoever writes the implementation plans

## 1. Intent

Sahvaas works, but a secretary setting up a society meets an accountant's tool: a 10-field form, a CSV file for flats, a "billing rule" with an account code, opening balances in debit/credit terms, 16 menu items with accounting names, and email + password + email verification for every resident. The product owner tried the setup themselves and found it too complicated; their judgement is that a real secretary will not finish it.

The change has one idea underneath it: **split the work by who actually does it.**

- The **CA / accountant** owns the books: groups and ledgers, opening balances, bill-type-to-ledger mapping, fixed assets, bank reconciliation, year close.
- The **secretary** runs the society: flats, residents, maintenance amount, bills, payments, vendor bills, notices, complaints. They never see a ledger code.
- The **resident (owner)** sees their own flat's account and pays it, without asking the secretary.

The plan change (Free = Basic minus ads) is what makes the split possible for every society: the CA login is currently a paid feature, and after this change every society can invite a CA.

## 2. Goals, non-goals, anti-goals

**Goals**
1. Free and Basic differ only in ads.
2. A secretary can go from first login to "first maintenance bill sent" in about 5 minutes, on a phone, without a CSV file, email address or accounting term.
3. The CA can enter the society's last audited balance sheet exactly as it is, and maintain groups and ledgers Tally-style.
4. Every owner can see their flat's full ledger (running balance, bills, receipts) and download it.
5. Notifications cost nothing per message.

**Non-goals (this round)**
- Hindi or any language other than English. All UI text, buttons, bills and messages are English. Multi-language is planned for later; no translation framework now.
- Changing Pro features, GST, TDS rules themselves, or the Razorpay/SaaS billing flow beyond plan contents.
- Native mobile apps. The app stays a web app / installable PWA.
- Rewriting the society portal from scratch.

**Anti-goals (would make this a failure even if it "works")**
- The secretary has to pick a ledger or account code anywhere.
- Any money number differs between what the resident, the secretary and the CA see for the same flat.
- Opening balances get "balanced" by the app silently plugging a difference into a reserve.
- Breaking the existing tested accounting (billing, TDS, GST, ledger postings); the 161 existing tests keep passing.
- Per-message costs growing with every bill and reminder.

## 3. Constraints

- Stack stays: Next.js 15 (App Router), React 19, Tailwind v4, Supabase (Auth + Postgres + RLS). Business rules live in Postgres functions with RLS, as today.
- Schema changes are new numbered migrations (`src/db/migrations/018_*.sql` onward), applied with `bun run db:migrate --apply`; `ALL_MIGRATIONS_CONSOLIDATED.sql` is regenerated with `bun run db:bundle`. Never edit 001–017.
- DB tests use the PGlite harness in `tests/db/` (`tests/db/harness.mjs`); every phase adds tests there.
- The live Supabase project has all 17 migrations applied and no users or societies yet, so no data migration of real users is needed.
- Costs (Oct 2026, third-party figures, before 18% GST): WhatsApp authentication message ≈ ₹0.115; SMS OTP ≈ ₹0.15–0.25 plus one-time DLT registration (≈ ₹5,900); web push is free.
- iPhone: web push works only when the app is added to the Home Screen (iOS 16.4+); Safari may clear script-written login cookies after 7 days.

## 4. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **1 (chosen)** | Change the existing app in phases, **accounting first** (5 phases, later extended with a 6th for the platform owner dashboard, section 11) | Secretary sees the new look only in phase 4, but nothing is built twice: Home's "To receive / To pay", the setup's maintenance step and "My account" all sit on the new accounting structure |
| 2 | New secretary look first, accounting later | Earlier visible change, good for demos; setup and Home would be rebuilt after accounting changes |
| 3 | Rewrite the society portal | Puts the tested billing/TDS/GST/ledger logic at risk and roughly doubles the time |

The product owner chose **Approach 1** (no demo is due in the coming weeks).

## 5. Roles after this change

| Role | Logs in with | Sees |
|---|---|---|
| Secretary / chairman / treasurer / society admin | Mobile + WhatsApp OTP | Secretary menu (section 9.3), Approvals |
| Committee member | Mobile + WhatsApp OTP | Same, read-only (as today) |
| Resident owner | Mobile + WhatsApp OTP | Home, My account (flat ledger), bills, pay, notices, complaints |
| Resident tenant | Mobile + WhatsApp OTP | Notices and complaints only. **No dues, bills or ledger.** |
| CA / accountant / auditor | Mobile + WhatsApp OTP | Professional portal, now including the accounting screens (section 7) |
| Platform owner | Mobile + WhatsApp OTP | Platform portal (unchanged apart from plans) |

## 6. Phase 1: Plans (small)

**Decided:** Free and Basic have the same features; Basic only removes ads. Pro unchanged.

| Plan | Features | Ads |
|---|---|---|
| Free | Billing & UPI, receipts, notices & complaints, double-entry books, **CA & auditor portal, asset register** | Residents see local offers |
| Basic (₹10/flat/month) | Everything in Free | No ads |
| Pro (₹18/flat/month) | Everything in Basic + GSTR-2B, TDS register, bank statement match, Tally export | No ads |

Work:
- Migration `018`: update the `free` row of `subscription_plans` (`feature_keys = '{ca_portal,asset_register}'`, `features_included`, `description`) and the `basic` row's `features_included` / `description` (currently seeded in `015_saas_billing.sql` lines 29–39 with `ON CONFLICT DO NOTHING`, so the live rows must be updated, not re-seeded). Replace `require_feature()` so its message no longer says "Basic and Pro" for `ca_portal` / `asset_register` (`015_saas_billing.sql` ~line 677).
- Text that promises "upgrade to unlock the CA portal": `src/views/society/SocietyDashboardPage.tsx` lines 161–162, `src/components/PlanBilling.tsx` lines 65 and 118, `FeatureGate planName="Basic and Pro"` at `SocietyDashboardPage.tsx` lines 458 and 497, fallback plan list in `src/views/public/PricingPage.tsx` lines 12–17. New Free-plan wording: the only upgrade reason from Free to Basic is "remove ads".
- Tests: `tests/db/saas-billing.test.mjs` test at line 120 ("Free plan … CA portal and asset register locked") and line 135 (`features` of free = `[]`) must be updated to the new rule; add a test that Free can invite a professional and use the asset register.

## 7. Phase 2: Accounting foundation (large)

### 7.1 Groups and ledgers (CA only)

**Decided:**
- Works like Tally. Primary groups are fixed: **Capital & Funds, Current Liabilities, Fixed Assets, Investments, Current Assets, Income, Expenses** (each has a fixed nature: equity/liability/asset/income/expense).
- The CA / accountant creates sub-groups inside them (e.g. "Bank Accounts", "FDs") and ledgers inside any group (e.g. "SBI FD", "HDFC Savings", "Parking Charges", "Lift AMC"), renames them, moves them between groups of the same nature, and deactivates them.
- A ledger with entries cannot be deleted, only deactivated.
- Ledgers the app posts to automatically (Members Receivable/"Members' dues", Sundry Creditors, GST payable, TDS payable, Advance maintenance received, Accumulated depreciation, General Reserve, Bank, Cash) can be renamed but not deleted, deactivated or moved to another nature.
- Only the CA / accountant creates or edits groups and ledgers. The secretary never does.

Today: `accounts` (`001_initial_schema.sql` line 449) has `type`, `parent_id`, `is_system`; the default chart (33 accounts) comes from `ensure_default_accounts()` in `013_accounting.sql`. There is no group concept, no UI to add accounts, and several places hard-code codes:
- `billing_rules.account_code IN ('4000','4200','3000','3100','3200')` (`007_ledger.sql` line 19)
- fixed-asset codes `IN ('1500'…'1550')` (`013_accounting.sql` lines 139, 510)
- `AdjustmentsPanel` blocked codes (`src/components/AdjustmentsPanel.tsx` line 30)
- reports group only by `type` (`src/components/FinancialReports.tsx` ~lines 151–165)

These checks must become "any active ledger of the right nature/group" so new ledgers are usable in billing charges, vendor bills, bank, fixed assets, adjustments and opening balances. Reports (Balance Sheet, I&E, Trial Balance) are presented group-wise. Tally export (`src/lib/tally-xml.ts`) emits the groups and ledgers.

**Several bank accounts (my call):** today every receipt and vendor payment posts to the single code `1000` and bank match reconciles against it (`vendor_payments.bank_account_id` exists but posting ignores it). Once the CA creates one ledger per bank account, the CA sets a **default receiving bank** and a **default paying bank**. When a society has more than one bank account, the secretary may choose "Paid from / Received in" by bank name (e.g. "HDFC Savings"); that is choosing a bank, not a ledger. Anything else the CA moves by adjustment. Bank reconciliation works per bank ledger.

### 7.2 Party ledgers for vendors and flats

**Decided:**
- When a new vendor's first bill is saved, that vendor appears as its own ledger under **Sundry Creditors**, automatically. The secretary does nothing extra.
- When a flat is added, it appears as its own ledger under **Members' dues**, automatically.
- The CA sees vendor-wise and member-wise ledgers like Tally.

**Builder's call, with a constraint (my recommendation):** keep the existing control accounts (Sundry Creditors `2000`, Members Receivable `1200`) and present each vendor / flat as a ledger computed from the existing sub-ledger data (bills, payments, expenses, vendor payments), rather than creating one `accounts` row per party. This leaves the tested posting functions untouched. Whatever is chosen, the party ledger shown to the CA, the flat ledger shown to the resident (section 10.2) and the Members' dues total in the balance sheet must be the same numbers, and Tally export must emit separate party ledgers.

### 7.3 Bill types decide the ledger and the TDS

**Decided:**
- The secretary never picks a ledger. When uploading a vendor bill they pick a **bill type** (Security, Housekeeping, Lift AMC, Plumbing, Legal/audit fees, …); the invoice reader suggests it.
- **TDS is decided by the bill type, not the ledger**, so it is right from day one even if the CA has not created a specific ledger yet.
- The CA maps each bill type to a ledger. When the CA later creates e.g. a "Lift AMC" ledger, they re-point the Lift AMC type to it; future bills go there and the CA can move earlier bills.
- If no bill type fits, the secretary chooses **Other** and the app asks one plain question: "Is this for work or a service (contractor, AMC, repair), a professional (CA, lawyer, architect), or goods you bought?" The answer sets the TDS nature.
- TDS is calculated bill by bill, as today: per-bill limit, yearly per-vendor limit, catch-up of earlier bills' TDS when the yearly limit is crossed, rate from the PAN's entity type, on the amount excluding GST.

Today this already exists: `expense_categories` (`013_accounting.sql` lines 138–198, 23 defaults with `account_code`, `tds_nature`, asset suggestion; a society's own row overrides the default) and `suggest_tds()` (~line 385, with yearly catch-up ~line 448). New work: a CA screen to edit bill types and their ledger mapping, the "Other" question in `src/views/society/tabs/ExpenseBillForm.tsx`, and re-pointing / moving bills.

### 7.4 Opening balances move to the CA login

**Decided:**
- Removed from the secretary's "Society Rules" screen (`src/views/society/tabs/SettingsTab.tsx` renders `OpeningBalances` at line 177) and from setup.
- In the CA login, the CA enters the **last audited balance sheet exactly as it is**: same lines, same amounts. Lines are pre-filled from the standard Maharashtra co-operative housing society format; the CA can add lines (creating ledgers per 7.1). Starting lines:

  | Liabilities | Assets |
  |---|---|
  | Share Capital | Fixed assets (net of depreciation) |
  | Reserve Fund | FDs / Investments |
  | Sinking Fund, Repair Fund, Building Fund | Each bank account separately; Cash |
  | Other funds | Members' dues (flat-wise) |
  | Income & Expenditure surplus | MSEB / water deposits |
  | Sundry Creditors | Interest accrued on FDs; TDS receivable |
  | Advances received from members; deposits | Advances to vendors |
  | GST / TDS payable | |

- The two sides must total the same before it can be submitted. If they don't, the screen shows the difference. **No automatic plug to General Reserve.**
- Members' dues are entered flat-wise in a table that already lists every flat (dues or advance per flat); the flat-wise total must equal the Members' dues line.

**Decided (after review): two dates.** Audits finish months after year-end, so a society going live in, say, November has an audited balance sheet as of 31 March and seven unrecorded months in between. Entering the March flat-wise dues would bill residents for dues they have since paid. Therefore:
- The CA enters the **audited balance sheet as of the last 31 March**, exactly as it is.
- The CA enters **flat-wise dues (or advances) as of the go-live date**. These become the payable opening bills.
- The CA bridges the months between with a **catch-up summary entry** (income, expenses, collections for the gap). The check "flat-wise total = Members' dues" compares the go-live dues with the March Members' dues line plus the catch-up entry's effect.
- Bills issued at setup (before any opening balance exists) show no arrears; arrears appear once the opening balance is approved.

**My calls (not discussed explicitly; check):**
- Workflow: the CA saves a draft and can edit it freely, then submits; the secretary (any committee role that can approve today) approves with one tap in **Approvals**; only then is it posted. This mirrors the existing CA-adjustment flow (`propose_adjustment` / `decide_adjustment`, `014_ca_workspace.sql` lines 459–596).
- On approval, flat-wise dues become payable opening bills (as `post_opening_balances()` in `010_launch.sql` ~line 203 does today) and flat advances become credits.
- Sundry Creditors may optionally be broken down vendor-wise; if it is, each vendor's opening payable can be paid in-app.
- After approval, corrections go through the existing CA adjustment flow (audit trail), not by re-editing the opening balance.
- Who may do it: a new professional permission (e.g. `manage_accounts`) covering groups/ledgers, bill-type mapping and opening balance; on by default in the CA and accountant presets (`src/lib/professional-permissions.ts`), and must be added to `valid_professional_permissions()` (`009_professional.sql`). Today `post_opening_balances()` only allows committee/platform admin.

### 7.5 Other accounting screens move to the CA login

**Decided:** Fixed Assets, Bank Reconciliation, Audit & Year Close (adjustments, year lock, last year's figures) and Opening Balance leave the secretary's menu and live in the CA login. The secretary still sees their results in Reports; anything the CA wants changed comes to the secretary as an item in **Approvals**.

Today the professional portal (`src/views/professional/ProfessionalDashboardPage.tsx`) already has Financials, GST, Expenses, Assets, Adjustments & Last Year, Documents, Remarks. Add: Groups & ledgers, Bill types, Opening balance, Bank reconciliation, Year close.

**Decided (after review): where the CA's authority ends.**

| The CA / accountant does directly | Needs a committee approval (in Approvals) |
|---|---|
| Groups and ledgers; bill-type mapping; fixed assets and depreciation; bank statement match | Opening balance; anything that changes posted entries (adjustments, moving earlier bills to another ledger); locking a financial year |

Verifying residents' payments stays the secretary's job; the CA's bank match can point to a payment but does not verify it.

**Decided (after review): societies without a CA on Sahvaas.** The committee can give one of its own members (e.g. the treasurer) an **Accountant** role in the same society, which opens the CA screens. Anything that person submits (e.g. the opening balance) must be approved by a *different* committee member, as `decide_adjustment` already enforces for adjustments today.

### 7.6 Owner change (secretary)

**Decided:**
- Each flat has an **Owner change** action for the secretary: new owner's name, mobile, transfer date.
- The flat keeps its ledger; only the name shown changes (e.g. "A-101 – New Owner"). No new ledger.
- If dues are pending, the app warns ("A-101 has ₹4,500 due"). Usually the old owner clears dues before selling; if not, the dues stay with the flat and the new owner pays them.
- The old owner's access to that flat ends; the new owner gets an invite.
- History is kept: who owned the flat from when to when, with their bills and receipts.

Today there is no transfer feature: `units.current_owner_id` (`001_initial_schema.sql` line 131) and memberships can only be deactivated (`MembersTab.tsx` line 131). An ownership history (owner, from, to) is needed so the new owner's statement starts at the transfer date with a "Brought forward from previous owner" line.

## 8. Phase 3: Login, invites, notifications (medium)

### 8.1 Login: mobile number + WhatsApp OTP

**Decided:**
- Everyone logs in with a mobile number and a one-time code sent on **WhatsApp**; **SMS** is the backup for people without WhatsApp. No email, password or email verification.
- Once logged in, the user stays logged in until they log out.

**Decided cost controls:**
- OTP is sent to mobile numbers already registered against a flat or invited, and (after review) also to: anyone using **"Register your society"** on the website (self-serve signup stays open) under tighter limits (3 OTPs per number per day plus a platform-wide daily cap), and anyone opening a valid **society joining link** (rate-limited per link). Joining-link users whose number matches no flat land in the secretary's Approvals.
- At most 5 OTPs per number per day; resend after 60 seconds.
- The platform dashboard shows OTP counts per society and alerts when a society exceeds 5 OTPs per flat per year. No per-plan cap.

**Required fixes:**
- iPhone/Safari: refresh the session server-side (middleware) so cookies are set by the server, and prompt iPhone users to "Add to Home Screen" (`src/components/PWAInstallButton.tsx` exists).
- Lost phone: a user can "log out of all devices" from another phone; the secretary can remove a member (removal must end their access even with a live session).

**Non-Indian numbers (my call):** owners living abroad (common for let-out flats, since tenants cannot pay) may log in with a foreign mobile number. Foreign numbers get the OTP on WhatsApp only (no SMS fallback); their higher per-message cost is counted in the OTP dashboard.

Today: email + password signup (`src/views/public/SignupPage.tsx`), `emailRedirectTo` in `src/context/AuthContext.tsx` line 429, invites keyed by email (`member_invites`, professional invites), no session timeout anywhere. Supabase phone auth with a custom sender (Supabase "Send SMS" auth hook pointed at the WhatsApp Cloud API, with SMS via an Indian provider such as MSG91 as fallback) is the expected route; the builder confirms the exact mechanism.

### 8.2 Invites: one society joining link

**Decided:**
- The secretary records each owner's name and mobile number against the flat (setup step 6, or later in Flats & residents).
- The society has one joining link the secretary posts in the society's WhatsApp group. A member opens it, logs in with mobile + OTP, and is attached to their flat automatically when the mobile matches what the secretary entered.
- An unknown number goes to the secretary's **Approvals** instead of joining.
- No per-invite messages, so inviting costs nothing.

### 8.3 Notifications instead of paid messages

**Decided:**
- An in-app **notification inbox** (bell icon with unread badge) for every user: new bill, dues reminder, notice, complaint update, payment verified/rejected; for committee: payments to verify, bills to approve, CA requests, join requests.
- **Web push** to the phone (free). Lock-screen text is generic ("Palm Heights CHS: You have a new message"); no amounts. Tapping opens the app at that item.
- Automatic dues reminders run nightly (alongside the existing nightly late-fee job, `010_launch.sql` ~line 409, pg_cron) on the schedule the secretary set in setup (section 9.1 step 4).
- If push is not allowed or not supported, everything is still in the inbox and on Home.

Today: the PWA manifest exists (`src/app/manifest.ts`) but there is **no service worker** and only an SVG icon (`public/icon.svg`); iPhone Home Screen needs PNG icons. Email sending exists (`src/app/api/notify/route.ts`, Resend) and becomes optional.

## 9. Phase 4: Secretary setup, menu, Home (medium)

Mockups (local, git-ignored): `.superpowers/brainstorm/22211-1793445453/content/setup-flow-v2.html`, `menu.html`, `home.html`.

### 9.1 Setup: 6 short steps, then the first bill

**Decided:**
1. **Login** — mobile + WhatsApp OTP.
2. **Society** — name, pincode (city and state filled automatically), "Your role" chips (Secretary / Chairman / Treasurer / Manager). Address, registration number and contact details move to a Society profile screen for later.
3. **Flats** — wings (chips + "Add wing"), number of floors, flats per floor → preview ("56 flats will be created: A-101 … A-704, B-101 … B-704") → create. "Or upload from Excel" stays as an alternative. Individual flats can be edited later.
4. **Maintenance** — "Same for all" (₹ per flat per month) or "Per sq.ft"; extra charges as toggles with amounts (Sinking fund, Repair fund, Parking); due day of month; **reminder schedule set here by the secretary**: "Remind ___ days after the due date, then every ___ days" (defaults 3 and 7). No ledgers or account codes on this screen.
5. **UPI** — society UPI ID and payee name, with a preview of the QR residents will see.
6. **Owners** — table of flats with owner name and mobile; "Paste from Excel"; **Skip** allowed (fill later in Flats & residents).
7. **Done** — "Your society is ready": first month's bill preview (count and total) and **Send bills**; optional "Invite your CA" (opening balances and ledgers are the CA's job); "Not now, go to dashboard".

Today: `src/views/onboarding/OnboardingPage.tsx` (10 fields, `create_society` RPC), CSV-only flat import (`UnitsTab.tsx`, `bulk_upsert_units`), UPI and due day in `SettingsTab.tsx`, billing rules with account code in `BillingTab.tsx`, and a 4-item checklist in `SocietyDashboardPage.tsx` lines 171–177. `create_society` currently requires address fields and must accept the shorter form.

**My calls:**
- Pincode lookup uses a free public pincode service with manual fallback.
- "Per sq.ft" needs each flat's area, which the flat generator does not collect: when chosen, ask area per flat position (all "…01" flats = X sq.ft, etc.), editable per flat later.
- Charges created in step 4 post to the default ledgers (Maintenance Charges, Sinking Fund, Repair Fund, Other Income) until the CA re-maps them.
- Late fee rules stay in Society settings, not in setup.
- **Parking** (and any charge that applies only to some flats): the setup toggle creates the charge, but no flat is charged until the secretary assigns it to flats in Maintenance bills. Today billing rules apply to all flats or by unit type only, so per-flat charge assignment is new phase-4 work.
- **Step 7 "Send bills" before anyone has joined:** bills belong to the **flat**, not to a user (today `bills.user_id` is NOT NULL and `generate_bills` skips flats with no linked owner, so step 7 would fail; changing that is the builder's job). The button issues the bills; each owner sees all their bills and dues as soon as they join through the joining link. Step 7 therefore also shows **"Share joining link in your society WhatsApp group"**. Bills are not sent as public links without login.

### 9.2 Bills

**Decided:** a proper maintenance bill in the standard society format, viewable and downloadable as PDF, reachable from the notification and from My account:
- Header: society name, registration number, address.
- Member: name, flat number, area, bill number, bill date, period.
- Charges breakup: service charges, sinking fund, repair fund, parking, water, non-occupancy charges, etc. (from `bill_items`, `001_initial_schema.sql` line 329).
- Previous dues (arrears), interest on them, less advance → total payable and due date. **My call:** "interest" here is the existing late fee (charged once per overdue bill, fixed or %), shown as a line on the bill. A by-law style monthly interest on all arrears is not part of this round.
- Footer: UPI QR for the exact amount, bank details, late-fee rule.

Today residents see only a one-line bill (number, amount, due date) and a UPI QR (`src/views/resident/ResidentDashboardPage.tsx`); the breakup is stored but not shown. **My call:** follow the existing printable receipt page pattern (`src/app/receipt/[id]/page.tsx`, `src/views/receipt/ReceiptPage.tsx`) for a `/bill/[id]` page with print-to-PDF.

### 9.3 Secretary menu

**Decided:** 12 items in 4 groups (from 16 in one list):

| Group | Items |
|---|---|
| (top) | **Home**, **Approvals** (new) |
| Money | Maintenance bills, Payments received, Vendor bills, Reports |
| Society | Flats & residents (flats + members + owner change on one screen), Notices, Complaints, Documents |
| Settings | Society settings (profile, UPI, due date, late fee, reminder schedule), CA & auditor, Plan & billing |

- **Approvals** collects everything the committee must approve: vendor bills, CA adjustments, the opening balance, unknown join requests.
- **Decided (after review): a society with only one committee member.** Today `approve_expense` refuses to let the person who entered a vendor bill approve it. While a society has only **one** active committee member, that person may approve their own vendor bills; such bills are marked **"self-approved"** in the audit trail. As soon as a second committee member joins, the normal rule applies again. Setup step 7 also suggests "Add your treasurer or chairman".
- Phone: bottom bar Home · Bills · Payments · Complaints · More; "More" opens the remaining items.
- Removed from the secretary menu (moved to CA login, section 7.5): Fixed Assets, Bank Reconciliation, Audit & Year Close, Opening balance.

Today: `NAV_ITEMS` in `src/views/society/SocietyDashboardPage.tsx` lines 60–77 and the mobile bar at lines 510–540.

### 9.4 Home

**Decided:** top cards **To receive** (amount, number of flats, how many overdue), **To pay** (amount, number of vendors, due this week), **Approvals** (count with breakdown), **Payments to verify**. Tapping "To receive" opens the flat-wise list sorted by oldest due with a "Send reminder to N overdue flats" button (in-app + push, section 8.3); tapping "To pay" opens the vendor-wise list with due dates and TDS already worked out, and "Record a payment".

Today the data exists as the Member Dues and Payables reports (`member_dues`, `payables_ageing` RPCs used in `FinancialReports.tsx` lines 121–122); Home currently shows Outstanding / Pending approvals / Open complaints / Registered units.

## 10. Phase 5: Resident side (medium)

### 10.1 Resident Home
Balance due, Pay by UPI, latest bill, notices, complaints. Ads remain on the Free plan (`src/components/SponsoredCard.tsx`).

### 10.2 My account (flat ledger)

**Decided:**
- Each **owner** sees their flat's full ledger: date, details, debit, credit, running balance; opening balance / brought forward; bills (link to bill PDF), payments (link to receipt), late fees, adjustments.
- Period: this financial year (Apr–Mar), last year, or custom.
- Download PDF and share on WhatsApp (for NOC, bank loan, records).
- The secretary can open and send any flat's statement from Flats & residents.
- **Tenants do not see it** (or any dues).
- Same numbers as the CA's party ledger for that flat (section 7.2).
- After an owner change, the new owner's statement starts at the transfer date with "Brought forward from previous owner".

Today: residents see a bill list and "Account Payment History"; there is no running-balance statement and no statement RPC. Mockup: `.superpowers/brainstorm/22211-1793445453/content/member-ledger.html`.

## 11. Phase 6: Platform owner dashboard (medium)

The platform owner's dashboard already exists inside this web app at `/platform` (`src/views/platform/PlatformDashboardPage.tsx`): Overview, Societies, Billing & Plans, Sponsors, Demo Requests, Tax Rules, Users, Audit Logs. **Decided:** keep it in the same app (no separate admin app) and add the five areas below. Item 1 ships with phase 3 because the OTP cost controls must exist at launch; items 2–5 form phase 6. Phase 4 must record the setup events item 2 needs.

**1. OTP and WhatsApp cost** (with phase 3)
- OTPs sent and estimated cost per society and platform-wide, split WhatsApp / SMS / foreign numbers.
- Alert when a society passes 5 OTPs per flat per year.
- Edit the platform-wide daily OTP cap and the per-number limits (section 8.1).
- Block / unblock a mobile number.

**2. Setup funnel**
- How many societies started setup and where they stopped, by step (section 9.1 steps 1–7), e.g. "40 started, 12 stopped at Flats".
- How many issued their first bill, and the time from first login to first bill (the "5 minutes" goal).

**3. Society health** (one row per society)
- Flats; owners joined (% of flats with a joined owner); this month's collection %.
- CA invited (yes/no); opening balance approved (yes/no).
- Last active date; flag societies that are stuck or going quiet so the owner can call them.

**4. Revenue**
- Societies on Free / Basic / Pro (and in trial); monthly recurring revenue; trials ending this week; unpaid Sahvaas invoices.
- Free-plan economics: ad revenue against OTP cost. Part of this already exists in Billing & Plans (`platform_billing_overview`) and Sponsors (`platform_ad_report`); reuse it.

**5. Support tools**
- **View a society read-only** to help a secretary. **My call (privacy):** read-only; every view is written to the audit log; the society's committee sees "Sahvaas support viewed your society on <date>" in their notifications; access lasts one session (e.g. 1 hour) and must be started again.
- **Announcements** to all secretaries (optionally filtered by plan or state), delivered as in-app notifications and push (section 8.3).

## 12. Calls I made that the product owner has not explicitly confirmed

1. Opening balance: CA drafts → secretary approves in Approvals; corrections after approval only via CA adjustments (7.4).
2. New professional permission for accounting work, on by default for CA and accountant (7.4).
3. Vendor-wise breakdown of opening Sundry Creditors is optional (7.4).
4. Party ledgers computed from existing sub-ledgers rather than one account per vendor/flat (7.2), as long as all views agree.
5. Everyone, including CA and platform owner, logs in by mobile + WhatsApp OTP; no email login kept (8.1).
6. Tenants see no bills or dues at all, so tenants cannot pay through the app; owners pay (10.2, section 5).
7. The old owner loses access at transfer; the secretary can still download their period's statement (7.6).
8. Pincode auto-fill, per-sq.ft area by flat position, default ledgers for setup charges, late fee kept out of setup (9.1).
9. Bill page follows the receipt page pattern (9.2).
10. Default receiving and paying bank set by the CA; the secretary may choose a bank by name when there are several (7.1).
11. Foreign mobile numbers allowed, WhatsApp OTP only (8.1).
12. Parking and similar charges are assigned to specific flats after setup (9.1).
13. Bills belong to flats; setup step 7 issues them and asks the secretary to share the joining link; no public bill links (9.1).
14. "Interest" on the bill is the existing late fee; no new interest rule (9.2).
15. Support "view a society" is read-only, audit-logged, announced to the committee, and time-limited (11).

## 13. Left to the builder

- Exact table and function design for groups, party ledgers, ownership history, notifications, push subscriptions, joining links and reminder settings, within the constraints above.
- How push is sent from the server (e.g. a notifications table drained by a scheduled sender, or an Edge Function), provided nightly reminders and event notifications both work.
- Flat numbering edge cases in the generator (ground floor, shops, skipped numbers), as long as the preview shows the result and flats can be edited after.
- The order of work inside each phase and how each phase is split into implementation plans.

## 14. External dependencies (product owner)

- **WhatsApp Business API** (Meta Business verification, an authentication message template) before phase 3. Can take several days; start early.
- **SMS fallback**: an Indian SMS provider account and DLT registration (≈ ₹5,900 one-time) if SMS backup is wanted at launch; otherwise it can follow later.
- **Web push keys** (VAPID) generated at build time; no account needed.
- **Supabase** project settings: phone auth enabled, no session time-box or inactivity timeout, pg_cron enabled (already used for late fees).

## 15. Done means

Per phase: migrations apply cleanly on a fresh database and on the live one; `bun run typecheck`, `bun run lint` and `bun run test` pass (existing 161 tests plus new ones covering the phase's rules); the flows above work end to end in the running app on a phone-sized screen.
