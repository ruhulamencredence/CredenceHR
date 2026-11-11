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
