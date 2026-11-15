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
