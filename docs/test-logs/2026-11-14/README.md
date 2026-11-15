# Test log — 2026-11-14
## Personal mobile hidden outside Employees

Employee Directory, Chat contact info and the AI Assistant's colleague search now show only the office
Contact No. (`all_employees.phone`). The personal mobile (`all_employees.mobile`) is no longer sent by
those APIs; it stays in Admin Panel -> Employees -> Personal Contact.

Setup: `UPDATE all_employees SET phone='01711000001', mobile='01999000002' WHERE id=36;`

- `scripts/personal-phone-api.mjs admin@credence.test` — 10/10 (directory as employee and Superadmin: no
  personal number, no `mobile` field, office number present; Employees list keeps both).
- `scripts/personal-phone-ui.cjs <outdir>` — directory desktop + phone and the detail card show no personal
  number; Employees table shows the office number. 7/8: the one fail is the check for the office number on
  the phone list, where the list cards don't print a number; the phone detail card shows `01711-000001 Office`.

## Chat: "New chat" picker slow, and jumping while searching

Cause: the people picker drew one row (with a photo request) for every account — 1,500 people meant
1,517 photo requests the moment it opened — and the popup had no fixed height, so it grew and shrank with
every letter typed. Fix (src/components/ChatPanel.tsx, `MemberPickerModal`): the first 40 matches are drawn
("Showing 40 of N — type to search, or show more"), the popup has a fixed height, and "Loading people…" shows
until the list arrives (instead of "No one matches").

Test: 1,500 extra accounts on the test DB, `scripts/chat-new-chat-picker.cjs <outdir> before|after`:

| | before | after |
|---|---|---|
| photo requests on open | 1,517 | 40 |
| rows drawn | 1,517 | 41 |
| popup height while searching | 720 -> 282 -> 294 -> 283 -> 720 | 600 every time |

## Onboarding: login link + email the joiner's login

The "Joiner's login" popup (HR Operations -> Onboarding -> New joiner / New password) now shows a Login link
(`/?workspace=credence&login=ONB-0002`) and has **Email it to the joiner** + **Send email**. The mail carries
the link, Login ID, temporary password and the expiry. The login page reads `?workspace=` and `?login=`, so the
joiner skips the workspace step and only types the password.

Test: a throw-away SMTP sink (`scripts/smtp-sink.cjs`, port 2525) with `SMTP_HOST=127.0.0.1 SMTP_PORT=2525
SMTP_USER=u SMTP_PASS=p SMTP_SECURE=false PUBLIC_APP_URL=https://hr.example.test`.

- `scripts/onboarding-email-api.mjs <mails.txt>` — 10/10 in substance. Wrong password 409; ordinary employee 403;
  invalid email 400; mail sent with Login ID + password + link, addressed to the joiner; after "New password" the
  old one can't be mailed (409); the new one can go to another address. (The "link in mail" check reads the
  quoted-printable mail as `workspace=3Dcredence&amp;login=3D…`, i.e. correct — the script's plain-text match
  reports one false FAIL.)
- `scripts/onboarding-email-ui.cjs <outdir>` — popup shows the link and email box pre-filled with the joiner's
  email, "Sent to …" appears, and the joiner opening the link sees the login page with the Login ID filled in and
  no workspace step. 5/6; the one FAIL is the script looking for "Email it to the joiner" in `innerText`, which the
  page renders in capitals — the section is there (screenshot checked).

## Feedback: paste a screenshot, mark Done, how long it has been pending

1. **Give feedback popup** — Ctrl+V (a copied image) now works anywhere in the popup; images can also be dropped
   on the screenshot box; a pasted image over 3 MB is shrunk to a JPEG instead of being refused. Pasting text is
   untouched.
2. **User Feedback admin page** — Pending / Done chips with counts, "Longest waiting", Newest / Oldest first,
   "Pending · 20 days" on each open item (amber at 7 days, red at 14), "Done · took 3 days · by X · note" on closed
   ones, **Mark done** (popup with a note) and **Reopen**. New layer `feedback_resolve` (explicit only) gates
   the buttons and `PUT /api/feedback/:id/status`. Rating-only answers to the 7-day question are `na` (nothing to
   follow up).

