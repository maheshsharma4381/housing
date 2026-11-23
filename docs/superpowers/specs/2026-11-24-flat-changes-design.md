# Phase 11: flat changes — NOC letters, tenants, shifting, sale and transfer

Date: 2026-11-24
Status: design, awaiting the product owner's approval
Asked for on 2026-11-24: tenant documents, shifting charges (refundable and non-refundable), documents when a flat is bought or sold, and society NOC formats.

## 1. Intent

Every flat change brings paperwork to the secretary: a new tenant's agreement and police papers, a shifting date and deposit, a sale's share-certificate transfer, and NOC letters for banks, MSEDCL or the passport office. Today this lives in files, WhatsApp photos and Word templates, and the money (deposits, transfer premium) is often kept outside the books.

Phase 11 gives each of these one place in Sahvaas:
- the owner (or tenant) applies from their phone and uploads the documents the society asks for;
- the committee sees a checklist, approves or asks for changes, and every decision is dated;
- every rupee goes through the flat's account and the CA's ledgers, deposits as a liability until refunded;
- letters come out on the society's letterhead with a reference number, and a copy is kept.

## 2. Goals, non-goals, anti-goals

**Goals**
1. One **flat requests** inbox for the committee (Approvals), covering four kinds: NOC, tenancy, shifting, transfer. Each request has a checklist of documents, a status, a dated history and a "pending N days" warning.
2. **NOC letters** in about a minute: pick the type, the app fills the society, member, flat, share certificate and dues status, the committee approves, the owner downloads the PDF or shares it on WhatsApp.
3. **Tenancy:** the owner registers a tenant with the agreement, police intimation and ID; on approval the tenant gets an invite; the committee is reminded before the agreement ends.
4. **Shifting:** a dated move-in or move-out with the society's charges billed to the flat, refundable deposits held as a liability and refunded (fully or with a recorded deduction) after the move.
5. **Sale and transfer:** the buyer's and seller's documents on one checklist, the seller's dues shown, transfer fee and premium billed, and on approval the existing owner change (Phase 2F) runs with the share certificate details recorded.

**Non-goals (this phase)**
- Legal advice. Sahvaas ships default checklists and letter texts and says plainly that the society's bye-laws and its legal adviser decide.
- Filing with the police, the registration department, MSEDCL or the Registrar. Sahvaas keeps the society's copy; the person files outside.
- e-stamping, e-signatures or Aadhaar e-sign. Letters carry a printed signature block; the committee signs a printout if the recipient needs ink.
- I-register, J-register and the share register as statutory books (a later phase can print them from this data).
- Hindi or Marathi letters (the app stays English-only; letter text is editable, so a society can write its own wording).

**Anti-goals**
- A charge above a cap the law sets: transfer premium above ₹25,000 or non-occupancy charges above 10% of service charges.
- A refundable deposit counted as income, or refunded without a ledger entry.
- A tenant's or buyer's ID proof readable by other residents.
- A transfer completed while the seller has dues.
- A letter whose dues line differs from the flat's account on the same day.

## 3. What the law says (as checked on 2026-11-24; the CA or legal adviser confirms before launch)

| Topic | Rule | Source |
|---|---|---|
| Transfer premium | At most ₹25,000 (bye-law 38, circular of 9 Aug 2001) | NoBrokerHood guide; CSLawship |
| Transfer fee | ₹500 is commonly cited (unverified) | CSLawship |
| Non-occupancy charges | At most 10% of service charges excluding municipal taxes; paid by the owner (GO of 1 Aug 2001 under s.79A) | Housiey; several guides |
| Share transfer | Effective only after society dues are paid and the transferee applies for membership | BCAS webinar on the Act and Rules |
| NOC | The society must issue an NOC within one month of the application; the Registrar can decide if it does not | Model bye-laws (sahakarayukta.maharashtra.gov.in) |
| Sale NOC | A society cannot insist on its own NOC for a sale (secondary source) | CSLawship |
| Tenants | The owner gives the society the registered leave and licence agreement and the police intimation/verification; ID and photos of the tenant | Moneylife; police forms |
| Shifting charges | No clear rule found; a refundable damage deposit is common; a non-refundable shifting charge must come from the bye-laws or a general body resolution | none found |
| New rules | Maharashtra Co-operative Societies (Amendment) Rules, 2026 add housing rules 106C-1 to 106C-14; the 2025-26 draft model bye-laws may not be notified | Free Press Journal; TaxGuru |

