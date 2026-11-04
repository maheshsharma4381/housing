# Phase 3C — Mobile + WhatsApp OTP login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People log in with their mobile number and a one-time code sent on WhatsApp (SMS as the Indian backup). Sends are limited and costed, and the platform owner watches the cost.

**Architecture:**
- Supabase phone auth sends the code. Supabase's **Send SMS hook** (HTTP) points at our route `/api/auth/sms-hook`. That route:
  1. verifies the Standard Webhooks signature;
  2. asks the database whether this number may get a code (`otp_claim`: blocked, 60-second resend, per-number daily limit, platform daily cap);
  3. sends the code on WhatsApp (Cloud API, an authentication template), falling back to SMS (MSG91) for Indian numbers;
  4. records the result and its cost (`otp_result`).
- Without a provider, a development-only console sender prints the code.
- Email login stays as a fallback until the product owner turns it off, because WhatsApp Business approval is still pending (spec 14).

**Tech Stack:** Next.js 15 route handlers (Node runtime), Supabase Auth phone OTP, plpgsql, PGlite tests, node:test.

**Spec:** `docs/superpowers/specs/2026-10-31-sahvaas-simplify-design.md`, sections 8.1, 11 item 1, 12 call 5 and 11, 14.

## Global Constraints
- At most 5 OTPs per number per day; resend after 60 seconds (8.1).
- Unknown numbers (self-serve signup, joining link): 3 OTPs per number per day plus a platform-wide daily cap (8.1).
- Foreign numbers: WhatsApp only, no SMS fallback; their cost is counted separately (8.1).
- Platform dashboard: OTPs and estimated cost per society and platform-wide, split WhatsApp / SMS / foreign; an alert when a society passes 5 OTPs per flat per year; edit the cap and limits; block and unblock a number (11 item 1).
- "Log out of all devices"; removing a member ends their access even with a live session (8.1).
- The middleware refreshes the session server-side (8.1, iPhone).
- Costs, before GST: WhatsApp authentication ≈ ₹0.115; SMS ≈ ₹0.15–0.25 (3).
- The app UI is English only. Secrets come only from env; `.env.example` holds placeholders only.

## Review Focus
1. A phone-only Supabase user (no email) must get a profile. Today `profiles.email` is NOT NULL, so `handle_new_user` would fail and break every phone signup.
2. A forged hook call (bad or missing signature, or a stale timestamp) must be refused before any send.
3. A refused number must get a clear message, and the refusal must not count toward its limit.
4. Invites keyed by mobile must be visible only to a login whose phone is **confirmed**.
5. Codes must never reach production logs. The console sender refuses to run when `NODE_ENV=production`.

---

### Task 1: Database (migration 032)

**Files:** Create `src/db/migrations/032_mobile_login.sql`, `tests/db/mobile-login.test.mjs`. Modify `tests/db/harness.mjs`: add `phone_confirmed_at TIMESTAMPTZ` to the `auth.users` stub.

**Interfaces:**
- **Profiles.** `profiles.email` becomes nullable. `handle_new_user()` sets full_name to `coalesce(meta full_name, split_part(email,'@',1), 'Member')` and stores the phone.
- **Invites by mobile.**
  - `member_invites.email` becomes nullable and gains a `mobile` column. `professional_invites.invited_email` becomes nullable and gains `invited_mobile`. Both tables get a CHECK that the email or the mobile is present.
  - `my_pending_invites()` and `respond_to_invite()` (both from 012) match the verified email **or** `current_verified_phone()` (from 031). When the login has neither: 'Verify your email or mobile before responding to invitations'.
  - `transfer_flat_owner` (from 031) needs the new owner's email **or** mobile.
- **Flats by phone.** `claim_my_flats() RETURNS JSONB` returns `[{society_name, flat}]`. It runs `attach_flats_by_phone(NULL, auth.uid(), current_verified_phone())` across all active societies.
- **OTP tables.**
  - `otp_settings`, a single row with id 1: per_number_daily 5, unknown_per_number_daily 3, platform_daily_cap 2000, resend_seconds 60, cost_whatsapp 0.115, cost_sms 0.20, cost_foreign 0.80.
  - `otp_blocked_numbers(mobile PK, reason, blocked_by, created_at)`.
  - `otp_log(id, mobile, society_id NULL, known, foreign_number, status claimed|sent|failed|refused, channel whatsapp|sms|console NULL, reason, cost, created_at)`.
  - RLS: only the platform admin can select from these tables.
- **`otp_claim(p_phone TEXT) RETURNS JSONB {allowed, reason, log_id, foreign}`.** Service role only.
  - A number is **known** when its normalized form matches any of:
    - `units.owner_mobile`;
    - the mobile of an open `unit_ownerships` period;
    - the mobile on a pending invite (member or professional);
    - an auth user with an active membership, an active professional grant, or platform admin.
  - Refusals are recorded with status refused, which does not count toward any limit. The messages are:
    - 'Enter a valid mobile number'
    - 'This mobile number is blocked — contact Sahvaas support'
    - 'Wait a minute before asking for another code'
    - 'Too many codes for this number today — try again tomorrow'
    - 'Mobile login is busy right now — try again later'
  - Limits count rows with status `claimed` or `sent` in the last 24 hours.
