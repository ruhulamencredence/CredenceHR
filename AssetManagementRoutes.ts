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
//                          Status timeline: pending -> approved -> dispatched
//                          -> fulfilled, or rejected at any approval step.
//                          ('manager_approved' is a legacy status kept in the
//                          ENUM only so pre-existing rows from before this
//                          Approval Workflow migration still render — new
//                          requisitions never enter it.)
//   asset_assignments   — who has which asset right now, and the full
//                          handover/return history for a given asset.
//                          returned_date IS NULL means still in use.
//
// Approval routing (matching the Asset Management flowchart — Supervisor
// Approval, then HR/IT Department Review) now goes entirely through the same
// Dynamic Approval Engine every other module uses (see
// createTemplateApprovalRequest/performApprovalAction in server.ts,
// request_type 'asset'): Layer 1 defaults to the requester's own Supervisor
// (Direct Supervisor, falling back to Department Supervisor) exactly like
// Conveyance/Leave/Timesheet, unless a Superadmin builds an 'asset' Template
// whose own Layer 1 overrides it; every Layer after that is that Template's
// hand-picked approvers, changeable from Admin Panel -> Approvals ->
// Templates the same way as any other module's chain. This REPLACES the
// hardcoded two-step Line-Manager-then-IT/Admin flow this file used to
// implement itself — approving/rejecting a requisition now happens from the
// generic Admin Panel -> Approvals queue / "My Approvals" (POST
// /api/approvals/:id/act, /api/my-approvals/:id/act), not from a route in
// this file. Once the LAST step approves, the requisition flips to
// 'approved' (finalizeAssetRequisitionApproval, server.ts) — IT/Admin then
// still has to actually hand over a specific inventory item via POST
// /api/assets/requisitions/:id/fulfill below, which remains this file's own
// concern (not part of the Approval Workflow).

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
  // Same helper GrievanceRoutes.ts/VehicleManagementRoutes.ts use for their
  // own canManage() — lets POST .../fulfill recognize a plain 'user' role
  // account that holds the 'asset_management' Module Access grant, same as
  // requireModule's own role-permissiveness (see wasFinalApprover's own
  // callers below for the OTHER way in, no grant needed at all).
  getAdminModules: (userId: number) => Promise<string[]>;
  createAlert: (
    queryDB: (sql: string, params?: any[]) => Promise<any>,
    params: { userId: number; type: AlertType; title: string; message: string; relatedType?: string; relatedId?: number }
  ) => Promise<void>;
  // Dynamic Approval Engine (server.ts) — routes a submitted requisition
  // through request_type 'asset' the same way Conveyance/Leave/Timesheet
  // already do. See the design note above registerAssetManagementRoutes.
  createTemplateApprovalRequest: (
    requestType: "conveyance" | "leave" | "timesheet" | "asset",
    sourceType: "user_claim" | "attendance_correction" | "leave_application" | "asset_requisition",
    sourceId: number,
    requestedBy: number
  ) => Promise<{ autoApproved: boolean; template: any | null }>;
  getCurrentStepApprovers: (request: any) => Promise<{ user_id: number; user_name: string | null }[]>;
  // Auto-approve path (no Supervisor and no Template resolved at all) — same
  // finalize function performApprovalAction's 'asset_requisition' branch
  // calls once the Approval Workflow's LAST step signs off.
  finalizeAssetRequisitionApproval: (requisitionId: number, approvedBy: number, remarks: string | null) => Promise<void>;
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
    // Flowchart's "মালামাল কি ঠিক আছে? — না (গরমিল/ড্যামেজ) -> অ্যাডজাস্টমেন্ট/
    // ক্লেইম রিকোয়েস্ট -> ইনভেন্টরি কর্তৃক সমস্যার সমাধান" branch: instead of
    // Accept & Acknowledge, an Employee can report the handed-over item
    // doesn't match the requisition (wrong item) or arrived damaged/missing.
    // One row per report; resolving it (optionally swapping in a different
    // asset) is what lets the Employee go back to a normal Acknowledge.
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS asset_assignment_claims (
        id INT AUTO_INCREMENT PRIMARY KEY,
        assignment_id INT NOT NULL,
        employee_user_id INT NOT NULL,
        issue_type ENUM('mismatch','damaged','missing','other') NOT NULL DEFAULT 'other',
        description TEXT NOT NULL,
        status ENUM('pending','resolved') NOT NULL DEFAULT 'pending',
        resolution_note TEXT NULL,
        resolved_by INT NULL,
        resolved_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (assignment_id) REFERENCES asset_assignments(id) ON DELETE CASCADE,
        FOREIGN KEY (employee_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure Asset Management tables exist: " + err.message);
  }
}

