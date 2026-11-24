# Sahvaas — Go-Live Checklist

Production setup for **Vercel (Next.js) + Supabase**. Do the steps in order; each has a check.
Sections 1–5 are for a new project. To update a project that is already live, see **section 6**.

---

## 1. Supabase project

1. Create a project in region **ap-south-1 (Mumbai)**, so data stays in India and latency is low.
2. **Run the migrations.** Put the *Session pooler* URI (Project Settings → Database → Connection string) in `.env.local` as `SUPABASE_DB_URL`. Never commit it, and never put it in Vercel. Then run:
   ```bash
   bun run db:migrate            # dry run: lists every pending file (001 … 044)
   bun run db:migrate --apply    # applies them in order, one transaction each
   ```
   - Applied files are recorded in `public._sahvaas_migrations`, so the next run applies only new files.
   - Instead of the script, you can paste `src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql` into the SQL Editor once. After that, mark it as applied with `node scripts/db-migrate.mjs --baseline 044` so later runs skip those files.
   - **Never re-run an old numbered file on a live database.** Later files redefine functions, and an old file would put back the old version.
   - ✅ Check, in the Table editor: `societies`, `bills`, `ledger_entries`, `flat_requests`, `tenancies` and `shiftings` exist.
   - ✅ Check, in Storage: four private buckets, `society-files`, `ad-creatives`, `staff-files` and `request-files`.
3. **Scheduled jobs.** The migrations turn on `pg_cron` (and `pg_net`) and schedule five jobs. Check with `select jobname, schedule from cron.job order by 1;`. Times are UTC.

   | Job | Schedule (UTC) | What it does |
   |---|---|---|
   | `sahvaas-dues-reminders` | `30 3 * * *` (09:00 IST) | reminds flats with unpaid bills |
   | `sahvaas-late-fees` | `0 19 * * *` (00:30 IST) | applies late fees |
   | `sahvaas-push` | `*/5 * * * *` | sends phone notifications (needs step 3 of section 3) |
   | `sahvaas-subscriptions` | `30 19 * * *` (01:00 IST) | Sahvaas plan renewals and expiry |
   | `sahvaas-tenancy-reminders` | `0 4 * * *` (09:30 IST) | reminds owners before a tenant agreement ends |

   If a job is missing, enable `pg_cron` and `pg_net` under Database → Extensions. Then copy the matching `cron.schedule(...)` block from its migration (010, 015, 030 or 041) and run it in the SQL Editor. Do not re-run the whole file.
4. **Authentication → URL Configuration**
   - Site URL: `https://<your-domain>`.
   - Redirect URLs: `https://<your-domain>/login` and `https://<your-domain>/reset-password`, plus the same paths on `http://localhost:3000` for local development.
5. **Authentication → Email**: keep *Confirm email* **ON**. Invites are claimed only by verified emails.
6. **Authentication → SMTP**: set up a custom SMTP sender (Resend, SES or Zoho). The built-in Supabase mailer allows only a few emails an hour and is not for production.
7. **Mobile + WhatsApp code login.** This is optional, and needed before Gate Lite. Turn it on only when your WhatsApp template is approved:
   - Authentication → Sign In / Providers → **Phone**: enable it.
     - Keep **Confirm phone** ON.
     - Set the OTP expiry to about 300 seconds, because WhatsApp can take a minute.
     - Set the SMS max frequency to 60 seconds.
   - Authentication → Hooks → **Send SMS hook** (HTTP): URL `https://<your-domain>/api/auth/sms-hook`. Copy its secret into `SEND_SMS_HOOK_SECRET` (section 3).
   - Authentication → Rate limits: raise **SMS sent**. The default is 30 an hour for the whole project.
   - Set `NEXT_PUBLIC_PHONE_LOGIN=1` only after a test code arrives. That shows "Log in with mobile".
8. **Advisors → Security / Performance**: resolve anything flagged after the migrations.
9. **Backups**: the Pro plan gives daily backups and PITR. You need them before onboarding paying societies.

## 2. Platform owner account

1. Sign up on the deployed site and verify your email.
2. In the SQL Editor:
   ```sql
   insert into platform_admins (user_id)
   select id from auth.users where email = 'you@yourcompany.in';
   ```
3. ✅ Check: signing in lands on `/platform` with the society overview.

## 3. Vercel

