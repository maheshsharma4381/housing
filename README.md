# Sahvaas — Housing Society Management

Multi-tenant housing society SaaS for India: committee operations, resident UPI payments,
CA/auditor access and (planned) automated ledgers and GSTR-2B reconciliation.

Portals: **Platform Owner** (`/platform`), **Society Committee** (`/society`),
**Resident** (`/resident`), **Professional / CA** (`/professional`).

Stack: Next.js 15 (App Router) · React 19 · Tailwind v4 · Supabase (Auth + Postgres + RLS).

> Current status, known gaps and roadmap: see [PROJECT_AUDIT.md](PROJECT_AUDIT.md).
> Production go-live steps: see [DEPLOYMENT.md](DEPLOYMENT.md).
>
> Optional email: set `RESEND_API_KEY` and `EMAIL_FROM` (see DEPLOYMENT.md); without them, use the WhatsApp share buttons.

## Local setup

1. Install dependencies (Node 20+):
   ```bash
   bun install        # or: npm install
   ```
2. Copy env file and fill in your Supabase project values:
   ```bash
   cp .env.example .env.local
   ```
3. Create the database: open the Supabase SQL Editor on a **fresh** project and run
   `src/db/migrations/ALL_MIGRATIONS_CONSOLIDATED.sql`.
   (For an existing DB that already has 001–003, run only `004_rls_hardening.sql`.)
4. Run the app, sign up at `/signup`, verify your email, sign in → you land on
   `/onboarding` to register a society.
   ```bash
   bun run dev        # http://localhost:3000
   ```
5. Optional demo data: edit the email in `src/db/seed/demo_seed.sql` and run it in the
   SQL Editor (creates "Palm Heights CHS (Demo)" with 32 flats, a bill, notices…).
6. Optional platform owner access:
   ```sql
   insert into platform_admins (user_id) values ('<your auth.users id>');
   ```

In Supabase → Authentication → URL Configuration, add `http://localhost:3000/login`
and `http://localhost:3000/reset-password` to the redirect URLs.

## Scripts

| Command | What it does |
|---|---|
| `bun run dev` | Next.js dev server |
| `bun run build` | Production build (type-check + lint included) |
| `bun run start` | Serve the production build |
| `bun run lint` | ESLint |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test` | Unit + database tests (migrations & RLS run on in-process Postgres via PGlite) |

## Project layout

```
src/app/          Next.js routes (thin wrappers)
src/views/        Page components per portal
src/components/   Shared UI (header, guards, workspace switcher, PWA)
src/context/      AuthContext — session, roles, active society
src/lib/          Supabase clients, helpers
src/db/migrations SQL schema + RLS (001–004) and consolidated file
src/types/        Database TypeScript types
```
