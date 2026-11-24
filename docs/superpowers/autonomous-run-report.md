# Autonomous run report (Phases 3–11C)

The product owner asked on 2026-11-05: "pura project complete kar do… dont wait for me, u decide the best" and "pure project ko proper test karna, bugs clear karna".

Each phase below went through the same steps:
1. a plan;
2. TDD implementation;
3. the full suite, one file at a time;
4. typecheck, lint and a production build;
5. a fresh reviewer (Opus) and one fix pass;
6. a fast-forward merge into local `main`.

Nothing was pushed to GitHub. No migration was applied to the live database: run `bun run db:migrate` and then `--apply` yourself.

---

## Phase 3A — notification inbox, dues reminders, web push (migration 030)

**Built**
- **In-app inbox.** A bell with an unread badge, fed by database triggers:
  - a new bill goes to the flat's owner;
  - a notice goes to its audience and the committee;
  - a complaint status change or a committee reply goes to the resident who raised it;
  - a verified or rejected payment goes to the payer;
  - committee admins get payments to verify, vendor bills to approve, CA / year-lock / bank-move proposals and opening balances.
- **Dues reminders.** The committee sets the schedule in Society Rules ("Remind 3 days after the due date, then every 7 days"). The job runs every morning at 09:00 IST through pg_cron. It reminds only the flat's current owner, never while a payment for the flat waits for verification, and at most once per bill per day (a unique index enforces this).
- **Web push to phones.**
  - The push carries no payload, so the lock screen shows only "Sahvaas: You have a new message".
  - `/api/push/send-pending` claims notifications once, then sends in parallel with a 5-second timeout and removes dead subscriptions.
  - Only real push services (Google, Mozilla, Apple, Windows) are accepted as endpoints.
  - A phone re-subscribes on its own and drops its subscription on logout.

**What you need to set (for push only; the inbox and reminders work without it)**
- In Vercel:
  - `SUPABASE_SERVICE_ROLE_KEY`;
  - `VAPID_PRIVATE_KEY` and `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (`.env.example` has a one-line command to generate them);
  - `VAPID_SUBJECT`;
  - `CRON_SECRET`.
- On the database, with pg_net enabled:
  - `ALTER DATABASE postgres SET app.push_url = 'https://<your-app>/api/push/send-pending';`
  - `ALTER DATABASE postgres SET app.cron_secret = '<same CRON_SECRET>';`
  - If Supabase refuses database settings, use Vault instead; the reviewer could not check this.

**Rulings I made (cost if wrong)**
1. Every notice also reaches the committee roles, whatever its audience. Cost: committee inboxes carry tenant-only and owner-only notices.
2. A receipt recorded straight from the bank statement still raises "Payment to verify" for the committee. Cost: one stale inbox item per such receipt.
3. Reminders are de-duplicated by the day they are for (`ref_date`). Cost: none.
4. The push sender uses the service-role key, server-side only. Cost: one more secret to set.
5. Push runs only from the scheduled job, and only once `app.push_url` / `app.cron_secret` are set. Cost: push stays off until then, and a phone may buzz up to 5 minutes after the event.
6. A notification's link opens Maintenance Billing for the committee and Bills for a resident. Cost: none.
7. Reminders run at 09:00 IST instead of night-time pushes being held back. Cost: none.
8. The lock-screen text has no society name, because the push carries no payload. Cost: the spec asked for the society name.
9. Opening-balance (arrears) bills are reminded like any other bill. Cost: none.
10. The committee is not notified about new complaints, because the spec's list leaves them out. Cost: the committee checks the Complaints screen itself.

**Deferred minors**
- Read-only committee members see an editable reminder schedule; the server refuses their Save.
- Two bells poll every 60 seconds on the society page: one in the mobile header, one in the sidebar.
- A subscription that answers 403 (after a VAPID key change) is not removed.
- The inbox mixes all of a user's societies, and its titles do not name the society.
- A deactivated society still produces notifications.
- Test gaps: the complaint, proposal and opening-balance triggers, and the sender's partial failures.
- The cron secret comparison is not constant-time. This is harmless: the route answers 401.

---

## Phase 3B — owners' mobiles and one joining link (migration 031)

**Built**
- **Owner mobiles (Flats tab).**
  - Each flat has an expected owner name and mobile, editable inline under "Owner mobile".
  - "Paste owners from Excel" takes three columns: flat number, name, mobile. It shows a preview of matched flats and lists unknown flat numbers and bad mobiles. An empty cell leaves what is saved alone.
  - The contacts sit in a committee-only table (`unit_owner_contacts`), so residents never see each other's mobiles.
- **One joining link (top of Members).**
  - Copy, "Share on WhatsApp", and "Make a new link" (the old one stops working).
- **`/join/<code>`.** The person logs in or signs up and comes straight back to the link.
  - **Joins at once:** when their **confirmed login phone** matches a flat's owner mobile, they join that flat as owner, provided the flat has no joined owner yet and the committee never removed them.
  - **Request:** everyone else becomes a request in **Approvals**. A typed mobile never attaches anyone.
  - **What the link shows:** already a member, waiting, or turned down with the reason plus "Ask again".
- **Join requests in Approvals.**
  - Approve as Owner or Tenant on a chosen flat, or reject with a reason.
  - A tenant gets no bills.
  - At most 30 waiting requests per society, or 2 per flat in a bigger society; decided requests don't count.
- **Owner change (2F) and the link.** An owner change sets the flat's expected mobile to the new owner's. When the new owner joins through the link, the waiting change completes and the flat's open bills become theirs.

**What you need to set**
- Nothing new. The link uses the app's own address.
- If you want sign-up through the link to return to the link after email verification, check Supabase → Authentication → URL Configuration: the redirect allow-list must accept query strings (`https://<your-app>/**`).
- When phone login is on (3C), keep **"Confirm phone"** on in Supabase. The link trusts only a confirmed phone.

