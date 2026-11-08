# Departments — real org structure, with an auto Supervisor approval layer

## What this adds
A proper **Department** master-data module — not just a free-text field —
matching how a real HR org chart works:

- Every Employee Directory row can now be linked to one structured
  **Department** (Admin Panel -> Departments), instead of only a hand-typed
  word.
- Each Department can have a **Supervisor** — a real login account, not just
  a name — who can actually act on Approval Workflow requests in the app.
- **Unless turned off**, that Supervisor is automatically the **first layer**
  of the Approval Workflow for every Conveyance Bill Claim / Timesheet
  Correction / Leave Application an Employee in that Department submits —
  ahead of whatever Approval Template applies. No separate Template step
  needs to be built for "my manager approves first"; simply picking a
  Supervisor on the Department is enough.
- If nothing else is configured for a Department at all (no Supervisor, or
  the toggle is off), behavior is exactly what it was before this feature —
  requests route straight to whatever Approval Template applies, same as
  today.
- The "Include Supervisor in Approval Workflow" toggle lets you skip the
  Supervisor layer for a specific Department without removing the Supervisor
  assignment itself (still shown for org-chart purposes).

This is a genuinely separate concept from the existing Admin Panel ->
Employees -> Edit -> **Supervisor** tab, which is a purely informational,
possibly-multiple reporting line between two Employee Directory rows and was
never (and still isn't) wired into approvals — that stays exactly as-is.

## Where to use it
- **Admin Panel -> Departments** (new tab, its own permission module so you
  can grant it separately) — add/edit Departments, pick a Supervisor from
  any login account, toggle the auto-approval layer, activate/deactivate.
- **Admin Panel -> Employees -> Add/Edit -> Department** — now a dropdown of
  real Departments (with the Supervisor's name shown alongside each option)
  instead of a free-text box. The Department list also shows a small
  Supervisor tooltip on hover.
- Approval routing itself needs no separate setup per Employee — it's
  entirely driven by which Department the Employee belongs to.

## How the workflow actually behaves
1. Employee in "Accounts & Finance" (Supervisor: Jamal, auto-approval ON)
   submits a Timesheet Correction.
2. Request lands with Jamal first — Admin Panel -> Approvals (or Jamal's own
   personal "waiting on me" queue) shows it immediately.
3. Jamal approves -> it moves on to whatever Approval Template applies to
   that request type (if any) -> proceeds through that Template's own layers
   exactly as before.
4. If there's a Supervisor gate but no Template beneath it, the request still
   requires real review — it does **not** silently auto-approve just because
   no Template exists (previously "no Template" meant instant auto-approval;
   now it only does when there's neither a Supervisor gate nor a Template).
5. The Supervisor can never end up approving their own request — if an
   Employee IS the Department's own Supervisor, the auto-layer is skipped for
   them and their request goes straight to the Template.

## Files changed
- `server.ts` — `GET/POST/PUT/DELETE /api/departments`, `"departments"`
  added to `ADMIN_MODULE_KEYS`, and the actual approval-engine wiring:
  `createTemplateApprovalRequest` / `getCurrentStepApprovers` now insert the
  Department Supervisor as step 1 (Template steps shift down to 2, 3, ...),
  and the same shift was applied to `GET /api/approvals` and
  `GET /api/my-approvals`, which had their own duplicated step-resolution
  logic. `resolveDepartmentSupervisor` also now respects a Department's
  Active/Inactive state.
- `src/types.ts` — new `Department` interface, `"departments"` added to
  `AdminModuleKey` / `ADMIN_MODULES`, `Employee.department_id`.
- `src/components/AdminPanel.tsx` — new **Departments** tab (list + add/edit
  form: name, Supervisor picker, the two toggles).
- `src/components/EmployeesPanel.tsx` — Department field is now a dropdown
  of real Departments (was free text), with a Supervisor tooltip on the list.
- `src/components/GlobalSidebar.tsx` / `AdminSidebar.tsx` — nav entry for the
  new tab.

## Note on the database
Your `server.ts` already had the `departments` table, the
`all_employees.department_id` column, a one-time migration that seeds
Departments from whatever free-text values already existed and backfills
`department_id` for matching rows, and the `approval_requests.
supervisor_step_user_id` column — all self-healing `CREATE TABLE IF NOT
EXISTS` / `ADD COLUMN` statements that run automatically on startup, same
pattern as everywhere else in this file. Nothing further to run by hand;
just deploy.

## How to apply
Drop these 6 files into your project at the same relative paths (overwriting
the originals), then:
```
npm install
npm run build
```

## Verification note
`npm install` + a full `vite build` (+ the `esbuild` server bundle step) were
run against your actual dependency tree in this environment and completed
with **no errors** (exit code 0, `dist/` produced normally) after every step
of this feature.
