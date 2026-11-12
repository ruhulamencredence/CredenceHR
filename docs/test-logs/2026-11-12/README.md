# Head of Department + teams with their own Supervisor

Test server :3200 on the test database (`scripts/dept-setup.sql`). Finance:
Accounts team (Supervisor Imran) = Sadia, Rafiq, Imran; Treasury team
(Supervisor Farhana); Head = Tahmid; Kamal in no team. Timesheet template:
Layer 1 Nasrin, Layer 2 Kamal. Requests = attendance corrections.

| Check | Result |
|---|---|
| API (`dept-api.mjs`): only Departments + edit_add can read / save teams; a person in two teams, someone from another Department, a team without a Supervisor, two "everyone else" teams refused; Rafiq: Imran → Head Tahmid → Nasrin → Kamal, step by step, another team's Supervisor neither sees nor can approve (403), the Head can't jump ahead; Kamal in no team → Head first; a Supervisor's own request → Head first; the Head's own → workflow only; a Direct Supervisor still comes first; moving Rafiq to another team moves his waiting request; a new Head takes the waiting Head step; no Head → on to the template; "everyone else" team catches people in no team | 33/33 |
| Screen (`dept-ui.mjs`): list with Head / Teams / Approval columns; Edit with Head picker and team cards (search to pick Supervisor and members); a new team saved; fits a phone; no page errors | 7/7 |
| One-time migration on startup: MIS had Supervisor Tanvir with "include in approval" on → "MIS team" (Supervisor Tanvir, everyone else) and Head Tanvir; HR had it off → nothing (as before) | as expected |

Changed test: `2026-10-25/scripts/qa-e2e-pickers.mjs` PK-06 — the Department
picker is now the Head of Department (it checked the old Supervisor field).

# Mobile App (APK) access for many at once, and for new accounts

| Check | Result |
|---|---|
| API (`app-access-api.mjs`): reading / changing needs Module Access granting; an account with the app off can't get into the app but can use the website; Users list shows `app_on`; 3 turned on in one request (Superadmin skipped), access log written; off again; a delegated Admin changes plain Users only and can't change the setting; a new account has nothing set (NULL) and gets into the app straight away while "New accounts get the Mobile App" is on, not when it is off; an account turned on by hand keeps it | 18/18 |
| Screen (`app-access-ui.mjs`): banner "6 accounts can't use the Mobile App yet", "No app" labels, setting shown On, Show them, bulk bar Turn on (2), Turn on for all → none left, banner gone, no page errors | 9/9 |

Note: existing accounts keep their own value (on or off); accounts that were
off stay off until turned on — the banner shows them.

# HR Quick reports (probation, joiners, transfers, resignations, religion)

Test server :3200 on the test database (`scripts/quick-setup.sql`, dates
relative to today): Tanvir probation ends in 9 days, Rafiq 11 days overdue,
Imran in 60 days, Sadia confirmed today; Rumana and Jahid joined this month;
two transfers this month (one later in the month, not yet applied) and one in
2025; exits — Tanvir (clearance 3/5, 8 days left), Imran (22 days), Sadia
termination (45 days), Nasrin settled last month, Kamal cancelled; religions
incl. "muslim" spelling, one inactive, Rumana not recorded.

| Check | Result |
|---|---|
| API (`quick-api.mjs`): the five summary numbers; each report's rows, order, filters (Department, Period, type), onboarding and clearance progress, reasons, turnover (only those already gone), no money fields; unknown report 404; bad dates fall back to this month; no token 401; no HR Operations 403; HR Operations with no layers ticked → allowed (default); layers ticked without Quick reports → 403 on all six routes while HR Operations still opens; ticked → allowed; existing "read" holders get the layer once (`quick-grant.ts`), unticking sticks | 42/42 |
| Screen (`quick-ui.mjs`): Admin Dashboard "HR reports" card (2 probation, Islam 6); tap Resignations → HR Operations → Reports → Quick reports with Resignations open; Probation (overdue / due soon / Confirmed in period); Religion → Not recorded → Rumana; Transfers + Excel + PDF downloads + This year; New joiners → row → Service Book; Build your own still opens Employee Reports; phone fits; no page errors; an account without the layer sees no card, no Quick reports tab, no menu item; ticked → card shows | 22/22 |
