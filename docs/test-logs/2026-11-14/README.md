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
