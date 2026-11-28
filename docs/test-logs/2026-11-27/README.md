# 2026-11-27 — Bill Claim, day by day

New Bill Claim form: a card per day of the From–To range, a chip per category
adds a bill already dated, one bar above the keyboard while a bill is typed,
"Same as <day before>", then a Review step and Submit. Same rules, routes and
server checks as before.

`scripts/bill-claim-by-day-ui.cjs` (phone 390×844, dev server :3200; first written on `claude/attendance-device-rule`, brought here 28 Nov):

```
PASS From two days ago to today → 3 day cards
PASS a chip opens the bill with one bar: Cancel / Add
PASS the popup's own Cancel / Review wait while the bill is typed
PASS the Amount is ready to type in
PASS Enter on the keyboard adds it
PASS day 1 shows its own total ৳730.00
PASS "Same as" copies the day before's bills
PASS Add with no amount → "Enter an amount greater than 0."
PASS Cancel on a new bill drops it
PASS Cancel on a changed bill puts it back (৳650)
PASS Claim total ৳970.00
PASS keyboard open: the Amount being typed is in view
PASS keyboard open: Done is just above the keyboard
PASS Review: ৳970.00, Toll × 2, Fuel, Parking
PASS Back returns to the days, bills kept
PASS claim filed: 2026-11-25 – 2026-11-27, ৳970.00
PASS each bill on its own date: 2026-11-25=80.00,2026-11-25=650.00,2026-11-26=120.00,2026-11-27=120.00
PASS no page errors
ALL PASS
```

Screens: `bill-claim-by-day.png`, `bill-claim-keyboard.png`, `bill-claim-review.png`.
