# Phase 5 — Resident side: My account and the resident Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each owner sees their flat's full ledger, with the same numbers as the CA's party ledger. They can download it as a PDF and share it on WhatsApp. Tenants see no dues, bills or ledger. The resident Home shows the balance due, Pay by UPI and the latest bill.

**Architecture:**
- Migration 036 adds `my_flat_statement(unit, from, to)` over `party_entries`, the source the CA's `party_statement` uses.
- It clamps the period to the caller's ownership period after an owner change, and labels the opening "Brought forward from previous owner".
- Each line carries its journal reference (`bill.*` or `payment.*`), so it can link to `/bill/<id>` or `/receipt/<id>`.

**Tech Stack:** plpgsql, PGlite tests, React, node:test.

**Spec:** `docs/superpowers/specs/2026-10-31-sahvaas-simplify-design.md` 10.1, 10.2.

## Global Constraints
- **Lines:** date, details, debit, credit and running balance; the opening balance or "brought forward"; bills (linked to the bill PDF), payments (linked to the receipt), late fees and adjustments.
- **Period:** this financial year (Apr–Mar), last year, or custom.
- Download as PDF and share on WhatsApp.
- **Tenants do not see it,** or any dues.
- **The numbers** match the CA's party ledger for that flat.
- **After an owner change,** the new owner's statement starts at the transfer date with "Brought forward from previous owner".
- **The secretary** can open any flat's statement from Flats & residents. This already exists from 2F (OwnerHistory → party_statement).

## Review Focus
1. The new owner never sees the previous owner's lines, even when asking for a period that starts before the transfer.
2. A removed owner or a tenant is refused.
3. The closing balance equals `party_statement`'s for the same range.
4. Bills and receipts in the list open the right page.

### Task 1: `my_flat_statement` (036)
- [ ] `tests/db/my-account.test.mjs` (RED) → 036 → GREEN.
- [ ] Commit `feat(account): the owner's flat statement`.

### Task 2: Screens
- [ ] `src/lib/fy.ts` `fyRange` with `tests/unit/fy.test.ts`.
- [ ] `src/components/FlatStatement.tsx`.
- [ ] The resident dashboard:
  - a "My account" tab for owners;
  - the dues banner and the Bills tab for owners only;
  - a "Latest bill" card on Home.
- [ ] Typecheck, lint, the full suite, build. Commit `feat(account): My account statement, tenants see no dues, latest bill on Home`.
