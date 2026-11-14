/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Monthly Attendance Report -> tap a day -> "Edit attendance": HR gives or
// corrects someone's In / Out for a day, with a reason (required). Needs the
// Attendance Reports module and its "Edit attendance" layer (explicit-only).
//
// The time is written where every count already reads attendance from — the
// day's Remote Attendance row (`attendance`, the same table an approved
// Timesheet correction writes; finalizeAttendanceCorrection in server.ts) —
// so the Monthly / Daily report, Department Summary, Timesheet and Payroll all
// see it. The office machine's punches are never touched: as everywhere, the
// day's In is the earlier of the two and its Out the later. The reason goes
// on the row ("HR edit: …") and every edit is kept in attendance_admin_edits
// with what the day had before. A salary month already Processed / Paid can't
// be edited (closedPayMonthFor), same as corrections.

import type { Express } from "express";
import { closedPayMonthFor, closedPayMonthMessage } from "./PayrollRoutes";

type Query = (sql: string, params?: any[]) => Promise<any>;

interface Deps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (key: any) => any;
  requireModuleLayer: (key: any, layer: string) => any;
  queryDB: Query;
  todayInDhaka: () => string;
}

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Who is edited: their Employee record when this account can see it. A
// login with no Employee record at all (it still shows on the report) is
// fine; one whose record is outside this account's Department scope is not.
async function target(queryDB: Query, userId: number): Promise<{ name: string; employee_code: string | null } | null> {
  const emp: any = ((await queryDB("SELECT name, employee_id FROM all_employees WHERE user_id = ? LIMIT 1", [userId])) as any[])[0];
  if (emp) return { name: emp.name, employee_code: emp.employee_id || null };
  const anyEmp: any[] = (await queryDB("/*unscoped*/ SELECT id FROM all_employees WHERE user_id = ? LIMIT 1", [userId])) || [];
  if (anyEmp.length) return null;
  const u: any = ((await queryDB("SELECT name, role FROM users WHERE id = ?", [userId])) as any[])[0];
  return u && u.role !== "superadmin" ? { name: u.name, employee_code: null } : null;
}
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);

export async function ensureAttendanceAdminEditSchema(dbPool: any): Promise<void> {
  try {
    await dbPool.query(
      `CREATE TABLE IF NOT EXISTS attendance_admin_edits (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        attendance_date DATE NOT NULL,
        attendance_id INT NULL,
        project_id INT NULL,
        old_check_in_at DATETIME NULL,
        old_check_out_at DATETIME NULL,
        new_check_in_at DATETIME NULL,
        new_check_out_at DATETIME NULL,
        remarks VARCHAR(500) NOT NULL,
        edited_by INT NULL,
        edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_att_admin_edits_user_date (user_id, attendance_date)
      )`
    );
  } catch (err: any) {
    console.warn("⚠️ Could not ensure attendance_admin_edits: " + err.message);
  }
}