1. Import the GitHub repository. The framework is **Next.js** (detected automatically). Build command: `bun run build` (or `npm run build`).
2. Environment variables (Production + Preview). Only the `NEXT_PUBLIC_` ones reach the browser; every other one is server-only.

   **Required**

   | Variable | Value | Notes |
   |---|---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` | Project Settings → API |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the anon public key | safe in the browser; RLS protects the data |
   | `NEXT_PUBLIC_APP_URL` | `https://<your-domain>` | used in email and WhatsApp links |
   | `SUPABASE_SERVICE_ROLE_KEY` | the service_role key (Project Settings → API) | **server-only, never `NEXT_PUBLIC_`.** Used only by the phone-notification sender (`/api/push/send-pending`) and the login-code hook (`/api/auth/sms-hook`) |

   **Email (recommended)**

   | Variable | Value | Notes |
   |---|---|---|
   | `RESEND_API_KEY` | from resend.com | without it, emails are skipped and the WhatsApp share still works |
   | `EMAIL_FROM` | `Sahvaas <noreply@<your-domain>>` | the domain must be verified in Resend |

   **Phone notifications (web push)**

   | Variable | Value | Notes |
   |---|---|---|
   | `VAPID_PRIVATE_KEY` | PEM, with newlines written as `\n` | generate once with the command in `.env.example` |
   | `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | the base64url public key | from the same command |
   | `VAPID_SUBJECT` | `mailto:support@<your-domain>` | |
   | `CRON_SECRET` | random 32+ characters | the same value goes into the database (step 3 below) |

   **Mobile + WhatsApp code login** (only with step 1.7)

   | Variable | Value | Notes |
   |---|---|---|
   | `SEND_SMS_HOOK_SECRET` | `v1,whsec_…` | from the Supabase Send SMS hook |
   | `OTP_PROVIDER` | `whatsapp` | `console` is for development only: it prints the code in the server log |
   | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_NAME`, `WHATSAPP_TEMPLATE_LANG` | WhatsApp Cloud API | an approved AUTHENTICATION template with a copy-code button |
   | `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID` | MSG91 | optional SMS backup for Indian numbers (DLT-approved OTP template) |
   | `NEXT_PUBLIC_PHONE_LOGIN` | `1` | only once a test code arrives |

   **Optional**

   | Variable | Value | Notes |
   |---|---|---|
   | `GROQ_API_KEY` | from console.groq.com | reads uploaded vendor invoices into the bill form; PDFs are turned into images in the browser. One key is enough, because Groq's limits apply per organization |
   | `ANTHROPIC_API_KEY` | from console.anthropic.com | an alternative that reads PDFs directly |
   | `INVOICE_PROVIDER` | `groq` or `anthropic` | only when both keys are set (default: Groq first) |
   | `INVOICE_MODEL` | e.g. `qwen/qwen3.8-27b` | model override |
   | `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Razorpay Dashboard → API Keys | online payment of Sahvaas invoices. Without them, societies pay by bank transfer and the platform owner marks the payment |
   | `RAZORPAY_WEBHOOK_SECRET` | set when you create the webhook | webhook URL `https://<your-domain>/api/billing/webhook`; events `payment.captured` and `order.paid` |
   | `SAHVAAS_GATEWAY_SECRET` | random 32+ characters | save the **same** value in Platform → Billing & Plans → Online payments (only its hash is stored) |

   Never put real keys in `.env.example`; it is committed. `SUPABASE_DB_URL` stays on your machine (and as a CI secret if you ever automate migrations). It is not a Vercel variable.
3. **Let the database call the push sender.** Do this only after the variables above are deployed: a run without the VAPID keys uses up the waiting notifications, and they never reach phones. Save two secrets in Supabase Vault, once, from the SQL Editor. Replace the `<…>` parts with the real values:
   ```sql
   select vault.create_secret('https://<your-domain>/api/push/send-pending', 'sahvaas_push_url');
   select vault.create_secret('<the CRON_SECRET from Vercel>', 'sahvaas_cron_secret');
   ```
   - The `sahvaas-push` job (migration 044) reads both every 5 minutes. Until they are saved it does nothing, and notifications show only inside the app.
   - Hosted Supabase does not allow `alter database … set app.push_url`, so use Vault.
   - To change a value later: `select vault.update_secret((select id from vault.secrets where name = 'sahvaas_push_url'), 'https://…');`
   - ✅ Check: after 5 minutes, `select status_code, content from net._http_response order by created desc limit 3;` shows `200` with `{"subscriptions":…,"sent":…}`.
