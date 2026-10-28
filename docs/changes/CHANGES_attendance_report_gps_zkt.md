# Monthly Attendance Report — now the "final" Attendance (GPS + ZKT + remarks)

## What changed
The existing **Admin Panel → Monthly Attendance Report** tab is now the one
place that shows an account's *final* Attendance for a day — merging:
- **GPS** — Remote Attendance (Self Service → Check In/Out, project-based,
  location-verified)
- **ZKT** — Office Attendance (the office biometric device, auto-synced by
  `zkSync.ts` every 5 minutes)

Nothing about the underlying data changed — this was already computed live
by merging the two (GPS always wins when both exist for a day; ZKT only
fills in a day that has no GPS row at all), same as before. What changed is
that it's now clearly *labeled*, and Check In/Out remarks are shown too.

### Date Wise
- New **Source** column — an explicit **GPS** or **ZKT** badge (previously
  only office days got a badge; GPS days just showed the project name with
  no explicit label).
- New **Remarks** column — shows the Check In/Out remarks from the GPS/Remote
  row (ZKT punches never carry remarks, so this is blank on a ZKT day).

### Month Wise
- Hovering a day now also shows **GPS**/**ZKT** and any remarks in the
  tooltip, not just the project name.
- A small legend under the grid spells out what green/blue/amber/grey mean,
  so the P/H/Absent letters aren't the only cue.

### Header text
Updated to say plainly that this is the final, merged record from both
sources — instead of only mentioning Remote Attendance.

## Files changed (only these 3)
- `server.ts` — `GET /api/attendance/report/monthly` now includes
  `check_in_remarks` / `check_out_remarks` on each day (Date Wise already
  had these; only Month Wise was missing them).
- `src/types.ts` — `MonthlyAttendanceReportDay` gets the two new remarks
  fields.
- `src/components/AdminPanel.tsx` — Date Wise table (Source + Remarks
  columns), Month Wise tooltip + legend, header copy.

## How to apply
Drop these 3 files into your project at the same relative paths (overwriting
the originals), then:
```
npm install
npm run build
```
No database migration needed — this only reads columns that already exist.

## Verification note
`npm install` + a full `vite build` (+ the `esbuild` server bundle step) were
run against your actual dependency tree in this environment and completed
with **no errors** (exit code 0, `dist/` produced normally).
