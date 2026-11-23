# Phase 11D (sale and transfer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The seller (or the committee) applies to transfer a flat to a named buyer with the documents the society asks for. The committee ticks that the original share certificate is received and bills the transfer fee and premium to the flat. Approval waits until the seller's dues are cleared; on approval the Phase 2F owner change runs, the buyer is invited and the share certificate details are recorded.

**Architecture:** A `transfer` kind on the 11A request engine. Fees go through 11C's `charge_flat` with two new system rules crediting new income ledgers 4600 "Transfer fees" and 4700 "Transfer premium". `decide_request` gets a transfer branch that checks the share certificate, the fees and the dues, then calls `transfer_flat_owner` unchanged. A trigger cancels an unpaid fee bill when the request is withdrawn or rejected. The 11C deferral lands here too: a society can require a shifting booking before a tenancy or a transfer is approved.

**Tech Stack:** Next.js 15, React 19, Tailwind v4, Supabase Postgres, PGlite DB tests, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-24-flat-changes-design.md` (section 5.5; the shifting gate from 5.4)

**Choices the spec left open, made here:**
- **The committee bills the fees** from the request ("Bill transfer fees"), prefilled from the settings and editable. A transfer within the family can be billed ₹0 premium, and nothing is billed for requests the committee never takes up. Approval needs this step to be done, even at ₹0 + ₹0.
- **Ledgers:** `4600 Transfer fees` and `4700 Transfer premium` (income), made on first use like 11C's.
- **Transfer date:** the date the committee approves, unless the committee enters an earlier one. Membership passes on the committee's approval, and `transfer_flat_owner` refuses future dates anyway.
- **Share certificate:** the committee ticks "Original share certificate received". At approval it records the certificate number (default: the flat's current one) and the endorsement date (default: the approval day). The number is written to `units.share_certificate_no`.
- **Buyer:** name and mobile are required (the buyer joins with mobile login); email is optional. The buyer cannot have an active owner's mobile on this flat.
- **Only one open transfer per flat.**
- **Withdrawn or rejected:** an unpaid fee bill is cancelled, with a reversing journal like `cancel_bill`. A paid one stays, and the committee refunds outside this flow.
- **Shifting gate:** off by default. When it is on, approval needs a shifting booking for the flat that is submitted or approved and was made since 60 days before the request: move-in for a tenancy, move-out for a transfer.

## Global Constraints

- Migration `src/db/migrations/043_transfer.sql` (Gate Lite moves to 044); run `bun run db:bundle` after it. Never edit 001–042.
- Functions redefined in 043 are copied verbatim from their latest definition and changed only where this plan says: `decide_request`, `system_rule` and `ensure_flat_change_ledgers` from 042.
- Applicants: an owner of the flat (`is_flat_owner`) or a managing role (`is_society_admin`). Tenants cannot apply. Error: `Only an owner of this flat can apply for a transfer`.
- Messages, exactly:
  - `Enter the buyer's name`
  - `Enter the buyer's mobile number`
  - `Mobile % is not a valid number`
  - `Enter a valid email for the buyer`
  - `This mobile belongs to an owner of this flat`
  - `Enter the sale deed date`
  - `The sale deed date cannot be in the future`
  - `The registration number can be up to 40 characters`
  - `A transfer request for this flat is already open`
  - `The transfer premium can be at most ₹25,000`
  - `Amounts must be between ₹0 and ₹1,00,000`
  - `The transfer fees are already billed`
  - `Bill the transfer fees first (₹0 if none)`
  - `Tick that the original share certificate is received`
  - `Clear dues of ₹{inr_text} before the transfer`
  - `The share certificate number can be up to 40 characters`
  - `The transfer date cannot be in the future`
  - `Only the committee can do this`
  - `Book the move-in shifting for this flat first`
  - `Book the move-out shifting for this flat first`
- Settings warning on screen, exactly: `Charge only what your bye-laws allow. The transfer premium is capped at ₹25,000.`
- Notifications:
  - managing roles on submission: `Transfer requested for flat {label}`;
  - the applicant and the flat's owners when fees are billed: `Transfer fees billed for flat {label}: {₹}`;
  - the applicant, the flat's owners and managing roles on approval: `Transfer approved for flat {label}`.
- English UI on all plans. DB tests run one file at a time with `TZ=UTC`.
- Branch `phase-11d-transfer`. Commit with `git -c user.name=ved300406 -c user.email=ved300406@gmail.com`; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push; never run `db:migrate --apply`.

## Review Focus

1. A seller with ₹1 of dues cannot be approved; after paying it, approval works (Task 3).
2. After approval the seller's owner membership is off, the buyer's invite is pending with the buyer's mobile, and the buyer sees none of the seller's request papers (Task 3).
3. A withdrawn request with an unpaid fee bill leaves the flat's dues at ₹0 and a balanced reversing journal (Task 2).
4. A premium above ₹25,000 can be neither saved in settings nor billed (Tasks 1 and 2).
5. With the shifting gate on, a tenancy needs a move-in booking and a transfer needs a move-out one; with it off, nothing changes (Task 4).

---

