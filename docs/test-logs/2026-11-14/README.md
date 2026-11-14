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
