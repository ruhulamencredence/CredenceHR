# PEPM update 2: Measurement Sheet, Dispatch Material, Material Receive

This update goes on top of the first PEPM update (deploy notes in
`DEPLOY_NOTES_pepm_update.md`, commit 27d305c). It also carries the two
report fixes made after it (plain white column menus, and a User given the
Reports module seeing every entry).

Copy these files over the live project (same paths), then on the server:

    npm install          # two new packages, see below
    npm run build        # rebuilds the website (dist)
    pm2 restart all      # or however the server is restarted

New npm packages (already in package.json / package-lock.json):
- `@mlightcad/libredwg-web` 0.7.17: reads DWG drawings (Measurement Sheet).
- `dxf-parser` 1.1.2: reads DXF drawings (Measurement Sheet).

New database tables and columns are created when the server starts; nothing
to run by hand:
- `measurement_sheets`
- `mpr_dispatches`, `mpr_fulfil_log`
- `entries.md_*` (delivery status of each MPR row)
- `users.can_receive_material`

## What is in it

- **PEPM Management -> Measurement Sheet** (new Admin Panel module, off until
  given in Users -> Module Access): upload a building drawing (DWG / DXF) and
  get the BOQ measurement sheet (beams, columns, slab; Nos x L x B x D), edit
  it, export Excel / PDF; Full drawing preview; Material Budget tab (cement,
  sand, stone, rod, shuttering and cost). Layers: See and export (the only
  one given by default), Upload drawings and edit, Delete, Material Budget.
- **PEPM -> Reports -> MPR Entries Report**: new Delivery Status column
  (Not dispatched / In dispatch list / Partly dispatched / Dispatched /
  Partly received / Received, click it for the row's history), Open /
  Received / All switch (rows received in full move to Received), Delivery
  Status and sent / received quantities in the Excel.
- **PEPM -> Reports -> Dispatch Material** (Purchase): tick MPR rows in the
  report and "Send to Dispatch"; then dispatch them on screen or with the
  Daily Site Requirement sheet (download, fill, upload): supplier, rate,
  P.O., dispatch qty and date, challan, vehicle. Partial dispatch and cancel
  (with a reason) are supported. Two new Reports layers in Module Access,
  both off unless ticked:
  - "Dispatch Material (own)": only the rows this account sent there or
    dispatched;
  - "Dispatch Material: see all": every row.
- **Job Entry -> Material Receive** (project accounts): switch "Also allow
  Material Receive" in Module Access, off by default. Shows the account's
  own MPR rows in Dispatch, the material on the way to its projects (Manage
  Projects) to confirm how much arrived (a short receipt needs a reason),
  and what was received in the last 60 days.
- **Alerts**: the project is told when material is dispatched; Purchase is
  told when less arrived than was sent. Tapping the alert opens the page.
- The % loader of the imports uses the new popup style.

---

# Also in this update: Users, Device Access, Chat, Appearance, Credence Assistant

These go in the same zip and deploy the same way (`npm install`,
`npm run build`, restart). New tables and columns are created on start:
`user_devices`, `users.max_devices`, `user_access_audit`, `access_templates`,
`users.is_blocked / blocked_reason / blocked_at / blocked_by`,
`users.can_use_ai_assistant / can_export_assistant_reports /
can_handle_assistant_support`, `assistant_support_sessions`,
`assistant_support_messages`.

New npm packages: `@capacitor/device` 6 and `capacitor-voice-recorder` 6.0.3
(both for the Android app).

## Settings & Administration -> Users
- A simple list: search, role filter, quick filters (Admins, No modules,
  Attendance on…), tick rows for bulk changes (turn a switch on / off, apply
  an Access Template, open Module Access for all of them), 50 per page.
- **Manage** opens as a page: Account (role, Login ID, password, Block login,
  last login, delete), Access, Features, Admin powers, Activity (who changed
  what), with Undo after each switch.
- **Module Access** opens as a page: sections (General, PEPM, HR, Attendance &
  Leave, Claims & Bills, …), each module's permission layers right under it,
  a search, "Turned on" summary, change or add accounts without leaving, and
  several accounts at once (only what changed is saved, per account).
- **Access Templates** and **Block login** (a new Users layer, off unless
  ticked): a blocked account can't sign in and its open sessions end.

## Device Access (Superadmin)
- Admin Panel -> **Device Access**: the app signs in on one phone per account;
  another phone waits for the Superadmin, who moves the account to it or
  allows one more (up to 5). Removing a phone signs it out.
- The current Android app doesn't send a phone id, so until the new APK is
  installed everyone keeps signing in as before (no phone limit). After
  everyone has the new app, add `DEVICE_REQUIRE_APP_UPDATE=1` to `.env` and
  restart: an old app is then asked to update.
- Rebuild the APK for this (`npx cap sync android`, then build): it needs the
  `@capacitor/device` plugin.

## Chat
- Current Chat screens: Chats / Groups tabs with a floating bar on phones,
  profile photos in avatars, frosted conversation background, the app's own
  popup for "Leave this chat?", the floating Chat button's new icon.
- Fix: messages load on MySQL 8.0.22 and newer.
- Who is online works with several PM2 workers.
- Voice messages use the app's own recorder once the new APK is installed
  (`capacitor-voice-recorder`); the current app keeps recording as before.
- Audio / video calls are not included.

## Appearance (Profile -> Appearance)
- Background themes per device: Classic, Frosted Glass, Apple Glow and
  **Minimal Mono** (grey workspace, white cards, quiet sidebar and header).

## Credence Assistant
- The floating Assistant (bottom right): answers from the person's own data
  (leave balance and applications, attendance, claims, holidays, colleagues,
  approvals; HR figures for those who may see them), drafts a leave
  application the person checks and submits, explains where things are, and
  hands over to a real person (**Support inbox** for agents).
- Without a key it uses its built-in Bangla / English engine. For free-form
  answers put a Gemini key in `.env`: `GEMINI_API_KEY=...` (optional
  `GEMINI_MODEL`). With a key, questions and the facts used to answer them
  are sent to Google.
- Module Access -> General: **AI Assistant** (on for everyone by default),
  **Assistant: PDF / Excel download** and **Assistant live support** (off by
  default).
- Questions about features this server doesn't have yet (Tasks, Targets,
  Loans, …) get "not on this server yet".
