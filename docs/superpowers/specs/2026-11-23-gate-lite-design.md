# Gate Lite: a visitor register for the society gate

Date: 2026-11-23
Status: design, awaiting the product owner's approval
Build window: January 2027, after the first pilot societies are live (product owner's call, 2026-11-23), and only once mobile login is switched on (section 3)

## 1. Intent

Sahvaas is an accounts-first society app: residents open it about once a month, to see and pay their bill. MyGate's strength is that the guard uses its app at every visitor, so residents open it every day. A full gate app (in-app approve/deny, delivery pre-approval, staff attendance, real-time calls) is months of work and a head-on fight with MyGate and NoBrokerHood. Gate Lite is the small version that small and mid-sized societies (20–150 flats, one or two watchmen, a paper register today) can use from day one:

- the guard writes each visitor into the phone instead of the paper register;
- the guard calls the flat from the same screen, as they do today on the intercom;
- the people living in the flat see who came;
- the committee gets a register it can search and download.

The society supplies the gate phone; Sahvaas supplies the app (product owner, 2026-11-23). Gate Lite also tests whether societies want gate features at all before anything bigger is built.

## 2. Goals, non-goals, anti-goals

**Goals**
1. A guard records a visitor in under 20 seconds: flat, name, purpose, optional photo, Save.
2. After saving, one tap calls the flat.
3. The people living in the flat get an inbox notification (and a push, when push is set up) for every entry to their flat.
4. The committee sees the whole register, filters by date and flat, and downloads it for Excel.
5. A guard changing shift or leaving the job needs nothing from the secretary.

**Non-goals (this round)**
- Approve/deny inside the app, delivery pre-approval, visitor passes or QR codes.
- Daily staff (maid, driver) attendance, vehicle registry, parcel log.
- Calls placed by the server (IVR) or instant (sub-second) push. Push stays the existing job (it may arrive up to 5 minutes later); the phone call is the real-time channel.
- Hindi or Marathi. The app stays English-only (spec 2026-10-31, section 2). The gate screen uses large text and icons so a guard with little English can follow it.
- A native app. The gate screen is a page of the installable PWA.

**Anti-goals (a failure even if it works)**
- The gate account can read anything other than what the gate screen needs: no bills, dues, ledgers, notices, documents, members list or other residents' visitor history.
- A resident sees visitors of another flat.
- The guard needs a login of their own, or the secretary has to do something every time a guard changes.
- Visitor photos are kept forever.
- Anything on the gate screen depends on the push job to work.

## 3. Constraints

- Stack and rules as in the main spec: Next.js 15, React 19, Tailwind v4, Supabase Postgres with RLS, business rules in plpgsql `SECURITY DEFINER` functions, new migration `040_gate_lite.sql`, PGlite DB tests, `bun run db:bundle`.
- `has_society_membership()` grants read access to about 20 tables to any active `society_memberships` row. Anything added to `society_memberships` inherits that.
- Email login is email + password; mobile login is a WhatsApp (or SMS) code and is switched on only when `NEXT_PUBLIC_PHONE_LOGIN=1` (WhatsApp approval pending). **Gate accounts log in by mobile code only** (builder's call, section 5.1), so Gate Lite ships only after mobile login is live. A shared email password would stay with every guard who leaves, against goal 5.
- Push is payload-free and sent by the pg_cron job every few minutes (Phase 3A).
- Gate phones are mostly cheap Android phones; the page must work on a 5-inch screen, on a slow connection, and stay logged in for weeks.
- Plans: Free and Basic differ only in ads. Gate Lite is on every plan, Free included; the gate screen never shows ads.

## 4. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **1 (chosen)** | **One shared "gate account" per gate, in its own table.** The secretary adds the gate phone by its mobile number or an email. The account is a row in a new `gate_accounts` table, not in `society_memberships`, and reaches data only through gate RPCs. The guard on duty types their name once per shift. | Nothing in the existing RLS can leak to the gate (default deny). Guards come and go without the secretary. Cost: a small separate invite-and-claim path and a fourth kind of landing page. Entries name the guard by typed name, not by a verified login. |
| 2 | A new role `gate` in `society_memberships`, reusing member invites and routing. | Least new code, but the gate inherits every "any member" read policy (about 20 tables, including notices and flats); each needs an exception, and every future policy must remember it. One missed exception breaks the first anti-goal. |
| 3 | One login per guard. | Who made each entry is verified. But guards change often and rarely have a phone of their own at the gate; the secretary would invite and remove people every month, against goal 5. |

Also dropped: a pairing code with Supabase anonymous sign-in. It needs no email or mobile, but turning on anonymous users makes every RPC open to `authenticated` reachable by anyone, which means auditing all of them.

Approach 1 is the builder's call on behalf of the product owner ("u decide"), recorded here so it can be overruled.

## 5. What gets built

### 5.1 Setting up the gate (secretary)

- Society settings get a **Gate** section: "Gate phones". Each gate account has a label ("Main gate", "Back gate") and the **mobile number of the SIM in the gate phone**; at most 5 per society. No email gate accounts.
- Adding one creates a pending gate account. When that number logs in by mobile code, the account is claimed automatically (no Accept step), matched with `normalize_mobile` against the confirmed login phone. Pending gate numbers count as known numbers for the OTP check, so the gate phone can get a code.
- If the gate phone is logged out, the code arrives on the gate phone itself, so the guard on duty logs back in without the secretary and no guard ever holds a password.
- **A gate number is gate-only.** `add_gate_account` refuses a number that already belongs to a Sahvaas login with any membership, professional access or platform role, or that matches a flat's owner contact or an owner/tenant on record in this society ("This number belongs to a resident or committee member. Use the gate phone's own SIM."). A login that holds a gate account cannot claim flats, accept member invites or join by link (those paths skip or refuse it), so the gate phone never gains resident or committee access.
- The secretary can switch a gate account off; it then stops working at once (every gate RPC checks `is_active`).
- Committee roles that can manage members (`society_admin`, `secretary`, `chairman`, `treasurer`) manage gate accounts.

### 5.2 The gate screen (`/gate`)

A login that holds an active gate account lands on `/gate` and can open nothing else (section 5.1 keeps gate logins gate-only).

1. **On duty:** the first time on a device, and whenever the guard taps the name bar: "Who is on duty?" with a text field. Kept on the device. Every entry stores this name.
2. **New visitor:**
   - **Flat:** a search box over the society's flats, showing wing-aware labels (`flatLabels`), plus "Society office" for visitors to no flat;
   - **Name** (required, 1–80 characters);
   - **Purpose:** one tap on Guest, Delivery, Cab, Service, Other;
   - **Mobile** (optional), **Vehicle number** (optional);
   - **Photo** (optional): opens the camera; the page shrinks it to at most 1280 px and about 200 KB before upload;
   - **Save entry**.
3. **After saving:** "Entry saved" and one **Call** button per person living in the flat (name shown, the button opens the dialer through `tel:`). With nobody to call: "No phone number for this flat".
4. **Inside now:** entries of the last 24 hours without an exit, newest first, each with **Exit**. Older entries are not shown to the gate.
5. If the gate account is switched off, the screen says "This gate phone has been switched off by the society" and offers Log out.

### 5.3 Who "lives in the flat"

**The household** of a flat is its active tenant memberships if there is at least one; otherwise its active owner memberships. An owner who has let the flat is not part of the household.

- **Notifications** (5.4) and the **Visitors tab** (5.5) go to the household only, and each person sees only entries made on or after the day their membership started (`joined_date`), so a new occupant never sees the previous occupant's visitors.
- **Call buttons** dial, in order:
  1. each household member's number: the confirmed login phone, else the phone on their profile;
  2. if no household member has a number: the flat's current owners (joined owners' numbers as above, then the owner contact mobile the committee saved for the flat), labelled "Owner".
  This keeps one tap working for flats whose people have not joined yet, the way the paper register's phone list does today.

### 5.4 Notifications

Each entry to a flat calls `notify_users` for the people living there: kind `visitor`, title "Visitor at the gate: {name}", body the purpose (and "Delivery" etc.), link `visitors`. Entries to "Society office" notify nobody. Exit sends nothing.

### 5.5 Resident screen

The resident portal gets **Visitors**: entries to the flat(s) where the person is in the household (5.3), made since they joined, for the last 30 days, newest first: date and time, name, purpose, photo thumbnail (opens larger), entered and exited times. A tenant sees this tab too (visitors are about who lives there, not about money).

### 5.6 Committee register

The society portal gets **Visitors** under Society: all entries, filters for date range (default this month) and flat, the photo on tap, and **Download** (CSV through `toCsv`/`downloadCsv`, opening in Excel): date, time in, time out, flat, visitor, mobile, purpose, vehicle, guard on duty, gate. Committee members (read-only role) see it too.

### 5.7 Keeping data

- Photos are deleted 90 days after the entry (daily pg_cron job); the entry row stays and shows "Photo removed after 90 days".
- Entries are kept for 2 years, then deleted by the same job.
- Photos live in a new private bucket `gate-photos` at `{society_id}/{yyyy-mm}/{entry_id}.jpg`. The gate account may upload only into its own society's folder; reading a photo goes through signed URLs created by an RPC that checks the same rules as the entry (committee: any; resident: household entries since joining; gate: last 24 hours).

## 6. Data model (migration 040)

- `gate_accounts`: id, society_id, label, mobile (normalized), user_id (null until claimed), is_active, created_by, created_at, claimed_at. A mobile number is a gate account in at most one society at a time.
- `gate_entries`: id, society_id, unit_id (null = society office), visitor_name, visitor_mobile, purpose (`guest|delivery|cab|service|other`), vehicle_number, photo_path, guard_name, gate_account_id, entered_at, exited_at, photo_removed_at.
- RLS on both tables with no policy for the gate account; committee read on `gate_entries` through `is_committee_viewer`; resident read of household rows since joining (5.3). All gate actions go through RPCs: `my_gate_account()`, `gate_flats()`, `gate_log_entry(...)`, `gate_flat_contacts(entry_id)`, `gate_inside_now()`, `gate_mark_exit(entry_id)`, `gate_photo_url(entry_id)`; secretary actions: `add_gate_account`, `set_gate_account_active`.
- `notifications.link` gains the value `visitors` for both portals (`societyTabFor` and the resident equivalent).

## 7. Left to the builder

- Exact screen layout and icons, within "big targets, little text".
- Whether the gate landing check lives in `AuthContext.getRedirectPath` or `ProtectedRoute` (a new portal kind `gate` is expected).
- Image shrinking method (canvas is fine).
- Whether `Call` buttons come back with the save response or from a second RPC.
- "Inside now" lists every open entry of the society for the last 24 hours, whichever gate made it.
- Entries cannot be edited in this round; a wrong entry gets an Exit and a new entry.
- Switching a gate account off needs no session revoke: every gate RPC checks `is_active`.

## 8. Success, after one month in pilot societies

- The guard records at least 70% of visitors in the app instead of the paper register.
- Residents in those societies open the app on at least 3 days a week.
- At least one committee downloads the register.

If guards go back to the paper register, the next step is to ask why before building more gate features.
