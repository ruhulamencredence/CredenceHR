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
// Each part is shown only to an account with the module it comes from
// (EXTRAS_PART_MODULE / TASK_MODULE below; a Superadmin sees everything) —
// the dashboard itself is open to every Admin, its HR figures are not.
// Every read goes through queryDB, so it covers the company being worked in
// (companyScope.ts). Each part fails on its own: a missing table just leaves
// that part empty.

import type { Express } from "express";

interface AdminDashboardRouteDeps {
  authenticateToken: any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  getAdminModules: (userId: number) => Promise<string[]>;
  todayInDhaka: () => string;
  // Who approves a pending approval request's current step (server.ts).
  getCurrentStepApprovers: (request: any) => Promise<{ user_id: number; user_name: string | null }[]>;
}

// What a pending approval request is, the module that lists it (an account
// sees only the kinds whose module it has) and the Admin Panel tab to open.
const STUCK_SOURCES: Record<string, { label: string; module: string; tab: string }> = {
  leave_application: { label: "Leave application", module: "leave_applications", tab: "leave_applications" },
  user_claim: { label: "Conveyance bill", module: "conveyance", tab: "conveyance" },
  claim: { label: "Movement claim", module: "claims", tab: "claims" },
  attendance: { label: "Attendance", module: "attendance", tab: "approvals" },
  attendance_correction: { label: "Attendance correction", module: "attendance", tab: "approvals" },
  asset_requisition: { label: "Asset requisition", module: "asset_management", tab: "asset_management" },
  vehicle_requisition: { label: "Vehicle requisition", module: "vehicle_management", tab: "vehicle_management" },
  mobile_limit_request: { label: "Mobile limit request", module: "mobile_bill", tab: "mobile_bill" },
  advance_request: { label: "Loan / salary advance", module: "payroll", tab: "payroll" }
};

// Which module(s) a part of /extras needs (any one of them).
const EXTRAS_PART_MODULE: Record<string, string[]> = {
  birthdays: ["employees"],
  attendance_approvals: ["attendance"],
  attendance_corrections: ["attendance"],
  documents: ["hr_operations"],
  status_effective: ["hr_operations"],
  alerts: ["employees", "hr_operations"]
};
// Task Status Overview row -> the module whose queue it counts.
const TASK_MODULE: Record<string, string> = {
  leave: "leave_applications",
  attendance: "attendance",
  corrections: "attendance",
  claims: "claims",
  bills: "disbursement",
  advances: "payroll",
  assets: "asset_management",
  vehicles: "vehicle_management",
  documents: "hr_operations",
  hr_actions: "hr_operations",
  exits: "exit_offboarding",
  grievances: "grievance_disciplinary"
};

const DAY_MS = 24 * 60 * 60 * 1000;
const dateOnly = (v: any): string | null => {
  if (!v) return null;
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / DAY_MS);

