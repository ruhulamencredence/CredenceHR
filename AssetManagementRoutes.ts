/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Asset Management (Employee Profile -> "My Assets" / "New Requisition" /
// "Requisition Status", plus Admin Panel -> Asset Management) — split into
// its own file from day one, same reasoning as profileRoutes.ts /
// ConveyanceBillClaimRoutes.ts / PayrollRoutes.ts: server.ts is already huge,
// so new features go in their own module and are registered from inside
// startServer() via registerAssetManagementRoutes(), reusing that request's
// authenticateToken/requireAdmin/requireModule/queryDB rather than a second
// Express app or DB connection.
//
// Data model (see ensureAssetManagementSchema below / schema.sql):
//   assets              — the company's asset inventory (one row per
//                          physical item: a specific laptop, monitor, etc.).
//   asset_requisitions  — an Employee's request for a new/replacement asset.
//                          Status timeline: pending -> manager_approved ->
//                          approved -> dispatched -> fulfilled, or rejected
//                          at either approval step.
//   asset_assignments   — who has which asset right now, and the full
//                          handover/return history for a given asset.
//                          returned_date IS NULL means still in use.
//
// Two distinct approval layers on a requisition, matching the workflow the
// module was speced against (Submitted -> Line Manager Approved -> IT/Admin
// Approved -> Asset Handed Over):
//   1) Line Manager — resolved from employee_supervisors (the same
//      Employee Directory "Supervisor" tab every other module already
//      reads), NOT gated behind the 'asset_management' AdminModuleKey. Any
//      account that is somebody's direct supervisor can act on that
//      person's request, whether or not they're an Admin.
//   2) IT/Admin — gated behind the 'asset_management' AdminModuleKey like
//      every other Admin Panel module (requireModule('asset_management')),
//      same convention as 'payroll', 'conveyance', etc. This is also where
//      the inventory itself (the `assets` table) is managed and where an
//      approved requisition is actually fulfilled (an asset is picked from
//      inventory and handed over).
//
// A requisition with no resolvable Line Manager (no Supervisor on file for
// that Employee) simply skips step 1 — IT/Admin can decide it directly from
// 'pending' — so a missing org-chart entry never blocks the request outright.

import type { Express } from "express";
import type { AlertType } from "./Alerts";

interface AssetManagementRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  // Same requireModule(moduleKey) factory every other Admin Panel module
  // uses (server.ts) — a Superadmin always passes; an Admin/User needs the
  // 'asset_management' key granted via Admin Panel -> Users -> Module Access.
  requireModule: (moduleKey: "asset_management") => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  createAlert: (
    queryDB: (sql: string, params?: any[]) => Promise<any>,
    params: { userId: number; type: AlertType; title: string; message: string; relatedType?: string; relatedId?: number }
  ) => Promise<void>;
}

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

