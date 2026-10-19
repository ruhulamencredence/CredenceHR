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
