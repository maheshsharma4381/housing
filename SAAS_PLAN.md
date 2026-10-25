# Sahvaas — SaaS + Accounting Plan (P7–P13)

**Date:** 20 Oct 2026
**Status:** P7 ✅ (prototype v2, 50 screens) · P8 ✅ (accounting core, 013) · P9 ✅ (CA workspace, 014) · P11 ✅ (SaaS billing, 015) · P12 ✅ (Free-plan sponsor cards, 016) · P10 ✅ (bank statement match, 017) — see §8 progress · P13 pending. Har phase user ke "ok" ke baad shuru hoga.
**Inputs:** user ke 4 sawaal (CA ko financials, asset vs expense, society ka payment flow, SaaS per-flat pricing + free plan with ads), current code (migrations 001–012), prototype canvas (26 screens).

---

## 0. Ek nazar mein

| Sawaal | Short answer | Phase |
|---|---|---|
| CA ko financials + I&E dikhna chahiye | Code mein **already hai** (CA portal → Financial reports: I&E, Balance Sheet, Trial Balance, Dues, Journal — `view_reports` permission se). Prototype mein desktop screen nahi bani thi. Kami: schedules, previous-year comparison, asset schedule, payables, TDS register, CA ke adjustment proposals. | P7 (screens), P9 (build) |
| Asset kharida ya expense hai — kaise samjhe? | Har vendor bill pe **"Revenue expense" ya "Capital (asset)"** choose hoga. Asset → Balance Sheet mein Fixed Assets + Asset Register + saal ke end mein depreciation. Expense → I&E. System suggest karega, CA review karega. | P8 |
| Society ka payment flow? | 3 flows: (1) resident → society (bana hua hai), (2) society → vendor (approval → creditor → payment record → bank), (3) society → Sahvaas (SaaS fee, Razorpay). **Society ka paisa kabhi Sahvaas ke account se nahi guzrega.** | P8, P10, P11 |
| Admin per-flat price decide kare | Admin console mein plans + per-flat rate + discount + per-society override. Har mahine/saal real flat count se GST invoice banega, Razorpay se pay. | P11 |
| Free dena hai toh ads | "Free" plan = core features + residents ko ads; paid = no ads + pro features. Ads kabhi payment/receipt/reports/CA screens pe nahi. Pehle local sponsor ads, Google AdSense baad mein. | P12 |

---

## 1. Abhi code mein kya hai (base jis pe banega)

