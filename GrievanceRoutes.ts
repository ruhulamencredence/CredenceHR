/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Grievance & Disciplinary (Admin Panel -> HR Advanced -> "Grievance &
// Disciplinary") — kept in its own file, same reasoning as
// ExitOffboardingRoutes.ts/RecruitmentRoutes.ts.
//
// Data model:
//   grievances           — one row per complaint raised by an employee
//                          (optionally anonymous, optionally naming who it's
//                          against), open -> investigating -> resolved/
//                          dismissed.
//   disciplinary_actions — one row per formal action issued to an employee
//                          (verbal/written warning, show-cause, suspension,
//                          termination), tracked through to employee
//                          acknowledgement.
//
// Same convention as ExitOffboardingRoutes.ts: every write route only ever
// does `WHERE id = ?`, filtering happens in JS after a full-table SELECT,
// and every INSERT/UPDATE is all-`?`-placeholders so the in-memory dev
// fallback's generic positional simulator stays correct.

import type { Express } from "express";

interface GrievanceRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (moduleKey: "grievance_disciplinary") => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  getAdminModules: (userId: number) => Promise<string[]>;
}

export async function ensureGrievanceSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS grievances (
        id INT AUTO_INCREMENT PRIMARY KEY,
        raised_by INT NOT NULL,
        against_user_id INT NULL,
        category VARCHAR(100) NULL,
        description TEXT NOT NULL,
        is_anonymous TINYINT(1) NOT NULL DEFAULT 0,
        status ENUM('open', 'investigating', 'resolved', 'dismissed') NOT NULL DEFAULT 'open',
        assigned_to INT NULL,
        resolution_notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        resolved_at TIMESTAMP NULL,
        FOREIGN KEY (raised_by) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (against_user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure grievances table exists: " + err.message);
  }
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS disciplinary_actions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        action_type ENUM('verbal_warning', 'written_warning', 'show_cause', 'suspension', 'termination') NOT NULL,
        reason TEXT NOT NULL,
        document_text TEXT NULL,
        issued_by INT NULL,
        issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        acknowledged TINYINT(1) NOT NULL DEFAULT 0,
        acknowledged_at TIMESTAMP NULL,
        status ENUM('active', 'acknowledged', 'closed') NOT NULL DEFAULT 'active',
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (issued_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure disciplinary_actions table exists: " + err.message);
  }
}