// Self-healing migration — same pattern as ensurePayrollSchema in
// PayrollRoutes.ts: CREATE TABLE IF NOT EXISTS means a normal server restart
// is enough to pick this up on an already-running database, no manual SQL
// required. Called from server.ts's ensureSchemaMigrations() alongside every
// other table.
export async function ensureAssetManagementSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS assets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        asset_tag VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(100) NOT NULL,
        serial_number VARCHAR(150) NULL,
        purchase_date DATE NULL,
        status ENUM('available','assigned','maintenance','disposed') NOT NULL DEFAULT 'available',
        condition_note VARCHAR(255) NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS asset_requisitions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_user_id INT NOT NULL,
        asset_category VARCHAR(100) NOT NULL,
        reason TEXT NOT NULL,
        urgency ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
        target_date DATE NULL,
        attachment_filename VARCHAR(255) NULL,
        attachment_mimetype VARCHAR(150) NULL,
        attachment_data LONGBLOB NULL,
        status ENUM('pending','manager_approved','approved','rejected','dispatched','fulfilled') NOT NULL DEFAULT 'pending',
        manager_id INT NULL,
        manager_decided_at TIMESTAMP NULL DEFAULT NULL,
        manager_remarks TEXT NULL,
        admin_decided_by INT NULL,
        admin_decided_at TIMESTAMP NULL DEFAULT NULL,
        rejection_reason TEXT NULL,
        assigned_asset_id INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (admin_decided_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (assigned_asset_id) REFERENCES assets(id) ON DELETE SET NULL
      )
    `);
    // Line items on a requisition — an Employee's "New Requisition" can now
    // ask for several things at once (e.g. "Stapler x2" + "A4 Paper x5
    // reams"), each with its own purpose/unit/quantity. asset_requisitions
    // itself still holds ONE summarized asset_category/reason (see
    // summarizeItems() below) purely so every existing column/alert/message
    // that reads requisition.asset_category or .reason keeps working
    // unchanged — the itemized breakdown always lives here instead.
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS asset_requisition_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        requisition_id INT NOT NULL,
        item_name VARCHAR(150) NOT NULL,
        purpose TEXT NOT NULL,
        unit VARCHAR(50) NOT NULL,
        quantity DECIMAL(10,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (requisition_id) REFERENCES asset_requisitions(id) ON DELETE CASCADE
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS asset_assignments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        asset_id INT NOT NULL,
        employee_user_id INT NOT NULL,
        requisition_id INT NULL,
        assigned_date DATE NOT NULL,
        returned_date DATE NULL,
        condition_on_assign ENUM('new','good') NOT NULL DEFAULT 'good',
        condition_on_return ENUM('good','damaged','lost') NULL,
        assigned_by INT NOT NULL,
        acknowledged_at TIMESTAMP NULL DEFAULT NULL,
        return_requested_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
        FOREIGN KEY (employee_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (requisition_id) REFERENCES asset_requisitions(id) ON DELETE SET NULL,
        FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure Asset Management tables exist: " + err.message);
  }
}

export function registerAssetManagementRoutes(app: Express, deps: AssetManagementRouteDeps) {
  const { authenticateToken, requireAdmin, requireModule, queryDB, createAlert } = deps;

  // Resolves the logged-in Employee's direct Line Manager, the same way
  // Payroll/Employees already read the org chart: users.id -> all_employees
  // (by user_id) -> employee_supervisors (is_direct = 1) -> supervisor's
  // all_employees row -> that row's user_id (null if the supervisor has no
  // login account, or no direct supervisor is on file at all).
  async function getDirectManagerUserId(employeeUserId: number): Promise<number | null> {
    const empRows = await queryDB("SELECT id FROM all_employees WHERE user_id = ? LIMIT 1", [employeeUserId]);
    if (empRows.length === 0) return null;
    const supRows = await queryDB(
      `SELECT s.supervisor_id
         FROM employee_supervisors s
        WHERE s.employee_id = ? AND s.is_direct = 1
        ORDER BY s.id DESC LIMIT 1`,
      [empRows[0].id]
    );
    if (supRows.length === 0) return null;
    const supEmpRows = await queryDB("SELECT user_id FROM all_employees WHERE id = ? LIMIT 1", [supRows[0].supervisor_id]);
    return supEmpRows[0]?.user_id ?? null;
  }

  const requisitionSelectBase = `
    SELECT r.*, u.name AS employee_name, m.name AS manager_name, a.name AS asset_name, a.asset_tag AS asset_tag
      FROM asset_requisitions r
      JOIN users u ON u.id = r.employee_user_id
      LEFT JOIN users m ON m.id = r.manager_id
      LEFT JOIN assets a ON a.id = r.assigned_asset_id
  `;

  // A validated, non-empty items[] from the New Requisition form -> the
  // single asset_category/reason string asset_requisitions itself stores
  // (so Alerts messages and every other place that reads those two columns
  // don't need to know about multi-item requisitions at all).
  function summarizeItems(items: { item_name: string; purpose: string }[]): { category: string; reason: string } {
    const category =
      items.length === 1 ? items[0].item_name : `${items[0].item_name} +${items.length - 1} more`;
    const reason = items.map((it) => `${it.item_name}: ${it.purpose}`).join(" | ");
    return { category, reason };
  }

  // Attaches each requisition's line items (asset_requisition_items) as
  // r.items. A requisition submitted before this feature existed has no
  // child rows, so it falls back to a single synthetic item built from its
  // own asset_category/reason/quantity-less legacy shape — old requests
  // still render fine in the itemized UI without a data migration.
  async function attachItems<T extends { id: number; asset_category: string; reason: string }>(rows: T[]): Promise<(T & { items: any[] })[]> {
    if (rows.length === 0) return rows as (T & { items: any[] })[];
    const ids = rows.map((r) => r.id);
    const itemRows = await queryDB(
      `SELECT * FROM asset_requisition_items WHERE requisition_id IN (${ids.map(() => "?").join(",")}) ORDER BY id ASC`,
      ids
    );
    const byRequisition = new Map<number, any[]>();
    for (const it of itemRows) {
      if (!byRequisition.has(it.requisition_id)) byRequisition.set(it.requisition_id, []);
      byRequisition.get(it.requisition_id)!.push(it);
    }
    return rows.map((r) => ({
      ...r,
      items: byRequisition.get(r.id) || [{ item_name: r.asset_category, purpose: r.reason, unit: "pcs", quantity: 1 }]
    }));
  }

  // ---------------------------------------------------------------------
  // Employee self-service (Employee Profile -> Asset Management)
  // ---------------------------------------------------------------------

  // GET /api/assets/my — assets currently assigned to me (My Assets tab).
  app.get("/api/assets/my", authenticateToken, async (req: any, res) => {
    try {
      const rows = await queryDB(
        `SELECT asg.id AS assignment_id, asg.assigned_date, asg.condition_on_assign,
                asg.acknowledged_at, asg.return_requested_at,
                a.id AS asset_id, a.asset_tag, a.name, a.category, a.serial_number
           FROM asset_assignments asg
           JOIN assets a ON a.id = asg.asset_id
          WHERE asg.employee_user_id = ? AND asg.returned_date IS NULL
          ORDER BY asg.assigned_date DESC`,
        [req.user.id]
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/assets/assignments/:id/acknowledge — the "Accept & Acknowledge"
  // digital handover button: the Employee confirms they've received the
  // asset. Only the assignment's own Employee may acknowledge it.
  app.post("/api/assets/assignments/:id/acknowledge", authenticateToken, async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM asset_assignments WHERE id = ?", [req.params.id]);
      const assignment = rows[0];
      if (!assignment) return res.status(404).json({ error: "Assignment not found." });
      if (assignment.employee_user_id !== req.user.id) {
        return res.status(403).json({ error: "Not authorized." });
      }
      if (assignment.acknowledged_at) {
        return res.status(400).json({ error: "Already acknowledged." });
      }
      await queryDB("UPDATE asset_assignments SET acknowledged_at = NOW() WHERE id = ?", [assignment.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/assets/assignments/:id/request-return — Asset Return &
  // Clearance: the Employee flags they want to return an asset (e.g. on
  // resignation, or simply no longer needing it). This only records intent —
  // IT/Admin still has to action the actual return (PUT .../return below),
  // which is what frees the asset back into inventory.
  app.post("/api/assets/assignments/:id/request-return", authenticateToken, async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM asset_assignments WHERE id = ?", [req.params.id]);
      const assignment = rows[0];
      if (!assignment) return res.status(404).json({ error: "Assignment not found." });
      if (assignment.employee_user_id !== req.user.id) {
        return res.status(403).json({ error: "Not authorized." });
      }
      if (assignment.returned_date) return res.status(400).json({ error: "This asset was already returned." });
      await queryDB("UPDATE asset_assignments SET return_requested_at = NOW() WHERE id = ?", [assignment.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/assets/requisitions — New Requisition tab: submit a request
  // for a new/replacement asset. Attachment is optional, same base64 ->
  // LONGBLOB pattern already used for Conveyance Bill Claim attachments and
  // the Profile photo upload (profileRoutes.ts) — no multipart/multer
  // anywhere else in this app, so this doesn't introduce a second upload
  // mechanism. The Line Manager (if one is on file) is resolved and stamped
  // on the request immediately, so the approval queue below doesn't have to
  // re-resolve the org chart on every read.
  app.post("/api/assets/requisitions", authenticateToken, async (req: any, res) => {
    try {
      const { items, urgency, target_date, attachment_base64, attachment_filename, attachment_mimetype } = req.body || {};

      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "Add at least one item to the requisition." });
      }
      // Trim/validate every row up front — one bad row fails the whole
      // request rather than silently dropping it (same "fail loud" pattern
      // every other form-submit route in this app already follows).
      const cleanItems = items.map((raw: any, idx: number) => {
        const item_name = String(raw?.item_name || "").trim();
        const purpose = String(raw?.purpose || "").trim();
        const unit = String(raw?.unit || "").trim();
        const quantity = Number(raw?.quantity);
        if (!item_name) throw new Error(`Item #${idx + 1}: item name is required.`);
        if (!purpose) throw new Error(`Item #${idx + 1}: purpose is required.`);
        if (!unit) throw new Error(`Item #${idx + 1}: unit is required.`);
        if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Item #${idx + 1}: quantity must be greater than 0.`);
        return { item_name, purpose, unit, quantity };
      });

      const urgencyLevel = ["low", "medium", "high"].includes(urgency) ? urgency : "medium";
      const { category, reason } = summarizeItems(cleanItems);

      let attachmentBuffer: Buffer | null = null;
      let mimetype: string | null = null;
      let filename: string | null = null;
      if (attachment_base64) {
        mimetype = String(attachment_mimetype || "application/octet-stream");
        filename = String(attachment_filename || "attachment").slice(0, 255);
        attachmentBuffer = Buffer.from(String(attachment_base64), "base64");
        if (attachmentBuffer.length > MAX_ATTACHMENT_BYTES) {
          return res.status(400).json({ error: "Attachment must be less than 5MB." });
        }
      }

      const managerId = await getDirectManagerUserId(req.user.id);

      const result = await queryDB(
        `INSERT INTO asset_requisitions
           (employee_user_id, asset_category, reason, urgency, target_date,
            attachment_filename, attachment_mimetype, attachment_data, manager_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [req.user.id, category, reason, urgencyLevel, target_date || null, filename, mimetype, attachmentBuffer, managerId]
      );

      for (const it of cleanItems) {
        await queryDB(
          `INSERT INTO asset_requisition_items (requisition_id, item_name, purpose, unit, quantity)
           VALUES (?, ?, ?, ?, ?)`,
          [result.insertId, it.item_name, it.purpose, it.unit, it.quantity]
        );
      }

      if (managerId) {
        await createAlert(queryDB, {
          userId: managerId,
          type: "asset_requisition" as AlertType,
          title: "New Asset Requisition",
          message: `${req.user.name || "An employee"} requested ${category}. Please review.`,
          relatedType: "asset_requisition",
          relatedId: result.insertId
        });
      }

      res.json({ success: true, id: result.insertId });
    } catch (err: any) {
      res.status(err.message?.startsWith("Item #") ? 400 : 500).json({ error: err.message });
    }
  });

  // GET /api/assets/requisitions/my — Requisition Status tab: my own
  // requests and where each one stands on the approval timeline.
  app.get("/api/assets/requisitions/my", authenticateToken, async (req: any, res) => {
    try {
      const rows = await queryDB(
        `${requisitionSelectBase} WHERE r.employee_user_id = ? ORDER BY r.created_at DESC`,
        [req.user.id]
      );
      res.json(await attachItems(rows));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------
  // Line Manager approval — resolved from employee_supervisors, NOT gated
  // behind the 'asset_management' module (any account that is somebody's
  // direct supervisor can act on that person's requests).
  // ---------------------------------------------------------------------

  // GET /api/assets/requisitions/for-manager-approval — pending requests
  // where the logged-in account is the requester's direct Line Manager.
  app.get("/api/assets/requisitions/for-manager-approval", authenticateToken, async (req: any, res) => {
    try {
      const rows = await queryDB(
        `${requisitionSelectBase} WHERE r.manager_id = ? AND r.status = 'pending' ORDER BY r.created_at ASC`,
        [req.user.id]
      );
      res.json(await attachItems(rows));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/assets/requisitions/:id/manager-decision — Line Manager
  // approves or rejects. Only the requisition's own resolved manager_id (or
  // a Superadmin, who can stand in for any missing approver) may decide it.
  app.put("/api/assets/requisitions/:id/manager-decision", authenticateToken, async (req: any, res) => {
    try {
      const { decision, remarks } = req.body || {};
      if (decision !== "approve" && decision !== "reject") {
        return res.status(400).json({ error: "decision must be 'approve' or 'reject'." });
      }
      const rows = await queryDB("SELECT * FROM asset_requisitions WHERE id = ?", [req.params.id]);
      const requisition = rows[0];
      if (!requisition) return res.status(404).json({ error: "Requisition not found." });
      if (requisition.status !== "pending") {
        return res.status(400).json({ error: "This requisition already moved past the Line Manager step." });
      }
      if (requisition.manager_id !== req.user.id && req.user.role !== "superadmin") {
        return res.status(403).json({ error: "Not authorized." });
      }

      const newStatus = decision === "approve" ? "manager_approved" : "rejected";
      await queryDB(
        `UPDATE asset_requisitions
            SET status = ?, manager_decided_at = NOW(), manager_remarks = ?,
                rejection_reason = ?
          WHERE id = ?`,
        [newStatus, remarks || null, decision === "reject" ? String(remarks || "Rejected by Line Manager") : null, requisition.id]
      );

      await createAlert(queryDB, {
        userId: requisition.employee_user_id,
        type: "asset_requisition" as AlertType,
        title: decision === "approve" ? "Requisition Approved by Manager" : "Requisition Rejected",
        message:
          decision === "approve"
            ? `Your ${requisition.asset_category} request was approved by your Line Manager and is now with IT/Admin.`
            : `Your ${requisition.asset_category} request was rejected by your Line Manager.`,
        relatedType: "asset_requisition",
        relatedId: requisition.id
      });

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------
  // IT/Admin (Admin Panel -> Asset Management) — gated behind the
  // 'asset_management' AdminModuleKey, same convention as every other
  // Admin Panel module (a Superadmin always passes requireModule).
  // ---------------------------------------------------------------------

  // GET /api/assets — inventory list, optional ?status=&category= filters.
  app.get("/api/assets", authenticateToken, requireAdmin, requireModule("asset_management"), async (req: any, res) => {
    try {
      const clauses: string[] = [];
      const params: any[] = [];
      if (req.query.status) {
        clauses.push("status = ?");
        params.push(req.query.status);
      }
      if (req.query.category) {
        clauses.push("category = ?");
        params.push(req.query.category);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = await queryDB(`SELECT * FROM assets ${where} ORDER BY created_at DESC`, params);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/assets — add a new asset to inventory.
  app.post("/api/assets", authenticateToken, requireAdmin, requireModule("asset_management"), async (req: any, res) => {
    try {
      const { asset_tag, name, category, serial_number, purchase_date, condition_note } = req.body || {};
      const tag = String(asset_tag || "").trim();
      const assetName = String(name || "").trim();
      const cat = String(category || "").trim();
      if (!tag) return res.status(400).json({ error: "Asset Tag is required." });
      if (!assetName) return res.status(400).json({ error: "Asset Name is required." });
      if (!cat) return res.status(400).json({ error: "Category is required." });

      const dup = await queryDB("SELECT id FROM assets WHERE asset_tag = ?", [tag]);
      if (dup.length > 0) return res.status(400).json({ error: "That Asset Tag already exists." });

      const result = await queryDB(
        `INSERT INTO assets (asset_tag, name, category, serial_number, purchase_date, condition_note, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [tag, assetName, cat, serial_number || null, purchase_date || null, condition_note || null, req.user.id]
      );
      res.json({ success: true, id: result.insertId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/assets/:id — edit an inventory item's details/status.
  app.put("/api/assets/:id", authenticateToken, requireAdmin, requireModule("asset_management"), async (req: any, res) => {
    try {
      const { name, category, serial_number, purchase_date, status, condition_note } = req.body || {};
      const rows = await queryDB("SELECT id FROM assets WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Asset not found." });

      const allowedStatus = ["available", "assigned", "maintenance", "disposed"];
      if (status && !allowedStatus.includes(status)) {
        return res.status(400).json({ error: "Invalid status." });
      }

      await queryDB(
        `UPDATE assets
            SET name = COALESCE(?, name), category = COALESCE(?, category),
                serial_number = ?, purchase_date = ?, status = COALESCE(?, status),
                condition_note = ?
          WHERE id = ?`,
        [name || null, category || null, serial_number || null, purchase_date || null, status || null, condition_note || null, req.params.id]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/assets/:id/history — Asset History: every Employee this exact
  // item has ever been assigned to, most recent first (Admin panel -> click
  // into an asset).
  app.get("/api/assets/:id/history", authenticateToken, requireAdmin, requireModule("asset_management"), async (req: any, res) => {
    try {
      const rows = await queryDB(
        `SELECT asg.*, u.name AS employee_name
           FROM asset_assignments asg
           JOIN users u ON u.id = asg.employee_user_id
          WHERE asg.asset_id = ?
          ORDER BY asg.assigned_date DESC`,
        [req.params.id]
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/assets/requisitions — full requisition list for IT/Admin,
  // optional ?status= filter. Distinct from /for-manager-approval above,
  // which only shows a given manager's own pending queue.
  app.get("/api/assets/requisitions", authenticateToken, requireAdmin, requireModule("asset_management"), async (req: any, res) => {
    try {
      const clauses: string[] = [];
      const params: any[] = [];
      if (req.query.status) {
        clauses.push("r.status = ?");
        params.push(req.query.status);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = await queryDB(`${requisitionSelectBase} ${where} ORDER BY r.created_at DESC`, params);
      res.json(await attachItems(rows));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/assets/requisitions/:id/admin-decision — IT/Admin approves or
  // rejects. Valid from 'pending' (no Line Manager on file — step 1 was
  // skipped) or 'manager_approved'. Approving here does NOT hand over an
  // asset yet — that's the separate POST .../fulfill below, which is where
  // a specific inventory item actually gets picked and assigned.
  app.put(
    "/api/assets/requisitions/:id/admin-decision",
    authenticateToken,
    requireAdmin,
    requireModule("asset_management"),
    async (req: any, res) => {
      try {
        const { decision, rejection_reason } = req.body || {};
        if (decision !== "approve" && decision !== "reject") {
          return res.status(400).json({ error: "decision must be 'approve' or 'reject'." });
        }
        const rows = await queryDB("SELECT * FROM asset_requisitions WHERE id = ?", [req.params.id]);
        const requisition = rows[0];
        if (!requisition) return res.status(404).json({ error: "Requisition not found." });
        if (!["pending", "manager_approved"].includes(requisition.status)) {
          return res.status(400).json({ error: "This requisition is not awaiting an IT/Admin decision." });
        }

        const newStatus = decision === "approve" ? "approved" : "rejected";
        await queryDB(
          `UPDATE asset_requisitions
              SET status = ?, admin_decided_by = ?, admin_decided_at = NOW(), rejection_reason = ?
            WHERE id = ?`,
          [newStatus, req.user.id, decision === "reject" ? String(rejection_reason || "Rejected by IT/Admin") : null, requisition.id]
        );

        await createAlert(queryDB, {
          userId: requisition.employee_user_id,
          type: "asset_requisition" as AlertType,
          title: decision === "approve" ? "Requisition Approved" : "Requisition Rejected",
          message:
            decision === "approve"
              ? `Your ${requisition.asset_category} request was approved by IT/Admin and will be dispatched shortly.`
              : `Your ${requisition.asset_category} request was rejected by IT/Admin.`,
          relatedType: "asset_requisition",
          relatedId: requisition.id
        });

        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  // POST /api/assets/requisitions/:id/fulfill — Digital Handover: IT/Admin
  // picks a specific 'available' asset from inventory and hands it over.
  // Creates the asset_assignments row (the Employee then confirms receipt
  // via POST .../acknowledge above), flips the asset to 'assigned', and
  // moves the requisition to 'dispatched'.
  app.post(
    "/api/assets/requisitions/:id/fulfill",
    authenticateToken,
    requireAdmin,
    requireModule("asset_management"),
    async (req: any, res) => {
      try {
        const { asset_id, condition_on_assign } = req.body || {};
        if (!asset_id) return res.status(400).json({ error: "asset_id is required." });

        const reqRows = await queryDB("SELECT * FROM asset_requisitions WHERE id = ?", [req.params.id]);
        const requisition = reqRows[0];
        if (!requisition) return res.status(404).json({ error: "Requisition not found." });
        if (requisition.status !== "approved") {
          return res.status(400).json({ error: "This requisition must be Approved before it can be fulfilled." });
        }

        const assetRows = await queryDB("SELECT * FROM assets WHERE id = ?", [asset_id]);
        const asset = assetRows[0];
        if (!asset) return res.status(404).json({ error: "Asset not found." });
        if (asset.status !== "available") return res.status(400).json({ error: "That asset is not currently available." });

        const condition = ["new", "good"].includes(condition_on_assign) ? condition_on_assign : "good";

        const result = await queryDB(
          `INSERT INTO asset_assignments (asset_id, employee_user_id, requisition_id, assigned_date, condition_on_assign, assigned_by)
           VALUES (?, ?, ?, CURDATE(), ?, ?)`,
          [asset.id, requisition.employee_user_id, requisition.id, condition, req.user.id]
        );
        await queryDB("UPDATE assets SET status = 'assigned' WHERE id = ?", [asset.id]);
        await queryDB("UPDATE asset_requisitions SET status = 'dispatched', assigned_asset_id = ? WHERE id = ?", [asset.id, requisition.id]);

        await createAlert(queryDB, {
          userId: requisition.employee_user_id,
          type: "asset_requisition" as AlertType,
          title: "Asset Dispatched",
          message: `Your ${asset.name} (${asset.asset_tag}) is ready — please Accept & Acknowledge it in My Assets.`,
          relatedType: "asset_requisition",
          relatedId: requisition.id
        });

        res.json({ success: true, assignment_id: result.insertId });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  // PUT /api/assets/assignments/:id/return — Asset Return & Clearance:
  // IT/Admin actions an Employee's returned item (or a forced recall). Frees
  // the asset back to 'available' unless it came back damaged/lost, in which
  // case it's routed to 'maintenance'/'disposed' instead. Also marks the
  // originating requisition (if any) 'fulfilled', closing its lifecycle.
  app.put(
    "/api/assets/assignments/:id/return",
    authenticateToken,
    requireAdmin,
    requireModule("asset_management"),
    async (req: any, res) => {
      try {
        const { condition_on_return } = req.body || {};
        if (!["good", "damaged", "lost"].includes(condition_on_return)) {
          return res.status(400).json({ error: "condition_on_return must be 'good', 'damaged', or 'lost'." });
        }
        const rows = await queryDB("SELECT * FROM asset_assignments WHERE id = ?", [req.params.id]);
        const assignment = rows[0];
        if (!assignment) return res.status(404).json({ error: "Assignment not found." });
        if (assignment.returned_date) return res.status(400).json({ error: "Already returned." });

        await queryDB(
          "UPDATE asset_assignments SET returned_date = CURDATE(), condition_on_return = ? WHERE id = ?",
          [condition_on_return, assignment.id]
        );

        const nextAssetStatus = condition_on_return === "good" ? "available" : condition_on_return === "damaged" ? "maintenance" : "disposed";
        await queryDB("UPDATE assets SET status = ? WHERE id = ?", [nextAssetStatus, assignment.asset_id]);

        if (assignment.requisition_id) {
          await queryDB("UPDATE asset_requisitions SET status = 'fulfilled' WHERE id = ? AND status = 'dispatched'", [assignment.requisition_id]);
        }

        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );
}