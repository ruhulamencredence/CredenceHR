# Remote Attendance — per-account Project lock

Lets a Superadmin/Admin pin a `user` OR `admin` account to exactly one
Project for Remote Attendance, right next to the existing `can_use_attendance`
toggle. Once pinned, that account's own Check In/Out is locked to that one
Project — it can't pick any other one, even an `admin` account which is
otherwise unrestricted on Projects everywhere else in the app.

**Scope: Attendance only.** The general "select project" dropdown used
throughout Budget/Jobs/MPR (Select a Budget, Job Entry, `user_project_permissions`,
the "Manage Projects" modal) is completely untouched by this — it keeps
working exactly as before for every account, pinned or not.

## What this adds

- **`users.attendance_project_id`** — new nullable `INT` column, FK to
  `projects(id) ON DELETE SET NULL` (so deleting a Project just clears the
  pin instead of blocking the delete). `NULL` by default for every existing
  account = unrestricted, today's behavior. Migration added as its own
  try/catch `ALTER TABLE`, same pattern as every other additive column in
  `server.ts`. Never set for `role = 'superadmin'`.
- **`PUT /api/users/:id/feature-permissions`** now also accepts
  `attendance_project_id` (a Project id, or `null` to clear it back to
  unrestricted) alongside the existing toggle fields — same "send only what
  changed" contract. Silently ignored if the target account is a
  `superadmin`.
- **`GET /api/users`, `POST /api/auth/login`, `GET /api/auth/me`** all now
  return `attendance_project_id` (always `null` for `superadmin`) so the
  Admin Panel and the account's own session both know about the pin without
  an extra round trip.
- **Server-side enforcement (`AttendanceRoutes.ts`)** — `getAllowedProjectIds()`,
  which already gated which Projects a plain `user` may check in/out
  against, now checks `attendance_project_id` FIRST for any non-superadmin
  account. If set, it's the only Project id allowed — overriding the
  "Admin sees every Project" rule this function already had. Enforced on
  both `POST /api/attendance/check-in` and `/check-out`, so this can't be
  bypassed by a direct API call even if the client-side dropdown is tampered
  with.
- **Admin Panel -> Users** — new "Attend. Project" column, right after
  "Attend.": a `<select>` of every Project (plus "Unrestricted"), disabled
  until `can_use_attendance` is granted. Uses the same
  `/feature-permissions` endpoint as the toggle next to it. Shows `—` for
  the Superadmin row, same as every other per-account permission column.
- **User Panel (`UserPanel.tsx`)** — the Attendance card (mobile dashboard +
  desktop) now receives a filtered `attendanceProjects` list instead of the
  full `projects` list: just the one pinned Project when
  `user.attendance_project_id` is set, otherwise unchanged. This is a
  client-side convenience (skips the dropdown entirely when there's only one
  option) — the real gate is server-side, above.