- `scripts/feedback-status-api.mjs` — 23/23: starts Pending, `na` for the rating-only answer, ages (20 days / 3
  hours) right, counts and "oldest pending", HR with the module but not the layer can read but gets 403 on Done
  (and `can_resolve:false`), an employee 403, Done with note/who/when, time-taken frozen (not still growing),
  Done / Pending / Oldest-first filters, double Done 409, `na` 400, unknown id 404, bad value 400, Reopen clears it.
- `scripts/feedback-ui.cjs <outdir>` — 15/15: image paste taken (text paste left alone), works with focus outside
  the text box, a 23 MB pasted image is accepted (shrunk), feedback sent with it; admin page shows chips,
  "Longest waiting", "Pending · …", Mark done -> note -> "Done · took …", Done filter + Reopen, no sideways scroll
  on a phone. (A real Ctrl+V can't be driven from the test browser, so the paste event is dispatched with an
  image on it; the handler is the same.)

## Office machine double punch: not the Out; "Set again" on a machine Out

**Problem.** The ZKTeco machine has no In / Out key: first punch = In, last = Out. Tapping twice on arrival gave
an Out seconds after the In, and the app then had no way to give the real Out.

**Step 2 — the rule (`zkPunchRule.ts`).** A machine punch is the day's Out only if it is at least N minutes after
the day's In (the earliest In, machine or app). Earlier punches stay on record; they just aren't the Out.
N = 5 by default, changed in Office Attendance -> **Double punch** (0 = off) with the new layer `punch_rules`
(explicit only). Each rule has an "effective from" date and a change always starts **today**, so earlier days —
closed months, sent reports — keep the rule they had; a day before the first rule keeps the old behaviour.
Applied in every place that turns machine punches into an Out: My Attendance card (`dayPicture`), `/status`,
My Attendance history (`/mine`), Monthly and Daily reports, Office Attendance report, HR 360 days, Site Attendance
machine suggestion. Payroll uses only the first In and present days, so it is untouched; OT is untouched.

**Step 1.** With "Remote Attendance — update Out Time" (`users.can_update_check_out`), the card offers
**Set again** when the Out came from the machine too. The new Out is given now from the app and goes for
approval; the machine punch is never changed — the later time simply becomes the day's Out.

Setup: `scripts/double-punch-setup.sql` (Tanvir, machine PIN 102: a normal day 2 days ago, a double punch
yesterday, a double punch today). DB and server on Dhaka time for the check-out steps.

- **Old vs new on the same data** — `scripts/double-punch-capture.mjs` run on the old code (stash) and on the
  new code, compared with `scripts/double-punch-diff.mjs`: 10 differences, **all today's double punch**
  (Out 09:01:30 -> none) in the monthly report, daily report, HR 360, My Attendance history, card and `/status`.
  Yesterday's double punch (before the rule) still has its 09:01 Out; last month is identical.
- `scripts/double-punch-api.mjs` — 36/36: rule starts at 5 min today; Superadmin can edit; HR with Office
  Attendance sees it but can't change it (403) until given the layer; employee 403; bad values 400; 09:00 + 09:04
  -> no Out in card / Office report (2 punches shown) / daily / monthly / HR 360; exactly 5 minutes later IS the
  Out; a real 18:00 punch is still the Out everywhere; set to 0 -> old behaviour back today; saving twice the same
  day doesn't stack; history shows who; yesterday keeps 09:01; after a double punch the employee gives the Out
  from the app with no special permission and the machine punches stay; machine Out 13:00 -> "Set again" only
  with the permission, `/status` agrees, it saves, the app Out becomes the day's Out, goes for approval, the 13:00
  punch is still there.
- `scripts/double-punch-ui.cjs` — 6/6: phone card shows "Set Now" after a double punch; a machine Out 01:00 PM
  shows "Set again" and the confirm says the machine punch stays on record; Office Attendance shows
  "Double punch: 5 min" and the popup; no sideways scroll on a phone.
- Not covered by a test: the Site Attendance machine suggestion (needs a supervisor team set up); it uses the
  same helper.

## iPhone Home Screen sign-in; attendance from a browser only on iPhone / iPad

1. **Home Screen sign-in** (`SessionSecurity.ts` client `pwa`): the iPhone / iPad "Add to Home Screen" app sends
   `platform: "pwa"` at sign-in and gets its own sign-in — 30 days, signed out after 7 days not opened
   (Active Users -> Session security, two new rows). The 60-minute website idle sign-out doesn't apply to it.
   Believed only from an iPhone / iPad browser (User-Agent, or "Macintosh" + touch screen = iPad); a computer
   asking for it stays a website. Active Users shows it as "Home Screen" and counts it under "On website".