| Area | Hai | Kami |
|---|---|---|
| Chart of accounts | 19 accounts (`ensure_default_accounts`, [007_ledger.sql](src/db/migrations/007_ledger.sql)) — Bank, Cash, Members Receivable, Creditors, GST/TDS Payable, Advance, 3 funds, 3 income, 6 expense | **Koi Fixed Asset / Depreciation / GST Input account nahi** |
| Expense posting | `ledger_post_expense`: sirf **paid** hone pe Dr Expense / Cr Bank / Cr TDS. Account category ke regex se (`expense_account_code`) | Cash-basis only; approve hone pe creditor nahi banta; asset ka option nahi; GST input alag nahi |
| Expenses table | subtotal, gst, tds, net_payable, maker-checker, void | `expense_type` (revenue/capital), TDS section, partial payment, payment mode/proof |
| Bank | `bank_accounts`, `bank_transactions` tables hain (001) | Statement import + matching UI/RPC nahi |
| CA portal | `FinancialReports` component CA ko bhi dikhta hai ([ProfessionalDashboardPage.tsx:125](src/views/professional/ProfessionalDashboardPage.tsx#L125)); GSTR-2B; audit remarks | Schedules, comparison, asset/payables/TDS reports, adjustment proposals, FY lock |
| SaaS | `subscription_plans` (₹12/18/25 per flat, [010_launch.sql:423](src/db/migrations/010_launch.sql#L423)), `subscriptions`, `platform_assign_plan`, suspend/activate, `platform_settings`, `platform_features.min_plan_tier`, `usage_metrics` | Invoice, payment gateway, dunning, overrides, **feature gating enforce nahi hota** (`features_included` sirf marketing text), free plan, ads |

---

## 2. Rules jo poore plan mein follow honge

1. **Society ka paisa society ke bank mein.** Resident ka UPI seedha society ke UPI/bank mein jaata hai; vendor ko society khud NEFT/UPI/cheque se pay karti hai. Sahvaas sirf record + verify karta hai. (Isliye humein payment-aggregator licence ki zaroorat nahi.) Sirf **SaaS fee** Sahvaas ke account mein aati hai.
2. **CA read-only rahega.** CA books mein seedha change nahi karega — "adjustment propose" karega, committee approve karegi. Har entry ka audit trail.
3. **Plan gating DB mein enforce hoga**, sirf UI mein chhupana kaafi nahi (jaise abhi RLS se roles enforce hote hain).
4. **Ads kabhi paise wali screens pe nahi:** payment, receipt, bills, financial reports, CA/auditor portal, login/signup.
5. **Har number admin decide kare:** price, discount, free plan limits, grace days, ad slots — sab `platform_settings` / plan tables mein, code mein hardcode nahi.
6. Accounting rates (depreciation %, TDS %, GST ITC) **defaults** honge; CA confirm/change kar sake.

---

## 3. CA ko financials (Topic A)

**Already chal raha hai:** CA ko committee `view_reports` / `view_ledger` deti hai → CA portal mein Financial reports tab (I&E, Balance Sheet, Trial Balance, Member Dues, Journal) + CSV export.

**Jo add karna hai (P9):**

| Report | Kya dikhega |
|---|---|
| Income & Expenditure (with schedules) | Har income/expense head ke andar ka breakup (click → journal lines), **previous year column**, surplus/deficit |
| Balance Sheet (with schedules) | Funds (Sinking, Repair, Reserve), Fixed Assets schedule (cost, additions, depreciation, WDV), Members receivable, Creditors, Advances, Bank |
| Fixed Asset Register | Har asset: kab, kitne mein, kis vendor se, invoice, kis fund se, depreciation history |
| Payables ageing | Kaun sa vendor kitne din se unpaid |
| TDS register | Section-wise deducted / deposited / pending |
| GST summary | Output GST (agar society registered), input claimable vs blocked, 2B status |
| Receipts & Payments a/c | Cash-basis summary — co-op societies ke audit mein maanga jaata hai |
| Adjustment proposals | CA ek journal propose kare (e.g. "₹48,000 lift repair ko asset banao") → committee approve → post |
| FY lock | Audit ke baad saal lock; uske baad sirf reversal/next-year entry (audit backlog M9) |
| Export | Excel/PDF; optional **Tally XML** (Indian CAs ke liye bahut kaam ka) |

---

## 4. Asset vs Expense (Topic B)

### 4.1 Society kaise batayegi
Bill add karte waqt ek sawaal: **"Yeh kya hai?"**
- **Regular kharcha (Revenue)** — security, housekeeping, bijli, chhoti repair, AMC
- **Nayi cheez kharidi (Capital / Asset)** — CCTV, generator, pump, lift, furniture, solar, computer, building ka bada kaam

System suggest karega: category + amount (default > ₹25,000 aur category CCTV/generator/pump/furniture/solar/computer) → "Yeh asset lagta hai — confirm karein?" Final decision committee ka, CA baad mein review/reclassify propose kar sakta hai.

### 4.2 Naye accounts (CoA v2)
| Code | Account | Type |
|---|---|---|
| 1300 | GST Input Credit | asset |
| 1400 | Advances & Deposits to Vendors | asset |
| 1500–1560 | Fixed Assets: Plant & Machinery, Electrical Installations, Furniture & Fixtures, Computers, CCTV/Security Equipment, Building Improvements | asset |
| 1590 | Accumulated Depreciation | asset (contra) |
| 5800 | Depreciation | expense |
| 5850 | Software & Subscriptions (Sahvaas fee) | expense |

### 4.3 Entries (example: CCTV ₹1,00,000 + 18% GST, TDS 2% under 194C)
**Approve hone pe (accrual):**
```
Dr 1540 CCTV Equipment        1,18,000   (agar GST claim nahi — zyada tar societies)
   Cr 2000 Sundry Creditors          1,18,000
```
(Agar society GST-registered hai aur CA bole ITC milega: Dr Asset 1,00,000 + Dr 1300 GST Input 18,000.)

**Payment record hone pe:**
```
Dr 2000 Sundry Creditors      1,18,000
   Cr 1000 Bank                      1,16,000
   Cr 2200 TDS Payable                   2,000
```
**Saal ke end (depreciation run):**
```
Dr 5800 Depreciation             15,000    (15% WDV default — CA confirm)
   Cr 1590 Accumulated Depreciation     15,000
```
Revenue expense mein bas Dr 1540 ki jagah Dr 5xxx expense head.

### 4.4 Asset register (naya table `fixed_assets`)
name, category, purchase date, put-to-use date, cost, vendor + invoice (expense link), location (Wing A terrace), **funded from** (General / Sinking Fund / Repair Fund + GB resolution doc), depreciation method (WDV/SLM) + rate, warranty/AMC expiry, disposal (sale/scrap → gain/loss entry).

Depreciation: committee "Run depreciation for FY" → **preview** → CA review → post (generate_bills jaisa dry-run pattern).

### 4.5a Invoice upload → auto-fill (prototype H0, H1)
1. **Upload:** camera photo / PDF / WhatsApp share → `society-files` bucket.
2. **AI reading:** Supabase Edge Function → Claude API (vision) → JSON: vendor name, GSTIN, invoice no., date, line items, taxable value, GST, total. API key Supabase secrets mein (Vercel pe nahi). Low confidence wale fields amber dikhenge.
3. **Vendor match:** GSTIN/PAN se existing vendor mile → uska category, bank details, past TDS history. Naya ho → vendor master mein save.
4. **PAN from GSTIN:** GSTIN ke char 3–12 = PAN. PAN ka 4th letter: P/H → individual/HUF rate, C/F/others → company/firm rate.
5. **Rules:** category → ledger head + TDS nature (admin table); vendor ka FY total vs limit; asset threshold (₹25,000 + category).
6. **Duplicate block:** same vendor + same invoice no.
7. Har field pe tag: INVOICE / RULE / YOU. User koi bhi field badal sakta hai — original value + reason audit log mein.

### 4.5b TDS rules engine (prototype K6)
- `tds_rules` (platform-level, **FY-versioned**): nature, section label, rate_individual, rate_other, single-bill limit, yearly limit, no-PAN rate (206AA 20%).
- `expense_categories` (platform defaults + society ke apne): category → ledger head → TDS nature → asset threshold.
- `vendor_tds_overrides` (society/CA): lower-deduction certificate (rate, valid till, cert no.).
- Precedence: vendor override → admin rule → bill-level change (reason required).
- Har bill pe `tds_rule_version` save hoga, taaki purane bill rate change se na badlein.
- Defaults (admin edit kar sake): Contract 194C 1% / 2% (₹30,000 single / ₹1,00,000 year) · Professional 194J 10% (₹50,000 year) · Technical 194J 2% · Rent 194I 10% building / 2% machinery (₹50,000 a month) · goods only = no TDS.
- ⚠️ **Income-tax Act, 2025** 1 Apr 2026 se sections renumber karta hai — labels editable rakhe hain; go-live se pehle CA se rates + labels confirm.
- Naya account: **5600 Professional & Audit Fees**, **5700 Property Tax**.

### 4.5c Invoice nahi hai (prototype H6)
| Case | Kya hoga |
|---|---|
| Invoice baad mein aayega | Expense abhi record, status `invoice_pending`, 7 din baad reminder, CA report mein flag |
| Invoice milega hi nahi (local plumber, chhota cash kaam) | System **payment voucher `PV-YYYY-####`** banata hai: payee, phone, kaam, amount, mode, head; proof = kaam ki photo / haath ki parchi (kam se kam ek); payee **OTP se confirm** kare |
- Voucher pe GST credit nahi; TDS check phir bhi chalega.
- Cash limit per voucher = society setting (default ₹5,000); usse upar UPI/bank hi.
- Same maker-checker approvals; CA ke liye "No-invoice vouchers" report.

### 4.5 Purane expenses
Jo expenses pehle se cash-basis pe post ho chuke hain woh waise hi rahenge (books balance rahengi). Naya flow sirf naye bills pe. Backfill test likha jayega.

---

## 5. Payment flows (Topic C)

### C1 — Resident → Society (bana hua hai)
Bill → resident UPI se society ko pay → UTR submit → treasurer verify → receipt + ledger.
**Add (P10):** bank statement CSV upload → UTR/amount/date se auto-match → treasurer ko "✓ statement mein mila" badge → ek click verify. Unmatched credits ki list (kisne bina UTR bheje pay kiya).
**Baad mein (optional):** society apna Razorpay merchant account jode toh resident card/netbanking se pay kare aur auto-verify ho. Paisa tab bhi seedha society ke account mein jaata hai.

### C2 — Society → Vendor (P8)
```
Vendor bill aaya
  → Maker add kare (invoice PDF, Revenue/Capital, category, GST, TDS section)
  → Approvals (2 of N, khud ka bill khud approve nahi — already hai)
  → Final approve = accrual entry (Creditor banta hai)        ← naya
  → Society bahar se pay kare (NEFT/UPI/cheque)
  → "Record payment": date, mode, UTR/cheque no., bank account, proof; partial bhi chalega   ← naya
  → Entry: Dr Creditors / Cr Bank / Cr TDS
  → TDS jama kiya → "Record TDS challan" → Dr TDS Payable / Cr Bank   ← naya
  → Bank statement mein match (P10)
```
Void: approve ke baad/payment ke baad void → reversal journal (already `ledger_reverse` hai).

### C3 — Society → Sahvaas (SaaS fee, P11)
```
Admin plan + per-flat rate set kare
  → Trial (default 30 din, admin badal sake)
  → Billing date pe invoice: billable flats × rate (min flats, discount, GST 18%)
  → Committee ko email/WhatsApp + app mein "Subscription & billing" page
  → Pay via Razorpay (UPI/card/netbanking) ya NEFT (admin manually mark paid)
  → Razorpay webhook → Supabase Edge Function → invoice paid, period extend
  → Society ki books mein auto-expense draft: "Sahvaas subscription" (5850) — treasurer confirm kare
  → Unpaid: reminder (D0, D+7, due D+15) → grace (D+30) → downgrade to Free (ads on, pro features lock) ya read-only — admin setting
  → Data kabhi delete nahi
```
Society chahe toh yeh fee residents pe "Software charges" bill head se daal sakti hai (existing billing rules se).

---

## 6. SaaS model (Topic D)

### 6.1 Admin kya control karega
| Setting | Example (starting point — admin badal sakta hai) |
|---|---|
| Plans | Free · Basic · Pro (existing starter/growth/enterprise rename/reuse) |
| Per-flat monthly rate | Free ₹0 · Basic ₹10 · Pro ₹18 |
| Annual discount | 2 mahine free (annual = 10 × monthly) |
| Minimum billable flats | 20 |
| Trial days | 30 |
| Grace days + non-payment action | 15 din, phir "downgrade to Free" |
| Per-society override | custom rate, % discount, free months, coupon code, note ("pilot society") |
| Billable flat rule | invoice ke din `units` table ka count; admin kisi flat ko "not billable" mark kar sake (builder-held/unsold) |
| GST | platform GSTIN, SAC code, 18% — **CA se confirm** |

### 6.2 Feature gating (entitlements)
Naya `plan_features(plan_id, feature_key, limit)` + SQL helper `society_has_feature(society_id, key)`:
- RPCs (e.g. `create_professional_invite`, `import_gstr2b`, `run_depreciation`) check karenge — bypass nahi ho sakta.
- UI locked feature pe "🔒 Pro mein milega — Upgrade" dikhayegi.

| Feature | Free | Basic | Pro |
|---|---|---|---|
| Flats, members, bills, UPI collection, receipts, notices, tickets | ✅ | ✅ | ✅ |
| Double-entry ledger + basic reports | ✅ | ✅ | ✅ |
| Expense maker-checker | ✅ | ✅ | ✅ |
| Asset register + depreciation | — | ✅ | ✅ |
| CA / auditor portal | — | ✅ | ✅ |
| GSTR-2B reconciliation, TDS register | — | — | ✅ |
| Bank statement auto-match | — | — | ✅ |
| Tally export | — | — | ✅ |
| Documents storage | 500 MB | 5 GB | 25 GB |
| Ads to residents | **Haan** | Nahi | Nahi |
(Matrix admin console se editable.)

### 6.3 Naye tables
`platform_invoices` (number series, society, period, flats, rate, discount, GST, total, status, pdf), `platform_invoice_payments` (razorpay ids, mode, amount, raw webhook), `society_pricing_overrides`, `coupons`, `plan_features`, `subscription_events` (trial started, upgraded, downgraded, reminder sent — audit).

### 6.4 Security
- Razorpay webhook **Supabase Edge Function** mein (signature verify, idempotent on payment id). Service role key Vercel pe nahi jayegi (existing rule).
- Society committee subscription fields change nahi kar sakti (M1 guard already hai).
- Price/plan change → audit log.

### 6.5 Admin console (platform owner)
Plans & pricing · Feature matrix · Societies (plan, status, override, invoices, "act as support" read-only session — table already hai) · Invoices & payments · Revenue dashboard (MRR, ARR, billable flats, collection %, overdue, trial→paid conversion, churn) · Demo requests (already) · Ads (P12) · Settings.

---

## 7. Free plan with ads (Topic E)

### 7.1 Kahan dikhega (sirf Free plan, sirf residents ko)
- Resident home feed mein 1 card (notices ke beech), Notices list ke neeche, ticket submit hone ke baad wali screen.
- **Kabhi nahi:** pay/UPI, receipt, bills, reports, committee money screens, CA/auditor portal, login/signup, emails/receipts PDF.
- Frequency cap (e.g. ek session mein max 2), clearly "Ad / Sponsored" label.

### 7.2 Ads kahan se
| Source | Kab | Kyun |
|---|---|---|
| House ads | Day 1 | "Society ko upgrade karwao", Sahvaas features — free, koi approval nahi |
| **Local sponsors** (pest control, plumber, tiffin, coaching, real estate) | P12 | Admin campaign banaye: image/text, link/WhatsApp, city/pincode targeting, start–end, fixed monthly price. Hyperlocal = zyada value |
| Google AdSense | Baad mein (optional) | Live domain + Google approval chahiye; kam fill/price; fallback ke liye |

Tables: `ad_campaigns`, `ad_creatives`, `ad_daily_stats` (impressions/clicks aggregate — per-user tracking nahi).

### 7.3 Privacy (DPDP Act 2023)
Advertiser ko koi resident data nahi milega; targeting sirf society ki city/pincode se; personalised ads off; privacy policy + terms update; committee ko pata ho ki Free plan mein ads hain (signup pe consent).

### 7.4 Sach-sach paise ka hisaab (andaza)
30 flats wali society → shayad ~1,000 ad views/month → AdSense rates pe sirf **₹20–60/month** (bahut andaza), jabki Basic plan = 30 × ₹10 = ₹300/month. Matlab **Free + ads ka asli kaam society ko jodna (funnel) hai**, kamai nahi. Ads se asli revenue local sponsors se aayega (ek vendor ₹500–2,000/month de kar 10–20 societies tak pahunche). Isliye P12 mein sponsor system pehle, AdSense baad mein.

---

## 8. Phases

Har phase: migration + tests (PGlite) + UI + prototype match + docs update + hosted DB migrate (`db-migrate --apply`).

### P7 — Prototype v2 (design only, no code)
Canvas mein ~14 nayi screens, same style:
- CA desktop: Financials (I&E + previous year), Balance Sheet with schedules, Fixed Asset Register, Adjustment proposal
- Committee: Add bill with "Revenue / Asset?" choice, Asset detail, Record vendor payment (partial), Depreciation preview, Bank statement match
- Society: Subscription & billing page (plan, invoice, pay), Upgrade/locked feature sheet, Downgrade warning
- Admin: Plans & pricing + feature matrix, Society override, Invoices, Revenue dashboard, Sponsor campaign
- Resident (Free plan): home feed with sponsored card
**Done when:** user approve kare. **Gate:** design pe change pehle yahin.

### P8 — Accounting core
Invoice upload + AI auto-fill (Edge Function) · `tds_rules` / `expense_categories` / `vendor_tds_overrides` + admin Tax rules screen · payment vouchers (no-invoice) + invoice-pending · CoA v2 · `expense_type` + asset suggestion · accrual posting on approval · `vendor_payments` (partial, mode, proof) · TDS sections + challan · GST claimable flag · `fixed_assets` + depreciation preview/post · disposal · backfill-safe for old expenses.
**Tests:** asset vs expense entries, partial payments, void after partial, depreciation idempotent per FY, books balance.

**P8 progress ✅ (20 Oct 2026)**
| Item | Status |
|---|---|
| CoA v2 (33 accounts) | ✅ `013_accounting.sql`; new societies topped up by a deferred trigger, existing ones backfilled |
| Tax rules | ✅ `tds_rules` (dated versions, FY-wise), `expense_categories` (23 defaults + society own), no-PAN 20% in `platform_settings`; platform console → **Tax Rules** |
| TDS suggestion | ✅ `suggest_tds()`: category → nature → rule; PAN from GSTIN, 4th letter → individual/other rate; single-bill + yearly limits with catch-up on earlier untaxed bills; lower-deduction certificate on vendor |
| Changed TDS | ✅ needs a reason (DB-enforced); bill stores section, rate, rule id, suggested amount |
| Invoice upload + auto-fill | ✅ `POST /api/extract-invoice` (Next route, user's session, committee only) → **Groq** (`GROQ_API_KEY`, `qwen/qwen3.8-27b` vision, PDF ke pehle 2 pages browser mein `pdfjs-dist` se JPEG) ya **Anthropic** (`ANTHROPIC_API_KEY`) tool-use → `normaliseExtraction()`; tags INVOICE / RULE / YOU; key na ho to manual — **Edge Function nahi, Next route** (key server-side env, service role ki zaroorat nahi). Groq limits org-level hain, isliye multiple keys se capacity nahi badhti — ek key |
| Duplicate invoice | ✅ same vendor + invoice no. blocked |
| Asset vs expense | ✅ `expense_type`, asset type from category, ₹25,000 suggestion, GST claimable → 1300 |
| Accrual | ✅ approval posts Dr head/asset (+GST input) / Cr 2000; capital bill creates `fixed_assets` row; approved-unpaid backfilled; legacy cash-basis rows untouched |
| Vendor payments | ✅ `record_vendor_payment()` partial, TDS once, final payment must carry remaining TDS, no future dates, proof file; `mark_expense_paid` kept as wrapper |
| TDS challan | ✅ `record_tds_challan()` — cannot exceed TDS payable |
| No invoice | ✅ `invoice_status = pending` (attach later via `attach_expense_invoice`) / `none` = voucher `PV-####` (payee + proof photo, no GST, cash limit `society_settings.voucher_cash_limit` ₹5,000) |
| Void v2 | ✅ reverses every payment + accrual; blocked once depreciation is posted on the asset |
| Fixed assets | ✅ register, existing assets (`add_existing_asset`, WDV must be in opening balances), `preview_depreciation` (WDV/SLM, half rate < 180 days), `post_depreciation` once per FY (from 1 Mar), `dispose_asset` gain/loss → 4300, rate change with reason |
| UI | ✅ Expenses & Payables tab (upload-first form, payables/TDS/invoice-pending cards, part-payments, challan, attach invoice, filters), Fixed Assets tab (committee) + read-only for CA, CA expenses table shows TDS section / voucher / asset |
| Tests | ✅ `tests/db/accounting.test.mjs` (17) + `tests/unit/tds.test.ts` (5); 2 older tests updated for accrual (accounts 19→33, payment journal now separate) — **118/118 pass**, `tsc`, `eslint` (0 errors), `next build` ✅ |
| Hosted DB | ✅ 013 applied; RLS on 7 new tables, 9/9 functions, books balanced |

**Not done / later:** payee OTP confirmation for vouchers (needs an SMS provider), invoice-pending reminders by email/WhatsApp, Sahvaas-subscription auto-expense (P11), TDS register report + Form 26Q data (P9), invoice reading not tested against the live Claude API (no key configured yet).

### P9 — CA workspace (desktop)
Reports with schedules + previous year (pehle saal ke liye CA last year ke audited figures enter kare) · Asset/Payables/TDS/GST/Receipts & Payments reports · CA adjustment proposals → committee approve · FY lock (M9) · Excel/PDF export · Tally XML (optional).
**Tests:** CA cannot post directly; proposal approve posts once; locked FY rejects back-dated entries.

**P9 progress ✅ (20 Oct 2026)**
| Item | Status |
|---|---|
| Comparatives | ✅ `income_expenditure_compare` (period vs whole previous FY), `balance_sheet_compare` (vs previous 31 Mar); source = **audited** (`prior_year_balances`, entered by committee / CA with `view_reports`) else **books** |
| Reports | ✅ Receipts & Payments (cash basis, pro-rata by counter-account, ties to bank + cash), Account Ledger (running balance, click any head), Payables ageing (0-30 / 31-60 / 61-90 / 90+), TDS register (deducted vs challans), GST summary (output, input claimed, not claimed) |
| Adjustments | ✅ `propose_adjustment` (balanced, sub-ledger accounts blocked: 1200 / 2000 / 2300 / 15xx / 1590), `propose_capitalisation` (expense → asset, creates the register entry on approval), `decide_adjustment` (committee, not the proposer, reason to reject), `withdraw_adjustment`; posted as `adjustment.approved` with proposer's name |
| FY lock | ✅ `lock_financial_year` (committee, ended years only, no pending adjustments), unlock = platform admin only; adjustments / opening balances / depreciation into a locked year refused; late system entries moved to 1 April with the original date in the narration; ledger lines follow the journal date |
| Exports | ✅ Excel (CSV) for every report, Print / PDF (dashboard chrome hidden), **Tally XML** (ledger masters + journal vouchers, Tally sign convention) — import into a test company first |
| UI | ✅ Financial Reports rebuilt (10 reports, previous-year column, drill-down), committee **Audit & Year Close** tab (decide adjustments, year lock, last year's figures), CA **Adjustments & Last Year** tab |
| Tests | ✅ `tests/db/ca-workspace.test.mjs` (8) + `tests/unit/tally-xml.test.ts` (2) — **129 pass**, `tsc`, `eslint` (0 errors), `next build` ✅ |
| Hosted DB | ✅ 014 applied; RLS on 3 new tables, 16/16 functions, lock triggers present |

**Not done / later:** Tally import not tried in a real Tally company; Form 26Q / 24Q file generation; co-operative society audit formats (Form N etc.) differ by state; previous-year column is the whole last year (not same months last year).

### P10 — Bank reconciliation
Bank statement CSV import (SBI/HDFC/ICICI/Axis/Kotak formats + generic mapping) → `bank_transactions` → auto-match resident payments + vendor payments → unmatched list → "statement mein mila" badge on verify screen.

**P10 progress ✅ (20 Oct 2026)**
| Item | Status |
|---|---|
| Parser | ✅ `src/lib/bank-statement.ts` in the browser: finds the heading row below bank / account lines, SBI / HDFC / ICICI / Axis / Kotak / generic names, Withdrawal + Deposit or Amount + Dr/Cr or signed amount, comma or tab files, "1,00,000.00 Dr" amounts, dates with time, newest-first statements reversed, footer lines skipped. CSV only (Excel → Save As CSV) |
| Import | ✅ `import_bank_statement` (committee, Pro `bank_match`): ≤ 5,000 lines, each line hashed per account, so re-uploading the same or an overlapping statement adds only new lines; latest closing balance saved on the bank account; `bank_statement_imports` keeps the file, period and counts |
| Auto-match | ✅ money in → resident payment whose UTR appears in the narration with the same amount; money out → vendor payment whose UTR / cheque ref appears, or TDS challan (same amount, ≤ 7 days, narration has the challan no. / TDS / ITNS / OLTAS); otherwise a **suggestion** when exactly one entry has the same amount within 3 (in) / 5 (out) days |
| Committee actions | ✅ **Verify all N** (UTRs found in the bank → `verify_payment`, receipts issued + emailed), confirm suggestion, match with… (amount and direction checked), **record as a flat's payment** (no UTR submitted: creates + verifies a payment for the owner), no match needed with a reason (bank charges, interest), unlink |
| Summary | ✅ statement balance vs books (ledger 1000 up to the statement date), unmatched money in / out, counts; one statement line per payment / vendor payment / challan (unique indexes) |
| Security | ✅ `bank_transactions` read-only through RLS (committee, CA with `view_bank_reconciliation`); writes only through the functions; matching helpers not callable from the app |
| UI | ✅ **Bank Reconciliation** tab (Pro gate): bank accounts, upload + preview, summary cards, Open / Suggested / Matched / No match needed filters with actions; Payments tab shows "In bank statement (date)" on matched UTRs |
| Tests | ✅ `bank-reconciliation.test.mjs` (7) + `bank-statement.test.ts` (6) — **161 / 161 pass**, `tsc`, `eslint` (0 errors), `next build` ✅ |
| Hosted DB | ✅ 017 applied; RLS on both tables, single SELECT policy on lines, anon cannot import, `match_bank_lines` internal only |

**Not done / later:** Excel / PDF statements (CSV only), bank charges / interest are not posted to the books from the statement (book them as an expense / income, then match), live bank feeds (Account Aggregator) — later.

### P11 — SaaS billing engine
Admin pricing console · feature matrix · overrides/coupons · trial · invoice generation (pg_cron) · Razorpay + Edge Function webhook · manual NEFT mark-paid · dunning (email + WhatsApp) · downgrade/read-only · society billing page · auto-expense draft in society books · revenue dashboard · entitlement checks in RPCs.
**Tests:** invoice maths (min flats, discount, GST, annual), webhook idempotency + bad signature, downgrade locks pro RPCs, committee can't edit subscription.

**P11 progress ✅ (20 Oct 2026)**
| Item | Status |
|---|---|
| Plans | ✅ Free ₹0 (ads) / Basic ₹10 (CA portal, asset register) / Pro ₹18 (+ GSTR-2B, TDS register, bank match, Tally); old starter/growth/enterprise switched off; admin edits rate, features, ads, storage |
| Billing rules | ✅ `platform_settings.billing`: 10 months for a year, min 20 flats, 30-day trial, due 15 days, renewal invoice 15 days before end, move to Free 30 days after renewal invoice, GST 18 %, SAC, seller + bank details |
| Trial | ✅ every society (new and existing) gets a 30-day trial with all features; paying during the trial starts the paid period after it |
| Overrides | ✅ `society_pricing_overrides`: custom rate, % discount, free months (first plan), flats not billable, valid till, reason — platform admin only |
| Invoices | ✅ `platform_invoices` GST tax invoice `SV-<FY>-NNNN`, seller / bill-to snapshot, CGST+SGST vs IGST on the printable view |
| Plan changes | ✅ `choose_plan`: new (after trial / today), upgrade now (prorated difference), cheaper plan or Free at period end; unpaid new / upgrade invoices voided on a new choice |
| Payments | ✅ Razorpay Checkout (`/api/billing/order`, `/api/billing/verify` re-checks the payment with Razorpay) + webhook (`/api/billing/webhook`, signature over raw body); DB side `gateway_record_payment` guarded by a shared secret (hash in `platform_secrets`) — **no service-role key**; NEFT marked by the admin; idempotent |
| On payment | ✅ plan starts / extends; a draft "Software & Subscriptions" bill (vendor Sahvaas, GST) lands in the society's books for approval |
| Lifecycle | ✅ `run_subscription_lifecycle` daily (pg_cron 01:00 IST): trial → Free, scheduled switches, renewal invoices, grace (`past_due`), move to Free; paying the old renewal restores the plan |
| Entitlements | ✅ `society_has_feature`; CA portal off on Free (grants kept, `has_professional_permission` returns false), CA invites blocked; asset register actions, GSTR-2B upload and TDS register gated; capital bills still post on any plan |
| UI | ✅ society **Plan & Billing** (status, plans with live quotes, pay / bank transfer, invoices, printable invoice), trial-ending / overdue / Free banners, feature gates on CA access and assets; platform **Billing & Plans** (KPIs, per-society price + invoices + NEFT mark-paid, plans & features, rules, gateway secret, run job); public **Pricing** page now reads live plans |
| Tests | ✅ `saas-billing.test.mjs` (9) + `razorpay.test.ts` (4) — **142 / 142 pass**, `tsc`, `eslint` (0 errors), `next build` ✅ |
| Hosted DB | ✅ 015 applied; 3 plans live, RLS on new tables, anon can only call `gateway_record_payment`, cron `sahvaas-subscriptions` scheduled |

**Not done / later:** reminder emails / WhatsApp for invoices (in-app banners only), Razorpay never called for real (no keys yet), refunds / credit notes, UPI AutoPay mandates, invoice numbering gaps if a transaction rolls back after numbering (rare; GST wants a continuous series — check with CA).

### P12 — Free plan + ads
Ad slot component (only Free + resident + allowed screens) · house ads · sponsor campaigns (targeting, schedule, caps, stats) · AdSense adapter (feature-flag, off by default) · privacy/terms update.
**Tests:** ad never renders on blocked routes; paid plan never gets ads; stats aggregate only.

**P12 progress ✅ (20 Oct 2026)**
| Item | Status |
|---|---|
| Campaigns | ✅ `ad_campaigns` (sponsor, headline 80, line 160, image in public bucket `ad-creatives` ≤ 2 MB, button + https / tel link only, cities / pincodes, placements home_feed / notices, dates, ₹ / month, house card, priority, status) — platform admin only |
| Who sees them | ✅ `ads_for_me`: only resident owners / tenants of a society whose plan has ads (Free), not in trial; committee never; sponsors first, house cards fill; one card per slot, two per session (browser session cap) |
| Where | ✅ resident home feed (under circulars) and notices list only — no slots on pay, bills, receipts, reports, committee or CA screens |
| Stats | ✅ `ad_daily_stats` per campaign × society × day × placement, impressions / taps only — no user ids; ineligible events ignored |
| Admin | ✅ platform **Sponsors** tab: create / edit with live preview, image upload, reach (societies + flats) even for drafts, this month's views / taps / CTR, sponsor income |
| Privacy | ✅ "Why am I seeing this?" on every card; Security page explains offers and no tracking; AI wording corrected |
| Tests | ✅ `ads.test.mjs` (6) — **148 / 148 pass**, `tsc`, `eslint` (0 errors), `next build` ✅ |
| Hosted DB | ✅ 016 applied; RLS on, bucket public read / admin write, anon cannot fetch ads |

**Not done / later:** Google AdSense filler (needs site approval; off), sponsor invoicing (sponsors are billed outside Sahvaas for now), sponsor self-serve portal, image moderation beyond admin review, Privacy Policy / Terms pages (legal text — P13 with a lawyer).

### P13 — Go-live (user ke accounts chahiye)
Purana F3 (custom SMTP, Supabase auth redirect URLs, Vercel deploy, Sentry, browser smoke test) + **Razorpay KYC**, platform **GST registration**, Terms / Privacy / Refund pages (Razorpay ke liye zaroori), domain.
**Note:** Razorpay KYC aur GST registration mein din/hafte lagte hain — **abhi se parallel mein shuru karo.**

**Suggested order:** P7 → P8 → P9 → P11 → P12 → P10, aur P13 ke account wale kaam aaj se parallel.

---

## 9. Decisions — ✅ confirmed 20 Oct 2026 (sab "Recommendation" column wale)

| # | Decision | Recommendation | Alternative |
|---|---|---|---|
| 1 | Starting prices (per flat/month) | Free ₹0 · Basic ₹10 · Pro ₹18; annual = 10 months; min 20 flats | Existing ₹12/18/25 rakho |
| 2 | Payment na aaye toh | Grace ke baad **Free pe downgrade** (ads on, pro lock) — society nahi tootegi | Read-only suspend |
| 3 | Free plan pe flat limit | Koi limit nahi (pro features lock hi kaafi) | e.g. 50 flats tak free |
| 4 | Ads source | House + local sponsors pehle, AdSense baad mein | AdSense day 1 |
| 5 | Payment gateway (SaaS fee) | Razorpay | Cashfree / PayU |
| 6 | CA books change kar sake? | Nahi — sirf propose, committee approve | CA ko direct posting permission |
| 7 | Asset suggestion threshold | ₹25,000 + category | Har bill pe manual |

---

## 10. Risks

- **Accounting rules** (depreciation rates, ITC for societies, TDS thresholds, co-op audit formats) state-wise alag ho sakte hain → sab configurable + kisi practising CA se ek baar review karwana.
- **Accrual change** existing reports ke numbers badal sakta hai (approved-but-unpaid ab expense mein dikhega) → release note + CA ko batana.
- **Ads se trust** — society log "ads" ko negative le sakte hain → clearly labelled, money screens pe kabhi nahi, ek click upgrade.
- **GST on SaaS** + invoice format → platform ka CA confirm kare before first invoice.
