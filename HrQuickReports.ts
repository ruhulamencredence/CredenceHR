/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations -> Quick Reports (and the Admin Dashboard's "HR reports"
// card): five ready reports, one click each — no columns or filters to pick.
//
//   probation     probation ending within 30 days, overdue (ended, not
//                 confirmed), confirmed in the period
//   joiners       joined in the period, by department, with onboarding progress
//   transfers     employee_transfers in the period: from -> to, effective date,
//                 still to take effect
//   religion      active employees by religion (and "not recorded"), by department
//   resignations  exit_requests: submitted in the period, in notice now,
//                 leaving within 30 days, settled; last working day,
//                 clearance progress, reasons, turnover. No money.
//   attendance    the period's month: attendance under 80%, late more than 3 times
//   leave         the period's year: Casual / Sick left 2 days or less, leave without pay
//   contracts     contracts ending within 60 days, or already ended
//   headcount     active employees by gender, branch, project, employment category
//   records       expired documents, awaiting e-signature, no app login
//   overtime      who did OT in the period: hours (approved / waiting for
//                 approval / on off-days and holidays), on which days, by
//                 month. Read from ot_entries after recalcOt (OvertimeRoutes.ts),
//                 so it matches Duty Roster -> OT Approval and Payroll. Only
//                 people set to get OT (not_eligible rows) and not rejected
//                 days. Hours only — no money.
// The last five read the same per-employee facts as Employee Reports
// (buildFacts, HrOpsReportsRoutes.ts), so the numbers match it.
//
// Probation dates are worked out exactly as Employee Reports does
// (HrOpsReportsRoutes.ts): Service Details' probation end, else joining date +
// probation months (the employee's, else HR Settings' default).
//
// Access: HR Operations + its layer "quick_reports" (plain reading, so part of
// the no-saved-layers default; accounts with saved layers got it once —
// startup marker hr_quick_reports_grant). UI and API alike. The Overtime
// report also needs its own layer "quick_ot" (same default; given once to
// accounts that had Quick reports — marker hr_quick_ot_grant).

import type { Express } from "express";
import { loadEmployeeWorld, loadSettings, snapshotOf, toDate } from "./HROperationsRoutes";
import { fallbackServiceStatus } from "./hrServiceStatus";
import { buildFacts } from "./HrOpsReportsRoutes";
import { getStartupMarker, setStartupMarker } from "./startupOnce";
import { recalcOt } from "./OvertimeRoutes";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export async function ensureHrQuickReportsSchema(dbPool: any): Promise<void> {
  try {
    if (!(await getStartupMarker(dbPool, "hr_quick_reports_grant"))) {
      // Accounts that already have HR Operations layers ticked keep seeing
      // everything plain they saw: they get the new reading layer once.
      const [holders]: any = await dbPool.query("SELECT DISTINCT user_id, company_id FROM admin_module_permission_layers WHERE module_key = 'hr_operations' AND layer_key = 'read'");
      for (const h of holders || []) {
        await dbPool.query("INSERT IGNORE INTO admin_module_permission_layers (user_id, module_key, layer_key, company_id) VALUES (?, 'hr_operations', 'quick_reports', ?)", [h.user_id, h.company_id ?? 1]);
      }
      await setStartupMarker(dbPool, "hr_quick_reports_grant", String((holders || []).length));
    }
  } catch (err: any) {
    console.warn("⚠️ Could not give HR Operations accounts the Quick reports layer: " + err.message);
  }
  try {
    if (!(await getStartupMarker(dbPool, "hr_quick_ot_grant"))) {
      // The Overtime report got its own layer: whoever already sees Quick
      // reports keeps seeing it, once; untick it in Module Access to stop.
      const [holders]: any = await dbPool.query("SELECT DISTINCT user_id, company_id FROM admin_module_permission_layers WHERE module_key = 'hr_operations' AND layer_key = 'quick_reports'");
      for (const h of holders || []) {
        await dbPool.query("INSERT IGNORE INTO admin_module_permission_layers (user_id, module_key, layer_key, company_id) VALUES (?, 'hr_operations', 'quick_ot', ?)", [h.user_id, h.company_id ?? 1]);
      }
      await setStartupMarker(dbPool, "hr_quick_ot_grant", String((holders || []).length));
    }
  } catch (err: any) {
    console.warn("⚠️ Could not give Quick reports accounts the Overtime report layer: " + err.message);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const monthEnd = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
const ymd = (v: any) => (v ? String(v).slice(0, 10) : null);
const countBy = (xs: (string | null)[], none = "Not recorded") => {
  const m = new Map<string, number>();
  for (const x of xs) {
    const k = (x || "").trim() || none;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
};
// A religion as people write it, under one spelling.
const RELIGION_ALIASES: [RegExp, string][] = [
  [/^(islam|muslim|moslem)/i, "Islam"],
  [/^(hindu)/i, "Hinduism"],
  [/^(christ)/i, "Christianity"],
  [/^(buddh|bouddh)/i, "Buddhism"]
];
const religionOf = (v: any) => {
  const s = String(v || "").trim();
  if (!s) return null;
  for (const [re, name] of RELIGION_ALIASES) if (re.test(s)) return name;
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// One person's OT totals from their days (also used again by the page for a
// single month).
export function otTotals<T extends { days: { minutes: number; approved: number; waiting: number; off: boolean }[] }>(r: T) {
  const add = (f: (d: T["days"][number]) => number) => r.days.reduce((a, d) => a + f(d), 0);
  return { ...r, total: add((d) => d.minutes), approved: add((d) => d.approved), waiting: add((d) => d.waiting), off: add((d) => (d.off ? d.minutes : 0)), day_count: r.days.length };
}

export interface HrQuickDeps {
  authenticateToken: any;
  requireModuleLayer: any;
  hasModuleLayer: (user: any, moduleKey: any, layer: string) => Promise<boolean>;
  queryDB: QueryDB;
  todayInDhaka: () => string;
}

export function registerHrQuickReportsRoutes(app: Express, deps: HrQuickDeps) {
  const { authenticateToken, requireModuleLayer, hasModuleLayer, queryDB, todayInDhaka } = deps;
  // The Overtime report has its own layer on top of Quick reports.
  const seesOt = (req: any) => hasModuleLayer(req.user, "hr_operations", "quick_ot").catch(() => false);
  const gate = [authenticateToken, requireModuleLayer("hr_operations", "quick_reports")];
  const fail = (res: any, err: any) => res.status(err?.statusCode || 500).json({ error: err?.message || String(err) });

  // Everyone of the company with what the reports need.
  interface Person {
    id: number;
    user_id: number | null;
    name: string;
    employee_code: string | null;
    designation: string | null;
    department: string | null;
    active: boolean;
    joining_date: string | null;
    probation_end_date: string | null;
    confirmation_date: string | null;
    service_status: string;
    religion: string | null;
  }
  async function people(): Promise<Person[]> {
    const world = await loadEmployeeWorld(queryDB);
    const settings = await loadSettings(queryDB);
    return world.employees.map((e: any) => {
      const snap = snapshotOf(world, Number(e.id));
      const joining = toDate(e.joining_date) || toDate(e.created_at);
      const probEnd =
        toDate(snap?.service?.probation_end_date) ||
        (joining
          ? (() => {
              const d = new Date(`${joining}T00:00:00Z`);
              d.setUTCMonth(d.getUTCMonth() + Number(snap?.service?.probation_months ?? settings.default_probation_months ?? 6));
              return d.toISOString().slice(0, 10);
            })()
          : null);
      return {
        id: Number(e.id),
        user_id: e.user_id ? Number(e.user_id) : null,
        name: e.name,
        employee_code: e.employee_id || null,
        designation: e.designation || null,
        department: e.department || null,
        active: Number(e.is_active ?? 1) !== 0,
        joining_date: joining,
        probation_end_date: probEnd,
        confirmation_date: toDate(snap?.service?.confirmation_date),
        service_status: snap?.service?.service_status || fallbackServiceStatus(e),
        religion: religionOf(e.religion)
      };
    });
  }
  const period = (q: any, today: string) => {
    const month = today.slice(0, 7);
    let from = DATE_RE.test(String(q.from || "")) ? String(q.from) : `${month}-01`;
    let to = DATE_RE.test(String(q.to || "")) ? String(q.to) : monthEnd(month);
    if (from > to) [from, to] = [to, from];
    return { from, to };
  };
  const inDept = (q: any) => {
    const d = String(q.department || "").trim();
    return (x: { department: string | null }) => !d || (x.department || "") === d;
  };

  // ---- the five reports ----
  async function probation(q: any, today: string) {
    const { from, to } = period(q, today);
    const all = (await people()).filter((p) => p.active).filter(inDept(q));
    const soon = addDays(today, 30);
    // In probation: not confirmed, status probation (or not set — then only
    // when the probation ended within the last 6 months, so long-serving
    // people without Service Details don't all show as overdue).
    const open = all.filter(
      (p) =>
        !p.confirmation_date &&
        p.probation_end_date &&
        (p.service_status === "probation" || (p.service_status === "" && p.probation_end_date >= addDays(today, -183)))
    );
    const rows = open
      .filter((p) => p.probation_end_date! <= soon)
      .map((p) => {
        const left = daysBetween(today, p.probation_end_date!);
        return { ...p, state: left < 0 ? "overdue" : "due_soon", days: left };
      })
      .sort((a, b) => a.days - b.days);
    const confirmed = all
      .filter((p) => p.confirmation_date && p.confirmation_date >= from && p.confirmation_date <= to)
      .map((p) => ({ ...p, state: "confirmed", days: null as number | null }));
    return {
      from,
      to,
      summary: { due_30: rows.filter((r) => r.state === "due_soon").length, overdue: rows.filter((r) => r.state === "overdue").length, confirmed: confirmed.length },
      rows: [...rows, ...confirmed]
    };
  }

  async function joiners(q: any, today: string) {
    const { from, to } = period(q, today);
    const list = (await people()).filter((p) => p.joining_date && p.joining_date >= from && p.joining_date <= to).filter(inDept(q));
    const items: any[] = (await queryDB("SELECT employee_id, status FROM hr_onboarding_items").catch(() => [])) || [];
    const prog = new Map<number, { done: number; total: number }>();
    for (const it of items) {
      if (it.status === "na") continue;
      const id = Number(it.employee_id);
      const p = prog.get(id) || { done: 0, total: 0 };
      p.total++;
      if (it.status === "done") p.done++;
      prog.set(id, p);
    }
    const rows = list
      .map((p) => ({ ...p, onboarding_done: prog.get(p.id)?.done ?? null, onboarding_total: prog.get(p.id)?.total ?? null }))
      .sort((a, b) => String(b.joining_date).localeCompare(String(a.joining_date)));
    return { from, to, summary: { joined: rows.length, by_department: countBy(rows.map((r) => r.department), "No department") }, rows };
  }

  async function transfers(q: any, today: string) {
    const { from, to } = period(q, today);
    const all = await people();
    const byId = new Map<number, Person>(all.map((p) => [p.id, p]));
    const raw: any[] = (await queryDB("SELECT * FROM employee_transfers").catch(() => [])) || [];
    const rows = raw
      .map((t) => {
        const p = byId.get(Number(t.employee_id));
        const when = ymd(t.effective_date) || ymd(t.created_at);
        return p && when
          ? {
              id: Number(t.id),
              employee_id: p.id,
              name: p.name,
              employee_code: p.employee_code,
              department: p.department,
              designation: p.designation,
              from_department: t.from_department_name || null,
              to_department: t.to_department_name || null,
              from_designation: t.from_designation || null,
              to_designation: t.to_designation || null,
              effective_date: when,
              reason: t.reason || null,
              scheduled: Number(t.applied ?? 1) === 0 || when > today
            }
          : null;
      })
      .filter((r): r is NonNullable<typeof r> => !!r && r.effective_date >= from && r.effective_date <= to)
      .filter((r) => !String(q.department || "") || r.from_department === q.department || r.to_department === q.department)
      .sort((a, b) => b.effective_date.localeCompare(a.effective_date));
    return { from, to, summary: { transfers: rows.length, scheduled: rows.filter((r) => r.scheduled).length }, rows };
  }

  async function religion(q: any) {
    const list = (await people()).filter((p) => p.active).filter(inDept(q));
    const total = list.length;
    const groups = countBy(list.map((p) => p.religion)).map((g) => ({ ...g, percent: total ? Math.round((g.count / total) * 1000) / 10 : 0 }));
    return {
      summary: { total, religions: groups.filter((g) => g.label !== "Not recorded").length, not_recorded: list.filter((p) => !p.religion).length },
      groups,
      rows: list.map((p) => ({ id: p.id, name: p.name, employee_code: p.employee_code, designation: p.designation, department: p.department, religion: p.religion })).sort((a, b) => String(a.name).localeCompare(String(b.name)))
    };
  }

  async function resignations(q: any, today: string) {
    const { from, to } = period(q, today);
    const all = await people();
    const byUser = new Map<number, Person>(all.filter((p) => p.user_id).map((p) => [p.user_id as number, p]));
    const [exits, items] = await Promise.all([
      queryDB("SELECT * FROM exit_requests").catch(() => []),
      queryDB("SELECT exit_id, is_cleared FROM exit_clearance_items").catch(() => [])
    ]);
    const clr = new Map<number, { done: number; total: number }>();
    for (const it of items || []) {
      const c = clr.get(Number(it.exit_id)) || { done: 0, total: 0 };
      c.total++;
      if (Number(it.is_cleared) === 1) c.done++;
      clr.set(Number(it.exit_id), c);
    }
    const type = ["resignation", "termination"].includes(String(q.type)) ? String(q.type) : "";
    const list = ((exits || []) as any[])
      .filter((x) => x.status !== "cancelled" && (!type || x.exit_type === type))
      .map((x) => {
        const p = byUser.get(Number(x.user_id));
        const lwd = ymd(x.last_working_day);
        const submitted = ymd(x.notice_date) || ymd(x.created_at);
        const inNotice = x.status !== "settled" && (!lwd || lwd >= today);
        return {
          id: Number(x.id),
          employee_id: p?.id ?? null,
          name: p?.name || "(no employee record)",
          employee_code: p?.employee_code || null,
          designation: p?.designation || null,
          department: p?.department || null,
          type: x.exit_type,
          submitted,
          last_working_day: lwd,
          days_left: lwd ? daysBetween(today, lwd) : null,
          status: x.status,
          in_notice: inNotice,
          clearance_done: clr.get(Number(x.id))?.done ?? 0,
          clearance_total: clr.get(Number(x.id))?.total ?? 0,
          reason: x.reason ? String(x.reason).slice(0, 200) : null
        };
      })
      .filter(inDept(q));
    // The list: anything submitted in the period, still in notice, or
    // leaving / settled in the period.
    const inPeriod = (d: string | null) => !!d && d >= from && d <= to;
    const rows = list
      .filter((r) => inPeriod(r.submitted) || r.in_notice || inPeriod(r.last_working_day))
      .sort((a, b) => (a.in_notice === b.in_notice ? String(a.last_working_day || "9").localeCompare(String(b.last_working_day || "9")) : a.in_notice ? -1 : 1));
    const yearStart = `${today.slice(0, 4)}-01-01`;
    const thisYear = list.filter((r) => r.submitted && r.submitted >= yearStart);
    const headcount = all.filter((p) => p.active).length;
    const activeIds = new Set(all.filter((p) => p.active).map((p) => p.id));
    // Turnover: those whose last working day this year has passed, out of
    // everyone employed this year (today's staff plus those already gone).
    const leftThisYear = list.filter((r) => r.last_working_day && r.last_working_day >= yearStart && r.last_working_day < today);
    const base = headcount + leftThisYear.filter((r) => r.employee_id == null || !activeIds.has(r.employee_id)).length;
    const reasonKey = (r: string | null) => {
      const s = String(r || "").trim();
      if (!s) return "Not given";
      if (/offer|salary|better|job|opportunit/i.test(s)) return "Better offer";
      if (/stud|education|abroad/i.test(s)) return "Higher study";
      if (/family|relocat|marri|personal|health/i.test(s)) return "Family / personal";
      return "Other";
    };
    return {
      from,
      to,
      summary: {
        submitted: list.filter((r) => inPeriod(r.submitted)).length,
        resignations: list.filter((r) => inPeriod(r.submitted) && r.type === "resignation").length,
        terminations: list.filter((r) => inPeriod(r.submitted) && r.type === "termination").length,
        in_notice: list.filter((r) => r.in_notice).length,
        leaving_30: list.filter((r) => r.in_notice && r.days_left != null && r.days_left >= 0 && r.days_left <= 30).length,
        settled: list.filter((r) => r.status === "settled" && inPeriod(r.last_working_day || r.submitted)).length
      },
      reasons: countBy(thisYear.map((r) => reasonKey(r.reason))),
      by_department: countBy(thisYear.map((r) => r.department), "No department"),
      turnover: { left_this_year: leftThisYear.length, headcount, base, percent: base ? Math.round((leftThisYear.length / base) * 1000) / 10 : 0 },
      rows
    };
  }

  // ---- the facts-based five (Employee Reports' facts) ----
  const facts = async (stages: string[], month: string, year: number, today: string) => (await buildFacts(queryDB, today, new Set(["base", ...stages]) as any, month, year, false)) as any[];
  const person = (f: any) => ({ id: f.employee_id, employee_id: f.employee_id, name: f.name, employee_code: f.employee_code, designation: f.designation, department: f.department });

  async function attendance(q: any, today: string) {
    const { from, to } = period(q, today);
    const month = to.slice(0, 7);
    const list = (await facts(["attendance"], month, Number(month.slice(0, 4)), today)).filter(inDept(q)).filter((f) => Number(f.att_working) > 0);
    const rows = list
      .map((f) => ({
        ...person(f),
        working: Number(f.att_working) || 0,
        present: Number(f.att_present) || 0,
        absent: Number(f.att_absent) || 0,
        leave: Number(f.att_leave) || 0,
        late: Number(f.att_late) || 0,
        extreme_late: Number(f.att_extreme_late) || 0,
        percent: f.att_percent == null ? null : Number(f.att_percent),
        low: f.att_percent != null && Number(f.att_percent) < 80,
        often_late: Number(f.att_late) > 3
      }))
      .filter((r) => r.low || r.often_late)
      .sort((a, b) => (a.percent ?? 100) - (b.percent ?? 100) || b.late - a.late);
    return { from, to, month, summary: { low: rows.filter((r) => r.low).length, often_late: rows.filter((r) => r.often_late).length, checked: list.length }, rows };
  }

  async function leave(q: any, today: string) {
    const { to } = period(q, today);
    const year = Number(to.slice(0, 4));
    const list = (await facts(["leave"], to.slice(0, 7), year, today)).filter(inDept(q));
    const rows = list
      .map((f) => ({
        ...person(f),
        casual_taken: Number(f.casual_taken) || 0,
        casual_balance: f.casual_balance == null ? null : Number(f.casual_balance),
        sick_taken: Number(f.sick_taken) || 0,
        sick_balance: f.sick_balance == null ? null : Number(f.sick_balance),
        lwp: Number(f.lwp_taken) || 0,
        last_leave: f.last_leave_date || null,
        low: (f.casual_balance != null && Number(f.casual_balance) <= 2) || (f.sick_balance != null && Number(f.sick_balance) <= 2),
        took_lwp: Number(f.lwp_taken) > 0
      }))
      .filter((r) => r.low || r.took_lwp)
      .sort((a, b) => b.lwp - a.lwp || (a.casual_balance ?? 99) - (b.casual_balance ?? 99));
    return { from: `${year}-01-01`, to: `${year}-12-31`, year, summary: { low: rows.filter((r) => r.low).length, lwp: rows.filter((r) => r.took_lwp).length }, rows };
  }

  async function contracts(q: any, today: string) {
    const soon = addDays(today, 60);
    const list = (await facts([], today.slice(0, 7), Number(today.slice(0, 4)), today)).filter(inDept(q));
    const rows = list
      .filter((f) => f.contract_end_date && f.contract_end_date <= soon && f.contract_end_date >= addDays(today, -183))
      .map((f) => {
        const days = daysBetween(today, f.contract_end_date);
        return { ...person(f), joining_date: f.joining_date, contract_end_date: f.contract_end_date, employment_category: f.employment_category, days, state: days < 0 ? "ended" : "due" };
      })
      .sort((a, b) => a.days - b.days);
    return { summary: { due_60: rows.filter((r) => r.state === "due").length, ended: rows.filter((r) => r.state === "ended").length }, rows };
  }

  async function headcount(q: any, today: string) {
    const list = (await facts([], today.slice(0, 7), Number(today.slice(0, 4)), today)).filter(inDept(q));
    const total = list.length;
    const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);
    // "male" / "Male" / " MALE" count as one.
    const tidy = (v: any) => {
      const t = v == null ? "" : String(v).trim();
      return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : null;
    };
    const dim = (key: string, none: string) => countBy(list.map((f) => (key === "gender" ? tidy(f[key]) : f[key] == null ? null : String(f[key]))), none).map((g) => ({ ...g, percent: pct(g.count) }));
    const gender = dim("gender", "Not recorded");
    const male = gender.find((g) => /^m/i.test(g.label))?.count || 0;
    const female = gender.find((g) => /^f/i.test(g.label))?.count || 0;
    return {
      summary: { total, male, female },
      dimensions: { gender, branch: dim("branch", "No branch"), project: dim("project", "No project"), category: dim("employment_category", "Not recorded") },
      rows: list
        .map((f) => ({ ...person(f), gender: tidy(f.gender), branch: f.branch || null, project: f.project || null, category: f.employment_category || null, age: f.age ?? null }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    };
  }

  // Who did OT in the period, how many hours, on which days and months.
  async function overtime(q: any, today: string) {
    const { from, to } = period(q, today);
    if (daysBetween(from, to) > 366) throw Object.assign(new Error("Pick at most one year."), { statusCode: 400 });
    // Bring the period's OT up to date with attendance, a month at a time
    // (recalcOt skips days someone already decided).
    const end = to > today ? today : to;
    for (let m = from; m <= end; ) {
      const last = monthEnd(m.slice(0, 7));
      await recalcOt(queryDB, m, last < end ? last : end).catch(() => undefined);
      m = addDays(last, 1);
    }
    const [all, entries] = await Promise.all([
      people(),
      queryDB("SELECT employee_id, work_date, day_kind, in_at, out_at, calc_minutes, approved_minutes, status FROM ot_entries WHERE work_date BETWEEN ? AND ? AND status NOT IN ('not_eligible', 'rejected') ORDER BY work_date", [from, to]).catch(() => [])
    ]);
    const byId = new Map<number, Person>(all.map((p) => [p.id, p]));
    const dept = String(q.department || "").trim();
    const hm = (v: any) => (v ? String(v).replace("T", " ").slice(11, 16) : null);
    const rowsById = new Map<number, any>();
    const months = new Map<string, number>();
    for (const x of (entries || []) as any[]) {
      const p = byId.get(Number(x.employee_id));
      if (!p || (dept && (p.department || "") !== dept)) continue;
      const approved = Number(x.approved_minutes) || 0;
      const waiting = x.status === "pending" ? Math.max(0, (Number(x.calc_minutes) || 0) - approved) : 0;
      const minutes = approved + waiting;
      if (minutes <= 0) continue;
      const date = ymd(x.work_date) as string;
      if (!rowsById.has(p.id)) rowsById.set(p.id, { id: p.id, name: p.name, employee_code: p.employee_code, designation: p.designation, department: p.department, days: [] as any[] });
      rowsById.get(p.id).days.push({ date, minutes, approved, waiting, off: x.day_kind === "off", in: hm(x.in_at), out: hm(x.out_at), status: x.status });
      months.set(date.slice(0, 7), (months.get(date.slice(0, 7)) || 0) + minutes);
    }
    const rows = [...rowsById.values()].map(otTotals).sort((a, b) => b.total - a.total || String(a.name).localeCompare(String(b.name)));
    const sum = (k: string) => rows.reduce((a, r) => a + r[k], 0);
    return {
      from,
      to,
      summary: { people: rows.length, total_minutes: sum("total"), approved_minutes: sum("approved"), waiting_minutes: sum("waiting"), off_minutes: sum("off"), waiting_people: rows.filter((r) => r.waiting > 0).length },
      months: [...months.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, minutes]) => ({ month, minutes })),
      rows
    };
  }

  async function records(q: any, today: string) {
    const list = (await facts(["documents"], today.slice(0, 7), Number(today.slice(0, 4)), today)).filter(inDept(q));
    const rows = list
      .map((f) => ({
        ...person(f),
        expired: Array.isArray(f.expired_documents) ? f.expired_documents : [],
        unsigned: Number(f.unsigned_documents) || 0,
        no_login: !f.has_login
      }))
      .filter((r) => r.expired.length || r.unsigned || r.no_login)
      .sort((a, b) => b.expired.length - a.expired.length || b.unsigned - a.unsigned);
    return {
      summary: { expired: rows.filter((r) => r.expired.length).length, unsigned: rows.filter((r) => r.unsigned).length, no_login: rows.filter((r) => r.no_login).length },
      rows
    };
  }

  const REPORTS: Record<string, (q: any, today: string) => Promise<any>> = {
    probation,
    joiners,
    transfers,
    religion: (q) => religion(q),
    resignations,
    attendance,
    leave,
    contracts,
    headcount,
    records,
    overtime
  };

  // The cards' numbers (HR Operations and the Admin Dashboard).
  app.get("/api/hr-ops/quick/summary", ...gate, async (req: any, res: any) => {
    try {
      const today = todayInDhaka();
      const [p, j, t, r, x, at, lv, ct, hc, rc, ot] = await Promise.all([
        probation({}, today),
        joiners({}, today),
        transfers({}, today),
        religion({}),
        resignations({}, today),
        attendance({}, today),
        leave({}, today),
        contracts({}, today),
        headcount({}, today),
        records({}, today),
        (await seesOt(req)) ? overtime({}, today).catch(() => null) : null
      ]);
      res.json({
        month: today.slice(0, 7),
        probation: p.summary,
        joiners: { joined: j.summary.joined, top: j.summary.by_department.slice(0, 3) },
        transfers: t.summary,
        religion: { ...r.summary, top: r.groups.filter((g: any) => g.label !== "Not recorded").slice(0, 4) },
        resignations: { in_notice: x.summary.in_notice, leaving_30: x.summary.leaving_30, submitted: x.summary.submitted },
        attendance: at.summary,
        leave: lv.summary,
        contracts: ct.summary,
        headcount: hc.summary,
        records: rc.summary,
        overtime: ot ? ot.summary : undefined
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // One report. ?from&to (default this month), ?department, ?type (resignations).
  app.get("/api/hr-ops/quick/:kind", ...gate, async (req: any, res: any) => {
    try {
      const fn = REPORTS[String(req.params.kind)];
      if (!fn) return res.status(404).json({ error: "No such report." });
      if (req.params.kind === "overtime" && !(await seesOt(req))) return res.status(403).json({ error: "You don't have permission to do this. Ask your Superadmin to grant it." });
      const departments: any[] = (await queryDB("SELECT name FROM departments WHERE is_active = 1 ORDER BY name").catch(() => [])) || [];
      res.json({ kind: req.params.kind, today: todayInDhaka(), departments: departments.map((d) => d.name), ...(await fn(req.query || {}, todayInDhaka())) });
    } catch (err) {
      fail(res, err);
    }
  });
}