- **`otp_result(p_log_id UUID, p_channel TEXT, p_ok BOOLEAN, p_error TEXT)`.** Service role only. It sets the status to sent or failed, the channel, and the cost: WhatsApp on a foreign number is cost_foreign; console is 0.
- **Platform functions.** Each requires the platform admin, with the message 'Only the platform owner can see OTP costs'.
  - `otp_overview(p_days INT DEFAULT 30) RETURNS JSONB` returns:
    - totals: whatsapp, sms, foreign, refused, cost;
    - societies: name, flats, sent, cost, sent_year, alert = sent_year > 5 × flats;
    - settings;
    - blocked.
  - `set_otp_settings(p JSONB)`.
  - `block_mobile(p_mobile, p_reason)`.
  - `unblock_mobile(p_mobile)`.

- [ ] Write the tests (RED):
  - a phone-only auth user gets a profile named 'Member';
  - a mobile-only invite is seen and accepted by a confirmed phone and not by an unconfirmed one;
  - claim_my_flats attaches the owner's flat;
  - otp_claim covers: known 5 a day, unknown 3 a day, the resend window, a blocked number, the platform cap, and refusals not counting;
  - otp_result sets the cost;
  - the overview alert fires;
  - a non-admin is refused;
  - authenticated users cannot call otp_claim.
- [ ] Implement 032 → GREEN. Run onboarding, owner-change, joining-link, rls and consolidated one at a time.
- [ ] Commit `feat(login): mobile OTP limits, costs and invites by mobile`.

### Task 2: The Send SMS hook

**Files:** Create:
- `src/lib/otp/webhook.ts`: `verifyWebhook(secret, headers, body, nowSeconds) → boolean`. The secret is `v1,whsec_<base64>`. The signature is `v1,<base64 HMAC-SHA256(key, id.timestamp.body)>`; several may be space-separated. Timestamps more than 5 minutes off are refused.
- `src/lib/otp/senders.ts`: pure request builders `whatsappRequest(cfg, to, code)` and `msg91Request(cfg, to, code)`, plus `otpConfig(env)` → `{provider: 'whatsapp'|'console'|'none', ...}`.
- `src/app/api/auth/sms-hook/route.ts`.
- `tests/unit/otp-webhook.test.ts`, `tests/unit/otp-senders.test.ts`.

**Behaviour:**
- **Signature.** A bad signature → 401 `{error:{http_code:401,message:'Bad signature'}}`.
- **Claim.** `otp_claim` refused → 429 with the reason as the message, which Supabase shows to the person.
- **WhatsApp.** The template carries the code as the body parameter and the copy-code URL button parameter. If it fails on an Indian number and MSG91 is configured, send by SMS. A foreign number gets WhatsApp only.
- **Console.** Only when `NODE_ENV !== 'production'`. It logs `[otp] <masked phone> <code>`.
- **No provider in production.** 503 'Mobile login is not set up yet'.
- **Env vars**, as placeholders in `.env.example`:
  - `SEND_SMS_HOOK_SECRET`
  - `OTP_PROVIDER`
  - `WHATSAPP_TOKEN`
  - `WHATSAPP_PHONE_NUMBER_ID`
  - `WHATSAPP_TEMPLATE_NAME`
  - `WHATSAPP_TEMPLATE_LANG`
  - `MSG91_AUTH_KEY`
  - `MSG91_TEMPLATE_ID`
  - `NEXT_PUBLIC_PHONE_LOGIN`

- [ ] Unit tests (RED) → implement → GREEN → commit `feat(login): Send SMS hook for WhatsApp and SMS codes`.

### Task 3: Login screens, devices, session

**Files:**
- Create `src/components/MobileOtpLogin.tsx` and `src/lib/phone-login.ts` (`toE164(input) → '+<digits>' | null`, `resendWait(lastSentMs, nowMs) → seconds`), with `tests/unit/phone-login.test.ts`.
- Modify:
  - `src/context/AuthContext.tsx`: `sendOtp`, `verifyOtp`, `logoutEverywhere`, and `claim_my_flats` after login;
  - `LoginPage`, `SignupPage`;
  - `src/middleware.ts`;
  - the four dashboards' logout areas;
  - the `MembersTab` invite form (a Mobile field; Email becomes optional when a mobile is given);
  - `OwnerChange` (email optional).

**Copy:**
- "Your mobile number"
- "Send code on WhatsApp"
- "Enter the 6-digit code"
- "Resend code in {n}s" / "Resend code"
- "Use email instead"
- "Log out of all devices"

**Rules:**
- The mobile form shows when `NEXT_PUBLIC_PHONE_LOGIN=1`; email stays behind "Use email instead".
- The middleware calls `getUser()` on every matched request, so the server refreshes the cookies, and redirects only on the protected prefixes.

- [ ] Unit tests (RED) → GREEN; typecheck, lint, build → commit `feat(login): log in with mobile and a WhatsApp code; log out of all devices`.

### Task 4: Platform "OTP & cost"

**Files:** Create `src/components/platform/OtpCosts.tsx`. Modify `src/views/platform/PlatformDashboardPage.tsx`, adding the tab "OTP & cost".

**Shows:**
- the totals for the last 30 days by channel, with the cost;
- a table of societies (flats, sent, cost, sent in the last year) with a red "Over 5 per flat a year" chip;
- the settings form;
- the blocked numbers, with block and unblock.

- [ ] Build; the full suite one file at a time; `bunx next build` → commit `feat(platform): OTP counts, costs, limits and blocked numbers`.
