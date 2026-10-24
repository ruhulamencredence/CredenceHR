# Update 3: Dispatch send-back, safe Notices, Employee delete guard

Goes on top of update 2 (commit 1b037aa, `DEPLOY_NOTES_pepm_update_2.md`).
Copy the changed files over the live project, then on the server:

    npm install          # new packages, see below
    npm run build
    pm2 restart all      # or however the server is restarted

New npm packages (already in package.json / package-lock.json):
`sanitize-html` 2.18.1, `@types/sanitize-html` 2.16.2, `dompurify` 3.

## PEPM -> Reports -> Dispatch Material
- A row still in the dispatch list (nothing dispatched yet) can be sent back
  to the MPR Entries report: the button on the row, or tick several and use
  "Back to MPR Entries" in the toolbar.

## Notices (security fix)
- A notice's HTML is cleaned when it is saved and again whenever it is read,
  so it can format text, link and show pictures but can no longer run code
  in a reader's browser. Notices saved before this are cleaned too.
- Custom Lottie animations: their expressions (run as JavaScript) are
  removed; a Lottie link must be an http(s) address.

## Employees (data fix)
- Deleting an Employee no longer deletes their salary runs, salary
  structures, adjustments, bonuses, pay items, loans / advances, late
  waivers, HR actions, letters or transfers. An Employee with any of these
  can't be deleted; set their Job Status to Resigned / Terminated instead.
- On the first start the database is changed to refuse such deletes too
  (foreign keys from these tables switched to ON DELETE RESTRICT). The log
  shows one "🔒 …" line per table. Nothing to run by hand.
- Deleting needs the new layer **Employees -> Delete employee records** in
  Users -> Module Access. Nobody has it until ticked (Superadmin always
  does); without it the delete button is hidden.

## Removed: PEPM Management -> Measurement Sheet
The software no longer has the Measurement Sheet module (page, API, drawing
engine, Module Access row, its permission layers incl. `material_budget`, and
its Credence Assistant topic).

Copying files over does not delete old ones — on the live server also
**delete** these three files before `npm run build`:

    MeasurementRoutes.ts
    MeasurementEngine.ts
    src/components/MeasurementSheet.tsx

When the server starts it **drops the `measurement_sheets` table** (all saved
sheets are deleted for good) and removes the module's saved permissions.
Take a database backup first if that data may ever be wanted. The npm packages `@mlightcad/libredwg-web` and `dxf-parser`
are now unused and can be removed with `npm uninstall` when convenient.
