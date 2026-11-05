# Phase 6 — The platform owner's dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The platform owner can see:
- where secretaries stop during setup;
- how each society is doing;
- what the business earns.

They can also look inside a society read-only to help, and announce things to every secretary.

**Architecture:** Migration 037 adds platform-admin-only RPCs:
- `platform_setup_funnel`: built from setup events, and also from the data, because steps done outside the wizard must count;
- `platform_society_health`;
- `platform_revenue`: reuses `platform_billing_overview`, ad campaigns and the OTP log;
- `start_support_view` and `support_snapshot`: one hour, audited, and the committee is notified;
- `platform_announce`: notifications to committee admins, filtered by plan and state.

The UI adds four tabs to the platform dashboard.

**Spec:** `docs/superpowers/specs/2026-10-31-sahvaas-simplify-design.md` 11 items 2–5, and 12 call 15.

## Global Constraints
- **Funnel:** how many started and where they stopped, by step; how many issued their first bill; the time from first login to the first bill.
- **Health:** flats; owners joined (%); this month's collection (%); CA invited; opening balance approved; last active; a flag for stuck or quiet societies.
- **Revenue:** societies by plan (Free, Basic, Pro, trial); MRR; trials ending this week; unpaid invoices; ad revenue against OTP cost.
- **Support:** read-only; every view in the audit log; the committee sees "Sahvaas support viewed your society on <date>"; access lasts one hour.
- **Announcements:** to all secretaries, optionally filtered by plan or state; in-app and push.

## Review Focus
1. A non-admin is refused by every RPC.
2. A support snapshot without a live session, or after it expires, is refused.
3. Funnel steps done outside the wizard still count.
4. An announcement reaches only active committee admins, never residents.

### Task 1: 037 + `tests/db/platform.test.mjs` (RED → GREEN)
### Task 2: Platform tabs: Setup funnel, Society health (with the support view), Revenue, Announcements