export function registerAssetManagementRoutes(app: Express, deps: AssetManagementRouteDeps) {
  const {
    authenticateToken,
    requireAdmin,
    requireModule,
    queryDB,
    getAdminModules,
    createAlert,
    createTemplateApprovalRequest,
    getCurrentStepApprovers,
    finalizeAssetRequisitionApproval
  } = deps;

  async function canManage(userId: number, role: string): Promise<boolean> {
    if (role === "superadmin") return true;
    if (role !== "admin" && role !== "user") return false;
    const modules = await getAdminModules(userId);
    return modules.includes("asset_management");
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

  // Attaches r.pending_with — who this requisition's Approval Workflow is
  // CURRENTLY waiting on, for every row with status 'pending' (undefined/
  // null on any other status, or if no approval_requests row is found —
  // e.g. a legacy pre-Approval-Workflow requisition). Resolved the same way
  // GET /api/approvals does: the request's current step's approver(s), via
  // getCurrentStepApprovers (the Supervisor auto-layer when it's step 1, or
  // the Template's own step otherwise) — ANY ONE of them clears the step,
  // so all are shown, not just one.
  // Plain any[] in/out (not generic over T) — chaining this with attachItems
  // (which has its own, differently-shaped generic) defeats TS's inference
  // either order; every caller already treats these rows as loosely-typed
  // DB result objects anyway.
  async function attachPendingApprover(rows: any[]): Promise<any[]> {
    const pendingIds = new Set(rows.filter((r) => r.status === "pending").map((r) => r.id));
    if (pendingIds.size === 0) return rows.map((r) => ({ ...r, pending_with: null }));

    const requestRows = await queryDB("SELECT * FROM approval_requests WHERE source_type = ?", ["asset_requisition"]);
    const requestByRequisitionId = new Map<number, any>(
      requestRows
        .filter((rr: any) => rr.status === "pending" && pendingIds.has(Number(rr.source_id)))
        .map((rr: any) => [Number(rr.source_id), rr])
    );

    const result: any[] = [];
    for (const r of rows) {
      const request = requestByRequisitionId.get(r.id);
      if (!request) {
        result.push({ ...r, pending_with: null });
        continue;
      }
      const approvers = await getCurrentStepApprovers(request);
      const names = approvers.map((a) => a.user_name).filter((n): n is string => !!n);
      result.push({ ...r, pending_with: names.length > 0 ? names.join(", ") : null });
    }
    return result;
  }

  // Was this account the one who cast the FINAL 'approved' action that
  // actually cleared a requisition's Approval Workflow (the last entry in
  // approval_requests.actions_json)? Answers "the person who approved this
  // may want to also finish the job (dispatch a specific inventory item)
  // without needing a SEPARATE 'asset_management' Module Access grant on
  // top of already being trusted as a Template approver" — see POST
  // .../requisitions/:id/fulfill and GET .../awaiting-my-fulfillment below.
  // Same pattern as VehicleManagementRoutes.ts's own wasFinalApprover.
  async function wasFinalApprover(requisitionId: number, userId: number): Promise<boolean> {
    const requestRows: any = await queryDB("SELECT * FROM approval_requests WHERE source_type = ?", ["asset_requisition"]);
    const request = requestRows.find((r: any) => Number(r.source_id) === requisitionId);
    if (!request) return false;
    let actions: any[] = [];
    try {
      actions = JSON.parse(request.actions_json || "[]");
    } catch {
      actions = [];
    }
    const last = actions[actions.length - 1];
    return !!last && last.action === "approved" && Number(last.approver_id) === Number(userId);
  }

  // This requisition's "HR/Admin Review" layer approvers (ApprovalTemplate
  // Manager.tsx's LAYER_NAMES step 2 — the Template's OWN step_order 1,
  // always, regardless of whether the auto Supervisor gate is also active as
  // a virtual step in front of it — a Template's own steps are always
  // HR-first: normally Supervisor(auto) -> HR(step_order 1) -> Inventory
  // (step_order 2), or, when skip_auto_supervisor's "জরুরি/HR Direct" path
  // is used (VehicleManagementRoutes.ts's POST .../admin-create equivalent
  // idea), HR/Admin's own step_order 1 IS the first real decision with no
  // Supervisor layer at all — either way HR is step_order 1). Used to CC HR
  // on every downstream operation (dispatch, issue reported/resolved,
  // employee's final Acknowledge) even once their own approval step is long
  // past and the request has moved on to Inventory/Store or fully cleared —
  // so HR keeps full visibility over where every requisition/asset stands
  // without having to be the one physically handling it (the user's
  // "admin/superadmin won't be doing the hand-over work, but still needs to
  // see it happen" requirement). Returns [] for a requisition with no
  // Template at all (Supervisor-only or auto-approved) — there's no
  // configured "HR layer" to notify in that case.
  async function getHrLayerApprovers(requisitionId: number): Promise<{ user_id: number; user_name: string | null }[]> {
    const requestRows: any = await queryDB("SELECT * FROM approval_requests WHERE source_type = ?", ["asset_requisition"]);
    const request = requestRows.find((r: any) => Number(r.source_id) === requisitionId);
    if (!request || !request.template_id) return [];
    const rows = await queryDB(
      `SELECT sa.user_id, u.name AS user_name
       FROM approval_template_step_approvers sa
       JOIN approval_template_steps s ON s.id = sa.step_id
       LEFT JOIN users u ON u.id = sa.user_id
       WHERE s.template_id = ? AND s.step_order = ?`,
      [request.template_id, 1]
    );
    return rows.map((r: any) => ({ user_id: Number(r.user_id), user_name: r.user_name }));
  }

  // Alerts every HR/Admin-layer approver on this requisition — see
  // getHrLayerApprovers above. Never throws — a notification failure
  // shouldn't fail the actual operation it's reporting on.
  async function notifyHrLayer(requisitionId: number, title: string, message: string) {
    try {
      const approvers = await getHrLayerApprovers(requisitionId);
      for (const approver of approvers) {
        await createAlert(queryDB, {
          userId: approver.user_id,
          type: "asset_requisition" as AlertType,
          title,
          message,
          relatedType: "asset_requisition",
          relatedId: requisitionId
        });
      }
    } catch (err: any) {
      console.warn("⚠️ Could not notify HR layer for Asset Requisition #" + requisitionId + ": " + err.message);
    }
  }

  // ---------------------------------------------------------------------
  // Employee self-service (Employee Profile -> Asset Management)
  // ---------------------------------------------------------------------

  // GET /api/assets/my — assets currently assigned to me (My Assets tab).
  // Each row also carries pending_claim (null once none/resolved) so the
  // Employee sees "Issue Reported — Awaiting Resolution" instead of the
  // Accept & Acknowledge button while IT/Admin is still working it.
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
      if (rows.length === 0) return res.json(rows);
      const ids = rows.map((r: any) => r.assignment_id);
      const claims = await queryDB(
        `SELECT * FROM asset_assignment_claims WHERE assignment_id IN (${ids.map(() => "?").join(",")}) AND status = 'pending'`,
        ids
      );
      const pendingByAssignment = new Map<number, any>(claims.map((c: any) => [Number(c.assignment_id), c]));
      res.json(rows.map((r: any) => ({ ...r, pending_claim: pendingByAssignment.get(Number(r.assignment_id)) || null })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/assets/assignments/:id/acknowledge — the "Accept & Acknowledge"
  // digital handover button: the Employee confirms they've received the
  // asset 100% as requisitioned. Only the assignment's own Employee may
  // acknowledge it. This is what closes out the REQUISITION as successful
  // (status -> 'fulfilled') — the asset's own later physical return (if any,
  // e.g. on resignation or no longer needing it) is a separate, unrelated
  // asset_assignments lifecycle event (see PUT .../return below) and no
  // longer what used to flip this status.
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
      const pendingClaims = await queryDB("SELECT id FROM asset_assignment_claims WHERE assignment_id = ? AND status = 'pending'", [
        assignment.id
      ]);
      if (pendingClaims.length > 0) {
        return res.status(400).json({ error: "You've already reported an issue on this item — wait for IT/Admin to resolve it first." });
      }
      await queryDB("UPDATE asset_assignments SET acknowledged_at = NOW() WHERE id = ?", [assignment.id]);
      if (assignment.requisition_id) {
        await queryDB("UPDATE asset_requisitions SET status = 'fulfilled' WHERE id = ? AND status = 'dispatched'", [assignment.requisition_id]);
        await notifyHrLayer(
          Number(assignment.requisition_id),
          "Asset Requisition Completed",
          `${req.user.name || "The employee"} confirmed receipt — requisition #${assignment.requisition_id} is now successfully fulfilled.`
        );
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/assets/assignments/:id/report-issue — flowchart's "রিকুইজিশন
  // অনুযায়ী মালামাল কি ঠিক আছে? -> না (গরমিল/ড্যামেজ) -> অ্যাডজাস্টমেন্ট/ক্লেইম
  // রিকোয়েস্ট" branch: instead of Accept & Acknowledge, the Employee reports
  // the handed-over item is wrong/damaged/missing. Blocks Acknowledge until
  // IT/Admin resolves it (PUT .../resolve below).
  app.post("/api/assets/assignments/:id/report-issue", authenticateToken, async (req: any, res) => {
    try {
      const { issue_type, description } = req.body || {};
      const issueType = ["mismatch", "damaged", "missing", "other"].includes(issue_type) ? issue_type : "other";
      const desc = String(description || "").trim();
      if (!desc) return res.status(400).json({ error: "Describe the issue." });

      const rows = await queryDB("SELECT * FROM asset_assignments WHERE id = ?", [req.params.id]);
      const assignment = rows[0];
      if (!assignment) return res.status(404).json({ error: "Assignment not found." });
      if (assignment.employee_user_id !== req.user.id) {
        return res.status(403).json({ error: "Not authorized." });
      }
      if (assignment.acknowledged_at) {
        return res.status(400).json({ error: "This item was already acknowledged — use Request Return / Replace instead." });
      }
      const existing = await queryDB("SELECT id FROM asset_assignment_claims WHERE assignment_id = ? AND status = 'pending'", [
        assignment.id
      ]);
      if (existing.length > 0) return res.status(400).json({ error: "An issue is already reported on this item and awaiting resolution." });

      const result = await queryDB(
        `INSERT INTO asset_assignment_claims (assignment_id, employee_user_id, issue_type, description)
         VALUES (?, ?, ?, ?)`,
        [assignment.id, req.user.id, issueType, desc]
      );

      const assetRows = await queryDB("SELECT * FROM assets WHERE id = ?", [assignment.asset_id]);
      const asset = assetRows[0];
      await createAlert(queryDB, {
        userId: assignment.assigned_by,
        type: "asset_requisition" as AlertType,
        title: "Asset Issue Reported",
        message: `${req.user.name || "An employee"} reported a problem with ${asset ? asset.name : "an asset"}${
          asset ? ` (${asset.asset_tag})` : ""
        }: ${desc}`,
        relatedType: "asset_assignment_claim",
        relatedId: result.insertId
      });
      if (assignment.requisition_id) {
        await notifyHrLayer(
          Number(assignment.requisition_id),
          "Asset Issue Reported",
          `${req.user.name || "An employee"} reported a problem on requisition #${assignment.requisition_id}: ${desc}`
        );
      }

      res.json({ success: true, id: result.insertId });
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
  // mechanism. Routing (who has to approve it) is entirely the Dynamic
  // Approval Engine's job from here — see createTemplateApprovalRequest.
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

      const result = await queryDB(
        `INSERT INTO asset_requisitions
           (employee_user_id, asset_category, reason, urgency, target_date,
            attachment_filename, attachment_mimetype, attachment_data, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [req.user.id, category, reason, urgencyLevel, target_date || null, filename, mimetype, attachmentBuffer]
      );

      for (const it of cleanItems) {
        await queryDB(
          `INSERT INTO asset_requisition_items (requisition_id, item_name, purpose, unit, quantity)
           VALUES (?, ?, ?, ?, ?)`,
          [result.insertId, it.item_name, it.purpose, it.unit, it.quantity]
        );
      }

      // Dynamic Approval Engine — routed through this Employee's assigned
      // Template for request_type 'asset' (Layer 1 defaults to their own
      // Supervisor per the flowchart's "Supervisor Approval" step unless a
      // Template overrides it; Layer 2+ is HR/IT's hand-picked approvers).
      // Falls back to a straight auto-approve if neither a Supervisor nor a
      // Template resolve at all.
      const { autoApproved } = await createTemplateApprovalRequest("asset", "asset_requisition", result.insertId, req.user.id);
      if (autoApproved) {
        try {
          await finalizeAssetRequisitionApproval(result.insertId, req.user.id, null);
        } catch (finalizeErr: any) {
          console.warn("⚠️ Could not auto-process Asset Requisition #" + result.insertId + ": " + finalizeErr.message);
        }
      } else {
        // Notify whoever the request is actually sitting with first — same
        // idea as Conveyance Bill Claim's own submit route.
        try {
          const requestRows = await queryDB("SELECT * FROM approval_requests WHERE source_type = ?", ["asset_requisition"]);
          const createdRequest = requestRows.find((r: any) => Number(r.source_id) === Number(result.insertId));
          if (createdRequest) {
            const approvers = await getCurrentStepApprovers(createdRequest);
            for (const approver of approvers) {
              await createAlert(queryDB, {
                userId: approver.user_id,
                type: "asset_requisition" as AlertType,
                title: "New Asset Requisition Awaiting Your Approval",
                message: `${req.user.name || "An employee"} requested ${category}. Please review.`,
                relatedType: "asset_requisition",
                relatedId: result.insertId
              });
            }
          }
        } catch (alertErr: any) {
          console.warn("⚠️ Could not notify the current-step approver for Asset Requisition #" + result.insertId + ": " + alertErr.message);
        }
      }

      // HR/Admin layer stays CC'd from the very start, even on a step they
      // aren't currently waiting on (e.g. still sitting with the requester's
      // Supervisor) — see notifyHrLayer's own comment.
      await notifyHrLayer(
        Number(result.insertId),
        "New Asset Requisition Submitted",
        `${req.user.name || "An employee"} submitted a request for ${category}.`
      );

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
      res.json(await attachItems(await attachPendingApprover(rows)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/assets/requisitions/awaiting-my-fulfillment — the OTHER half
  // of "who does the Fulfill/Hand Over step": an account named as a
  // Template approver (Admin Panel -> Approvals -> Templates) may hold NO
  // 'asset_management' Module Access at all, so it has no Admin Panel page
  // to go finish the job on once it approves. This is that page's
  // self-service equivalent — no module gate, just "did I approve this"
  // (wasFinalApprover) — so the exact same account that cleared the
  // Approval Workflow can see and act on its own approved-but-undispatched
  // requisitions without a Superadmin having to grant it Admin Panel access
  // on top of already being trusted as an approver.
  app.get("/api/assets/requisitions/awaiting-my-fulfillment", authenticateToken, async (req: any, res) => {
    try {
      const rows = await queryDB(`${requisitionSelectBase} WHERE r.status = ? ORDER BY r.created_at DESC`, ["approved"]);
      const mine: any[] = [];
      for (const r of rows) {
        if (await wasFinalApprover(Number((r as any).id), req.user.id)) mine.push(r);
      }
      res.json(await attachItems(mine));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/assets/available — no module gate, just enough (id/name/
  // asset_tag/category) for the asset picker on POST .../fulfill below, so
  // an approver acting via the self-service route above can still pick an
  // item without 'asset_management' Module Access. GET /api/assets (the
  // full inventory record, Admin Panel's own list) stays module-gated.
  app.get("/api/assets/available", authenticateToken, async (_req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM assets WHERE status = ?", ["available"]);
      res.json(rows.map((a: any) => ({ id: Number(a.id), asset_tag: a.asset_tag, name: a.name, category: a.category })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------
  // IT/Admin (Admin Panel -> Asset Management) — gated behind the
  // 'asset_management' AdminModuleKey, same convention as every other
  // Admin Panel module (a Superadmin always passes requireModule).
  // Approve/Reject itself now happens through the generic Approval Workflow
  // queue (Admin Panel -> Approvals / "My Approvals") — see the design note
  // above registerAssetManagementRoutes. What's left here is inventory
  // management plus fulfilling an already-approved requisition.
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
  // optional ?status= filter. Approve/Reject itself is done from the generic
  // Approval Workflow queue (Admin Panel -> Approvals), not from here.
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
      res.json(await attachItems(await attachPendingApprover(rows)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/assets/assignment-claims — IT/Admin's queue for the flowchart's
  // "গরমিল/ড্যামেজ" branch (POST .../report-issue above), optional ?status=
  // filter (defaults to showing everything, newest first).
  app.get("/api/assets/assignment-claims", authenticateToken, requireAdmin, requireModule("asset_management"), async (req: any, res) => {
    try {
      const clauses: string[] = [];
      const params: any[] = [];
      if (req.query.status) {
        clauses.push("ac.status = ?");
        params.push(req.query.status);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = await queryDB(
        `SELECT ac.*, u.name AS employee_name, asg.asset_id, a.name AS asset_name, a.asset_tag AS asset_tag
           FROM asset_assignment_claims ac
           JOIN asset_assignments asg ON asg.id = ac.assignment_id
           JOIN users u ON u.id = ac.employee_user_id
           LEFT JOIN assets a ON a.id = asg.asset_id
          ${where}
          ORDER BY ac.created_at DESC`,
        params
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/assets/assignment-claims/:id/resolve — flowchart's "ইনভেন্টরি
  // কর্তৃক সমস্যার সমাধান": IT/Admin closes out a reported issue, optionally
  // swapping in a different in-stock item (replacement_asset_id) when the
  // original one was actually wrong/damaged — the Employee still has to
  // Acknowledge afterwards either way (flowchart routes back to "ইউজার কর্তৃক
  // সিস্টেমে প্রাপ্তি স্বীকার", not straight to closed).
  app.put(
    "/api/assets/assignment-claims/:id/resolve",
    authenticateToken,
    requireAdmin,
    requireModule("asset_management"),
    async (req: any, res) => {
      try {
        const { resolution_note, replacement_asset_id } = req.body || {};
        const note = String(resolution_note || "").trim();
        if (!note) return res.status(400).json({ error: "Add a note on how this was resolved." });

        const claimRows = await queryDB("SELECT * FROM asset_assignment_claims WHERE id = ?", [req.params.id]);
        const claim = claimRows[0];
        if (!claim) return res.status(404).json({ error: "Claim not found." });
        if (claim.status !== "pending") return res.status(400).json({ error: "This claim was already resolved." });

        const assignmentRows = await queryDB("SELECT * FROM asset_assignments WHERE id = ?", [claim.assignment_id]);
        const assignment = assignmentRows[0];
        if (!assignment) return res.status(404).json({ error: "Assignment not found." });

        if (replacement_asset_id) {
          const newAssetRows = await queryDB("SELECT * FROM assets WHERE id = ?", [replacement_asset_id]);
          const newAsset = newAssetRows[0];
          if (!newAsset) return res.status(404).json({ error: "Replacement asset not found." });
          if (newAsset.status !== "available") return res.status(400).json({ error: "That replacement asset is not currently available." });

          // The original item goes to Maintenance rather than back to
          // Available — it was reported wrong/damaged/missing, so it isn't
          // safe to hand to the next requester untouched.
          await queryDB("UPDATE assets SET status = 'maintenance' WHERE id = ?", [assignment.asset_id]);
          await queryDB("UPDATE assets SET status = 'assigned' WHERE id = ?", [newAsset.id]);
          await queryDB("UPDATE asset_assignments SET asset_id = ? WHERE id = ?", [newAsset.id, assignment.id]);
          if (assignment.requisition_id) {
            await queryDB("UPDATE asset_requisitions SET assigned_asset_id = ? WHERE id = ?", [newAsset.id, assignment.requisition_id]);
          }
        }

        await queryDB(
          `UPDATE asset_assignment_claims
              SET status = 'resolved', resolution_note = ?, resolved_by = ?, resolved_at = NOW()
            WHERE id = ?`,
          [note, req.user.id, claim.id]
        );

        await createAlert(queryDB, {
          userId: claim.employee_user_id,
          type: "asset_requisition" as AlertType,
          title: "Asset Issue Resolved",
          message: `Your reported issue was resolved: ${note}${replacement_asset_id ? " A replacement item was assigned." : ""} Please Accept & Acknowledge in My Assets.`,
          relatedType: "asset_assignment_claim",
          relatedId: claim.id
        });
        if (assignment.requisition_id) {
          await notifyHrLayer(
            Number(assignment.requisition_id),
            "Asset Issue Resolved",
            `The reported issue on requisition #${assignment.requisition_id} was resolved: ${note}`
          );
        }

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
  //
  // NOT module-gated the way every other Admin Panel route in this file is —
  // a plain 'asset_management' Module Access grant is one way in, but the
  // account that just cleared THIS SPECIFIC requisition's Approval Workflow
  // (wasFinalApprover) is also allowed to finish the job — see GET
  // .../awaiting-my-fulfillment above for where that account finds this
  // action without any Admin Panel access at all.
  app.post("/api/assets/requisitions/:id/fulfill", authenticateToken, async (req: any, res) => {
      try {
        const id = Number(req.params.id);
        const manage = await canManage(req.user.id, req.user.role);
        if (!manage && !(await wasFinalApprover(id, req.user.id))) {
          return res
            .status(403)
            .json({ error: "You need Asset Management access, or to be this request's approver, to fulfill it." });
        }
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
        await notifyHrLayer(
          Number(requisition.id),
          "Asset Dispatched",
          `${asset.name} (${asset.asset_tag}) was dispatched for requisition #${requisition.id}.`
        );

        res.json({ success: true, assignment_id: result.insertId });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

  // PUT /api/assets/assignments/:id/return — Asset Return & Clearance:
  // IT/Admin actions an Employee's returned item (or a forced recall). Frees
  // the asset back to 'available' unless it came back damaged/lost, in which
  // case it's routed to 'maintenance'/'disposed' instead. The originating
  // requisition (if any) was already marked 'fulfilled' the moment the
  // Employee Accept & Acknowledged it (POST .../acknowledge above) — a
  // later physical return is a separate, unrelated asset_assignments event
  // (resignation, no longer needed, etc.) and no longer re-touches
  // asset_requisitions.status; the UPDATE below is a harmless no-op on the
  // normal path (status is already 'fulfilled', not 'dispatched') and only
  // still matters for a pre-existing row acknowledged before this change.
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