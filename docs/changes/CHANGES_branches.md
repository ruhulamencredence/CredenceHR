# Branches — Phase 1 (management only)

## Background / why a separate table instead of reusing Projects
`projects` isn't just an attendance concept in this app — it also backs MPR
Entries, Bulk Add Users logins ("Project Name + Password"), and Budget/Job
reports. Mixing Branch rows into that same table would make Branches show up
in all of those pickers too. So **Branch is a brand-new table**, completely
separate from Projects, and nothing about Projects/MPR/Budgets/Jobs changes.

## What's in this phase
Just **Branch management** — Admin Panel -> Branches, a new tab with the same
shape as the existing Projects tab (name, optional GPS pin + attendance
radius, list/search/edit/delete). This is a foundation only:

- No account is assigned to a Branch yet.
- Remote Attendance Check In/Out, Timesheet, and the "Correct Attendance"
  modal are untouched and still work exactly as before (Project-based).

That wiring — letting an Admin choose "Branch" or "Project" for an account,
and having Attendance/Timesheet honor it — is a bigger change (touches the
`attendance` table and ~8 query sites in server.ts) and is intentionally left
for a follow-up phase so this one stays small and reviewable.

## Files changed (9)
- `schema.sql` — new `branches` table (mirrors `projects`: name, GPS
  lat/lng/label, attendance radius). Includes the commented `ALTER`/`CREATE`
  block for an existing database, same convention as every other addition in
  this file.
- `server.ts` — `'branches'` added to `ADMIN_MODULE_KEYS`; new
  `GET/POST/PUT/DELETE /api/branches` (mirrors `/api/projects` — POST/PUT/
  DELETE gated the same way with `requireAdmin` + `requireModule("branches")`;
  GET is open to any signed-in account, no per-user permission table yet).
- `src/types.ts` — new `Branch` interface; `'branches'` added to
  `AdminModuleKey` / `ADMIN_MODULES` / `AdminNavRequest`.
- `src/components/AdminPanel.tsx` — new "Branches" tab: state, data loading,
  save/delete handlers, list+form UI, and its own `LocationMapPicker` instance
  — all a close mirror of the existing Projects tab.
- `src/components/GlobalSidebar.tsx` — "Branches" added to the Admin Panel
  drawer, next to Projects.
- `src/components/Navbar.tsx` — "Branches" added to the desktop "Manage"
  header menu, next to Projects. **Also includes your own latest status-bar
  color edit** (transparent overlay header padding comment/behavior) — merged
  in on top of the Branches change, not overwritten.
- `src/components/AdminSidebar.tsx` — updated for type consistency (this file
  isn't actually used anywhere anymore — GlobalSidebar replaced it — but it's
  still compiled, so its `AdminTab`/`counts` types needed the same addition).
- `src/App.tsx` — **your latest status-bar color edit** (native status bar
  now fully transparent — `StatusBar.setOverlaysWebView({ overlay: true })` —
  instead of a solid `#6300C6` fill). No Branches-related change in this file;
  included only so this zip reflects your current App.tsx, not an older one.

Module access to the new "Branches" tab is grantable per-Admin the same way
as every other tab, from Admin Panel -> Users -> Module Access (it's driven
generically off `ADMIN_MODULES`, no extra wiring needed there).

## How to apply
Drop these 7 files into your project at the same relative paths (overwriting
the originals), run the schema addition (or the commented block if your
database already exists), then:
```
npm install
npm run build
```

## Verification note
`npm install` + a full `vite build` (+ the `esbuild server.ts` bundle step)
were run against your actual dependency tree in this environment and
completed with **no errors** (exit code 0, `dist/` + `dist/server.cjs`
produced normally). A full project-wide `tsc --noEmit` still can't finish in
this sandbox on this codebase's size (same known limit noted in
`CHANGES_timesheet.md`) — please run your own `npm run build` before
deploying regardless.

## Next step (when you're ready)
Phase 2: add `branch_id` + a location-type choice ('project' vs 'branch') to
accounts, and update Remote Attendance check-in/out + Timesheet to check in
against a Branch's pin when that's what the account is assigned to.
