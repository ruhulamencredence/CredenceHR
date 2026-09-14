/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// MPR Entries — the core Job Entry CRUD: list (role-scoped), create, edit,
// split, soft delete + Job Recycle (restore/permanent-erase), edit-history,
// and the two small lookup endpoints (mpr-usage, job/:jobId/items) that back
// the entry form's client-side checks. Split out of server.ts on purpose —
// server.ts is already ~8,000 lines in one file, so this moves out as-is (no
// logic changes) the same way Personal Data, Users, Holidays, Attendance,
// and Conveyance Bill Claims already were.
//
// Dependencies below are all defined elsewhere in server.ts (parseQtyNumber/
// toDateOnlyString are plain top-level helpers there, not closures) and
// threaded through as deps rather than duplicated or re-imported directly.

import type { Express } from "express";

interface EntriesRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (moduleKey: string) => any;
  requireBudgetModuleAccess: any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  todayInDhaka: () => string;
  parseQtyNumber: (value: any) => number | null;
  toDateOnlyString: (value: any) => string | null;
}

export function registerEntriesRoutes(app: Express, deps: EntriesRouteDeps) {
  const {
    authenticateToken,
    requireAdmin,
    requireModule,
    requireBudgetModuleAccess,
    queryDB,
    todayInDhaka,
    parseQtyNumber,
    toDateOnlyString
  } = deps;

  // 5. Entries
  //
  // Regular Users only ever see THEIR OWN entries here (Recent Entries must not leak
  // another user's job/entry data) — an Admin still sees everything, since Reports /
  // Job Recycle need the full picture. MPR-No uniqueness is still enforced system-wide
  // server-side regardless of what any one user can see; GET /api/entries/mpr-usage
  // below is the (deliberately minimal) endpoint that lets a User discover "this MPR
  // No is already used, under Job X" without exposing whose entry it is.
  app.get("/api/entries", authenticateToken, async (req: any, res) => {
    try {
      // Every column of the exact Budget Excel row this entry's Item Name was picked
      // from (matched on budget_id + MRF No + Description, via a correlated subquery
      // that resolves to a single budget_items.id so the join can never duplicate a
      // row) is attached here, so both the User's "view" popup and the Admin's full
      // Excel export can show/download Specification, Qty and the rest without a
      // separate round trip.
      let sql = `
        SELECT e.*, p.project_name, j.job_no, j.job_duration, m.mpr_no, u.name as user_name, b.budget_name,
          -- Admin-set Delivery Date window for this entry's Budget, straight from the
          -- budgets row (NOT from GET /api/budgets, which hides an unpublished Budget
          -- from a non-admin caller) — so Job Edit's date picker can always enforce it,
          -- even for a Budget the owner can no longer see in their Budgets list.
          b.delivery_date_from AS delivery_date_from, b.delivery_date_to AS delivery_date_to,
          bi.sl_no AS bi_sl_no, bi.req_no AS bi_req_no, bi.item_date AS bi_item_date,
          bi.specification, bi.req_qty, bi.unit, bi.po_qty, bi.received_qty, bi.balance_qty,
          bi.entry_user AS bi_entry_user, bi.approved_date AS bi_approved_date,
          bi.app_user AS bi_app_user, bi.site_sup_date,
          -- Whether the creating user has already submitted (locked) the Budget this
          -- entry belongs to — the client uses this to decide if editing is allowed.
          (SELECT COUNT(*) FROM budget_submissions bs
             WHERE bs.budget_id = e.budget_id AND bs.user_id = e.created_by) AS budget_locked
        FROM entries e
        JOIN projects p ON e.project_id = p.id
        JOIN jobs j ON e.job_id = j.id
        JOIN mpr_numbers m ON e.mpr_id = m.id
        LEFT JOIN users u ON e.created_by = u.id
        LEFT JOIN budgets b ON e.budget_id = b.id
        -- Prefer the exact source row via budget_item_id (pins to the specific Excel
        -- row, so entries with a duplicate Description still each show their OWN
        -- Specification/Qty). Only falls back to the old description-text match for
        -- entries created before that column existed (budget_item_id IS NULL).
        LEFT JOIN budget_items bi ON bi.id = COALESCE(
          e.budget_item_id,
          (
            SELECT bi2.id FROM budget_items bi2
            WHERE bi2.budget_id = e.budget_id AND LOWER(TRIM(bi2.mrf_no)) = LOWER(TRIM(m.mpr_no))
              AND LOWER(TRIM(bi2.description)) = LOWER(TRIM(e.item_name))
            ORDER BY bi2.id ASC LIMIT 1
          )
        )
        WHERE e.deleted_at IS NULL
      `;
      const params: any[] = [];
      if (req.user.role !== "admin" && req.user.role !== "superadmin") {
        sql += ` AND e.created_by = ?`;
        params.push(req.user.id);
      }
      sql += ` ORDER BY e.entry_date DESC, e.id DESC`;
      const entries = await queryDB(sql, params);
      res.json(
        entries.map((e: any) => ({
          ...e,
          budget_locked: !!Number(e.budget_locked),
          delivery_date_from: toDateOnlyString(e.delivery_date_from),
          delivery_date_to: toDateOnlyString(e.delivery_date_to)
        }))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Minimal, system-wide "is this MPR No already used, and under which Job" lookup —
  // available to every authenticated user (not just Admin), since a User needs this to
  // avoid picking an MPR No someone else already entered. Deliberately leaves out
  // created_by / user_name so it doesn't turn into a way to browse other users' entries.
  app.get("/api/entries/mpr-usage", authenticateToken, async (req: any, res) => {
    try {
      // used_by_other: whether THIS particular usage row belongs to a DIFFERENT user
      // than the caller — deliberately not the creator's name/id (see comment above),
      // just a boolean. An MPR No already used only by the calling user themself is
      // still reusable (to requisition the remaining Qty of an Item under it with a
      // new Delivery Date); one used by someone else stays blocked, same as before.
      const sql = `
        SELECT e.mpr_id, m.mpr_no, j.job_no, e.job_name, p.project_name, e.entry_date,
          (e.created_by <> ?) AS used_by_other
        FROM entries e
        JOIN mpr_numbers m ON e.mpr_id = m.id
        JOIN projects p ON e.project_id = p.id
        JOIN jobs j ON e.job_id = j.id
        WHERE e.deleted_at IS NULL
      `;
      const rows = await queryDB(sql, [req.user.id]);
      res.json(rows.map((r: any) => ({ ...r, used_by_other: !!Number(r.used_by_other) })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Job Recycle bin — every soft-deleted entry (Admin-only). Mirrors the GET
  // /api/entries join so the Admin sees the exact same detail (Item Name,
  // Specification, Qty, etc.) plus who deleted it and when, with a Restore option.
  app.get("/api/entries/recycle", authenticateToken, requireAdmin, requireModule("recycle"), async (req, res) => {
    try {
      let sql = `
        SELECT e.*, p.project_name, j.job_no, j.job_duration, m.mpr_no, u.name as user_name, b.budget_name,
          d.name as deleted_by_name,
          bi.sl_no AS bi_sl_no, bi.req_no AS bi_req_no, bi.item_date AS bi_item_date,
          bi.specification, bi.req_qty, bi.unit, bi.po_qty, bi.received_qty, bi.balance_qty,
          bi.entry_user AS bi_entry_user, bi.approved_date AS bi_approved_date,
          bi.app_user AS bi_app_user, bi.site_sup_date
        FROM entries e
        JOIN projects p ON e.project_id = p.id
        JOIN jobs j ON e.job_id = j.id
        JOIN mpr_numbers m ON e.mpr_id = m.id
        LEFT JOIN users u ON e.created_by = u.id
        LEFT JOIN users d ON e.deleted_by = d.id
        LEFT JOIN budgets b ON e.budget_id = b.id
        LEFT JOIN budget_items bi ON bi.id = COALESCE(
          e.budget_item_id,
          (
            SELECT bi2.id FROM budget_items bi2
            WHERE bi2.budget_id = e.budget_id AND LOWER(TRIM(bi2.mrf_no)) = LOWER(TRIM(m.mpr_no))
              AND LOWER(TRIM(bi2.description)) = LOWER(TRIM(e.item_name))
            ORDER BY bi2.id ASC LIMIT 1
          )
        )
        WHERE e.deleted_at IS NOT NULL
        ORDER BY e.deleted_at DESC, e.id DESC
      `;
      const entries = await queryDB(sql);
      res.json(entries);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/entries", authenticateToken, requireBudgetModuleAccess, async (req: any, res) => {
    try {
      // job_name is now typed by the user (not auto-generated).
      // job_no is now assigned automatically by the server (not typed by the user).
      // "items" is a list of { mpr_id, item_name, delivery_date } — one Job Name / Job No
      // can carry multiple MPR Nos in a single submission, each with its own delivery date.
      // budget_id: the User must first pick a Budget the Admin has created & imported —
      // every entry is now created FROM that Budget and is validated against it below.
      const { budget_id, project_id, job_name, job_duration, items } = req.body;

      if (
        !budget_id ||
        !project_id ||
        !job_name ||
        !String(job_name).trim() ||
        !job_duration ||
        !String(job_duration).trim() ||
        !Array.isArray(items) ||
        items.length === 0
      ) {
        return res.status(400).json({
          error: "Budget, Project, Job Name, Job Duration and at least one MPR No entry are required"
        });
      }

      // The Budget must exist and must actually have imported line items — a Budget
      // that's only been named but never had an Excel imported into it has nothing
      // valid to enter yet.
      const budgetRows = await queryDB("SELECT id FROM budgets WHERE id = ?", [budget_id]);
      if (budgetRows.length === 0) {
        return res.status(400).json({ error: "Invalid Budget selected. Please choose from the list." });
      }

      // Once THIS user has submitted this Budget (marked it as finished), block any
      // further entries from them under it — enforced here too, not just hidden in the
      // UI, so it can't be bypassed via a direct API call.
      const submittedRows = await queryDB("SELECT * FROM budget_submissions WHERE budget_id = ? AND user_id = ?", [
        budget_id,
        req.user.id
      ]);
      if (submittedRows.length > 0) {
        return res.status(400).json({
          error: "This Budget has already been submitted. No further entries can be added to it."
        });
      }

      const budgetItemRows = await queryDB(
        "SELECT mrf_no FROM budget_items WHERE budget_id = ? AND mrf_no IS NOT NULL AND mrf_no <> ''",
        [budget_id]
      );
      if (budgetItemRows.length === 0) {
        return res.status(400).json({ error: "This Budget has no imported MPR/MRF Nos yet." });
      }
      const allowedMprNosForBudget = new Set(
        budgetItemRows.map((r: any) => String(r.mrf_no).trim().toLowerCase())
      );

      for (const it of items) {
        if (
          !it ||
          !it.mpr_id ||
          !it.budget_item_id ||
          !it.item_name ||
          !String(it.item_name).trim() ||
          !it.delivery_date ||
          it.requisitioned_qty === undefined ||
          it.requisitioned_qty === null ||
          String(it.requisitioned_qty).trim() === "" ||
          !(Number(it.requisitioned_qty) > 0)
        ) {
          return res.status(400).json({
            error: "Every MPR row needs an MPR No, Item Name, a Requisitioned Qty greater than 0, and a Delivery Date"
          });
        }
      }

      // Every item must point at a REAL imported Budget Excel row (budget_items.id)
      // belonging to this Budget + this MPR No — this is what lets two rows share the
      // exact same Description of Materials text and still be entered as two separate
      // entries (each pinned to its own source row), instead of collapsing into one.
      // Also re-derive item_name from that row server-side so a direct API call can't
      // smuggle in arbitrary text under a valid budget_item_id.
      const allBudgetItemRows = await queryDB(
        "SELECT id, mrf_no, description, req_qty FROM budget_items WHERE budget_id = ?",
        [budget_id]
      );
      const validItemsById = new Map<number, any>(allBudgetItemRows.map((r: any) => [Number(r.id), r]));
      const mprNoById = new Map<number, string>();
      for (const it of items) {
        const row = validItemsById.get(Number(it.budget_item_id));
        if (!row) {
          return res.status(400).json({
            error: "One of the selected Items no longer matches the imported Budget Excel. Please refresh and try again."
          });
        }
        if (!mprNoById.has(Number(it.mpr_id))) {
          const mprRowForCheck = await queryDB("SELECT mpr_no FROM mpr_numbers WHERE id = ?", [it.mpr_id]);
          mprNoById.set(Number(it.mpr_id), mprRowForCheck[0]?.mpr_no || "");
        }
        const mprNoForCheck = mprNoById.get(Number(it.mpr_id)) || "";
        if (String(row.mrf_no).trim().toLowerCase() !== String(mprNoForCheck).trim().toLowerCase()) {
          return res.status(400).json({
            error: "One of the selected Items does not belong to the selected MPR No."
          });
        }
        // Trust the DB's own Description text, not whatever the client sent.
        it.item_name = String(row.description || "").trim();
      }

      // Cap each item's Requisitioned Qty against its own imported req_qty, PER USER —
      // this user's requested Qty here plus whatever they've already requisitioned
      // against this exact budget_item_id (in earlier, still-active entries) must not
      // exceed the item's original imported Qty. This is what lets the same Item (and
      // its MPR No) be entered again later for the remaining balance, with its own
      // Delivery Date, once an earlier entry against it is edited down.
      // Two rows in the SAME submission can now legitimately share a budget_item_id —
      // the client's "Add new row for the remaining Qty" split lets one Item's Qty be
      // sent under two Delivery Dates in one Job. So this cap has to be checked against
      // each item's COMBINED requested Qty across the whole batch, not row-by-row —
      // checking each row in isolation would let two large rows each individually pass
      // (both under `remaining`) while their sum quietly exceeds what's actually left.
      const batchTotalsByItem = new Map<number, number>();
      for (const it of items) {
        const key = Number(it.budget_item_id);
        batchTotalsByItem.set(key, (batchTotalsByItem.get(key) || 0) + Number(it.requisitioned_qty));
      }
      const checkedItemIds = new Set<number>();
      for (const it of items) {
        const key = Number(it.budget_item_id);
        if (checkedItemIds.has(key)) continue;
        checkedItemIds.add(key);
        const row = validItemsById.get(key);
        const totalQty = parseQtyNumber(row?.req_qty);
        if (totalQty !== null) {
          const consumedRows = await queryDB(
            "SELECT COALESCE(SUM(requisitioned_qty), 0) AS consumed FROM entries WHERE budget_item_id = ? AND created_by = ? AND deleted_at IS NULL",
            [key, req.user.id]
          );
          const consumed = Number(consumedRows[0]?.consumed || 0);
          const remaining = totalQty - consumed;
          const requestedTotal = batchTotalsByItem.get(key) || 0;
          if (requestedTotal > remaining + 0.001) {
            return res.status(400).json({
              error: `Requisitioned Qty for "${it.item_name}" can't exceed the remaining available Qty (${remaining}).`
            });
          }
        }
      }

      // If the Admin has set an allowed Delivery Date window for this Budget, every
      // MPR row's Delivery Date must fall inside it (inclusive) — enforced here too,
      // not just as a min/max on the client's date picker, so it can't be bypassed
      // via a direct API call.
      const rangeRows = await queryDB("SELECT delivery_date_from, delivery_date_to FROM budgets WHERE id = ?", [
        budget_id
      ]);
      const deliveryFrom = toDateOnlyString(rangeRows[0]?.delivery_date_from);
      const deliveryTo = toDateOnlyString(rangeRows[0]?.delivery_date_to);
      if (deliveryFrom || deliveryTo) {
        for (const it of items) {
          const d = String(it.delivery_date).slice(0, 10);
          if ((deliveryFrom && d < deliveryFrom) || (deliveryTo && d > deliveryTo)) {
            return res.status(400).json({
              error: `Delivery Date must be between ${deliveryFrom || "—"} and ${deliveryTo || "—"} for this Budget.`
            });
          }
        }
      }

      // An MPR No that carries several imported Excel rows (even ones that share the
      // exact same Description of Materials text) is now submitted as several items
      // sharing that same mpr_id, one per Excel row (budget_item_id) — that's expected,
      // not a duplicate. It's also expected for the SAME budget_item_id to appear
      // MULTIPLE TIMES under the SAME mpr_id — that's the client's "Split remaining
      // Qty to a new row" feature (see splitLeftoverToNewRow in UserPanel.tsx), which
      // can be used repeatedly to spread one Item's Qty across as many rows/Delivery
      // Dates as needed. There's no fixed cap on how many rows a pair can span — the
      // combined-Qty check above (batchTotalsByItem vs. remaining) already guarantees
      // the rows' Qtys can never add up to more than what was actually available, so
      // that's the only guard needed here; no separate per-pair row-count rejection.

      // Entry date is always today's date — users cannot edit or backdate it.
      const entry_date = todayInDhaka();

      // Enforce that Project Name and every MPR No must come from the Admin-managed lists —
      // this blocks bypassing the dropdown restriction via a direct API call.
      const projectRows = await queryDB("SELECT id, project_name FROM projects WHERE id = ?", [project_id]);
      if (projectRows.length === 0) {
        return res.status(400).json({ error: "Invalid Project selected. Please choose from the list." });
      }
      const projectName = projectRows[0].project_name;

      // Every MPR No must have been imported specifically under this Project within the
      // selected Budget's sheet (a Budget sheet can carry rows for several Projects) —
      // this scopes the MPR No choices to the selected Project, matching the dropdown.
      const projectBudgetItemRows = await queryDB(
        "SELECT mrf_no FROM budget_items WHERE budget_id = ? AND LOWER(TRIM(project_name)) = LOWER(TRIM(?)) AND mrf_no IS NOT NULL AND mrf_no <> ''",
        [budget_id, projectName]
      );
      const allowedMprNosForProject = new Set(
        projectBudgetItemRows.map((r: any) => String(r.mrf_no).trim().toLowerCase())
      );

      // Non-admin users can only submit entries for a project the Admin has granted
      // them access to — enforced here too, not just hidden in the dropdown, so it
      // can't be bypassed with a direct API call.
      if (req.user.role !== "admin" && req.user.role !== "superadmin") {
        const permRows = await queryDB(
          "SELECT id FROM user_project_permissions WHERE user_id = ? AND project_id = ?",
          [req.user.id, project_id]
        );
        if (permRows.length === 0) {
          return res.status(403).json({ error: "You don't have permission to submit entries for this project." });
        }
      }

      for (const it of items) {
        const mprRows = await queryDB("SELECT id, mpr_no FROM mpr_numbers WHERE id = ?", [it.mpr_id]);
        if (mprRows.length === 0) {
          return res.status(400).json({ error: "Invalid MPR No selected. Please choose from the list." });
        }
        // Enforce that the MPR No actually belongs to the selected Budget's imported
        // sheet — blocks entering an MPR No from a different Budget via a direct API call.
        if (!allowedMprNosForBudget.has(String(mprRows[0].mpr_no).trim().toLowerCase())) {
          return res.status(400).json({
            error: `MPR No "${mprRows[0].mpr_no}" was not imported into the selected Budget.`
          });
        }
        // Enforce that the MPR No was specifically imported under the selected Project
        // (not just somewhere else in the same Budget sheet) — blocks picking an MPR No
        // that belongs to a different Project via a direct API call.
        if (!allowedMprNosForProject.has(String(mprRows[0].mpr_no).trim().toLowerCase())) {
          return res.status(400).json({
            error: `MPR No "${mprRows[0].mpr_no}" does not belong to the selected Project "${projectName}".`
          });
        }
      }

      // An MPR No can only ever be used ONCE, system-wide, full stop — reject it here
      // too if it's already attached to ANY earlier entry (this same user's own, under
      // this Job or any other, or a different user's) under THIS SAME Budget, so the
      // dropdown restriction can't be bypassed via a direct API call. It's never
      // reusable again afterwards by anyone, including whoever used it originally. The
      // same MPR No is still allowed again once it's used under a different Budget.
      for (const it of items) {
        // Deleted entries free up their MPR No for reuse — only an active (non-deleted)
        // entry counts as "already used".
        const usedRows = await queryDB(
          "SELECT id FROM entries WHERE mpr_id = ? AND budget_id = ? AND deleted_at IS NULL",
          [it.mpr_id, budget_id]
        );
        if (usedRows.length > 0) {
          return res.status(400).json({
            warning: true,
            error: "One of the selected MPR Nos has already been used in another entry under this Budget."
          });
        }
      }

      // 1. Auto-generate a Job No sequential PER USER PER BUDGET (e.g. JOB-0001,
      // JOB-0002 ... for THIS user under THIS Budget specifically) — so every user's
      // own submissions start again from JOB-0001 independently of what any other user
      // is on, AND start again from JOB-0001 whenever they move to a different Budget.
      const jobCountRows = await queryDB("SELECT COUNT(*) as cnt FROM jobs WHERE created_by = ? AND budget_id = ?", [
        req.user.id,
        budget_id
      ]);
      const nextJobSeq = (jobCountRows[0]?.cnt || 0) + 1;
      const job_no = `JOB-${String(nextJobSeq).padStart(4, "0")}`;

      // 2. Create one Job for this submission (Job No is unique per user PER BUDGET,
      // not globally and not just per user)
      const jobResult = await queryDB(
        "INSERT INTO jobs (job_no, job_duration, created_by, budget_id) VALUES (?, ?, ?, ?)",
        [job_no, String(job_duration).trim(), req.user.id, budget_id]
      );
      const jobId = jobResult.insertId;

      // 3. Insert one entry per MPR No — all sharing this Job Name + Job No, and all
      // tagged with the Budget they were created from + the User who created them.
      const insertedIds: number[] = [];
      for (const it of items) {
        const result = await queryDB(
          `INSERT INTO entries (entry_date, job_name, budget_id, project_id, job_id, mpr_id, budget_item_id, item_name, requisitioned_qty, delivery_date, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry_date,
            String(job_name).trim(),
            budget_id,
            project_id,
            jobId,
            it.mpr_id,
            it.budget_item_id,
            String(it.item_name).trim(),
            Number(it.requisitioned_qty),
            it.delivery_date,
            req.user.id
          ]
        );
        insertedIds.push(result.insertId);
      }

      res.json({
        success: true,
        job_no,
        job_name: String(job_name).trim(),
        budget_id,
        entry_date,
        count: insertedIds.length,
        ids: insertedIds
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to save entry" });
    }
  });

  // "Job Edit" — add a new MPR row into an EXISTING Job (unlike POST /api/entries,
  // which always creates a brand-new Job). This is what lets a user extend a Job that
  // was already Final Submitted. Before the owning user has Final Submitted the
  // Job's Budget, this is just a normal part of entering data (same as
  // POST /api/entries) — no extra permission needed. Once that Budget HAS been
  // Final Submitted, adding to a Job is gated on can_job_edit (Admin Panel ->
  // Users) for non-admins, matching "user add edit delete kichui korte parbe na"
  // if the Admin hasn't turned Job Edit on for them.
  app.post("/api/entries/job/:jobId/items", authenticateToken, async (req: any, res) => {
    try {
      const jobId = Number(req.params.jobId);
      const { items } = req.body;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "At least one MPR row is required" });
      }

      const jobRows = await queryDB("SELECT * FROM jobs WHERE id = ?", [jobId]);
      if (jobRows.length === 0) return res.status(404).json({ error: "Job not found" });
      const job = jobRows[0];

      // Set below when this add must be QUEUED for Admin approval instead of applied
      // immediately — a non-admin, Final-Submitted Job, relying on the can_job_edit
      // permission (as opposed to editing before Final Submit, which needs no special
      // permission at all and is never queued). See the queuing branch further down,
      // right before the insert loop.
      let queueForApproval = false;

      if (req.user.role !== "admin" && req.user.role !== "superadmin" && job.created_by !== req.user.id) {
        return res.status(403).json({ error: "You can only edit your own Jobs." });
      }
      if (req.user.role !== "admin" && req.user.role !== "superadmin") {
        // Only require can_job_edit once the owner has ALREADY Final Submitted this
        // Job's Budget — before that, adding another MPR to your own not-yet-locked
        // Job needs no special permission, same as creating one in the first place.
        const ownSubmissionRows = await queryDB(
          "SELECT id FROM budget_submissions WHERE budget_id = ? AND user_id = ?",
          [job.budget_id, req.user.id]
        );
        const budgetAlreadySubmitted = ownSubmissionRows.length > 0;
        if (budgetAlreadySubmitted) {
          const permRows = await queryDB("SELECT can_job_edit FROM users WHERE id = ?", [req.user.id]);
          const canJobEdit = permRows.length > 0 && !!Number(permRows[0].can_job_edit);
          if (!canJobEdit) {
            return res.status(403).json({ error: "You don't have permission to edit Jobs. Ask your Admin to enable Job Edit for your account." });
          }
          // can_job_edit unlocks Add MPR on a Final-Submitted Job, but the change
          // itself must still go through Admin approval before it actually lands —
          // see PEPM Manage -> Edit Log (requireModule("editlog")) below.
          queueForApproval = true;
        }
      }

      const budget_id = job.budget_id;
      if (!budget_id) {
        return res.status(400).json({ error: "This Job isn't linked to a Budget, so items can't be added to it." });
      }

      // A Job's entries all share one Project (set when the Job was first created) —
      // pull it from any existing (non-deleted) entry under this Job.
      const anyEntryRows = await queryDB(
        "SELECT project_id, job_name FROM entries WHERE job_id = ? AND deleted_at IS NULL LIMIT 1",
        [jobId]
      );
      if (anyEntryRows.length === 0) {
        return res.status(400).json({ error: "This Job has no active MPR entries to attach to." });
      }
      const project_id = anyEntryRows[0].project_id;
      const job_name = anyEntryRows[0].job_name;

      for (const it of items) {
        if (
          !it ||
          !it.mpr_id ||
          !it.budget_item_id ||
          !it.delivery_date ||
          it.requisitioned_qty === undefined ||
          it.requisitioned_qty === null ||
          String(it.requisitioned_qty).trim() === "" ||
          !(Number(it.requisitioned_qty) > 0)
        ) {
          return res.status(400).json({
            error: "Every MPR row needs an MPR No, an Item, a Requisitioned Qty greater than 0, and a Delivery Date"
          });
        }
      }

      // Every item must point at a REAL imported Budget Excel row belonging to this
      // Budget, and match the selected MPR No — same validation as creating a new Job.
      const allBudgetItemRows = await queryDB(
        "SELECT id, mrf_no, description, req_qty FROM budget_items WHERE budget_id = ?",
        [budget_id]
      );
      const validItemsById = new Map<number, any>(allBudgetItemRows.map((r: any) => [Number(r.id), r]));
      const mprNoById = new Map<number, string>();
      for (const it of items) {
        const row = validItemsById.get(Number(it.budget_item_id));
        if (!row) {
          return res.status(400).json({
            error: "One of the selected Items no longer matches the imported Budget Excel. Please refresh and try again."
          });
        }
        if (!mprNoById.has(Number(it.mpr_id))) {
          const mprRowForCheck = await queryDB("SELECT mpr_no FROM mpr_numbers WHERE id = ?", [it.mpr_id]);
          mprNoById.set(Number(it.mpr_id), mprRowForCheck[0]?.mpr_no || "");
        }
        const mprNoForCheck = mprNoById.get(Number(it.mpr_id)) || "";
        if (String(row.mrf_no).trim().toLowerCase() !== String(mprNoForCheck).trim().toLowerCase()) {
          return res.status(400).json({ error: "One of the selected Items does not belong to the selected MPR No." });
        }
        it.item_name = String(row.description || "").trim();
      }

      // Cap each item's Requisitioned Qty against remaining Qty, PER USER — same rule
      // as creating a new Job (see POST /api/entries for the full explanation).
      const batchTotalsByItem = new Map<number, number>();
      for (const it of items) {
        const key = Number(it.budget_item_id);
        batchTotalsByItem.set(key, (batchTotalsByItem.get(key) || 0) + Number(it.requisitioned_qty));
      }
      const checkedItemIds = new Set<number>();
      for (const it of items) {
        const key = Number(it.budget_item_id);
        if (checkedItemIds.has(key)) continue;
        checkedItemIds.add(key);
        const row = validItemsById.get(key);
        const totalQty = parseQtyNumber(row?.req_qty);
        if (totalQty !== null) {
          const consumedRows = await queryDB(
            "SELECT COALESCE(SUM(requisitioned_qty), 0) AS consumed FROM entries WHERE budget_item_id = ? AND created_by = ? AND deleted_at IS NULL",
            [key, job.created_by]
          );
          const consumed = Number(consumedRows[0]?.consumed || 0);
          const remaining = totalQty - consumed;
          const requestedTotal = batchTotalsByItem.get(key) || 0;
          if (requestedTotal > remaining + 0.001) {
            return res.status(400).json({
              error: `Requisitioned Qty for "${it.item_name}" can't exceed the remaining available Qty (${remaining}).`
            });
          }
        }
      }

      // Admin-set Delivery Date window for the Budget, if any.
      const rangeRows = await queryDB("SELECT delivery_date_from, delivery_date_to FROM budgets WHERE id = ?", [
        budget_id
      ]);
      const deliveryFrom = toDateOnlyString(rangeRows[0]?.delivery_date_from);
      const deliveryTo = toDateOnlyString(rangeRows[0]?.delivery_date_to);
      if (deliveryFrom || deliveryTo) {
        for (const it of items) {
          const d = String(it.delivery_date).slice(0, 10);
          if ((deliveryFrom && d < deliveryFrom) || (deliveryTo && d > deliveryTo)) {
            return res.status(400).json({
              error: `Delivery Date must be between ${deliveryFrom || "—"} and ${deliveryTo || "—"} for this Budget.`
            });
          }
        }
      }
      // Every new MPR row added here is dated today (entry_date, set further below) —
      // its Delivery Date can never be earlier than today, mirroring the min/max
      // already enforced on the client's date picker.
      {
        const today = todayInDhaka();
        for (const it of items) {
          const d = String(it.delivery_date).slice(0, 10);
          if (d < today) {
            return res.status(400).json({ error: `Delivery Date can't be earlier than today (${today}).` });
          }
        }
      }

      // An MPR No can only ever be used ONCE, system-wide — same rule as creation.
      for (const it of items) {
        const usedRows = await queryDB(
          "SELECT id FROM entries WHERE mpr_id = ? AND budget_id = ? AND deleted_at IS NULL",
          [it.mpr_id, budget_id]
        );
        if (usedRows.length > 0) {
          return res.status(400).json({
            error: "One of the selected MPR Nos has already been used in another entry under this Budget."
          });
        }
      }

      // Job Edit (can_job_edit), on a Final-Submitted Job, never applies directly —
      // every proposed MPR row is queued as its own job_edit_requests row (so the
      // reviewing Admin, and this user's own "Edit Pending Admin Approval" badge,
      // can act on/track each one independently) and only lands in `entries` once
      // an Admin with the "editlog" module approves it (see POST /api/job-edits/:id/act
      // further down, and GET /api/job-edits for the Admin-side review list).
      if (queueForApproval) {
        const queuedIds: number[] = [];
        for (const it of items) {
          const mprNo = mprNoById.get(Number(it.mpr_id)) || "";
          const payload = {
            mpr_no: mprNo,
            mpr_id: it.mpr_id,
            budget_item_id: it.budget_item_id,
            item_name: it.item_name,
            requisitioned_qty: Number(it.requisitioned_qty),
            delivery_date: it.delivery_date
          };
          const result = await queryDB(
            "INSERT INTO job_edit_requests (job_id, entry_id, action, payload, status, requested_by) VALUES (?, NULL, 'add_item', ?, 'pending', ?)",
            [jobId, JSON.stringify(payload), req.user.id]
          );
          queuedIds.push(result.insertId);
        }
        return res.json({
          success: true,
          pending: true,
          message: `Submitted — ${queuedIds.length > 1 ? "these MPR rows are" : "this MPR row is"} pending Admin approval.`,
          job_id: jobId,
          count: queuedIds.length
        });
      }

      const entry_date = todayInDhaka();
      const insertedIds: number[] = [];
      for (const it of items) {
        const result = await queryDB(
          `INSERT INTO entries (entry_date, job_name, budget_id, project_id, job_id, mpr_id, budget_item_id, item_name, requisitioned_qty, delivery_date, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry_date,
            job_name,
            budget_id,
            project_id,
            jobId,
            it.mpr_id,
            it.budget_item_id,
            it.item_name,
            Number(it.requisitioned_qty),
            it.delivery_date,
            job.created_by
          ]
        );
        insertedIds.push(result.insertId);
        // So an Admin/Superadmin can see, in the "MPR Edit Log" tab, exactly which new
        // MPR rows were added into an already Final-Submitted Job via Job Edit, by
        // whom, and when — not just edits to EXISTING rows (which the PUT endpoint
        // below already logs). old_value is blank since there was nothing before it;
        // new_value carries the Qty/Delivery Date, since Item Name, MPR No and Job No
        // are already available via the entry join in GET /api/entries/edit-history.
        await queryDB(
          "INSERT INTO entry_edit_history (entry_id, edited_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)",
          [
            result.insertId,
            req.user.id,
            "job_edit_add",
            "",
            `Qty: ${it.requisitioned_qty}, Delivery Date: ${it.delivery_date}`
          ]
        );
      }

      res.json({ success: true, job_id: jobId, count: insertedIds.length, ids: insertedIds });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to add MPR to Job" });
    }
  });

  // Edit an existing MPR entry. Item Name and Delivery Date are always required; Job
  // Name, Job Duration and MPR No are optional in the request body and only touched
  // when the client actually sends a changed value (undefined = leave as-is). Allowed
  // only for the User who created it. Before THIS user's Final Submit ("Submit Budget")
  // of the Budget it belongs to, every field is freely editable — including MPR No,
  // Item, Qty, Job Name and Job Duration on a row already attached to a Job. Once that
  // Budget has been Final Submitted, this locks down to Delivery-Date-only, same as
  // before — unless that user has the Job Edit permission, which still only unlocks
  // Add/Delete of MPR rows on a Final-Submitted Job, not editing an existing row's
  // other fields.
  // Job Name and Job Duration are shared by every MPR row of the same Job, so a change
  // to either is applied — and logged in entry_edit_history — for every entry under
  // that Job, not just the row that was open when the edit was made.
  app.put("/api/entries/:id", authenticateToken, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { item_name, delivery_date, job_name, job_duration, mpr_id, budget_item_id, requisitioned_qty } = req.body;

      if (!item_name || !String(item_name).trim() || !delivery_date) {
        return res.status(400).json({ error: "Item Name and Delivery Date are required" });
      }
      // requisitioned_qty is optional in the request body (older callers that don't
      // send it leave the entry's existing Qty untouched), but if it IS sent it must
      // be a positive number — capped against the item's remaining Qty further below.
      const qtyProvided =
        requisitioned_qty !== undefined && requisitioned_qty !== null && String(requisitioned_qty).trim() !== "";
      if (qtyProvided && !(Number(requisitioned_qty) > 0)) {
        return res.status(400).json({ error: "Requisitioned Qty must be greater than 0" });
      }
      if (job_name !== undefined && !String(job_name).trim()) {
        return res.status(400).json({ error: "Job Name cannot be empty" });
      }
      if (job_duration !== undefined && !String(job_duration).trim()) {
        return res.status(400).json({ error: "Job Duration cannot be empty" });
      }

      const rows = await queryDB(
        `SELECT e.*, j.job_duration AS current_job_duration, m.mpr_no AS current_mpr_no
         FROM entries e
         JOIN jobs j ON e.job_id = j.id
         JOIN mpr_numbers m ON e.mpr_id = m.id
         WHERE e.id = ?`,
        [id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Entry not found" });
      const entry = rows[0];

      // Only the owner (or an Admin) can edit — an Admin can edit any entry.
      if (req.user.role !== "admin" && req.user.role !== "superadmin" && entry.created_by !== req.user.id) {
        return res.status(403).json({ error: "You can only edit your own entries." });
      }

      // Fetch this user's own feature-permission flags fresh (not from the JWT, which
      // can be up to 7 days stale) so an Admin toggling them takes effect immediately.
      let canEditDeliveryDate = true;
      let canJobEdit = false;
      if (req.user.role !== "admin" && req.user.role !== "superadmin") {
        const permRows = await queryDB("SELECT can_edit_delivery_date, can_job_edit FROM users WHERE id = ?", [
          req.user.id
        ]);
        if (permRows.length > 0) {
          canEditDeliveryDate = permRows[0].can_edit_delivery_date === undefined || !!Number(permRows[0].can_edit_delivery_date);
          canJobEdit = !!Number(permRows[0].can_job_edit);
        }
      }

      // Once this entry's Budget has been submitted (by the user who owns the entry)
      // it's "Final Submitted" / locked. Job Edit (can_job_edit) does NOT unlock
      // editing an existing entry's fields here — it only unlocks adding a new MPR
      // (POST /api/entries/job/:jobId/items) and deleting one (DELETE below). Editing
      // an existing row stays Delivery-Date-only, exactly like the pre-lock stage,
      // gated by can_edit_delivery_date — so a non-admin is blocked here entirely
      // only if they have NEITHER permission at all.
      let budgetLocked = false;
      if (entry.budget_id && req.user.role !== "admin" && req.user.role !== "superadmin") {
        const submittedRows = await queryDB(
          "SELECT id FROM budget_submissions WHERE budget_id = ? AND user_id = ?",
          [entry.budget_id, entry.created_by]
        );
        budgetLocked = submittedRows.length > 0;
        if (budgetLocked && !canJobEdit && !canEditDeliveryDate) {
          return res.status(400).json({
            error: "This entry's Budget has already been submitted. It can no longer be edited."
          });
        }
      }

      // An Admin always gets a truly unrestricted edit here. A regular User/owner is
      // ALSO fully unrestricted as long as their Budget hasn't been Final Submitted yet
      // (budgetLocked === false) — before that point, every field (MPR No, Item, Qty,
      // Job Name, Job Duration, Delivery Date) stays freely editable, including for
      // entries already attached to a Job ("Add MPR to Job" / Job creation does not by
      // itself lock a row). can_job_edit is NOT part of this — once the Budget IS Final
      // Submitted, can_job_edit never allows Requisitioned Qty (or any other field
      // besides Delivery Date) to change on an EXISTING row; it only unlocks Add/Delete
      // of MPR rows on an otherwise-locked, Final-Submitted Job.
      const fullyUnlocked = req.user.role === "admin" || req.user.role === "superadmin" || !budgetLocked;

      // Once this entry's Budget has been Final Submitted, a non-admin User without Job
      // Edit can only ever change its Delivery Date — Job Name, Job Duration, MPR No,
      // Item Name/selection and Requisitioned Qty are all locked from that point on. If
      // the user doesn't even have the Delivery Date permission, Delivery Date is locked
      // too. The UI no longer offers inputs for the locked fields, but that alone
      // doesn't stop a direct API call, so re-check here: any of these fields sent with
      // a value different from what's already stored is rejected outright.
      if (!fullyUnlocked) {
        const lockedMismatches: string[] = [];
        if (item_name !== undefined && String(item_name).trim() !== String(entry.item_name)) {
          lockedMismatches.push("Item Name");
        }
        if (job_name !== undefined && String(job_name).trim() !== String(entry.job_name)) {
          lockedMismatches.push("Job Name");
        }
        if (job_duration !== undefined && String(job_duration).trim() !== String(entry.current_job_duration)) {
          lockedMismatches.push("Job Duration");
        }
        if (mpr_id !== undefined && Number(mpr_id) !== Number(entry.mpr_id)) {
          lockedMismatches.push("MPR No");
        }
        if (
          budget_item_id !== undefined &&
          budget_item_id !== null &&
          Number(budget_item_id) !== Number(entry.budget_item_id)
        ) {
          lockedMismatches.push("Item selection");
        }
        if (qtyProvided && Number(requisitioned_qty) !== Number(entry.requisitioned_qty)) {
          lockedMismatches.push("Requisitioned Qty");
        }
        const newDeliveryDateForCheck = String(delivery_date).slice(0, 10);
        const oldDeliveryDateForCheck = toDateOnlyString(entry.delivery_date) || "";
        if (!canEditDeliveryDate && newDeliveryDateForCheck !== oldDeliveryDateForCheck) {
          lockedMismatches.push("Delivery Date");
        }
        if (lockedMismatches.length > 0) {
          return res.status(400).json({
            error: `Only Delivery Date can be edited after an entry is submitted. (${lockedMismatches.join(", ")} cannot be changed.)`
          });
        }
      }

      // --- Resolve the effective MPR No for this save (unchanged unless mpr_id given) ---
      let effectiveMprId = entry.mpr_id;
      let effectiveMprNo = entry.current_mpr_no;
      const mprChanged = mpr_id !== undefined && Number(mpr_id) !== Number(entry.mpr_id);
      if (mprChanged) {
        const newMprRows = await queryDB("SELECT id, mpr_no FROM mpr_numbers WHERE id = ?", [mpr_id]);
        if (newMprRows.length === 0) {
          return res.status(400).json({ error: "Invalid MPR No selected. Please choose from the list." });
        }
        // An MPR No can only ever be used ONCE, system-wide — same rule as creation,
        // scoped to this entry's own Budget, excluding this entry itself (re-selecting
        // its own current MPR No must stay allowed) and any deleted entry (deleted
        // entries free up their MPR No for reuse). Never reusable again afterwards by
        // anyone, including this entry's own owner under a different entry/Job.
        const usedRows = await queryDB(
          "SELECT id FROM entries WHERE mpr_id = ? AND budget_id = ? AND id <> ? AND deleted_at IS NULL",
          [mpr_id, entry.budget_id, id]
        );
        if (usedRows.length > 0) {
          return res.status(400).json({ error: "That MPR No has already been used in another entry under this Budget." });
        }
        // Must still belong to the same Budget + Project this entry was created under —
        // blocks smuggling in an MPR No from an unrelated Budget/Project via a direct API call.
        if (entry.budget_id) {
          const projRows = await queryDB("SELECT project_name FROM projects WHERE id = ?", [entry.project_id]);
          const projectName = projRows[0]?.project_name || "";
          const allowedRows = await queryDB(
            "SELECT id FROM budget_items WHERE budget_id = ? AND LOWER(TRIM(mrf_no)) = LOWER(TRIM(?)) AND LOWER(TRIM(project_name)) = LOWER(TRIM(?))",
            [entry.budget_id, newMprRows[0].mpr_no, projectName]
          );
          if (allowedRows.length === 0) {
            return res.status(400).json({
              error: `MPR No "${newMprRows[0].mpr_no}" was not imported for this Project under this entry's Budget.`
            });
          }
        }
        effectiveMprId = Number(mpr_id);
        effectiveMprNo = newMprRows[0].mpr_no;
      }

      // If the entry's Budget has an Admin-set Delivery Date window, the new Delivery
      // Date must still fall inside it (inclusive) — enforced here too, not just as a
      // min/max on the client's date picker, so it can't be bypassed via a direct API call.
      const newDeliveryDate = String(delivery_date).slice(0, 10);
      if (entry.budget_id) {
        const rangeRows = await queryDB("SELECT delivery_date_from, delivery_date_to FROM budgets WHERE id = ?", [
          entry.budget_id
        ]);
        const deliveryFrom = toDateOnlyString(rangeRows[0]?.delivery_date_from);
        const deliveryTo = toDateOnlyString(rangeRows[0]?.delivery_date_to);
        if ((deliveryFrom && newDeliveryDate < deliveryFrom) || (deliveryTo && newDeliveryDate > deliveryTo)) {
          return res.status(400).json({
            error: `Delivery Date must be between ${deliveryFrom || "—"} and ${deliveryTo || "—"} for this Budget.`
          });
        }
      }

      // A Delivery Date can never be moved to a point before the entry was created,
      // nor before today (the day of this edit) — only checked when the date is
      // actually being changed, so re-saving an old entry whose Delivery Date already
      // predates today (untouched) never breaks. Applies to every editor, including
      // Job Edit, mirroring the min/max already enforced on the client's date picker.
      const oldDeliveryDateForFloor = toDateOnlyString(entry.delivery_date) || "";
      if (newDeliveryDate !== oldDeliveryDateForFloor) {
        const entryDateStr = toDateOnlyString(entry.entry_date) || "";
        const floor = entryDateStr && entryDateStr > todayInDhaka() ? entryDateStr : todayInDhaka();
        if (newDeliveryDate < floor) {
          return res.status(400).json({
            error: `Delivery Date can't be earlier than ${floor} (the entry date / today).`
          });
        }
      }

      // If the entry came from a Budget, the new Item must still be one of that
      // Budget's imported Excel rows for the effective (possibly newly-picked) MPR No —
      // blocks typing in an arbitrary value via a direct API call. When the client sends
      // a specific budget_item_id (the normal path from the edit UI), pin to that EXACT
      // Excel row so entries with a duplicate Description text still resolve to their
      // own Specification/Qty; only falls back to a description-text match for older
      // callers that don't send budget_item_id.
      let effectiveBudgetItemId: number | null = entry.budget_item_id ?? null;
      if (entry.budget_id) {
        if (budget_item_id) {
          const validRows = await queryDB(
            "SELECT id, description FROM budget_items WHERE id = ? AND budget_id = ? AND LOWER(TRIM(mrf_no)) = LOWER(TRIM(?))",
            [budget_item_id, entry.budget_id, effectiveMprNo]
          );
          if (validRows.length === 0) {
            return res.status(400).json({
              error: "Item must be one of the rows imported for this MPR No in the Budget."
            });
          }
          effectiveBudgetItemId = Number(budget_item_id);
        } else {
          const validRows = await queryDB(
            "SELECT id FROM budget_items WHERE budget_id = ? AND LOWER(TRIM(mrf_no)) = LOWER(TRIM(?)) AND LOWER(TRIM(description)) = LOWER(TRIM(?))",
            [entry.budget_id, effectiveMprNo, item_name]
          );
          if (validRows.length === 0) {
            return res.status(400).json({
              error: "Item Name must be one of the Descriptions imported for this MPR No in the Budget."
            });
          }
          // No specific row chosen — leave budget_item_id as-is only if it still matches
          // this MPR No, otherwise clear it so GET /api/entries falls back to the
          // (now-ambiguous) description-text match rather than pointing at a stale row.
          if (mprChanged) effectiveBudgetItemId = null;
        }
      }

      // Cap the (possibly edited) Requisitioned Qty against the item's remaining
      // balance for this entry's OWNER — same rule as creation, excluding this entry's
      // own current Qty from the "already consumed" sum (since we're replacing it).
      let effectiveRequisitionedQty: number | null = entry.requisitioned_qty ?? null;
      if (qtyProvided && effectiveBudgetItemId) {
        const itemRows = await queryDB("SELECT req_qty FROM budget_items WHERE id = ?", [effectiveBudgetItemId]);
        const totalQty = parseQtyNumber(itemRows[0]?.req_qty);
        if (totalQty !== null) {
          const consumedRows = await queryDB(
            "SELECT COALESCE(SUM(requisitioned_qty), 0) AS consumed FROM entries WHERE budget_item_id = ? AND created_by = ? AND deleted_at IS NULL AND id <> ?",
            [effectiveBudgetItemId, entry.created_by, id]
          );
          const consumed = Number(consumedRows[0]?.consumed || 0);
          const remaining = totalQty - consumed;
          if (Number(requisitioned_qty) > remaining + 0.001) {
            return res.status(400).json({
              error: `Requisitioned Qty can't exceed the remaining available Qty (${remaining}).`
            });
          }
        }
        effectiveRequisitionedQty = Number(requisitioned_qty);
      }

      // --- Apply changes + record history (only for fields that actually changed) ---
      const editedBy = req.user.id;
      const rowHistory: { field: string; oldVal: string; newVal: string }[] = [];

      const trimmedItemName = String(item_name).trim();
      if (trimmedItemName !== String(entry.item_name)) {
        rowHistory.push({ field: "item_name", oldVal: entry.item_name, newVal: trimmedItemName });
      }
      const oldDeliveryDate = toDateOnlyString(entry.delivery_date) || "";
      if (newDeliveryDate !== oldDeliveryDate) {
        rowHistory.push({ field: "delivery_date", oldVal: oldDeliveryDate, newVal: newDeliveryDate });
      }
      if (mprChanged) {
        rowHistory.push({ field: "mpr_no", oldVal: entry.current_mpr_no, newVal: effectiveMprNo });
      }
      // Numeric comparison, not string — entry.requisitioned_qty comes back from a
      // DECIMAL column (e.g. the string "5.00"), while effectiveRequisitionedQty is a
      // plain JS number (e.g. 5). Comparing those as strings ("5" !== "5.00") falsely
      // flagged Requisitioned Qty as "changed" any time it was merely re-sent unchanged
      // (e.g. while only editing Delivery Date), polluting the Edit Log with entries
      // for a field that was never actually touched.
      const oldQtyNum =
        entry.requisitioned_qty === null || entry.requisitioned_qty === undefined ? null : Number(entry.requisitioned_qty);
      if (qtyProvided && Number(effectiveRequisitionedQty) !== oldQtyNum) {
        rowHistory.push({
          field: "requisitioned_qty",
          oldVal: oldQtyNum === null ? "" : String(oldQtyNum),
          newVal: String(effectiveRequisitionedQty)
        });
      }

      await queryDB(
        "UPDATE entries SET item_name = ?, delivery_date = ?, mpr_id = ?, budget_item_id = ?, requisitioned_qty = ? WHERE id = ?",
        [trimmedItemName, newDeliveryDate, effectiveMprId, effectiveBudgetItemId, effectiveRequisitionedQty, id]
      );
      for (const h of rowHistory) {
        await queryDB(
          "INSERT INTO entry_edit_history (entry_id, edited_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)",
          [id, editedBy, h.field, h.oldVal, h.newVal]
        );
      }

      // Job Name / Job Duration are shared by every MPR row under the same Job.
      const jobNameChanged = job_name !== undefined && String(job_name).trim() !== String(entry.job_name);
      const jobDurationChanged =
        job_duration !== undefined && String(job_duration).trim() !== String(entry.current_job_duration);

      if (jobNameChanged || jobDurationChanged) {
        const siblingRows = await queryDB("SELECT id FROM entries WHERE job_id = ?", [entry.job_id]);
        const siblingIds = siblingRows.map((s: any) => s.id);

        if (jobNameChanged) {
          const trimmedJobName = String(job_name).trim();
          await queryDB("UPDATE entries SET job_name = ? WHERE job_id = ?", [trimmedJobName, entry.job_id]);
          for (const sid of siblingIds) {
            await queryDB(
              "INSERT INTO entry_edit_history (entry_id, edited_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)",
              [sid, editedBy, "job_name", entry.job_name, trimmedJobName]
            );
          }
        }
        if (jobDurationChanged) {
          const trimmedJobDuration = String(job_duration).trim();
          await queryDB("UPDATE jobs SET job_duration = ? WHERE id = ?", [trimmedJobDuration, entry.job_id]);
          for (const sid of siblingIds) {
            await queryDB(
              "INSERT INTO entry_edit_history (entry_id, edited_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)",
              [sid, editedBy, "job_duration", entry.current_job_duration, trimmedJobDuration]
            );
          }
        }
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to update entry" });
    }
  });

  // Split an existing entry's Requisitioned Qty into two entries under the SAME Job +
  // MPR No + Item, each free to carry its own Delivery Date — mirrors the "Split
  // remaining Qty into a new item" feature already available while first creating a
  // Job (see splitLeftoverInSameRow in UserPanel.tsx), now available on an entry
  // that's already been saved, for as long as it's still fully editable (i.e. its
  // Budget hasn't been Final Submitted yet — same cutoff PUT /api/entries/:id uses for
  // full field-editing). can_job_edit does NOT unlock this once the Budget IS Final
  // Submitted — splitting an existing row's Qty is a structural change to an
  // already-locked row, not "adding a new MPR row" (POST /api/entries/job/:jobId/items).
  // The two resulting entries always add back up to exactly this entry's original Qty,
  // so nothing is created or lost against the Budget's imported balance.
  app.post("/api/entries/:id/split", authenticateToken, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { split_qty, split_delivery_date } = req.body;

      const rows = await queryDB("SELECT * FROM entries WHERE id = ?", [id]);
      if (rows.length === 0 || rows[0].deleted_at) return res.status(404).json({ error: "Entry not found" });
      const entry = rows[0];

      // Only the owner (or an Admin) can split — an Admin can split any entry.
      if (req.user.role !== "admin" && req.user.role !== "superadmin" && entry.created_by !== req.user.id) {
        return res.status(403).json({ error: "You can only edit your own entries." });
      }

      if (entry.budget_id && req.user.role !== "admin" && req.user.role !== "superadmin") {
        const submittedRows = await queryDB(
          "SELECT id FROM budget_submissions WHERE budget_id = ? AND user_id = ?",
          [entry.budget_id, entry.created_by]
        );
        if (submittedRows.length > 0) {
          return res.status(400).json({
            error: "This entry's Budget has already been submitted. It can no longer be split."
          });
        }
      }

      const currentQty =
        entry.requisitioned_qty === null || entry.requisitioned_qty === undefined ? null : Number(entry.requisitioned_qty);
      const splitQtyNum = Number(split_qty);
      if (currentQty === null || !(currentQty > 0)) {
        return res.status(400).json({ error: "This entry has no Requisitioned Qty to split." });
      }
      if (!Number.isFinite(splitQtyNum) || !(splitQtyNum > 0)) {
        return res.status(400).json({ error: "Enter a valid Qty to split off." });
      }
      // Both resulting rows must end up with something — splitting off the entire
      // Qty would just be moving the entry, not splitting it.
      if (splitQtyNum >= currentQty) {
        return res.status(400).json({
          error: `Qty to split off must be less than the entry's current Qty (${currentQty}) — some must remain on the original entry.`
        });
      }
      if (!split_delivery_date) {
        return res.status(400).json({ error: "Delivery Date is required for the split-off entry." });
      }

      // If the entry's Budget has an Admin-set Delivery Date window, the split-off
      // entry's Delivery Date must still fall inside it (inclusive) — same rule PUT
      // enforces on a normal edit.
      const newDeliveryDate = String(split_delivery_date).slice(0, 10);
      if (entry.budget_id) {
        const rangeRows = await queryDB("SELECT delivery_date_from, delivery_date_to FROM budgets WHERE id = ?", [
          entry.budget_id
        ]);
        const deliveryFrom = toDateOnlyString(rangeRows[0]?.delivery_date_from);
        const deliveryTo = toDateOnlyString(rangeRows[0]?.delivery_date_to);
        if ((deliveryFrom && newDeliveryDate < deliveryFrom) || (deliveryTo && newDeliveryDate > deliveryTo)) {
          return res.status(400).json({
            error: `Delivery Date must be between ${deliveryFrom || "—"} and ${deliveryTo || "—"} for this Budget.`
          });
        }
      }
      // Never earlier than today, mirroring every other Delivery Date entry point (the
      // split-off row is a brand-new entry, dated today, same as Add MPR to Job).
      const today = todayInDhaka();
      if (newDeliveryDate < today) {
        return res.status(400).json({ error: `Delivery Date can't be earlier than today (${today}).` });
      }

      const remainingQty = currentQty - splitQtyNum;

      // 1. Shrink the original entry down to whatever's left, logged exactly like any
      // other Requisitioned Qty edit.
      await queryDB("UPDATE entries SET requisitioned_qty = ? WHERE id = ?", [remainingQty, id]);
      await queryDB(
        "INSERT INTO entry_edit_history (entry_id, edited_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)",
        [id, req.user.id, "requisitioned_qty", String(currentQty), String(remainingQty)]
      );

      // 2. Insert the split-off portion as its own entry — same Job, MPR No and Item,
      // just its own Qty and Delivery Date. Deliberately bypasses the usual "MPR No can
      // only be used once" check (see POST /api/entries and .../job/:jobId/items): this
      // is the one legitimate case of two active entries sharing an MPR No, since
      // together they always add back up to exactly what the original entry held.
      const result = await queryDB(
        `INSERT INTO entries (entry_date, job_name, budget_id, project_id, job_id, mpr_id, budget_item_id, item_name, requisitioned_qty, delivery_date, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          today,
          entry.job_name,
          entry.budget_id,
          entry.project_id,
          entry.job_id,
          entry.mpr_id,
          entry.budget_item_id,
          entry.item_name,
          splitQtyNum,
          newDeliveryDate,
          entry.created_by
        ]
      );
      await queryDB(
        "INSERT INTO entry_edit_history (entry_id, edited_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)",
        [
          result.insertId,
          req.user.id,
          "split_from_entry",
          "",
          `Split from entry #${id} — Qty: ${splitQtyNum}, Delivery Date: ${newDeliveryDate}`
        ]
      );

      res.json({ success: true, new_entry_id: result.insertId, remaining_qty: remainingQty });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to split entry" });
    }
  });

  // Full change history for one entry row (Item Name, Delivery Date, MPR No, and any
  // Job Name / Job Duration edits made from this or a sibling row under the same Job).
  // Admin-only, per the Admin Panel's Reports tab.
  app.get("/api/entries/:id/history", authenticateToken, requireAdmin, requireModule("reports"), async (req, res) => {
    try {
      const { id } = req.params;
      const rows = await queryDB(
        `SELECT h.*, u.name AS editor_name
         FROM entry_edit_history h
         LEFT JOIN users u ON h.edited_by = u.id
         WHERE h.entry_id = ?
         ORDER BY h.edited_at DESC, h.id DESC`,
        [id]
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // System-wide edit log across EVERY entry — this is what powers the Admin Panel's
  // own "MPR Edit Log" tab, separate from the per-entry history popup above. Lets an
  // Admin see, across ALL Job Numbers / MPR Nos / Users, which day each edit happened
  // and what changed, without having to open each entry's history one at a time.
  // Joins in the entry's Job No and (current) MPR No so every row is identifiable even
  // after the entry itself has since been further edited or its owner has moved on.
  app.get("/api/entries/edit-history", authenticateToken, requireAdmin, requireModule("editlog"), async (req, res) => {
    try {
      const rows = await queryDB(
        `SELECT h.*, u.name AS editor_name,
                j.job_no, e.job_name, e.mpr_id, m.mpr_no, e.item_name,
                e.created_by AS entry_owner_id, ou.name AS entry_owner_name
         FROM entry_edit_history h
         JOIN entries e ON h.entry_id = e.id
         JOIN jobs j ON e.job_id = j.id
         JOIN mpr_numbers m ON e.mpr_id = m.id
         LEFT JOIN users u ON h.edited_by = u.id
         LEFT JOIN users ou ON e.created_by = ou.id
         ORDER BY h.edited_at DESC, h.id DESC`,
        []
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Entry deletion is now available to the User who owns the entry, not just the
  // Admin (an Admin can still delete any entry). It's a SOFT delete — the entry moves
  // into the Admin's Job Recycle bin (Reports -> Job Recycle) instead of being erased,
  // so an accidental delete can still be restored. Same lock rule as editing: once
  // this entry's Budget has been submitted by its owner, a non-admin can no longer
  // delete it either.
  app.delete("/api/entries/:id", authenticateToken, async (req: any, res) => {
    try {
      const { id } = req.params;
      const rows = await queryDB(
        `SELECT e.*, j.job_duration AS current_job_duration, m.mpr_no AS current_mpr_no
         FROM entries e
         JOIN jobs j ON e.job_id = j.id
         JOIN mpr_numbers m ON e.mpr_id = m.id
         WHERE e.id = ?`,
        [id]
      );
      if (rows.length === 0 || rows[0].deleted_at) {
        return res.status(404).json({ error: "Entry not found" });
      }
      const entry = rows[0];

      // Only the owner (or an Admin) can delete — an Admin can delete any entry.
      if (req.user.role !== "admin" && req.user.role !== "superadmin" && entry.created_by !== req.user.id) {
        return res.status(403).json({ error: "You can only delete your own entries." });
      }

      // Once this entry's Budget has been submitted (by the user who owns the entry),
      // it's locked — deleting must be blocked here too, same rule as editing. A
      // non-admin with the Job Edit permission (Admin Panel -> Users) is exempt: that
      // permission is specifically what lets them delete an MPR out of an already
      // Final-Submitted Job — but even then, the delete is QUEUED for Admin approval
      // (job_edit_requests) rather than applied immediately, same as Add MPR above.
      if (entry.budget_id && req.user.role !== "admin" && req.user.role !== "superadmin") {
        const submittedRows = await queryDB(
          "SELECT id FROM budget_submissions WHERE budget_id = ? AND user_id = ?",
          [entry.budget_id, entry.created_by]
        );
        if (submittedRows.length > 0) {
          const permRows = await queryDB("SELECT can_job_edit FROM users WHERE id = ?", [req.user.id]);
          const canJobEdit = permRows.length > 0 && !!Number(permRows[0].can_job_edit);
          if (!canJobEdit) {
            return res.status(400).json({
              error: "This entry's Budget has already been submitted. It can no longer be deleted."
            });
          }
          // Refuse a second delete request while one against this same entry is
          // already pending review — the UI already disables the Delete button once
          // pending, this is just the server-side backstop against a direct API call.
          const existingPending = await queryDB(
            "SELECT id FROM job_edit_requests WHERE entry_id = ? AND action = 'delete_entry' AND status = 'pending'",
            [id]
          );
          if (existingPending.length > 0) {
            return res.status(400).json({ error: "A delete request for this MPR is already pending Admin approval." });
          }
          await queryDB(
            "INSERT INTO job_edit_requests (job_id, entry_id, action, payload, status, requested_by) VALUES (?, ?, 'delete_entry', NULL, 'pending', ?)",
            [entry.job_id, id, req.user.id]
          );
          return res.json({
            success: true,
            pending: true,
            message: "Submitted — this MPR's deletion is pending Admin approval."
          });
        }
      }

      await queryDB("UPDATE entries SET deleted_at = NOW(), deleted_by = ? WHERE id = ?", [req.user.id, id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to delete entry" });
    }
  });

  // Restore a soft-deleted entry out of the Job Recycle bin (Admin-only).
  app.post("/api/entries/:id/restore", authenticateToken, requireAdmin, requireModule("recycle"), async (req, res) => {
    try {
      const { id } = req.params;
      const rows = await queryDB("SELECT id, deleted_at FROM entries WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Entry not found" });
      if (!rows[0].deleted_at) return res.status(400).json({ error: "This entry is not in the Recycle bin." });

      await queryDB("UPDATE entries SET deleted_at = NULL, deleted_by = NULL WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to restore entry" });
    }
  });

  // Permanently erase an entry from the Job Recycle bin (Admin-only). Only allowed on
  // an entry that's already soft-deleted — this can't be used to bypass the soft
  // delete on an active entry.
  app.delete("/api/entries/:id/permanent", authenticateToken, requireAdmin, requireModule("recycle"), async (req, res) => {
    try {
      const { id } = req.params;
      const rows = await queryDB("SELECT id, deleted_at FROM entries WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Entry not found" });
      if (!rows[0].deleted_at) {
        return res.status(400).json({ error: "This entry must be deleted first before it can be permanently erased." });
      }

      await queryDB("DELETE FROM entries WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to permanently delete entry" });
    }
  });

  // Shared SELECT for both GET /api/job-edits/mine and GET /api/job-edits below —
  // joins the requester/reviewer names and (for a 'delete_entry' request) the
  // target entry's current MPR No / Item / Qty / Delivery Date, so the client never
  // needs a second round trip to show what's actually pending.
  const JOB_EDIT_REQUEST_SELECT = `
    SELECT r.id, r.job_id, j.job_no, e.job_name, r.entry_id, r.action, r.payload, r.status,
      r.requested_by, ru.name AS requested_by_name,
      r.reviewed_by, rv.name AS reviewed_by_name, r.reviewed_at, r.review_note, r.created_at,
      m.mpr_no AS entry_mpr_no, e.item_name AS entry_item_name,
      e.requisitioned_qty AS entry_requisitioned_qty, e.delivery_date AS entry_delivery_date
    FROM job_edit_requests r
    JOIN jobs j ON r.job_id = j.id
    JOIN users ru ON r.requested_by = ru.id
    LEFT JOIN users rv ON r.reviewed_by = rv.id
    LEFT JOIN entries e ON r.entry_id = e.id
    LEFT JOIN mpr_numbers m ON e.mpr_id = m.id
  `;

  // Parses the TEXT `payload` column back into an object (or null for a
  // 'delete_entry' row, which never has one) — shared by both list endpoints below.
  const parseJobEditRequestRow = (row: any) => ({
    ...row,
    payload: row.payload ? JSON.parse(row.payload) : null
  });

  // This user's own queued Job Edit requests — pending ones (drives the "Edit/Delete
  // Pending Admin Approval" badges) plus anything reviewed in the last 2 days (so a
  // rejection is still visible for a bit, not just silently gone) — see JobEditPanel.tsx.
  app.get("/api/job-edits/mine", authenticateToken, async (req: any, res) => {
    try {
      const rows = await queryDB(
        `${JOB_EDIT_REQUEST_SELECT}
         WHERE r.requested_by = ?
           AND (r.status = 'pending' OR (r.status <> 'pending' AND r.reviewed_at >= NOW() - INTERVAL 2 DAY))
         ORDER BY r.created_at DESC`,
        [req.user.id]
      );
      res.json(rows.map(parseJobEditRequestRow));
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to load your pending Job Edit requests" });
    }
  });

  // Admin Panel -> PEPM Manage -> Edit Log's "Job Edit Approvals" list — every User's
  // queued Job Edit requests (pending first, most recent first), for an Admin with the
  // "editlog" module specifically — NOT every Admin, matching how Job Edit's own
  // approval is meant to stay scoped to whoever already reviews the Edit Log.
  app.get("/api/job-edits", authenticateToken, requireAdmin, requireModule("editlog"), async (req, res) => {
    try {
      // Every still-pending request, plus anything reviewed in the last 30 days for
      // the "Recently Reviewed" list — bounded so this never grows unbounded; the
      // MPR Edit Log table below already keeps the permanent record of an approved
      // Add MPR, and an old rejection isn't useful to keep surfacing here.
      const rows = await queryDB(
        `${JOB_EDIT_REQUEST_SELECT}
         WHERE r.status = 'pending' OR r.reviewed_at >= NOW() - INTERVAL 30 DAY
         ORDER BY (r.status = 'pending') DESC, r.created_at DESC`
      );
      res.json(rows.map(parseJobEditRequestRow));
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to load Job Edit requests" });
    }
  });

  // Approve or reject a queued Job Edit request — same "editlog" gate as the list
  // above. Approving actually performs the underlying change now (INSERT for
  // add_item, soft-delete for delete_entry); rejecting just marks it reviewed and
  // leaves the Job untouched. Either way the request itself is terminal afterwards —
  // it can't be acted on twice.
  app.post("/api/job-edits/:id/act", authenticateToken, requireAdmin, requireModule("editlog"), async (req: any, res) => {
    try {
      const { id } = req.params;
      const { action, note } = req.body;
      if (action !== "approve" && action !== "reject") {
        return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
      }

      const rows = await queryDB("SELECT * FROM job_edit_requests WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Job Edit request not found" });
      const request = rows[0];
      if (request.status !== "pending") {
        return res.status(400).json({ error: "This request has already been reviewed." });
      }

      if (action === "reject") {
        await queryDB(
          "UPDATE job_edit_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), review_note = ? WHERE id = ?",
          [req.user.id, note || null, id]
        );
        return res.json({ success: true, status: "rejected" });
      }

      // action === "approve" — apply the change the request was queued for.
      if (request.action === "add_item") {
        const payload = JSON.parse(request.payload);

        const jobRows = await queryDB("SELECT * FROM jobs WHERE id = ?", [request.job_id]);
        if (jobRows.length === 0) {
          return res.status(400).json({ error: "The Job this request was for no longer exists." });
        }
        const job = jobRows[0];
        const anyEntryRows = await queryDB(
          "SELECT project_id, job_name FROM entries WHERE job_id = ? AND deleted_at IS NULL LIMIT 1",
          [request.job_id]
        );
        if (anyEntryRows.length === 0) {
          return res.status(400).json({ error: "This Job has no active MPR entries left to attach to." });
        }

        // Re-validate against current data before actually inserting — time has
        // passed since the User submitted this request, so the remaining Qty or the
        // MPR No's availability may have changed since (e.g. another Job Edit was
        // approved, or the MPR No got used elsewhere in the meantime).
        const budgetItemRows = await queryDB(
          "SELECT id, req_qty FROM budget_items WHERE id = ? AND budget_id = ?",
          [payload.budget_item_id, job.budget_id]
        );
        if (budgetItemRows.length === 0) {
          return res.status(400).json({
            error: "The selected Item no longer matches the imported Budget Excel. This request can no longer be approved as-is."
          });
        }
        const totalQty = parseQtyNumber(budgetItemRows[0].req_qty);
        if (totalQty !== null) {
          const consumedRows = await queryDB(
            "SELECT COALESCE(SUM(requisitioned_qty), 0) AS consumed FROM entries WHERE budget_item_id = ? AND created_by = ? AND deleted_at IS NULL",
            [payload.budget_item_id, job.created_by]
          );
          const remaining = totalQty - Number(consumedRows[0]?.consumed || 0);
          if (Number(payload.requisitioned_qty) > remaining + 0.001) {
            return res.status(400).json({
              error: `Requisitioned Qty for "${payload.item_name}" now exceeds the remaining available Qty (${remaining}). This request can no longer be approved as-is.`
            });
          }
        }
        const usedRows = await queryDB(
          "SELECT id FROM entries WHERE mpr_id = ? AND budget_id = ? AND deleted_at IS NULL",
          [payload.mpr_id, job.budget_id]
        );
        if (usedRows.length > 0) {
          return res.status(400).json({
            error: "That MPR No has since been used in another entry under this Budget. This request can no longer be approved as-is."
          });
        }

        const entry_date = todayInDhaka();
        const result = await queryDB(
          `INSERT INTO entries (entry_date, job_name, budget_id, project_id, job_id, mpr_id, budget_item_id, item_name, requisitioned_qty, delivery_date, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry_date,
            anyEntryRows[0].job_name,
            job.budget_id,
            anyEntryRows[0].project_id,
            request.job_id,
            payload.mpr_id,
            payload.budget_item_id,
            payload.item_name,
            Number(payload.requisitioned_qty),
            payload.delivery_date,
            job.created_by
          ]
        );
        await queryDB(
          "INSERT INTO entry_edit_history (entry_id, edited_by, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)",
          [
            result.insertId,
            request.requested_by,
            "job_edit_add",
            "",
            `Qty: ${payload.requisitioned_qty}, Delivery Date: ${payload.delivery_date}`
          ]
        );
        await queryDB(
          "UPDATE job_edit_requests SET status = 'approved', entry_id = ?, reviewed_by = ?, reviewed_at = NOW(), review_note = ? WHERE id = ?",
          [result.insertId, req.user.id, note || null, id]
        );
      } else {
        // delete_entry
        if (!request.entry_id) {
          return res.status(400).json({ error: "This request no longer points at a valid entry." });
        }
        const entryRows = await queryDB("SELECT id, deleted_at FROM entries WHERE id = ?", [request.entry_id]);
        if (entryRows.length === 0 || entryRows[0].deleted_at) {
          return res.status(400).json({ error: "This MPR row no longer exists or was already deleted." });
        }
        await queryDB("UPDATE entries SET deleted_at = NOW(), deleted_by = ? WHERE id = ?", [
          request.requested_by,
          request.entry_id
        ]);
        await queryDB(
          "UPDATE job_edit_requests SET status = 'approved', reviewed_by = ?, reviewed_at = NOW(), review_note = ? WHERE id = ?",
          [req.user.id, note || null, id]
        );
      }

      res.json({ success: true, status: "approved" });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to act on this Job Edit request" });
    }
  });
}
