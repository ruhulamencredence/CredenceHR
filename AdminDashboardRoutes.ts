/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Admin Dashboard: the figures that have no screen of their
// own to borrow from (AdminDashboard.tsx reads everything else from the
// modules' own endpoints). One request:
//   birthdays       — active Employees with a birthday in the next 7 days
//   attendance      — remote check-ins/outs waiting in the Approval Chain, and
//                     attendance corrections (timesheet) waiting for review
//   documents       — HR letter requests and submitted information requests
//   status_effective — approved/pending personnel actions not applied yet,
//                     effective today or later
//   tasks           — what is waiting on HR, per kind (Task Status Overview)
//   alerts          — probation / contract ends and document expiries due
//                     within 30 days (or already past, up to 30 days)
// Every read goes through queryDB, so it covers the company being worked in
// (companyScope.ts). Each part fails on its own: a missing table just leaves
// that part empty.

import type { Express } from "express";

interface AdminDashboardRouteDeps {
  authenticateToken: any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  getAdminModules: (userId: number) => Promise<string[]>;
  todayInDhaka: () => string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const dateOnly = (v: any): string | null => {
  if (!v) return null;
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / DAY_MS);

export function registerAdminDashboardRoutes(app: Express, deps: AdminDashboardRouteDeps) {
  const { authenticateToken, queryDB, getAdminModules, todayInDhaka } = deps;
  const rows = (sql: string, params: any[] = []) => queryDB(sql, params).then((r: any) => (Array.isArray(r) ? r : [])).catch(() => [] as any[]);

  // Same people who see the dashboard (AdminPanel's canSeeDashboard).
  const gate = async (req: any, res: any, next: any) => {
    const role = req.user?.role;
    if (role === "superadmin" || role === "admin") return next();
    try {
      if (role === "user" && (await getAdminModules(req.user.id)).includes("admin_dashboard")) return next();
    } catch {}
    return res.status(403).json({ error: "Admin access required" });
  };

  app.get("/api/admin-dashboard/extras", authenticateToken, gate, async (_req: any, res) => {
    try {
      const today = todayInDhaka();
      const [employees, users, service, docs, approvals, corrections, letters, infos, actions, leaves, claims, bills, advances, assets, vehicles, exits, grievances] =
        await Promise.all([
          rows("SELECT id, employee_id, user_id, name, designation, department, date_of_birth, is_active FROM all_employees"),
          rows("SELECT id, name FROM users"),
          rows("SELECT employee_id, probation_end_date, confirmation_date, contract_end_date, service_status FROM hr_employee_service"),
          rows("SELECT id, user_id, doc_type, expiry_date FROM employee_documents"),
          // Only what's waiting — every check-in/out has an approval request,
          // so the full table grows by the day.
          rows("SELECT id, source_type, requested_by, status, created_at FROM approval_requests WHERE status = 'pending'"),
          rows("SELECT id, user_id, attendance_date, status, created_at FROM attendance_corrections WHERE status = 'pending'"),
          rows("SELECT id, employee_id, user_id, letter_type, status, created_at FROM hr_letter_requests"),
          rows("SELECT id, employee_id, user_id, item_type, doc_type, status, submitted_at FROM hr_info_requests"),
          rows("SELECT id, employee_id, action_type, effective_date, status, applied FROM hr_actions"),
          rows("SELECT id, status FROM leave_applications"),
          rows("SELECT id, status FROM user_claims"),
          rows("SELECT id, is_disbursed FROM conveyance_bills"),
          rows("SELECT id, status FROM advance_requests"),
          rows("SELECT id, status FROM asset_requisitions"),
          rows("SELECT id, status FROM vehicle_requisitions"),
          rows("SELECT id, status FROM exit_requests"),
          rows("SELECT id, status FROM grievances")
        ]);

      const empById = new Map<number, any>(employees.map((e: any) => [Number(e.id), e]));
      const empByUser = new Map<number, any>(employees.filter((e: any) => e.user_id).map((e: any) => [Number(e.user_id), e]));
      const userName = new Map<number, string>(users.map((u: any) => [Number(u.id), u.name]));
      const person = (employeeId: any, userId: any) => {
        const e = (employeeId && empById.get(Number(employeeId))) || (userId && empByUser.get(Number(userId)));
        return {
          name: e?.name || (userId ? userName.get(Number(userId)) : null) || "—",
          employee_code: e?.employee_id || null,
          department: e?.department || null,
          designation: e?.designation || null
        };
      };

      // Birthdays in the next 7 days (29 Feb falls on 28 Feb in other years).
      const ty = Number(today.slice(0, 4));
      const birthdays = employees
        .filter((e: any) => Number(e.is_active ?? 1) === 1 && dateOnly(e.date_of_birth))
        .map((e: any) => {
          const [by, bm, bd] = dateOnly(e.date_of_birth)!.split("-").map(Number);
          const on = (y: number) => {
            const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
            const d = bm === 2 && bd === 29 && !leap ? 28 : bd;
            return `${y}-${String(bm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          };
          let next = on(ty);
          if (next < today) next = on(ty + 1);
          const days = daysBetween(today, next);
          return { ...person(e.id, null), date: next, days_away: days, turning: Number(next.slice(0, 4)) - by };
        })
        .filter((b: any) => b.days_away >= 0 && b.days_away <= 7)
        .sort((a: any, b: any) => a.days_away - b.days_away || a.name.localeCompare(b.name));

      // Only this company's people (users is scoped to the company).
      const here = new Set(users.map((u: any) => Number(u.id)));
      const pendingAttendance = approvals
        .filter((a: any) => a.status === "pending" && a.source_type === "attendance" && here.has(Number(a.requested_by)))
        .map((a: any) => ({ id: Number(a.id), ...person(null, a.requested_by), date: dateOnly(a.created_at) }));
      const pendingCorrections = corrections
        .filter((c: any) => c.status === "pending")
        .map((c: any) => ({ id: Number(c.id), ...person(null, c.user_id), date: dateOnly(c.attendance_date) }));

      const documents = [
        ...letters
          .filter((l: any) => l.status === "pending")
          .map((l: any) => ({ id: `letter-${l.id}`, kind: "Letter request", detail: String(l.letter_type || "").replace(/_/g, " "), ...person(l.employee_id, l.user_id), date: dateOnly(l.created_at) })),
        ...infos
          .filter((i: any) => i.status === "submitted")
          .map((i: any) => ({ id: `info-${i.id}`, kind: "Information submitted", detail: i.doc_type || String(i.item_type || "").replace(/_/g, " "), ...person(i.employee_id, i.user_id), date: dateOnly(i.submitted_at) }))
      ];

      const statusEffective = actions
        .filter((a: any) => Number(a.applied || 0) === 0 && (a.status === "pending" || a.status === "approved") && (dateOnly(a.effective_date) || "") >= today)
        .map((a: any) => ({
          id: Number(a.id),
          ...person(a.employee_id, null),
          action: String(a.action_type || "").replace(/_/g, " "),
          date: dateOnly(a.effective_date),
          status: a.status
        }))
        .sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)));

      // Due within 30 days, or overdue by up to 30.
      const soon = (d: string | null) => {
        if (!d) return null;
        const n = daysBetween(today, d);
        return n >= -30 && n <= 30 ? n : null;
      };
      const alerts: any[] = [];
      for (const s of service) {
        const e = empById.get(Number(s.employee_id));
        if (!e || Number(e.is_active ?? 1) !== 1) continue;
        const confirmed = !!dateOnly(s.confirmation_date) || /confirm/i.test(String(s.service_status || ""));
        const p = soon(dateOnly(s.probation_end_date));
        if (p !== null && !confirmed) alerts.push({ kind: "probation", label: "Probation ends", ...person(e.id, null), date: dateOnly(s.probation_end_date), days: p });
        const c = soon(dateOnly(s.contract_end_date));
        if (c !== null) alerts.push({ kind: "contract", label: "Contract ends", ...person(e.id, null), date: dateOnly(s.contract_end_date), days: c });
      }
      for (const d of docs) {
        const n = soon(dateOnly(d.expiry_date));
        const e = empByUser.get(Number(d.user_id));
        if (n !== null && (!e || Number(e.is_active ?? 1) === 1))
          alerts.push({ kind: "document", label: `${d.doc_type || "Document"} expires`, ...person(null, d.user_id), date: dateOnly(d.expiry_date), days: n });
      }
      alerts.sort((a, b) => a.days - b.days);

      const count = (list: any[], ok: (r: any) => boolean) => list.filter(ok).length;
      const tasks = [
        { key: "leave", label: "Leave applications", count: count(leaves, (r) => r.status === "pending"), tab: "leave_applications" },
        { key: "attendance", label: "Attendance approvals", count: pendingAttendance.length, tab: "approvals" },
        { key: "corrections", label: "Attendance corrections", count: pendingCorrections.length, tab: null },
        { key: "claims", label: "Movement claims", count: count(claims, (r) => r.status === "pending"), tab: "claims" },
        { key: "bills", label: "Bills to disburse", count: count(bills, (r) => !Number(r.is_disbursed || 0)), tab: "disbursement" },
        { key: "advances", label: "Advance salary", count: count(advances, (r) => r.status === "pending"), tab: null },
        { key: "assets", label: "Asset requisitions", count: count(assets, (r) => r.status === "pending" || r.status === "manager_approved"), tab: "asset_management" },
        { key: "vehicles", label: "Vehicle requisitions", count: count(vehicles, (r) => r.status === "pending"), tab: "vehicle_management" },
        { key: "documents", label: "Document requests", count: documents.length, tab: "hr_operations" },
        { key: "hr_actions", label: "Personnel actions", count: count(actions, (r) => r.status === "pending"), tab: "hr_operations" },
        { key: "exits", label: "Exits in progress", count: count(exits, (r) => r.status === "pending" || r.status === "clearance"), tab: "exit_offboarding" },
        { key: "grievances", label: "Open grievances", count: count(grievances, (r) => r.status === "open" || r.status === "investigating"), tab: "grievance_disciplinary" }
      ];

      res.json({
        today,
        birthdays,
        attendance_approvals: pendingAttendance,
        attendance_corrections: pendingCorrections,
        documents,
        status_effective: statusEffective,
        tasks,
        alerts
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
}
