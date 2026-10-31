/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Management Dashboard (Admin Panel -> Management Dashboard, AdminModuleKey
// "management_dashboard") — the whole company for one month, compared with
// the month before: people, attendance, money paid out, approvals, PEPM
// projects, targets, recruitment, fleet and assets, plus a "Needs attention"
// list. Like HRAnalyticsRoutes.ts it owns no tables: one read-only
// aggregation over tables that already exist. Attendance uses the same
// engine as the Monthly Attendance report (HrOps360Routes.ts), so the
// numbers match it.

import type { Express } from "express";
import { leaveLabelFn, loadAttendanceData, computeAttendanceDays, summarizeDays } from "./HrOps360Routes";

interface ManagementDashboardDeps {
  authenticateToken: any;
  requireModule: (moduleKey: "management_dashboard") => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  todayInDhaka: () => string;
}

const ymd = (v: any): string | null => {
  if (!v) return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 6 * 3600 * 1000).toISOString().slice(0, 10);
};
const ym = (v: any) => ymd(v)?.slice(0, 7) || null;
const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;
const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
const monthEnd = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const monthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
const daysBetween = (a: any, b: string) => {
  const s = ymd(a);
  if (!s) return 0;
  return Math.max(0, Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${s}T00:00:00Z`).getTime()) / 86400000));
};
// Every query here is best-effort: a module that isn't set up yet (no table)
// just shows empty instead of failing the whole dashboard.
const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
  try {
    return (await p) ?? fallback;
  } catch {
    return fallback;
  }
};

const SOURCE_LABEL: Record<string, string> = {
  leave_application: "Leave Application",
  user_claim: "Conveyance Bill Claim",
  claim: "Movement Claim",
  attendance_correction: "Timesheet correction",
  attendance: "Attendance",
  asset_requisition: "Asset Requisition",
  vehicle_requisition: "Vehicle Requisition",
  mobile_limit_request: "Mobile limit",
  advance_request: "Loan / Advance"
};

export function registerManagementDashboardRoutes(app: Express, deps: ManagementDashboardDeps) {
  const { authenticateToken, requireModule, queryDB, todayInDhaka } = deps;

  app.get("/api/management-dashboard", authenticateToken, requireModule("management_dashboard"), async (req: any, res: any) => {
    try {
      const today = todayInDhaka();
      const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query?.month || "")) ? String(req.query.month) : today.slice(0, 7);
      const prev = shiftMonth(month, -1);
      const from = `${month}-01`;
      const to = monthEnd(month) < today ? monthEnd(month) : today;
      const prevFrom = `${prev}-01`;
      const prevTo = monthEnd(prev);
      const depts: string[] = String(req.query?.departments || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const [users, allEmps, exits, payrolls, leaves, approvals, targets, targetTasks, convBills, convItems, advances, mobileBills, rides, vehicles, assignments, postings, candidates, entries, projects, dispatches, tasks, grievances] =
        await Promise.all([
          safe(queryDB("SELECT id, name, role, is_blocked FROM users"), []),
          safe(queryDB("SELECT * FROM all_employees"), []),
          safe(queryDB("SELECT * FROM exit_requests"), []),
          safe(queryDB("SELECT * FROM payrolls WHERE month_year IN (?, ?)", [month, prev]), []),
          safe(queryDB("SELECT * FROM leave_applications WHERE end_date >= ? AND start_date <= ?", [prevFrom, monthEnd(month) > today ? monthEnd(month) : today]), []),
          safe(queryDB("SELECT * FROM approval_requests WHERE status = 'pending' OR updated_at >= ?", [prevFrom]), []),
          safe(queryDB("SELECT * FROM targets WHERE period IN (?, ?)", [month, prev]), []),
          safe(queryDB("SELECT * FROM target_tasks"), []),
          safe(queryDB("SELECT * FROM conveyance_bills WHERE is_disbursed = 1 AND disbursed_at >= ?", [prevFrom]), []),
          safe(queryDB("SELECT * FROM conveyance_bill_items"), []),
          safe(queryDB("SELECT * FROM employee_advances WHERE created_at >= ?", [prevFrom]), []),
          safe(queryDB("SELECT * FROM mobile_bills WHERE bill_month IN (?, ?)", [month, prev]), []),
          safe(queryDB("SELECT * FROM vehicle_requisitions WHERE ride_date BETWEEN ? AND ?", [prevFrom, monthEnd(month)]), []),
          safe(queryDB("SELECT * FROM vehicles"), []),
          safe(queryDB("SELECT * FROM asset_assignments WHERE returned_date IS NULL"), []),
          safe(queryDB("SELECT * FROM job_postings"), []),
          safe(queryDB("SELECT * FROM job_candidates"), []),
          safe(queryDB("SELECT id, project_id, computed_amount, created_at FROM entries WHERE deleted_at IS NULL AND created_at >= ?", [prevFrom]), []),
          safe(queryDB("SELECT id, project_name FROM projects"), []),
          safe(queryDB("SELECT d.id, d.status, d.dispatch_date, d.received_date, e.project_id FROM mpr_dispatches d JOIN entries e ON e.id = d.entry_id WHERE d.status <> 'cancelled'"), []),
          safe(queryDB("SELECT id, status, completed_at, department FROM tasks WHERE completed_at >= ?", [prevFrom]), []),
          safe(queryDB("SELECT id, status FROM grievances"), [])
        ]);

      // People: employees (not just accounts), active ones, with their department.
      const activeEmps = (allEmps as any[]).filter((e) => Number(e.is_active ?? 1) !== 0);
      const inScope = (dept: any) => !depts.length || depts.includes(String(dept || "").trim() || "Unassigned");
      const deptOf = (e: any) => String(e?.department || "").trim() || "Unassigned";
      const empByUser = new Map<number, any>();
      const empById = new Map<number, any>();
      for (const e of allEmps as any[]) {
        if (e.user_id != null) empByUser.set(Number(e.user_id), e);
        empById.set(Number(e.id), e);
      }
      const userName = new Map<number, string>((users as any[]).map((u) => [Number(u.id), u.name]));
      const nameOfUser = (id: any) => empByUser.get(Number(id))?.name || userName.get(Number(id)) || `User #${id}`;
      const deptOfUser = (id: any) => deptOf(empByUser.get(Number(id)));
      const scoped = activeEmps.filter((e) => inScope(deptOf(e)));

      // Joined / left per month (left = last working day of an exit that wasn't cancelled).
      const exitsLive = (exits as any[]).filter((x) => x.status !== "cancelled" && inScope(deptOfUser(x.user_id)));
      const joinedIn = (m: string) => (allEmps as any[]).filter((e) => ym(e.joining_date) === m && inScope(deptOf(e)));
      const leftIn = (m: string) => exitsLive.filter((x) => ym(x.last_working_day) === m);
      const flow = [5, 4, 3, 2, 1, 0].map((back) => {
        const m = shiftMonth(month, -back);
        return { month: m, label: monthLabel(m), joined: joinedIn(m).length, left: leftIn(m).length };
      });
      const headcount = scoped.length;
      const joinedNow = joinedIn(month).length;
      const leftNow = leftIn(month).length;
      const headcountPrev = headcount - joinedNow + leftNow;
      const headDept = new Map<string, { count: number; joined: number; left: number }>();
      const hd = (d: string) => headDept.get(d) || (headDept.set(d, { count: 0, joined: 0, left: 0 }), headDept.get(d)!);
      for (const e of scoped) hd(deptOf(e)).count++;
      for (const e of joinedIn(month)) hd(deptOf(e)).joined++;
      for (const x of leftIn(month)) hd(deptOfUser(x.user_id)).left++;

      // Attendance — the Monthly Attendance engine, this month and last.
      const label = await safe(leaveLabelFn(queryDB as any), (k: string) => k);
      const attendanceFor = async (f: string, t: string) => {
        const data = await loadAttendanceData(queryDB as any, f, t);
        const byDept = new Map<string, { working: number; present: number; leave: number; late: number; people: number }>();
        let working = 0, presentish = 0, late = 0;
        for (const e of scoped) {
          const s = summarizeDays(computeAttendanceDays(data, e, f, t, today, label));
          if (!s.working_days) continue;
          const d = byDept.get(deptOf(e)) || { working: 0, present: 0, leave: 0, late: 0, people: 0 };
          d.working += s.working_days;
          d.present += s.present;
          d.leave += s.leave;
          d.late += s.late + s.extreme_late;
          d.people++;
          byDept.set(deptOf(e), d);
          working += s.working_days;
          presentish += s.present + s.leave;
          late += s.late + s.extreme_late;
        }
        return { byDept, rate: working ? round1((presentish / working) * 100) : null, latePct: working ? round1((late / working) * 100) : null };
      };
      const [att, attPrev] = await Promise.all([safe(attendanceFor(from, to), null as any), safe(attendanceFor(prevFrom, prevTo), null as any)]);
      const attendanceByDept = att
        ? [...att.byDept.entries()]
            .map(([department, d]: [string, any]) => ({
              department,
              people: d.people,
              present_pct: d.working ? round1(((d.present + d.leave) / d.working) * 100) : 0,
              late_pct: d.working ? round1((d.late / d.working) * 100) : 0,
              prev_present_pct: attPrev?.byDept.get(department)?.working
                ? round1(((attPrev.byDept.get(department).present + attPrev.byDept.get(department).leave) / attPrev.byDept.get(department).working) * 100)
                : null
            }))
            .sort((a, b) => b.present_pct - a.present_pct)
        : [];

      // Salary — Payroll's net salary for the month (paid or not), by department.
      const payFor = (m: string) => (payrolls as any[]).filter((p) => p.month_year === m && inScope(deptOf(empById.get(Number(p.employee_id)))));
      const salaryNow = payFor(month).reduce((a, p) => a + num(p.net_salary), 0);
      const salaryPrev = payFor(prev).reduce((a, p) => a + num(p.net_salary), 0);
      const salaryPaid = payFor(month).length > 0 && payFor(month).every((p) => p.payment_status === "paid");
      const salDept = new Map<string, { amount: number; prev: number; people: number }>();
      for (const p of payFor(month)) {
        const d = deptOf(empById.get(Number(p.employee_id)));
        const r = salDept.get(d) || { amount: 0, prev: 0, people: 0 };
        r.amount += num(p.net_salary);
        r.people++;
        salDept.set(d, r);
      }
      for (const p of payFor(prev)) {
        const d = deptOf(empById.get(Number(p.employee_id)));
        const r = salDept.get(d) || { amount: 0, prev: 0, people: 0 };
        r.prev += num(p.net_salary);
        salDept.set(d, r);
      }

      // Leave today / tomorrow.
      const tomorrow = new Date(new Date(`${today}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
      const onDay = (d: string) =>
        (leaves as any[]).filter((l) => l.status === "approved" && (ymd(l.start_date) || "") <= d && (ymd(l.end_date) || "") >= d && inScope(deptOfUser(l.user_id)));
      const leaveToday = onDay(today);
      const leavePending = (leaves as any[]).filter((l) => l.status === "pending" && inScope(deptOfUser(l.user_id))).length;

      // Approvals — waiting now (age), and how fast decisions were made.
      const appr = (approvals as any[]).filter((r) => inScope(deptOfUser(r.requested_by)));
      const pending = appr.filter((r) => r.status === "pending");
      const decidedIn = (m: string) => appr.filter((r) => (r.status === "approved" || r.status === "rejected") && ym(r.updated_at) === m);
      const avgDays = (rows: any[]) => (rows.length ? round1(rows.reduce((a, r) => a + daysBetween(r.created_at, ymd(r.updated_at) || today), 0) / rows.length) : null);
      const types = new Set<string>([...pending.map((r) => r.source_type), ...decidedIn(month).map((r) => r.source_type)]);
      const approvalsByType = [...types]
        .map((t) => {
          const p = pending.filter((r) => r.source_type === t);
          return {
            type: t,
            label: SOURCE_LABEL[t] || t,
            waiting: p.length,
            stuck: p.filter((r) => daysBetween(r.created_at, today) >= 3).length,
            avg_days: avgDays(decidedIn(month).filter((r) => r.source_type === t)),
            oldest_days: p.reduce((a, r) => Math.max(a, daysBetween(r.created_at, today)), 0)
          };
        })
        .sort((a, b) => b.waiting - a.waiting);
      const approvalsOldest = pending
        .slice()
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, 25)
        .map((r) => ({
          id: Number(r.id),
          label: SOURCE_LABEL[r.source_type] || r.source_type,
          requester: nameOfUser(r.requested_by),
          department: deptOfUser(r.requested_by),
          layer: `${r.current_step}/${r.total_steps}`,
          waiting_on: r.adhoc_approver_id ? nameOfUser(r.adhoc_approver_id) : r.current_step === 1 && r.supervisor_step_user_id ? nameOfUser(r.supervisor_step_user_id) : null,
          days: daysBetween(r.created_at, today)
        }));
      const stuck = pending.filter((r) => daysBetween(r.created_at, today) >= 3).length;

      // Targets — weighted progress of each target's tasks.
      const tasksByTarget = new Map<number, any[]>();
      for (const t of targetTasks as any[]) {
        const k = Number(t.target_id);
        if (!tasksByTarget.has(k)) tasksByTarget.set(k, []);
        tasksByTarget.get(k)!.push(t);
      }
      const progressOf = (t: any) => {
        const ts = tasksByTarget.get(Number(t.id)) || [];
        const w = ts.reduce((a, x) => a + (num(x.weight) || 1), 0);
        return w ? ts.reduce((a, x) => a + (num(x.weight) || 1) * Math.min(100, num(x.progress)), 0) / w : 0;
      };
      const liveTargets = (m: string) =>
        (targets as any[]).filter((t) => t.period === m && !["cancelled", "rejected", "draft"].includes(String(t.status)) && inScope(String(t.department || deptOfUser(t.user_id))));
      const avgProgress = (rows: any[]) => (rows.length ? round1(rows.reduce((a, t) => a + progressOf(t), 0) / rows.length) : null);
      const tDept = new Map<string, any[]>();
      for (const t of liveTargets(month)) {
        const d = String(t.department || deptOfUser(t.user_id) || "Unassigned");
        if (!tDept.has(d)) tDept.set(d, []);
        tDept.get(d)!.push(t);
      }
      const prevTDept = new Map<string, any[]>();
      for (const t of liveTargets(prev)) {
        const d = String(t.department || deptOfUser(t.user_id) || "Unassigned");
        if (!prevTDept.has(d)) prevTDept.set(d, []);
        prevTDept.get(d)!.push(t);
      }
      const targetsByDept = [...tDept.entries()]
        .map(([department, rows]) => ({
          department,
          pct: avgProgress(rows) ?? 0,
          prev: avgProgress(prevTDept.get(department) || []),
          count: rows.length,
          done: rows.filter((t) => progressOf(t) >= 100).length,
          overdue: rows.filter((t) => t.deadline && (ymd(t.deadline) || "") < today && progressOf(t) < 100).length
        }))
        .sort((a, b) => b.pct - a.pct);

      // Money paid out.
      const itemsByBill = new Map<number, number>();
      for (const it of convItems as any[]) itemsByBill.set(Number(it.bill_id), (itemsByBill.get(Number(it.bill_id)) || 0) + num(it.amount));
      const convFor = (m: string) =>
        (convBills as any[]).filter((b) => ym(b.disbursed_at) === m && inScope(deptOfUser(b.user_id))).reduce((a, b) => a + (itemsByBill.get(Number(b.id)) || 0), 0);
      const advFor = (m: string) =>
        (advances as any[]).filter((a) => ym(a.created_at) === m && inScope(deptOf(empById.get(Number(a.employee_id))))).reduce((s, a) => s + num(a.total_amount), 0);
      const mobFor = (m: string) =>
        (mobileBills as any[]).filter((b) => b.bill_month === m && inScope(deptOf(empById.get(Number(b.employee_id))))).reduce((s, b) => s + num(b.amount), 0);
      const mobOver = (mobileBills as any[])
        .filter((b) => b.bill_month === month && inScope(deptOf(empById.get(Number(b.employee_id)))))
        .reduce((s, b) => s + Math.max(0, num(b.amount) - num(b.limit_amount || 0)), 0);
      const money = [
        { key: "salary", label: "Salary (Payroll)", source: salaryPaid ? "Run Payroll · paid" : "Run Payroll · net", amount: salaryNow, prev: salaryPrev },
        { key: "advance", label: "Loans / advance given", source: "Loan / Advance", amount: advFor(month), prev: advFor(prev) },
        { key: "conveyance", label: "Conveyance claims", source: "Bill Claim · disbursed", amount: convFor(month), prev: convFor(prev) },
        { key: "mobile", label: "Mobile bills", source: mobOver > 0 ? `Mobile Bill · ৳${Math.round(mobOver).toLocaleString("en-US")} over limit` : "Mobile Bill", amount: mobFor(month), prev: mobFor(prev) }
      ];

      // PEPM projects — MPR value entered this month, and material on the way / received.
      const projName = new Map<number, string>((projects as any[]).map((p) => [Number(p.id), p.project_name]));
      const projAgg = new Map<number, { value: number; prevValue: number; rows: number; sent: number; received: number }>();
      const pa = (id: number) => projAgg.get(id) || (projAgg.set(id, { value: 0, prevValue: 0, rows: 0, sent: 0, received: 0 }), projAgg.get(id)!);
      for (const e of entries as any[]) {
        if (e.project_id == null) continue;
        const m = ym(e.created_at);
        if (m === month) {
          pa(Number(e.project_id)).value += num(e.computed_amount);
          pa(Number(e.project_id)).rows++;
        } else if (m === prev) pa(Number(e.project_id)).prevValue += num(e.computed_amount);
      }
      for (const d of dispatches as any[]) {
        if (d.project_id == null) continue;
        if (d.status === "sent") pa(Number(d.project_id)).sent++;
        else if (d.status === "received" && ym(d.received_date) === month) pa(Number(d.project_id)).received++;
      }
      const projectRows = [...projAgg.entries()]
        .map(([id, p]) => ({ project: projName.get(id) || `Project #${id}`, value: Math.round(p.value), prev_value: Math.round(p.prevValue), mpr_rows: p.rows, on_the_way: p.sent, received: p.received }))
        .filter((p) => p.value || p.on_the_way || p.received)
        .sort((a, b) => b.value - a.value);
      const maxProject = projectRows.reduce((a, p) => Math.max(a, p.value), 0);

      // Workforce, recruitment, fleet and assets.
      const probation = scoped.filter((e) => /probation/i.test(String(e.employment_category || e.job_status || ""))).length;
      const inNotice = exitsLive.filter((x) => x.status === "pending" || x.status === "clearance").length;
      const tenureYears = scoped.filter((e) => ymd(e.joining_date)).map((e) => daysBetween(e.joining_date, today) / 365.25);
      const male = scoped.filter((e) => /^m/i.test(String(e.gender || ""))).length;
      const female = scoped.filter((e) => /^f/i.test(String(e.gender || ""))).length;
      const openPostings = (postings as any[]).filter((p) => p.status === "open");
      const cand = (st: string[]) => (candidates as any[]).filter((c) => st.includes(String(c.status))).length;
      const ridesNow = (rides as any[]).filter((r) => ym(r.ride_date) === month && ["approved", "ongoing", "completed"].includes(String(r.status)) && inScope(deptOfUser(r.employee_user_id)));
      const busy = (vehicles as any[]).length ? Math.round(((vehicles as any[]).filter((v) => v.status === "on_ride").length / (vehicles as any[]).length) * 100) : null;
      const assignScoped = (assignments as any[]).filter((a) => inScope(deptOfUser(a.employee_user_id)));
      const doneTasks = (tasks as any[]).filter((t) => ym(t.completed_at) === month && inScope(t.department)).length;

      // KPI: targets achieved (all targets this month, and last).
      const tNow = avgProgress(liveTargets(month));
      const tPrev = avgProgress(liveTargets(prev));

      // Needs attention — plain rules over what was computed above.
      const attention: { level: "high" | "medium" | "info"; title: string; detail: string; target: string }[] = [];
      if (stuck > 0) {
        const worst = approvalsByType.filter((a) => a.stuck > 0).slice(0, 2).map((a) => a.label).join(" and ");
        attention.push({ level: "high", title: `${stuck} approval${stuck === 1 ? "" : "s"} waiting 3+ days`, detail: worst ? `Mostly ${worst}` : "Approval engine", target: "approvals" });
      }
      for (const d of attendanceByDept.filter((x) => x.late_pct >= 10).slice(0, 2)) {
        attention.push({ level: "medium", title: `${d.department}: late arrivals ${d.late_pct}%`, detail: `${d.people} people · this month`, target: "attendance" });
      }
      for (const d of attendanceByDept.filter((x) => x.prev_present_pct != null && x.present_pct < (x.prev_present_pct as number) - 3).slice(0, 2)) {
        attention.push({ level: "medium", title: `${d.department}: attendance fell to ${d.present_pct}%`, detail: `Was ${d.prev_present_pct}% last month`, target: "attendance" });
      }
      const overdueTargets = targetsByDept.reduce((a, t) => a + t.overdue, 0);
      if (overdueTargets) attention.push({ level: "medium", title: `${overdueTargets} target${overdueTargets === 1 ? "" : "s"} past deadline`, detail: "Not finished yet", target: "targets" });
      if (salaryPrev > 0 && salaryNow > salaryPrev * 1.05) {
        attention.push({ level: "medium", title: `Salary cost up ${round1(((salaryNow - salaryPrev) / salaryPrev) * 100)}%`, detail: "Compared with last month", target: "salary" });
      }
      if (inNotice) attention.push({ level: "info", title: `${inNotice} resignation${inNotice === 1 ? "" : "s"} in progress`, detail: "Exit / Offboarding", target: "headcount" });
      const openGrievances = (grievances as any[]).filter((g) => g.status === "open" || g.status === "investigating").length;
      if (openGrievances) attention.push({ level: "info", title: `${openGrievances} open grievance${openGrievances === 1 ? "" : "s"}`, detail: "Grievance & Disciplinary", target: "headcount" });

      const departments = [...new Set(activeEmps.map((e) => deptOf(e)))].sort((a, b) => a.localeCompare(b));

      res.json({
        month,
        prev_month: prev,
        today,
        departments,
        kpis: {
          headcount: { value: headcount, prev: headcountPrev },
          attendance: { value: att?.rate ?? null, prev: attPrev?.rate ?? null, late_pct: att?.latePct ?? null },
          salary: { value: Math.round(salaryNow), prev: Math.round(salaryPrev), paid: salaryPaid },
          on_leave_today: { value: leaveToday.length, tomorrow: onDay(tomorrow).length, pending: leavePending },
          approvals: { waiting: pending.length, stuck, avg_days: avgDays(decidedIn(month)) },
          targets: { value: tNow, prev: tPrev }
        },
        flow,
        headcount_by_department: [...headDept.entries()].map(([department, d]) => ({ department, ...d })).sort((a, b) => b.count - a.count),
        attendance_by_department: attendanceByDept,
        salary_by_department: [...salDept.entries()].map(([department, d]) => ({ department, amount: Math.round(d.amount), prev: Math.round(d.prev), people: d.people })).sort((a, b) => b.amount - a.amount),
        on_leave_today: leaveToday.map((l) => ({ name: nameOfUser(l.user_id), department: deptOfUser(l.user_id), leave_type: label(l.leave_type), until: ymd(l.end_date) })),
        money: money.map((m) => ({ ...m, amount: Math.round(m.amount), prev: Math.round(m.prev) })),
        approvals_by_type: approvalsByType,
        approvals_oldest: approvalsOldest,
        projects: projectRows.map((p) => ({ ...p, share_of_max: maxProject ? Math.round((p.value / maxProject) * 100) : 0 })),
        targets_by_department: targetsByDept,
        ops: {
          mpr_rows: (entries as any[]).filter((e) => ym(e.created_at) === month).length,
          material_on_the_way: (dispatches as any[]).filter((d) => d.status === "sent").length,
          tasks_done: doneTasks
        },
        workforce: {
          joined: joinedNow,
          left: leftNow,
          probation,
          in_notice: inNotice,
          avg_tenure_years: tenureYears.length ? round1(tenureYears.reduce((a, b) => a + b, 0) / tenureYears.length) : null,
          male,
          female
        },
        recruitment: {
          open_positions: openPostings.reduce((a, p) => a + (num(p.vacancy_count) || 1), 0),
          applied: (candidates as any[]).length,
          interview: cand(["interview_scheduled", "interviewed"]),
          offered: cand(["offered"]),
          hired: cand(["hired"])
        },
        fleet: {
          rides: ridesNow.length,
          vehicles_busy_pct: busy,
          assets_in_use: assignScoped.reduce((a, x) => a + (num(x.quantity) || 1), 0),
          awaiting_ack: assignScoped.filter((a) => !a.acknowledged_at).length
        },
        attention
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
