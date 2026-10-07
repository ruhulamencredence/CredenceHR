/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// MPR Numbers, Budgets (Excel import, publish, submit, approve), Rate File, Delivery Date conditions and Jobs routes,
// moved out of server.ts unchanged. The shared helpers they use are passed in by startServer().

import { activeGroupId } from "./companyContext";
import { DeliveryConditionType } from "./deliveryDateConditions";
import { addDaysToDateStr } from "./deliveryDateConditions";
import { resolveMinLeadDays } from "./deliveryDateConditions";
import { memoryDb } from "./memoryDbFallback";
import type { Express } from "express";

export interface RegisterBudgetImportRoutesDeps {
  authenticateToken: any;
  bulkInsert: any;
  dbPool: any;
  findOrCreateMpr: any;
  findOrCreateProject: any;
  isMySQLConnected: any;
  queryDB: any;
  requireAdmin: any;
  requireBudgetModuleAccess: any;
  requireModule: any;
  scopedExecute: any;
  toDateOnlyString: any;
  todayInDhaka: any;
}

export function registerBudgetImportRoutes(app: Express, deps: RegisterBudgetImportRoutesDeps) {
  const { authenticateToken, bulkInsert, dbPool, findOrCreateMpr, findOrCreateProject, isMySQLConnected, queryDB, requireAdmin, requireBudgetModuleAccess, requireModule, scopedExecute, toDateOnlyString, todayInDhaka } = deps;
  // 3. MPR Numbers CRUD
  app.get("/api/mpr-numbers", authenticateToken, async (req, res) => {
    try {
      const mprs = await queryDB("SELECT * FROM mpr_numbers ORDER BY mpr_no ASC");
      res.json(mprs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/mpr-numbers", authenticateToken, requireAdmin, requireModule("mprs"), async (req: any, res) => {
    try {
      const { mpr_no } = req.body;
      if (!mpr_no) return res.status(400).json({ error: "MPR number is required" });

      const result = await queryDB("INSERT INTO mpr_numbers (mpr_no, created_by) VALUES (?, ?)", [
        mpr_no.trim(),
        req.user.id
      ]);
      res.json({ id: result.insertId, mpr_no: mpr_no.trim() });
    } catch (err: any) {
      if (err.code === "ER_DUP_ENTRY" || err.message?.includes("already exists")) {
        return res.status(400).json({ error: "MPR number already exists" });
      }
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/mpr-numbers/:id", authenticateToken, requireAdmin, requireModule("mprs"), async (req, res) => {
    try {
      const { id } = req.params;
      const { mpr_no } = req.body;
      if (!mpr_no) return res.status(400).json({ error: "MPR number is required" });

      await queryDB("UPDATE mpr_numbers SET mpr_no = ? WHERE id = ?", [mpr_no.trim(), id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/mpr-numbers/:id", authenticateToken, requireAdmin, requireModule("mprs"), async (req, res) => {
    try {
      const { id } = req.params;
      await queryDB("DELETE FROM mpr_numbers WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 3b. Budgets — created by the Admin, then an Excel sheet of line items is imported
  // into them. Importing auto-adds every MRF No to the Approved MPR list and every
  // Project Name to the Approved Project list, if they don't already exist.
  // Listing is open to any authenticated user (not admin-only): Users must browse the
  // Budgets the Admin has created & imported before they're allowed to start a new MPR
  // Entry — clicking a Budget is now the entry point into the Entry form.
  app.get("/api/budgets", authenticateToken, async (req, res) => {
    try {
      // Explicit columns (not SELECT *) so the potentially large file_data blob is
      // never sent down for the list view — only whether a file exists (has_file).
      const budgets = await queryDB(
        "SELECT id, budget_name, created_by, created_at, original_filename, delivery_date_from, delivery_date_to, rate_approved_at, rate_approved_by, is_published, published_at, (file_data IS NOT NULL) AS has_file FROM budgets ORDER BY created_at DESC"
      );
      const counts = await queryDB("SELECT budget_id, COUNT(*) as cnt FROM budget_items GROUP BY budget_id");
      const countMap: Record<number, number> = {};
      for (const c of counts) countMap[c.budget_id] = Number(c.cnt);
      // Which of these Budgets has THIS user already submitted (and is therefore
      // locked from further entries)? Scoped to req.user.id, not global.
      const submittedRows = await queryDB("SELECT budget_id FROM budget_submissions WHERE user_id = ?", [
        (req as any).user.id
      ]);
      const submittedSet = new Set(submittedRows.map((r: any) => Number(r.budget_id)));
      const isAdmin = (req as any).user.role === "admin" || (req as any).user.role === "superadmin";
      const mapped = budgets.map((b: any) => ({
        ...b,
        has_file: !!Number(b.has_file),
        delivery_date_from: toDateOnlyString(b.delivery_date_from),
        delivery_date_to: toDateOnlyString(b.delivery_date_to),
        item_count: countMap[b.id] || 0,
        is_published: !!Number(b.is_published),
        submitted: submittedSet.has(Number(b.id))
      }));
      // Non-admin Users only ever see Budgets the Admin has explicitly Submitted
      // (is_published) from the Import Rate File / Import Budget from Excel page —
      // a Budget that's still being imported/reviewed stays invisible to them.
      // Admins always see every Budget, published or not, so they can manage it.
      res.json(isAdmin ? mapped : mapped.filter((b: any) => b.is_published));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Download/view the original Excel file that was imported into this Budget.
  app.get("/api/budgets/:id/file", authenticateToken, requireAdmin, requireModule("imports"), async (req, res) => {
    try {
      const budgetId = Number(req.params.id);
      const rows = await queryDB(
        "SELECT id, original_filename, file_mimetype, file_data FROM budgets WHERE id = ?",
        [budgetId]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Budget not found" });
      const b = rows[0];
      if (!b.file_data) return res.status(404).json({ error: "No Excel file has been saved for this budget yet" });

      const buffer: Buffer = Buffer.isBuffer(b.file_data) ? b.file_data : Buffer.from(b.file_data);
      res.setHeader("Content-Type", b.file_mimetype || "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(b.original_filename || `budget_${budgetId}.xlsx`)}"`
      );
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/budgets", authenticateToken, requireAdmin, requireModule("imports"), async (req: any, res) => {
    try {
      const { budget_name } = req.body;
      if (!budget_name || !String(budget_name).trim()) {
        return res.status(400).json({ error: "Budget Name is required" });
      }
      const result = await queryDB("INSERT INTO budgets (budget_name, created_by) VALUES (?, ?)", [
        String(budget_name).trim(),
        req.user.id
      ]);
      res.json({ id: result.insertId, budget_name: String(budget_name).trim() });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to create budget" });
    }
  });

  // "Submit" a Budget (Admin-only): flips is_published on, which is what makes it
  // show up in GET /api/budgets for ordinary Users — until this is called, the Budget
  // only exists on the Admin's Data Import page. Body { published: false } lets the
  // Admin pull a Budget back to Draft (e.g. it was submitted by mistake, or needs more
  // rows imported first) without deleting anything already saved on it.
  app.post("/api/budgets/:id/publish", authenticateToken, requireAdmin, requireModule("imports"), async (req: any, res) => {
    try {
      const budgetId = Number(req.params.id);
      const budgetRows = await queryDB("SELECT id FROM budgets WHERE id = ?", [budgetId]);
      if (budgetRows.length === 0) return res.status(404).json({ error: "Budget not found" });

      const publish = req.body?.published !== false; // default: publish
      await queryDB("UPDATE budgets SET is_published = ?, published_at = ? WHERE id = ?", [
        publish ? 1 : 0,
        publish ? new Date() : null,
        budgetId
      ]);
      res.json({ success: true, is_published: publish });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to update Budget submission status" });
    }
  });

  // Open to any authenticated user (not admin-only): once a User picks a Budget from
  // the list, the Entry Form calls this to know exactly which Project(s) and MPR/MRF
  // Nos were imported into that Budget, so only those can be picked for a new entry.
  app.get("/api/budgets/:id/items", authenticateToken, async (req: any, res) => {
    try {
      // requisitioned_by_me: how much of THIS item's Qty the CALLING user has already
      // put into their own active entries — lets the User Entry Form show/cap the
      // remaining Requisitioned Qty available to them for each item (req_qty is the
      // item's total from the imported Excel, shared across the sheet; consumption is
      // tracked per user, per the app's Requisitioned Qty splitting feature).
      const items = await queryDB(
        `SELECT bi.*,
           (SELECT COALESCE(SUM(e.requisitioned_qty), 0) FROM entries e
              WHERE e.budget_item_id = bi.id AND e.created_by = ? AND e.deleted_at IS NULL) AS requisitioned_by_me
         FROM budget_items bi WHERE bi.budget_id = ? ORDER BY bi.id ASC`,
        [req.user.id, req.params.id]
      );
      res.json(items);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Look up the imported "Description of Materials" for a given MRF/MPR No, so the User
  // Entry Form can auto-fill Item Name the moment an MPR No is selected. Open to any
  // authenticated user (not admin-only) since this is used from the User Entry Form.
  // If the same MRF No was imported more than once, the most recently imported row wins.
  app.get("/api/budget-items/lookup", authenticateToken, async (req, res) => {
    try {
      const mprNo = String(req.query.mpr_no || "").trim();
      if (!mprNo) return res.json({ description: null });
      const rows = await queryDB(
        "SELECT description FROM budget_items WHERE LOWER(mrf_no) = LOWER(?) ORDER BY id DESC LIMIT 1",
        [mprNo]
      );
      res.json({ description: rows.length > 0 ? rows[0].description : null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // "Submit Budget" — a User marks a Budget as finished once they've entered every Job
  // they intend to under it. Recorded per (budget_id, user_id): after this, POST
  // /api/entries rejects any further entries from THIS user under THIS budget. It does
  // not affect other users still working on the same Budget, and it's irreversible from
  // the User side (only an Admin deleting the Budget clears it).
  app.post("/api/budgets/:id/submit", authenticateToken, requireBudgetModuleAccess, async (req: any, res) => {
    try {
      const budgetId = Number(req.params.id);
      const budgets = await queryDB("SELECT id FROM budgets WHERE id = ?", [budgetId]);
      if (budgets.length === 0) return res.status(404).json({ error: "Budget not found" });

      const already = await queryDB("SELECT * FROM budget_submissions WHERE budget_id = ? AND user_id = ?", [
        budgetId,
        req.user.id
      ]);
      if (already.length > 0) {
        return res.json({ success: true, already_submitted: true });
      }

      // Block submitting an empty Budget as "finished" — this user must have created
      // at least one entry under this Budget first. Enforced here too (not just a
      // disabled button in the UI) so it can't be bypassed via a direct API call.
      const ownEntryRows = await queryDB("SELECT id FROM entries WHERE budget_id = ? AND created_by = ? LIMIT 1", [
        budgetId,
        req.user.id
      ]);
      if (ownEntryRows.length === 0) {
        return res.status(400).json({
          error: "You haven't added any entries to this Budget yet. Add at least one MPR entry before submitting."
        });
      }

      await queryDB("INSERT INTO budget_submissions (budget_id, user_id) VALUES (?, ?)", [budgetId, req.user.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to submit budget" });
    }
  });

  // Final Submit ONE Job — only that Job's entries lock for this user; the
  // Budget's other Jobs stay open. Needs at least one of the user's own active
  // entries in the Job.
  app.post("/api/jobs/:id/submit", authenticateToken, requireBudgetModuleAccess, async (req: any, res) => {
    try {
      const jobId = Number(req.params.id);
      const jobs = await queryDB("SELECT id, budget_id, job_no FROM jobs WHERE id = ?", [jobId]);
      if (jobs.length === 0) return res.status(404).json({ error: "Job not found" });
      const job = jobs[0];
      const own = await queryDB("SELECT id FROM entries WHERE job_id = ? AND created_by = ? AND deleted_at IS NULL LIMIT 1", [
        jobId,
        req.user.id
      ]);
      if (own.length === 0) return res.status(400).json({ error: "You have no entries in this Job to submit." });
      const budgetDone = job.budget_id
        ? await queryDB("SELECT id FROM budget_submissions WHERE budget_id = ? AND user_id = ?", [job.budget_id, req.user.id])
        : [];
      const already = await queryDB("SELECT id FROM job_submissions WHERE job_id = ? AND user_id = ?", [jobId, req.user.id]);
      if (budgetDone.length > 0 || already.length > 0) return res.json({ success: true, already_submitted: true });
      await queryDB("INSERT INTO job_submissions (job_id, budget_id, user_id) VALUES (?, ?, ?)", [jobId, job.budget_id || null, req.user.id]);
      res.json({ success: true, job_no: job.job_no });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to submit the Job" });
    }
  });

  // List everyone who has Final Submitted a given Budget (Admin-only) — feeds the
  // "Submissions" panel on the Data Import page, which is where the manual unlock
  // button below lives. active_entry_count is shown alongside each name so the
  // Admin can see at a glance whether a user's submission still has entries behind
  // it (normal) or is already empty (would auto-unlock the moment any of their
  // entries got deleted — see unlockBudgetSubmissionIfEmpty in EntriesRoutes.ts —
  // but isn't wrong to leave alone either, hence the manual override existing too).
  app.get(
    "/api/budgets/:id/submissions",
    authenticateToken,
    requireAdmin,
    requireModule("imports"),
    async (req, res) => {
      try {
        const budgetId = Number(req.params.id);
        const rows = await queryDB(
          `SELECT bs.user_id, bs.submitted_at, u.name AS user_name,
             (SELECT COUNT(*) FROM entries e
                WHERE e.budget_id = bs.budget_id AND e.created_by = bs.user_id AND e.deleted_at IS NULL
             ) AS active_entry_count
           FROM budget_submissions bs
           JOIN users u ON u.id = bs.user_id
           WHERE bs.budget_id = ?
           ORDER BY bs.submitted_at DESC`,
          [budgetId]
        );
        const jobRows = await queryDB(
          `SELECT js.user_id, js.job_id, js.submitted_at, u.name AS user_name, j.job_no,
             (SELECT COUNT(*) FROM entries e
                WHERE e.job_id = js.job_id AND e.created_by = js.user_id AND e.deleted_at IS NULL
             ) AS active_entry_count
           FROM job_submissions js
           JOIN users u ON u.id = js.user_id
           JOIN jobs j ON j.id = js.job_id
           WHERE js.budget_id = ?
           ORDER BY js.submitted_at DESC`,
          [budgetId]
        );
        res.json([
          ...rows.map((r: any) => ({ ...r, kind: "budget", job_id: null, job_no: null, active_entry_count: Number(r.active_entry_count) })),
          ...jobRows.map((r: any) => ({ ...r, kind: "job", active_entry_count: Number(r.active_entry_count) }))
        ]);
      } catch (err: any) {
        res.status(500).json({ error: err.message || "Failed to load Budget submissions" });
      }
    }
  );

  // Manual "Unlock Submission" (Admin-only) — lifts a single user's Final Submit
  // lock on this Budget regardless of whether they still have active entries under
  // it, for whenever the Admin wants to let someone back in to add/fix entries
  // without waiting on (or instead of) the automatic unlock above. Same effect as
  // that automatic path: just removing the budget_submissions row.
  app.delete(
    "/api/budgets/:id/submissions/:userId",
    authenticateToken,
    requireAdmin,
    requireModule("imports"),
    async (req, res) => {
      try {
        const budgetId = Number(req.params.id);
        const userId = Number(req.params.userId);
        // ?job_id= unlocks that one Job's Final Submit; without it, the whole Budget's.
        const jobId = Number(req.query.job_id) || null;
        if (jobId) await queryDB("DELETE FROM job_submissions WHERE job_id = ? AND user_id = ? AND budget_id = ?", [jobId, userId, budgetId]);
        else await queryDB("DELETE FROM budget_submissions WHERE budget_id = ? AND user_id = ?", [budgetId, userId]);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message || "Failed to unlock this Budget submission" });
      }
    }
  );

  // "Approve & Calculate" — Admin action per Budget. Matches every one of this Budget's
  // MPR entries against the Rate File (Item Name + Specification -> Rate, Item Name ->
  // Materials Category), computes Amount = Rate x Req. Qty, and writes the result onto
  // each entry. Re-runnable any time (e.g. after the Admin updates the Rate File to fill
  // in previously-missing items) — it always recomputes from scratch using whatever is
  // currently in rate_list / material_categories, it never merges with old values.
  app.post("/api/budgets/:id/approve", authenticateToken, requireAdmin, requireModule("imports"), async (req: any, res) => {
    try {
      const budgetId = Number(req.params.id);
      const budgetRows = await queryDB("SELECT id FROM budgets WHERE id = ?", [budgetId]);
      if (budgetRows.length === 0) return res.status(404).json({ error: "Budget not found" });

      // Blank-ish placeholder text ("NONE", "N/A", "-", etc. — common in these Excel
      // sheets where a real Excel-blank wasn't used) normalizes to the SAME empty
      // string as an actual blank cell, so "Specification: NONE" matches a Rate row
      // whose Specification cell is genuinely empty.
      const BLANK_SPEC_WORDS = new Set(["none", "n/a", "na", "n.a", "n.a.", "nil", "-", "--", "nill"]);
      const norm = (v: any) => {
        if (v === null || v === undefined) return "";
        const s = String(v).trim().toLowerCase().replace(/\s+/g, " ");
        return BLANK_SPEC_WORDS.has(s) ? "" : s;
      };

      let entryRows: any[];
      let rateRows: any[];
      let categoryRows: any[];

      if (isMySQLConnected && dbPool) {
        // Resolve each entry back to its source Budget Excel row the same way GET
        // /api/entries does: prefer budget_item_id, fall back to an MRF No +
        // Description text match for entries created before that column existed.
        const [rows]: any = await scopedExecute(
          `
          SELECT e.id, e.item_name,
            bi.description AS bi_description, bi.specification AS bi_specification, bi.req_qty AS bi_req_qty
          FROM entries e
          JOIN mpr_numbers m ON e.mpr_id = m.id
          LEFT JOIN budget_items bi ON bi.id = COALESCE(
            e.budget_item_id,
            (
              SELECT bi2.id FROM budget_items bi2
              WHERE bi2.budget_id = e.budget_id AND LOWER(TRIM(bi2.mrf_no)) = LOWER(TRIM(m.mpr_no))
                AND LOWER(TRIM(bi2.description)) = LOWER(TRIM(e.item_name))
              ORDER BY bi2.id ASC LIMIT 1
            )
          )
          WHERE e.budget_id = ? AND e.deleted_at IS NULL
          `,
          [budgetId]
        );
        entryRows = rows;
        const [r]: any = await scopedExecute("SELECT materials_name, unit, rate, specification FROM rate_list");
        rateRows = r;
        const [c]: any = await scopedExecute("SELECT head, sub1, sub2, sub3, details, sector FROM material_categories");
        categoryRows = c;
      } else {
        const budgetItemsById = new Map(memoryDb.budget_items.map((bi: any) => [bi.id, bi]));
        entryRows = memoryDb.entries
          .filter((e: any) => e.budget_id === budgetId && !e.deleted_at)
          .map((e: any) => {
            const bi = e.budget_item_id ? budgetItemsById.get(e.budget_item_id) : null;
            return { id: e.id, item_name: e.item_name, bi_description: bi?.description, bi_specification: bi?.specification, bi_req_qty: bi?.req_qty };
          });
        rateRows = memoryDb.rate_list;
        categoryRows = memoryDb.material_categories;
      }

      if (entryRows.length === 0) {
        return res.status(400).json({ error: "This Budget has no MPR entries to calculate yet." });
      }

      // Keyed by normalized Item Name -> every {specification, rate} row for that name,
      // so an unambiguous single match can be told apart from one that genuinely needs
      // an exact Specification match (see the loop below).
      const rateByName = new Map<string, { specification: string; rate: number }[]>();
      for (const r of rateRows) {
        const key = norm(r.materials_name);
        if (!key) continue;
        const list = rateByName.get(key) || [];
        list.push({ specification: norm(r.specification), rate: Number(r.rate) });
        rateByName.set(key, list);
      }

      const categoryByDetails = new Map<string, { head: string; sub1: string; sub2: string; sub3: string; sector: string }>();
      for (const c of categoryRows) {
        const key = norm(c.details);
        if (!key || categoryByDetails.has(key)) continue; // first row wins on duplicate Details
        categoryByDetails.set(key, { head: c.head, sub1: c.sub1, sub2: c.sub2, sub3: c.sub3, sector: c.sector });
      }

      const missingRateItems = new Map<string, { item_name: string; specification: string }>();
      const missingCategoryItems = new Map<string, string>();
      let matchedCount = 0;
      const updates: { id: number; matchedRate: number | null; amount: number | null; category: any }[] = [];

      for (const row of entryRows) {
        const itemName = row.bi_description || row.item_name;
        const spec = row.bi_specification;
        const reqQty =
          row.bi_req_qty !== null && row.bi_req_qty !== undefined && String(row.bi_req_qty).trim() !== ""
            ? Number(row.bi_req_qty)
            : null;

        const nameKey = norm(itemName);
        const specKey = norm(spec);
        const candidates = rateByName.get(nameKey) || [];
        // Exact Item Name + Specification match only. If the Specification doesn't
        // match any row for this Item Name — even if other rows share the same
        // Item Name with a DIFFERENT Specification/Rate — this is treated as "not
        // found" and goes to the Missing Rate list, never guessed from an unrelated
        // Specification's rate (several items in the real Rate File have wildly
        // different rates per Specification for the same Item Name).
        //
        // If MORE THAN ONE Rate row shares this exact Item Name + Specification (a
        // duplicate/undifferentiated entry in the Rate sheet itself, e.g. two "Local
        // Sand" rows both with a blank Specification but different Rates), that's
        // just as unresolvable as no match at all — silently picking the first one
        // would be an arbitrary guess, so this also goes to Missing Rate for the
        // Admin to de-duplicate in the Rate File.
        const matchingSpecRows = candidates.filter((c) => c.specification === specKey);
        const matchedRate = matchingSpecRows.length === 1 ? matchingSpecRows[0].rate : null;
        const category = categoryByDetails.get(nameKey) || null;
        const amount = matchedRate !== null && reqQty !== null && Number.isFinite(reqQty) ? matchedRate * reqQty : null;

        if (matchedRate === null) {
          const dedupeKey = `${nameKey}|||${specKey}`;
          if (!missingRateItems.has(dedupeKey)) {
            missingRateItems.set(dedupeKey, { item_name: itemName || "(blank)", specification: spec || "" });
          }
        } else {
          matchedCount++;
        }
        if (!category && !missingCategoryItems.has(nameKey)) {
          missingCategoryItems.set(nameKey, itemName || "(blank)");
        }

        updates.push({ id: row.id, matchedRate, amount, category });
      }

      if (isMySQLConnected && dbPool) {
        for (const u of updates) {
          await scopedExecute(
            `UPDATE entries SET matched_rate = ?, computed_amount = ?, category_head = ?, category_sub1 = ?, category_sub2 = ?, category_sub3 = ?, category_sector = ?, rate_calculated_at = NOW() WHERE id = ?`,
            [
              u.matchedRate,
              u.amount,
              u.category?.head || null,
              u.category?.sub1 || null,
              u.category?.sub2 || null,
              u.category?.sub3 || null,
              u.category?.sector || null,
              u.id
            ]
          );
        }
        await scopedExecute(`UPDATE budgets SET rate_approved_at = NOW(), rate_approved_by = ? WHERE id = ?`, [
          req.user.id,
          budgetId
        ]);
      } else {
        const updateById = new Map(updates.map((u) => [u.id, u]));
        memoryDb.entries = memoryDb.entries.map((e: any) => {
          const u = updateById.get(e.id);
          if (!u) return e;
          return {
            ...e,
            matched_rate: u.matchedRate,
            computed_amount: u.amount,
            category_head: u.category?.head || null,
            category_sub1: u.category?.sub1 || null,
            category_sub2: u.category?.sub2 || null,
            category_sub3: u.category?.sub3 || null,
            category_sector: u.category?.sector || null,
            rate_calculated_at: new Date()
          };
        });
        const b = memoryDb.budgets.find((x: any) => x.id === budgetId);
        if (b) {
          b.rate_approved_at = new Date();
          b.rate_approved_by = req.user.id;
        }
      }

      res.json({
        success: true,
        total_entries: entryRows.length,
        matched_rate_count: matchedCount,
        missing_rate: Array.from(missingRateItems.values()),
        missing_category: Array.from(missingCategoryItems.values())
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to approve & calculate this Budget" });
    }
  });

  // "Remove Unused Rows" — a separate, non-destructive action alongside the
  // real Delete Budget below: it only removes this Budget's UNUSED imported
  // Excel rows (budget_items with zero entries pointing at them), never the
  // Budget itself or any row a User has already submitted an MPR Entry
  // against. A row is "used" iff at least one still-active (not soft-
  // deleted, Job Recycle) entries row has budget_item_id pointing at it —
  // every entry created since budget_item_id existed sets this
  // (EntriesRoutes.ts), so this is an exact per-row check, not a heuristic.
  // budget_submissions (the per-user Final Submit lock) is left untouched
  // too; an Admin can always come back and "Import more rows into this
  // budget" again later — see POST /api/budgets/:id/import's merge-on-match
  // logic for how a re-import avoids creating duplicates of what's kept here.
  //
  // The Approved MPR Numbers List (mpr_numbers) is NOT touched for an MRF No
  // that's still on a kept (used) row, or still imported into ANY other
  // Budget, or still referenced by any entry anywhere in the system — mpr_no
  // is globally unique and legitimately reused across Budgets/periods.
  app.post("/api/budgets/:id/remove-unused-items", authenticateToken, requireAdmin, requireModule("imports"), async (req, res) => {
    try {
      const budgetId = req.params.id;
      const budgets = await queryDB("SELECT id FROM budgets WHERE id = ?", [budgetId]);
      if (budgets.length === 0) return res.status(404).json({ error: "Budget not found" });

      const items = await queryDB("SELECT * FROM budget_items WHERE budget_id = ?", [budgetId]);

      const deletedIds: number[] = [];
      const keptIds: number[] = [];
      for (const item of items) {
        const usageRows = await queryDB(
          "SELECT COUNT(*) as cnt FROM entries WHERE budget_item_id = ? AND deleted_at IS NULL",
          [item.id]
        );
        if ((usageRows[0]?.cnt || 0) > 0) {
          keptIds.push(item.id);
        } else {
          deletedIds.push(item.id);
        }
      }

      // Snapshot which MPR Numbers the rows actually being removed touch,
      // BEFORE those budget_items rows are deleted — this is the candidate
      // list to clean up afterwards (only the ones that turn out orphaned).
      // An MRF No that also appears on a KEPT row is never a candidate.
      const keptMrfNos = new Set(
        items.filter((it: any) => keptIds.includes(it.id) && it.mrf_no).map((it: any) => String(it.mrf_no).trim().toLowerCase())
      );
      const candidateMrfNos = Array.from(
        new Set(
          items
            .filter((it: any) => deletedIds.includes(it.id) && it.mrf_no)
            .map((it: any) => String(it.mrf_no).trim().toLowerCase())
        )
      ).filter((mrfNo) => !keptMrfNos.has(mrfNo));

      for (const id of deletedIds) {
        await queryDB("DELETE FROM budget_items WHERE id = ?", [id]);
      }

      // Remove each candidate MPR No from the Approved list ONLY if nothing
      // else in the system still points to it — another Budget's
      // budget_items, or an entry (active or still sitting in the Job
      // Recycle bin) under any Budget.
      for (const mrfNo of candidateMrfNos) {
        const stillInBudgetItems = await queryDB(
          "SELECT COUNT(*) as cnt FROM budget_items WHERE LOWER(mrf_no) = LOWER(?)",
          [mrfNo]
        );
        if ((stillInBudgetItems[0]?.cnt || 0) > 0) continue;

        const mprRows = await queryDB("SELECT id FROM mpr_numbers WHERE LOWER(mpr_no) = LOWER(?)", [mrfNo]);
        if (mprRows.length === 0) continue;
        const mprId = mprRows[0].id;

        const stillInEntries = await queryDB("SELECT COUNT(*) as cnt FROM entries WHERE mpr_id = ?", [mprId]);
        if ((stillInEntries[0]?.cnt || 0) > 0) continue;

        await queryDB("DELETE FROM mpr_numbers WHERE id = ?", [mprId]);
      }

      res.json({ success: true, deleted_count: deletedIds.length, kept_count: keptIds.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Deleting a Budget wipes out EVERYTHING created under it — not just the imported
  // Budget Excel rows (budget_items) but every MPR Entry and Job a User submitted
  // against it too. Without this, those entries/jobs used to survive with budget_id
  // set to NULL (orphaned but still visible in Job Entry Details / Admin reports) —
  // deleting the Budget is meant to be a full, permanent wipe of that relation. This
  // is deliberately separate from POST /api/budgets/:id/remove-unused-items above
  // (a non-destructive cleanup an Admin reaches for first) — this is the real,
  // no-going-back delete, its own separate button in the Admin UI.
  //
  // The Approved MPR Numbers List (mpr_numbers) is NOT simply wiped alongside it,
  // though — that table has no budget_id column at all: mpr_no is GLOBALLY unique,
  // and the same MRF No can legitimately be imported into more than one Budget's
  // Excel (re-used across periods). So after the cascade above, we only remove the
  // MPR Numbers that came in from THIS Budget's import AND are not referenced by any
  // other Budget's imported rows or any other entry left in the system — an MRF No
  // still in use elsewhere is left alone.
  app.delete("/api/budgets/:id", authenticateToken, requireAdmin, requireModule("imports"), async (req, res) => {
    try {
      const budgetId = req.params.id;
      const budgets = await queryDB("SELECT id FROM budgets WHERE id = ?", [budgetId]);
      if (budgets.length === 0) return res.status(404).json({ error: "Budget not found" });

      // Snapshot which MPR Numbers this Budget's imported Excel rows touch, BEFORE
      // those budget_items rows are deleted below — this is the candidate list to
      // clean up afterwards (only the ones that turn out to be orphaned).
      const mrfRows = await queryDB(
        "SELECT mrf_no FROM budget_items WHERE budget_id = ? AND mrf_no IS NOT NULL AND mrf_no <> ''",
        [budgetId]
      );
      const candidateMrfNos = Array.from(
        new Set(mrfRows.map((r: any) => String(r.mrf_no).trim().toLowerCase()).filter(Boolean))
      );

      // Order matters: entries reference jobs/budget_items/budgets, so entries go
      // first, then jobs, then the imported Excel rows, then the submission locks,
      // and finally the Budget itself.
      await queryDB("DELETE FROM entries WHERE budget_id = ?", [budgetId]);
      await queryDB("DELETE FROM job_submissions WHERE budget_id = ?", [budgetId]);
      await queryDB("DELETE FROM jobs WHERE budget_id = ?", [budgetId]);
      await queryDB("DELETE FROM budget_items WHERE budget_id = ?", [budgetId]);
      await queryDB("DELETE FROM budget_submissions WHERE budget_id = ?", [budgetId]);
      await queryDB("DELETE FROM budgets WHERE id = ?", [budgetId]);

      // Now that this Budget's own rows are gone, remove each candidate MPR No from
      // the Approved list ONLY if nothing else in the system still points to it —
      // another Budget's budget_items, or an entry (active or still sitting in the
      // Job Recycle bin) under a different Budget.
      for (const mrfNo of candidateMrfNos) {
        const stillInBudgetItems = await queryDB(
          "SELECT COUNT(*) as cnt FROM budget_items WHERE LOWER(mrf_no) = LOWER(?)",
          [mrfNo]
        );
        if ((stillInBudgetItems[0]?.cnt || 0) > 0) continue;

        const mprRows = await queryDB("SELECT id FROM mpr_numbers WHERE LOWER(mpr_no) = LOWER(?)", [mrfNo]);
        if (mprRows.length === 0) continue;
        const mprId = mprRows[0].id;

        const stillInEntries = await queryDB("SELECT COUNT(*) as cnt FROM entries WHERE mpr_id = ?", [mprId]);
        if ((stillInEntries[0]?.cnt || 0) > 0) continue;

        await queryDB("DELETE FROM mpr_numbers WHERE id = ?", [mprId]);
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Import the Rate File — a reference/lookup Excel with two sheets: "Rate" (materials
  // price list) and "Materials Category" (Head/Sub-1/Sub-2/Sub-3 classification tree).
  // The client parses both sheets and posts the already-mapped rows here. Each
  // import fully REPLACES the previous data (delete-then-insert) rather than merging,
  // since this is always re-uploaded as a complete sheet, not edited row-by-row.
  app.post("/api/rate-file/import", authenticateToken, requireAdmin, requireModule("imports"), async (req: any, res) => {
    try {
      const { rate_rows, category_rows, file_base64, file_name, file_mimetype } = req.body;
      if ((!Array.isArray(rate_rows) || rate_rows.length === 0) && (!Array.isArray(category_rows) || category_rows.length === 0)) {
        return res.status(400).json({ error: "No rows found in either sheet of the uploaded Excel file." });
      }

      const field = (v: any) => (v !== undefined && v !== null && String(v).trim() !== "" ? String(v).trim() : null);
      const numOrNull = (v: any) => {
        if (v === undefined || v === null || String(v).trim() === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };

      const rateRecords = (rate_rows || [])
        .map((r: any) => ({
          materials_name: field(r.materials_name),
          unit: field(r.unit),
          rate: numOrNull(r.rate),
          specification: field(r.specification),
          assigned_person: field(r.assigned_person),
          remarks: field(r.remarks)
        }))
        .filter((r: any) => r.materials_name); // Materials Name is the only required field in this sheet

      const categoryRecords = (category_rows || [])
        .map((r: any) => ({
          sl_no: numOrNull(r.sl_no),
          head: field(r.head),
          sub1: field(r.sub1),
          sub2: field(r.sub2),
          sub3: field(r.sub3),
          details: field(r.details),
          sector: field(r.sector)
        }))
        .filter((r: any) => r.head || r.sub1 || r.sub2 || r.sub3 || r.details); // skip fully blank rows

      if (isMySQLConnected && dbPool) {
        // Only replace rows that came from a previous Excel import — a manually
        // entered rate (is_manual = 1, added via "No rate match" -> manual entry)
        // survives this re-import instead of being wiped out.
        await scopedExecute("DELETE FROM rate_list WHERE is_manual = 0");
        await bulkInsert(
          "rate_list",
          ["materials_name", "unit", "rate", "specification", "assigned_person", "remarks"],
          rateRecords.map((r: any) => [r.materials_name, r.unit, r.rate, r.specification, r.assigned_person, r.remarks])
        );

        await scopedExecute("DELETE FROM material_categories");
        await bulkInsert(
          "material_categories",
          ["sl_no", "head", "sub1", "sub2", "sub3", "details", "sector"],
          categoryRecords.map((r: any) => [r.sl_no, r.head, r.sub1, r.sub2, r.sub3, r.details, r.sector])
        );

        if (file_base64 && typeof file_base64 === "string") {
          try {
            const fileBuffer = Buffer.from(file_base64, "base64");
            await scopedExecute(
              `INSERT INTO rate_file_meta (id, original_filename, file_mimetype, file_data, imported_at)
               VALUES (?, ?, ?, ?, NOW())
               ON DUPLICATE KEY UPDATE original_filename = VALUES(original_filename),
                 file_mimetype = VALUES(file_mimetype), file_data = VALUES(file_data), imported_at = NOW()`,
              [
                activeGroupId(),
                String(file_name || "Rate_File.xlsx").slice(0, 255),
                String(file_mimetype || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
                fileBuffer
              ]
            );
          } catch (fileErr: any) {
            console.warn("Failed to save original Rate File: " + fileErr.message);
          }
        }
      } else {
        const manualRows = memoryDb.rate_list.filter((r: any) => r.is_manual);
        memoryDb.rate_list = [...manualRows, ...rateRecords.map((r: any, i: number) => ({ id: manualRows.length + i + 1, is_manual: false, ...r }))];
        memoryDb.material_categories = categoryRecords.map((r: any, i: number) => ({ id: i + 1, ...r }));
        if (file_base64) {
          memoryDb.rate_file_meta = {
            original_filename: file_name || "Rate_File.xlsx",
            file_mimetype: file_mimetype || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            imported_at: new Date()
          };
        }
      }

      res.json({
        success: true,
        rate_inserted: rateRecords.length,
        category_inserted: categoryRecords.length
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to import the Rate file" });
    }
  });

  // Current Rate File status — row counts + last-imported filename/date — so the Admin
  // Panel can show what's already saved without re-importing.
  app.get("/api/rate-file/summary", authenticateToken, requireAdmin, requireModule("imports"), async (req, res) => {
    try {
      if (isMySQLConnected && dbPool) {
        const [rateCountRows]: any = await scopedExecute("SELECT COUNT(*) as cnt FROM rate_list");
        const [catCountRows]: any = await scopedExecute("SELECT COUNT(*) as cnt FROM material_categories");
        const [metaRows]: any = await scopedExecute(
          "SELECT original_filename, imported_at FROM rate_file_meta WHERE id = ?",
          [activeGroupId()]
        );
        res.json({
          rate_count: rateCountRows[0]?.cnt || 0,
          category_count: catCountRows[0]?.cnt || 0,
          original_filename: metaRows[0]?.original_filename || null,
          imported_at: metaRows[0]?.imported_at || null
        });
      } else {
        res.json({
          rate_count: memoryDb.rate_list.length,
          category_count: memoryDb.material_categories.length,
          original_filename: memoryDb.rate_file_meta?.original_filename || null,
          imported_at: memoryDb.rate_file_meta?.imported_at || null
        });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to load Rate File summary" });
    }
  });

  // Full Rate list (materials price list) — for the Admin "View" modal.
  app.get("/api/rate-file/rate-list", authenticateToken, requireAdmin, requireModule("imports"), async (req, res) => {
    try {
      if (isMySQLConnected && dbPool) {
        const rows = await queryDB("SELECT * FROM rate_list ORDER BY id ASC");
        res.json(rows);
      } else {
        res.json(memoryDb.rate_list);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to load the Rate list" });
    }
  });

  // Manually add/update a Rate — used from the "Approve & Calculate" -> Missing Rate
  // review list, so the Admin can fix a "No rate match" right there in the app instead
  // of always having to go edit the Excel and re-import. Upserts on exact Item Name +
  // Specification (case/whitespace-insensitive) so re-saving the same item just updates
  // its rate rather than piling up duplicate rows. Marked is_manual so a future Rate
  // File re-import never wipes it out.
  app.post("/api/rate-list/manual", authenticateToken, requireAdmin, requireModule("imports"), async (req: any, res) => {
    try {
      const materials_name = String(req.body.materials_name || "").trim();
      const specification = req.body.specification !== undefined && req.body.specification !== null
        ? String(req.body.specification).trim()
        : "";
      const rate = Number(req.body.rate);

      if (!materials_name) return res.status(400).json({ error: "Item Name is required." });
      if (!Number.isFinite(rate) || rate < 0) return res.status(400).json({ error: "A valid, non-negative Rate is required." });

      const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
      const nameKey = norm(materials_name);
      const specKey = norm(specification);

      if (isMySQLConnected && dbPool) {
        const [existingRows]: any = await scopedExecute(
          "SELECT id FROM rate_list WHERE LOWER(TRIM(materials_name)) = ? AND LOWER(TRIM(COALESCE(specification, ''))) = ? AND is_manual = 1",
          [nameKey, specKey]
        );
        if (existingRows.length > 0) {
          await scopedExecute("UPDATE rate_list SET rate = ?, added_by = ? WHERE id = ?", [
            rate,
            req.user.id,
            existingRows[0].id
          ]);
        } else {
          await scopedExecute(
            "INSERT INTO rate_list (materials_name, unit, rate, specification, assigned_person, remarks, is_manual, added_by) VALUES (?, NULL, ?, ?, NULL, 'Manually entered by Admin', 1, ?)",
            [materials_name, rate, specification || null, req.user.id]
          );
        }
      } else {
        const existing = memoryDb.rate_list.find(
          (r: any) => r.is_manual && norm(String(r.materials_name || "")) === nameKey && norm(String(r.specification || "")) === specKey
        );
        if (existing) {
          existing.rate = rate;
          existing.added_by = req.user.id;
        } else {
          memoryDb.rate_list.push({
            id: (memoryDb.rate_list.reduce((max: number, r: any) => Math.max(max, r.id || 0), 0)) + 1,
            materials_name,
            unit: null,
            rate,
            specification: specification || null,
            assigned_person: null,
            remarks: "Manually entered by Admin",
            is_manual: true,
            added_by: req.user.id
          });
        }
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to save the manual rate" });
    }
  });

  // Full Materials Category tree — for the Admin "View" modal.
  app.get("/api/rate-file/categories", authenticateToken, requireAdmin, requireModule("imports"), async (req, res) => {
    try {
      if (isMySQLConnected && dbPool) {
        const rows = await queryDB("SELECT * FROM material_categories ORDER BY id ASC");
        res.json(rows);
      } else {
        res.json(memoryDb.material_categories);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to load Materials Categories" });
    }
  });

  // Import parsed Excel rows into a Budget.
  // Expected Excel header: Sl.No. | Project Name | Req. No. | MRF No | Date |
  // Description of Materials | Unit | Specification | Req. Qty | Purchase Order Qty |
  // Received Qty | Balance Qty | Entry User | Aproved Date | App. User | Site Sup. Date
  // (the client parses the .xlsx and posts already-mapped row objects here)
  app.post("/api/budgets/:id/import", authenticateToken, requireAdmin, requireModule("imports"), async (req: any, res) => {
    try {
      const budgetId = Number(req.params.id);
      const budgetRows = await queryDB("SELECT id FROM budgets WHERE id = ?", [budgetId]);
      if (budgetRows.length === 0) return res.status(404).json({ error: "Budget not found" });

      const { rows, file_base64, file_name, file_mimetype } = req.body;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: "No rows found in the uploaded Excel file" });
      }

      // Save the original Excel file itself against this Budget (overwrites any
      // previously saved file, so it always reflects the most recently imported sheet).
      if (file_base64 && typeof file_base64 === "string") {
        try {
          const fileBuffer = Buffer.from(file_base64, "base64");
          await queryDB(
            "UPDATE budgets SET original_filename = ?, file_mimetype = ?, file_data = ? WHERE id = ?",
            [
              String(file_name || `budget_${budgetId}.xlsx`).slice(0, 255),
              String(file_mimetype || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
              fileBuffer,
              budgetId
            ]
          );
        } catch (fileErr: any) {
          console.warn("Failed to save original Excel file for budget " + budgetId + ": " + fileErr.message);
        }
      }

      let itemsInserted = 0;
      let itemsReplaced = 0;
      let mprAdded = 0;
      let mprAlreadyExisting = 0;
      let projectsAdded = 0;
      let projectsAlreadyExisting = 0;

      // Re-importing into an already-Published Budget (the "Import more rows
      // into this budget" button — this route has no is_published guard) must
      // not create duplicate rows for the same real-world line item, and must
      // not orphan any MPR Entry already submitted against an existing row.
      // So: match each incoming row against this Budget's EXISTING rows on
      // (Project Name, MRF No, Description of Materials, Specification) —
      // case/whitespace-insensitive — and UPDATE that row IN PLACE (same id,
      // so entries.budget_item_id pointing at it stays valid) instead of
      // inserting a second copy. Only a row with no match on all four fields
      // is a genuinely new line item and gets INSERTed.
      const matchKey = (project_name: string, mrf_no: string, description: string, specification: string) =>
        `${project_name.toLowerCase()}|${mrf_no.toLowerCase()}|${description.toLowerCase()}|${specification.toLowerCase()}`;
      const existingItems = await queryDB("SELECT * FROM budget_items WHERE budget_id = ?", [budgetId]);
      const existingByKey = new Map<string, any>(
        existingItems.map((it: any) => [
          matchKey(String(it.project_name || ""), String(it.mrf_no || ""), String(it.description || ""), String(it.specification || "")),
          it
        ])
      );

      for (const r of rows) {
        const field = (v: any) => (v != null ? String(v).trim() : "");
        const sl_no = field(r.sl_no);
        const project_name = field(r.project_name);
        const req_no = field(r.req_no);
        const mrf_no = field(r.mrf_no);
        const item_date = field(r.item_date);
        const description = field(r.description);
        const unit = field(r.unit);
        const specification = field(r.specification);
        const req_qty = field(r.req_qty);
        const po_qty = field(r.po_qty);
        const received_qty = field(r.received_qty);
        const balance_qty = field(r.balance_qty);
        const entry_user = field(r.entry_user);
        const approved_date = field(r.approved_date);
        const app_user = field(r.app_user);
        const site_sup_date = field(r.site_sup_date);

        // Skip fully blank rows
        if (!project_name && !req_no && !mrf_no && !description) continue;

        const key = matchKey(project_name, mrf_no, description, specification);
        const existing = existingByKey.get(key);
        if (existing) {
          await queryDB(
            `UPDATE budget_items
                SET sl_no = ?, project_name = ?, req_no = ?, mrf_no = ?, item_date = ?, description = ?, unit = ?, specification = ?,
                    req_qty = ?, po_qty = ?, received_qty = ?, balance_qty = ?, entry_user = ?, approved_date = ?, app_user = ?, site_sup_date = ?
              WHERE id = ?`,
            [
              sl_no, project_name, req_no, mrf_no, item_date, description, unit, specification,
              req_qty, po_qty, received_qty, balance_qty, entry_user, approved_date, app_user, site_sup_date,
              existing.id
            ]
          );
          itemsReplaced++;
        } else {
          const result = await queryDB(
            `INSERT INTO budget_items
             (budget_id, sl_no, project_name, req_no, mrf_no, item_date, description, unit, specification,
              req_qty, po_qty, received_qty, balance_qty, entry_user, approved_date, app_user, site_sup_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              budgetId, sl_no, project_name, req_no, mrf_no, item_date, description, unit, specification,
              req_qty, po_qty, received_qty, balance_qty, entry_user, approved_date, app_user, site_sup_date
            ]
          );
          itemsInserted++;
          // Same file can list the same line item twice (or a later row can
          // match an earlier row just inserted this batch) — keep the map
          // current so later rows in THIS import still match it instead of
          // creating a second duplicate.
          existingByKey.set(key, { id: result.insertId });
        }

        if (project_name) {
          const pr = await findOrCreateProject(project_name, req.user.id);
          if (pr.created) projectsAdded++;
          else if (pr.id) projectsAlreadyExisting++;
        }
        if (mrf_no) {
          const mr = await findOrCreateMpr(mrf_no, req.user.id);
          if (mr.created) mprAdded++;
          else if (mr.id) mprAlreadyExisting++;
        }
      }

      res.json({
        success: true,
        items_inserted: itemsInserted,
        items_replaced: itemsReplaced,
        mpr_added: mprAdded,
        mpr_already_existing: mprAlreadyExisting,
        projects_added: projectsAdded,
        projects_already_existing: projectsAlreadyExisting
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to import Excel data" });
    }
  });

  // Admin sets (or clears) the allowed Delivery Date window for a Budget, after it's
  // been imported. Once set, every MPR Entry created/edited under this Budget must
  // have a Delivery Date inside [delivery_date_from, delivery_date_to] (both inclusive)
  // — enforced here on write, and in POST/PUT /api/entries so it can't be bypassed via
  // a direct API call. Passing both as null/empty clears the restriction.
  app.put("/api/budgets/:id/delivery-range", authenticateToken, requireAdmin, requireModule("imports"), async (req: any, res) => {
    try {
      const budgetId = Number(req.params.id);
      const budgetRows = await queryDB("SELECT id FROM budgets WHERE id = ?", [budgetId]);
      if (budgetRows.length === 0) return res.status(404).json({ error: "Budget not found" });

      let { delivery_date_from, delivery_date_to } = req.body;
      delivery_date_from = delivery_date_from ? String(delivery_date_from).trim() : null;
      delivery_date_to = delivery_date_to ? String(delivery_date_to).trim() : null;

      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      if (delivery_date_from && !dateRe.test(delivery_date_from)) {
        return res.status(400).json({ error: "Invalid Delivery Date From." });
      }
      if (delivery_date_to && !dateRe.test(delivery_date_to)) {
        return res.status(400).json({ error: "Invalid Delivery Date To." });
      }
      if (delivery_date_from && delivery_date_to && delivery_date_from > delivery_date_to) {
        return res.status(400).json({ error: "Delivery Date From must be on or before Delivery Date To." });
      }

      await queryDB("UPDATE budgets SET delivery_date_from = ?, delivery_date_to = ? WHERE id = ?", [
        delivery_date_from,
        delivery_date_to,
        budgetId
      ]);

      res.json({ success: true, delivery_date_from, delivery_date_to });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to set Delivery Date range" });
    }
  });

  // --- Delivery Date Conditions ("minimum lead time" rule) ---
  // Admin Panel -> PEPM Manage -> Data Import -> Condition Set. See
  // deliveryDateConditions.ts for the resolver used by EntriesRoutes.ts's
  // actual enforcement; these are just the CRUD/read endpoints behind the
  // admin UI, plus one unrestricted read (below the admin-only block) that
  // any authenticated account uses to grey out blocked dates on its own
  // Delivery Date pickers.
  app.get("/api/delivery-date-conditions", authenticateToken, requireAdmin, requireModule("imports"), async (req, res) => {
    try {
      const rows = await queryDB(
        `SELECT c.*,
                CASE WHEN c.scope = 'project' THEN p.project_name
                     WHEN c.scope = 'budget' THEN b.budget_name
                     ELSE NULL END AS scope_name
         FROM delivery_date_conditions c
         LEFT JOIN projects p ON c.scope = 'project' AND p.id = c.scope_id
         LEFT JOIN budgets b ON c.scope = 'budget' AND b.id = c.scope_id
         ORDER BY c.condition_type, c.scope = 'global' DESC, c.scope, c.scope_id`
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Upserts the ONE Global row for a condition_type — always exists already
  // (seeded in initDB()), so this is always an UPDATE in practice; INSERT ...
  // ON DUPLICATE KEY covers a fresh/self-healed table too.
  app.put("/api/delivery-date-conditions/global", authenticateToken, requireAdmin, requireModule("imports"), async (req: any, res) => {
    try {
      const { condition_type, enabled, min_lead_days, apply_to_admins } = req.body;
      if (condition_type !== "entry" && condition_type !== "job_edit") {
        return res.status(400).json({ error: "condition_type must be 'entry' or 'job_edit'" });
      }
      const days = Number(min_lead_days);
      if (!Number.isInteger(days) || days < 0) {
        return res.status(400).json({ error: "min_lead_days must be a non-negative whole number" });
      }
      await queryDB(
        `INSERT INTO delivery_date_conditions (condition_type, scope, scope_id, min_lead_days, apply_to_admins, enabled, updated_by)
         VALUES (?, 'global', 0, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE min_lead_days = VALUES(min_lead_days), apply_to_admins = VALUES(apply_to_admins),
           enabled = VALUES(enabled), updated_by = VALUES(updated_by)`,
        [condition_type, days, apply_to_admins ? 1 : 0, enabled ? 1 : 0, req.user.id]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Creates/updates a Project or Budget override row (upsert on the same
  // unique key the Global row above uses).
  app.post("/api/delivery-date-conditions/override", authenticateToken, requireAdmin, requireModule("imports"), async (req: any, res) => {
    try {
      const { condition_type, scope, scope_id, min_lead_days, apply_to_admins, enabled } = req.body;
      if (condition_type !== "entry" && condition_type !== "job_edit") {
        return res.status(400).json({ error: "condition_type must be 'entry' or 'job_edit'" });
      }
      if (scope !== "project" && scope !== "budget") {
        return res.status(400).json({ error: "scope must be 'project' or 'budget'" });
      }
      const id = Number(scope_id);
      if (!id) return res.status(400).json({ error: "A Project/Budget must be selected" });
      const days = Number(min_lead_days);
      if (!Number.isInteger(days) || days < 0) {
        return res.status(400).json({ error: "min_lead_days must be a non-negative whole number" });
      }
      const table = scope === "project" ? "projects" : "budgets";
      const existsRows = await queryDB(`SELECT id FROM ${table} WHERE id = ?`, [id]);
      if (existsRows.length === 0) {
        return res.status(400).json({ error: `Selected ${scope === "project" ? "Project" : "Budget"} not found` });
      }
      await queryDB(
        `INSERT INTO delivery_date_conditions (condition_type, scope, scope_id, min_lead_days, apply_to_admins, enabled, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE min_lead_days = VALUES(min_lead_days), apply_to_admins = VALUES(apply_to_admins),
           enabled = VALUES(enabled), updated_by = VALUES(updated_by)`,
        [condition_type, scope, id, days, apply_to_admins ? 1 : 0, enabled === false ? 0 : 1, req.user.id]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Removes a Project/Budget override entirely (a Global row can only ever be
  // disabled/re-enabled above — deleting it isn't offered, since the resolver
  // and this admin UI both assume exactly one Global row per condition_type
  // always exists).
  app.delete("/api/delivery-date-conditions/:id", authenticateToken, requireAdmin, requireModule("imports"), async (req, res) => {
    try {
      await queryDB("DELETE FROM delivery_date_conditions WHERE id = ? AND scope <> 'global'", [req.params.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Unrestricted (any authenticated account, no admin/module gate) — lets a
  // Delivery Date picker on the New Job Entry / Add MPR / Job Edit forms
  // grey out blocked dates for THIS account before it even attempts a
  // submit, using the exact same resolver the server enforces with.
  app.get("/api/delivery-date-conditions/effective", authenticateToken, async (req: any, res) => {
    try {
      const conditionType = req.query.type as DeliveryConditionType;
      if (conditionType !== "entry" && conditionType !== "job_edit") {
        return res.status(400).json({ error: "type must be 'entry' or 'job_edit'" });
      }
      const projectId = req.query.project_id ? Number(req.query.project_id) : null;
      const budgetId = req.query.budget_id ? Number(req.query.budget_id) : null;
      const minLeadDays = await resolveMinLeadDays(queryDB, conditionType, {
        projectId,
        budgetId,
        userRole: req.user.role
      });
      res.json({
        min_lead_days: minLeadDays,
        earliest_date: minLeadDays !== null ? addDaysToDateStr(todayInDhaka(), minLeadDays) : null
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 4. Jobs & Duration
  app.get("/api/jobs", authenticateToken, async (req, res) => {
    try {
      const jobs = await queryDB("SELECT * FROM jobs ORDER BY job_no ASC");
      res.json(jobs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/jobs/check/:jobNo", authenticateToken, async (req, res) => {
    try {
      const { jobNo } = req.params;
      const jobs = await queryDB("SELECT * FROM jobs WHERE job_no = ?", [jobNo.trim()]);
      if (jobs.length > 0) {
        res.json({ exists: true, job: jobs[0] });
      } else {
        res.json({ exists: false });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
