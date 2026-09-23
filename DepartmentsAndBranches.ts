/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Departments (Admin Panel -> Departments) + Branches (Admin Panel ->
// Branches) routes, split out of server.ts on purpose — same convention as
// profileRoutes.ts/holidayRoutes.ts/Alerts.ts/UserManagement.ts: server.ts is
// already huge, so these go in their own file instead of growing it further.
// Registered from inside startServer() via registerDepartmentsAndBranchesRoutes(),
// reusing that same request's `app`/`authenticateToken`/`requireAdmin`/
// `requireModule`/`queryDB` rather than creating a second Express app or a
// second DB connection.
//
// Kept together in one file (rather than two) since both are small,
// standalone Admin Panel master-data CRUD modules of the same shape — not
// because they share any logic. Extracted as-is from server.ts's "Branches"
// and "Departments" sections — no logic changed, only moved. Everything else
// these sections reference (the `departments`/`branches` tables themselves,
// ADMIN_MODULE_KEYS, and resolveDepartmentSupervisor — used elsewhere by the
// Approval Workflow, not just here) stays in server.ts.

import type { Express } from "express";

interface DepartmentsAndBranchesRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  // Same requireModule(moduleKey) factory used by every other Admin Panel
  // module in server.ts — pass "departments"/"branches" through it here so a
  // Superadmin can grant/revoke each module's access independently.
  requireModule: (moduleKey: "departments" | "branches") => any;
  // Per-module action gate (Read Only/Edit-Add/Entry-Upload/Delete-Trash/
  // Permanent Delete) — Departments is the first module wired up to this;
  // Branches stays on requireModule alone for now. See requireModuleLayer()
  // in server.ts for the exact semantics.
  requireModuleLayer: (moduleKey: "departments" | "branches", layer: "read" | "edit_add" | "entry_upload" | "delete_trash" | "permanent_delete") => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
}

