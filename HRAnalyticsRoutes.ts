/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Analytics (Admin Panel -> HR Advanced -> "HR Analytics") — kept in its
// own file, same reasoning as ExitOffboardingRoutes.ts. Unlike every other
// HR Advanced module, this one owns no tables of its own — it's a single
// read-only aggregation endpoint over tables that already exist (users,
// all_employees, job_postings, exit_requests, grievances,
// leave_applications, attendance), so there's no ensureXSchema export here.

import type { Express } from "express";

interface HRAnalyticsRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (moduleKey: "hr_analytics") => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Safe 'YYYY-MM' extraction from a DB date/timestamp value. Real MySQL
// (via mysql2) hands back an ISO-ish string/Date consistently, but the
// in-memory dev fallback's generic INSERT stamps created_at with a raw
// `new Date()` object — String(new Date()) is "Tue Sep 22 2026 ...", NOT
// "2026-09-22...", so a plain `String(value).slice(0, 7)` silently produces
// the wrong bucket key in dev mode. Routing every value through `new
// Date(value)` first (a no-op for an already-a-Date value, a real parse for
// a string/DATE value) and reading .toISOString() works for both.
function toMonthKey(value: any): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 7);
}

// Last `count` months (oldest first), each as {month: 'YYYY-MM', label: 'Jan'}.
function lastMonths(count: number): { month: string; label: string }[] {
  const out: { month: string; label: string }[] = [];
  const now = new Date();
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ month: monthKey(d), label: d.toLocaleDateString("en-US", { month: "short" }) });
  }
  return out;
}

export function registerHRAnalyticsRoutes(app: Express, deps: HRAnalyticsRouteDeps) {
  const { authenticateToken, requireAdmin, requireModule, queryDB } = deps;

  app.get("/api/hr-analytics/summary", authenticateToken, requireAdmin, requireModule("hr_analytics"), async (_req: any, res: any) => {
    try {
      const [allUsers, employees, postings, exits, grievances, leaveApps, attendance] = await Promise.all([
        queryDB("SELECT * FROM users"),
        queryDB("SELECT * FROM all_employees"),
        queryDB("SELECT * FROM job_postings"),
        queryDB("SELECT * FROM exit_requests"),
        queryDB("SELECT * FROM grievances"),
        queryDB("SELECT * FROM leave_applications"),
        queryDB("SELECT * FROM attendance")
      ]);
      const users = allUsers.filter((u: any) => u.role === "admin" || u.role === "user");

      const headcountTotal = users.length;

      const deptByUserId = new Map<number, string>();
      for (const e of employees) {
        if (e.user_id != null && e.department) deptByUserId.set(Number(e.user_id), e.department);
      }
      const deptCounts = new Map<string, number>();
      for (const u of users) {
        const dept = deptByUserId.get(Number(u.id)) || "Unassigned";
        deptCounts.set(dept, (deptCounts.get(dept) || 0) + 1);
      }
      const headcountByDepartment = Array.from(deptCounts.entries())
        .map(([department, count]) => ({ department, count }))
        .sort((a, b) => b.count - a.count);

      const openPositions = postings
        .filter((p: any) => p.status === "open")
        .reduce((sum: number, p: any) => sum + (Number(p.vacancy_count) || 0), 0);

      const pendingExits = exits.filter((e: any) => e.status === "pending" || e.status === "clearance").length;
      const openGrievances = grievances.filter((g: any) => g.status === "open" || g.status === "investigating").length;

      const months = lastMonths(6);
      const monthIndex = new Map(months.map((m, i) => [m.month, i]));

      const leaveByMonth = months.map((m) => ({ ...m, count: 0 }));
      for (const a of leaveApps) {
        const key = toMonthKey(a.apply_date);
        const idx = key ? monthIndex.get(key) : undefined;
        if (idx !== undefined) leaveByMonth[idx].count++;
      }

      const exitsByMonth = months.map((m) => ({ ...m, count: 0 }));
      for (const e of exits) {
        const key = toMonthKey(e.created_at);
        const idx = key ? monthIndex.get(key) : undefined;
        if (idx !== undefined) exitsByMonth[idx].count++;
      }

      // Remote Attendance Rate this month — distinct (user, date) check-ins
      // this month over (headcount x days elapsed so far this month). Only
      // covers the GPS-based Remote Attendance module, not office/biometric
      // attendance, so labelled accordingly on the dashboard.
      const now = new Date();
      const daysElapsed = now.getDate();
      const thisMonthKey = monthKey(now);
      const presentDates = new Set<string>();
      for (const a of attendance) {
        const key = toMonthKey(a.attendance_date);
        if (key === thisMonthKey) presentDates.add(`${a.user_id}_${a.attendance_date}`);
      }
      const possibleAttendance = headcountTotal * daysElapsed;
      const attendanceRate = possibleAttendance > 0 ? Math.min(100, Math.round((presentDates.size / possibleAttendance) * 1000) / 10) : 0;

      res.json({
        headcount_total: headcountTotal,
        headcount_by_department: headcountByDepartment,
        open_positions: openPositions,
        pending_exits: pendingExits,
        open_grievances: openGrievances,
        remote_attendance_rate: attendanceRate,
        leave_applications_by_month: leaveByMonth,
        exits_by_month: exitsByMonth
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
