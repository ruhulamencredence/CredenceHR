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