export function registerDepartmentsAndBranchesRoutes(app: Express, deps: DepartmentsAndBranchesRouteDeps) {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, queryDB } = deps;

  // Branches (Admin Panel -> Branches, its own AdminModuleKey/module permission,
  // separate from Projects). Same GPS-pinned-site shape as a Project, kept in
  // its own table on purpose — Projects also back MPR Entries, Bulk Add Users
  // logins and Budget/Job reports, none of which should ever see a Branch row
  // mixed into their picklists. Phase 1: management (this CRUD + Admin Panel
  // tab) only — every signed-in account can list Branches (no per-user
  // permission table yet, unlike user_project_permissions), and nothing in
  // Remote Attendance/Timesheet reads from this table yet.
  app.get("/api/branches", authenticateToken, async (req, res) => {
    try {
      const branches = await queryDB("SELECT * FROM branches ORDER BY branch_name ASC");
      res.json(branches);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Same both-or-neither/finite-range validation as parseProjectLocation above
  // (kept as its own copy rather than a shared helper, matching how Projects'
  // own version isn't shared with anything else in this file either).
  function parseBranchLocation(body: any): { lat: number | null; lng: number | null; label: string | null; radius: number | null } | { error: string } {
    const hasLat = body.location_lat !== undefined && body.location_lat !== null && body.location_lat !== "";
    const hasLng = body.location_lng !== undefined && body.location_lng !== null && body.location_lng !== "";
    if (!hasLat && !hasLng) return { lat: null, lng: null, label: null, radius: null };
    if (hasLat !== hasLng) return { error: "Both latitude and longitude are required to set a location" };
    const lat = Number(body.location_lat);
    const lng = Number(body.location_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { error: "Invalid map location coordinates" };
    }
    const label = typeof body.location_label === "string" ? body.location_label.trim().slice(0, 255) || null : null;

    let radius: number | null = null;
    const hasRadius = body.location_radius !== undefined && body.location_radius !== null && body.location_radius !== "";
    if (hasRadius) {
      const r = Number(body.location_radius);
      if (!Number.isFinite(r) || r < 10 || r > 50000) {
        return { error: "Radius must be between 10 and 50,000 meters" };
      }
      radius = Math.round(r);
    }
    return { lat, lng, label, radius };
  }

  // Which Holiday Calendar (Admin Panel -> Holidays) applies to every
  // Employee at this Branch — 'head_office' unless the request explicitly
  // says 'project_site', matching the branches.branch_type column's own
  // default.
  function parseBranchType(body: any): "head_office" | "project_site" {
    return body.branch_type === "project_site" ? "project_site" : "head_office";
  }

  app.post("/api/branches", authenticateToken, requireAdmin, requireModule("branches"), async (req: any, res) => {
    try {
      const { branch_name } = req.body;
      if (!branch_name) return res.status(400).json({ error: "Branch name is required" });
      const location = parseBranchLocation(req.body);
      if ("error" in location) return res.status(400).json({ error: location.error });
      const branchType = parseBranchType(req.body);

      const result = await queryDB(
        "INSERT INTO branches (branch_name, branch_type, location_lat, location_lng, location_label, location_radius, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [branch_name.trim(), branchType, location.lat, location.lng, location.label, location.radius, req.user.id]
      );
      res.json({
        id: result.insertId,
        branch_name: branch_name.trim(),
        branch_type: branchType,
        location_lat: location.lat,
        location_lng: location.lng,
        location_label: location.label,
        location_radius: location.radius
      });
    } catch (err: any) {
      if (err.code === "ER_DUP_ENTRY" || err.message?.includes("already exists")) {
        return res.status(400).json({ error: "Branch already exists" });
      }
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/branches/:id", authenticateToken, requireAdmin, requireModule("branches"), async (req, res) => {
    try {
      const { id } = req.params;
      const { branch_name } = req.body;
      if (!branch_name) return res.status(400).json({ error: "Branch name is required" });
      const location = parseBranchLocation(req.body);
      if ("error" in location) return res.status(400).json({ error: location.error });
      const branchType = parseBranchType(req.body);

      await queryDB(
        "UPDATE branches SET branch_name = ?, branch_type = ?, location_lat = ?, location_lng = ?, location_label = ?, location_radius = ? WHERE id = ?",
        [branch_name.trim(), branchType, location.lat, location.lng, location.label, location.radius, id]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/branches/:id", authenticateToken, requireAdmin, requireModule("branches"), async (req, res) => {
    try {
      const { id } = req.params;
      await queryDB("DELETE FROM branches WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Departments (Admin Panel -> Departments, its own "departments"
  // AdminModuleKey) — real org-structure master data: a Department name, an
  // optional Supervisor (a login account, users.id — see the long design
  // comment on the `departments` table in initDB()), and
  // include_supervisor_approval (default ON) which drives the Department
  // Supervisor auto-layer in the Approval Workflow (resolveDepartmentSupervisor
  // / createTemplateApprovalRequest / getCurrentStepApprovers). GET is open to
  // any signed-in account (same convention as GET /api/projects) since the
  // Employees form's Department picker needs this regardless of whether that
  // account has been granted the "departments" module itself; only
  // create/update/delete are gated.
  app.get("/api/departments", authenticateToken, async (req: any, res) => {
    try {
      const rows = await queryDB(
        `SELECT d.*, u.name AS supervisor_name
         FROM departments d
         LEFT JOIN users u ON u.id = d.supervisor_user_id
         ORDER BY d.name ASC`
      );
      res.json(
        rows.map((d: any) => ({
          id: d.id,
          name: d.name,
          supervisor_user_id: d.supervisor_user_id || null,
          supervisor_name: d.supervisor_name || null,
          include_supervisor_approval: !!Number(d.include_supervisor_approval),
          is_active: !!Number(d.is_active),
          created_at: d.created_at
        }))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/departments", authenticateToken, requireAdmin, requireModule("departments"), requireModuleLayer("departments", "edit_add"), async (req: any, res) => {
    try {
      const name = String(req.body?.name || "").trim();
      if (!name) return res.status(400).json({ error: "Department name is required." });
      const existing = await queryDB("SELECT id FROM departments WHERE name = ?", [name]);
      if (existing.length > 0) return res.status(400).json({ error: "A Department with this name already exists." });

      const supervisorUserId = req.body?.supervisor_user_id ? Number(req.body.supervisor_user_id) : null;
      if (supervisorUserId) {
        const su = await queryDB("SELECT id FROM users WHERE id = ?", [supervisorUserId]);
        if (su.length === 0) return res.status(400).json({ error: "Selected Supervisor account not found." });
      }
      // Defaults ON — simply picking a Supervisor is enough to gate this
      // Department's Approval Workflow with them as the first layer; an Admin
      // has to deliberately turn this off (see the departments table comment).
      const includeSupervisorApproval = req.body?.include_supervisor_approval === false ? 0 : 1;

      const result = await queryDB(
        "INSERT INTO departments (name, supervisor_user_id, include_supervisor_approval, is_active) VALUES (?, ?, ?, 1)",
        [name, supervisorUserId, includeSupervisorApproval]
      );
      res.status(201).json({ success: true, id: result.insertId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/departments/:id", authenticateToken, requireAdmin, requireModule("departments"), requireModuleLayer("departments", "edit_add"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await queryDB("SELECT * FROM departments WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Department not found." });

      const name = String(req.body?.name || "").trim();
      if (!name) return res.status(400).json({ error: "Department name is required." });
      const dupe = await queryDB("SELECT id FROM departments WHERE name = ? AND id <> ?", [name, id]);
      if (dupe.length > 0) return res.status(400).json({ error: "A Department with this name already exists." });

      const supervisorUserId = req.body?.supervisor_user_id ? Number(req.body.supervisor_user_id) : null;
      if (supervisorUserId) {
        const su = await queryDB("SELECT id FROM users WHERE id = ?", [supervisorUserId]);
        if (su.length === 0) return res.status(400).json({ error: "Selected Supervisor account not found." });
      }
      const includeSupervisorApproval = req.body?.include_supervisor_approval === false ? 0 : 1;
      const isActive = req.body?.is_active === false ? 0 : 1;

      await queryDB(
        "UPDATE departments SET name = ?, supervisor_user_id = ?, include_supervisor_approval = ?, is_active = ? WHERE id = ?",
        [name, supervisorUserId, includeSupervisorApproval, isActive, id]
      );
      // Keep every existing reader's plain-text `all_employees.department`
      // mirror in sync with a rename (Notices targeting, Attendance Reports,
      // the Employees panel's own search — see resolveEmployeeDepartment).
      await queryDB("UPDATE all_employees SET department = ? WHERE department_id = ?", [name, id]);
      // Same reasoning for any Superadmin-granted per-user Attendance Report
      // Department scope (attendance_report_department_access) that names the
      // OLD Department name — otherwise a rename would silently drop that
      // account back to "no rows for this name" (which reads as fully
      // unrestricted, not fully blocked, so this is a quiet privilege change
      // if left un-synced, not just a display bug).
      if (existing[0].name !== name) {
        try {
          await queryDB("UPDATE attendance_report_department_access SET department = ? WHERE department = ?", [name, existing[0].name]);
        } catch {
          // Non-fatal: at worst a rare (user_id, department) unique-key clash
          // (that account already had a scope row under the new name too) —
          // never block the Department rename itself over this side effect.
        }
        // Same reasoning for the 'leave_applications' module's own per-user
        // Department scope (leave_application_department_access).
        try {
          await queryDB("UPDATE leave_application_department_access SET department = ? WHERE department = ?", [name, existing[0].name]);
        } catch {
          // Non-fatal — see comment above.
        }
        // Same reasoning for the 'conveyance' module's own per-user
        // Department scope (conveyance_claim_department_access).
        try {
          await queryDB("UPDATE conveyance_claim_department_access SET department = ? WHERE department = ?", [name, existing[0].name]);
        } catch {
          // Non-fatal — see comment above.
        }
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Deleting a Department only detaches it — all_employees.department_id ON
  // DELETE SET NULL (see initDB()), so every Employee just loses the
  // structured link; their plain-text `department` mirror is untouched.
  app.delete("/api/departments/:id", authenticateToken, requireAdmin, requireModule("departments"), requireModuleLayer("departments", "delete_trash"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await queryDB("SELECT * FROM departments WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Department not found." });
      await queryDB("DELETE FROM departments WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}