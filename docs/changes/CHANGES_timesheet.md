# Timesheet (My Attendance — Month Wise / Day Wise / Custom Range) + logo-to-dashboard

## What's new

### 1. "Timesheet" — every account's own Attendance report
A new Self Service page, **Timesheet**, available to every account (mobile
APK, narrow/mobile web, and desktop web) with three views:
- **Month Wise** — pick a year + month, see every day of that month with
  Present/Absent, In Time, Out Time, and Project — plus Present/Absent totals.
- **Day Wise** — pick a single date, see full detail (every Project checked
  into that day, in/out times, distance from site, remarks, approval status),
  or "Absent" if nothing was recorded.
- **Custom Range** — pick a From/To date, same day-by-day report as Month
  Wise but for any date span (capped at 366 days).

No new server endpoint was needed — it reuses the existing
`GET /api/attendance/mine` (the same call `AttendanceCard` already uses for
"today's" status), just sliced client-side by month/day/range.

Reachable from:
- **Web (desktop)** — Navbar's "Self Service" header dropdown → **Timesheet**
  (new, listed first).
- **Mobile / narrow web (hamburger drawer)** — GlobalSidebar's "SELF SERVICE"
  section → **Timesheet** (new, listed first).

### 2. Header logo → Dashboard (web)
On desktop web, clicking the Credence logo in the header now takes you back
to the User Panel dashboard (leaving any Self Service page like Leave
Application / Timesheet), the same way GlobalSidebar's own "Dashboard" link
already worked on mobile.

## Files changed (only these 4)
- `src/components/Timesheet.tsx` — **new file**, the Timesheet page itself.
- `src/App.tsx` — imports `Timesheet`, adds `'timesheet'` to the Self Service
  view state, renders `<Timesheet>` when selected, and wires the Navbar's new
  `onGoToDashboard` (logo click) to leave Self Service / land on the
  dashboard.
- `src/components/Navbar.tsx` — new `onGoToDashboard` prop (logo is now a
  button), `'timesheet'` added to the Self Service menu type, and a new
  "Timesheet" item in the Self Service dropdown.
- `src/components/GlobalSidebar.tsx` — `'timesheet'` added to the Self
  Service menu type, and a new "Timesheet" item in the drawer's SELF SERVICE
  section.

## How to apply
Drop these files into your project at the same relative paths (overwriting
the originals), then:
```
npm install
npm run build
```

## Verification note
`npm install` + a full `vite build` were run against your actual dependency
tree in this environment and completed with **no errors** (exit code 0,
`dist/` produced normally) — this covers all 4 changed files plus every file
that imports them. A full `tsc --noEmit` project-wide type-check could not
finish in this sandbox (the existing 14,000+ line codebase runs out of the
sandbox's memory/time on a full check, unrelated to this change), so please
still run your own `npm run build` / `tsc` before deploying to catch
anything a full, fully-typed check would catch that the build step doesn't.