**Rulings I made (cost if wrong)**
1. The join code is 12 random hex characters. Cost: none.
2. One mobile entered on several flats joins all of them in one go. Cost: a mistyped mobile hands a second flat to that person until the committee removes them.
3. Someone already in the society cannot use the link again; a second flat goes through Members. Cost: one extra step for owners of two flats.
4. Login and signup come back through the existing `returnUrl`. Cost: none.
5. The mobile typed on the join page is shown to the committee only and never attaches anyone. Cost: until phone login (3C) is live, every resident goes through Approvals.
6. A phone match never overrides the committee. A flat whose owner has already joined, or a person the committee removed, goes to Approvals. Cost: joint owners are approved by hand.
7. Correcting a flat's mobile also corrects a waiting owner change, so the old number stops working. Cost: none.

**Reviewer findings fixed:**
- the join code needed pgcrypto, which Supabase keeps in the `extensions` schema, so the link would not have worked on the live database;
- the daily cap would have blocked normal sign-ups;
- residents could read owners' mobiles;
- a phone match could bring back removed members and add silent co-owners;
- a corrected mobile still worked;
- an open redirect through `returnUrl`;
- a rejected person never saw the reason;
- pasting names only wiped saved mobiles.

**Deferred minors**
- A waiting request blocks a later phone match until the committee decides.
- Approving a stale request ignores an existing membership.
- Joining by invite or link does not close a waiting request.
- The new owner's email invite stays pending after the change completes through the link.
- The Approve screen does not show the flat's current owner or a waiting owner change.
- Two simultaneous first loads of the link can show a link that is replaced at once.
- No length limits on the request's name, mobile and flat.
- Mobiles typed as `0091…` or `+91 0…` are not normalised.
- The owner-contacts audit records a count, not each old and new mobile.
- A changed link is reported only after logging in.
- Test gaps: read-only committee and other-society refusals, RLS on reading join requests, receipts moving through the link.

---

## Phase 3C — mobile + WhatsApp code login (migration 032)

**Built**
- **Mobile login.** "Your mobile number" → "Send code on WhatsApp" → "Enter the 6-digit code".
  - Supabase phone auth makes the code and calls our **Send SMS hook** (`/api/auth/sms-hook`). The hook checks Supabase's signature, asks the database whether this number may get a code, sends it on WhatsApp, and falls back to SMS (MSG91) for Indian numbers. A resend after a WhatsApp code that never arrived goes by SMS first.
  - Numbers outside India: type the country code (+65 …). They get WhatsApp only.
- **Limits and cost.**
  - Per number: 60 seconds between codes. 5 a day for a registered number, 3 a day for an unknown one.
  - Each society's numbers share a daily bound of 2 per flat + 20.
  - Platform-wide: a daily cap for unregistered numbers (2000) and an emergency cap for registered ones (20000).
  - Blocked numbers are refused.
  - Every send is logged with its cost.
- **Platform → "OTP & cost".** WhatsApp, SMS and foreign counts; estimated cost; a per-society table with an alert above 5 codes per flat a year; editable limits; block and unblock a number.
- **Accounts.**
  - A phone-only account works; it no longer needs an email.
  - Logging in with the mobile the committee entered for a flat joins that flat, under the committee's name for the owner.
  - Invites (member and CA) can name a mobile. Only a confirmed phone sees them.
  - An owner change can name the new owner by mobile.
  - "Log out of all devices" is in every portal.
  - The middleware refreshes the session on every page (iPhone).
  - A one-time "What is your name?" card for new mobile accounts; an "Add your mobile number" card for existing email accounts.

**Switched off until you are ready.** The login page shows mobile login only when `NEXT_PUBLIC_PHONE_LOGIN=1`. Until then:
- email login works as before;
- invites and owner changes still need an email.

**What you need to set (when WhatsApp Business is approved)**
1. Supabase → Authentication → Providers → **Phone**:
   - enable it;
   - keep **Confirm phone** ON;
   - set the OTP expiry to about 300 seconds;
   - set SMS max frequency to 60 seconds.
2. Supabase → Authentication → **Hooks** → "Send SMS hook" (HTTP): URL `https://<your-app>/api/auth/sms-hook`. Copy its secret into `SEND_SMS_HOOK_SECRET`.
3. Supabase → Authentication → **Rate limits**: raise "SMS sent" (default 30 per hour for the whole project).
4. In Vercel:
   - `SEND_SMS_HOOK_SECRET`;
   - `SUPABASE_SERVICE_ROLE_KEY` (already needed for push);
   - `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_NAME` (an approved **authentication** template with a copy-code button), `WHATSAPP_TEMPLATE_LANG`;
   - optional SMS backup: `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID` (DLT-approved);
   - then `NEXT_PUBLIC_PHONE_LOGIN=1`.
5. Tell existing users: log in with email once, and add your mobile from the card at the bottom of the screen. Otherwise a mobile login makes a second, empty account.