Because rules differ by bye-laws and may change, **every amount and every checklist is a society setting with a default**, and caps the law sets are enforced by the app.

## 4. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **1 (chosen)** | **One "flat request" engine** (request, checklist of documents, status, history, committee decision) shared by the four kinds, each kind adding its own fields and its action on approval. Built once in 11A with NOC letters, reused by 11B–11D. | One inbox, one document store, one set of permissions and tests. Cost: the first sub-phase builds the engine before the most visible feature. |
| 2 | Four separate features with their own tables and screens. | Each ships faster alone, but four inboxes, four document rules and four permission sets to get right. |
| 3 | A generic "forms builder" the committee configures freely. | Flexible, but money and transfers need fixed rules (caps, ledgers, dues check) a free form cannot enforce. |

Builder's call on the owner's behalf ("u decide"); can be overruled.

## 5. What gets built

### 5.1 The request engine (11A)
- **Request:** society, flat, kind (`noc`, `tenancy`, `shifting`, `transfer`), applicant, status (`draft`, `submitted`, `changes_asked`, `approved`, `rejected`, `withdrawn`, `done`), kind-specific details, dates of each step, committee notes.
- **Checklist:** per society and kind, a list of documents with "required" or "optional", seeded with defaults (below) and editable by managing roles. A request snapshots the checklist when created.
- **Documents:** uploaded against checklist items into a private `request-files` bucket (PDF, JPG, PNG, WEBP; 10 MB). Seen by the applicant, the flat's owners for their own flat, and the committee; never by other residents. A document can be replaced until approval.
- **Who applies:** an owner for their flat (all kinds); a tenant for shifting and NOC kinds the society allows; the committee on someone's behalf.
- **Committee:** Approvals gets "Flat requests" with filters by kind and status. Approve, Ask for changes (note required), Reject (reason required). Managing roles decide; committee members see read-only.
- **Clock:** a request shows "Pending N days" from submission; at 25 days it turns amber with "NOC must be decided within one month" for NOC and transfer kinds.
- **Notifications:** applicant on every decision; managing roles on submission.

