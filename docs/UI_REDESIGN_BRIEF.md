# Sahvaas — UI & UX Redesign Brief

> **Ye file kya hai?** Ye Claude ke liye poora design brief hai. Isse Claude ko pata chalega ki
> app kaisa dikhna chahiye (UI), har kaam kitna aasaan hona chahiye (UX), kya change karna hai
> aur kya bilkul nahi chhoona hai.
>
> **Kaise use karein:** Claude Code mein naya session kholo (folder `D:\sahaniwas`) aur ye prompt paste karo:
>
> ```
> Read docs/UI_REDESIGN_BRIEF.md completely and follow it. Start with Phase 0,
> Phase 0.5 (journey audit) and Phase 1, then continue phase by phase.
> Use the ui-ux-pro-max and ui-styling skills.
> No backend changes: do not change Supabase queries, RPCs, RLS or migrations.
> Anything that needs a backend change goes to the "Needs backend" list for me.
> Commit after each phase, never push. After every phase show me before/after
> screenshots at 375px and 1280px, the tap counts for the journeys it touched,
> and tick that phase's checklist in this file.
> ```
>
> Agla phase chalane ke liye: `Continue docs/UI_REDESIGN_BRIEF.md from the next unticked phase.`

---

## 1. Goal

Make every screen of Sahvaas look and feel like a product from a well-funded company, at the
level of the Razorpay Dashboard, Stripe Dashboard, Linear or Zerodha Console: calm, clean,
consistent, fast, and obvious to use. A society secretary aged 55 should be able to use it on
a phone without help, and a CA should be able to work through hundreds of rows on a laptop
without friction.

Take inspiration from those products' *quality*, never copy their layouts, logos, colours or
illustrations.

**The bar:** if you put a Sahvaas screen next to a Razorpay Dashboard screen, nothing on the
Sahvaas screen should look homemade, **and** every common task takes fewer steps than it does
today (section 13 sets the targets). A beautiful screen that needs six taps still feels cheap.

## 2. Hard rules (do not break the app)

1. **No backend changes.** Do not change Supabase queries, RPC calls, RLS, migrations,
   API routes, `src/lib/*` business logic or `AuthContext`, and do not change what data is
   read or written.
   **You may change the flow in the UI layer:** merge or split screens, reorder steps, move an
   action next to where it is needed, add a preview step, open a different tab first, prefill a
   field from data the screen already loads, and remember UI choices (filter, FY, last tab) in
   `localStorage`.
   If a UX improvement needs a backend change (a new RPC, a new column, a bulk action), **do
   not build it**: add it to the "Needs backend" list in section 14 for the owner to approve.
2. **Keep every feature, field, button and permission check.** A button may move; it may not
   disappear. If a screen has a `canManage` / `readOnly` / `FeatureGate` check today, it must
   still have it.
3. **Keep all routes and exported component names** (other files import them).
4. **Keep accounting words in English** (I&E, Balance Sheet, TDS, GSTR-2B, Ledger, Journal).
   You may shorten or clarify UI copy, but do not change the meaning of any accounting,
   legal or payment text.
5. **Print must keep working.** Bills, receipts, statements, invoices and reports have
   `print:` styles: they must still print cleanly on A4.
6. Every phase ends green: `bun run typecheck`, `bun run lint`, `bun run test`, `bun run build`.
7. Commit after each phase with a clear message. **Never push** and never touch the live DB.
8. **Allowed new dependencies:** Radix primitives / shadcn-style copy-in components
   (`@radix-ui/react-dialog`, `-dropdown-menu`, `-popover`, `-tooltip`, `-tabs`, `-select`,
   `-switch`, `-checkbox`), `class-variance-authority`, `clsx`, `tailwind-merge`, `sonner`
   (toasts). **Not allowed:** MUI, Chakra, Ant, Bootstrap, or any full UI kit.

## 3. What makes it look homemade today (audit, 26 Nov 2026)