export function registerGrievanceRoutes(app: Express, deps: GrievanceRouteDeps) {
  const { authenticateToken, requireAdmin, requireModule, queryDB, getAdminModules } = deps;
  const adminGate = [authenticateToken, requireAdmin, requireModule("grievance_disciplinary")];

  async function canManage(userId: number, role: string): Promise<boolean> {
    if (role === "superadmin") return true;
    if (role !== "admin" && role !== "user") return false;
    const modules = await getAdminModules(userId);
    return modules.includes("grievance_disciplinary");
  }

  async function serializeGrievance(g: any, userById: Map<number, any>) {
    const anon = !!Number(g.is_anonymous);
    return {
      id: Number(g.id),
      raised_by: anon ? null : Number(g.raised_by),
      raised_by_name: anon ? "Anonymous" : userById.get(Number(g.raised_by))?.name || null,
      against_user_id: g.against_user_id === null || g.against_user_id === undefined ? null : Number(g.against_user_id),
      against_user_name: g.against_user_id ? userById.get(Number(g.against_user_id))?.name || null : null,
      category: g.category,
      description: g.description,
      is_anonymous: anon,
      status: g.status,
      assigned_to: g.assigned_to === null || g.assigned_to === undefined ? null : Number(g.assigned_to),
      assigned_to_name: g.assigned_to ? userById.get(Number(g.assigned_to))?.name || null : null,
      resolution_notes: g.resolution_notes,
      created_at: g.created_at
    };
  }

  // GET: a module-granted account sees every grievance; anyone else only
  // ever sees grievances they themselves raised.
  app.get("/api/grievances", authenticateToken, async (req: any, res: any) => {
    try {
      const manage = await canManage(req.user.id, req.user.role);
      const [rows, users]: [any, any] = await Promise.all([queryDB("SELECT * FROM grievances"), queryDB("SELECT id, name FROM users")]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      const scoped = manage ? rows : rows.filter((g: any) => Number(g.raised_by) === Number(req.user.id));
      const sorted = scoped.sort((a: any, b: any) => Number(b.id) - Number(a.id));
      res.json(await Promise.all(sorted.map((g: any) => serializeGrievance(g, userById))));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST: any authenticated account may raise a grievance for themselves
  // (raised_by is always req.user.id, never trusted from the body).
  app.post("/api/grievances", authenticateToken, async (req: any, res: any) => {
    try {
      const body = req.body || {};
      const description = typeof body.description === "string" ? body.description.trim().slice(0, 4000) : "";
      if (!description) return res.status(400).json({ error: "Description is required." });
      const category = typeof body.category === "string" ? body.category.trim().slice(0, 100) || null : null;
      const againstUserId = body.against_user_id ? Number(body.against_user_id) : null;
      const isAnonymous = !!body.is_anonymous;
      const result: any = await queryDB(
        "INSERT INTO grievances (raised_by, against_user_id, category, description, is_anonymous, status) VALUES (?, ?, ?, ?, ?, ?)",
        [req.user.id, againstUserId, category, description, isAnonymous ? 1 : 0, "open"]
      );
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM grievances WHERE id = ?", [Number(result.insertId)]),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      res.status(201).json(await serializeGrievance(rows[0], userById));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT: assign / change status / resolve — module-gated, a plain reporter
  // can never touch their own grievance's status.
  app.put("/api/grievances/:id", ...adminGate, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const body = req.body || {};
      const existingRows: any = await queryDB("SELECT * FROM grievances WHERE id = ?", [id]);
      if (existingRows.length === 0) return res.status(404).json({ error: "Grievance not found." });
      const existing = existingRows[0];
      const status = ["open", "investigating", "resolved", "dismissed"].includes(body.status) ? body.status : existing.status;
      const assignedTo = body.assigned_to !== undefined ? (body.assigned_to ? Number(body.assigned_to) : null) : existing.assigned_to;
      const resolutionNotes = typeof body.resolution_notes === "string" ? body.resolution_notes.trim().slice(0, 4000) : existing.resolution_notes;
      const isResolving = status === "resolved" || status === "dismissed";
      await queryDB(
        "UPDATE grievances SET status = ?, assigned_to = ?, resolution_notes = ?, resolved_at = ? WHERE id = ?",
        [status, assignedTo, resolutionNotes, isResolving ? new Date() : existing.resolved_at, id]
      );
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM grievances WHERE id = ?", [id]),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      res.json(await serializeGrievance(rows[0], userById));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- Disciplinary Actions ----------
  async function serializeAction(a: any, userById: Map<number, any>) {
    return {
      id: Number(a.id),
      user_id: Number(a.user_id),
      user_name: userById.get(Number(a.user_id))?.name || null,
      action_type: a.action_type,
      reason: a.reason,
      document_text: a.document_text,
      issued_by_name: a.issued_by ? userById.get(Number(a.issued_by))?.name || null : null,
      issued_at: a.issued_at,
      acknowledged: !!Number(a.acknowledged),
      status: a.status
    };
  }

  app.get("/api/disciplinary-actions", authenticateToken, async (req: any, res: any) => {
    try {
      const manage = await canManage(req.user.id, req.user.role);
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM disciplinary_actions"),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      const scoped = manage ? rows : rows.filter((a: any) => Number(a.user_id) === Number(req.user.id));
      const sorted = scoped.sort((a: any, b: any) => Number(b.id) - Number(a.id));
      res.json(await Promise.all(sorted.map((a: any) => serializeAction(a, userById))));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/disciplinary-actions", ...adminGate, async (req: any, res: any) => {
    try {
      const body = req.body || {};
      const userId = Number(body.user_id);
      const actionType = body.action_type;
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 2000) : "";
      if (!userId || !["verbal_warning", "written_warning", "show_cause", "suspension", "termination"].includes(actionType) || !reason) {
        return res.status(400).json({ error: "Employee, action type and reason are required." });
      }
      const documentText = typeof body.document_text === "string" ? body.document_text.trim().slice(0, 4000) || null : null;
      const result: any = await queryDB(
        "INSERT INTO disciplinary_actions (user_id, action_type, reason, document_text, issued_by, acknowledged, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [userId, actionType, reason, documentText, req.user.id, 0, "active"]
      );
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM disciplinary_actions WHERE id = ?", [Number(result.insertId)]),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      res.status(201).json(await serializeAction(rows[0], userById));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT: mark acknowledged (by the employee themself — no module gate on
  // THIS route) or closed (module-gated below via a second check).
  app.put("/api/disciplinary-actions/:id", authenticateToken, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const body = req.body || {};
      const existingRows: any = await queryDB("SELECT * FROM disciplinary_actions WHERE id = ?", [id]);
      if (existingRows.length === 0) return res.status(404).json({ error: "Disciplinary action not found." });
      const existing = existingRows[0];
      const isOwner = Number(existing.user_id) === Number(req.user.id);
      const manage = await canManage(req.user.id, req.user.role);

      if (body.acknowledge) {
        if (!isOwner) return res.status(403).json({ error: "Only the named employee can acknowledge this." });
        await queryDB("UPDATE disciplinary_actions SET acknowledged = ?, acknowledged_at = ?, status = ? WHERE id = ?", [
          1,
          new Date(),
          "acknowledged",
          id
        ]);
      } else if (body.status === "closed") {
        if (!manage) return res.status(403).json({ error: "You don't have access to close this. Ask your Superadmin to grant it." });
        await queryDB("UPDATE disciplinary_actions SET status = ? WHERE id = ?", ["closed", id]);
      } else {
        return res.status(400).json({ error: "Nothing to update." });
      }

      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM disciplinary_actions WHERE id = ?", [id]),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      res.json(await serializeAction(rows[0], userById));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
