# Monthly Attendance Report + role-based permission

## What's new
A new Admin Panel tab: **Monthly Attendance Report**, with two views:
- **Month Wise** — every user, one row, P/absent grid across every day of a chosen month, plus Present/Absent totals.
- **Date Wise** — pick one date, see everyone split into Present (with check-in/out times) vs Absent.

It's gated by its own permission module (`attendance_reports`), separate from
the existing raw "Remote Attendance" log module — so your Superadmin can grant
**just this report** to any Admin or User account, independent of whether
they also get the raw log. This reuses the exact same `admin_module_permissions`
mechanism already in your app (Admin Panel -> Users -> Manage Modules), so no
new tables or UI concepts were introduced — the new module simply shows up as
one more checkbox there, assignable to Admin or User role accounts alike.

## Files changed (only these 5)
- `server.ts` — added `"attendance_reports"` to `ADMIN_MODULE_KEYS`; two new
  endpoints:
  - `GET /api/attendance/report/monthly?year=&month=&project_id=`
  - `GET /api/attendance/report/daily?date=&project_id=`
  Both gated by `requireAdmin` + `requireModule("attendance_reports")`, same
  pattern as every other module route. Both reuse the already-existing
  `SELECT * FROM attendance` / `projects` / `users` queries and roll the data
  up in JS, so the in-memory dev-mode DB fallback works with zero changes.
- `src/types.ts` — `attendance_reports` added to `AdminModuleKey` / `ADMIN_MODULES`
  / `AdminNavRequest`; new response types (`MonthlyAttendanceReport*`,
  `DailyAttendanceReport*`).
- `src/components/AdminPanel.tsx` — new tab body (Month Wise / Date Wise toggle,
  project/year/month/date filters, the two report tables).
- `src/components/AdminSidebar.tsx` — new mobile nav entry.
- `src/components/Navbar.tsx` — new entry in the desktop "Workforce" header menu.

## How to apply
Drop these 5 files into your project at the same relative paths (overwriting
the originals), then:
```
npm install
npm run build
```
No database migration is needed — `module_key` is a plain `VARCHAR(50)`, so
the new `attendance_reports` key just starts working the moment the server
restarts with this code.

## After deploying
Go to **Admin Panel -> Users -> Manage Modules** for whichever Admin or User
account should see the report, and check **"Monthly Attendance Report"**.

## Verification note
I don't have network access in this environment, so I could not run
`npm install` / a full `vite build` against your real dependency tree. I did
run the TypeScript compiler in isolation against each changed file (parser
only, since `@types/react` etc. aren't installed here) and confirmed there are
no syntax errors and no unresolved identifiers in the new code. Please still
run your own `npm run build` before deploying to catch anything a full,
fully-typed build would catch that a bare parser check can't.
