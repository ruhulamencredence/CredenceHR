/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Remote Attendance: the Projects one account may check in at.
//
// user_attendance_projects holds one row per (account, Project), each with an
// optional valid_from / valid_to (a temporary site, e.g. two weeks at Savar).
// Rules:
//  - no rows at all for an account  -> not restricted ("Any project"), the
//    account's usual Project access applies (AttendanceRoutes.ts);
//  - any rows                       -> only the Projects whose dates cover
//    the day. Rows that have run out stay listed (greyed in Module Access) but
//    no longer count, so an account whose only Project has ended can't check
//    in anywhere until an Admin adds one or clears the list.
// A Superadmin is never restricted.
//
// It replaces the single users.attendance_project_id ("Allowed project for
// check-in"): that value is copied into this table once at start-up and the
// column is no longer read for the rule. The feature-permissions endpoint
// still accepts attendance_project_id from an older screen and turns it into
// a one-row list.

import type { Express } from "express";
import { getStartupMarker, setStartupMarker } from "./startupOnce";

type Query = (sql: string, params?: any[]) => Promise<any>;

export interface AttendanceProjectRow {
  project_id: number;
  project_name: string;
  valid_from: string | null;
  valid_to: string | null;
  active: boolean;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ymdOrNull = (v: any): string | null => {
  const s = v == null ? "" : String(v).slice(0, 10);
  return YMD.test(s) ? s : null;
};

export async function ensureAttendanceProjectsSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  await dbPool.query(`CREATE TABLE IF NOT EXISTS user_attendance_projects (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    project_id INT NOT NULL,
    valid_from DATE NULL,
    valid_to DATE NULL,
    created_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_user_attendance_project (user_id, project_id),
    INDEX idx_uap_project (project_id),
    CONSTRAINT fk_uap_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_uap_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  )`);
  // Once: the old single "Allowed project for check-in" becomes a one-row list.
  if (!(await getStartupMarker(dbPool, "attendance_projects_from_pin"))) {
    await dbPool.query(
      `INSERT IGNORE INTO user_attendance_projects (user_id, project_id)
       SELECT u.id, u.attendance_project_id FROM users u
       JOIN projects p ON p.id = u.attendance_project_id
       WHERE u.attendance_project_id IS NOT NULL AND u.role <> 'superadmin'`
    );
    await setStartupMarker(dbPool, "attendance_projects_from_pin");
  }
}

// Every listed Project of one account, with whether it counts on `ymd`.
export async function listAttendanceProjects(queryDB: Query, userId: number, ymd: string): Promise<AttendanceProjectRow[]> {
  const rows: any[] = await queryDB(
    `SELECT a.project_id, p.project_name,
            DATE_FORMAT(a.valid_from, '%Y-%m-%d') AS valid_from,
            DATE_FORMAT(a.valid_to, '%Y-%m-%d') AS valid_to
     FROM user_attendance_projects a JOIN projects p ON p.id = a.project_id
     WHERE a.user_id = ? ORDER BY p.project_name`,
    [userId]
  ).catch(() => []);
  return (rows || []).map((r: any) => ({
    project_id: Number(r.project_id),
    project_name: String(r.project_name || ""),
    valid_from: r.valid_from || null,
    valid_to: r.valid_to || null,
    active: (!r.valid_from || r.valid_from <= ymd) && (!r.valid_to || r.valid_to >= ymd)
  }));
}

// The Projects an account is limited to on `ymd`, or null when it isn't
// limited (no list, or a Superadmin).
export async function restrictedAttendanceProjects(queryDB: Query, userId: number, role: string, ymd: string): Promise<Set<number> | null> {
  if (role === "superadmin") return null;
  const rows = await listAttendanceProjects(queryDB, userId, ymd);
  if (!rows.length) return null;
  return new Set(rows.filter((r) => r.active).map((r) => r.project_id));
}

interface Deps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (key: any) => any;
  requireModuleLayer: (key: any, layer: string) => any;
  queryDB: Query;
  todayInDhaka: () => string;
}

// Checks that the caller may change this account's list — same guard as
// PUT /api/users/:id/feature-permissions (UserManagement.ts): an Admin can't
// reach the Superadmin or another Admin. Sends the error itself.
async function guardTarget(queryDB: Query, req: any, res: any, userId: number): Promise<any | null> {
  const rows: any[] = await queryDB("SELECT id, role FROM users WHERE id = ?", [userId]);
  if (!rows.length || (rows[0].role === "superadmin" && req.user.role !== "superadmin")) {
    res.status(404).json({ error: "User not found" });
    return null;
  }
  if (rows[0].role === "admin" && req.user.role !== "superadmin") {
    res.status(403).json({ error: "Only the Superadmin can change another Admin's permissions." });
    return null;
  }
  if (rows[0].role === "superadmin") {
    res.status(400).json({ error: "A Superadmin can check in at any project." });
    return null;
  }
  return rows[0];
}

