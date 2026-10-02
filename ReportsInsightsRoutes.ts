/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Reports & Insights (Admin Panel -> Reports & Insights) — one place to run
// the operational reports that used to be scattered (or missing): Attendance,
// Movement Claim, Bill Claim, Conveyance Bill, Bill Disbursement, Leave,
// Asset and Vehicle. Each report is a small definition below: which Admin
// modules may run it, which filters it takes, and a `run` that reads the
// tables and returns { columns, rows }; SUMMARIES below adds the totals.
// The page renders any report the same way and exports it to Excel / PDF.
//
// Access: a report is listed and runnable only for an account holding one of
// its modules (a Superadmin holds all). Department-wise scopes that the
// source modules already enforce (Attendance Report, Leave Application,
// Conveyance) apply here too. Reads only — nothing here writes.

import type { Express } from "express";
import { leaveLabelFn, loadAttendanceData, computeAttendanceDays, summarizeDays } from "./HrOps360Routes";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;
type DeptScopeKind = "attendance" | "leave" | "conveyance";

interface ReportsInsightsDeps {
  authenticateToken: any;
  requireAdmin: any;
  queryDB: QueryDB;
  getAdminModules: (userId: number) => Promise<string[]>;
  todayInDhaka: () => string;
  getDeptScope: (kind: DeptScopeKind, userId: number) => Promise<string[] | null>;
}

export type ColumnType = "text" | "number" | "money" | "date" | "datetime" | "percent";
export interface ReportColumn {
  key: string;
  label: string;
  type?: ColumnType;
}
type FilterKey = "date" | "department" | "employee" | "status";

interface RunCtx {
  from: string;
  to: string;
  status: string;
  today: string;
  queryDB: QueryDB;
  people: People;
}