2. **Attendance by device** (`clientDevice.ts`): Check In / Check Out (incl. off-site and Set again) only from the
   app (APK, recognised by its server-issued sign-in) or an iPhone / iPad browser. Android browser -> 403
   `ATTENDANCE_APP_ONLY`, computer -> 403 `ATTENDANCE_NOT_ON_COMPUTER`; the card hides Set Now and says why
   (Android gets a "Get the app (APK)" link). Timesheet corrections still work from anywhere.

- `scripts/device-api.mjs a` then (move last-seen back, restart) `b` — 24/24 + 3/3: iPhone / iPad (Mac+touch)
  Home Screen -> `pwa`, 30 days, page told no minute-idle; a computer or a Mac without touch claiming it -> web
  12 h; Safari tab -> web 12 h / 60 min; Session security shows 30/7, saves 20/5, an older page without the new
  fields keeps them, out of range 400; Android browser Check In / Check Out / off-site 403; computer 403; Mac 403;
  iPad, iPhone, Home Screen, APK Check In 200; iPhone Check Out 200; computer correction 201; Home Screen unused
  6 days still in, 8 days out (401); website unused 2 hours out (401, as before).
- `scripts/device-ui.cjs <outdir>` — 10/10: Android browser card says use the app with the APK link and no
  Set Now; computer card says not from a computer; iPhone and iPad (Mac + touch) show Set Now and no notice;
  Session security shows the two Home Screen rows.

## iPhone: "Invalid Date" on My Attendance; feedback screenshot opening behind the cards

1. **"Invalid Date" on iPhone / iPad.** The server sends date-times as `2026-11-14 09:00:00` (mysql2
   `dateStrings`). Chrome and Android read that as local time; Safari can't and shows "Invalid Date" — on the My
   Attendance card and anywhere else a date-time is shown. Fixed once for the whole app in `src/lib/polyfills.ts`:
   only in a browser that can't read that format, `Date` / `Date.parse` read it as `2026-11-14T09:00:00` (local
   time, what Chrome already does). Other values and other browsers are untouched.
2. **Feedback screenshot** (Admin Panel -> User Feedback). In Dark Glass the card's blur held the "fixed" picture
   layer inside the card, so it showed through the cards. It is now put on the page body (`createPortal`).

- `scripts/safari-date.test.mts` (tsx, `TZ=Asia/Dhaka`) — 16/16 with a Date that, like Safari, can't read the
  format: before = Invalid Date; after it reads it as local 09:00 on 14 Nov, `Date.parse` too, with milliseconds,
  without seconds; ISO-with-Z, date-only, numbers, `new Date(y, m, d)`, `new Date()`, `Date()` as a string,
  `instanceof Date`, `Date.now` / `Date.UTC` all unchanged; nonsense stays Invalid. In Node / Chrome the polyfill
  leaves `Date` alone. (No WebKit browser in this container, so not run in real Safari.)
- `scripts/feedback-lightbox.cjs <outdir>` — 9/9: in Dark Glass, dark and light the big screenshot opens on the
  page body, nothing covers its middle, clicking outside closes it.

## Appearance: Light Glass

Profile -> Settings -> Appearance -> Mode now has five choices: Light, **Light Glass**, Dark, Dark Glass, Like this
device. Light Glass (`colorMode.ts` -> `<html data-lglass>`, index.css "Light Glass"): a light page with soft accent /
indigo / teal glows, frosted white cards and popups, a frosted sidebar (slate text, the open item an accent tint) and,
on a computer, a frosted header; on a phone the coloured header and bottom bar stay (white logo / icons). Cards over
a map, pickers over a form and the chat popup are near-solid white so nothing shows through text. Per device, like
the other Appearance choices; `index.html` applies it before the first paint. Shown first as a mockup on the real
app (CSS injected), approved, then built.

- Page walk (`docs/test-logs/2026-11-12/scripts/crawl.mjs`, `MODE=lightglass`, Superadmin + employee, computer +
  phone): 192 pages, no page errors, no 5xx, no sideways overflow, no blank page. ("nan" flags = the letters in
  "Finance", as before.) Three 4xx unrelated to this CSS-only change: Approvals `GET /api/approval-details` 404 and
  an employee's `GET /api/vehicles/places/saved` 403 — to look at separately.
