# Test log — 15 November 2026

## Users → Merge accounts (a hand-made login + the import's login for one person)

Logins opened by hand before the employee import, and then a second login per person made by the import
(Login ID = Employee ID). Admin Panel → Users → **Merge accounts** pairs each login with no employee to the
import's login (same email, Login ID / mobile, or name), shows what moves, and merges: every record on the old
login moves to the import's login, then the old login is deleted. Module access and password: the old login's
(suggested) or the import's. Behind the explicit Users layer `merge_accounts`.

Test data: `scripts/merge-seed.cjs` — Karim (old login: admin, 2 modules, chat on, 3 attendance days, own leave,
a leave he approved, a bill claim; import login with "tasks"), Rafiq (same email), Sumon (same name as two
employees), a stranger with no match.

- `scripts/merge-api.sh`: **21/21** — no layer → 403 (candidates and merge), layer → 200; a Superadmin and a login
  linked to an employee can't be merged away; 2 merged; old logins gone; attendance 3, own leave, the leave he
  approved (`decided_by`), bill claim all on the kept login; module access + role + switches from the old login;
  email carried over; signs in with Employee ID or old email + the old password, the import password no longer
  works; employee still linked; logged; nothing left pointing at the old id; an HR approval step's
  `approver_user_ids` list updated.
- `scripts/merge-ui.cjs`: **17/17** — button on Users; Karim (name) and Rafiq (email) found and ticked; Sumon flagged
  "more than one" and not ticked; the stranger "No match found"; What moves = 6 records (attendance 3, leave 2,
  claim 1) + access rows apart; picking MRG-904 by hand ticks it; "Keep the employee login's" access and password;
  red confirm; "3 merged."; access stays "tasks", role "user", import password works; records still moved;
  Sumon merged into MRG-904 with the email; History lists the merges; no page errors.

## Departments → team: add people by project, from any department, new joiners by themselves

One Supervisor can lead people from several projects (work stations) and departments. Edit Department → a team →
**Add people by project**: pick a Department (this one, all, or another), one or more Work stations, tick or Select all,
"Add N to team". Members are grouped by work station; "Remove all" per work station. A rule adds new joiners at those
work stations (in that Department, or any) to the team by themselves.

Test data: `scripts/teams-seed.cjs` — Inventory QA (3 at Gulshan Tower, 2 at Banani Site, 1 at Uttara Project),
Accounts QA (Faruk at Gulshan Tower, in an Accounts team).

- `scripts/teams-by-project-api.sh`: **19/19** — the pool has every department's people with work station, department
  and current team; a team saved with Faruk (Accounts) + two rules; Faruk left the Accounts team; his Supervisor resolves
  to this team's; new joiners: Gulshan + Inventory added, Gulshan + Accounts not (rule is Inventory only), Uttara + any
  department added, Banani not (no rule), an older Uttara employee not; one taken out by hand is not re-added; an unchanged
  rule keeps its date; a removed rule is gone; an unknown employee id → 400.
- `scripts/teams-by-project-ui.cjs`: **11/11** — work stations with counts; Gulshan + Banani → 5; Select all → added,
  grouped 3 + 2; rule chips; "All departments" shows Faruk "now in Accounts QA team"; warnings (another department,
  moves from another team); his chip names his department; one taken out; Save → members and both rules stored, Faruk
  out of the Accounts team; no page errors.
