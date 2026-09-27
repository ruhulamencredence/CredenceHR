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
import type { AlertType } from "./Alerts";

interface GrievanceRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (moduleKey: "grievance_disciplinary") => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  getAdminModules: (userId: number) => Promise<string[]>;
  createAlert: (
    queryDB: (sql: string, params?: any[]) => Promise<any>,
    params: { userId: number; type: AlertType; title: string; message: string; relatedType?: string; relatedId?: number }
  ) => Promise<void>;
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
  // Feedback thread on a grievance or disciplinary action. The person a
  // grievance names, the person it's assigned to investigate, and the
  // employee a disciplinary action is issued to each have to give their
  // feedback here; HR can add notes too. role: 'named' | 'assignee' | 'hr'.
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS case_feedback (
        id INT AUTO_INCREMENT PRIMARY KEY,
        case_type VARCHAR(20) NOT NULL,
        case_id INT NOT NULL,
        user_id INT NOT NULL,
        role VARCHAR(20) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_case_feedback_case (case_type, case_id)
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure case_feedback table exists: " + err.message);
  }
}

export function registerGrievanceRoutes(app: Express, deps: GrievanceRouteDeps) {
  const { authenticateToken, requireAdmin, requireModule, queryDB, getAdminModules, createAlert } = deps;
  const adminGate = [authenticateToken, requireAdmin, requireModule("grievance_disciplinary")];

  async function canManage(userId: number, role: string): Promise<boolean> {
    if (role === "superadmin") return true;
    if (role !== "admin" && role !== "user") return false;
    const modules = await getAdminModules(userId);
    return modules.includes("grievance_disciplinary");
  }

  // Never throws — a failed notification mustn't fail the action itself.
  async function notify(userIds: (number | null | undefined)[], type: AlertType, title: string, message: string, relatedType: string, relatedId: number, exceptUserId?: number) {
    const seen = new Set<number>();
    for (const raw of userIds) {
      const uid = Number(raw);
      if (!uid || seen.has(uid) || uid === Number(exceptUserId)) continue;
      seen.add(uid);
      try {
        await createAlert(queryDB, { userId: uid, type, title, message, relatedType, relatedId });
      } catch (err: any) {
        console.warn("⚠️ Could not send grievance/disciplinary alert: " + err.message);
      }
    }
  }

  // HR side: every Superadmin plus anyone holding the
  // 'grievance_disciplinary' module.
  async function hrUserIds(): Promise<number[]> {
    const users: any = await queryDB("SELECT id, name, role FROM users ORDER BY name ASC");
    const out: number[] = [];
    for (const u of users) {
      if (await canManage(Number(u.id), u.role)) out.push(Number(u.id));
    }
    return out;
  }

  async function feedbackFor(caseType: "grievance" | "disciplinary"): Promise<Map<number, any[]>> {
    const rows: any = await queryDB("SELECT * FROM case_feedback");
    const map = new Map<number, any[]>();
    for (const r of rows) {
      if (r.case_type !== caseType) continue;
      const id = Number(r.case_id);
      if (!map.has(id)) map.set(id, []);
      map.get(id)!.push(r);
    }
    for (const list of map.values()) list.sort((a, b) => Number(a.id) - Number(b.id));
    return map;
  }

  const serializeFeedback = (rows: any[], userById: Map<number, any>) =>
    rows.map((f) => ({
      id: Number(f.id),
      user_id: Number(f.user_id),
      user_name: userById.get(Number(f.user_id))?.name || null,
      role: f.role,
      message: f.message,
      created_at: f.created_at
    }));

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

  // Grievance + its feedback thread, trimmed to what this viewer may see:
  // HR and the assignee see every entry; the named person only their own;
  // the person who raised it sees none (only the status/resolution).
  function withGrievanceFeedback(base: any, g: any, feedbackRows: any[], userById: Map<number, any>, viewerId: number, manage: boolean) {
    const isAssignee = Number(g.assigned_to) === Number(viewerId);
    const visible = manage || isAssignee ? feedbackRows : feedbackRows.filter((f) => Number(f.user_id) === Number(viewerId));
    const closed = g.status === "resolved" || g.status === "dismissed";
    const namedGave = !g.against_user_id || feedbackRows.some((f) => f.role === "named" && Number(f.user_id) === Number(g.against_user_id));
    const assigneeGave = !g.assigned_to || feedbackRows.some((f) => f.role === "assignee" && Number(f.user_id) === Number(g.assigned_to));
    return {
      ...base,
      feedback: serializeFeedback(visible, userById),
      feedback_pending: { named: !closed && !namedGave, assignee: !closed && !assigneeGave }
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
      const fb = await feedbackFor("grievance");
      res.json(
        await Promise.all(
          sorted.map(async (g: any) =>
            withGrievanceFeedback(await serializeGrievance(g, userById), g, fb.get(Number(g.id)) || [], userById, req.user.id, manage)
          )
        )
      );
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
      const newId = Number(result.insertId);
      if (againstUserId && againstUserId !== Number(req.user.id)) {
        await notify(
          [againstUserId],
          "grievance",
          "A Grievance Names You — Feedback Required",
          `A grievance${category ? ` (${category})` : ""} has been raised that names you. Open Grievance & Disciplinary to read it and give your feedback.`,
          "grievance",
          newId
        );
      }
      await notify(
        await hrUserIds(),
        "grievance",
        "New Grievance Raised",
        `${isAnonymous ? "An anonymous employee" : req.user.name || "An employee"} raised a grievance${category ? ` (${category})` : ""}.`,
        "grievance",
        newId,
        req.user.id
      );
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM grievances WHERE id = ?", [newId]),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      res.status(201).json(withGrievanceFeedback(await serializeGrievance(rows[0], userById), rows[0], [], userById, req.user.id, false));
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
      const existing = { ...existingRows[0] };
      const status = ["open", "investigating", "resolved", "dismissed"].includes(body.status) ? body.status : existing.status;
      const assignedTo = body.assigned_to !== undefined ? (body.assigned_to ? Number(body.assigned_to) : null) : existing.assigned_to;
      const resolutionNotes = typeof body.resolution_notes === "string" ? body.resolution_notes.trim().slice(0, 4000) : existing.resolution_notes;
      const isResolving = status === "resolved" || status === "dismissed";
      await queryDB(
        "UPDATE grievances SET status = ?, assigned_to = ?, resolution_notes = ?, resolved_at = ? WHERE id = ?",
        [status, assignedTo, resolutionNotes, isResolving ? new Date() : existing.resolved_at, id]
      );
      if (assignedTo && Number(assignedTo) !== Number(existing.assigned_to)) {
        await notify(
          [assignedTo],
          "grievance",
          "Grievance Assigned to You — Feedback Required",
          `${req.user.name || "HR"} assigned you grievance #${id}${existing.category ? ` (${existing.category})` : ""}. Open Grievance & Disciplinary to review it and give your feedback.`,
          "grievance",
          id,
          req.user.id
        );
      }
      if (status !== existing.status) {
        await notify(
          [existing.raised_by],
          "grievance",
          "Your Grievance Was Updated",
          `Your grievance #${id} is now ${status}.${isResolving && resolutionNotes ? ` Notes: ${resolutionNotes}` : ""}`,
          "grievance",
          id,
          req.user.id
        );
        if (isResolving) {
          await notify(
            [existing.against_user_id, assignedTo],
            "grievance",
            "Grievance Closed",
            `Grievance #${id} was marked ${status}.`,
            "grievance",
            id,
            req.user.id
          );
        }
      }
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM grievances WHERE id = ?", [id]),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      const fb = await feedbackFor("grievance");
      res.json(withGrievanceFeedback(await serializeGrievance(rows[0], userById), rows[0], fb.get(id) || [], userById, req.user.id, true));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/grievances/:id/feedback — the named person ('named'), the
  // assigned investigator ('assignee') or HR ('hr') adds feedback. HR and
  // the assignee are notified of the named person's feedback, and so on.
  app.post("/api/grievances/:id/feedback", authenticateToken, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const message = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 4000) : "";
      if (!message) return res.status(400).json({ error: "Write your feedback first." });
      const rows: any = await queryDB("SELECT * FROM grievances WHERE id = ?", [id]);
      const g = rows[0];
      if (!g) return res.status(404).json({ error: "Grievance not found." });
      if (g.status === "resolved" || g.status === "dismissed") return res.status(400).json({ error: "This grievance is already closed." });
      const me = Number(req.user.id);
      const role =
        Number(g.against_user_id) === me ? "named" : Number(g.assigned_to) === me ? "assignee" : (await canManage(me, req.user.role)) ? "hr" : null;
      if (!role) return res.status(403).json({ error: "You aren't part of this grievance." });
      await queryDB("INSERT INTO case_feedback (case_type, case_id, user_id, role, message) VALUES (?, ?, ?, ?, ?)", ["grievance", id, me, role, message]);
      const who = role === "named" ? "The person named" : role === "assignee" ? "The investigator" : "HR";
      await notify(
        [...(await hrUserIds()), g.assigned_to],
        "grievance",
        "Grievance Feedback Received",
        `${who} (${req.user.name || "someone"}) gave feedback on grievance #${id}.`,
        "grievance",
        id,
        me
      );
      res.status(201).json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/grievances/people — names for the "Against (optional)" picker
  // on the self-service Raise Grievance form.
  app.get("/api/grievances/people", authenticateToken, async (req: any, res: any) => {
    try {
      const rows: any = await queryDB("SELECT id, name, role FROM users ORDER BY name ASC");
      res.json(
        rows
          .filter((u: any) => u.role !== "superadmin" && Number(u.id) !== Number(req.user.id))
          .map((u: any) => ({ id: Number(u.id), name: u.name }))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/my-cases — Self Service -> "Grievance & Disciplinary": what
  // this account raised, grievances that name them, grievances assigned to
  // them, and disciplinary actions issued to them — each with the feedback
  // they're allowed to see and whether their own feedback is still owed.
  app.get("/api/my-cases", authenticateToken, async (req: any, res: any) => {
    try {
      const me = Number(req.user.id);
      const [grievances, actions, users]: [any, any, any] = await Promise.all([
        queryDB("SELECT * FROM grievances"),
        queryDB("SELECT * FROM disciplinary_actions"),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      const gfb = await feedbackFor("grievance");
      const dfb = await feedbackFor("disciplinary");
      const byNewest = (a: any, b: any) => Number(b.id) - Number(a.id);
      const shapeG = async (g: any) => {
        const base = withGrievanceFeedback(await serializeGrievance(g, userById), g, gfb.get(Number(g.id)) || [], userById, me, false);
        // The named person never sees who raised it.
        if (Number(g.against_user_id) === me && Number(g.raised_by) !== me) return { ...base, raised_by: null, raised_by_name: "Confidential" };
        return base;
      };
      res.json({
        raised: await Promise.all(grievances.filter((g: any) => Number(g.raised_by) === me).sort(byNewest).map(shapeG)),
        named: await Promise.all(grievances.filter((g: any) => Number(g.against_user_id) === me && Number(g.raised_by) !== me).sort(byNewest).map(shapeG)),
        assigned: await Promise.all(grievances.filter((g: any) => Number(g.assigned_to) === me).sort(byNewest).map(shapeG)),
        disciplinary: await Promise.all(
          actions
            .filter((a: any) => Number(a.user_id) === me)
            .sort(byNewest)
            .map(async (a: any) => {
              const fb = dfb.get(Number(a.id)) || [];
              return {
                ...(await serializeAction(a, userById)),
                feedback: serializeFeedback(fb, userById),
                feedback_pending: a.status !== "closed" && !fb.some((f: any) => f.role === "named")
              };
            })
        )
      });
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
      const fb = await feedbackFor("disciplinary");
      res.json(
        await Promise.all(
          sorted.map(async (a: any) => {
            const list = fb.get(Number(a.id)) || [];
            return {
              ...(await serializeAction(a, userById)),
              feedback: serializeFeedback(list, userById),
              feedback_pending: a.status !== "closed" && !list.some((f: any) => f.role === "named")
            };
          })
        )
      );
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
      const LABEL: Record<string, string> = {
        verbal_warning: "Verbal Warning",
        written_warning: "Written Warning",
        show_cause: "Show Cause",
        suspension: "Suspension",
        termination: "Termination"
      };
      await notify(
        [userId],
        "disciplinary",
        `${LABEL[actionType]} Issued — Feedback Required`,
        `${req.user.name || "HR"} issued you a ${LABEL[actionType]}: ${reason}. Open Grievance & Disciplinary to give your feedback and acknowledge it.`,
        "disciplinary_action",
        Number(result.insertId),
        req.user.id
      );
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM disciplinary_actions WHERE id = ?", [Number(result.insertId)]),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      res.status(201).json({ ...(await serializeAction(rows[0], userById)), feedback: [], feedback_pending: true });
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
      const existing = { ...existingRows[0] };
      const isOwner = Number(existing.user_id) === Number(req.user.id);
      const manage = await canManage(req.user.id, req.user.role);

      if (body.acknowledge) {
        if (!isOwner) return res.status(403).json({ error: "Only the named employee can acknowledge this." });
        const fbRows: any = await queryDB("SELECT * FROM case_feedback");
        const gave = fbRows.some((f: any) => f.case_type === "disciplinary" && Number(f.case_id) === id && Number(f.user_id) === Number(req.user.id));
        if (!gave) return res.status(400).json({ error: "Give your feedback before acknowledging." });
        await queryDB("UPDATE disciplinary_actions SET acknowledged = ?, acknowledged_at = ?, status = ? WHERE id = ?", [
          1,
          new Date(),
          "acknowledged",
          id
        ]);
      } else if (body.status === "closed") {
        if (!manage) return res.status(403).json({ error: "You don't have access to close this. Ask your Superadmin to grant it." });
        await queryDB("UPDATE disciplinary_actions SET status = ? WHERE id = ?", ["closed", id]);
        await notify([existing.user_id], "disciplinary", "Disciplinary Action Closed", `${req.user.name || "HR"} closed the disciplinary action issued to you.`, "disciplinary_action", id, req.user.id);
      } else {
        return res.status(400).json({ error: "Nothing to update." });
      }

      if (body.acknowledge) {
        await notify(
          [existing.issued_by, ...(await hrUserIds())],
          "disciplinary",
          "Disciplinary Action Acknowledged",
          `${req.user.name || "The employee"} acknowledged the disciplinary action issued to them.`,
          "disciplinary_action",
          id,
          req.user.id
        );
      }
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM disciplinary_actions WHERE id = ?", [id]),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      const fb = (await feedbackFor("disciplinary")).get(id) || [];
      res.json({ ...(await serializeAction(rows[0], userById)), feedback: serializeFeedback(fb, userById), feedback_pending: rows[0].status !== "closed" && !fb.some((f: any) => f.role === "named") });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/disciplinary-actions/:id/feedback — the employee's reply
  // (required before Acknowledge), or an HR note. Notifies the issuer + HR.
  app.post("/api/disciplinary-actions/:id/feedback", authenticateToken, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const message = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 4000) : "";
      if (!message) return res.status(400).json({ error: "Write your feedback first." });
      const rows: any = await queryDB("SELECT * FROM disciplinary_actions WHERE id = ?", [id]);
      const a = rows[0];
      if (!a) return res.status(404).json({ error: "Disciplinary action not found." });
      if (a.status === "closed") return res.status(400).json({ error: "This action is already closed." });
      const me = Number(req.user.id);
      const role = Number(a.user_id) === me ? "named" : (await canManage(me, req.user.role)) ? "hr" : null;
      if (!role) return res.status(403).json({ error: "You aren't part of this disciplinary action." });
      await queryDB("INSERT INTO case_feedback (case_type, case_id, user_id, role, message) VALUES (?, ?, ?, ?, ?)", ["disciplinary", id, me, role, message]);
      if (role === "named") {
        await notify(
          [a.issued_by, ...(await hrUserIds())],
          "disciplinary",
          "Disciplinary Feedback Received",
          `${req.user.name || "The employee"} gave feedback on the disciplinary action issued to them.`,
          "disciplinary_action",
          id,
          me
        );
      } else {
        await notify([a.user_id], "disciplinary", "HR Replied on Your Disciplinary Action", `${req.user.name || "HR"}: ${message}`, "disciplinary_action", id, me);
      }
      res.status(201).json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
