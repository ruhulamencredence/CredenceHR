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
