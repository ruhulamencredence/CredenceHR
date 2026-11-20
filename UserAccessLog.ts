/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Login & Access log: who changed what on a login, and when — HR Operations
// -> Service Book -> "Login & Access" (EmployeeActivityRoutes.ts).
//
// Nothing in the routes that change a login was touched for this. One
// middleware (userAccessLogMiddleware, mounted before the routes) looks at
// every change request to /api/users/:id/... — Block, Mobile App, Projects,
// Module Access, permission layers, Self Service switches, password reset,
// e-mail / Login ID, role… — takes a picture of the login before the route
// runs and again once it has answered OK, and writes down only what is
// different. A request that fails (any answer that isn't 2xx) writes
// nothing. A new login (POST /api/users) is written as "Login created".
// Changes made by the app itself, not through those routes (a Transfer
// moving PEPM projects and the Check-in place), call logUserAccess directly.
//
// The log only ever adds rows, never stops a request: every step is caught.
// It starts the day this ships; earlier changes were never recorded.

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export interface AccessChange {
  what: string;
  from?: string | null;
  to?: string | null;
  added?: string[];
  removed?: string[];
}

export async function ensureUserAccessLogSchema(queryDB: QueryDB): Promise<void> {
  try {
    await queryDB(`/*unscoped*/ CREATE TABLE IF NOT EXISTS user_access_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      employee_id INT NULL,
      actor_id INT NULL,
      actor_name VARCHAR(150) NULL,
      source VARCHAR(40) NOT NULL DEFAULT 'users',
      action VARCHAR(120) NOT NULL,
      changes_json TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ual_user (user_id, created_at),
      INDEX idx_ual_employee (employee_id, created_at)
    )`);
  } catch (err: any) {
    console.warn("⚠️ Login & Access log table: " + err.message);
  }
}