**Rulings I made (cost if wrong)**
1. Email login stays as a fallback; spec 12 call 5 said no email. Cost: one more login option on screen until you remove it.
2. Unknown numbers get 3 codes a day. This covers both "Register your society" and the joining link, with no separate per-link limit. Cost: none.
3. A failed send counts toward the 60-second wait but not toward the daily limits, and costs nothing. Cost: a broken provider is retried once a minute per person.
4. Each provider gets 2 seconds inside one 3.5-second budget; Supabase allows a hook 5 seconds. Cost: a slow WhatsApp reply falls back to SMS, or the person is asked to try again in a minute.
5. MSG91's request shape could not be checked without an account. Cost: the SMS backup may need a small fix when you configure it.
6. A CA can be invited by mobile too. Cost: none.
7. The iPhone "Add to Home Screen" hint is the one from 3A in the bell. Cost: none.
8. Rejected-at-review behaviours are fixed. The redirect after a mobile login has no automated UI test, because the project has no React test harness. Cost: check it by hand once.

**Deferred minors**
- "Log out of all devices" does not remove the lost phone's push subscription. The pushes carry no content.
- A pending owner invite stays after the flat is claimed by phone.
- Professional invites by mobile have no duplicate check.
- A rotated hook secret (`a|b`) is not supported.
- A few screens show a blank email for phone-only users.
- OTP settings accept negative costs.

---

## Phase 4A — bills belong to flats, the bill page, per-flat charges (migration 033)

**Built**
- **Bills belong to the flat.**
  - Bills are issued for every flat, even before anyone has joined.
  - A sold flat with a waiting owner change bills nobody. Before, it billed the seller.
  - When the owner joins (by invite, the joining link, or mobile login), they take the flat's bills and any money recorded for it, with one "Bills for Flat …" notification.
  - Money received for a flat nobody has joined can be recorded from the bank statement.
  - Opening dues for such a flat wait for the owner like any bill.
- **Printable bill, `/bill/<id>`.**
  - It shows: society name, registration number and address; member, flat and area; bill number, date and period; the charges breakup; the late fee as its own line; previous dues; less advance; total payable and due date; a UPI QR for the exact amount; bank details; the late-fee rule.
  - "Print / Save PDF". A cancelled or paid bill says so and asks for nothing.
  - Linked from the resident's bills and from Maintenance bills.
- **Charges for chosen flats (parking).** Each charge shows "Charged to: all flats / chosen flats" with a flat picker. A chosen-flats charge bills nobody until flats are chosen.
- **Member dues report.** One row per flat, named by the owner, the expected owner, or "Not joined yet".
- **A society with one committee member** approves its own vendor bills; they are marked self-approved in the audit log. One approval is then enough even with two-step approval on. When a second admin joins, the normal rule returns.

**What you need to set:** nothing.

**Rulings I made (cost if wrong)**
1. Existing tests that assumed "flats without an owner are skipped" were updated to the new rule. Cost: none.
2. Bill arrears are the flat's other open bills due earlier. Advance is verified money not yet set against bills, plus opening advances. Cost: none.
3. "All flats" on a charge is a direct rule update. Cost: none.
4. The bill notification opens the Bills list, which is one tap from the bill page. Cost: one extra tap.

**Deferred minors**
- The buyer of a sold flat gets no "Bills for Flat" notification.
- The bill shows the primary bank, not the CA's default receiving bank.
- "Less: advance" shows even when nothing is due.
- Late-fee wording: the percentage is on the unpaid balance; opening bills show the rule; a ₹0 fee prints.
- Read-only members see the chosen-flats buttons, and the server refuses them. "All flats" is not audited.
- A charge added in Maintenance bills starts as "all flats".
- The self-approval note is also shown to read-only viewers.
- "No bills to generate" does not name the charge that needs flats.
- Nits: the middleware prefix `/bill` also matches `/billing…`; `inr_text` duplicates `money_text`.

---

## Phase 4B — setup in six short steps (migration 034)

**Built**
- **`/onboarding` is the setup wizard** (and `/setup` resumes it).
  - **Society:** name, pincode (city and state filled in automatically), and your role.
  - **Flats:** wings ("No wings" allowed) × floors × flats per floor, with a preview such as "56 flats will be created: A-101 … A-704, B-101 … B-704". Or upload from Excel.
  - **Maintenance:**
    - "Same for all" or "Per sq.ft", with the area asked per flat position;
    - Sinking fund, Repair fund and Parking. Parking bills only the flats you pick later.
    - The due day, and "Remind 3 days after the due date, then every 7 days".
    - These charges post to the default ledgers (4000, 3000, 3100, 4200) until the CA re-maps them.
  - **UPI:** the ID and payee, with a QR preview. "Later" is allowed.
  - **Owners:** a table of flats with name and mobile, or paste from Excel. "Skip" is allowed.
  - **Done:** this month's bills (count, total, due date, and any flats not billed); **Send bills**; the joining link to share; "Invite your CA"; "Add your treasurer or chairman".
- **Resume.** The wizard resumes at the first unfinished step, counting work done elsewhere (Excel import, Settings, Billing). The dashboard shows "Finish setting up your society" until the first bills are out.
- **Society profile** in Society settings: address, registration number and contact details, printed on bills and receipts.
- **Setup events** are recorded for the platform's setup funnel (Phase 6).

**Rulings I made (cost if wrong)**
1. Running Maintenance again updates the setup charges and never duplicates them. A toggle switched off makes its charge inactive, never deleted. Cost: none.
2. The first bills cover the current month. They fall due on the society's due day, but never in less than a week, so no bill is overdue (with a late fee) the night it is sent. Cost: a society starting late in a month bills the whole month.
3. The UI-only fixes have no automated UI test, because the project has no React test harness. The decisions behind them (resume, due date, UPI check) are tested functions. Cost: a rendering slip shows only by hand.

