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
