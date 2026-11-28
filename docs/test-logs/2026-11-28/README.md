# 2026-11-28 — Bill Claim: each bill's own receipt

A category with "Receipt" ticked in Bill Claim Policy now needs a receipt
(photo or PDF, up to 3 per bill, 5MB each) on every one of its bills, added
inside the bill. Stored in `bill_claim_item_files`.

`scripts/bill-receipts-per-bill.cjs` (dev server :3200; local policy:
enforce_category_limits = 1, Fuel / Parking / Food Allowance with Receipt):

```
PASS Fuel (Receipt ticked): the bill shows "Receipt *"
PASS a photo picked → its thumbnail in the bill
PASS keyboard open: amount, receipt and Add all in view
PASS Toll (no Receipt tick): "Receipt (optional)"
PASS Fuel row: 📎 1
PASS Parking row: red "receipt needed"
PASS a note under the total says which bill still needs it
PASS Review is refused while a receipt is missing
PASS Review: "Receipts 2 files", Toll "not needed"
PASS the claim's own file is now "Other attachment (optional)"
PASS filed: each receipt on its own bill (Fuel:image/jpeg, Parking:application/pdf)
PASS no page errors
PASS my claims: each bill lists its receipts (name, no file data)
PASS owner opens the receipt (same bytes)
PASS a colleague without Bill Claim can't open it (403)
PASS Superadmin opens it
PASS approval details: a Receipt column and one attachment per receipt
PASS approvers open a receipt through approval-details (&file=)
PASS …and someone outside the chain can't (403)
PASS edit: kept receipts move to the rewritten bills, the new one is added (Fuel:2,Parking:1)
PASS the kept receipt is the same file (not re-uploaded)
PASS server refuses a Parking bill without its receipt: "Bill 2: attach the receipt for Parking (photo or PDF)."
PASS more than 3 receipts on a bill is refused
PASS a non-photo / non-PDF receipt is refused
PASS an older form's claim with one claim file still goes in (201)
ALL PASS
```

`../2026-11-27/scripts/bill-claim-by-day-ui.cjs` re-run with no Receipt ticks
(it adds bills without receipts): ALL PASS — the day-by-day form is unchanged.

Screens: `receipts-keyboard.png`, `receipts-list.png`, `receipts-review.png`.

## Personal mobile only in Admin Panel -> Employees

`all_employees.mobile` (Employee Info -> Personal Contact -> Personal Mobile)
is no longer sent anywhere else. My Team, HR 360, HR Reports ("Contact No."
column, same key `mobile`), Vehicle drivers, Asset handover, the SIM list's
employee picker and Headcount now use the office Contact No. (`phone`), or
nothing. Copies already saved on rides (`driver_mobile`) and asset handovers
(`handed_to_mobile`, `return_via_mobile`) are replaced at server start.

`scripts/personal-mobile-only-in-employees.cjs` (a team member given personal
01711000111 and office 01999000222, put back afterwards):

```
PASS a team member: Farhana Yasmin
PASS My Team shows the office Contact No.: 01999000222
PASS the personal mobile is nowhere in the reply
PASS no office number → no phone (not the personal one)
PASS HR 360: office Contact No., no personal mobile
PASS HR Reports "Contact No." column: office number only
PASS HR Reports column is labelled "Contact No."
PASS Vehicle -> Drivers employee list: office Contact No. (01999000222)
PASS Vehicle -> Drivers list: no personal mobile
```

## Leave Summary: the head cut out around the leave card, every theme

The coloured head of the Leave Summary card is now cut out around the inner
leave card with an 8px gap (src/lib/leaveCarve.ts, a CSS mask redrawn when
either changes size) in every theme and colour mode — before, only on the
Stone & Olive branch.

`scripts/leave-carve-all-themes.cjs` (mobile 390px and desktop 1440px; the
head's mask was set in every case):

```
mobile/desktop  Orange · Light, Default · Light, Apple Glow · Light, Mono · Light,
                Orange · Light Glass, Orange · Dark, Orange · Dark Glass   mask: true
```

Screens: `carve-all-mobile.png`, `carve-all-desktop.png`. In Dark Glass the head
has no colour of its own, so there is nothing to see cut.