export async function logUserAccess(
  queryDB: QueryDB,
  entry: { userId: number; actorId?: number | null; actorName?: string | null; source?: string; action: string; changes: AccessChange[] }
): Promise<void> {
  try {
    if (!entry.userId || !entry.changes.length) return;
    const emp: any[] = (await queryDB("/*unscoped*/ SELECT id FROM all_employees WHERE user_id = ? LIMIT 1", [entry.userId]).catch(() => [])) || [];
    let actorName = entry.actorName ?? null;
    if (!actorName && entry.actorId) {
      const a: any[] = (await queryDB("/*unscoped*/ SELECT COALESCE(e.name, u.name) AS name FROM users u LEFT JOIN all_employees e ON e.user_id = u.id WHERE u.id = ? LIMIT 1", [entry.actorId]).catch(() => [])) || [];
      actorName = a[0]?.name || null;
    }
    await queryDB(
      "/*unscoped*/ INSERT INTO user_access_log (user_id, employee_id, actor_id, actor_name, source, action, changes_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [entry.userId, emp[0]?.id ?? null, entry.actorId ?? null, actorName ? String(actorName).slice(0, 150) : null, (entry.source || "users").slice(0, 40), entry.action.slice(0, 120), JSON.stringify(entry.changes).slice(0, 60000)]
    );
  } catch (err: any) {
    console.warn("⚠️ Login & Access log: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// A picture of one login: its own settings and the lists that hang off it.
// ---------------------------------------------------------------------------

// Columns that change on their own (sign-in, tutorials…) or must never be
// written anywhere (the password hash — only "changed" is recorded).
const SKIP_COLUMNS = new Set([
  "id", "created_at", "updated_at", "last_login_lat", "last_login_lng", "last_login_at", "welcome_seen_at", "tutorials_done",
  "sessions_valid_after", "chat_about", "blocked_at", "blocked_by", "onboarding_expires_at"
]);
const LABELS: Record<string, string> = {
  password_hash: "Password",
  must_change_password: "Must change password",
  is_blocked: "Login blocked",
  blocked_reason: "Block reason",
  can_use_app: "Mobile App",
  app_access_custom: "Mobile App: own list",
  role: "Role",
  email: "E-mail",
  username: "Login ID",
  name: "Name",
  attendance_project_id: "Attendance project",
  attendance_projects_by_branch: "Check-in by Branch",
  max_devices: "Devices allowed",
  can_work_all_companies: "Works in all companies",
  can_view_group_directory: "Whole-group Directory",
  non_employee_reason: "Login without an employee (reason)"
};
export const columnLabel = (col: string) =>
  LABELS[col] ||
  col
    .replace(/^can_(view_|use_)?/, "")
    .split("_")
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");

const isFlag = (col: string) => /^can_|^is_|_custom$|must_change_password|attendance_projects_by_branch/.test(col);

interface Snapshot {
  row: Record<string, any> | null;
  lists: Record<string, Set<string>>;
}

async function listOf(queryDB: QueryDB, sql: string, userId: number): Promise<Set<string>> {
  const rows: any[] = (await queryDB(sql, [userId]).catch(() => [])) || [];
  return new Set(rows.map((r) => String(r.v ?? "")).filter(Boolean));
}

async function snapshot(queryDB: QueryDB, userId: number): Promise<Snapshot> {
  const rows: any[] = (await queryDB("/*unscoped*/ SELECT * FROM users WHERE id = ?", [userId]).catch(() => [])) || [];
  const [projects, attendance, modules, layers, app] = await Promise.all([
    listOf(queryDB, "/*unscoped*/ SELECT COALESCE(p.project_name, CONCAT('Project #', x.project_id)) AS v FROM user_project_permissions x LEFT JOIN projects p ON p.id = x.project_id WHERE x.user_id = ?", userId),
    listOf(
      queryDB,
      "/*unscoped*/ SELECT CONCAT(COALESCE(p.project_name, CONCAT('Project #', x.project_id)), IF(x.valid_to IS NULL, '', CONCAT(' (until ', DATE_FORMAT(x.valid_to, '%Y-%m-%d'), ')'))) AS v FROM user_attendance_projects x LEFT JOIN projects p ON p.id = x.project_id WHERE x.user_id = ?",
      userId
    ),
    listOf(queryDB, "/*unscoped*/ SELECT DISTINCT module_key AS v FROM admin_module_permissions WHERE user_id = ?", userId),
    listOf(queryDB, "/*unscoped*/ SELECT DISTINCT CONCAT(module_key, ': ', layer_key) AS v FROM admin_module_permission_layers WHERE user_id = ?", userId),
    listOf(queryDB, "/*unscoped*/ SELECT DISTINCT item_key AS v FROM user_app_access WHERE user_id = ?", userId)
  ]);
  return {
    row: rows[0] || null,
    lists: { "PEPM projects": projects, "Check-in places": attendance, "Module access": modules, "Permission layers": layers, "Mobile App items": app }
  };
}

const show = (col: string, v: any): string | null => {
  if (v == null || v === "") return null;
  if (isFlag(col)) return Number(v) ? "On" : "Off";
  return String(v).slice(0, 200);
};

export function diffSnapshots(before: Snapshot, after: Snapshot): AccessChange[] {
  const out: AccessChange[] = [];
  const a = before.row || {};
  const b = after.row || {};
  for (const col of Object.keys(b)) {
    if (SKIP_COLUMNS.has(col)) continue;
    const x = a[col];
    const y = b[col];
    if (String(x ?? "") === String(y ?? "")) continue;
    if (col === "password_hash") {
      out.push({ what: "Password", to: "Reset" });
      continue;
    }
    if (col === "is_blocked") {
      out.push({ what: "Login", from: Number(x) ? "Blocked" : "Open", to: Number(y) ? "Blocked" : "Open" });
      continue;
    }
    out.push({ what: columnLabel(col), from: show(col, x), to: show(col, y) });
  }
  for (const [what, now] of Object.entries(after.lists)) {
    const was = before.lists[what] || new Set<string>();
    const added = [...now].filter((v) => !was.has(v)).sort();
    const removed = [...was].filter((v) => !now.has(v)).sort();
    if (added.length || removed.length) out.push({ what, added, removed });
  }
  return out;
}

// The page's own name for a route ("/api/users/12/tasks-access" -> "Tasks access").
const ACTIONS: Record<string, string> = {
  "": "Login details",
  block: "Block / Unblock",
  "app-access": "Mobile App",
  projects: "Project Access",
  "attendance-projects": "Check-in places",
  "module-permissions": "Module Access",
  "module-permission-layers": "Permission layers",
  "reset-password": "Password reset",
  "feature-permissions": "Feature permissions",
  role: "Role",
  email: "E-mail",
  username: "Login ID"
};
const actionOf = (sub: string) =>
  ACTIONS[sub] ||
  sub
    .split("-")
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");

const USER_PATH = /^\/api\/users\/(\d+)(?:\/([a-z0-9-]+))?\/?$/i;

export function userAccessLogMiddleware(queryDB: QueryDB) {
  return (req: any, res: any, next: any) => {
    try {
      const method = String(req.method || "").toUpperCase();
      if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
      const path = String(req.path || "");
      if (!path.startsWith("/api/users")) return next();
      if (!req.headers?.authorization) return next();

      // A new login.
      if (method === "POST" && /^\/api\/users\/?$/.test(path)) {
        const send = res.json.bind(res);
        res.json = (body: any) => {
          try {
            if (res.statusCode < 300 && body?.id) {
              void logUserAccess(queryDB, {
                userId: Number(body.id),
                actorId: req.user?.id ? Number(req.user.id) : null,
                action: "Login created",
                changes: [{ what: "Login", to: `Created · ${body.role || "user"}${body.username ? ` · ${body.username}` : ""}` }]
              });
            }
          } catch {
            // the answer still goes out
          }
          return send(body);
        };
        return next();
      }

      const m = USER_PATH.exec(path);
      if (!m) return next();
      if (method === "DELETE" && !m[2]) return next(); // the login itself is going away
      const userId = Number(m[1]);
      const sub = String(m[2] || "").toLowerCase();
      const before: Promise<Snapshot | null> = snapshot(queryDB, userId).catch(() => null);
      let started = false;
      // The route runs only once the picture is taken, so "before" is really before.
      before.then(
        () => {
          started = true;
          next();
        },
        () => {
          started = true;
          next();
        }
      );
      res.on("finish", () => {
        if (!started || res.statusCode < 200 || res.statusCode >= 300 || !req.user) return;
        void (async () => {
          try {
            const was = await before;
            if (!was?.row) return;
            const now = await snapshot(queryDB, userId);
            const changes = diffSnapshots(was, now);
            if (!changes.length) return;
            await logUserAccess(queryDB, { userId, actorId: Number(req.user.id), action: actionOf(sub), changes });
          } catch {
            // never in the way of the request
          }
        })();
      });
    } catch {
      next();
    }
  };
}