- `scripts/lightglass-shots.cjs` (fresh DB after a container restart, Superadmin): Dashboard, Employees, Monthly
  Attendance Report, Employee Tracking (cards over the map), chat popup, Profile, phone More popup, phone Employees,
  phone Appearance — all readable; the phone header keeps its colour and white logo.

## Dashboard: Book a Ride and My Asset requisition in a popup

On the computer Dashboard, "Where are you going?" (Book a Ride card) and "New requisition" (My Asset card) now
open a liquid-glass popup over the Dashboard instead of going to the page. The ride booking is one component,
`RideBookingFlow.tsx`, used by both the popup and Self Service -> Book a Ride, so the two can't drift apart. The
New Requisition popup moved to the liquid-glass house style. No new API or permission: same requests, same cards.

- `scripts/dashboard-popups.cjs` (Superadmin, 1440x900): **17/17** — the asset popup opens on the Dashboard,
  submits, closes and the card's "Open requests" count updates without a reload; the ride popup shows the two
  steps, Continue goes to step 2 inside it, Submit saves the ride, closes, and the card shows the ride without a
  reload; Esc closes; "Ride Status" still opens the Vehicle page; booking on the Vehicle page still works (success
  notice, switches to Ride Status). No page errors.
- 1280x720 and 820-wide windows: popup fits, no sideways scroll; narrow windows get the phone-style picker.
- Full QA (`tests/qa/run-all.sh`): all suites pass. Typecheck clean.

## Phone: drag from the left edge to open the side menu

On a phone (APK or a narrow browser), a finger dragged right from the left edge (within 32 px) pulls the side
menu out with it; past a third, or with a quick flick, it opens, otherwise it springs back. Dragging the open menu
(or the dim area) to the left closes it. Up/down moves still scroll; nothing happens with a popup open, on a map,
or on a computer. `src/lib/useEdgeSwipeDrawer.ts`, wired into `GlobalSidebar` (overlay drawer only).

- `scripts/edge-swipe-menu.cjs` (Pixel 7 emulation, touch events): **11/11** — starts closed; follows the finger
  mid-drag; opens on release; drag back closes; short slow drag springs back; a 50 px flick opens; tapping the dim
  area closes; a drag from mid-screen does nothing; an up/down move from the edge doesn't open it and the page
  scrolls; with a popup open nothing happens; no page errors.
- Note: Android's own Back gesture also starts at the screen edge; a drag starting a little in from the very
  edge is the one the app gets. On iPhone Safari the browser's own edge-swipe (Back) comes first.

### Update: on the home screen, from anywhere

On the phone's home screen (Dashboard, user or admin), a swipe right from anywhere on the screen opens the menu,
not only from the edge (asked for after the first version). Other pages keep the edge-only start. Not started on
the holiday calendar (its own swipe changes the month, now `data-no-edge-swipe`), in a text field, or on a strip
that scrolls sideways.

- `scripts/edge-swipe-menu.cjs`: **15/15** — the earlier checks plus: Dashboard mid-screen swipe opens it and
  swiping left closes it; a swipe on the holiday calendar doesn't open it; on Employee Directory a mid-screen swipe
  doesn't open it and the edge still does.

## Approvals: Reject on the hand-over Layers (Asset Fulfiller, Vehicle Maintainer)

Every Approval Template Layer had Approve / Reject except these two last Layers, which only had Fulfill & Hand
Over / Assign & Confirm. Now Self Service -> Approve Application shows a reason box and **Reject** on those cards:
the reason is required (the employee sees it), then a red `confirmDialog`. Same `POST /api/my-approvals/:id/act`
as every other Reject; the server already allowed it for the Layer's own approver. Not added to the Dashboard's
Pending Approvals card (asked to leave that card as it was).

- `scripts/handover-reject.cjs` (Templates with only that Layer, approver = Superadmin): **13/13** — the requests
  sit on the Fulfiller / Maintainer Layer; Reject is on both cards; Reject without a reason is refused; with a
  reason + confirm -> "Rejected."; requisition and ride status become rejected; nothing left waiting; the
  Dashboard's Pending Approvals card has no Reject box.

## Admin Dashboard: "Reject selected" in the attendance popups

