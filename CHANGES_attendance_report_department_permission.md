# Monthly Attendance Report — per-user Department scoping

## What this adds
Until now, the `attendance_reports` Admin Panel module (Admin Panel -> Users
-> Module Access -> "Monthly Attendance Report") was all-or-nothing: any
Admin or User account granted it could see every Department's rows on the
Monthly Attendance Report (Month Wise), the Date Wise report, and the
Department filter dropdown.

This adds an **optional, per-account Department scope** on top of that same
module grant:

- When a Superadmin ticks **Monthly Attendance Report** for an Admin or User
  in the Module Access modal, a new **"Department Access for this Report"**
  box appears with a checklist of every real Department.
- **Leaving every Department unchecked keeps today's behavior** — the
  account sees all Departments. This is the default for every existing grant
  (nothing changes for anyone until a Superadmin explicitly ticks a
  Department for them).
- Ticking one or more Departments restricts that account to only those
  Departments on the Monthly Attendance Report, the Date Wise report, and
  the Department filter dropdown.
- If the account being granted this is set as the **Supervisor** of a
  Department (Admin Panel -> Departments), that Department is **pre-ticked**
  the first time this is set up for them — a sensible default, not a rule.
  It can be unticked (falling back to full/all-Department access, or to
  whatever other Departments are ticked instead).
- The same scoping can be set for any account regardless of whether they
  supervise a Department at all — a Superadmin can hand-pick any single
  Department, or several, for anyone with the module granted.

## Where it's enforced
- Server-side, not just hidden in the UI: `GET /api/attendance/report/*`
  (departments, monthly, daily) all check the account's scope and filter
  accordingly. A scoped account's Department dropdown only ever lists the
  Department(s) they're allowed to see, and requesting another Department
  directly (e.g. via the API) is rejected with 403.
- A Superadmin is never scoped — always sees every Department, same as
  before.

## Where to use it
- **Admin Panel -> Users -> Module Access** (Superadmin only) — tick
  "Monthly Attendance Report", then use the new Department checklist that
  appears underneath it.

## New API
- `GET /api/users/:id/attendance-report-departments` (Superadmin) — the
  Department names currently scoped for that account (empty = unrestricted).
- `PUT /api/users/:id/attendance-report-departments` (Superadmin) — replaces
  the scoped set; only accepts real Department names.

## Data
New table `attendance_report_department_access (user_id, department)` —
additive on top of `admin_module_permissions`. Deleted automatically when
the user is deleted, and cleared when an Admin is demoted back to a plain
User (same as their other module grants). A Department rename (Admin Panel
-> Departments) updates any scope rows using the old name so a grant never
silently goes stale.