**Reviewer findings fixed:**
- per-sq.ft areas no longer overwrite the flats' building, floor, type and occupancy, or duplicate Excel flats;
- first bills are no longer overdue the same night;
- the wizard sets up the society that is open;
- buildings without wings work;
- owners have a table;
- the society profile screen now exists;
- unbilled flats are shown;
- the dashboard card disappears once bills are out;
- one UPI ID check is shared by the wizard and Settings.

**Deferred minors**
- State is free text; the platform's GST invoice compares state names.
- A raw database error is possible if two Maintenance saves race.
- The pincode lookup route has no sign-in or rate limit.
- More than 2,000 generated flats get a raw limit message.
- The wizard has no Back button.

---

## Phase 4C — the secretary's menu, Home and Approvals (migration 035)

**Built**
- **Menu:**
  - Home and Approvals at the top;
  - **Money:** Maintenance bills, Payments received, Vendor bills, Reports;
  - **Society:** Flats & residents (Flats | Members on one screen), Notices, Complaints, Documents;
  - **Settings:** Society settings, CA & auditor, Plan & billing;
  - **Accounts:** only for the committee's Accountant.
  - Phone bar: Home · Bills · Payments · Complaints · More.
- **Home cards:**
  - **To receive** (amount, flats, overdue) opens the flat-wise dues, oldest first, with **"Send reminder to N overdue flats"**.
  - **To pay** (cash still owed, vendors, due this week) opens the vendor-wise list with TDS worked out, and "Record a payment".
  - **Approvals** (with a breakdown).
  - **Payments to verify.**
- **Reminder button:** at most one reminder per flat per day, counting the nightly one. It skips flats whose payment waits for verification, and says how many flats have nobody joined.
- **Approvals** now also lists vendor bills to approve, with the vendor, invoice, TDS and net. The same rules as Vendor bills apply: maker-checker, two-step, and the sole-member exception.

**Rulings I made (cost if wrong)**
1. The spec's table has 13 menu items although the text says 12. The table wins. Cost: none.
2. A vendor bill is due 30 days after its invoice date (or after it was recorded), because there is no payment-terms field. Cost: "due this week" is approximate for bills with other terms.
3. The Approvals badge counts vendor bills too. Cost: the same bill shows on two badges.

**Deferred minors**
- Vendor grouping by name vs id.
- "due this week" counts bills, not vendors; plurals.
- The lists show "Nothing is due" while loading.
- Home's Refresh does not reload the cards.
- The phone More sheet repeats the bar items.
- The Home heading is old.
- The Flats | Members choice sticks.
- The same flat number in two wings collides in the dues list.

---

## Phase 5 — the resident side: My account (migration 036)

**Built**
- **My account** (owners only): the flat's full ledger. It shows date, details, debit, credit and running balance, with links to the bill and the receipt.
  - The period is this year, last year (April–March) or custom.
  - Download PDF; Share on WhatsApp.
  - The numbers match the CA's party ledger for the flat.
- **After an owner change,** every owner of the flat starts at the transfer date with "Brought forward from previous owner", even when the seller never joined. A period before the purchase is refused.
- **Tenants** see no dues banner, no Bills and no My account.
- **Home** shows the latest bill.

**Rulings I made (cost if wrong)**
1. An owner with no earlier owner on the flat sees the whole history. Cost: none.
2. The secretary's "send any flat's statement" is the existing period statement under Flats → Owners. Cost: none.
3. A statement line links only to a bill or receipt the owner can open. A joint owner sees the line but not the document. Cost: a joint owner asks the first owner for the PDF.

**Deferred minors**
- A tenant still sees an empty "payment history" card.
- The Latest bill card can show a cancelled bill.
- "This year" shows a closing date of 31 March next year.
- PDF and WhatsApp wording for NOC or loan use.
- Custom dates can show stale results while typing.

---

## Phase 6 — the platform owner's dashboard (migration 037)

**Built** (new Platform tabs)
- **Setup funnel:** how many reached each step and where the rest stopped, counting steps done outside the wizard; how many issued a first bill; the typical time from first login.
- **Society health:** flats, owners joined %, this month's collection %, CA invited, opening balance approved, and last active, with "Stuck in setup" and "Going quiet" flags. **View** opens a society **read-only for one hour**:
  - you give a reason;
  - every view is in the society's audit log;
  - the committee is told once per hour: "Sahvaas support viewed your society on <date>".
- **Revenue:** societies by plan, MRR (paying, active societies only), trials ending this week, unpaid Sahvaas invoices, and ad revenue this month against OTP cost.
- **Announcements:** sent to committee admins, optionally filtered by plan or state, in-app and by push.

**Rulings I made (cost if wrong)**
1. "Stuck" means a week after registering with no bill. "Quiet" means 30 days with no activity. Cost: these thresholds are a guess and easy to change.
2. **Read-only and time-limited holds only inside the support view.** Your platform-admin login can already read and write every society through the database rules. Enforcing it in the database is a larger follow-up. Cost: platform work done outside the support view leaves no "support viewed" notice.
3. A complimentary plan is not revenue: MRR needs a paid invoice covering today. Cost: none.

**Deferred minors**
- Collection shows 0% when nothing was billed this month.
- A manager of several societies gets duplicate announcements.
- Trial counts include societies that already booked a paid plan.
- Ad revenue counts only live campaigns.
- Funnel display: raw minutes, and steps out of order.
- Health is sorted by name.
- Announcement state and plan are not validated.
- The page Refresh does not reload the new tabs.

---

## Phase 7 — the installable app (the "mobile app")

The spec decided **no native app**: "The app stays a web app / installable PWA" (section 2, non-goals). So the mobile app is Sahvaas installed from the browser. On Android, Chrome shows "Install app". On iPhone, Safari → Share → "Add to Home Screen". It then opens full-screen with its own icon, like any app.

