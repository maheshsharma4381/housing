# Phase 10: notice read record, polls, staff register

Date: 2026-11-23
Status: approved by the product owner in conversation ("haan teeno bana do", 2026-11-23); details below are the builder's calls on the owner's behalf ("u decide")

## 1. Intent

Residents open Sahvaas about once a month, to pay. Three small features give the committee reasons to use it every week and residents reasons to open it, without a gate phone or WhatsApp login:

1. **Notice read record:** the committee can show who has seen a notice ("38 of 52 have seen it") and follow up with the rest.
2. **Polls:** the committee asks owners a question before the AGM ("Lift repair for ₹4 lakh: Yes / No") and takes the result into the meeting.
3. **Staff register:** a list of the society's maids, drivers, cooks and cleaners, with photo, ID proof (committee only), police verification and the flats each one works in.

Amenity booking waits until a CA has said which ledger its income goes to and whether GST applies.

## 2. Goals, non-goals, anti-goals

**Goals**
1. A notice records each person who has seen it; the committee sees counts and the names (with flat) of those who have not.
2. A poll gives one vote per flat, counted only from owners; the committee sees live counts, residents see results once the poll closes.
3. A resident adds their own domestic help in under a minute; the committee sees and verifies everyone.

**Non-goals**
- Polls are not a legal general-body vote (MCS Act: resolutions are passed in the general body meeting). The poll screen says so: "This poll shows members' views. Decisions are taken in the general body meeting."
- Elections, proxy votes, weighted votes (by area or shares), multi-question surveys.
- Staff attendance or entry logging (that is Gate Lite).
- A read receipt for notices sent outside the app.

**Anti-goals**
- A flat votes twice, or a tenant's vote counts.
- Anyone except the committee sees how a particular flat voted. The committee sees which flats have voted, never what they chose.
- A resident sees another person's ID document, or a staff member's mobile number when that person does not work in their flat.
- A seen-record is created for someone who never opened the notice.

## 3. Decisions

### 3.1 Notice read record
- **Seen** = the notice was shown to the person on their Notices screen (resident) or opened from a notification. Recorded once per person (`notice_reads`, first time only). The committee's own reads are not counted.
- The **audience** of a notice = active memberships matching `target_audience` (as in `trg_notify_notice`), excluding the publisher. Counting is per person.
- Committee view under each notice: "Seen by N of M" and a "Not seen yet" list: name and flat label, so the secretary can call or WhatsApp them.
- Old notices (published before this phase) show the count too; it starts from zero.

### 3.2 Polls
- Created by managing roles (`is_society_admin`): question (5–200 characters), optional details (≤ 1000), 2–6 options (each 1–80 characters), closing date and time (at least 1 hour and at most 60 days ahead).
- **Voters:** each flat with at least one active `resident_owner` membership. Any owner of the flat can vote for it; the vote can be changed by any owner of that flat until the poll closes; the last choice counts. An owner of two flats votes once for each.
- Committee members vote as owners of their flats, like everyone else.
- **Secret from residents and committee:** stored per flat with the option chosen; the committee sees counts and the list of flats that have voted and not voted, never the choice per flat. Residents see their own flat's choice.
- **Results:** committee sees live counts. Residents see counts after the poll closes. Closing: automatic at the closing time, or "Close now" by a managing role. A closed poll cannot be reopened or edited; a poll with no votes can be deleted.
- Opening a poll notifies all owners (kind `poll`, title `Poll: {question}`, link `polls`). No reminder.
- **Download:** the committee downloads the result (question, options with counts, flats voted, flats not voted) as CSV for the AGM file.

### 3.3 Staff register
- Staff: name (required), kind (`maid`, `driver`, `cook`, `cleaner`, `nanny`, `other`), mobile (optional, normalized), photo (optional), ID proof (optional, PDF or image), police verified (yes/no with date, set by the committee only), notes (committee only), active.
- **Who adds:** a resident (owner or tenant) adds staff linked to their own flat; the committee adds staff linked to any flats or to none (society staff such as a sweeper).
- **Linking existing staff:** a resident types the staff's mobile; if the society already has that person, they link their flat instead of creating a duplicate. A mobile is unique among active staff of a society.
- **Who sees what:**
  - committee (viewer roles): everything;
  - a resident: the society staff list with name, kind, photo and "Police verified" badge; mobile only for staff who work in their own flat; never the ID proof or notes.
- **Who edits:** the committee edits everything. A resident edits name, kind, mobile and photo of staff linked only to their own flat(s), and can unlink their flat. A resident can upload an ID proof for staff they add; after upload only the committee can see it.
- "Remove" = inactive (kept for history); only the committee removes.
- Files in a new private bucket `staff-files` at `{society_id}/{staff_id}/photo-{uuid}.jpg` and `{society_id}/{staff_id}/id-{uuid}.{ext}`; 5 MB limit; JPG, PNG, WEBP, PDF.

## 4. Constraints

- Migration `039_community.sql` (Gate Lite, planned but not built, moves to 040). `bun run db:bundle`.
- Plpgsql `SECURITY DEFINER SET search_path = public` RPCs, RLS default deny, grants to `authenticated`.
- English UI only. All plans, Free included.
- No change to how notices are published or how notifications are sent.
