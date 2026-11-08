# Leave Summary — Dashboard card

## What's new
A "Leave Summary" card on the User Panel Dashboard (mobile drop-banner section
+ desktop), inspired by the reference image's layout but built with this
app's own violet-gradient header/shape and color tokens (`--g-gradient`,
`--g-accent`) instead of copying the reference's illustration/status-bar.

- **Total Leave** strip — Available (sum of remaining Casual/Sick/Without-Pay
  balance) and Leave Used (day_count of every application that isn't
  rejected — rejections refund their balance server-side already, so this
  always matches what's actually been spent).
- **3 tables** as three tabs, exactly as asked: **Review** (pending),
  **Approved**, **Rejected** — a submitted application always starts in
  Review, then moves into Approved or Rejected once decided (Self Service ->
  Leave Approvals), never both.
- **Submit Leave** button opens the existing `NewLeaveApplicationModal` (no
  changes to that form) and refreshes the card on success.
- Not permission-gated — every User/Admin account can apply for Leave, same
  as the existing "Self Service" menu.

## No backend or type changes needed
Every endpoint this card calls already existed and already returned exactly
the shape needed (`GET /api/leave-applications/mine`, `GET /api/leave-balances`,
`POST /api/leave-applications` via the existing modal) — so this was a
pure frontend addition.

## Files changed (only these 2)
- `src/components/LeaveSummaryCard.tsx` — **new** component.
- `src/components/UserPanel.tsx` — imports it and renders it right after the
  Remote Attendance card, both on the mobile Dashboard and the desktop view
  (same responsive show/hide pattern already used for Remote Attendance).

## How to apply
Drop these 2 files into your project at the same relative paths (the first
is brand new, the second overwrites your existing one), then:
```
npm install
npm run build
```

## Verification note
No network access here, so I couldn't run `npm install`/a full build against
your real dependency tree. I ran the TypeScript compiler standalone against
both files (parser + name-resolution only, since `@types/react` isn't
installed in this sandbox) and got zero syntax errors and zero unresolved
names. Please still run your own `npm run build` before deploying.