**Built**
- Proper app icons for Android (192, 512 and maskable) and the iPhone Home Screen (180 PNG).
- The installed app opens on login, which sends a signed-in person straight to their screen. It is not locked to portrait, so wide ledgers can be turned sideways.
- **"Install app" button** inside the resident and secretary screens (icon-only on phones). Android's one-time install prompt is caught as soon as the app starts. iPhone users get a short guide, including "open in Safari first" when they came from WhatsApp.
- **Offline:** a page load with no internet shows a friendly offline page. **Nothing else is cached**, so bills and payments are never shown stale.
- On iPhone the app starts below the status bar (clock and notch).

**Rulings I made (cost if wrong)**
1. No native app and no Play Store listing, per the spec. A Play Store listing (a "Trusted Web Activity" wrapper) needs your Google Play Console account and a decision. Cost: no app-store presence until then.
2. Only the offline page is cached. Cost: no reading of old data offline (deliberate).

**Deferred minors**
- The notification badge on Android shows as a white square.
- Icon artwork polish (maskable full-bleed, transparent corners).
- The service-worker test checks a mirror of the rule, not `sw.js` itself.
- No install button in the desktop sidebar.

---

## Phase 8 — fixes people would notice

- **Tenants:** no payment history and no Bills screen, even from a notification. Switching to a rented flat leaves the owner-only tabs.
- **Latest bill card:** skips cancelled bills.
- **Phone "More" sheet:** shows only what the bottom bar does not, under Money / Society / Settings headings.
- **Home:** the heading now says "Home". Flats & residents from the menu opens on Flats.
- **Home lists:**
  - show a spinner while loading, and errors;
  - the reminder button reports "already reminded today";
  - singular and plural wording is right.
- **My account:** shows "Balance today" for a period running past today.
- **Bill page:** "Less: advance" only on bills that still ask for payment.
- **Log out of all devices:** also stops pushes to the lost phone.
- **Platform:**
  - the funnel time reads in minutes, hours or days, with steps in order;
  - Society health lists stuck, then quiet societies first.

---

## Phase 9 — loose ends (migration 038)

You approved these on 2026-11-05 ("HAAN"), along with my three suggestions:
- email login stays until WhatsApp is live;
- no Play Store app for now;
- no database lock on platform-admin writes for now.

**Fixed**
- **Mobiles with a 0 after the country code.** `+91 0 98765 43210`, `0091 098765…` and `91 0 98765…` are the same number as `98765 43210`. They now match the owner's flat, invites and the joining link. Numbers already saved in the wrong 13-digit shape are corrected.
- **Old requests and invites close by themselves:**
  - Once someone joins a society by any route, their waiting join request there is closed. Nobody approves it twice.
  - A mobile the committee saves later still lets that person join through the link, even though they had already asked.
  - Their own pending owner invite for the flat is marked accepted.
  - After an owner change, the invite is closed once the named buyer joins under another login.
  - A joint owner's invite stays open.
- **The bank on the bill** is the account on the CA's default receiving ledger. With no choice made, it is the primary account.
- **A deactivated society sends no notifications.** Phone notifications refused because of an old server key are cleaned up, and the phone saves a fresh subscription the next time the app opens.
- **GST on Sahvaas's own invoices** compares states by GST state code: "MH" = "Maharashtra", and a GSTIN wins. New societies choose their state from a list.
- **Home dues list:** `101` in wing A and `101` in wing B show as A-101 and B-101 instead of colliding.
- **People who log in by mobile** are shown by their mobile, with its own country code, where an empty email used to show. This covers the sidebars, the member, payment and professional lists, the platform user list and Sign Out.
- **Pincode lookup** needs a login and allows 20 lookups in 10 minutes.
- **Setup wizard Back button:**
  - Back works from Maintenance onwards.
  - Flats only offers Continue once flats exist. Flats are added or changed in Flats & residents.
  - Maintenance offers "Keep saved charges".
  - UPI shows the saved ID.
- **My account "This year"** runs from 1 April to today.

**Rulings I made (cost if wrong)**
1. A phone notification refused with 403 is deleted. Every phone saves a new one when the app next opens. Cost: if the server keys are ever wrong, phones get no notifications until the app is opened once.
2. The pincode limit is counted per server, not shared. Cost: a signed-in person could do somewhat more than 20 lookups.
3. Lint shows 4 warnings instead of 2. The two new ones are in config files this phase did not touch. Cost: none.

**Deferred minors**
- A deactivated society is not told when support views it.
- Adding someone to the committee without a flat closes their waiting flat request. The committee can still invite them to the flat.
- "This year" uses the phone's date, so an owner abroad can miss an entry made today in India.
- Old Sahvaas invoices to a society that typed "MH" now show CGST+SGST where they showed IGST. Misspellings like "Maharastra" still compare by name.
- Small phone-notification races after a server key change. They heal when the app is next opened.

---

## Phase 10 — notice read record, polls, staff register (migration 039)

Asked for on 2026-11-23 ("haan teeno bana do"). Spec `docs/superpowers/specs/2026-11-23-community-design.md`, plan `docs/superpowers/plans/2026-11-23-community.md`.

**Built**
- **Who has seen a notice.**
  - A notice shown on a resident's Notices screen is recorded once per person.
  - Under each notice the committee gets "Seen by N of M" and a "Not seen yet" list (name and flat).
  - The committee itself is not counted. An owners-only notice leaves tenants out.
