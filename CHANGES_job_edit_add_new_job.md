# Job Edit — "Add New Job"

Adds a way for a User with the `can_job_edit` permission to create a brand-new
Job (not just add/delete an MPR row on one that already exists) for a Budget
they've already Final Submitted — routed through the same Admin approval
queue as Add MPR / Delete MPR.

## What this adds

- **`job_edit_requests.action` gets a new `'add_job'` member**, and
  `job_edit_requests.job_id` becomes nullable (a still-pending `add_job`
  request has no real Job yet — it's backfilled once approved). Updated in
  `schema.sql` (fresh installs) and as idempotent `ALTER TABLE ... MODIFY
  COLUMN` migrations in `server.ts` (existing installs).
- **`POST /api/job-edits/new-job`** (`EntriesRoutes.ts`) — a non-admin needs
  both `can_job_edit` ON and an existing `budget_submissions` row for the
  selected Budget (i.e. they've already Final Submitted it) to call this.
  Validates Budget/Project/Job Name/Job Duration/items the same way
  `POST /api/entries` does (MPR-to-Budget-Item matching, per-item remaining
  Qty cap, system-wide MPR-No uniqueness, Delivery Date window), then queues
  ONE `job_edit_requests` row (`action = 'add_job'`, `job_id = NULL`) carrying
  the whole proposed Job as its payload — nothing is created yet.
- **`POST /api/job-edits/:id/act`** — new `request.action === "add_job"`
  branch. On approve: re-validates against live data (same re-checks as the
  existing `add_item` branch), then actually creates the Job (auto-generated
  `job_no`, sequential per user per Budget — identical to `POST
  /api/entries`) and every entries row, logging each as
  `entry_edit_history.field_name = 'job_edit_new_job'`. Backfills the new
  Job's id onto the request row. On reject: no different from the existing
  flow.
- **`GET /api/job-edits` / `GET /api/job-edits/mine`** — the shared SELECT's
  `jobs` join is now `LEFT JOIN` (was `JOIN`), since a pending `add_job`
  request has no `job_id` yet.
- **`src/types.ts`** — `PendingJobEdit.action` adds `'add_job'`; `job_id` is
  now `number | null`; documents the `add_job` payload shape.
- **`src/components/AdminPanel.tsx`** — Job Edit Approvals list renders a
  "New Job" badge + description for `add_job` rows (falls back to the
  proposed Job Name when there's no `job_no` yet); `FIELD_LABELS` adds
  `job_edit_new_job: 'New Job Added (Job Edit)'` for the MPR Edit Log table.
- **`src/components/JobEditPanel.tsx`** — new "Add New Job" button in the
  header opens a form: pick a Budget/Project (derived from this user's own
  already-Final-Submitted Jobs), Job Name, Job Duration, then add one or more
  MPR Nos (each auto-filling its Items, same pattern as "Add MPR to this
  Job"). Submits to `POST /api/job-edits/new-job`. A new "Pending New Job
  Requests" section (between the header and the Job list) shows this user's
  own queued `add_job` requests and their Approved/Rejected status.

## Not covered / known limits

- The Budget/Project picker in "Add New Job" is derived from Jobs this user
  already has locked (`GET /api/entries` filtered to `budget_locked`) — a
  Budget+Project pair with zero active Jobs left (e.g. all deleted) won't
  show up as an option. Edge case, not worth a separate lookup endpoint.
- Per-row Delivery Date only (no shared-date-with-per-item-override or
  "split remaining Qty into a new row" — both present in "Add MPR to this
  Job" — were left out of "Add New Job" to keep the new form simpler; add
  them the same way if needed later.