4. Domains: add your domain and point DNS as Vercel shows. HTTPS is automatic.
5. ✅ Check: `https://<your-domain>/` loads, and the response headers include `X-Frame-Options: DENY`.

## 4. Smoke test on production (about 20 minutes)

1. `/signup` → verify the email → `/onboarding`. Create a test society with the wizard.
2. Society Rules → add the **society's** UPI ID.
3. Flats → import the CSV template.
4. Members → invite a second email you own as *Resident (Owner)* of a flat, and a third as *Treasurer*. Also open the society's joining link on another phone and join as an owner.
5. Billing → add a charge → Preview → Issue Bills. The owner gets an email if Resend is set up, and a phone notification if push is set up.
6. As the resident: open the bill → Pay via UPI (the QR shows the society's UPI ID) → submit a 12-digit UTR.
7. As the treasurer: Payments → Verify. The receipt opens with Print and WhatsApp.
8. As the resident: My account shows the bill and the payment.
9. Requests: ask for a NOC as the owner, then approve it as the secretary. The letter gets a number `NOC/<FY>/001`.
10. Financial Reports → Trial Balance shows ✓ Books balance.
11. Platform console: the society appears with this month's billed and collected totals.
12. Delete the test society's data, or suspend it from the platform console.

## 5. Ongoing operations

- **CI**: GitHub Actions (`.github/workflows/ci.yml`) runs the type check, lint, the unit and database tests (80+ files) and a build on every push and PR. Keep `main` protected.
- **Schema changes**: add a new numbered migration and run `bun run db:bundle`, which regenerates `ALL_MIGRATIONS_CONSOLIDATED.sql` (a test fails if the bundle drifts). Then run `bun run db:migrate`, check the list, and run it again with `--apply`.
- **Error monitoring** (recommended): add Sentry (`@sentry/nextjs`) or Vercel Observability before you scale up.
- **Late fees** run nightly; committees can still press *Apply Late Fees* by hand. Shifting and transfer bills never get late fees.
- **Suspending a society**: Platform console → Status → Suspended (a reason is required). Members, the committee and CAs lose access at once, and the data is kept. Assigning a plan reactivates it.

## 6. Updating a live project

1. Pull `main` and run `bun run db:migrate`. It lists only the files not yet applied.
   - As of 2026-11-24, the live database is at 038, so the list should be **039, 040, 041, 042, 043 and 044**.
   - 039 is Phase 10 (notice reads, polls, staff register). 040–043 are Phase 11: NOC letters, tenants, shifting, sale and transfer. 044 moves the push job's settings to Vault.
2. Run `bun run db:migrate --apply` **before** Vercel deploys the new code, or the new screens will open without their tables.
3. Check that `cron.job` lists `sahvaas-tenancy-reminders` (added by 041) and that Storage has `staff-files` and `request-files`.
4. Check new Vercel variables against section 3 (for example `SUPABASE_SERVICE_ROLE_KEY`, the VAPID keys and `CRON_SECRET` for push).

## 7. Known limitations at launch

- **Legal figures need a CA or legal adviser:** the defaults and caps come from secondary sources.
  - The ₹25,000 transfer-premium cap and the ₹500 default transfer fee.
  - The 10% cap on non-occupancy charges.
  - The NOC letter wording.
  - The default TDS rates and limits, and the depreciation rates (Platform → Tax Rules).
- Invite emails need `RESEND_API_KEY`; otherwise share the WhatsApp link from Members or CA Access.
- Mobile login needs an approved WhatsApp template (or MSG91 with DLT); until then, people log in by email.
- Gate Lite (the visitor register) is planned for January 2027 and is not built yet.
- GSTR-2B credit and debit notes and amendments are listed as *skipped*, not reconciled.
- Bank statement match (Pro) reads only CSV statements, so committees save Excel or PDF downloads as CSV first.
  - Bank charges and interest are matched as "no match needed"; they are not posted to the books automatically.
  - Shifting deposit refunds are not matched automatically either; mark them "no match needed".
- Invoice auto-reading needs `GROQ_API_KEY` (or `ANTHROPIC_API_KEY`). Without it, committee members type the bill details (upload still works). On Groq's free tier, a busy reader falls back to manual entry with a message.
- The Tally XML export is untested against a real Tally install. Ask the CA to import it into a test company first.
- A locked financial year can only be unlocked by the platform owner (`unlock_financial_year`, through SQL or support).
- Subscription invoices to societies are tracked (plan and period) but not charged automatically.
- The Phase 2F "Owner change" screen records a change without the dues check. A sale through Requests always checks dues.
