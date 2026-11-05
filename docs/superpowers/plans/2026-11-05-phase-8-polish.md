# Phase 8 — Deferred minors that people would notice

**Goal:** Clear the reviewers' deferred minors that change what a person sees or does, with no new database migration. Those listed in `docs/superpowers/autonomous-run-report.md` stay deferred unless they appear here.

- **Resident:**
  - tenants see no payment history and no Bills screen, even from a notification link;
  - switching to a rented flat leaves the owner-only tabs;
  - the latest-bill card skips cancelled bills (Phase 5 M1, M2).
- **Secretary:**
  - the phone "More" sheet shows only what the bar does not, under group headings;
  - the Home heading reads "Home";
  - Flats & residents from the menu opens on Flats (Phase 4C M9, M10, M11).
- **Home cards:**
  - loading spinners instead of "Nothing is due" while lists load;
  - errors are shown;
  - "already reminded today" is reported;
  - singular and plural wording (Phase 4C M3, M5, M6).
- **My account:** a period running past today shows "Balance today" (Phase 5 M3).
- **Bill page:** the advance line appears only on bills that still ask for payment (Phase 4A M6).
- **Middleware:** the protected prefix `/bill/` no longer matches `/billing…` (Phase 4A M12).
- **Log out of all devices** removes every push subscription of the account (Phase 3C M3).
- **Platform:**
  - the funnel's median time is in minutes, hours or days;
  - "stopped at" is in step order;
  - Society health lists stuck, then quiet societies first (Phase 6 M6, M7).