| # | Problem | Evidence in code |
|---|---|---|
| 1 | Dark-only theme with sky-blue glow gradients: looks like a template, not a finance product | `layout.tsx` forces `className="dark"` and `bg-slate-950`; `shadow-sky-600/30`, `from-sky-500 to-sky-700` |
| 2 | Body text is too small almost everywhere | `text-xs` used 255 times, often as the default for whole screens (`<div className="space-y-6 text-xs">` in BillingTab) |
| 3 | No shared components: every screen hand-rolls its buttons, inputs, cards and tables, so they all differ slightly | no `src/components/ui/`; `inputClass` strings copied into many files; `rounded-xl` ×402, `rounded-2xl` ×185, `rounded-lg` ×75, `rounded-3xl` ×17 |
| 4 | Browser pop-ups for confirmations and input | `window.confirm` ×15, `window.prompt` ×5 (e.g. cancel bill reason) |
| 5 | Success/error messages are inline boxes that push content down and stay there | `notice` / `error` state boxes at the top of most tabs |
| 6 | No web font is loaded: text renders differently on every device | no `next/font` anywhere; `globals.css` is only `@import "tailwindcss"` |
| 7 | Amounts don't line up in tables | `tabular-nums` used 0 times |
| 8 | The logo is the letter "S" in a gradient square | `PublicHeader.tsx` |
| 9 | Back button / refresh loses your place: tabs are only React state | `?tab=` is read once in `SocietyDashboardPage.tsx:214` but never written back |
| 10 | Marketing copy talks like a developer ("Multi-Tenant Housing Society OS") instead of to a secretary | `HomePage.tsx` hero |

## 4. Who uses it

| Portal | Route | Who | Device | Design priority |
|---|---|---|---|---|
| Society committee | `/society` | Secretary, Treasurer, Chairman, Accountant — often 45–70, not "techy" | Phone first, also laptop | Clarity, big tap targets, "what needs me today" |
| Resident | `/resident` | Flat owners and tenants | Phone (PWA) | Pay dues in 2 taps, read notices, raise complaints |
| Professional / CA | `/professional` | CAs, auditors, accountants with many client societies | Laptop / desktop | Dense data, fast scanning, keyboard, exports |
| Platform owner | `/platform` | Sahvaas team | Desktop | KPIs, tables, filters |
| Public site + auth | `/`, `/pricing`, `/login`… | Prospective societies and CAs | Both | Trust, clarity, conversion |

## 5. Design direction and tokens

**Direction:** light, calm, trustworthy fintech. White surfaces on a very light grey canvas,
one confident blue brand colour, thin borders, very soft shadows, generous whitespace, strong
typographic hierarchy. Colour is used for meaning (status, money in/out), not for decoration.
Dark mode is supported through the same tokens, but **light is the default**.

Define everything as tokens in `src/app/globals.css` with Tailwind v4 `@theme` and CSS
variables, with a `.dark` override block and `@custom-variant dark`. After Phase 1 no
component may use raw palette classes like `bg-slate-900` or `text-sky-400`; use the
semantic tokens (`bg-surface`, `text-fg-muted`, `border-border`, `bg-brand`…).

### Colour (light)

| Token | Value | Use |
|---|---|---|
| `canvas` | `#F6F7F9` | page background behind cards |
| `surface` | `#FFFFFF` | cards, tables, dialogs, sidebar |
| `surface-muted` | `#F1F3F6` | table header, hover rows, input add-ons |
| `border` | `#E4E7EC` | default 1px borders |
| `border-strong` | `#CDD3DC` | inputs, dividers that need weight |
| `fg` | `#101828` | headings and main text |
| `fg-muted` | `#475467` | secondary text, labels |
| `fg-subtle` | `#667085` | hints, timestamps (still ≥ 4.5:1 on white) |
| `brand` | `#2563EB` (hover `#1D4ED8`, soft `#EFF4FF`, text-on-soft `#1E40AF`) | primary buttons, links, active nav, focus ring |
| `success` | text `#067647`, soft `#ECFDF3`, solid `#12B76A` | paid, verified, collected, money in |
| `warning` | text `#B54708`, soft `#FFFAEB`, solid `#F79009` | pending, due soon, trial ending |
| `danger` | text `#B42318`, soft `#FEF3F2`, solid `#F04438` | overdue, rejected, destructive actions |
| `info` | text `#175CD3`, soft `#EFF8FF` | neutral notices |