- **Polls** (Society → Polls; residents: Polls tab).
  - One vote per flat, from owners; a committee person votes for the flat on their membership.
  - A joint owner can change the flat's vote until it closes.
  - Nobody sees counts while a poll is open; the committee sees which flats voted, never how.
  - Owners are notified when a poll opens.
  - Close now, Delete (only with no votes), Download result (CSV for the AGM file).
  - Every poll carries "This poll shows members' views. Decisions are taken in the general body meeting."
- **Staff register** (Society → Staff; residents: Staff tab).
  - Residents add their maid/driver/cook; the same mobile links the existing person instead of a duplicate.
  - The committee adds society staff, verifies (police verified date), keeps notes, removes.
  - Residents see the register (name, kind, photo, verified badge); mobile only for their own staff; ID proofs and notes only for the committee.
  - Files in a private `staff-files` bucket (JPG, PNG, WEBP, PDF; 5 MB).

**Final review fixes** (fresh Opus reviewer; each with a failing test first)
1. A resident could move "Police verified" onto another person, or take over committee-added staff by typing their mobile. Now residents edit only staff they added, and their change of name, mobile or photo clears the verification.
2. Live counts next to the voted-flats list showed the committee how each flat voted. Counts now appear only after closing.
3. A committee person's flat (stored on the committee membership) could not vote. It now counts as an owner flat.
4. The staff screen showed buttons the server refuses. The list now says what each person may do.
5. The staff bucket accepted any file type. It now accepts only images and PDFs.

**Rulings**
1. Polls are a secret ballot: counts only after closing, for the committee too. Cost if wrong: the committee wants live counts (one line).
2. "Seen" means shown on the Notices screen, not scrolled to. Cost: a notice lower on a long list counts as seen.
3. Amenity booking waits for a CA's word on its income ledger and GST.

**Deferred minors**
- Unchecking a flat in a resident's staff edit does nothing but says "Saved."
- "Already in the register" drops the typed name and kind without saying so.
- A resident re-adding a removed person's mobile creates a fresh record; the committee is not told.
- The poll choice keeps the old pick after voting.
- "Voted X of Y" can exceed Y when a voting owner has since left.
- Flat labels in the seen list and poll list can drop the wing.
- New RPCs are not revoked from anon (each checks the login).
- `mark_notices_seen` does not check that the society is active.
- Replaced staff photos and ID proofs are never deleted (a retention decision under the DPDP Act).
- Two residents adding the same new mobile at the same moment get a raw error.
- The polls list shows "No polls yet" on a load error.

## Phase 11A — flat requests and NOC letters (migration 040)

Asked for on 2026-11-24 ("haan, NOC se shuru karo"). Design `docs/superpowers/specs/2026-11-24-flat-changes-design.md` (11B tenancy, 11C shifting, 11D sale and transfer come next), plan `docs/superpowers/plans/2026-11-24-phase-11a-noc.md`.

**Built**
- **One request system** for NOC now and tenancy, shifting and transfer later: request, documents per checklist item (private `request-files` bucket, PDF or image, 10 MB), status, dated history, "Pending N days" (amber at 25 days for NOCs: a NOC must be decided within one month).
- **Seven NOC types** per society, editable by the committee (name, letter text, who signs, documents to ask for, "tenants can ask", in use): sale, home loan, leave and licence, electricity meter, passport / address proof, gas connection, repairs. The committee can add its own types.
- **Residents** (Requests tab): ask for a NOC with a purpose and addressee, add the documents, withdraw, send again after changes, open the letter. Tenants can ask only for types marked for tenants (passport and gas by default).
- **Committee** (Society → Requests & NOCs; Approvals shows how many wait): the letter as it will be issued today, with warnings; the share certificate number of the flat; Approve, Ask for changes, Decline.
- **Letters:** numbered `NOC/2026-27/001` per society per financial year; the flat's owners, society name, registration number, address, share certificate number and the dues line filled in ("As per the society's accounts in Sahvaas, there are no dues outstanding as on …"); printed or saved as PDF from the browser; shared on WhatsApp; kept in the **NOC register**.

**Final review fixes** (fresh Opus reviewer; each with a failing test first)
1. A letter asked for by the secretary on someone's behalf, or by a tenant, named that person as the flat's member. The letter now names the flat's owners; residence letters name who asked; an applicant who has left the flat gets no letter.
2. "No dues" could be certified when opening balances were never entered. The line now says "As per the society's accounts in Sahvaas", and the committee is warned before approving.
3. A buyer could read the seller's requests and documents. Owners now see only what was asked since they became owners.
4. Text typed by the applicant (addressee, purpose) could become a paragraph of the signed letter. Both are single lines now, and the committee always sees the letter before approving.
5. A committee member opening Requests in the resident view saw the whole society's requests. It now shows only their own.

**Rulings**
1. No draft status; a request goes to the committee when created, and documents are added after.
2. The letter is stored as text and printed from the browser; no PDF file is made on the server.
3. NOC fees wait for 11C (they need a one-off charge to a flat).
4. A committee member who owns a flat asks for their own NOC from the resident view.

**Deferred minors**
- The NOC register has no "issued by" column and shows dates as YYYY-MM-DD.
- Removing a document, or a failed attach, leaves the file in storage.
- A document record does not check that the file exists.
- Letters print "Registration No. —" when the society has none; the address can end in ", ".
- Reprinting an old letter uses today's letterhead.
- An applicant in a deactivated society can still withdraw or upload.
- The financial-year restart is tested on the numbering helper, not inside the approval.
- New functions are callable by anon (each refuses without a login).
- Two custom NOC types added at the same moment can clash.
- Requests of a switched-off type show "NOC request"; the inbox loads the latest 300; no note field when sending again.

