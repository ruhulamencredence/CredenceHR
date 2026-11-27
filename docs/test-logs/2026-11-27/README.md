# 2026-11-27 — Bill Claim, day by day (branch `claude/attendance-device-rule`)

New Bill Claim form: a card per day of the From–To range, a chip per category
adds a bill already dated, one bar above the keyboard while a bill is typed,
"Same as <day before>", then a Review step and Submit. Same rules, routes and
server checks as before.

`scripts/bill-claim-by-day-ui.cjs` (phone 390×844, dev server of this branch):

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

# 2026-11-27 — Stone & Olive theme (branch `claude/attendance-device-rule`)

Profile → Appearance → Stone & Olive (`src/stoneOlive.css`, `src/lib/stoneTheme.ts`).
`scripts/stone-olive-ui.cjs` picks the theme the way a user does
(`mpr_bg_theme_v2 = stone`, no injected CSS), opens 21 screens on phone and
computer, and on each one looks for page errors and for colours outside the
theme (violet / blue / orange; `scripts/stone-olive-scan.js`):

```
ok m-dash off-theme colours: 1 errors: 0 {"bg":"stone","ui":"mono"}
ok m-dash2 off-theme colours: 5 errors: 0
ok m-leave off-theme colours: 4 errors: 0
ok m-billclaim off-theme colours: 6 errors: 0
ok m-myteam off-theme colours: 5 errors: 0
ok m-chat off-theme colours: 1 errors: 0
ok m-more off-theme colours: 1 errors: 0
ok m-confirm off-theme colours: 1 errors: 0
ok m-danger off-theme colours: 1 errors: 0
ok m-appearance off-theme colours: 2 errors: 0
ok m-approve off-theme colours: 2 errors: 0
ok m-map off-theme colours: 2 errors: 0
ok d-dash off-theme colours: 7 errors: 0
ok d-mail off-theme colours: 6 errors: 0
ok d-chat off-theme colours: 1 errors: 0
ok d-approve off-theme colours: 1 errors: 0
ok d-employees off-theme colours: 2 errors: 0
ok d-access off-theme colours: 0 errors: 0
ok d-dept off-theme colours: 0 errors: 0
ok m-login off-theme colours: 0 errors: 0
ok d-login off-theme colours: 0 errors: 0
```

No page errors. What the scan still counts is mostly on purpose: the earth-tone
avatar, amber for late / pending / "No pay", the attendance dial's hand.
`THEME=orange` with the same script: Orange looks as before (`data-ui="orange"`).

Screens: `stone-olive-phone.jpg` (Dashboard, Chat, a confirm popup,
Appearance), `stone-olive-web.jpg` (computer Dashboard).
