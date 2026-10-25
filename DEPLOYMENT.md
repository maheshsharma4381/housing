# Sahvaas — Go-Live Checklist

Production setup for **Vercel (Next.js) + Supabase**. Do the steps in order; each has a check.

---

## 1. Supabase project

1. Create a project in region **ap-south-1 (Mumbai)** (data stays in India; lower latency).
2. **SQL Editor → run `src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql`** once on the fresh project.
   - It creates the schema, RLS policies, RPCs, the private `society-files` storage bucket and its policies.
   - If you already ran an older consolidated file, run only the newer numbered files in order (`004_…` → `010_…`). Every file is safe to re-run.
   - ✅ Check: *Table editor* shows `societies`, `bills`, `ledger_entries`, `audit_remarks`…; *Storage* shows `society-files` (private).
3. **Database → Extensions → enable `pg_cron`**, then re-run `010_launch.sql`.
   - ✅ Check: `select jobname, schedule from cron.job;` → `sahvaas-late-fees | 0 19 * * *` (00:30 IST nightly).
4. **Authentication → URL Configuration**
   - Site URL: `https://<your-domain>`
   - Redirect URLs: `https://<your-domain>/login`, `https://<your-domain>/reset-password` (and `http://localhost:3000/...` for local dev).
5. **Authentication → Email**: keep *Confirm email* **ON** — invites are claimed only by verified emails.
6. **Authentication → SMTP**: configure a custom SMTP sender (Resend / SES / Zoho). The built-in Supabase mailer is rate-limited to a few emails per hour and is not for production.
7. **Advisors → Security / Performance**: resolve anything flagged after running the migrations.
8. **Backups**: Pro plan enables daily backups + PITR — required before onboarding paying societies.

## 2. Platform owner account

1. Sign up on the deployed site and verify your email.
2. SQL Editor:
   ```sql
   insert into platform_admins (user_id)
   select id from auth.users where email = 'you@yourcompany.in';
   ```
3. ✅ Check: signing in lands on `/platform` with the society overview.

## 3. Vercel

1. Import the GitHub repository → Framework **Next.js** (auto-detected). Build command `bun run build` (or `npm run build`).
2. Environment variables (Production + Preview):

   | Variable | Value | Notes |
   |---|---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` | Project Settings → API |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon public key | safe in the browser (RLS protects data) |
   | `NEXT_PUBLIC_APP_URL` | `https://<your-domain>` | used in email / WhatsApp links |
   | `RESEND_API_KEY` | from resend.com | optional — without it emails are skipped, WhatsApp share still works |
   | `EMAIL_FROM` | `Sahvaas <noreply@<your-domain>>` | domain must be verified in Resend |
   | `GROQ_API_KEY` | from console.groq.com | optional — reads uploaded vendor invoices into the bill form (images; PDFs are rendered to images in the browser). Server-only (no `NEXT_PUBLIC_`). One key is enough: Groq limits apply per organization, so extra keys add no capacity |
   | `ANTHROPIC_API_KEY` | from console.anthropic.com | optional alternative — reads PDFs directly |
   | `INVOICE_PROVIDER` | `groq` / `anthropic` | only when both keys are set (default: Groq first) |
   | `INVOICE_MODEL` | e.g. `qwen/qwen3.8-27b` | optional — model override |
   | `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Razorpay Dashboard → API Keys | optional — online payment of Sahvaas invoices; without them societies pay by bank transfer and the admin marks it paid |
   | `RAZORPAY_WEBHOOK_SECRET` | set when creating the webhook | webhook URL `https://<your-domain>/api/billing/webhook`, events `payment.captured` and `order.paid` |
   | `SAHVAAS_GATEWAY_SECRET` | random 32+ characters | save the **same** value in Platform → Billing & Plans → Online payments (only its hash is stored) |

   **Do not add `SUPABASE_SERVICE_ROLE_KEY` to Vercel** — the app never needs it. Never commit real keys to `.env.example`.
3. Domains → add your domain, point DNS as Vercel shows. HTTPS is automatic.
4. ✅ Check: `https://<your-domain>/` loads; response headers include `X-Frame-Options: DENY`.

## 4. Smoke test on production (15 minutes)

1. `/signup` → verify email → `/onboarding` → create a test society.
2. Society Rules → add the **society's** UPI ID.
3. Flats → import the CSV template.
4. Members → invite a second email you own as *Resident (Owner)* of a flat (and a third as *Treasurer*).
5. Billing → add a charge → Preview → Issue Bills (the owner gets an email if Resend is configured).
6. As the resident: open the bill → Pay via UPI (QR shows the society VPA) → submit a 12-digit UTR.
7. As treasurer: Payments → Verify → receipt opens → Print / WhatsApp.
8. Financial Reports → Trial Balance shows ✓ Books balance.
9. Platform console → the society appears with this month's billed / collected totals.
10. Delete the test society data or suspend it from the platform console.

## 5. Ongoing operations

- **CI**: GitHub Actions (`.github/workflows/ci.yml`) runs type check, lint, 80+ unit/DB tests and a build on every push/PR. Keep `main` protected.
- **Schema changes**: add a new numbered migration, regenerate `ALL_MIGRATIONS_CONSOLIDATED.sql` (a test fails if it drifts), run the new file on Supabase.
- **Error monitoring** (recommended): add Sentry (`@sentry/nextjs`) or Vercel Observability before scale-up.
- **Late fees**: run nightly via pg_cron; committees can still press *Apply Late Fees* manually.
- **Suspending a society**: Platform console → Status → Suspended (reason required). Members, committee and CAs lose access immediately; data is kept. Assigning a plan reactivates it.

## 6. Known limitations at launch

- Invite emails need `RESEND_API_KEY`; otherwise share the WhatsApp link from Members / CA Access.
- GSTR-2B credit/debit notes and amendments are listed as *skipped*, not reconciled.
- Bank statement match (Pro) reads CSV statements only — committees save Excel / PDF downloads as CSV first. Bank charges and interest are matched as "no match needed"; they are not posted to the books automatically.
- Push notifications and offline PWA caching are not built yet.
- Invoice auto-reading needs `GROQ_API_KEY` (or `ANTHROPIC_API_KEY`); without it committee members type bill details (upload still works). On Groq's free tier a busy reader falls back to manual entry with a message.
- Default TDS rates / limits and depreciation rates must be confirmed by a CA before go-live (Platform → Tax Rules).
- Tally XML export is untested against a real Tally install — ask the CA to import it into a test company first.
- A locked financial year can only be unlocked by the platform owner (`unlock_financial_year`, SQL / support).
- Subscription invoices to societies are tracked (plan + period) but not charged automatically.
