# 2026-11-23 — Self Service → My Team

A Head of Department, a team Supervisor or a Direct Supervisor sees their own
people on the Dashboard: today's Present / Late / On leave / Not in yet, the
full list (search, status filter, grouped by how each person is under them)
and one person's card (today, this month so far, Call / Mail). No module and
no per-account switch (owner's decision); the server works out the team from
the database on every request.

## Tests (dev server :3200, local MariaDB)
- `my-team-api.txt` — 24/24: Head sees the whole Department (not the one who
  resigned, not other Departments, the Employee with no login included);
  team Supervisor sees team members from any Department, plus "everyone else";
  Direct Supervisor sees only their report; today present / late / leave /
  not in; summary counts; outsider and Superadmin get nothing extra and 403
  on a person; month so far, and no "absent every day" for someone with no
  attendance recorded; losing the Head role ends it at once.
- `my-team-ui.txt` — 19/19: phone card with the four counts and who is late;
  See all page grouped "Head of …", Casual Leave, In time + Project; Late
  filter; search; person card with this month, Call link, "Under you as";
  computer card; no card for an account with nobody under it.
- Screenshots: `my-team-card-phone.png`, `my-team-page-phone.png`,
  `my-team-person-phone.png`, `my-team-card-desktop.png`.

Note: the UI test writes its output to /tmp while it runs — the dev server
reloads the page whenever a file under docs/ changes.

# Phone Leave page — "Given for <year>" and Apply Leave at the bottom

- A thin row at the top of the gauge card: what each leave type's balance was
  this year = days left + approved this year + still waiting for approval
  (a pending application is taken off the balance when it's sent). No pay
  shows "No limit". A tapped type shows Given / Taken / Waiting / Left.
- Apply Leave no longer sits in the card: it floats centred above the bottom
  bar, the same pill and place as Check In/Out's "Add Check In/Out", only
  while the Leave page is showing and not while the form is open.
- `leave-given-ui.txt` — 13/13; screenshots `leave-given-phone.png`,
  `leave-given-casual-phone.png`.

# My Attendance: no "Set again" text

The Out Time box no longer shows "Set again". For an account allowed to give
the Out again (users.can_update_check_out) the box itself is tapped; it asks
first, as before. For anyone else the box does nothing.
- `out-again-tap-ui.txt` — 9/9; screenshot `out-again-card.png`.
