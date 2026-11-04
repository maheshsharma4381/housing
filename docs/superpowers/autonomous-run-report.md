# Autonomous run report (Phases 3–6)

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