export function registerAttendanceAdminEditRoutes(app: Express, deps: Deps) {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, queryDB, todayInDhaka } = deps;
  const gate = [authenticateToken, requireAdmin, requireModule("attendance_reports"), requireModuleLayer("attendance_reports", "attendance_edit")];

  // What the day has now + the Projects to pick from + earlier HR edits.
  app.get("/api/attendance/admin-edit", ...gate, async (req: any, res: any) => {
    try {
      const userId = Number(req.query.user_id);
      const date = String(req.query.date || "");
      if (!userId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Pick a person and a day." });
      // Inside this account's Department / company scope (strict query scope).
      const emp = await target(queryDB, userId);
      if (!emp) return res.status(403).json({ error: "This person isn't in the employees you can see." });
      const [rows, projects, edits, allowed]: any[] = await Promise.all([
        queryDB("SELECT a.id, a.project_id, a.check_in_at, a.check_out_at, p.project_name FROM attendance a LEFT JOIN projects p ON p.id = a.project_id WHERE a.user_id = ? AND a.attendance_date = ? ORDER BY a.id", [userId, date]),
        queryDB("SELECT id, project_name FROM projects ORDER BY project_name"),
        queryDB(
          "SELECT e.*, u.name AS edited_by_name FROM attendance_admin_edits e LEFT JOIN users u ON u.id = e.edited_by WHERE e.user_id = ? AND e.attendance_date = ? ORDER BY e.id DESC",
          [userId, date]
        ).catch(() => []),
        queryDB("SELECT project_id FROM user_attendance_projects WHERE user_id = ?", [userId]).catch(() => [])
      ]);
      const closed = await closedPayMonthFor(userId, date);
      res.json({
        employee: emp,
        rows: rows || [],
        projects: projects || [],
        // Their own check-in Project(s), to pick first.
        suggested_project_id: rows?.[0]?.project_id ?? allowed?.[0]?.project_id ?? null,
        closed: closed ? closedPayMonthMessage(closed) : null,
        edits: (edits || []).map((e: any) => ({
          old_in: e.old_check_in_at,
          old_out: e.old_check_out_at,
          new_in: e.new_check_in_at,
          new_out: e.new_check_out_at,
          remarks: e.remarks,
          by: e.edited_by_name || null,
          at: e.edited_at
        }))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // { user_id, date, check_in "HH:MM" | null, check_out "HH:MM" | null,
  //   out_next_day?, project_id? (needed when the day has no row), remarks }
  app.post("/api/attendance/admin-edit", ...gate, async (req: any, res: any) => {
    try {
      const b = req.body || {};
      const userId = Number(b.user_id);
      const date = String(b.date || "");
      const remarks = typeof b.remarks === "string" ? b.remarks.trim().slice(0, 500) : "";
      if (!userId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Pick a person and a day." });
      if (date > todayInDhaka()) return res.status(400).json({ error: "Can't give attendance for a future day." });
      if (!remarks) return res.status(400).json({ error: "Write the reason (remarks)." });
      const inHm = b.check_in ? String(b.check_in) : null;
      const outHm = b.check_out ? String(b.check_out) : null;
      if ((inHm && !HM.test(inHm)) || (outHm && !HM.test(outHm))) return res.status(400).json({ error: "Times must be HH:MM." });
      if (!inHm && !outHm) return res.status(400).json({ error: "Give an In time, an Out time or both." });
      if (!(await target(queryDB, userId))) return res.status(403).json({ error: "This person isn't in the employees you can see." });
      const closed = await closedPayMonthFor(userId, date);
      if (closed) return res.status(400).json({ error: closedPayMonthMessage(closed) });

      const outNext = !!b.out_next_day || (!!inHm && !!outHm && outHm < inHm);
      const inAt = inHm ? `${date} ${inHm}:00` : null;
      const outAt = outHm ? `${outNext ? nextDay(date) : date} ${outHm}:00` : null;
      const rows: any[] = (await queryDB("SELECT * FROM attendance WHERE user_id = ? AND attendance_date = ? ORDER BY id", [userId, date])) || [];
      const row = rows[0] || null;
      const note = `HR edit: ${remarks}`.slice(0, 1000);
      let attendanceId: number;
      let projectId: number;
      if (row) {
        attendanceId = Number(row.id);
        projectId = Number(row.project_id);
        if (inAt && row.check_out_at && !outAt && new Date(String(row.check_out_at).replace(" ", "T")).getTime() <= new Date(inAt.replace(" ", "T")).getTime())
          return res.status(400).json({ error: "The In time is after the day's Out time." });
        await queryDB(
          `UPDATE attendance SET
             check_in_at = COALESCE(?, check_in_at), check_out_at = COALESCE(?, check_out_at),
             check_in_remarks = CASE WHEN ? IS NOT NULL THEN ? ELSE check_in_remarks END,
             check_out_remarks = CASE WHEN ? IS NOT NULL THEN ? ELSE check_out_remarks END
           WHERE id = ?`,
          [inAt, outAt, inAt, note, outAt, note, attendanceId]
        );
      } else {
        projectId = Number(b.project_id);
        if (!projectId) return res.status(400).json({ error: "Pick the Project for this day." });
        const p: any[] = (await queryDB("SELECT id FROM projects WHERE id = ?", [projectId])) || [];
        if (!p.length) return res.status(400).json({ error: "That Project no longer exists." });
        if (!inAt) return res.status(400).json({ error: "A day with no attendance needs an In time." });
        const ins: any = await queryDB(
          "INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at, check_out_at, check_in_remarks, check_out_remarks) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [userId, projectId, date, inAt, outAt, note, outAt ? note : null]
        );
        attendanceId = Number(ins.insertId);
      }
      await queryDB(
        `INSERT INTO attendance_admin_edits (user_id, attendance_date, attendance_id, project_id, old_check_in_at, old_check_out_at, new_check_in_at, new_check_out_at, remarks, edited_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, date, attendanceId, projectId, row?.check_in_at ?? null, row?.check_out_at ?? null, inAt ?? row?.check_in_at ?? null, outAt ?? row?.check_out_at ?? null, remarks, Number(req.user.id)]
      );
      res.json({ success: true, attendance_id: attendanceId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