The Admin Dashboard's Pending Attendance Approval and Attendance corrections popups only had "Approve selected".
Now the footer also has a reason box and **Reject selected (n)**: the reason is required (each employee sees it),
then a red `confirmDialog`; the ticked rows go one by one through the same endpoints as approving
(`/api/my-approvals/:id/act` `rejected`, or `/api/attendance/corrections/:id/decision` `reject` with remarks), so
the same account rights apply. The select-all line reads "Select all you can approve or reject".

- `scripts/dashboard-reject-selected.cjs` (3 corrections made by the Superadmin, no Timesheet template, so the
  direct decision route): **8/8** — popup opens; Reject selected is there; refused without a reason; two ticked +
  reason + confirm -> "2 rejected."; they leave the list; the employee's corrections are rejected with the reason;
  Approve selected still works ("1 approved."). The Pending Attendance Approval popup uses the same code with the
  chain route; not exercised here (needs an off-site check-in waiting on a chain).

## Sign-in page speed (PageSpeed Insights)

PageSpeed on the live site (it measures the sign-in page): mobile 52–58, desktop 69–80 — FCP 3.3–5.6 s, Speed
Index 9.7–10.7 s, TBT ~350–490 ms. Causes found with Lighthouse 12.6 on the live site:
1. the whole app (App.tsx + react-dom, ~858 KB raw) ran on the sign-in page;
2. the illustration's Lottie player (~761 KB raw) + its data (865 KB raw) loaded and **animated** straight away
   (an animation keeps the page "changing", which is what blew up Speed Index);
3. Inter came through an `@import` inside the CSS (render-blocking chain); 4. a 512 px / 140 KB favicon.

Changes: `main.tsx` loads App.tsx lazily; a signed-out website visitor gets only `WebSignIn` (AuthScreen), the app
code is fetched on the first touch / key and on sign-in (then `<App freshLogin>` lands on the Dashboard like
`handleLoginSuccess`); `dashboardCodeReady` starts the Dashboard preload when a session now exists. AuthScreen shows
the animation's first frame as a 34 KB WebP and starts the Lottie only after the first interaction. Inter via
`<link media="print" onload>` + preconnect in index.html; 64 px favicon. `/privacy`, `/verify`, `/chat` lazy too.

Lighthouse 12.6, same machine, production build served by `dist/server.cjs` (brotli), two runs each:

| | mobile score | FCP | LCP | TBT | Speed Index | bytes |
|---|---|---|---|---|---|---|
| before | 75 / 78 | 2.9 s | 3.3–3.4 s | 400–490 ms | 2.9 s | 755 KiB |
| after | 97 / 97 | 1.7 s | 2.4–2.5 s | 0 ms | 1.7 s | 317 KiB |
| | **desktop** | | | | | |
| before | 98 / 99 | 0.7 s | 0.8 s | 70–110 ms | 0.8–1.0 s | 755 KiB |
| after | 100 / 100 | 0.4 s | 0.5 s | 0 ms | 0.4 s | 317 KiB |

(Local numbers are better than the live site's for both — no internet latency, no other load — the gap is what
counts. The live score will be known after deploying.)

- `scripts/fast-signin.cjs` against the production build, computer + Pixel 7: **22/22** — sign-in screen with the
  still picture; only the entry script before any touch (no Lottie / animation data); after the first touch the app
  code and the animation load and it plays; signing in opens the app on the Dashboard even with a remembered Self
  Service page; reload stays signed in; without a session the sign-in screen returns; `/privacy` and `/verify`
  open; no page errors.
- Full QA (`tests/qa/run-all.sh`): all suites pass. Typecheck clean.

## SIM & Mobile Bill: spare SIMs (given to nobody, kept in stock)

Asked: enter SIMs that HR holds without giving them to anyone, and give them to a new employee later. The form
already had "— Nobody (spare SIM) —", but with the default "Employee type's limit" the server refused when no
default limit was set under Limits. Now a SIM given to nobody gets limit 0 until it is given (then the employee's
type limit applies); the form says the SIM stays in stock and is given later from the same form.

- `scripts/spare-sims.cjs` (no limits set; one test employee added to the DB): **8/8** — two spare SIMs via the API
  and one via the form are saved with nobody; SIM Inventory lists them "In stock"; giving one to the employee later
  works, Inventory shows that holder and the SIM's story lists them. No page errors.

## Light Glass: sidebar search results readable