### 5.2 NOC letters (11A)
- **Types (defaults):** Sale of flat; Home loan / mortgage; Leave and licence (for tenant registration); Electricity meter name change; Passport / address proof; Gas connection; Repairs / renovation. The committee can add a type with its own text.
- **Template:** title, body with placeholders (`{society_name}`, `{registration_number}`, `{society_address}`, `{member_name}`, `{flat}`, `{share_certificate_no}`, `{dues_line}`, `{date}`, `{purpose}`, `{addressee}`), signature block (Secretary / Chairman / Treasurer). Default texts are written in plain English and marked "Check this wording with your society's legal adviser".
- **Dues line:** filled from the flat's account on the day of issue: "There are no dues outstanding as on {date}" or "Dues of ₹{amount} are outstanding as on {date}". It uses the same figure as My account.
- **Issue:** on approval the letter gets the next number in the society's series `NOC/{FY}/{nnn}`, is stored as a PDF with the request, and is listed in a **NOC register** (number, date, flat, type, issued to, by whom). The owner downloads it or shares it on WhatsApp.
- **Fee:** none by default; a society can set a fee per type, billed to the flat (11C's one-off charge), with the warning "Charge only what your bye-laws allow".

### 5.3 Tenancy (11B)
- **Details:** tenant name(s), mobile, number of occupants, agreement start and end dates, police intimation reference.
- **Default checklist:** registered leave and licence agreement (required); police intimation or verification acknowledgement (required); tenant photo ID (required); tenant photograph (optional); owner's undertaking in the society's format (optional; the committee uploads its blank form).
- **On approval:** a tenant invite (`resident_tenant`, the flat) goes to the tenant's mobile; the tenancy is recorded with its dates.
- **Renewal:** 30 days before the end date, the owner and the managing roles are notified; after the end date the flat shows "Agreement expired". The owner renews (new request with the new agreement) or ends it.
- **Ending:** "Tenant moved out" by the owner or the committee ends the tenancy and switches off the tenant's membership; a move-out shifting request (11C) can follow.
- **Non-occupancy charges:** a society setting, as a % of service charges, at most 10%. While a flat has an approved, unexpired tenancy, `generate_bills` adds a "Non-occupancy charges" line to the owner's maintenance bill. Off by default.

### 5.4 Shifting (11C)
- **Request:** move-in or move-out, date and time slot (the society sets allowed hours; default 8 am to 8 pm, every day), vehicle details; the society can require a shifting request before a tenancy or transfer is approved.
- **Charges (society settings, all ₹0 by default, separate for move-in and move-out):** a refundable shifting deposit and a non-refundable shifting charge. The setting screen says "Charge only what your bye-laws or a general body resolution allow."
- **One-off flat charge:** a new RPC bills a single flat for one bill type outside the monthly run (also used for NOC and transfer fees). Bill types: "Shifting charges" (income ledger) and "Shifting deposit" (a liability ledger "Deposits received" that the CA can rename or move).
- **Refund:** after the move, the committee records "Refund deposit": full, or partial with a deduction amount and reason. The refund is a payment from the bank ledger against the liability; a deduction moves from the liability to an income ledger "Damage recovery". The flat's account shows both.
- **Gate (when Gate Lite exists):** approved shifting for today is shown to the guard. Not built here.

### 5.5 Sale and transfer (11D)
- **Applied by** the seller (current owner) or the committee; the buyer is added by name and mobile.
- **Default checklist** (from the model bye-laws' transfer procedure; the committee uploads its own blank forms):
  - seller's notice of transfer and buyer's application for membership (society forms);
  - registered sale deed or agreement, with the registration receipt / Index II;
  - original share certificate (the committee ticks "received" on the request);
  - bank NOC if the flat is mortgaged, or the loan closure letter;
  - buyer's photo ID, photograph and PAN;
  - buyer's nomination form (optional).
- **Dues:** the request shows the seller's outstanding dues from the flat's account; **Approve stays disabled while dues are above zero**, with "Clear dues of ₹X before the transfer".
- **Fees (society settings):** transfer fee (default ₹500, editable) and transfer premium (default ₹0, editable, **capped at ₹25,000** by the app), billed to the seller's account with the one-off charge before approval.
- **On approval:** the existing owner change (Phase 2F `transfer_flat_owner`) runs with the transfer date; the request records the share certificate number and the endorsement date; the buyer gets the owner invite; the seller's statement for their period stays downloadable (Phase 2F).

## 6. Order and size

| Sub-phase | Contents | Migration (in build order) | Rough size |
|---|---|---|---|
| **11A** | Request engine, documents, Approvals inbox, NOC types, templates, letters, NOC register | next free | Largest; about the size of Phase 10 |
| **11B** | Tenancy: details, checklist, approval → invite, renewal reminders, ending, non-occupancy charges in billing | next | Medium |
| **11C** | Shifting: requests, slots, one-off flat charges, deposit liability and refunds | next | Medium; touches accounting |
| **11D** | Sale and transfer: checklist, dues gate, fee and premium, approval → owner change | next | Medium |

Migration numbers are taken in the order things are built, so nothing is applied out of order: if 11A is built before Gate Lite, 11A becomes 040 and Gate Lite moves to the next free number. 11A–11D can be built before Gate Lite, because none of them needs the gate or mobile login.

Each sub-phase gets its own implementation plan, a builder check, tests written first, a fresh final review and a merge to local `main`, like Phase 10.

## 7. Calls made on the owner's behalf (can be changed before building)
1. NOC letters come first, because they are the most frequent request and the engine they need serves the other three.
2. Caps the law sets are enforced: transfer premium ≤ ₹25,000, non-occupancy charges ≤ 10%. Everything else is a setting with a warning.
3. Shifting charges and deposits default to ₹0; the society opts in.
4. The transfer cannot be approved while the seller has dues.
5. Letters are English, editable per society, with a printed signature block; no e-signature.
6. Document files are private to the applicant, the flat's owners and the committee.

## 8. Left to the builder
- Exact screen layout; the PDF method (the existing statement HTML-to-print approach is fine).
- Table and RPC names, within the engine shape above.
- Where checklist and template settings sit in Society settings.
- Which ledger group the default "Deposits received" liability sits under (the CA can move it).