export function registerAdminDashboardRoutes(app: Express, deps: AdminDashboardRouteDeps) {
  const { authenticateToken, queryDB, getAdminModules, todayInDhaka, getCurrentStepApprovers } = deps;
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

  app.get("/api/admin-dashboard/extras", authenticateToken, gate, async (req: any, res) => {
    try {
      const isSuper = req.user.role === "superadmin";
      const mods = isSuper ? [] : await getAdminModules(req.user.id).catch(() => [] as string[]);
      const may = (part: string) => isSuper || (EXTRAS_PART_MODULE[part] || []).some((m) => mods.includes(m));
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
        birthdays: may("birthdays") ? birthdays : [],
        attendance_approvals: may("attendance_approvals") ? pendingAttendance : [],
        attendance_corrections: may("attendance_corrections") ? pendingCorrections : [],
        documents: may("documents") ? documents : [],
        status_effective: may("status_effective") ? statusEffective : [],
        tasks: tasks.filter((t) => isSuper || mods.includes(TASK_MODULE[t.key])),
        alerts: may("alerts") ? alerts : []
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Applications that have sat at the same approval layer for `days` days or
  // more (default 3): which layer, who has to act, since when. Reliever
  // requests of leave applications count too. Only the kinds whose module
  // this account has (a Superadmin sees all).
  app.get("/api/admin-dashboard/stuck", authenticateToken, gate, async (req: any, res) => {
    try {
      const days = Math.min(60, Math.max(1, Math.floor(Number(req.query.days)) || 3));
      const isSuper = req.user.role === "superadmin";
      const mods = isSuper ? [] : await getAdminModules(req.user.id).catch(() => [] as string[]);
      const allowed = (type: string) => !!STUCK_SOURCES[type] && (isSuper || mods.includes(STUCK_SOURCES[type].module));
      const today = todayInDhaka();
      const [requests, steps, leaves, relievers, users] = await Promise.all([
        rows(
          `SELECT ar.*, DATE(COALESCE(ar.updated_at, ar.created_at)) AS since
           FROM approval_requests ar
           WHERE ar.status = 'pending' AND COALESCE(ar.updated_at, ar.created_at) <= DATE_SUB(NOW(), INTERVAL ? DAY)
           ORDER BY COALESCE(ar.updated_at, ar.created_at) ASC LIMIT 400`,
          [days]
        ),
        rows("SELECT template_id, step_order, approver_type, label FROM approval_template_steps"),
        rows("SELECT id, start_date, end_date, day_count FROM leave_applications WHERE status = 'pending'"),
        allowed("leave_application")
          ? rows(
              `SELECT la.id, la.user_id, la.reliever_id, la.start_date, la.end_date, la.day_count, DATE(la.created_at) AS since
               FROM leave_applications la
               WHERE la.status = 'pending' AND la.reliever_status = 'pending' AND la.reliever_id IS NOT NULL
                 AND la.created_at <= DATE_SUB(NOW(), INTERVAL ? DAY)
                 AND NOT EXISTS (SELECT 1 FROM approval_requests ar WHERE ar.source_type = 'leave_application' AND ar.source_id = la.id)`,
              [days]
            )
          : Promise.resolve([] as any[]),
        rows("SELECT id, name FROM users")
      ]);
      const nameOf = new Map<number, string>(users.map((u: any) => [Number(u.id), String(u.name || "")]));
      const stepLabel = new Map<string, string>(steps.map((st: any) => [`${st.template_id}:${st.step_order}`, String(st.label || st.approver_type || "").trim()]));
      const leaveById = new Map<number, any>(leaves.map((l: any) => [Number(l.id), l]));
      const leaveDates = (l: any) => (l ? `${dateOnly(l.start_date)}${dateOnly(l.end_date) !== dateOnly(l.start_date) ? ` to ${dateOnly(l.end_date)}` : ""} (${Number(l.day_count)} day${Number(l.day_count) === 1 ? "" : "s"})` : null);

      const items: any[] = [];
      for (const ar of requests.filter((r: any) => allowed(r.source_type)).slice(0, 200)) {
        const src = STUCK_SOURCES[ar.source_type];
        const step = Number(ar.current_step);
        const supervisorStep = !!ar.supervisor_step_user_id;
        const layer = supervisorStep && step === 1
          ? "Supervisor"
          : (ar.template_id && stepLabel.get(`${ar.template_id}:${step - (supervisorStep ? 1 : 0)}`)) || `Step ${step}`;
        const approvers = await getCurrentStepApprovers(ar).catch(() => []);
        const since = dateOnly(ar.since) || today;
        items.push({
          kind: ar.source_type,
          label: src.label,
          tab: src.tab,
          id: Number(ar.source_id),
          requester: nameOf.get(Number(ar.requested_by)) || "—",
          detail: ar.source_type === "leave_application" ? leaveDates(leaveById.get(Number(ar.source_id))) : null,
          layer,
          step,
          total_steps: Number(ar.total_steps) || null,
          approvers: approvers.map((a) => a.user_name || `User #${a.user_id}`),
          since,
          days_waiting: Math.max(0, daysBetween(since, today))
        });
      }
      for (const l of relievers) {
        const since = dateOnly(l.since) || today;
        items.push({
          kind: "leave_reliever",
          label: "Leave application",
          tab: "leave_applications",
          id: Number(l.id),
          requester: nameOf.get(Number(l.user_id)) || "—",
          detail: leaveDates(l),
          layer: "Reliever",
          step: null,
          total_steps: null,
          approvers: [nameOf.get(Number(l.reliever_id)) || "—"],
          since,
          days_waiting: Math.max(0, daysBetween(since, today))
        });
      }
      items.sort((a, b) => b.days_waiting - a.days_waiting);
      const byKind = new Map<string, { label: string; tab: string; count: number }>();
      for (const it of items) {
        const k = byKind.get(it.label) || { label: it.label, tab: it.tab, count: 0 };
        k.count++;
        byKind.set(it.label, k);
      }
      res.json({ days, total: items.length, by_kind: [...byKind.values()].sort((a, b) => b.count - a.count), items });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
}