### Task 1: Ledgers, system rules and transfer settings

**Files:** Create `043_transfer.sql` (section 1); Test `tests/db/transfer.test.mjs`

**Produces:**
- `ensure_flat_change_ledgers` (redefined): adds `4600 Transfer fees` and `4700 Transfer premium` (income).
- `system_rule` (redefined): adds keys `transfer_fee` (4600, "Transfer fee") and `transfer_premium` (4700, "Transfer premium").
- `society_settings` columns:
  - `transfer_fee NUMERIC(10,2) NOT NULL DEFAULT 500`;
  - `transfer_premium NUMERIC(10,2) NOT NULL DEFAULT 0`;
  - `shifting_required BOOLEAN NOT NULL DEFAULT false`.
- `set_transfer_settings(p_society_id uuid, p_settings jsonb) RETURNS void` (managing roles; keys optional, the current value is kept):
  - fee 0–100000;
  - premium 0–25000;
  - error `Only the committee can change this`.
- Request checklist seed for kind `transfer`. `seed_request_checklists` is redefined from 041, and existing societies are backfilled with ON CONFLICT DO NOTHING. Items:
  - `notice` Seller's notice of transfer (society form), required;
  - `membership` Buyer's application for membership (society form), required;
  - `deed` Registered sale deed or agreement, required;
  - `index2` Registration receipt or Index II, required;
  - `loan` Bank NOC or loan closure letter (if the flat had a loan), optional;
  - `buyer_id` Buyer's photo ID, required;
  - `buyer_photo` Buyer's photograph, required;
  - `buyer_pan` Buyer's PAN, required;
  - `nomination` Buyer's nomination form, optional.

- [ ] Tests:
  - `transfer ledgers and charges`: `charge_flat` with `transfer_fee` 500 + `transfer_premium` 20000 posts 1200 +20500, 4600 −500, 4700 −20000.
  - `transfer settings`: defaults are 500 / 0 / false; the owner and a committee member are refused; premium 25001 gives the cap message; fee −1 gives the amounts message; a save keeps keys that were not sent.
  - `every society has the transfer checklist`: an existing society and a new one each have 9 items, 7 of them required.
- [ ] RED → implement → GREEN; `shifting.test.mjs` → PASS. Commit `feat(transfer): transfer ledgers, settings and checklist (043)`.

### Task 2: Applying, fees and cancellation

**Files:** Modify `043_transfer.sql` (section 2); Test `tests/db/transfer.test.mjs`

**Produces:**
- `create_transfer_request(p_unit_id uuid, p_details jsonb) RETURNS uuid`.
  - Keys: `buyer_name` (2–120), `buyer_mobile` (stored normalized with `normalize_mobile`), `buyer_email` (optional, lower-cased), `deed_date` (no later than today in IST), `deed_number` (optional, ≤ 40).
  - Whitespace is collapsed. The checklist is the snapshot from `request_checklists` kind `transfer`.
  - Event `submitted`; managing roles are notified.
- `bill_transfer_fees(p_request_id uuid, p_fee numeric, p_premium numeric) RETURNS uuid` (managing roles; request open).
  - Refuses a second billing.
  - Calls `charge_flat` with lines `Transfer fee` / `Transfer premium`, due in 7 days (IST today + 7).
  - Writes these details: `fee`, `premium`, `fee_bill_id` (NULL when both are 0), `fees_billed_at`.
  - Event `fees_billed` with note `{₹total}`; notification. Returns the bill id or NULL.
- `save_transfer_handover(p_request_id uuid, p_details jsonb) RETURNS void` (managing roles; request open).
  - Keys: `certificate_received` boolean, `share_certificate_no` (≤ 40), `endorsed_on` date, `transfer_date` (no later than today in IST). Each key is optional and merged into details.
  - Event `certificate_received` the first time it turns true.
- Private helper `cancel_flat_charge(p_bill_id uuid, p_reason text) RETURNS void`:
  - does nothing when the bill is cancelled or anything was paid on it;
  - otherwise does what `cancel_bill` does (status, balance 0, the two `ledger_reverse` calls, audit) without the role check.
- Trigger `trg_transfer_closed_cancels_fees` AFTER UPDATE OF status ON flat_requests, when kind = 'transfer' and the new status is withdrawn or rejected. It calls `cancel_flat_charge(details->>'fee_bill_id', 'Transfer request closed')`.

- [ ] Tests:
  - `an owner applies to transfer the flat`: details are normalized; the checklist has 9 items; the secretary gets `Transfer requested for flat A-101`.
  - `who can apply`: tenant, other flat's owner and committee member are refused with the exact message; the secretary can apply on behalf.
  - `application checks`: each message above for name, mobile, email, an owner's own mobile, a future deed date and a 41-character number.
  - `one open transfer per flat`.
  - `fees are billed once`:
    - 500 + 20000 → one bill, two lines, flat dues 20500, owner notified;
    - a second call → `The transfer fees are already billed`;
    - premium 25001 → cap message;
    - an owner calling it → `Only the committee can do this`.
  - `no fees makes no bill`: 0 + 0 → NULL; `fees_billed_at` is set.
  - `withdrawing cancels an unpaid fee bill`: the bill is cancelled, dues are back to 0, and the `bill.cancelled` journal sums to 0 with 1200 −total.
  - `a paid fee bill stays when the request is rejected`.
