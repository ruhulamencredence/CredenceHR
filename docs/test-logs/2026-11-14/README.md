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
