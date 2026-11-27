# 2026-11-25 — Notices: "Send again" to everyone

Who has read it → "Send again ▾": **To who hasn't read it** (as before — with
"I have read this", Not yet + Opened) or **To everyone** the notice is for,
those who have read it too. Push only: nobody's Read ✓ / opened record
changes, so the notice doesn't pop up again for those who read it. Asks first
with the counts. Same permission as before (Notices + notice_read_report);
`POST /api/notices/:id/remind` takes `{ to: "everyone" }`, without it the same
as before; the automatic next-day reminder is unchanged.
- `notice-send-everyone.txt` — 13/13 (3 vs 4 recipients, records unchanged,
  refused without Notices, a paused notice can't be sent, menu counts, confirm,
  both ways from the screen, no page errors); screenshots
  `notice-send-menu.png`, `notice-send-confirm.png`.

# Holiday Calendar: add a date range

Add Date took one date only, so a holiday of several days (Eid) had to be added
day by day. Now Add has From and To (optional): every day of the range is added
to the chosen calendar (Head Office / Project Side) with the same type and
title; days already set are left as they are and named in the message; at most
62 days. One date (To empty) and Edit work as before. The popup moved to the
liquid-glass style. `POST /api/holidays` takes an optional `end_date`.
- `holiday-range.txt` — 14/14 (one date as before; 20–23 March with the 21st
  already set → 3 added, 21st skipped; other calendar untouched; all set → 409;
  To before From / over 62 days → 400; title on every day; from the screen:
  "5 days" hint, "Added 5 dates", 10–14 May on the calendar; no page errors);
  screenshot `holiday-range-form.png`.