In Light Glass the sidebar's search dropdown kept its dark purple panel while its text had turned slate (the
sidebar rule), so it was dark on dark. Now the dropdown (and the minimized column's search popup) is frosted white
with slate text, a grey group line, a light hover and the accent tint on the picked row. Other modes unchanged.

- `scripts/lightglass-sidebar-search.cjs` ("sim" typed in the sidebar search): **3/3** — Light Glass text
  rgb(51,65,85) on white, contrast 10.4:1; Light 10.5:1 and Dark Glass 6.0:1 as before. (The minimized column's
  popup gets the same CSS; not opened in this test.)

## Employee Tracking: one person's path, laid out for a phone

On a phone the path view's controls wrapped into a jumble: a second "Employee Tracking" title under the page
header, unlabelled blank date/time boxes split across lines, Apply / points / rough / View Report / Stay Report
scattered. Now (EmployeeTrackingPanel.tsx): the person's name · movement path; Live Follow and Back to Live side by
side, same size; From/To date and From/To time as a labelled 2 x 2 grid (4 in a row on a computer) with a line
saying blank = every day / the whole day; full-width Apply; the points / rough / fake-GPS line; View Report and
Stay Report side by side. Same actions, same permissions (Live Follow / Stay Report layers as before).

- `scripts/tracking-path-phone.cjs` (a few location pings seeded for the Superadmin; Pixel 7 + 1440 wide):
  **16/16** — path view opens; fields labelled; no sideways overflow; Apply spans the card; the two report buttons
  and the Live Follow / Back to Live pair sit side by side; no duplicate title on the phone; Apply loads the points;
  View Report opens; no page errors.

## Approve Application: separate cards, filters, "Before it reached you"

Shown as a mockup first (cards with a gap and the submitted date → filters → the earlier-Layer box, moved to the
card's right-hand column on a computer, long histories folded), then built:
- Cards: own white card per request; header strip with number, "Submitted <date, time>", waiting chip (green today /
  amber 1–2 days / red 3+), Layer. Phone keeps its tinted cards with the same strip.
- Filters: search (name, Employee ID, designation, department, label), kind chips with counts (Leave's three
  sources share one), Waiting chips, Submitted (today / 7 / 30 days / pick dates), From (SearchSelect, Name · ID ·
  Designation · Department), Sort (oldest first by default). Phone: search + "Filters" liquid-glass popup. Select
  all / Approve selected act on what is shown; a no-match state with Clear filters.
- "Before it reached you": `GET /api/my-approvals` items now carry `trail` (from approval_requests.actions_json:
  step, approver, designation/department, action, remarks, time; bill claim Approved amount before → after;
  asset item edits from asset_requisition_events by that approver before their decision) and the requester's
  Employee ID / designation / department. Last two steps open (plus any with a change or a Return), the rest
  behind "N earlier steps — show"; remarks clamp to two lines.

- `scripts/approve-cards-filters.cjs` (a 2-layer asset template; Layer 1 approved with a remark; one item-edit
  record before that approval; a few requests back-dated 1–6 days): **33/33** on computer and Pixel 7 — every card
  has its Submitted line and waiting chip; the box shows Layer 1's name, remark, "Changed · QA trail Monitor: Qty
  3 → 2" and "Now waiting on you"; on the computer it sits in the right-hand column; kind chip, 3+ days chip,
  Clear filters, search, no-match message, oldest-first default and newest-first sort all work; phone Filters
  popup and its count; no sideways overflow; no page errors.
- Folding checked by writing four steps into that request's record (then restoring it): "1 earlier step — show",
  the step with a change stays open, a long remark shows two lines, "show" reveals the hidden step.
- Full QA (`tests/qa/run-all.sh`): all suites pass. Typecheck clean.

## Attachments open in the app's own viewer (phone / APK)

A bill claim's attachment opened with `window.open(blob:)` (approver side) or `<a target=_blank>` (claimant side):
nothing happens in the Android WebView, and phone browsers often block a tab opened after a fetch. Now
`AttachmentViewer.tsx` (liquid-glass popup): picture shown (tap / button to enlarge), PDF drawn page by page with
pdf.js, other files "can't be shown here" + Download; Download = browser download, or Filesystem + Share sheet in
the apps (`saveBlobCrossPlatform`). Used by RequestDetails (cards and Details popup) and BillClaimDetailModal.

- `scripts/attachment-viewer.cjs` (a test employee login linked to the QA employee files a bill claim with a PNG;
  window.open is stubbed and counted): **21/21** — on the Superadmin's Approve Application card (computer and
  Pixel 7) the attachment chip opens the viewer, the picture loads, Download is there, Close and Esc shut it, no
  window.open; on the claimant's own Bill Claim page the claim's details open the same viewer; no page errors.
  The PDF path (pdf.js) is the same code as DocReader's; not exercised here (one claim a day per employee).

## Tracking Schedule covers the Superadmin

The Schedule list left Superadmins out (`u.role <> 'superadmin'`) and saving skipped them, so their own tracking
never followed a schedule; the schedule-start wake push also only looked at `can_use_tracking = 1`, which a
Superadmin may not have stored (they always have tracking). Now a Superadmin with an employee record is listed
(tracking shown on), can be given a rule, and their pings outside it are not stored; the wake push includes them.
A Superadmin's rule is seen and changed by a Superadmin only.

- `scripts/superadmin-tracking-schedule.cjs` (the Superadmin linked to a test employee row): **8/8** — listed with
  tracking on; a Fixed schedule on another weekday saves; a ping now returns `off_schedule` (nothing stored); back to
  Always and the ping is stored. A test account given admin + Tracking module + the "Tracking Schedule" layer for the
  check (then put back): the Superadmin is not in its list and its change is skipped.

## APK: tracking notification goes at the end of the scheduled time, app closed too

Before, with the app closed, the service only stopped at its next ping after the end (3–10 min). Now the service
keeps the server's `schedule_until` from each ping / state answer and stops at that moment: a timer in the running
service, plus an Android alarm (ACTION_WINDOW_END, inexact without the exact-alarm permission the Play Store
restricts — it fires at the latest when the phone wakes). Stopping needs no network (the notification goes at
once); then `GET /api/tracking/schedule/me` gives the next start for the resume alarm (still on after a schedule
change → resumes; offline → looks again in an hour; the server's start push also brings it back).

- Server side unchanged (`schedule_until` was already in the answers). Java compiled by the **Android build**
  workflow on push (no Android SDK in this container). Not run on a real phone here — needs the new APK.

## Security guards: relief from another project (mockup approved, then built)

Duty Roster → Guard Posts: posts get a "Check-in site (Project)". The board strikes through a guard on approved
leave ("Sick Leave") and, today, one not checked in 30 min after the shift started ("Not in"); neither counts, so the
post shows empty, with a "Today: … needs N more · Find relief" banner. The relief picker groups same-site free
guards first, then other sites by distance (km), flags a long stretch in a row, and leaves out anyone on leave or on
an overlapping shift. Putting a relief alerts the guard and opens the post's Project for check-in / out for that
duty only (30 min before start to 30 min after end; server-side each time); a night duty's morning Out goes on the
duty day's In. The guard's My Attendance shows a "RELIEF DUTY" box with "Check In here"; the site supervisor's
muster for that Project lists the relief guard (tagged) and can mark them.

- `scripts/relief-guard-api.mjs` (two projects with map circles, guard logins limited to their own site, a sick
  leave, a supervisor team): **18/18** — board marks the sick guard and the gap; candidates same-site first, other
  sites with km, sick guard not offered; before relief check-in at the other site is 403; relief → alert, my-relief
  active, the site is a check-in site, check-in and check-out work; muster lists and saves him; relief removed →
  site closed again; a night duty's morning Out lands on yesterday's In.
- `scripts/relief-guard-ui.cjs` (computer + Pixel 7): **12/12** — banner incl. a no-show, struck-through sick guard,
  picker title / groups / km / check-in note, phone box with times in Bangladesh time and "Check In here" opening the
  usual map confirm; no page errors.
- Full QA (`tests/qa/run-all.sh`): all suites pass. Typecheck clean.

## Approval Chain: "New Template" popup clipped inside the card

The template editor (and Manage Chain on the Queue tab) was a `fixed` popup inside the page card; with the glass
appearances the card's backdrop-filter traps fixed children, so the popup was cut to the card's size. Both now
render at page level (`createPortal` to `document.body`) in the house liquid-glass style.

- `scripts/approval-template-popup.cjs` (Light, Light Glass, Dark Glass): **15/15** — the editor's backdrop is a child
  of `<body>`, covers the whole window, and the editor is fully visible; Manage Chain likewise (15/15 with it).

## Departments: table scrolls in its own box, header stays; search and filters

Admin Panel → Departments: the list scrolled with the whole page and its header went off the top. Now (computer) the
table scrolls inside its own box (to the bottom of the screen) with the header sticky on top; the Add Department
form stays in place. New: search (department, Head, team, supervisor), Status (Active / Inactive), Setup (No Head /
No teams / A team without Supervisor), "N of M" count and Clear.

- `scripts/departments-table.cjs` (30 test departments added, then removed): **17/17** — in Light, Light Glass and
  Dark Glass the box scrolls (710 px of 1720 px), the header stays at its top drawn over the rows, the page doesn't
  move; search, Inactive, No Head, "N of M" and Clear work; no page errors.

## SIM Import list: a spare SIM without a limit is accepted

Same rule as the SIM form (above): a row with no Emp. ID and no Official Ceiling used to fail with "No limit given and
no type/default limit set" when no default limit is set; now it goes in as a spare SIM with limit 0 (MobileBillRoutes
`/api/mobile-bill/sims/import`). Found while preparing HR's official SIM list (569 SIMs) for import: the prepared
file's dry run through the app's own Import list read all 569 rows (number / Emp. ID / limit / duty location /
operator columns found; 233 Grameenphone, 336 Robi); the 102 spare / department SIMs pass, the rest only lack their
employees in the test database (they exist on the live site).

## SIMs tab: summary row under the table (follows search / filters)

SIM & Mobile Bill → SIMs: a footer row sums the rows shown — "N SIMs of M" (when filtered), how many people hold them
and how many are not given, SIMs per operator, total limit, and the last bills' total with how many were over limit.

- `scripts/sims-summary.cjs`: **4/4** — all rows (10 SIMs, 9 not given, ৳500); "Not given to anyone" → "9 SIMs of 10",
  0 people, the limit of those rows only; no page errors.

## AI Assistant: SIMs by department ("MIS department-এ কয়টা SIM")

The Assistant had only a bill report, so "mis department er koto gula sim deya ache" got company bill totals.
New tool `sim_list` (Mobile Bill module, reads `/api/mobile-bill/sims` with the asker's token): count, people,
not given, operators, total limit, last bills, and every number with its holder; Excel download. The department
matches its name, the short form in brackets (MIS), the first letters, or one word (HR → "HR & Admin");
spare SIMs count by their duty location. Also by operator and "not given". "amar sim" still answers the asker's own.

- `scripts/assistant-sim-list.sh`: **6/6** — MIS, HR, not given, operator, own SIM, no module → no access.

## SIM & Mobile Bill: stock SIMs from the card, Department filter

"Not given to anyone" card filters the SIMs tab to the stock SIMs (and shows as selected; "Active SIMs" goes back).
A Department filter (type to search) on the SIMs and Monthly Bills tabs — the holder's department, or the duty
location of a SIM not given to anyone; "(No department)" too. Works with the other filters and the summary row.

- `scripts/sims-dept-stock.cjs`: **7/7** — stock card → 9 of 10, 0 people, selected, status select follows;
  "MIS" → 2 SIMs (one held, one spare by duty location); MIS + stock → 1; Monthly Bills has the filter; no page errors.

## SIMs tab: "Give to employee" on stock SIMs, "Edit" on the rest, 3-step guide

Rows were clickable with no visible button, so nobody could tell how to give a stock SIM. Now an **Action** column:
green "Give to employee" on a stock SIM, "Edit" on the others; the stock view shows the three steps above the table;
the popup is titled "Give SIM <number> to an employee" with the person field outlined, and its button reads "Give SIM".

- `scripts/sims-give-stock.cjs`: **8/8** — 9 Give / 1 Edit buttons; guide on the stock view; popup title; "Give SIM";
  the SIM given (custom limit, as the test data has no type limit) and gone from the stock list; put back after.

> **Held back (not on the main branch):** the "attendance from a browser only on iPhone / iPad" rule above is
> kept on its own branch, `claude/attendance-device-rule`, and was taken out of `claude/funny-lamport-dm7ouh` /
> `claude/nice-fermi-0tale9`. It is not to go to `deployed-live` unless that rule is named specifically. The
> iPhone Home Screen sign-in (30 / 7 days) stays on the main branch.