Dark mode: canvas `#0B0F17`, surface `#111722`, surface-muted `#182030`, border `#232C3B`,
fg `#E6E9EF`, fg-muted `#A3ACBA`; status colours keep their hue, softs become 12% alpha.

Update `themeColor` in `layout.tsx` and colours in `manifest.ts` to the new brand.

### Status mapping (use everywhere, through one `<StatusBadge status=…>`)

| Status | Tone |
|---|---|
| paid, verified, approved, active, resolved, collected | success |
| pending, submitted, partially paid, due soon, in review, trial | warning |
| overdue, rejected, failed, past due, suspended | danger |
| draft, cancelled, closed, inactive, void | neutral (cancelled/void also strike-through amount) |
| open, new, info | info |

### Typography

- Font: **Inter** via `next/font/google` (variable, `display: swap`), set as `--font-sans`.
  Numbers: `font-variant-numeric: tabular-nums` on every amount, count, date column and KPI.
- App scale (px / weight): page title 24/600 · section title 16/600 · card title 14/600 ·
  body **14/400 (the default — not 12)** · secondary 13/400 · caption/label 12/500 ·
  KPI value 28/600 · table cell 14 · table header 12/500 uppercase-free, `fg-muted`.
- Marketing scale: hero 48–60/700 desktop, 34–40 mobile; section title 30–36/650.
- Form inputs are **16px on phones** (stops iOS zoom), 14px from `sm:` up.
- Sentence case everywhere ("Issue bills", not "Issue Bills"). No ALL-CAPS labels except tiny overlines.
- Never use `font-black` inside the app.

### Shape, space, depth, motion

- 4px grid. Page padding 16 (phone) / 24 (tablet) / 32 (desktop). Card padding 16 / 20 / 24.
- Radius: **8** buttons, inputs, badges · **12** cards, tables, menus · **16** dialogs, sheets. Nothing else.
- Shadows: `0 1px 2px rgba(16,24,40,.05)` on cards; a stronger soft shadow only on
  dialogs, menus and popovers. No coloured glow shadows.
- Motion: 150ms ease-out for hover/press, 200ms for dialogs, drawers and sheets; honour
  `prefers-reduced-motion`. Use skeletons for loading, not spinners in the middle of a page.
- Icons: lucide only, 16px inline / in buttons, 20px in navigation, stroke 1.75. No emoji in the UI.
- Max content width 1200px for app pages (1440 for wide data tables), centred.

### Indian formatting (everywhere, via existing helpers in `src/lib/inr.ts`, `fy.ts`, `flat-label.ts`)

- Money: `₹1,25,000` (lakh grouping), 2 decimals only where paise matter; negative as `−₹500` in danger colour; money in = success colour only where it helps.
- Dates: `26 Nov 2026`; with time `26 Nov 2026, 4:30 pm`; relative ("2 days ago") only in feeds.
- Financial year shown as `FY 2026–27`.
- Phone: `+91 98765 43210`.

## 6. Component library (`src/components/ui/`)

Build these in Phase 1, document each with a one-line comment, and use **only these** on
every redesigned screen:

- **Button** — variants `primary | secondary | ghost | danger | link`, sizes `sm | md | lg`,
  `loading` (spinner + disabled, keeps width), optional left/right icon, `asChild` for links.
  Min height 40 (md) and 44 on touch.
- **IconButton** — required `aria-label`, tooltip on desktop.
- **Input, Textarea, Select, Checkbox, Radio, Switch** — one look; 40px height; `border-strong`;
  brand focus ring (2px, offset); error state.
- **Field** — label, optional "(optional)" tag, hint text, error text, `htmlFor` wiring.
- **AmountInput** — `₹` prefix add-on, lakh formatting on blur, right-aligned, tabular.
- **Card**, **CardHeader** (title, description, actions), **CardBody**, **CardFooter**.
- **StatCard** — label, big value, optional delta/trend and sub-text, optional click-through.
- **StatusBadge / Badge** — tones from the status mapping above, optional dot.
- **DataTable** — sticky header, right-aligned numeric columns, row hover, row click,
  row actions in a `⋯` menu, empty/loading rows, optional selection + bulk-action bar,
  totals footer. **On phones it renders as a stacked card list** (each row becomes a card
  with the 2–3 most important fields), never a sideways-scrolling table.
