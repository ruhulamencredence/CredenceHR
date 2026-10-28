/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Users (the list, the Manage page and Module Access):
//   - the access audit log — every successful change to one account
//     (PUT / DELETE /api/users/:id/...), shown as "Activity" on Manage;
//   - Access Templates — named presets of switches and modules, applied by
//     the client through the normal per-user endpoints;
//   - Block login (Users layer "Block Account") — a blocked account can't
//     sign in and every session it still has ends on its next request.

import type { Express } from "express";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

// The switches a template can turn on: the Manage page's own five
// (feature-permissions) and the Module Access Self Service switches.
export const TEMPLATE_FEATURES = [
  "can_use_attendance",
  "can_use_tracking",
  "can_view_leave_summary",
  "can_edit_delivery_date",
  "can_job_edit",
  "can_view_movement_claims",
  "can_view_conveyance_claims",
  "can_view_timesheet",
  "can_view_leave_application",
  "can_view_my_leave",
  "can_receive_material",
  "can_return_dispatch"
];

export async function ensureUserAccessSchema(dbPool: any) {
  const run = async (what: string, sql: string, ignore: string[] = []) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      if (!ignore.includes(err.code)) console.warn(`⚠️ Users (${what}): ${err.message}`);
    }
  };
  await run(
    "access audit",
    `CREATE TABLE IF NOT EXISTS user_access_audit (
      id INT AUTO_INCREMENT PRIMARY KEY,
      target_user_id INT NOT NULL,
      actor_user_id INT NULL,
      action VARCHAR(64) NOT NULL,
      detail TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_access_audit_target (target_user_id, created_at)
    )`
  );
  await run(
    "access templates",
    `CREATE TABLE IF NOT EXISTS access_templates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description VARCHAR(255) NULL,
      features_json TEXT NULL,
      modules_json TEXT NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`
  );
  for (const [name, def] of [
    ["is_blocked", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["blocked_reason", "VARCHAR(255) NULL"],
    ["blocked_at", "DATETIME NULL"],
    ["blocked_by", "INT NULL"],
    // Credence Assistant switches (Module Access).
    ["can_use_ai_assistant", "TINYINT(1) NOT NULL DEFAULT 1"],
    ["can_export_assistant_reports", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["can_handle_assistant_support", "TINYINT(1) NOT NULL DEFAULT 0"]
  ]) {
    await run(`users.${name}`, `ALTER TABLE users ADD COLUMN ${name} ${def}`, ["ER_DUP_FIELDNAME"]);
  }
}

export type AccountState = "ok" | "blocked" | "removed";
const stateCache = new Map<number, { state: AccountState; at: number }>();
const STATE_TTL_MS = 30_000;

// Whether a signed-in account may still be used (cached briefly).
export async function accountState(queryDB: QueryDB, userId: number): Promise<AccountState> {
  const hit = stateCache.get(userId);
  if (hit && Date.now() - hit.at < STATE_TTL_MS) return hit.state;
  const rows: any[] | null = await queryDB("SELECT id, is_blocked FROM users WHERE id = ?", [userId]).catch(() => null);
  // A database hiccup never signs anyone out.
  if (!rows) return "ok";
  const row = rows.find((r: any) => Number(r.id) === userId);
  const state: AccountState = !row ? "removed" : Number(row.is_blocked || 0) === 1 ? "blocked" : "ok";
  stateCache.set(userId, { state, at: Date.now() });
  return state;
}

interface Deps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (k: any) => any;
  requireModuleLayer: (k: any, layer: any) => any;
  queryDB: QueryDB;
  adminModuleKeys: readonly string[];
}