interface ReportDef {
  key: string;
  category: string;
  title: string;
  description: string;
  modules: string[];
  filters: FilterKey[];
  // Label for the date range ("Ride date", "Bill date"…) and its default span.
  dateLabel?: string;
  maxDays?: number;
  statuses?: { value: string; label: string }[];
  deptScope?: DeptScopeKind;
  run: (ctx: RunCtx) => Promise<{ columns: ReportColumn[]; rows: any[] }>;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
// A DATE / DATETIME column as YYYY-MM-DD (server runs on Dhaka time).
export function d10(v: any): string {
  if (!v) return "";
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  return String(v).slice(0, 10);
}
export function dt16(v: any): string {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(String(v).replace(" ", "T"));
  if (isNaN(d.getTime())) return String(v).slice(0, 16);
  return `${d10(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const num = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const inRange = (d: string, from: string, to: string) => !!d && d >= from && d <= to;
const titleCase = (s: string) => String(s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;

const EMP_COLS: ReportColumn[] = [
  { key: "emp_code", label: "Emp ID" },
  { key: "employee", label: "Employee" },
  { key: "department", label: "Department" }
];

interface Person {
  name: string;
  emp_code: string;
  department: string;
  designation: string;
}
interface People {
  byUser: Map<number, Person>;
  employees: any[];
  userName: (id: any) => string;
}

async function loadPeople(queryDB: QueryDB): Promise<People> {
  const [users, emps] = await Promise.all([
    queryDB("SELECT id, name FROM users").catch(() => []),
    queryDB("SELECT * FROM all_employees").catch(() => [])
  ]);
  const empByUser = new Map<number, any>();
  for (const e of emps) if (e.user_id != null) empByUser.set(Number(e.user_id), e);
  const byUser = new Map<number, Person>();
  for (const u of users) {
    const e = empByUser.get(Number(u.id));
    byUser.set(Number(u.id), {
      name: e?.name || u.name || "",
      emp_code: e?.employee_id || "",
      department: e?.department || "",
      designation: e?.designation || ""
    });
  }
  return {
    byUser,
    employees: emps,
    userName: (id: any) => (id == null ? "" : byUser.get(Number(id))?.name || "")
  };
}

// Employee columns for a row owned by a login account.
const who = (people: People, userId: any) => {
  const p = people.byUser.get(Number(userId));
  return { emp_code: p?.emp_code || "", employee: p?.name || "", department: p?.department || "" };
};

const sum = (rows: any[], key: string) => round2(rows.reduce((a, r) => a + num(r[key]), 0));

// ---------------------------------------------------------------------------
// report definitions
// ---------------------------------------------------------------------------

const ATTENDANCE_MODULES = ["attendance_reports", "attendance", "office_attendance"];
const DAY_STATUS: Record<string, string> = {
  present: "Present",
  absent: "Absent",
  leave: "Leave",
  holiday: "Holiday",
  weekend: "Weekend",
  future: "—",
  not_joined: "Not joined",
  separated: "Separated"
};

const REPORTS: ReportDef[] = [
  // ---------------- Attendance ----------------
  {
    key: "attendance_summary",
    category: "Attendance",
    title: "Attendance Summary",
    description: "Per employee: working days, present, absent, leave, late and attendance % (office punches, remote check-ins, site muster and approved leave).",
    modules: ATTENDANCE_MODULES,
    filters: ["date", "department", "employee"],
    dateLabel: "Attendance date",
    maxDays: 92,
    deptScope: "attendance",
    async run({ from, to, today, queryDB, people }) {
      const data = await loadAttendanceData(queryDB, from, to);
      const label = await leaveLabelFn(queryDB);
      const rows: any[] = [];
      for (const e of people.employees) {
        const days = computeAttendanceDays(data, e, from, to, today, label);
        const s = summarizeDays(days);
        if (!s.working_days && days.every((d) => d.status === "not_joined" || d.status === "separated")) continue;
        rows.push({
          emp_code: e.employee_id || "",
          employee: e.name || "",
          department: e.department || "",
          designation: e.designation || "",
          working_days: s.working_days,
          present: s.present,
          absent: s.absent,
          leave: s.leave,
          holidays: s.holidays,
          late: s.late,
          extreme_late: s.extreme_late,
          attendance_percent: s.attendance_percent
        });
      }
      rows.sort((a, b) => a.department.localeCompare(b.department) || a.employee.localeCompare(b.employee));
      return {
        columns: [
          ...EMP_COLS,
          { key: "designation", label: "Designation" },
          { key: "working_days", label: "Working Days", type: "number" },
          { key: "present", label: "Present", type: "number" },
          { key: "absent", label: "Absent", type: "number" },
          { key: "leave", label: "Leave", type: "number" },
          { key: "holidays", label: "Holidays / Weekends", type: "number" },
          { key: "late", label: "Late", type: "number" },
          { key: "extreme_late", label: "Extreme Late", type: "number" },
          { key: "attendance_percent", label: "Attendance %", type: "percent" }
        ],
        rows
      };
    }
  },
  {
    key: "attendance_daily",
    category: "Attendance",
    title: "Daily Attendance Log",
    description: "Every employee, every day: status, first in, last out, late mark and leave type.",
    modules: ATTENDANCE_MODULES,
    filters: ["date", "department", "employee", "status"],
    dateLabel: "Attendance date",
    maxDays: 31,
    deptScope: "attendance",
    statuses: ["present", "absent", "leave", "holiday", "weekend"].map((v) => ({ value: v, label: DAY_STATUS[v] })),
    async run({ from, to, today, queryDB, people, status }) {
      const data = await loadAttendanceData(queryDB, from, to);
      const label = await leaveLabelFn(queryDB);
      const rows: any[] = [];
      const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      for (const e of people.employees) {
        for (const d of computeAttendanceDays(data, e, from, to, today, label)) {
          if (d.status === "not_joined" || d.status === "separated" || d.status === "future") continue;
          if (status && d.status !== status) continue;
          rows.push({
            date: d.date,
            day: WD[d.weekday] || "",
            emp_code: e.employee_id || "",
            employee: e.name || "",
            department: e.department || "",
            status: DAY_STATUS[d.status] || d.status,
            in: d.in || "",
            out: d.out || "",
            late: d.late === "extreme" ? "Extreme late" : d.late === "late" ? "Late" : "",
            waived: d.waived ? "Waived" : "",
            leave_type: d.leave_type || "",
            note: d.holiday || d.correction || "",
            source: d.source || ""
          });
        }
      }
      rows.sort((a, b) => a.date.localeCompare(b.date) || a.employee.localeCompare(b.employee));
      return {
        columns: [
          { key: "date", label: "Date", type: "date" },
          { key: "day", label: "Day" },
          ...EMP_COLS,
          { key: "status", label: "Status" },
          { key: "in", label: "In" },
          { key: "out", label: "Out" },
          { key: "late", label: "Late" },
          { key: "waived", label: "Waiver" },
          { key: "leave_type", label: "Leave Type" },
          { key: "note", label: "Note" },
          { key: "source", label: "Source" }
        ],
        rows
      };
    }
  },
  {
    key: "remote_attendance",
    category: "Attendance",
    title: "Remote Check-in / Check-out",
    description: "App check-ins: project, in / out time, distance from the project and hours on site.",
    modules: ["attendance", "attendance_reports"],
    filters: ["date", "department", "employee"],
    dateLabel: "Attendance date",
    deptScope: "attendance",
    async run({ from, to, queryDB, people }) {
      const [att, projects] = await Promise.all([
        queryDB("SELECT * FROM attendance WHERE attendance_date BETWEEN ? AND ?", [from, to]).catch(() => queryDB("SELECT * FROM attendance")),
        queryDB("SELECT id, project_name FROM projects").catch(() => [])
      ]);
      const projectName = new Map<number, string>(projects.map((p: any) => [Number(p.id), p.project_name]));
      const rows = att
        .filter((a: any) => inRange(d10(a.attendance_date), from, to))
        .map((a: any) => {
          const inAt = a.check_in_at ? new Date(a.check_in_at) : null;
          const outAt = a.check_out_at ? new Date(a.check_out_at) : null;
          const hours = inAt && outAt ? round2((outAt.getTime() - inAt.getTime()) / 3600000) : null;
          return {
            date: d10(a.attendance_date),
            ...who(people, a.user_id),
            project: projectName.get(Number(a.project_id)) || "",
            check_in: dt16(a.check_in_at).slice(11),
            in_distance_m: a.check_in_distance_m != null ? Math.round(num(a.check_in_distance_m)) : null,
            check_out: dt16(a.check_out_at).slice(11),
            out_distance_m: a.check_out_distance_m != null ? Math.round(num(a.check_out_distance_m)) : null,
            hours,
            remarks: [a.check_in_remarks, a.check_out_remarks].filter(Boolean).join(" / ")
          };
        })
        .sort((a: any, b: any) => a.date.localeCompare(b.date) || a.employee.localeCompare(b.employee));
      return {
        columns: [
          { key: "date", label: "Date", type: "date" },
          ...EMP_COLS,
          { key: "project", label: "Project" },
          { key: "check_in", label: "Check-in" },
          { key: "in_distance_m", label: "In Distance (m)", type: "number" },
          { key: "check_out", label: "Check-out" },
          { key: "out_distance_m", label: "Out Distance (m)", type: "number" },
          { key: "hours", label: "Hours", type: "number" },
          { key: "remarks", label: "Remarks" }
        ],
        rows
      };
    }
  },

  // ---------------- Movement Claim ----------------
  {
    key: "movement_claims",
    category: "Claim",
    title: "Movement Claims",
    description: "Field movements: purpose, check-in / check-out time and distance travelled.",
    modules: ["claims"],
    filters: ["date", "department", "employee", "status"],
    dateLabel: "Movement date",
    statuses: [
      { value: "open", label: "Open" },
      { value: "completed", label: "Completed" }
    ],
    async run({ from, to, queryDB, people, status }) {
      const claims = await queryDB("SELECT * FROM claims").catch(() => []);
      const rows = claims
        .filter((c: any) => inRange(d10(c.check_in_at || c.created_at), from, to) && (!status || c.status === status))
        .map((c: any) => ({
          claim_no: `MC-${c.id}`,
          date: d10(c.check_in_at || c.created_at),
          ...who(people, c.user_id),
          purpose: c.purpose || "",
          check_in: dt16(c.check_in_at).slice(11),
          check_out: dt16(c.check_out_at).slice(11),
          distance_km: c.distance_km != null ? round2(num(c.distance_km)) : null,
          status: titleCase(c.status)
        }))
        .sort((a: any, b: any) => a.date.localeCompare(b.date));
      return {
        columns: [
          { key: "claim_no", label: "Claim No" },
          { key: "date", label: "Date", type: "date" },
          ...EMP_COLS,
          { key: "purpose", label: "Purpose" },
          { key: "check_in", label: "Check-in" },
          { key: "check_out", label: "Check-out" },
          { key: "distance_km", label: "Distance (km)", type: "number" },
          { key: "status", label: "Status" }
        ],
        rows
      };
    }
  },

  // ---------------- Bill Claim ----------------
  {
    key: "bill_claims",
    category: "Bill",
    title: "Bill Claims",
    description: "Every bill claim with its period, categories, claimed and approved amount and review status.",
    modules: ["conveyance"],
    filters: ["date", "department", "employee", "status"],
    dateLabel: "Claim date",
    deptScope: "conveyance",
    statuses: [
      { value: "pending", label: "Pending" },
      { value: "approved", label: "Approved" },
      { value: "rejected", label: "Rejected" }
    ],
    async run({ from, to, queryDB, people, status }) {
      const [claims, items] = await Promise.all([
        queryDB(
          "SELECT id, user_id, claim_date, from_date, to_date, category, amount, approved_amount, status, admin_remarks, reviewed_by, reviewed_at, created_at FROM user_claims"
        ).catch(() => []),
        queryDB("SELECT user_claim_id, category_name, amount FROM user_claim_items").catch(() => [])
      ]);
      const itemsBy = new Map<number, any[]>();
      for (const it of items) {
        const k = Number(it.user_claim_id);
        if (!itemsBy.has(k)) itemsBy.set(k, []);
        itemsBy.get(k)!.push(it);
      }
      const rows = claims
        .filter((c: any) => inRange(d10(c.claim_date || c.created_at), from, to) && (!status || c.status === status))
        .map((c: any) => {
          const its = itemsBy.get(Number(c.id)) || [];
          const cats = its.length ? [...new Set(its.map((i: any) => i.category_name || ""))].filter(Boolean) : [c.category].filter(Boolean);
          return {
            claim_no: `BC-${c.id}`,
            claim_date: d10(c.claim_date || c.created_at),
            ...who(people, c.user_id),
            period_from: d10(c.from_date),
            period_to: d10(c.to_date || c.from_date),
            categories: cats.map(titleCase).join(", "),
            bills: its.length || 1,
            amount: round2(num(c.amount)),
            approved_amount: c.approved_amount != null ? round2(num(c.approved_amount)) : null,
            status: titleCase(c.status),
            reviewed_by: people.userName(c.reviewed_by),
            reviewed_at: dt16(c.reviewed_at),
            remarks: c.admin_remarks || ""
          };
        })
        .sort((a: any, b: any) => a.claim_date.localeCompare(b.claim_date));
      return {
        columns: [
          { key: "claim_no", label: "Claim No" },
          { key: "claim_date", label: "Claim Date", type: "date" },
          ...EMP_COLS,
          { key: "period_from", label: "Bills From", type: "date" },
          { key: "period_to", label: "Bills To", type: "date" },
          { key: "categories", label: "Categories" },
          { key: "bills", label: "Bills", type: "number" },
          { key: "amount", label: "Claimed", type: "money" },
          { key: "approved_amount", label: "Approved", type: "money" },
          { key: "status", label: "Status" },
          { key: "reviewed_by", label: "Reviewed By" },
          { key: "reviewed_at", label: "Reviewed At", type: "datetime" },
          { key: "remarks", label: "Remarks" }
        ],
        rows
      };
    }
  },
  {
    key: "bill_claim_categories",
    category: "Bill",
    title: "Bill Claim by Category",
    description: "Claimed amount per category (Food, Transport…) for the period — where the money goes.",
    modules: ["conveyance"],
    filters: ["date", "department", "employee", "status"],
    dateLabel: "Bill date",
    deptScope: "conveyance",
    statuses: [
      { value: "pending", label: "Pending" },
      { value: "approved", label: "Approved" },
      { value: "rejected", label: "Rejected" }
    ],
    async run({ from, to, queryDB, people, status }) {
      const [claims, items] = await Promise.all([
        queryDB("SELECT id, user_id, claim_date, category, amount, status, created_at FROM user_claims").catch(() => []),
        queryDB("SELECT user_claim_id, category_name, bill_date, amount FROM user_claim_items").catch(() => [])
      ]);
      const claimById = new Map<number, any>(claims.map((c: any) => [Number(c.id), c]));
      const withItems = new Set(items.map((i: any) => Number(i.user_claim_id)));
      // One line per bill: the claim's own bills, or the claim itself for an
      // older single-category claim.
      const lines: any[] = [];
      for (const it of items) {
        const c = claimById.get(Number(it.user_claim_id));
        if (c) lines.push({ c, category: it.category_name, date: d10(it.bill_date || c.claim_date), amount: num(it.amount) });
      }
      for (const c of claims) if (!withItems.has(Number(c.id))) lines.push({ c, category: c.category, date: d10(c.claim_date || c.created_at), amount: num(c.amount) });
      // Grouped per employee + category so the department / employee filters
      // still apply.
      const groups = new Map<string, any>();
      for (const l of lines) {
        if (!inRange(l.date, from, to) || (status && l.c.status !== status)) continue;
        const cat = titleCase(l.category || "Other");
        const k = `${l.c.user_id}|${cat}`;
        if (!groups.has(k)) groups.set(k, { ...who(people, l.c.user_id), category: cat, bills: 0, amount: 0 });
        const g = groups.get(k);
        g.bills += 1;
        g.amount = round2(g.amount + l.amount);
      }
      const rows = [...groups.values()].sort((a, b) => a.category.localeCompare(b.category) || b.amount - a.amount);
      return {
        columns: [
          { key: "category", label: "Category" },
          ...EMP_COLS,
          { key: "bills", label: "Bills", type: "number" },
          { key: "amount", label: "Amount", type: "money" }
        ],
        rows
      };
    }
  },

  // ---------------- Conveyance Bill & Disbursement ----------------
  {
    key: "conveyance_bills",
    category: "Bill",
    title: "Conveyance Bills",
    description: "Bills prepared from approved claims: items, distance, amount and whether each one is disbursed.",
    modules: ["conveyance", "disbursement"],
    filters: ["date", "department", "employee", "status"],
    dateLabel: "Bill date",
    statuses: [
      { value: "pending", label: "Awaiting disbursement" },
      { value: "disbursed", label: "Disbursed" }
    ],
    async run({ from, to, queryDB, people, status }) {
      const [bills, items] = await Promise.all([
        queryDB("SELECT * FROM conveyance_bills").catch(() => []),
        queryDB("SELECT bill_id, distance_km, amount FROM conveyance_bill_items").catch(() => [])
      ]);
      const agg = new Map<number, { n: number; km: number; amt: number }>();
      for (const it of items) {
        const k = Number(it.bill_id);
        const a = agg.get(k) || { n: 0, km: 0, amt: 0 };
        a.n += 1;
        a.km += num(it.distance_km);
        a.amt += num(it.amount);
        agg.set(k, a);
      }
      const rows = bills
        .filter((b: any) => {
          const disbursed = !!Number(b.is_disbursed);
          return inRange(d10(b.bill_date || b.created_at), from, to) && (!status || (status === "disbursed") === disbursed);
        })
        .map((b: any) => {
          const a = agg.get(Number(b.id)) || { n: 0, km: 0, amt: 0 };
          return {
            bill_no: `CB-${b.id}`,
            bill_date: d10(b.bill_date || b.created_at),
            ...who(people, b.user_id),
            items: a.n,
            distance_km: round2(a.km),
            amount: round2(a.amt),
            status: Number(b.is_disbursed) ? "Disbursed" : "Awaiting disbursement",
            voucher_no: b.voucher_no || "",
            disbursed_at: dt16(b.disbursed_at),
            prepared_by: people.userName(b.created_by)
          };
        })
        .sort((a: any, b: any) => a.bill_date.localeCompare(b.bill_date));
      return {
        columns: [
          { key: "bill_no", label: "Bill No" },
          { key: "bill_date", label: "Bill Date", type: "date" },
          ...EMP_COLS,
          { key: "items", label: "Items", type: "number" },
          { key: "distance_km", label: "Distance (km)", type: "number" },
          { key: "amount", label: "Amount", type: "money" },
          { key: "status", label: "Status" },
          { key: "voucher_no", label: "Voucher No" },
          { key: "disbursed_at", label: "Disbursed At", type: "datetime" },
          { key: "prepared_by", label: "Prepared By" }
        ],
        rows
      };
    }
  },
  {
    key: "bill_disbursements",
    category: "Bill",
    title: "Bill Disbursements",
    description: "Money paid out: voucher, date, who disbursed it and the amount, per bill.",
    modules: ["disbursement"],
    filters: ["date", "department", "employee"],
    dateLabel: "Disbursed date",
    async run({ from, to, queryDB, people }) {
      const [bills, items] = await Promise.all([
        queryDB("SELECT * FROM conveyance_bills").catch(() => []),
        queryDB("SELECT bill_id, amount FROM conveyance_bill_items").catch(() => [])
      ]);
      const amt = new Map<number, number>();
      for (const it of items) amt.set(Number(it.bill_id), (amt.get(Number(it.bill_id)) || 0) + num(it.amount));
      const rows = bills
        .filter((b: any) => Number(b.is_disbursed) && inRange(d10(b.disbursed_at), from, to))
        .map((b: any) => ({
          voucher_no: b.voucher_no || "",
          disbursed_at: dt16(b.disbursed_at),
          bill_no: `CB-${b.id}`,
          bill_date: d10(b.bill_date),
          ...who(people, b.user_id),
          amount: round2(amt.get(Number(b.id)) || 0),
          disbursed_by: people.userName(b.disbursed_by)
        }))
        .sort((a: any, b: any) => a.disbursed_at.localeCompare(b.disbursed_at));
      return {
        columns: [
          { key: "voucher_no", label: "Voucher No" },
          { key: "disbursed_at", label: "Disbursed At", type: "datetime" },
          { key: "bill_no", label: "Bill No" },
          { key: "bill_date", label: "Bill Date", type: "date" },
          ...EMP_COLS,
          { key: "amount", label: "Amount", type: "money" },
          { key: "disbursed_by", label: "Disbursed By" }
        ],
        rows
      };
    }
  },

  // ---------------- Leave ----------------
  {
    key: "leave_applications",
    category: "Leave",
    title: "Leave Applications",
    description: "Every application overlapping the period: type, dates, days, reliever and decision.",
    modules: ["leave_applications"],
    filters: ["date", "department", "employee", "status"],
    dateLabel: "Leave date",
    deptScope: "leave",
    statuses: [
      { value: "pending", label: "Pending" },
      { value: "approved", label: "Approved" },
      { value: "rejected", label: "Rejected" }
    ],
    async run({ from, to, queryDB, people, status }) {
      const [apps, label] = await Promise.all([queryDB("SELECT * FROM leave_applications").catch(() => []), leaveLabelFn(queryDB)]);
      const rows = apps
        .filter((a: any) => d10(a.start_date) <= to && d10(a.end_date || a.start_date) >= from && (!status || a.status === status))
        .map((a: any) => ({
          ...who(people, a.user_id),
          leave_type: label(a.leave_type),
          start_date: d10(a.start_date),
          end_date: d10(a.end_date),
          days: num(a.day_count),
          half_day: Number(a.is_half_day) ? "Yes" : "",
          purpose: a.purpose || "",
          apply_date: d10(a.apply_date || a.created_at),
          reliever: a.reliever_id ? `${people.userName(a.reliever_id)}${a.reliever_status ? ` (${titleCase(a.reliever_status)})` : ""}` : "",
          status: titleCase(a.status),
          decided_by: people.userName(a.decided_by),
          decided_at: dt16(a.decided_at)
        }))
        .sort((a: any, b: any) => a.start_date.localeCompare(b.start_date));
      return {
        columns: [
          ...EMP_COLS,
          { key: "leave_type", label: "Leave Type" },
          { key: "start_date", label: "From", type: "date" },
          { key: "end_date", label: "To", type: "date" },
          { key: "days", label: "Days", type: "number" },
          { key: "half_day", label: "Half Day" },
          { key: "purpose", label: "Purpose" },
          { key: "apply_date", label: "Applied On", type: "date" },
          { key: "reliever", label: "Reliever" },
          { key: "status", label: "Status" },
          { key: "decided_by", label: "Decided By" },
          { key: "decided_at", label: "Decided At", type: "datetime" }
        ],
        rows
      };
    }
  },
  {
    key: "leave_taken",
    category: "Leave",
    title: "Leave Taken by Type",
    description: "Approved leave days per employee, one column per leave type (days inside the period only).",
    modules: ["leave_applications"],
    filters: ["date", "department", "employee"],
    dateLabel: "Leave date",
    deptScope: "leave",
    async run({ from, to, queryDB, people }) {
      const [apps, label] = await Promise.all([queryDB("SELECT * FROM leave_applications").catch(() => []), leaveLabelFn(queryDB)]);
      const types = new Map<string, string>();
      const byUser = new Map<number, any>();
      for (const a of apps) {
        if (a.status !== "approved") continue;
        const s = d10(a.start_date);
        const e = d10(a.end_date || a.start_date);
        if (s > to || e < from) continue;
        // Days of this application that fall inside the period (scaled for a
        // half day / a day_count that differs from the calendar span).
        const span = Math.max(1, daysBetween(s, e));
        const inside = daysBetween(s > from ? s : from, e < to ? e : to);
        const days = round2((num(a.day_count) || span) * (inside / span));
        const t = String(a.leave_type || "other");
        types.set(t, label(t));
        const uid = Number(a.user_id);
        if (!byUser.has(uid)) byUser.set(uid, { ...who(people, uid), total: 0 });
        const r = byUser.get(uid);
        r[`t_${t}`] = round2((r[`t_${t}`] || 0) + days);
        r.total = round2(r.total + days);
      }
      const typeCols = [...types.entries()].sort((a, b) => a[1].localeCompare(b[1]));
      const rows = [...byUser.values()].sort((a, b) => b.total - a.total);
      return {
        columns: [
          ...EMP_COLS,
          ...typeCols.map(([t, l]) => ({ key: `t_${t}`, label: l, type: "number" as ColumnType })),
          { key: "total", label: "Total Days", type: "number" }
        ],
        rows
      };
    }
  },

  // ---------------- Asset ----------------
  {
    key: "asset_register",
    category: "Asset",
    title: "Asset Register",
    description: "Every asset with its status and who holds it now.",
    modules: ["asset_management"],
    filters: ["department", "employee", "status"],
    statuses: ["available", "assigned", "maintenance", "disposed"].map((v) => ({ value: v, label: titleCase(v) })),
    async run({ queryDB, people, status }) {
      const [assets, assigns] = await Promise.all([
        queryDB("SELECT * FROM assets").catch(() => []),
        queryDB("SELECT * FROM asset_assignments").catch(() => [])
      ]);
      const current = new Map<number, any>();
      for (const a of assigns) if (!a.returned_date) current.set(Number(a.asset_id), a);
      const rows = assets
        .filter((a: any) => !status || a.status === status)
        .map((a: any) => {
          const c = current.get(Number(a.id));
          return {
            asset_tag: a.asset_tag || "",
            name: a.name || "",
            asset_category: titleCase(a.category),
            serial_number: a.serial_number || "",
            purchase_date: d10(a.purchase_date),
            status: titleCase(a.status),
            ...(c ? who(people, c.employee_user_id) : { emp_code: "", employee: "", department: "" }),
            assigned_date: c ? d10(c.assigned_date) : "",
            acknowledged: c ? (c.acknowledged_at ? "Yes" : "Awaiting") : ""
          };
        })
        .sort((a: any, b: any) => a.asset_tag.localeCompare(b.asset_tag));
      return {
        columns: [
          { key: "asset_tag", label: "Tag" },
          { key: "name", label: "Asset" },
          { key: "asset_category", label: "Category" },
          { key: "serial_number", label: "Serial No" },
          { key: "purchase_date", label: "Purchased", type: "date" },
          { key: "status", label: "Status" },
          { key: "emp_code", label: "Holder ID" },
          { key: "employee", label: "Held By" },
          { key: "department", label: "Department" },
          { key: "assigned_date", label: "Assigned On", type: "date" },
          { key: "acknowledged", label: "Acknowledged" }
        ],
        rows
      };
    }
  },
  {
    key: "asset_assignments",
    category: "Asset",
    title: "Asset Handover History",
    description: "Every handover in the period: who got what, condition, acknowledgement and return.",
    modules: ["asset_management"],
    filters: ["date", "department", "employee", "status"],
    dateLabel: "Handover date",
    statuses: [
      { value: "held", label: "Still held" },
      { value: "returned", label: "Returned" }
    ],
    async run({ from, to, queryDB, people, status }) {
      const [assets, assigns] = await Promise.all([
        queryDB("SELECT id, asset_tag, name, category FROM assets").catch(() => []),
        queryDB("SELECT * FROM asset_assignments").catch(() => [])
      ]);
      const assetById = new Map<number, any>(assets.map((a: any) => [Number(a.id), a]));
      const rows = assigns
        .filter((a: any) => inRange(d10(a.assigned_date || a.created_at), from, to) && (!status || (status === "returned") === !!a.returned_date))
        .map((a: any) => {
          const as = assetById.get(Number(a.asset_id)) || {};
          return {
            assigned_date: d10(a.assigned_date || a.created_at),
            asset_tag: as.asset_tag || "",
            name: as.name || "",
            ...who(people, a.employee_user_id),
            quantity: a.quantity != null ? `${num(a.quantity)} ${a.unit || ""}`.trim() : "",
            condition: titleCase(a.condition_on_assign),
            acknowledged_at: dt16(a.acknowledged_at),
            returned_date: d10(a.returned_date),
            condition_on_return: titleCase(a.condition_on_return),
            assigned_by: people.userName(a.assigned_by)
          };
        })
        .sort((a: any, b: any) => a.assigned_date.localeCompare(b.assigned_date));
      return {
        columns: [
          { key: "assigned_date", label: "Handover", type: "date" },
          { key: "asset_tag", label: "Tag" },
          { key: "name", label: "Asset" },
          ...EMP_COLS,
          { key: "quantity", label: "Qty" },
          { key: "condition", label: "Condition" },
          { key: "acknowledged_at", label: "Acknowledged", type: "datetime" },
          { key: "returned_date", label: "Returned", type: "date" },
          { key: "condition_on_return", label: "Return Condition" },
          { key: "assigned_by", label: "Assigned By" }
        ],
        rows
      };
    }
  },
  {
    key: "asset_requisitions",
    category: "Asset",
    title: "Asset Requisitions",
    description: "Requests raised in the period: items, urgency, target date and where each one stands.",
    modules: ["asset_management"],
    filters: ["date", "department", "employee", "status"],
    dateLabel: "Requested date",
    statuses: ["pending", "manager_approved", "approved", "dispatched", "fulfilled", "rejected"].map((v) => ({ value: v, label: titleCase(v) })),
    async run({ from, to, queryDB, people, status }) {
      const [reqs, items] = await Promise.all([
        queryDB(
          "SELECT id, employee_user_id, asset_category, reason, urgency, target_date, status, manager_decided_at, admin_decided_at, rejection_reason, created_at FROM asset_requisitions"
        ).catch(() => []),
        queryDB("SELECT requisition_id, item_name, unit, quantity, removed_at FROM asset_requisition_items").catch(() => [])
      ]);
      const itemsBy = new Map<number, string[]>();
      for (const it of items) {
        if (it.removed_at) continue;
        const k = Number(it.requisition_id);
        if (!itemsBy.has(k)) itemsBy.set(k, []);
        itemsBy.get(k)!.push(`${it.item_name} × ${num(it.quantity)}${it.unit ? ` ${it.unit}` : ""}`);
      }
      const rows = reqs
        .filter((r: any) => inRange(d10(r.created_at), from, to) && (!status || r.status === status))
        .map((r: any) => ({
          req_no: `AR-${r.id}`,
          requested_on: d10(r.created_at),
          ...who(people, r.employee_user_id),
          items: (itemsBy.get(Number(r.id)) || []).join(", ") || titleCase(r.asset_category),
          reason: r.reason || "",
          urgency: titleCase(r.urgency),
          target_date: d10(r.target_date),
          status: titleCase(r.status),
          decided_at: dt16(r.admin_decided_at || r.manager_decided_at),
          rejection_reason: r.rejection_reason || ""
        }))
        .sort((a: any, b: any) => a.requested_on.localeCompare(b.requested_on));
      return {
        columns: [
          { key: "req_no", label: "Req No" },
          { key: "requested_on", label: "Requested", type: "date" },
          ...EMP_COLS,
          { key: "items", label: "Items" },
          { key: "reason", label: "Reason" },
          { key: "urgency", label: "Urgency" },
          { key: "target_date", label: "Target Date", type: "date" },
          { key: "status", label: "Status" },
          { key: "decided_at", label: "Decided At", type: "datetime" },
          { key: "rejection_reason", label: "Rejection Reason" }
        ],
        rows
      };
    }
  },

  // ---------------- Vehicle ----------------
  {
    key: "vehicle_rides",
    category: "Vehicle",
    title: "Ride History",
    description: "Every ride request: route, schedule, vehicle and driver, status and return time.",
    modules: ["vehicle_management"],
    filters: ["date", "department", "employee", "status"],
    dateLabel: "Ride date",
    statuses: ["pending", "approved", "ongoing", "completed", "rejected", "cancelled"].map((v) => ({ value: v, label: titleCase(v) })),
    async run({ from, to, queryDB, people, status }) {
      const [rides, vehicles] = await Promise.all([
        queryDB("SELECT * FROM vehicle_requisitions").catch(() => []),
        queryDB("SELECT id, vehicle_no, model FROM vehicles").catch(() => [])
      ]);
      const vehicleById = new Map<number, any>(vehicles.map((v: any) => [Number(v.id), v]));
      const rows = rides
        .filter((r: any) => inRange(d10(r.ride_date), from, to) && (!status || r.status === status))
        .map((r: any) => {
          const v = vehicleById.get(Number(r.assigned_vehicle_id));
          return {
            ride_no: `VR-${r.id}`,
            ride_date: d10(r.ride_date),
            start_time: String(r.start_time || "").slice(0, 5),
            ...who(people, r.employee_user_id),
            pickup: r.pickup_location || "",
            destination: r.destination || "",
            purpose: r.purpose || "",
            est_hours: num(r.estimated_duration_hours),
            vehicle: v ? `${v.vehicle_no}${v.model ? ` (${v.model})` : ""}` : "",
            driver: [r.driver_name, r.driver_mobile].filter(Boolean).join(" — "),
            status: titleCase(r.status),
            returned_at: dt16(r.actual_return_at),
            returned_late: r.actual_return_at ? (Number(r.returned_late) ? "Late" : "On time") : ""
          };
        })
        .sort((a: any, b: any) => (a.ride_date + a.start_time).localeCompare(b.ride_date + b.start_time));
      return {
        columns: [
          { key: "ride_no", label: "Ride No" },
          { key: "ride_date", label: "Date", type: "date" },
          { key: "start_time", label: "Start" },
          ...EMP_COLS,
          { key: "pickup", label: "Pickup" },
          { key: "destination", label: "Destination" },
          { key: "purpose", label: "Purpose" },
          { key: "est_hours", label: "Est. Hours", type: "number" },
          { key: "vehicle", label: "Vehicle" },
          { key: "driver", label: "Driver" },
          { key: "status", label: "Status" },
          { key: "returned_at", label: "Returned At", type: "datetime" },
          { key: "returned_late", label: "Return" }
        ],
        rows
      };
    }
  },
  {
    key: "vehicle_utilization",
    category: "Vehicle",
    title: "Vehicle Utilization",
    description: "Per vehicle: rides, hours on the road, late returns and current status.",
    modules: ["vehicle_management"],
    filters: ["date"],
    dateLabel: "Ride date",
    async run({ from, to, queryDB }) {
      const [rides, vehicles] = await Promise.all([
        queryDB("SELECT * FROM vehicle_requisitions").catch(() => []),
        queryDB("SELECT * FROM vehicles").catch(() => [])
      ]);
      const stats = new Map<number, { rides: number; completed: number; hours: number; late: number }>();
      for (const r of rides) {
        if (!r.assigned_vehicle_id || !inRange(d10(r.ride_date), from, to) || !["approved", "ongoing", "completed"].includes(r.status)) continue;
        const k = Number(r.assigned_vehicle_id);
        const s = stats.get(k) || { rides: 0, completed: 0, hours: 0, late: 0 };
        s.rides += 1;
        if (r.status === "completed") {
          s.completed += 1;
          const start = new Date(`${d10(r.ride_date)}T${String(r.start_time || "00:00").slice(0, 5)}:00`);
          const back = r.actual_return_at ? new Date(r.actual_return_at) : null;
          const h = back && !isNaN(start.getTime()) ? (back.getTime() - start.getTime()) / 3600000 : num(r.estimated_duration_hours);
          s.hours += h > 0 ? h : num(r.estimated_duration_hours);
          if (Number(r.returned_late)) s.late += 1;
        }
        stats.set(k, s);
      }
      const rows = vehicles
        .map((v: any) => {
          const s = stats.get(Number(v.id)) || { rides: 0, completed: 0, hours: 0, late: 0 };
          return {
            vehicle_no: v.vehicle_no || "",
            model: v.model || "",
            vehicle_type: titleCase(v.vehicle_type),
            current_status: titleCase(v.status),
            rides: s.rides,
            completed: s.completed,
            hours: round2(s.hours),
            late_returns: s.late
          };
        })
        .sort((a: any, b: any) => b.rides - a.rides);
      return {
        columns: [
          { key: "vehicle_no", label: "Vehicle No" },
          { key: "model", label: "Model" },
          { key: "vehicle_type", label: "Type" },
          { key: "current_status", label: "Now" },
          { key: "rides", label: "Rides", type: "number" },
          { key: "completed", label: "Completed", type: "number" },
          { key: "hours", label: "Hours on Road", type: "number" },
          { key: "late_returns", label: "Late Returns", type: "number" }
        ],
        rows
      };
    }
  }
];

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const CATEGORY_ORDER = ["Attendance", "Leave", "Claim", "Bill", "Asset", "Vehicle"];

export function registerReportsInsightsRoutes(app: Express, deps: ReportsInsightsDeps) {
  const { authenticateToken, requireAdmin, queryDB, getAdminModules, todayInDhaka, getDeptScope } = deps;

  const allowedReports = async (user: any): Promise<ReportDef[]> => {
    if (user.role === "superadmin") return REPORTS;
    const mods = new Set(await getAdminModules(user.id));
    return REPORTS.filter((r) => r.modules.some((m) => mods.has(m)));
  };

  app.get("/api/reports-insights/catalog", authenticateToken, requireAdmin, async (req: any, res: any) => {
    try {
      const list = await allowedReports(req.user);
      // Departments the caller may pick (the Department filter's dropdown).
      const emps: any[] = await queryDB("SELECT DISTINCT department FROM all_employees WHERE department IS NOT NULL AND department <> ''").catch(() => []);
      res.json({
        categories: CATEGORY_ORDER.filter((c) => list.some((r) => r.category === c)),
        reports: list.map((r) => ({
          key: r.key,
          category: r.category,
          title: r.title,
          description: r.description,
          filters: r.filters,
          dateLabel: r.dateLabel || "Date",
          maxDays: r.maxDays || null,
          statuses: r.statuses || []
        })),
        departments: emps.map((e: any) => e.department).sort((a: string, b: string) => a.localeCompare(b)),
        today: todayInDhaka()
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/reports-insights/run", authenticateToken, requireAdmin, async (req: any, res: any) => {
    try {
      const key = String(req.body?.key || "");
      const def = (await allowedReports(req.user)).find((r) => r.key === key);
      if (!def) return res.status(403).json({ error: "You don't have access to this report." });

      const today = todayInDhaka();
      const isDate = (s: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
      let from = isDate(req.body?.from) ? String(req.body.from) : `${today.slice(0, 7)}-01`;
      let to = isDate(req.body?.to) ? String(req.body.to) : today;
      if (from > to) [from, to] = [to, from];
      if (def.filters.includes("date") && def.maxDays && daysBetween(from, to) > def.maxDays) {
        return res.status(400).json({ error: `Pick a period of at most ${def.maxDays} days for this report.` });
      }
      const department = String(req.body?.department || "").trim();
      const employee = String(req.body?.employee || "").trim().toLowerCase();
      const status = String(req.body?.status || "").trim();

      // Department-wise scope carried over from the source module.
      const scope = def.deptScope && req.user.role !== "superadmin" ? await getDeptScope(def.deptScope, req.user.id) : null;
      if (scope && department && !scope.includes(department)) {
        return res.status(403).json({ error: "You don't have access to this Department." });
      }

      const people = await loadPeople(queryDB);
      const out = await def.run({ from, to, status: def.filters.includes("status") ? status : "", today, queryDB, people });
      let rows = out.rows;
      if (scope) {
        const allowed = new Set(scope);
        rows = rows.filter((r) => allowed.has(r.department));
      }
      if (department && def.filters.includes("department")) rows = rows.filter((r) => r.department === department);
      if (employee && def.filters.includes("employee")) {
        rows = rows.filter((r) => String(r.employee || "").toLowerCase().includes(employee) || String(r.emp_code || "").toLowerCase() === employee);
      }
      // Totals describe exactly the rows shown (after every filter).
      const summary = SUMMARIES[def.key]?.(rows) || [{ label: "Rows", value: rows.length }];
      res.json({
        key: def.key,
        title: def.title,
        category: def.category,
        from: def.filters.includes("date") ? from : null,
        to: def.filters.includes("date") ? to : null,
        columns: out.columns,
        rows,
        summary,
        generated_at: new Date().toISOString()
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}

// The totals strip above each report, computed from the rows actually shown.
const SUMMARIES: Record<string, (rows: any[]) => { label: string; value: string | number }[]> = {
  attendance_summary: (r) => [
    { label: "Employees", value: r.length },
    { label: "Present days", value: sum(r, "present") },
    { label: "Absent days", value: sum(r, "absent") },
    { label: "Late", value: sum(r, "late") }
  ],
  attendance_daily: (r) => [
    { label: "Present", value: r.filter((x) => x.status === "Present").length },
    { label: "Absent", value: r.filter((x) => x.status === "Absent").length },
    { label: "Leave", value: r.filter((x) => x.status === "Leave").length },
    { label: "Late", value: r.filter((x) => x.late && !x.waived).length }
  ],
  remote_attendance: (r) => [
    { label: "Check-ins", value: r.length },
    { label: "Not checked out", value: r.filter((x) => !x.check_out).length },
    { label: "Total hours", value: sum(r, "hours") }
  ],
  movement_claims: (r) => [
    { label: "Movements", value: r.length },
    { label: "Total distance (km)", value: sum(r, "distance_km") }
  ],
  bill_claims: (r) => [
    { label: "Claims", value: r.length },
    { label: "Claimed", value: sum(r, "amount") },
    { label: "Approved", value: sum(r, "approved_amount") },
    { label: "Pending", value: r.filter((x) => x.status === "Pending").length }
  ],
  bill_claim_categories: (r) => [{ label: "Total", value: sum(r, "amount") }],
  conveyance_bills: (r) => [
    { label: "Bills", value: r.length },
    { label: "Total", value: sum(r, "amount") },
    { label: "Awaiting disbursement", value: sum(r.filter((x) => x.status !== "Disbursed"), "amount") }
  ],
  bill_disbursements: (r) => [
    { label: "Payments", value: r.length },
    { label: "Total paid", value: sum(r, "amount") }
  ],
  leave_applications: (r) => [
    { label: "Applications", value: r.length },
    { label: "Approved days", value: sum(r.filter((x) => x.status === "Approved"), "days") },
    { label: "Pending", value: r.filter((x) => x.status === "Pending").length }
  ],
  leave_taken: (r) => [
    { label: "Employees on leave", value: r.length },
    { label: "Total days", value: sum(r, "total") }
  ],
  asset_register: (r) => [
    { label: "Assets", value: r.length },
    { label: "Assigned", value: r.filter((x) => x.status === "Assigned").length },
    { label: "Available", value: r.filter((x) => x.status === "Available").length },
    { label: "Maintenance", value: r.filter((x) => x.status === "Maintenance").length }
  ],
  asset_assignments: (r) => [
    { label: "Handovers", value: r.length },
    { label: "Not acknowledged", value: r.filter((x) => !x.acknowledged_at).length },
    { label: "Returned", value: r.filter((x) => x.returned_date).length }
  ],
  asset_requisitions: (r) => [
    { label: "Requests", value: r.length },
    { label: "Open", value: r.filter((x) => !["Fulfilled", "Rejected"].includes(x.status)).length },
    { label: "Fulfilled", value: r.filter((x) => x.status === "Fulfilled").length }
  ],
  vehicle_rides: (r) => [
    { label: "Rides", value: r.length },
    { label: "Completed", value: r.filter((x) => x.status === "Completed").length },
    { label: "Returned late", value: r.filter((x) => x.returned_late === "Late").length }
  ],
  vehicle_utilization: (r) => [
    { label: "Vehicles", value: r.length },
    { label: "Rides", value: sum(r, "rides") },
    { label: "Hours on road", value: sum(r, "hours") }
  ]
};
