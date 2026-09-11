# Conveyance Disbursement — backend

Backend for the "Conveyance Disbursement" Admin Panel module (frontend was
built in an earlier pass — `src/components/DisbursementPanel.tsx` and its
wiring into `AdminPanel.tsx` / `Navbar.tsx` / `GlobalSidebar.tsx`). This adds
the server side: new columns, new routes, and the permission gate.

## What this adds

- **New `disbursement` AdminModuleKey** (`server.ts` → `ADMIN_MODULE_KEYS`).
  Grantable to Superadmin + any Admin via the existing Admin Panel -> Users ->
  Module Access modal — no new UI needed, it already loops over
  `ADMIN_MODULES`. Deliberately separate from the `conveyance` module, so an
  Admin can be trusted to BUILD Conveyance Bills without also being trusted to
  authorize payouts, and vice versa.
- **`conveyance_bills` gets 4 new columns**: `is_disbursed`, `voucher_no`,
  `disbursed_at`, `disbursed_by`. Added to the `CREATE TABLE IF NOT EXISTS`
  for fresh installs, and as individual `ALTER TABLE ... ADD COLUMN`
  migrations (each its own try/catch, ignored once the column exists) for
  installs that already had the table — same pattern as every other
  additive column in this file.
- **`POST /api/conveyance-bills/:id/disburse`** — marks a Bill disbursed.
  Rejects if already disbursed or if the Bill has no line items yet.
  Auto-suggests a `PV-<billId>-<YYYYMMDD>` voucher number if the client
  doesn't send one (so a bulk "Disburse Selected" call, which sends none per
  bill, still gets one each); a single manual disburse can still send its own
  edited value. Best-effort notifies the claimant via the existing Alerts
  system (`conveyance_disbursed`, added to `AlertType`).
- **`POST /api/conveyance-bills/:id/undisburse`** — clears
  `is_disbursed`/`voucher_no`/`disbursed_at`/`disbursed_by` back to Pending,
  so a mistaken disbursement can be corrected and re-done.
- **`GET /api/conveyance-bills`** and **`GET /api/conveyance-bills/:id`** —
  now also return `disbursed_by_name` (joined), and are gated by a new
  `requireAnyModule(["conveyance", "disbursement"])` helper instead of
  `requireModule("conveyance")` alone, since the Disbursement panel reuses
  these same list/detail endpoints and a disbursement-only Admin needs to be
  able to call them without also holding the `conveyance` module.
- **`DELETE /api/conveyance-bills/:id`** — now refuses to delete a Bill that's
  already disbursed (money already paid out shouldn't just vanish); it has to
  be undone first.

## Frontend fix + enhancement bundled in

`DisbursementPanel.tsx`'s "Print Payment Voucher" was reading `bill.items`
straight off the list row, but the list endpoint only ever returns
`item_count`/`total_amount`, never `items` — so the printed voucher would
have come out with zero line items. The PDF-building code was pulled out
into a shared `buildAndSaveVoucherPdf(billId)` helper that always fetches
`GET /api/conveyance-bills/:id` (full detail, with items) first.

That helper is now also called automatically right after a successful
disburse — single or bulk. Confirming disbursement:
1. Calls `POST .../disburse` for every selected Bill.
2. Refreshes the list.
3. Downloads a Payment Voucher PDF for each just-disbursed Bill, one at a
   time (so any native "save file" prompt doesn't overlap the next).

The confirm modal stays open through all of this — "Disbursing…" during
step 1, "Preparing voucher(s)…" during step 3 — so it isn't dismissed
mid-download. A PDF that fails to build/save doesn't undo the disbursement
itself (already saved server-side); it can always be reprinted later from
the per-row Printer button, which now shares the same helper.

## Where to use it

- **Admin Panel -> Users -> Module Access** — grant/revoke "Conveyance
  Disbursement" per Admin, same as every other module.
- **Admin Panel -> Conveyance Disbursement** (Workforce menu on desktop, or
  the mobile drawer) — list Pending/Disbursed/All Bills, filter by User,
  select one or many Pending Bills to disburse together, print a Payment
  Voucher for any disbursed Bill, or Undo one back to Pending.

## Not done here

Nothing outstanding — this closes out the feature end to end (schema, API,
permissions, and the one frontend gap found while wiring it up).