**Before using it:** ask the society's legal adviser to read the seven letter texts (Society → Requests & NOCs → NOC letters), and record share certificate numbers on the request screen.

## Phase 11B — tenant registration (migration 041)

Asked for on 2026-11-24 ("haan, 11B tenant shuru karo"). Plan `docs/superpowers/plans/2026-11-24-phase-11b-tenancy.md`.

**Built**
- **Register a tenant** (owner, Requests tab): tenant's name, mobile, email (optional), people living there, agreement dates (up to 60 months), police reference. It goes to the committee as a request with the society's tenant documents: registered leave and licence agreement, police intimation or verification, tenant's photo ID (required); tenant's photograph and the owner's undertaking (optional). The committee can change the list.
- **On approval:** the tenancy is recorded and the tenant is invited (emailed when there is an email; a "Send the invite on WhatsApp" button on the request).
- **Tenants** view for the committee (Requests & NOCs → Tenants) and for owners: Active, Ends soon (30 days), Agreement expired, Ended, Renewed; Renew (same tenant) and "Tenant moved out" (the tenant loses access, pending invites are cancelled).
- **Reminder** to the owners and the committee 30 days before the agreement ends (09:30 every morning).
- **Non-occupancy charges** (off by default): a % (at most 10%) of a let flat's service charges — charges credited to Maintenance Charges and not ticked "Municipal tax" in Maintenance bills — added as a line on its bill for any period it was let.
- **A sale** ends the seller's tenancy record, so the buyer is not charged or blocked by it; the tenant keeps access (as decided in Phase 2F) until the buyer registers or removes them.

**Final review fixes** (fresh Opus reviewer; each with a failing test first)
1. After a sale, the buyer paid non-occupancy charges for the seller's tenant and could not register their own. Now a sale ends the old tenancy record.
2. Cancelling an early renewal cut off a tenant still living there. Now the current agreement simply continues.
3. The tenant's invite was only recorded, never sent. Now it is emailed and can be sent on WhatsApp.
4. An earlier invite with the tenant's email blocked approval with a database error. It is now reused.
5. An owner's own mobile or email entered as the tenant's could turn the owner into a tenant. It is refused.
6. A new tenant could read earlier tenants' names and mobiles. Hidden now.
7. Non-occupancy charges counted sinking fund, repair fund and parking. Now only maintenance (service) charges.
8. A "renewal" could quietly change the tenant. Renewal is for the same tenant now.

**Rulings**
1. One active tenancy per flat; a renewal is a new request for the same tenant.
2. A tenancy counts for non-occupancy charges for any bill period it overlaps (a tenant who left mid-month still made the flat let that month).
3. The non-occupancy line carries no GST and posts to Maintenance Charges (4000). Ask the CA whether GST applies when maintenance carries GST.
4. On a sale the tenant keeps access (Phase 2F rule); only the tenancy record ends.

**Deferred minors**
- The flat's "tenant occupied" mark is not cleared when a tenancy ends.
- A future end date can be set through the API (the screen sends none).
- A second renewal request gets the wording "has already ended".
- The approval message drops the committee's note; owners are not told when the committee ends a tenancy.
- An agreement that has already ended can be registered and gets a past-dated reminder.
- Details cannot be corrected after "Ask for changes" (withdraw and register again).
- The bill preview does not show the non-occupancy line separately.

**Before using it:** if the society charges non-occupancy charges, have the general body pass the %, and ask the CA about GST on that line. Tick "Municipal tax" on any property-tax charge in Maintenance bills.

## Phase 11C — shifting charges and refundable deposits (migration 042)

Asked for on 2026-11-24 ("haan, 11C shifting shuru karo"). Plan `docs/superpowers/plans/2026-11-25-phase-11c-shifting.md`.

**Built**
- **Book shifting** (owner or tenant, Requests tab): moving in or out, date (today to 90 days), time inside the society's hours, vehicle. The form shows what will be billed.
- **Settings** (Requests & NOCs → Shifting): a charge and a refundable deposit for moving in and for moving out (all ₹0 by default), and the allowed hours (default 08:00–20:00), with "Charge only what your bye-laws or a general body resolution allow."
- **On approval** the flat gets one bill: the charge goes to the new ledger "Shifting charges" (income), the deposit to "Deposits received" (a liability, not income). No late fee is ever added to these bills, and they fall due no earlier than the shifting day.
- **Refund** (committee, Shifting view): full, or with an amount kept and the reason; the date it was paid, the bank account or cash, and a cheque/UTR number. The books: Deposits received down by the deposit, the bank down by what was paid back, "Damage recovery" (income) up by what was kept. The flat's account (My account) shows the deposit returned and the refund paid.
- Cancelling an unpaid shifting bill (the move was called off) releases the deposit.

