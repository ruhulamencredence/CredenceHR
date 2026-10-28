# Update 4: PEPM (Material Receive, P.O Import, Budget notice, Job Edit details), Chat, security fixes

Goes on top of update 3 (`DEPLOY_NOTES_pepm_update_3.md`). The zip holds
every file changed since commit 1b037aa (update 2), so it carries update 3
as well. Copy the files over the live project, then on the server:

    npm install          # no new packages this time; harmless to run
    npm run build
    pm2 restart all      # or however the server is restarted

If update 3 was never applied, also delete these three files before
`npm run build` (see update 3):

    MeasurementRoutes.ts
    MeasurementEngine.ts
    src/components/MeasurementSheet.tsx

Take a database backup first. Everything below is added to the database on
the first start; nothing has to be run by hand.

## Sign-in key (read this)

The key sign-in tokens are signed with is no longer allowed to be a
default written in the code. If `.env` has a long `JWT_SECRET` (32+
characters, not the old default), nothing changes. If it is missing, short
or the old default, the server makes a random key on the first start and
keeps it in `.jwt-secret` next to `server.ts` (the log says so). Then
**everyone is signed out once** and signs in again. More than one server
behind the same address: put the same long `JWT_SECRET` in every `.env`
(`openssl rand -hex 48`).

## PEPM -> Material Receive
- The project can take its own MPR row back out of Dispatch Material while
  nothing has been sent on it, choosing a new delivery date (within the
  allowed window), or Confirm it. Purchase gets an alert.
  New switch, off for everyone: Users -> Module Access -> PEPM ->
  **Take back / Confirm in Dispatch** (`users.can_return_dispatch`).
- Full receiving form (challan, date, qty, remarks), fits a phone screen,
  and a whole P.O. / challan can be received at once.

## PEPM -> Reports -> Dispatch Material
- One P.O-Number for all lines of a dispatch.

## PEPM -> Reports -> P.O Import (new)
- Upload the ERP purchase-order export (Excel): each line is matched to
  its MPR row (Project, MPR / MRF No, Material, Specification), checked
  first, then saved. The P.O No shows on the MPR Entries report and its
  Excel. Importing the same P.O again updates it.
- New Reports layer **P.O Import** in Module Access; nobody has it until
  ticked (Superadmin always does).
- New tables: `mpr_po_lines`, `mpr_po_imports`.

## PEPM -> Data Import (Budget)
- Importing a Budget writes a short draft notice
  ("<Budget> - MPR Updated up to <date>") and opens it for editing; nobody
  sees it until it is published from that popup or from Notices. A
  Superadmin / Notices user gets a "Draft notice" alert.
- New column `notices.source_ref`.

## PEPM -> MPR Edit Log -> Job Edit Approvals
- **Details** on every request: for Delete MPR, everything about the row
  being deleted (with a warning when material was already sent or received
  against it); for Add MPR, the Budget item's qty before -> after and
  what's left; and the Job's MPR rows with the change marked in place.
- Tick several pending requests (or Select all) and **Approve selected** /
  **Reject selected** together. Each goes through the same checks as a
  single one; any that can't be approved any more is listed, the rest go
  through.

## Chat
- Reactions, delete for me / unsend for everyone, wallpapers, contact
  info, edit a sent message (15 minutes), forward to up to 5 chats, pin
  up to 3 messages (24 h / 7 / 30 days).
- New chat / Add members show each person's designation and department,
  and search by them.
- New switch Users -> Module Access -> **Chat**, ON for every account
  (as now); turning it off hides Chat and blocks its API for that account.
- New tables / columns: `chat_message_reactions`, `chat_message_hidden`,
  `chat_pinned_messages`, `chat_wallpapers`, `chat_messages.unsent_at /
  unsent_by / edited_at / is_forwarded`, `users.chat_about`,
  `users.can_use_chat`.

## Security and smaller fixes
- Sign-in: 5 wrong passwords lock that account for 15 minutes; 30 from one
  address make that address wait. An admin's password reset lifts the
  lock. New table `login_attempts`.
- API: an unknown `/api` address answers 404 JSON; database error text
  never reaches the browser (a short plain message instead; the original
  goes to the server log).
- Leave: no second application for days already applied for (waiting or
  approved); the balance can't go below zero even when two are sent at
  the same moment.
- Alerts: **Clear all** in the bell and on the Alerts page.
- Login and Change password: an eye button to show / hide the password.

## Not in this update
- Payroll's "attendance can't add up to more than the working days" check
  (the live payroll code is older; it needs its own port).
- CORS allow-list (needs `CORS_ORIGINS` set in `.env` first).
