# Monthly Leave Application — its own module + per-user Department scoping

## What this adds
A brand new, separately-grantable Admin Panel module: **Monthly Leave
Application** (`leave_applications`). Until now there was no way to hand an
Admin or a plain User account "just see everyone's Leave Applications" —
the closest thing, "Leave Approvals", is tied to the old approver workflow
(only Admin/Superadmin, and only ever shows applications where *you* were
picked as Approver), and "Leave Manage" is about editing Leave *balances*
(`can_manage_leave`), not viewing applications.

- Superadmin grants **Monthly Leave Application** to an Admin or a User from
  Admin Panel -> Users -> Module Access, same checkbox list as every other
  tab (Reports, Employees, Attendance Reports, etc.).
- Once granted, a new **"Department Access for this Report"** box appears
  (same pattern as the existing Monthly Attendance Report scoping) listing
  every real Department.
- **Leaving every Department unchecked keeps the account seeing every
  Department's Leave Applications** — the default, and the only behavior
  before this feature existed.
- Ticking one or more Departments restricts the account to only those
  Departments' Leave Applications, on both the report list and its
  Department filter dropdown.
- If the account is set as a Department's **Supervisor** (Admin Panel ->
  Departments), that Department is **pre-ticked** the first time this is
  set up for them — a sensible default, not a rule. It can be unticked
  (falling back to full/all-Department access, or whatever other
  Department(s) are ticked instead).
- The same scoping can be set for any account regardless of whether they
  supervise a Department at all, and works identically whether the account
  is role `admin` or role `user`.

## Where it's enforced
- Server-side: `GET /api/leave-applications/report` and
  `GET /api/leave-applications/report/departments` both check the account's
  scope (`getLeaveApplicationDeptScope`) and filter accordingly. A scoped
  account's Department dropdown only ever lists the Department(s) they're
  allowed to see, and requesting another Department directly via
  `?department=` is rejected with 403.
- A Superadmin is never scoped — always sees every Department.
- Completely independent of the old `GET /api/leave-applications` (Leave
  Approvals / decision workflow) — that endpoint, its approver-based
  visibility rules, and the Approve/Reject flow are all untouched.

## Where to use it
- **Admin Panel -> Users -> Module Access** (Superadmin only) — tick
  "Monthly Leave Application", then use the new Department checklist that
  appears underneath it.
- **Admin Panel -> Monthly Leave Application** (new tab, visible to anyone
  granted the module, or a Superadmin) — the read-only report itself:
  Employee, Department, Leave Type, Start/End Date, Days, Status, Approver,
  with a search box and a Department filter.

## New API
- `GET /api/users/:id/leave-application-departments` (Superadmin) — the
  Department names currently scoped for that account (empty = unrestricted).
- `PUT /api/users/:id/leave-application-departments` (Superadmin) — replaces
  the scoped set; only accepts real Department names.
- `GET /api/leave-applications/report/departments` (`leave_applications`
  module) — the Department names this account may filter by.
- `GET /api/leave-applications/report` (`leave_applications` module) — every
  Leave Application, Department-enriched and Department-scoped.

## Data
New table `leave_application_department_access (user_id, department)` —
additive on top of `admin_module_permissions`, same shape as the existing
`attendance_report_department_access`. Deleted automatically when the user
is deleted (FK cascade + explicit cleanup), and cleared when an Admin is
demoted back to a plain User (same as their other module grants). A
Department rename (Admin Panel -> Departments) updates any scope rows using
the old name so a grant never silently goes stale.