// Registered before the other /api/users routes, so the audit hook below
// sees every change.
export function registerUserAccessExtras(app: Express, deps: Deps) {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, queryDB, adminModuleKeys } = deps;

  // Who changed what: the endpoint and the request body (passwords never
  // stored), written after the response goes out. "X-Access-Template" marks
  // changes made by applying a template.
  const SECRET_KEYS = new Set(["password", "new_password", "newPassword", "login_password"]);
  app.use("/api/users/:id", (req: any, res: any, next: any) => {
    const targetId = Number(req.params.id);
    if (!["PUT", "DELETE"].includes(req.method) || !Number.isFinite(targetId)) return next();
    const subPath = String(req.path || "/").replace(/^\//, "");
    res.on("finish", () => {
      if (res.statusCode >= 400 || !req.user) return;
      const action = subPath || (req.method === "DELETE" ? "delete" : "update");
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(req.body || {})) if (!SECRET_KEYS.has(k)) body[k] = v;
      const template = typeof req.headers["x-access-template"] === "string" ? req.headers["x-access-template"].slice(0, 100) : null;
      const detail = JSON.stringify(template ? { ...body, _template: template } : body).slice(0, 4000);
      queryDB("INSERT INTO user_access_audit (target_user_id, actor_user_id, action, detail) VALUES (?, ?, ?, ?)", [
        targetId,
        req.user.id,
        action.slice(0, 64),
        detail
      ]).catch((err: any) => console.warn("⚠️ Could not write user access audit: " + err.message));
    });
    next();
  });

  // The "Activity" list on an account's Manage page.
  app.get("/api/users/:id/access-audit", authenticateToken, requireAdmin, requireModule("users"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM user_access_audit WHERE target_user_id = ? ORDER BY id DESC LIMIT 100", [id]),
        queryDB("SELECT id, name FROM users")
      ]);
      const nameById = new Map<number, string>(users.map((u: any) => [Number(u.id), u.name]));
      res.json(
        (rows as any[]).map((r) => {
          let detail: any = null;
          try {
            detail = r.detail ? JSON.parse(r.detail) : null;
          } catch {
            detail = null;
          }
          return {
            id: Number(r.id),
            action: r.action,
            detail,
            actor_name: r.actor_user_id ? nameById.get(Number(r.actor_user_id)) || null : null,
            created_at: r.created_at
          };
        })
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Access Templates.
  const parseTemplateBody = (body: any) => {
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 100) : "";
    if (!name) throw Object.assign(new Error("Template name is required."), { status: 400 });
    const description = typeof body?.description === "string" ? body.description.trim().slice(0, 255) : "";
    const features = (Array.isArray(body?.features) ? body.features : []).filter((f: any) => TEMPLATE_FEATURES.includes(f));
    const modules = (Array.isArray(body?.modules) ? body.modules : []).filter((m: any) => adminModuleKeys.includes(m));
    return { name, description, features, modules };
  };
  const parseList = (v: any) => {
    try {
      const a = JSON.parse(v || "[]");
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  };
  const serialize = (r: any) => ({
    id: Number(r.id),
    name: r.name,
    description: r.description || "",
    features: parseList(r.features_json),
    modules: parseList(r.modules_json)
  });

  app.get("/api/access-templates", authenticateToken, requireAdmin, requireModule("users"), async (_req: any, res) => {
    try {
      const rows: any = await queryDB("SELECT * FROM access_templates");
      res.json((rows as any[]).map(serialize).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/access-templates", authenticateToken, requireAdmin, requireModule("users"), requireModuleLayer("users", "edit_add"), async (req: any, res) => {
    try {
      const t = parseTemplateBody(req.body);
      const result: any = await queryDB(
        "INSERT INTO access_templates (name, description, features_json, modules_json, created_by) VALUES (?, ?, ?, ?, ?)",
        [t.name, t.description, JSON.stringify(t.features), JSON.stringify(t.modules), req.user.id]
      );
      res.json({ id: Number(result.insertId), ...t });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.put("/api/access-templates/:id", authenticateToken, requireAdmin, requireModule("users"), requireModuleLayer("users", "edit_add"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const t = parseTemplateBody(req.body);
      const result: any = await queryDB("UPDATE access_templates SET name = ?, description = ?, features_json = ?, modules_json = ? WHERE id = ?", [
        t.name,
        t.description,
        JSON.stringify(t.features),
        JSON.stringify(t.modules),
        id
      ]);
      if (!result.affectedRows) return res.status(404).json({ error: "Template not found." });
      res.json({ id, ...t });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete("/api/access-templates/:id", authenticateToken, requireAdmin, requireModule("users"), requireModuleLayer("users", "delete_trash"), async (req: any, res) => {
    try {
      await queryDB("DELETE FROM access_templates WHERE id = ?", [Number(req.params.id)]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Block / unblock a login. Body: { blocked: boolean, reason?: string }
  app.put("/api/users/:id/block", authenticateToken, requireAdmin, requireModule("users"), requireModuleLayer("users", "block_account"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const blocked = req.body?.blocked === true;
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (!id) return res.status(400).json({ error: "A valid user id is required." });
      if (id === Number(req.user.id)) return res.status(400).json({ error: "You can't block your own account." });
      const target: any[] = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
      if (!target.length) return res.status(404).json({ error: "User not found" });
      if (target[0].role === "superadmin") return res.status(400).json({ error: "The Superadmin account can't be blocked." });
      // Same rule as deleting: only the Superadmin may act on an Admin account.
      if (target[0].role === "admin" && req.user.role !== "superadmin") {
        return res.status(403).json({ error: "Only the Superadmin can block or unblock an Admin account." });
      }
      if (blocked && !reason) return res.status(400).json({ error: "Write the reason for blocking this account." });
      if (blocked) {
        await queryDB("UPDATE users SET is_blocked = 1, blocked_reason = ?, blocked_at = NOW(), blocked_by = ? WHERE id = ?", [reason.slice(0, 255), req.user.id, id]);
      } else {
        await queryDB("UPDATE users SET is_blocked = 0, blocked_reason = NULL, blocked_at = NULL, blocked_by = NULL WHERE id = ?", [id]);
      }
      stateCache.delete(id);
      res.json({ success: true, is_blocked: blocked });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