- **Toolbar / FilterBar** — search input, filter chips/selects, right-side actions.
- **Tabs** and **SegmentedControl** (e.g. Flats | Members).
- **Dialog**, **Drawer / Sheet** (right side on desktop, bottom sheet on phones).
- **ConfirmDialog** + `useConfirm()` hook — replaces all 15 `window.confirm`; destructive
  ones use the danger button and say exactly what will happen ("Cancel bill B-0142 for flat
  A-302? The ledger entry is reversed.").
- **PromptDialog** + `usePrompt()` — replaces all 5 `window.prompt` (with a proper textarea
  and validation for reasons).
- **Toast** (sonner) — replaces inline success messages; errors that need action stay inline
  next to the thing that failed.
- **Alert / Banner** — info, success, warning, danger; optional action link; dismissible where it makes sense
  (plan banner, read-only banner, trial banner).
- **EmptyState** — redesign the existing one: icon in a soft circle, title, one helpful line,
  primary action.
- **Skeleton** — text, card, table-row variants.
- **PageHeader** — title, description, breadcrumbs (optional), primary + secondary actions;
  on phones the primary action becomes a full-width button or a floating action button.
- **Avatar** (initials fallback), **DropdownMenu**, **Tooltip**, **Popover**, **Stepper**
  (setup wizard, bill issue flow), **Pagination**, **DescriptionList** (label/value pairs
  for detail screens), **Money** and **DateText** display components.
- **AppShell** — see section 7.

## 7. App shell and navigation

One shell for all four portals (`/society`, `/resident`, `/professional`, `/platform`):

- **Desktop (≥1024px):** left sidebar 248px, white, with logo + workspace switcher at the top
  (society name, role; switch society / CA workspace), grouped nav using the existing groups
  in `src/lib/society-nav.ts` (Money, Society, Settings, Accounts), count badges (Approvals,
  pending payments, open complaints), and a profile menu at the bottom (name, mobile/email,
  Install app, Sign out, Sign out everywhere). Collapsible to icons at 1024–1279px.
- **Top bar:** page title or breadcrumbs on the left; notification bell, help, profile on the right.
- **Phones:** sticky top bar (society name + bell), bottom tab bar using the existing
  `PHONE_BAR` (Home · Bills · Payments · Complaints) plus **More**, which opens a bottom sheet
  with the full grouped menu. Respect safe-area insets.
- **URL keeps your place:** write the active tab to `?tab=` with `router.replace` (or
  `history.replaceState`) and read it on load, so refresh, back button and shared links work.
  Do the same for the resident, professional and platform portals. (This is navigation state
  only; no data logic changes.)
- Banners (read-only committee member, plan/trial, offline) sit under the top bar in one
  consistent `Alert` style, never stacked more than two.

## 8. Page patterns

Every screen follows one of these anatomies:

1. **Home / overview** — greeting + context line → KPI row (`StatCard` ×3–4) → "Needs your
   attention" list (actionable items with a button each) → quick actions → recent activity.
2. **List** — `PageHeader` (title, short description, primary action) → summary stats if
   relevant → `FilterBar` → `DataTable` → pagination. Empty, loading and error states designed.
3. **Detail** — header with name/number, status badge and actions → `DescriptionList` →
   related lists/tabs → activity/audit trail.
4. **Create / edit form** — opens in a `Drawer` (desktop) / full-screen sheet (phone) for
   short forms; a full page with sections for long ones (vendor bill, setup). Labels above
   fields, one column on phones, two at most on desktop, helper text under tricky fields,
   inline validation on blur, sticky footer with Cancel + primary action.
5. **Financial report** — report picker, FY/period selector, society name and period in the
   heading, accounting typography: indented groups, right-aligned tabular amounts, subtotal
   rows in 600 weight with a top border, grand total with a double top border, negative in
   brackets or with a minus as the CA expects, export buttons (CSV, PDF, Tally) in one
   consistent `DropdownMenu`. Must print on A4 portrait.
6. **Wizard** — `Stepper` with progress, one topic per step, Back/Next in a sticky footer,
   "Save and finish later".
7. **Printable document** (bill, receipt, statement, invoice) — letterhead layout: society
   name, address, registration no. at the top; document title and number; clean table;
   totals box; UPI QR; footer note. Looks like a real printed bill on A4 and on a phone.

States to design on **every** screen: loading (skeleton), empty (EmptyState with action),
error (Alert with retry), no permission (calm explanation, who can do it), read-only.

## 9. Page inventory (tick each when redesigned and verified)

### Society portal — `src/views/society/SocietyDashboardPage.tsx` + `tabs/` + components
- [x] Home — KPIs: collected this month, outstanding, overdue flats, approvals waiting;
      setup checklist as a progress card (`/setup`); "Needs your attention"; quick actions
      (Issue bills, Record payment, Add vendor bill, Post notice); latest notices. (`HomeCards`)
- [x] Approvals — one inbox: vendor bills, join requests, CA adjustments, opening balance,
      flat requests; each item has Approve / Reject with ConfirmDialog. (`PendingVendorBills`, `JoinRequests`, `RequestsWaiting`)
- [x] Maintenance bills — charges (billing rules) as a clean card list with an "Add charge"
      drawer; issue-bills as a 3-step flow with preview; bills `DataTable` with status chips,
      flat search, totals footer; cancel with PromptDialog. (`BillingTab`, `RuleFlats`, `BillTypes`)
- [x] Payments received — "To verify" queue first (proof image preview, verify / reject),
      then history table; record payment drawer. (`PaymentsTab`)
- [ ] Vendor bills — list with status, maker-checker state; long form as a sectioned page
      (vendor, invoice upload with AI extract, amounts/GST/TDS, revenue vs capital). (`ExpensesTab`, `ExpenseBillForm`)
- [ ] Reports — report pattern (section 8.5). (`FinancialReports`, `FlatStatement`, `PartyLedgers`)
- [ ] Flats & residents — SegmentedControl Flats | Members; flats table with wing filter,
      occupancy badge; member drawer; owner change, tenancy, transfer, shifting flows. (`UnitsTab`, `MembersTab`, `OwnerChange`, `Tenancies`, `TransferForm`, `Shiftings`)
- [ ] Notices — list + composer drawer with preview. (`NoticesTab`, `NoticeSeen`)
- [ ] Polls — cards with results bars. (`PollsList`, `PollCard`)
- [ ] Staff — register table + profile drawer. (`StaffRegister`)
- [ ] Requests & NOCs — list + detail. (`FlatRequests`, `RequestDetail`)
- [ ] Complaints — list with status/priority + conversation thread like a chat. (`ComplaintsTab`, `ComplaintThread`)
- [ ] Documents — folder/grid view with file type icons. (`DocumentsVault`)
- [ ] Society settings, CA & auditor, Plan & billing (pricing cards, invoices table). (`SettingsTab`, `SocietyProfile`, `ProfessionalsTab`, `PlanBilling`, `ShiftingSettings`, `TenancySettings`, `TransferSettings`, `JoinLinkCard`)
- [ ] Accounts group — Groups & Ledgers, Bill Types, Opening Balance, Fixed Assets, Bank
      Reconciliation, Audit & Year Close. (`ChartOfAccounts`, `OpeningBalanceEditor`, `OpeningBalanceReview`, `AssetRegister`, `BankReconciliation`, `AdjustmentsPanel`, `YearLockPanel`, `PriorYearEditor`)

### Resident portal — `src/views/resident/`
- [x] Overview — hero card "You owe ₹X, due 10 Dec" with a big **Pay via UPI** button (or
      "All paid ✓" state), then notices, my requests, polls, sponsored card (Free plan only,
      clearly labelled "Sponsored", never on money screens).
- [ ] Bills, My account / statement, Notices, Polls, Staff, Requests, Complaints (`ResidentTickets`), Documents.

### Professional / CA portal — `src/views/professional/`
- [ ] Client societies list → workspace. Sticky context bar: society + FY.
- [ ] Financial Reports, Groups & Ledgers, Bill Types, Opening Balance, GST (GSTR-2B),
      Expenses & TDS, Fixed Assets, Bank Reconciliation, Audit & Year Close, Audit Vault,
      Audit Remarks. Denser spacing allowed here (table rows 40px), keyboard friendly.

### Platform owner — `src/views/platform/` + `src/components/platform/`
- [ ] Overview, Societies, Setup funnel, Society health, Revenue, Announcements, Billing &
      Plans, Sponsors (`AdsConsole`), OTP & cost, Demo requests, Tax rules, Users, Audit logs.
      KPI cards + charts (use `src/lib/chart.ts`, follow the dataviz skill) + filterable tables.

### Public site and auth — `src/views/public/`, `src/components/PublicHeader.tsx`, `PublicFooter.tsx`
- [x] Home — rewrite the hero for a secretary ("Run your society without registers and
      WhatsApp chaos" style, plain words), real product screenshots of the redesigned app
      in a device frame, persona sections (Committee, Residents, CAs), how it works in 3
      steps, security/trust strip, pricing teaser, FAQ, final CTA.
- [ ] Features, For Societies, For Accountants & CAs, Security, Pricing (plan cards +
      comparison table), Contact (form + details).
- [x] Login, Signup, Forgot / Reset password — split layout: form on the left, brand panel
      on the right (desktop); OTP as 6 separate boxes with auto-advance and paste. (`MobileOtpLogin`)
- [ ] Onboarding, Setup wizard (`SetupWizard`), Join by link (`/join/[code]`).
- [x] Public bill and receipt pages (`/bill/[id]`, `/receipt/[id]`) — printable document pattern.
- [ ] 404, error page, `public/offline.html` — branded, friendly, with a way back.
- [ ] Shared prompts: `NamePrompt`, `AddMobilePrompt`, `PWAInstallButton`, `OfflineIndicator`, `NotificationBell`, `WorkspaceSelector`, `SignOutMenu`.

### Brand
- [x] A simple, professional logo mark + "Sahvaas" wordmark as SVG (replace the "S" square);
      update `public/icon.svg` and the PNG icons, favicon, manifest, `themeColor`.

## 10. Copy rules

- Plain words a secretary uses: "Bills", "Payments", "Who hasn't paid", "Send reminder".
  Accounting terms stay exact where accounting is happening.
- Buttons say what they do: "Issue 32 bills", "Verify payment", not "Submit" / "OK".
- Errors say what happened and what to do next, never raw Supabase/Postgres text alone.
- Empty states say why it is empty and offer the next step.
- Sentence case. No exclamation marks. No jargon like "multi-tenant", "OS", "granular".

## 11. Accessibility and mobile

- WCAG 2.2 AA contrast for all text and icons that carry meaning.
- Visible focus ring on every interactive element; full keyboard use of dialogs, menus, tables.
- Tap targets ≥ 44×44px on touch; no hover-only actions on phones.
- Every icon-only button has an `aria-label`; form fields have labels; status is never shown by colour alone (badge text too).
- Test at 360, 375, 768, 1024, 1280 and 1440px. No horizontal scrolling at 360px.
- Respect safe areas (`env(safe-area-inset-*)`) for the PWA.

## 12. Phases

Each phase: work → `bun run typecheck && bun run lint && bun run test && bun run build` →
screenshots before/after at 375px and 1280px → tick the boxes above → commit (no push).

- [ ] **Phase 0 — Look first.** Run the dev server and open the demo seed society
      ("Palm Heights CHS (Demo)", `src/db/seed/demo_seed.sql`). Never type the user's real
      password: ask the user to sign in on the localhost page in the browser pane, or use a
      local test account. Take "before" screenshots of every page in section 9 and note
      anything this brief missed at the bottom of this file.
- [ ] **Phase 0.5 — Journey audit.** Walk journeys J1–J12 (section 13) as they are today,
      count the steps, list the friction, propose the new flows, and write it all to
      `docs/UX_JOURNEYS.md`. Put backend needs in section 14. Show the owner the summary
      table (journey, steps today, steps proposed) before Phase 2 starts building flows.
- [ ] **Phase 1 — Foundation.** Tokens, Inter font, light/dark theme, `src/components/ui/*`,
      `useConfirm` / `usePrompt` / toasts, AppShell, `?tab=` URL sync, new logo. Build a
      hidden `/ui` page (dev only) showing every component in every state.
- [ ] **Phase 2 — Society portal** (most used; do Home, Approvals, Bills, Payments first).
- [ ] **Phase 3 — Resident portal** (phone first).
- [ ] **Phase 4 — Professional / CA portal.**
- [ ] **Phase 5 — Platform owner.**
- [ ] **Phase 6 — Public site, auth, onboarding, setup wizard, join.**
- [ ] **Phase 7 — Printable documents** (bill, receipt, statement, invoice, reports print).
- [ ] **Phase 8 — Polish.** Grep for leftover raw palette classes (`slate-`, `sky-`,
      `text-xs` used as body text), remaining `window.confirm/prompt`, inconsistent radius;
      dark mode check; a11y pass; Lighthouse ≥ 90 on Performance, Accessibility, Best Practices
      for `/`, `/login`, `/society`, `/resident`.

### Definition of done for a page

- Uses only `ui/` components and semantic tokens.
- Loading, empty, error, read-only and no-permission states look designed.
- Works at 360px with no sideways scroll, and looks deliberate at 1440px.
- All amounts `₹` lakh-formatted and tabular; all dates `26 Nov 2026` style.
- No `window.confirm` / `window.prompt`; success shows as a toast.
- Same data and permissions as before; every old button still exists somewhere sensible.
- If the page is part of a journey in section 13, that journey meets its target and its
  "after" step count is written in `docs/UX_JOURNEYS.md`.
- The page's primary action is the most common task, and nothing on it is a dead end.

## 13. UX: key journeys

UI is how a screen looks; UX is how quickly someone gets their job done without help. The
redesign is judged on both. Phase 0.5 measures these journeys as they are today, and every
later phase must make the journeys it touches meet their targets.

### Principles

1. **The most common task comes first.** Each screen has one primary action, and it is the
   thing most people came to do (Pay, Verify, Issue bills), not a settings link.
2. **Attention before information.** Show what needs the user (overdue, waiting for approval,
   payments to verify) above what is just to read.
3. **Smart defaults.** Prefill from data the screen already has: this month, the current FY,
   today's date, last month's charges, the only wing, the society's UPI ID.
4. **Preview before anything hard to undo.** Issuing bills, cancelling a bill, year close,
   sending a notice to everyone, rejecting a request: show exactly what will happen and to
   how many flats/people, then confirm.
5. **Hide the advanced until needed.** GST, TDS, capital vs revenue, per-flat rules and
   similar options sit behind "More options", and open automatically when already in use.
6. **No dead ends.** Every success, empty state and error points to the next step.
7. **Say what happens next.** "Residents get a notification", "The ledger entry is reversed",
   "The CA can see this after you approve".
8. **Remember context.** Last tab, filters, FY and the selected society are kept (URL +
   `localStorage`), so returning users land where they left off.
9. **Keep the user's place.** After an action and the `onChanged` refresh, keep scroll
   position, the open drawer or row, and focus; never jump back to the top.
10. **Forgiving inputs.** Accept pasted UTRs with spaces, amounts with commas, phone numbers
    with +91; numeric keypad (`inputMode="numeric"`) for numbers on phones; validate on blur
    with a clear message, not only on submit.

### Journeys and targets

A "step" is one tap/click or one screen change, counted from the starting point. Typing into
a field does not count as a step; choosing from a list does.

| # | Journey | Who | Device | Starts at | Target |
|---|---|---|---|---|---|
| J1 | Pay dues and submit the UTR | Resident | Phone | Opening the app | 1 tap to the UPI app with the amount filled; back in the app, the UTR box is already in view, accepts a paste, then 1 tap to submit |
| J2 | Issue this month's bills | Secretary | Phone + laptop | Home | ≤ 3 steps: choose month (prefilled) → preview (flats, total, any flat left out) → issue; then an option to notify residents |
| J3 | Verify a resident's payment | Treasurer | Phone | Home | Home shows "N payments to verify"; 1 tap opens the queue; proof/UTR visible in the list; 1 tap to verify |
| J4 | See who hasn't paid and remind them | Secretary | Phone | Home | 1 tap to the overdue list; 1 tap to "Send reminder to N flats" with confirm (uses the existing `remind_overdue_flats`) |
| J5 | Add a vendor bill from a photo or PDF | Accountant / Treasurer | Phone + laptop | Vendor bills | Upload → fields prefilled by the existing invoice extract → check → save, under 1 minute for a normal bill |
| J6 | Approve or reject a vendor bill | Chairman / Treasurer | Phone | Notification or Home | Opens straight on the bill in Approvals; invoice visible; 1 tap + confirm |
| J7 | Post a notice | Secretary | Phone | Home | Quick action → title, text, category (default General) → preview as residents see it → publish, under 1 minute |
| J8 | Raise a complaint | Resident | Phone | Opening the app | Under 30 seconds: category, text, optional photo, submit; then shows its status and what happens next |
| J9 | Export a report | CA | Laptop | CA workspace | Society + FY remembered; ≤ 2 clicks from the report to the file (CSV / PDF / Tally) |
| J10 | New society to its first bill | Secretary | Laptop or phone | Sign up | One sitting: sign up → onboarding → setup wizard (progress shown, can resume) → first bill issued; wizard never asks for something it can work out |
| J11 | Join a society by link | Resident | Phone | Opening the joining link | Society name shown at once → mobile OTP → pick flat → request sent, under 2 minutes, then a clear "waiting for approval" screen |
| J12 | Find a flat or resident | Committee | Both | Any screen | Search in the top bar by flat number or name (filtering data already loaded), result in 1 tap |

### What Phase 0.5 produces

Write `docs/UX_JOURNEYS.md` with, for each journey J1–J12:

1. **Today:** the path screen by screen, with the step count and screenshots at 375px.
2. **Friction:** where someone would hesitate, scroll, guess or make a mistake (unclear
   label, action far from the data, no preview, tiny tap target, dead end, jargon).
3. **Proposed flow:** the new path and its step count, and which pages/components change.
4. **Needs backend:** anything the proposed flow needs that the UI cannot do alone. Copy
   these into the "Needs backend" list in section 14; do not build them.

Phases 2–6 then build the proposed flows, and update the step count in `docs/UX_JOURNEYS.md`
from "today" to "after" for every journey they touch.

### Real-user check (the owner does this; Claude cannot)

After Phase 3, give 3 committee members and 3 residents the journeys for their role on their
own phones, without explaining anything, and record the screen. Note every place they stop,
ask a question or tap the wrong thing, and add it to section 14. Fixing those comes before
Phase 8 polish.

## 14. Notes found during the work

_(Claude: add anything here that this brief got wrong or missed.)_

- **Status, 26 Nov 2026 (branch `ui-redesign`).** Every screen now uses the tokens (light theme, Inter, 8/12/16 radii,
  sentence case), the temporary palette bridge is gone, all `window.confirm` / `window.prompt` calls use
  `ui/feedback`, and the app icons use the new mark. Ticked items above meet their line in full. The rest are
  on the new look but not yet to every detail of their line: drawers for create/edit forms, a shared
  `DataTable` (only Maintenance bills has the table + phone cards pattern), the complaints chat thread,
  the documents folder grid, the CA FY context bar, a dark-mode switch (the tokens support `.dark`), the
  dev-only `/ui` page, Phase 0 screenshots, the Phase 0.5 journey audit (`docs/UX_JOURNEYS.md`) and Lighthouse.
  An automated contrast scan (text under 3.2:1 against its background) found nothing on the 16 society
  screens, 13 platform screens and the public pages after the last fixes.

- 26 Nov 2026: screens not redesigned yet are made light by a temporary `.palette-bridge` in `globals.css` (it re-points the old slate/sky/emerald/amber/rose colours). Paper (bill, receipt, invoice, QR) opts out with `.palette-native`. Under the bridge `text-white` is dark, so redesigned code uses `text-on-brand` on solid fills. Remove the bridge in Phase 8.
- Native `<dialog>` and a small store (`ui/feedback.tsx`) are used for confirm/prompt dialogs and toasts instead of Radix and sonner: no new dependencies were needed.

### Needs backend (owner approval required before building)

_(Claude: one line each: what, which journey it helps, and why the UI cannot do it alone.)_

- **Record a cash or cheque payment for a flat (committee).** Helps J3 and the Home "Record payment" quick action the brief lists. There is no RPC for the committee to record a resident's offline payment; the UI only verifies UTRs that residents submit, so the button is "Verify payments" for now.