- [ ] RED → implement → GREEN; `flat-requests.test.mjs` → PASS. Commit `feat(transfer): applying, fee billing and cancellation`.

### Task 3: Approval runs the owner change

**Files:** Modify `043_transfer.sql` (section 3: `decide_request` redefined from 042); Test `tests/db/transfer.test.mjs`

**Produces:** the `decide_request` transfer branch on approve. It runs after the existing document check and applicant check, and it must check everything before it sets the status:
- the fees step was done, else `Bill the transfer fees first (₹0 if none)`;
- `certificate_received`, else `Tick that the original share certificate is received`;
- `flat_dues_on(unit, IST today) > 0` → `Clear dues of ₹X before the transfer` (`inr_text`).

When the checks pass, it:
- calls `transfer_flat_owner(unit, buyer_name, buyer_email, buyer_mobile, coalesce(transfer_date, IST today))`;
- sets `units.share_certificate_no` to `coalesce(details.share_certificate_no, units.share_certificate_no)`;
- writes these details: `transfer_date`, `endorsed_on` (default today), `share_certificate_no`, `ownership_id`, `invite_id`;
- sends the notification and returns `{status:'approved', ownership_id, invite_id}`.

The checks run before the status update, so a refusal leaves the request `submitted`.

- [ ] Tests:
  - `approval waits for the fees, the certificate and the dues`: three refusals in order with the exact messages; after a verified payment of the fee bill it approves.
  - `approval transfers the flat`:
    - the seller's `resident_owner` membership is inactive;
    - the open `unit_ownerships` row has the buyer's name and mobile;
    - a pending `resident_owner` invite has the buyer's mobile;
    - `units.share_certificate_no` is the new number and details carry the endorsement date;
    - the seller still sees the request; the old flat statement stays available (`flat_owner_periods` has two periods).
  - `the buyer cannot read the seller's papers`: after the buyer accepts the invite (`accept_member_invite_row` or the harness's path used in `owner-change.test.mjs`), `can_see_request` is false for the transfer request and the buyer reads 0 rows of `request_documents`.
  - `a refused approval changes nothing`: when the dues refusal fires, the status is still `submitted` and the flat still has the seller.
- [ ] RED → implement → GREEN; `owner-change.test.mjs`, `tenancy.test.mjs`, `shifting.test.mjs` → PASS. Commit `feat(transfer): approval runs the owner change`.

### Task 4: Shifting required before tenancy or transfer

**Files:** Modify `043_transfer.sql` (section 4: the gate inside the redefined `decide_request`); Test `tests/db/transfer.test.mjs`

**Produces:** in `decide_request` on approve, for kind `tenancy` and `transfer`, when `society_settings.shifting_required` is on:
- the flat needs a `shifting` request with status submitted or approved, direction `in` for a tenancy and `out` for a transfer, and `submitted_at >= request.submitted_at - 60 days`;
- otherwise the exact message for that direction.

- [ ] Tests:
  - `the shifting gate`: off → a tenancy approves without a booking; on → `Book the move-in shifting for this flat first`; after the owner books a move-in, it approves.
  - A transfer with the gate on → `Book the move-out shifting for this flat first`.
- [ ] RED → implement → GREEN. Commit `feat(transfer): society can require shifting before tenancy or transfer`.

### Task 5: Helpers and screens

**Files:**
- Create `src/lib/transfer.ts`, `src/components/TransferForm.tsx`, `src/components/TransferSettings.tsx`.
- Modify:
  - `MyRequests.tsx`: **Transfer this flat** for owned flats.
  - `RequestDetail.tsx`: a transfer block with the buyer, the deed and the flat's dues. For managing roles it also has the certificate tick, a **Bill transfer fees** form prefilled from the settings, and the approval fields (transfer date, share certificate number, endorsed on) saved through `save_transfer_handover` before `decide_request`. Approve is disabled with `Clear dues of ₹X before the transfer` while dues are above 0.
  - `FlatRequests.tsx`: transfer settings, next to the shifting settings.
  - `types/database.ts`.
- Test `tests/unit/transfer.test.ts`.

**Produces:**
- `transferDraftError(d, today)`, mirroring the DB checks.
- `transferFeeError(fee, premium)`, with the DB's messages.
- `transferBlocker({feesBilled, certificateReceived, dues}): string | null`: the first unmet step, with the DB's messages and `formatINR` for the amount.

- [ ] Unit tests → RED → implement → GREEN; screens; typecheck, lint (0 errors), build. Commit `feat(transfer): apply, fees and approval screens`.

### Task 6: Bundle, docs, verification

- [ ] `bun run db:bundle`; every DB and unit test → 0 fail; typecheck, lint, build.
- [ ] Gate Lite docs: 043 → 044.
- [ ] Report section "Phase 11D — sale and transfer (migration 043)"; the next steps list 039–043.
- [ ] Commit `docs(report): Phase 11D (migration 043)`.