// [{ project_id, valid_from?, valid_to? }] -> checked rows, or an error text.
async function cleanList(queryDB: Query, input: any): Promise<{ rows: { project_id: number; valid_from: string | null; valid_to: string | null }[] } | { error: string }> {
  if (!Array.isArray(input)) return { error: "projects must be a list." };
  const out = new Map<number, { project_id: number; valid_from: string | null; valid_to: string | null }>();
  for (const raw of input) {
    const id = Number(raw?.project_id);
    if (!Number.isInteger(id) || id <= 0) return { error: "Each project needs a valid project_id." };
    const from = ymdOrNull(raw?.valid_from);
    const to = ymdOrNull(raw?.valid_to);
    if ((raw?.valid_from && !from) || (raw?.valid_to && !to)) return { error: "Dates must be YYYY-MM-DD." };
    if (from && to && to < from) return { error: "A project's To date can't be before its From date." };
    out.set(id, { project_id: id, valid_from: from, valid_to: to });
  }
  if (out.size > 200) return { error: "Too many projects." };
  if (out.size) {
    const ids = [...out.keys()];
    const found: any[] = await queryDB(`SELECT id FROM projects WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    if (found.length !== ids.length) return { error: "One of the projects no longer exists." };
  }
  return { rows: [...out.values()] };
}

async function replaceList(queryDB: Query, userId: number, rows: { project_id: number; valid_from: string | null; valid_to: string | null }[], by: number) {
  await queryDB("DELETE FROM user_attendance_projects WHERE user_id = ?", [userId]);
  for (const r of rows) {
    await queryDB(
      "INSERT INTO user_attendance_projects (user_id, project_id, valid_from, valid_to, created_by) VALUES (?, ?, ?, ?, ?)",
      [userId, r.project_id, r.valid_from, r.valid_to, by]
    );
  }
  // The old single-project column follows along so nothing still reading it
  // can see a stale pin: the only Project when there's exactly one, else none.
  await queryDB("UPDATE users SET attendance_project_id = ? WHERE id = ?", [rows.length === 1 ? rows[0].project_id : null, userId]).catch(() => {});
}

export function registerAttendanceProjectRoutes(app: Express, deps: Deps): { replaceAttendanceProjects: typeof replaceList } {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, queryDB, todayInDhaka } = deps;
  const gate = [authenticateToken, requireAdmin, requireModule("users")];

  // One account's list (Module Access -> Remote Attendance).
  app.get("/api/users/:id(\\d+)/attendance-projects", ...gate, async (req: any, res) => {
    try {
      const target = await guardTarget(queryDB, req, res, Number(req.params.id));
      if (!target) return;
      res.json({ today: todayInDhaka(), projects: await listAttendanceProjects(queryDB, Number(req.params.id), todayInDhaka()) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Replace one account's list ([] = any project again).
  app.put("/api/users/:id(\\d+)/attendance-projects", ...gate, requireModuleLayer("users", "edit_add"), async (req: any, res) => {
    try {
      const userId = Number(req.params.id);
      const target = await guardTarget(queryDB, req, res, userId);
      if (!target) return;
      const clean = await cleanList(queryDB, req.body?.projects);
      if ("error" in clean) return res.status(400).json({ error: clean.error });
      await replaceList(queryDB, userId, clean.rows, Number(req.user.id));
      res.json({ today: todayInDhaka(), projects: await listAttendanceProjects(queryDB, userId, todayInDhaka()) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Several accounts at once: add these projects, remove them, or make them
  // the whole list. Accounts the caller may not change are skipped and named.
  app.put("/api/users/attendance-projects/bulk", ...gate, requireModuleLayer("users", "edit_add"), async (req: any, res) => {
    try {
      const mode = req.body?.mode === "remove" ? "remove" : req.body?.mode === "replace" ? "replace" : "add";
      const ids = Array.isArray(req.body?.user_ids) ? [...new Set(req.body.user_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0))] : [];
      if (!ids.length) return res.status(400).json({ error: "Pick at least one person." });
      if (ids.length > 1000) return res.status(400).json({ error: "Too many people at once." });
      const clean = await cleanList(queryDB, req.body?.projects);
      if ("error" in clean) return res.status(400).json({ error: clean.error });
      if (mode !== "replace" && !clean.rows.length) return res.status(400).json({ error: "Pick at least one project." });
      const users: any[] = await queryDB(`SELECT id, name, role FROM users WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
      let changed = 0;
      const skipped: string[] = [];
      for (const u of users) {
        if (u.role === "superadmin" || (u.role === "admin" && req.user.role !== "superadmin")) {
          skipped.push(String(u.name));
          continue;
        }
        const current = await listAttendanceProjects(queryDB, Number(u.id), todayInDhaka());
        const map = new Map(current.map((r) => [r.project_id, { project_id: r.project_id, valid_from: r.valid_from, valid_to: r.valid_to }]));
        if (mode === "replace") map.clear();
        for (const r of clean.rows) {
          if (mode === "remove") map.delete(r.project_id);
          else map.set(r.project_id, r);
        }
        await replaceList(queryDB, Number(u.id), [...map.values()], Number(req.user.id));
        changed++;
      }
      res.json({ changed, skipped });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return { replaceAttendanceProjects: replaceList };
}
