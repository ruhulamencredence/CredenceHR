# Timesheet — "Correct Attendance" no longer blocked by Project permission

## The bug
Opening **Timesheet → click a date → Correct Attendance** would often show:

> "You don't have any Project to correct attendance against."

...with no dropdown, so the request couldn't be submitted at all.

**Root cause:** the Project picker in that modal was fed from `GET
/api/projects`, which (for a non-Admin) only returns Projects the Admin has
explicitly granted that account via *Admin Panel → Users → Manage Projects*.
Any Employee with **no** Project explicitly granted saw an empty list, even
though `POST /api/attendance/corrections` (the endpoint that actually submits
the request) never checked that permission in the first place — it only
checks the Project exists, then routes the request through the Approval
Workflow exactly like any other correction. So the permission check was only
ever blocking the *form*, never the *request*.

## The fix
Every account can now submit a Timesheet correction for **any** Project, and
it goes to the normal Approval Workflow queue (Admin Panel → Approvals) same
as before — nothing about how corrections are approved/rejected changed.

- **`server.ts`** — new endpoint `GET /api/projects/all`: every Project,
  unfiltered by `user_project_permissions`, open to any signed-in account.
  (The existing `GET /api/projects` is untouched — Check-In/Check-Out and the
  Admin panels still use the permission-filtered list, since which Projects
  an account can actively check into is a separate, still-enforced rule.)
- **`src/components/Timesheet.tsx`** — now loads Projects from
  `/api/projects/all` instead of `/api/projects`, so the Correct Attendance
  picker (and the Project-name lookup used when viewing a past correction's
  status) always has the full list.

## Files changed (only these 2)
- `server.ts`
- `src/components/Timesheet.tsx`
(`src/components/AttendanceCorrectionModal.tsx` — comment-only update, no
behavior change.)

## How to apply
Drop these files into your project at the same relative paths (overwriting
the originals), then:
```
npm install
npm run build
```

## Verification note
`npm install` + a full `vite build` (+ the `esbuild` server bundle step) were
run against your actual dependency tree in this environment and completed
with **no errors** (exit code 0, `dist/` produced normally).