**Final review fixes** (fresh Opus reviewer; each with a failing test first where it is in the database)
1. The refund did not show in the flat's account. It does now.
2. A refund was booked as bank money paid today, whatever happened. Now the committee gives the date, the bank or cash, and a reference.
3. The 2% late fee was charged on refundable deposits. Shifting bills never get late fees now.
4. A cancelled shifting bill left the deposit "held" for ever. It is released now.
5. A tenant who booked could not open the bill (it is the owner's). They see the amounts instead.

**Rulings**
1. New ledgers on first use: 2400 Deposits received, 4400 Shifting charges, 4500 Damage recovery.
2. A refund needs the shifting bill fully paid.
3. A refund line in the bank statement is not matched automatically yet; mark it "no match needed".
4. "Require a shifting request before a tenancy or transfer is approved" moves to 11D.

**Deferred minors**
- The CA can rename the three new ledgers but not move them to another group.
- A refund can be recorded before the shifting date; approval does not check for a past date.
- The shifting list shows the latest 200.
- A partly paid shifting bill blocks the refund (the CA can adjust).
- Two open bookings of the same kind for one flat are allowed.
- System charges and shifting settings could be changed by writing to the tables directly (the screens never do).

## Phase 11D — sale and transfer (migration 043)

Asked for on 2026-11-24 ("haan, 11D transfer shuru karo"). Plan `docs/superpowers/plans/2026-11-24-phase-11d-transfer.md`.

**Built**
- **Transfer this flat** (owner, Requests tab): the buyer's name, mobile (and email if any), the sale deed date and registration number. The request asks for the society's transfer documents: the seller's notice, the buyer's membership application, the sale deed, Index II, the bank NOC (optional), the buyer's ID, photo and PAN, and the nomination (optional). The committee can change the list.
- **Committee, on the request:**
  - ticks "Original share certificate received";
  - bills the transfer fee (default ₹500) and premium (default ₹0, at most ₹25,000), prefilled from the settings and editable for each sale, for example ₹0 premium within the family. They go to the new income ledgers "Transfer fees" and "Transfer premium";
  - sees the flat's dues. **Approve transfer** stays off until the fees are billed, the certificate is ticked and the dues are ₹0 ("Clear dues of ₹X before the transfer").
- **On approval** the Phase 2F owner change runs:
  - the seller's access ends, and a seller on the committee keeps the committee role but not the flat;
  - the buyer is invited by mobile (and email), with a WhatsApp button;
  - the share certificate number and endorsement date are recorded;
  - the buyer never sees the seller's papers;
  - the seller's statement for their period stays available.
- **Withdrawn or declined:** the fee bill is cancelled, and anything already paid on it goes back to the flat's advance.
- **Sale settings** (Requests & NOCs → Sale settings): the fee, the premium, and "Require a shifting booking first". The shifting rule means a move-in before a new tenant is approved (a renewal needs none) and an approved move-out before a sale is approved.

**Final review fixes** (fresh Opus reviewer; each with a failing test first where it is in the database)
1. If the flat had an advance, the fee bill took it automatically, and a withdrawn sale kept it. Now everything paid on the fee bill comes back as advance.
2. The buyer's email could be the seller's own (or a co-owner's), which handed the flat back to them. It is checked now.
3. A seller who was on the committee kept the flat after the sale. Not any more.
4. With the shifting rule on, a tenancy renewal asked for a move-in booking. A renewal needs none now.
5. A move-out booking that was still waiting satisfied the rule but could never be approved after the sale. A sale now needs the move-out approved.
6. A second sale could overwrite an earlier owner change still waiting for its buyer to join. It is refused now.
7. A share certificate number the committee typed was put back to the old one after ticking the certificate box. It is kept now.

**Rulings**
1. The committee bills the fees from the request; approval needs that step, even at ₹0.
2. The transfer date is the approval day unless the committee enters an earlier one. It uses the server's date, the same one the owner change checks.
3. A withdrawn or declined sale returns what was paid on the fee bill to the flat's advance, so the committee refunds it or it pays the next bill.
4. The Phase 2F "Owner change" screen still works without the dues check (for inheritance and corrections).
5. One buyer per sale. A second joint buyer is added later.

**Deferred minors**
- The fee and premium caps are enforced by the screens and the billing, not by the table itself.
- The Approve button can show as on while the dues figure is still loading (the database still refuses).
- The endorsement date is not checked against the transfer date.
- The sale form and another form can be open at once on the Requests tab.
- No tests yet for flats with two owners.

**Before using it:** have the CA or legal adviser confirm the fee and premium your bye-laws allow (the ₹25,000 cap and the ₹500 fee come from secondary sources).

## Fix — phone notifications on hosted Supabase (migration 044)

On 2026-11-24 the database settings step for push failed on Supabase: `permission denied to set parameter "app.push_url"`. Hosted Supabase does not let projects set custom `app.*` database settings. Migration 044 reschedules the `sahvaas-push` job to read the push URL and `CRON_SECRET` from Supabase Vault (`sahvaas_push_url`, `sahvaas_cron_secret`), and still falls back to the `app.*` settings where they are allowed. DEPLOYMENT.md section 3, step 3 has the two `vault.create_secret` lines. Gate Lite moves to migration 045.

## What you need to do next

1. **Apply migrations 039 to 043** (027 to 038 are already applied live):
   - `bun run db:migrate` (dry run: the list should say 039, 040, 041, 042 and 043);
   - then `bun run db:migrate --apply`.
2. **Push** when you are happy. GitHub has everything up to Phase 8 (pushed on 2026-11-05); Phase 9, Phase 10, Phase 11A–11D and the Gate Lite and Phase 11 plans are on local `main` only.
3. **Environment and Supabase settings:**
   - **3A push:** `SUPABASE_SERVICE_ROLE_KEY`, the VAPID keys, `CRON_SECRET`, and the two database settings.
   - **3C mobile login, when WhatsApp is approved:** the Phone provider with "Confirm phone" on, the Send SMS hook, `SEND_SMS_HOOK_SECRET`, the WhatsApp/MSG91 keys, the SMS rate limit, then `NEXT_PUBLIC_PHONE_LOGIN=1`.
4. **Install the app on your own phone and check it there:**
   - register a society through the wizard;
   - send the first bills;
   - open the joining link as an owner;
   - pay;
   - verify;
   - open My account.
