/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employee 360 (Admin Panel -> HRM -> HR Operations -> Service Book) — one
// page that pulls together everything the app already knows about one
// Employee, section by section, plus the few records that had no home
// before:
//
//   Records (new, HR-maintained, hr_operations module):
//     hr_emp_experience — previous employers (company, designation, period,
//       last salary, reason for leaving, reference, experience certificate
//       file, "verified" tick),
//     hr_emp_education  — degrees / exams with certificate file + verified,
//     hr_emp_family     — family members, flagged as Nominee (with %),
//       Emergency Contact and/or Dependent,
//     hr_emp_training   — trainings attended (internal / external / online).
//
//   Read from the modules that own them (never duplicated):
//     service history (buildServiceBook), Document Vault files, Attendance
//     (remote check-ins + ZKTeco punches + holidays + approved leave, with
//     the Payroll late policy), Leave balances and applications, Conveyance
//     claims / bills / movement claims, Salary structures + Payroll
//     payslips + bonuses, Loans / advances, Assets, Disciplinary actions,
//     Performance reviews and the Exit request.
//
// Salary and loan figures are only returned to an account that also holds
// the Payroll module (Superadmin always does); everything else needs only
// hr_operations. The operations the page offers (HR Action, letter,
// document upload, loan, disciplinary action…) call each owning module's
// existing endpoint, so that module's own permission and workflow still
// apply — this file only adds the four record types above.
//
// Same data-access convention as HROperationsRoutes.ts: reads are
// `SELECT * FROM x` (optionally narrowed by one `WHERE col = ?`) and always
// re-filtered in JS, writes only ever use `WHERE id = ?`.

import type { Express } from "express";
import { getHolidayMapsByGroup, getEmployeeBranchTypeMap, getEmployeeBranchTypeByEmployeeId, type HolidayAppliesTo } from "./holidayRoutes";
import { loadSiteEntries } from "./SiteAttendanceRoutes";
import { buildServiceBook, loadEmployeeWorld, loadSettings, snapshotOf, currentValues, toDate, num, monthsBetween } from "./HROperationsRoutes";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface Employee360RouteDeps {
  authenticateToken: any;
  requireModule: (moduleKey: "hr_operations") => any;
  queryDB: QueryDB;
  getAdminModules: (userId: number) => Promise<string[]>;
  todayInDhaka: () => string;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FILE_COLUMNS = `
        file_name VARCHAR(255) NULL,
        file_mime VARCHAR(100) NULL,
        file_data LONGBLOB NULL,`;
const VERIFY_COLUMNS = `
        verified TINYINT(1) NOT NULL DEFAULT 0,
        verified_by INT NULL,
        verified_at TIMESTAMP NULL DEFAULT NULL,
        verify_note VARCHAR(500) NULL,`;

export async function ensureEmployee360Schema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  const tables: [string, string][] = [
    [
      "hr_emp_experience",
      `CREATE TABLE IF NOT EXISTS hr_emp_experience (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        company_name VARCHAR(200) NOT NULL,
        company_business VARCHAR(150) NULL,
        location VARCHAR(200) NULL,
        designation VARCHAR(150) NULL,
        department VARCHAR(150) NULL,
        from_date DATE NULL,
        to_date DATE NULL,
        responsibilities TEXT NULL,
        last_salary DECIMAL(12, 2) NULL,
        leaving_reason VARCHAR(500) NULL,
        reference_name VARCHAR(150) NULL,
        reference_contact VARCHAR(150) NULL,${VERIFY_COLUMNS}${FILE_COLUMNS}
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE
      )`
    ],
    [
      "hr_emp_education",
      `CREATE TABLE IF NOT EXISTS hr_emp_education (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        level VARCHAR(60) NULL,
        degree VARCHAR(150) NOT NULL,
        major VARCHAR(150) NULL,
        institute VARCHAR(200) NULL,
        board_university VARCHAR(150) NULL,
        passing_year INT NULL,
        result VARCHAR(60) NULL,
        duration VARCHAR(60) NULL,${VERIFY_COLUMNS}${FILE_COLUMNS}
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE
      )`
    ],
    [
      "hr_emp_family",
      `CREATE TABLE IF NOT EXISTS hr_emp_family (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        name VARCHAR(150) NOT NULL,
        relation VARCHAR(60) NULL,
        date_of_birth DATE NULL,
        occupation VARCHAR(150) NULL,
        phone VARCHAR(60) NULL,
        nid VARCHAR(60) NULL,
        address VARCHAR(500) NULL,
        is_nominee TINYINT(1) NOT NULL DEFAULT 0,
        nominee_percent DECIMAL(5, 2) NULL,
        is_emergency TINYINT(1) NOT NULL DEFAULT 0,
        is_dependent TINYINT(1) NOT NULL DEFAULT 0,
        remarks VARCHAR(500) NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE
      )`
    ],
    [
      "hr_emp_training",
      `CREATE TABLE IF NOT EXISTS hr_emp_training (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        title VARCHAR(200) NOT NULL,
        training_type VARCHAR(30) NULL,
        organizer VARCHAR(200) NULL,
        location VARCHAR(200) NULL,
        from_date DATE NULL,
        to_date DATE NULL,
        hours DECIMAL(6, 1) NULL,
        cost DECIMAL(12, 2) NULL,
        result VARCHAR(100) NULL,
        certificate_no VARCHAR(100) NULL,
        remarks VARCHAR(500) NULL,${FILE_COLUMNS}
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE
      )`
    ]
  ];
  for (const [name, ddl] of tables) {
    try {
      await dbPool.query(ddl);
    } catch (err: any) {
      console.warn(`⚠️ Could not ensure ${name} table exists: ` + err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Record types (the four new tables) — one field list drives validation,
// INSERT and UPDATE so they can't drift apart.
// ---------------------------------------------------------------------------

type FieldType = "text" | "date" | "money" | "int" | "bool";
interface RecordSpec {
  table: string;
  label: string;
  required: string[];
  fields: Record<string, { type: FieldType; max?: number }>;
  hasFile: boolean;
  hasVerify: boolean;
}

export const RECORD_SPECS: Record<string, RecordSpec> = {
  experience: {
    table: "hr_emp_experience",
    label: "Experience",
    required: ["company_name"],
    hasFile: true,
    hasVerify: true,
    fields: {
      company_name: { type: "text", max: 200 },
      company_business: { type: "text", max: 150 },
      location: { type: "text", max: 200 },
      designation: { type: "text", max: 150 },
      department: { type: "text", max: 150 },
      from_date: { type: "date" },
      to_date: { type: "date" },
      responsibilities: { type: "text", max: 4000 },
      last_salary: { type: "money" },
      leaving_reason: { type: "text", max: 500 },
      reference_name: { type: "text", max: 150 },
      reference_contact: { type: "text", max: 150 }
    }
  },
  education: {
    table: "hr_emp_education",
    label: "Education",
    required: ["degree"],
    hasFile: true,
    hasVerify: true,
    fields: {
      level: { type: "text", max: 60 },
      degree: { type: "text", max: 150 },
      major: { type: "text", max: 150 },
      institute: { type: "text", max: 200 },
      board_university: { type: "text", max: 150 },
      passing_year: { type: "int" },
      result: { type: "text", max: 60 },
      duration: { type: "text", max: 60 }
    }
  },
  family: {
    table: "hr_emp_family",
    label: "Family / Nominee",
    required: ["name"],
    hasFile: false,
    hasVerify: false,
    fields: {
      name: { type: "text", max: 150 },
      relation: { type: "text", max: 60 },
      date_of_birth: { type: "date" },
      occupation: { type: "text", max: 150 },
      phone: { type: "text", max: 60 },
      nid: { type: "text", max: 60 },
      address: { type: "text", max: 500 },
      is_nominee: { type: "bool" },
      nominee_percent: { type: "money" },
      is_emergency: { type: "bool" },
      is_dependent: { type: "bool" },
      remarks: { type: "text", max: 500 }
    }
  },
  training: {
    table: "hr_emp_training",
    label: "Training",
    required: ["title"],
    hasFile: true,
    hasVerify: false,
    fields: {
      title: { type: "text", max: 200 },
      training_type: { type: "text", max: 30 },
      organizer: { type: "text", max: 200 },
      location: { type: "text", max: 200 },
      from_date: { type: "date" },
      to_date: { type: "date" },
      hours: { type: "money" },
      cost: { type: "money" },
      result: { type: "text", max: 100 },
      certificate_no: { type: "text", max: 100 },
      remarks: { type: "text", max: 500 }
    }
  }
};

function cleanValue(type: FieldType, v: any, max?: number): any {
  if (type === "bool") return v === true || v === 1 || v === "1" || v === "true" ? 1 : 0;
  if (v === undefined || v === null || v === "") return null;
  if (type === "date") return toDate(v);
  if (type === "money") return num(v);
  if (type === "int") return num(v) === null ? null : Math.round(Number(v));
  return String(v).trim().slice(0, max || 255) || null;
}

// A record as sent to the browser — never carries file_data itself.
function publicRecord(r: any, userName: (id: any) => string | null) {
  const out: any = { ...r, id: Number(r.id), employee_id: Number(r.employee_id) };
  delete out.file_data;
  out.has_file = !!r.file_data || !!r.file_name;
  for (const k of ["from_date", "to_date", "date_of_birth"]) if (k in out) out[k] = toDate(out[k]);
  if ("verified" in out) {
    out.verified = !!Number(out.verified);
    out.verified_by_name = r.verified_by ? userName(r.verified_by) : null;
  }
  for (const k of ["is_nominee", "is_emergency", "is_dependent"]) if (k in out) out[k] = !!Number(out[k]);
  for (const k of ["last_salary", "nominee_percent", "hours", "cost"]) if (k in out && out[k] != null) out[k] = Number(out[k]);
  return out;
}

// Months covered by a list of [from, to] periods, overlaps counted once.
export function coveredMonths(periods: { from: string | null; to: string | null }[], today: string): number {
  const ranges = periods
    .filter((p) => p.from)
    .map((p) => [p.from as string, p.to && p.to < today ? p.to : today] as [string, string])
    .filter(([a, b]) => a <= b)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const merged: [string, string][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) {
      if (r[1] > last[1]) last[1] = r[1];
    } else merged.push([r[0], r[1]]);
  }
  // Periods are inclusive (1 Jan – 31 Dec is 12 months), so count to the
  // day after the end date.
  const dayAfter = (d: string) => {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + 1);
    return x.toISOString().slice(0, 10);
  };
  return merged.reduce((s, [a, b]) => s + Math.max(0, monthsBetween(a, dayAfter(b))), 0);
}

// The required-document list (HR Ops Settings -> required_documents, one
// per line) and which of them an Employee has no upload for. A Document
// Vault type matches when either name contains the other, ignoring case
// and punctuation ("NID Card" covers "NID").
export function requiredDocuments(settings: Record<string, string>): string[] {
  return String(settings.required_documents || "")
    .split(/\n|,/)
    .map((x) => x.trim())
    .filter(Boolean);
}
export function missingDocuments(required: string[], docTypes: string[]): string[] {
  const norm = (x: string) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return required.filter((r) => !docTypes.some((t) => norm(t) && (norm(t).includes(norm(r)) || norm(r).includes(norm(t)))));
}

// Leave type key -> label ("casual" -> "Casual Leave", custom categories by
// their own label).
export async function leaveLabelFn(queryDB: QueryDB): Promise<(k: string) => string> {
  const cats: any[] = await queryDB("SELECT * FROM leave_categories").catch(() => []);
  const fixed: Record<string, string> = { casual: "Casual Leave", sick: "Sick Leave", without_pay: "Leave Without Pay" };
  return (k: string) => fixed[k] || cats.find((c: any) => c.category_key === k)?.label || String(k || "").replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Attendance — the same sources Payroll reads (Remote check-ins, ZKTeco
// punches, holiday calendar per Branch type, approved leave, late policy +
// waivers), day by day.
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes();
const hhmm = (d: Date | null) => (d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : null);

export async function rowsFor(queryDB: QueryDB, table: string, column: string, value: any): Promise<any[]> {
  // Narrowed by one indexed column in MySQL; always re-filtered here since
  // the in-memory fallback DB may hand back the whole table.
  const rows: any[] = await queryDB(`SELECT * FROM ${table} WHERE ${column} = ?`, [value]).catch(() =>
    queryDB(`SELECT * FROM ${table}`).catch(() => [])
  );
  return (rows || []).filter((r: any) => String(r[column]) === String(value));
}

export interface AttendanceDay {
  date: string;
  weekday: number;
  status: "present" | "absent" | "leave" | "holiday" | "weekend" | "future" | "not_joined" | "separated";
  holiday: string | null;
  in: string | null;
  out: string | null;
  late: "late" | "extreme" | null;
  waived: boolean;
  leave_type: string | null;
  source: string | null;
  correction: string | null;
}

// Every attendance input for a date range, indexed for per-employee lookup.
// With `emp` it reads only that Employee's rows (Employee 360); without, the
// whole company's rows for the range in one query per table (Employee
// Reports, HrOpsReportsRoutes.ts).
export interface AttendanceData {
  branchTypes: Map<number, HolidayAppliesTo>;
  // Keyed by all_employees.id — covers Employees with no login too.
  branchByEmployee: Map<number, HolidayAppliesTo>;
  holidays: Record<HolidayAppliesTo, Map<string, { day_type: string; title: string }>>;
  remoteByUser: Map<number, any[]>;
  punchesByPin: Map<string, any[]>;
  leavesByUser: Map<number, any[]>;
  correctionsByUser: Map<number, any[]>;
  waiversByEmployee: Map<number, any[]>;
  // Confirmed Site Attendance (supervisor muster roll) entries.
  siteByEmployee: Map<number, any[]>;
  policies: any[];
}

const indexBy = <K>(rows: any[], key: (r: any) => K | null) => {
  const m = new Map<K, any[]>();
  for (const r of rows) {
    const k = key(r);
    if (k === null || k === undefined) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
};

async function rowsInRange(queryDB: QueryDB, table: string, column: string, from: string, to: string): Promise<any[]> {
  return (await queryDB(`SELECT * FROM ${table} WHERE ${column} BETWEEN ? AND ?`, [from, to]).catch(() => queryDB(`SELECT * FROM ${table}`).catch(() => []))) || [];
}

export async function loadAttendanceData(queryDB: QueryDB, from: string, to: string, emp?: any): Promise<AttendanceData> {
  const userId = emp?.user_id ? Number(emp.user_id) : null;
  const [branchTypes, branchByEmployee, holidays, remote, punches, leaves, corrections, waivers, policies, site] = await Promise.all([
    getEmployeeBranchTypeMap(queryDB),
    getEmployeeBranchTypeByEmployeeId(queryDB),
    getHolidayMapsByGroup(queryDB, from, to),
    emp ? (userId ? rowsFor(queryDB, "attendance", "user_id", userId) : Promise.resolve([])) : rowsInRange(queryDB, "attendance", "attendance_date", from, to),
    emp
      ? emp.zk_device_pin
        ? rowsFor(queryDB, "zk_attendance_logs", "device_user_pin", emp.zk_device_pin)
        : Promise.resolve([])
      : rowsInRange(queryDB, "zk_attendance_logs", "punch_time", `${from} 00:00:00`, `${to} 23:59:59`),
    emp ? (userId ? rowsFor(queryDB, "leave_applications", "user_id", userId) : Promise.resolve([])) : queryDB("SELECT * FROM leave_applications").catch(() => []),
    emp ? (userId ? rowsFor(queryDB, "attendance_corrections", "user_id", userId) : Promise.resolve([])) : rowsInRange(queryDB, "attendance_corrections", "attendance_date", from, to),
    emp ? rowsFor(queryDB, "late_waivers", "employee_id", Number(emp.id)) : rowsInRange(queryDB, "late_waivers", "waiver_date", from, to),
    queryDB("SELECT * FROM late_policy_settings").catch(() => []),
    loadSiteEntries(queryDB, from, to, emp ? Number(emp.id) : undefined)
  ]);
  return {
    branchTypes,
    branchByEmployee,
    holidays: holidays as AttendanceData["holidays"],
    remoteByUser: indexBy<number>(remote, (r) => (r.user_id != null ? Number(r.user_id) : null)),
    punchesByPin: indexBy<string>(punches, (r) => (r.device_user_pin != null ? String(r.device_user_pin) : null)),
    leavesByUser: indexBy<number>(leaves, (r) => (r.user_id != null ? Number(r.user_id) : null)),
    correctionsByUser: indexBy<number>(corrections, (r) => (r.user_id != null ? Number(r.user_id) : null)),
    waiversByEmployee: indexBy<number>(waivers, (r) => (r.employee_id != null ? Number(r.employee_id) : null)),
    siteByEmployee: indexBy<number>(site, (r) => (r.employee_id != null ? Number(r.employee_id) : null)),
    policies
  };
}

// One Employee's days in [from, to] — present / absent / leave / holiday…,
// first-in / last-out and late marks (Payroll's late policy and waivers).
export function computeAttendanceDays(data: AttendanceData, emp: any, from: string, to: string, today: string, leaveLabel: (k: string) => string): AttendanceDay[] {
  const userId = emp.user_id ? Number(emp.user_id) : null;
  const group: HolidayAppliesTo = data.branchByEmployee.get(Number(emp.id)) || (userId && data.branchTypes.get(userId)) || "head_office";
  const holidays = data.holidays[group];
  const joining = toDate(emp.joining_date);
  const lastDay = Number(emp.is_active ?? 1) === 0 ? toDate(emp.job_status_effective_date) || toDate(emp.status_effective_date) : null;

  const firstIn = new Map<string, Date>();
  const lastOut = new Map<string, Date>();
  const source = new Map<string, Set<string>>();
  const note = (d: string, s: string) => {
    if (!source.has(d)) source.set(d, new Set());
    source.get(d)!.add(s);
  };
  const keepIn = (d: string, t: Date) => {
    const cur = firstIn.get(d);
    if (!cur || t < cur) firstIn.set(d, t);
  };
  const keepOut = (d: string, t: Date) => {
    const cur = lastOut.get(d);
    if (!cur || t > cur) lastOut.set(d, t);
  };

  const remote = userId ? data.remoteByUser.get(userId) || [] : [];
  const punches = emp.zk_device_pin ? data.punchesByPin.get(String(emp.zk_device_pin)) || [] : [];
  const leaves = userId ? data.leavesByUser.get(userId) || [] : [];
  const corrections = userId ? data.correctionsByUser.get(userId) || [] : [];
  const waivers = data.waiversByEmployee.get(Number(emp.id)) || [];
  const policies = data.policies;
  for (const r of remote) {
    const d = toDate(r.attendance_date);
    if (!d || d < from || d > to || !r.check_in_at) continue;
    keepIn(d, new Date(r.check_in_at));
    if (r.check_out_at) keepOut(d, new Date(r.check_out_at));
    note(d, "Remote");
  }
  for (const p of punches) {
    if (!p.punch_time) continue;
    const t = new Date(p.punch_time);
    const d = ymd(t);
    if (d < from || d > to) continue;
    keepIn(d, t);
    keepOut(d, t);
    note(d, "Office device");
  }
  // Site Attendance: Present without a time still counts as present (at the
  // shift start, so never late); Late carries the arrival time; Leave is a
  // supervisor-recorded leave day; Absent is simply no attendance.
  const sitePresent = new Set<string>();
  const siteLeave = new Set<string>();
  for (const e of data.siteByEmployee.get(Number(emp.id)) || []) {
    const d = toDate(e.attendance_date);
    if (!d || d < from || d > to) continue;
    if (e.status === "leave") {
      siteLeave.add(d);
      continue;
    }
    if (e.status !== "present" && e.status !== "late") continue;
    sitePresent.add(d);
    if (e.in_time) keepIn(d, new Date(`${d}T${e.in_time}:00`));
    if (e.out_time) keepOut(d, new Date(`${d}T${e.out_time}:00`));
    note(d, "Site supervisor");
  }
  const leaveByDay = new Map<string, string>();
  for (const l of leaves) {
    if (l.status !== "approved") continue;
    const s = toDate(l.start_date);
    const e = toDate(l.end_date);
    if (!s || !e || e < from || s > to) continue;
    for (let d = new Date(`${s < from ? from : s}T00:00:00`); ymd(d) <= (e > to ? to : e); d.setDate(d.getDate() + 1)) leaveByDay.set(ymd(d), leaveLabel(l.leave_type));
  }
  for (const d of siteLeave) if (!leaveByDay.has(d)) leaveByDay.set(d, "Leave (site)");
  const correctionByDay = new Map<string, string>();
  for (const c of corrections) {
    const d = toDate(c.attendance_date);
    if (d && d >= from && d <= to) correctionByDay.set(d, c.status);
  }
  const waived = new Set(waivers.map((w: any) => toDate(w.waiver_date)));
  const policyFor = (d: string) =>
    policies
      .filter((p: any) => (toDate(p.effective_date) || "") <= `${d.slice(0, 7)}-01`)
      .sort((a: any, b: any) => (toDate(b.effective_date) || "").localeCompare(toDate(a.effective_date) || "") || Number(b.id) - Number(a.id))[0] || {
      shift_start_time: "09:00:00",
      grace_minutes: 10,
      extreme_grace_minutes: 60
    };

  const days: AttendanceDay[] = [];
  for (let dt = new Date(`${from}T00:00:00`); ymd(dt) <= to; dt.setDate(dt.getDate() + 1)) {
    const d = ymd(dt);
    const hol = holidays.get(d) || null;
    const inAt = firstIn.get(d) || null;
    const outAt = lastOut.get(d) || null;
    let status: AttendanceDay["status"];
    if (joining && d < joining) status = "not_joined";
    else if (lastDay && d > lastDay) status = "separated";
    else if (inAt || sitePresent.has(d)) status = "present";
    else if (hol) status = hol.day_type === "weekend" ? "weekend" : "holiday";
    else if (leaveByDay.has(d)) status = "leave";
    else if (d > today) status = "future";
    else status = "absent";
    let late: AttendanceDay["late"] = null;
    if (inAt && !hol) {
      const pol = policyFor(d);
      const [h, m] = String(pol.shift_start_time || "09:00").split(":").map(Number);
      const mins = minutesOf(inAt);
      if (mins > h * 60 + m + Number(pol.extreme_grace_minutes ?? 60)) late = "extreme";
      else if (mins > h * 60 + m + Number(pol.grace_minutes ?? 10)) late = "late";
    }
    days.push({
      date: d,
      weekday: dt.getDay(),
      status,
      holiday: hol ? hol.title || (hol.day_type === "weekend" ? "Weekend" : "Holiday") : null,
      in: hhmm(inAt),
      out: outAt && inAt && outAt.getTime() !== inAt.getTime() ? hhmm(outAt) : null,
      late,
      waived: !!late && waived.has(d),
      leave_type: leaveByDay.get(d) || null,
      source: source.has(d) ? [...source.get(d)!].join(" + ") : null,
      correction: correctionByDay.get(d) || null
    });
  }
  return days;
}

export function summarizeDays(days: AttendanceDay[]) {
  const count = (s: string) => days.filter((d) => d.status === s).length;
  const present = count("present");
  const absent = count("absent");
  const leave = count("leave");
  const working = present + absent + leave;
  return {
    working_days: working,
    present,
    absent,
    leave,
    holidays: count("holiday") + count("weekend"),
    late: days.filter((d) => d.late === "late" && !d.waived).length,
    extreme_late: days.filter((d) => d.late === "extreme" && !d.waived).length,
    attendance_percent: working ? Math.round(((present + leave) / working) * 1000) / 10 : null
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const SECTIONS = ["records", "documents", "attendance", "attendance_year", "leave", "claims", "salary", "loans", "assets", "discipline", "performance"] as const;
const PAYROLL_SECTIONS = new Set(["salary", "loans"]);

export function registerEmployee360Routes(app: Express, deps: Employee360RouteDeps) {
  const { authenticateToken, requireModule, queryDB, getAdminModules, todayInDhaka } = deps;
  const gate = [authenticateToken, requireModule("hr_operations")];
  const fail = (res: any, err: any, status = 500) => res.status(err?.statusCode || status).json({ error: err?.message || String(err) });
  const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

  // Which other modules the viewer holds — decides what the page shows
  // (salary/loans) and which operations it offers.
  async function viewerModules(req: any): Promise<Set<string>> {
    if (req.user.role === "superadmin") return new Set(["*"]);
    return new Set(await getAdminModules(Number(req.user.id)).catch(() => []));
  }
  const has = (mods: Set<string>, key: string) => mods.has("*") || mods.has(key);

  async function employeeRow(id: number) {
    const rows: any[] = await queryDB("SELECT * FROM all_employees");
    const e = rows.find((x: any) => Number(x.id) === id);
    if (!e) throw bad("Employee not found.", 404);
    return e;
  }
  async function userNames() {
    const users: any[] = await queryDB("SELECT * FROM users").catch(() => []);
    const byId = new Map<number, string>(users.map((u: any) => [Number(u.id), u.name]));
    return (id: any) => (id ? byId.get(Number(id)) || null : null);
  }
  const leaveLabeler = () => leaveLabelFn(queryDB);

  // ---- section builders ----
  async function recordsSection(empId: number) {
    const userName = await userNames();
    const out: Record<string, any[]> = {};
    for (const [kind, spec] of Object.entries(RECORD_SPECS)) {
      const rows = await rowsFor(queryDB, spec.table, "employee_id", empId);
      out[kind] = rows.map((r) => publicRecord(r, userName));
    }
    out.experience.sort((a, b) => (b.from_date || "").localeCompare(a.from_date || ""));
    out.education.sort((a, b) => Number(b.passing_year || 0) - Number(a.passing_year || 0));
    out.training.sort((a, b) => (b.from_date || "").localeCompare(a.from_date || ""));
    const today = todayInDhaka();
    const prior = coveredMonths(out.experience.map((x) => ({ from: x.from_date, to: x.to_date || x.from_date })), today);
    return { experience: out.experience, education: out.education, family: out.family, training: out.training, prior_experience_months: prior };
  }

  async function documentsSection(emp: any) {
    const settings = await loadSettings(queryDB);
    const userName = await userNames();
    const docs = emp.user_id ? await rowsFor(queryDB, "employee_documents", "user_id", Number(emp.user_id)) : [];
    const signatures: any[] = await queryDB("SELECT * FROM document_signatures").catch(() => []);
    const signed = new Set(signatures.map((s: any) => Number(s.document_id)));
    const today = todayInDhaka();
    const list = docs
      .map((d: any) => ({
        id: Number(d.id),
        doc_type: d.doc_type,
        file_name: d.file_name,
        file_mimetype: d.file_mimetype,
        expiry_date: toDate(d.expiry_date),
        expired: !!toDate(d.expiry_date) && toDate(d.expiry_date)! < today,
        requires_signature: !!Number(d.requires_signature),
        is_signed: signed.has(Number(d.id)),
        uploaded_at: d.uploaded_at,
        uploaded_by_name: userName(d.uploaded_by)
      }))
      .sort((a: any, b: any) => b.id - a.id);
    const required = requiredDocuments(settings);
    const missing = missingDocuments(required, list.map((d: any) => d.doc_type));
    return { documents: list, required, missing, linked: !!emp.user_id };
  }

  async function attendanceSection(emp: any, month: string) {
    const [y, m] = month.split("-").map(Number);
    const from = `${month}-01`;
    const to = `${month}-${pad(new Date(y, m, 0).getDate())}`;
    const days = computeAttendanceDays(await loadAttendanceData(queryDB, from, to, emp), emp, from, to, todayInDhaka(), await leaveLabeler());
    return { month, days, summary: summarizeDays(days), linked: !!emp.user_id || !!emp.zk_device_pin };
  }

  async function attendanceYearSection(emp: any, year: number) {
    const today = todayInDhaka();
    const to = `${year}-12-31` < today ? `${year}-12-31` : today;
    if (`${year}-01-01` > today) return { year, months: [] };
    const days = computeAttendanceDays(await loadAttendanceData(queryDB, `${year}-01-01`, to, emp), emp, `${year}-01-01`, to, today, await leaveLabeler());
    const months = [];
    for (let mo = 1; mo <= 12; mo++) {
      const key = `${year}-${pad(mo)}`;
      const md = days.filter((d) => d.date.startsWith(key));
      if (md.length) months.push({ month: key, ...summarizeDays(md) });
    }
    return { year, months, total: summarizeDays(days) };
  }

  async function leaveSection(emp: any, year: number) {
    if (!emp.user_id) return { linked: false, year, balances: [], applications: [] };
    const uid = Number(emp.user_id);
    const label = await leaveLabeler();
    const userName = await userNames();
    const [bal, catBal, cats, apps] = await Promise.all([
      rowsFor(queryDB, "leave_balances", "user_id", uid),
      rowsFor(queryDB, "leave_category_balances", "user_id", uid),
      queryDB("SELECT * FROM leave_categories").catch(() => []),
      rowsFor(queryDB, "leave_applications", "user_id", uid)
    ]);
    const yearApps = apps.filter((a: any) => (toDate(a.start_date) || "").startsWith(String(year)));
    const used = (key: string, status: string) =>
      yearApps.filter((a: any) => a.leave_type === key && a.status === status).reduce((s: number, a: any) => s + Number(a.day_count || 0), 0);
    const b = bal[0];
    const balances = [
      { key: "casual", label: label("casual"), balance: b ? Number(b.casual_leave) : 0 },
      { key: "sick", label: label("sick"), balance: b ? Number(b.sick_leave) : 0 },
      { key: "without_pay", label: label("without_pay"), balance: b ? Number(b.leave_without_pay) : 0 },
      ...catBal.map((cb: any) => {
        const c = cats.find((x: any) => Number(x.id) === Number(cb.category_id));
        return c ? { key: c.category_key, label: c.label, balance: Number(cb.balance) } : null;
      })
    ]
      .filter(Boolean)
      .map((x: any) => ({ ...x, taken: used(x.key, "approved"), pending: used(x.key, "pending") }));
    // Any leave type that was used this year but has no balance row.
    for (const a of yearApps) {
      if (!balances.some((x: any) => x.key === a.leave_type)) balances.push({ key: a.leave_type, label: label(a.leave_type), balance: 0, taken: used(a.leave_type, "approved"), pending: used(a.leave_type, "pending") });
    }
    return {
      linked: true,
      year,
      balances,
      applications: apps
        .map((a: any) => ({
          id: Number(a.id),
          leave_type: a.leave_type,
          leave_label: label(a.leave_type),
          start_date: toDate(a.start_date),
          end_date: toDate(a.end_date),
          day_count: Number(a.day_count || 0),
          purpose: a.purpose || null,
          status: a.status,
          apply_date: toDate(a.apply_date) || toDate(a.created_at),
          decided_by: userName(a.decided_by),
          remarks: a.remarks || null
        }))
        .sort((x: any, y: any) => (y.start_date || "").localeCompare(x.start_date || ""))
    };
  }

  async function claimsSection(emp: any, year: number) {
    if (!emp.user_id) return { linked: false, year, claims: [], bills: [], movements: [], totals: null };
    const uid = Number(emp.user_id);
    const inYear = (d: any) => (toDate(d) || "").startsWith(String(year));
    const [claims, bills, items, moves] = await Promise.all([
      rowsFor(queryDB, "user_claims", "user_id", uid),
      rowsFor(queryDB, "conveyance_bills", "user_id", uid),
      queryDB("SELECT * FROM conveyance_bill_items").catch(() => []),
      rowsFor(queryDB, "claims", "user_id", uid)
    ]);
    const claimRows = claims
      .filter((c: any) => inYear(c.claim_date))
      .map((c: any) => ({
        id: Number(c.id),
        claim_date: toDate(c.claim_date),
        from_date: toDate(c.from_date),
        to_date: toDate(c.to_date),
        category: c.category,
        amount: Number(c.amount || 0),
        approved_amount: c.approved_amount != null ? Number(c.approved_amount) : null,
        description: c.description || null,
        status: c.status,
        admin_remarks: c.admin_remarks || null
      }))
      .sort((a: any, b: any) => (b.claim_date || "").localeCompare(a.claim_date || ""));
    const billRows = bills
      .filter((b: any) => inYear(b.bill_date))
      .map((b: any) => {
        const its = items.filter((i: any) => Number(i.bill_id) === Number(b.id));
        return {
          id: Number(b.id),
          bill_date: toDate(b.bill_date),
          items: its.length,
          amount: its.reduce((s: number, i: any) => s + Number(i.amount || 0), 0),
          is_disbursed: !!Number(b.is_disbursed),
          voucher_no: b.voucher_no || null,
          disbursed_at: b.disbursed_at || null,
          remarks: b.remarks || null
        };
      })
      .sort((a: any, b: any) => (b.bill_date || "").localeCompare(a.bill_date || ""));
    const moveRows = moves
      .filter((c: any) => inYear(c.check_in_at || c.created_at))
      .map((c: any) => ({
        id: Number(c.id),
        date: toDate(c.check_in_at || c.created_at),
        purpose: c.purpose,
        status: c.status,
        distance_km: c.distance_km != null ? Number(c.distance_km) : null
      }))
      .sort((a: any, b: any) => (b.date || "").localeCompare(a.date || ""));
    const monthly: Record<string, { claimed: number; approved: number; billed: number; paid: number }> = {};
    const bump = (d: string | null, k: "claimed" | "approved" | "billed" | "paid", v: number) => {
      if (!d) return;
      const key = d.slice(0, 7);
      monthly[key] = monthly[key] || { claimed: 0, approved: 0, billed: 0, paid: 0 };
      monthly[key][k] += v;
    };
    for (const c of claimRows) {
      bump(c.claim_date, "claimed", c.amount);
      if (c.status === "approved") bump(c.claim_date, "approved", c.approved_amount ?? c.amount);
    }
    for (const b of billRows) {
      bump(b.bill_date, "billed", b.amount);
      if (b.is_disbursed) bump(b.bill_date, "paid", b.amount);
    }
    return {
      linked: true,
      year,
      claims: claimRows,
      bills: billRows,
      movements: moveRows,
      monthly: Object.entries(monthly)
        .map(([month, v]) => ({ month, ...v }))
        .sort((a, b) => a.month.localeCompare(b.month)),
      totals: {
        claimed: claimRows.reduce((s: number, c: any) => s + c.amount, 0),
        approved: claimRows.filter((c: any) => c.status === "approved").reduce((s: number, c: any) => s + (c.approved_amount ?? c.amount), 0),
        pending: claimRows.filter((c: any) => c.status === "pending").reduce((s: number, c: any) => s + c.amount, 0),
        pending_count: claimRows.filter((c: any) => c.status === "pending").length,
        billed: billRows.reduce((s: number, b: any) => s + b.amount, 0),
        disbursed: billRows.filter((b: any) => b.is_disbursed).reduce((s: number, b: any) => s + b.amount, 0),
        distance_km: moveRows.reduce((s: number, c: any) => s + (c.distance_km || 0), 0)
      }
    };
  }

  async function salarySection(empId: number) {
    const [structures, payrolls, bonuses] = await Promise.all([
      rowsFor(queryDB, "salary_structures", "employee_id", empId),
      rowsFor(queryDB, "payrolls", "employee_id", empId),
      rowsFor(queryDB, "pending_bonuses", "employee_id", empId)
    ]);
    const s = structures
      .map((r: any) => ({
        id: Number(r.id),
        effective_date: toDate(r.effective_date),
        basic_salary: Number(r.basic_salary || 0),
        house_rent: Number(r.house_rent || 0),
        medical_allowance: Number(r.medical_allowance || 0),
        conveyance_allowance: Number(r.conveyance_allowance || 0),
        other_allowance: Number(r.other_allowance || 0),
        gross_salary: Number(r.gross_salary || 0),
        tax_deduction: Number(r.tax_deduction || 0),
        pf_deduction: Number(r.pf_deduction || 0)
      }))
      .sort((a: any, b: any) => (a.effective_date || "").localeCompare(b.effective_date || "") || a.id - b.id)
      .map((r: any, i: number, all: any[]) => {
        const prev = all[i - 1];
        return { ...r, change: prev ? r.gross_salary - prev.gross_salary : null, change_percent: prev && prev.gross_salary ? Math.round(((r.gross_salary - prev.gross_salary) / prev.gross_salary) * 1000) / 10 : null };
      })
      .reverse();
    const p = payrolls
      .map((r: any) => ({
        id: Number(r.id),
        month_year: r.month_year,
        present_days: Number(r.present_days || 0),
        absent_days: Number(r.absent_days || 0),
        leave_days: Number(r.leave_days || 0),
        gross_earned: Number(r.gross_earned || 0),
        bonus_amount: Number(r.bonus_amount || 0),
        overtime_amount: Number(r.overtime_amount || 0),
        advance_deduction: Number(r.advance_deduction || 0),
        total_deduction: Number(r.total_deduction || 0),
        net_salary: Number(r.net_salary || 0),
        payment_status: r.payment_status,
        paid_at: r.paid_at || null
      }))
      .sort((a: any, b: any) => String(b.month_year).localeCompare(String(a.month_year)));
    const byYear: Record<string, { gross: number; net: number; bonus: number; months: number }> = {};
    for (const r of p) {
      const y = String(r.month_year).slice(0, 4);
      byYear[y] = byYear[y] || { gross: 0, net: 0, bonus: 0, months: 0 };
      byYear[y].gross += r.gross_earned;
      byYear[y].net += r.net_salary;
      byYear[y].bonus += r.bonus_amount;
      byYear[y].months += 1;
    }
    return {
      structures: s,
      payrolls: p,
      bonuses: bonuses
        .map((b: any) => ({ id: Number(b.id), month_year: b.month_year, amount: Number(b.amount || 0), reason: b.reason || null }))
        .sort((a: any, b: any) => String(b.month_year).localeCompare(String(a.month_year))),
      yearly: Object.entries(byYear)
        .map(([year, v]) => ({ year, ...v }))
        .sort((a, b) => b.year.localeCompare(a.year))
    };
  }

  async function loansSection(empId: number) {
    const userName = await userNames();
    const [advances, requests, payrolls] = await Promise.all([
      rowsFor(queryDB, "employee_advances", "employee_id", empId),
      rowsFor(queryDB, "advance_requests", "employee_id", empId),
      rowsFor(queryDB, "payrolls", "employee_id", empId)
    ]);
    const loans = advances
      .map((a: any) => {
        const total = Number(a.total_amount || 0);
        const paid = Number(a.paid_amount || 0);
        const inst = Number(a.monthly_installment || 0);
        const remaining = Math.max(0, total - paid);
        return {
          id: Number(a.id),
          total_amount: total,
          monthly_installment: inst,
          paid_amount: paid,
          remaining,
          installments_left: inst > 0 ? Math.ceil(remaining / inst) : null,
          reason: a.reason || null,
          status: a.status,
          created_at: toDate(a.created_at),
          created_by: userName(a.created_by)
        };
      })
      .sort((a: any, b: any) => b.id - a.id);
    return {
      loans,
      requests: requests
        .map((r: any) => ({
          id: Number(r.id),
          total_amount: Number(r.total_amount || 0),
          monthly_installment: Number(r.monthly_installment || 0),
          reason: r.reason || null,
          status: r.status,
          created_at: toDate(r.created_at),
          decided_by: userName(r.decided_by),
          decision_remarks: r.decision_remarks || null
        }))
        .sort((a: any, b: any) => b.id - a.id),
      deductions: payrolls
        .filter((p: any) => Number(p.advance_deduction || 0) > 0)
        .map((p: any) => ({ month_year: p.month_year, amount: Number(p.advance_deduction), payment_status: p.payment_status }))
        .sort((a: any, b: any) => String(b.month_year).localeCompare(String(a.month_year))),
      outstanding: loans.filter((l: any) => l.status === "active").reduce((s: number, l: any) => s + l.remaining, 0)
    };
  }

  async function assetsSection(emp: any) {
    if (!emp.user_id) return { linked: false, assets: [] };
    const [assigns, assets] = await Promise.all([
      rowsFor(queryDB, "asset_assignments", "employee_user_id", Number(emp.user_id)),
      queryDB("SELECT * FROM assets").catch(() => [])
    ]);
    return {
      linked: true,
      assets: assigns
        .map((a: any) => {
          const asset = assets.find((x: any) => Number(x.id) === Number(a.asset_id));
          return {
            id: Number(a.id),
            asset_tag: asset?.asset_tag || null,
            name: asset?.name || "Asset",
            category: asset?.category || null,
            serial_number: asset?.serial_number || null,
            quantity: a.quantity != null ? Number(a.quantity) : null,
            unit: a.unit || null,
            assigned_date: toDate(a.assigned_date),
            returned_date: toDate(a.returned_date),
            condition_on_assign: a.condition_on_assign || null,
            condition_on_return: a.condition_on_return || null,
            acknowledged: !!a.acknowledged_at
          };
        })
        .sort((a: any, b: any) => (b.assigned_date || "").localeCompare(a.assigned_date || ""))
    };
  }

  async function disciplineSection(emp: any) {
    if (!emp.user_id) return { linked: false, actions: [], exit: null };
    const userName = await userNames();
    const [acts, exits, feedback] = await Promise.all([
      rowsFor(queryDB, "disciplinary_actions", "user_id", Number(emp.user_id)),
      rowsFor(queryDB, "exit_requests", "user_id", Number(emp.user_id)),
      rowsFor(queryDB, "case_feedback", "case_type", "disciplinary")
    ]);
    const exit = exits.filter((x: any) => x.status !== "cancelled").sort((a: any, b: any) => Number(b.id) - Number(a.id))[0];
    return {
      linked: true,
      actions: acts
        .map((d: any) => ({
          id: Number(d.id),
          action_type: d.action_type,
          reason: d.reason,
          issued_at: toDate(d.issued_at),
          issued_by: userName(d.issued_by),
          acknowledged: !!Number(d.acknowledged),
          acknowledged_at: d.acknowledged_at ? String(d.acknowledged_at) : null,
          document_text: d.document_text || null,
          status: d.status,
          // The employee's explanation and HR's notes, oldest first.
          feedback: feedback
            .filter((f: any) => Number(f.case_id) === Number(d.id))
            .sort((a: any, b: any) => Number(a.id) - Number(b.id))
            .map((f: any) => ({ by: userName(f.user_id), role: f.role, message: f.message, at: f.created_at ? String(f.created_at) : null }))
        }))
        .sort((a: any, b: any) => (b.issued_at || "").localeCompare(a.issued_at || "")),
      exit: exit
        ? { id: Number(exit.id), exit_type: exit.exit_type, notice_date: toDate(exit.notice_date), last_working_day: toDate(exit.last_working_day), status: exit.status, reason: exit.reason || null }
        : null
    };
  }

  async function performanceSection(emp: any) {
    if (!emp.user_id) return { linked: false, reviews: [] };
    const userName = await userNames();
    const [reviews, cycles] = await Promise.all([
      rowsFor(queryDB, "performance_reviews", "user_id", Number(emp.user_id)),
      queryDB("SELECT * FROM performance_cycles").catch(() => [])
    ]);
    return {
      linked: true,
      reviews: reviews
        .map((r: any) => {
          const c = cycles.find((x: any) => Number(x.id) === Number(r.cycle_id));
          return {
            id: Number(r.id),
            cycle: c?.name || "Review",
            period_start: toDate(c?.period_start),
            period_end: toDate(c?.period_end),
            overall_rating: r.overall_rating != null ? Number(r.overall_rating) : null,
            strengths: r.strengths || null,
            improvements: r.improvements || null,
            status: r.status,
            reviewer: userName(r.reviewer_id)
          };
        })
        .sort((a: any, b: any) => (b.period_end || "").localeCompare(a.period_end || ""))
    };
  }

  // ---- overview: header, personal profile, summary tiles, timeline ----
  app.get("/api/hr-ops/p360/:employeeId", ...gate, async (req: any, res: any) => {
    try {
      await sendOverview(res, Number(req.params.employeeId), await viewerModules(req));
    } catch (err) {
      fail(res, err);
    }
  });
  // `mods` decides what the page shows (salary/loans) and which operations
  // it offers — the viewer's modules, or just "payroll" for one's own book.
  async function sendOverview(res: any, empId: number, mods: Set<string>) {
    try {
      const today = todayInDhaka();
      const canPayroll = has(mods, "payroll");
      const book = await buildServiceBook(queryDB, today, empId, false);
      const world = await loadEmployeeWorld(queryDB);
      const snap = snapshotOf(world, empId);
      if (!snap) throw bad("Employee not found.", 404);
      const e = snap.employee;
      const cur = currentValues(snap);

      const [records, docs, att, leave, claims, loans, assets] = await Promise.all([
        recordsSection(empId),
        documentsSection(e),
        attendanceSection(e, today.slice(0, 7)),
        leaveSection(e, Number(today.slice(0, 4))),
        claimsSection(e, Number(today.slice(0, 4))),
        canPayroll ? loansSection(empId) : Promise.resolve(null),
        assetsSection(e)
      ]);
      const serviceMonths = book.employee?.service_length_months ?? null;

      // Without Payroll access the timeline keeps the event but not the
      // amounts.
      const events = canPayroll
        ? book.events
        : book.events.map((ev: any) =>
            ["salary", "increment", "salary_adjustment"].includes(ev.kind)
              ? { ...ev, detail: ev.kind === "salary" ? "Salary structure revised" : "Salary revised" }
              : { ...ev, detail: ev.detail ? String(ev.detail).replace(/,?\s*Gross[^,]*/g, "").trim() || null : ev.detail }
          );

      const supervisorEmp = snap.supervisor ? world.employees.find((x: any) => Number(x.id) === snap.supervisor!.id) : null;
      res.json({
        permissions: {
          payroll: canPayroll,
          document_vault: has(mods, "document_vault"),
          grievance_disciplinary: has(mods, "grievance_disciplinary"),
          asset_management: has(mods, "asset_management"),
          employees: has(mods, "employees")
        },
        employee: {
          ...book.employee,
          gross_salary: canPayroll ? cur.gross_salary : null,
          user_id: e.user_id ? Number(e.user_id) : null,
          service_status:
            snap.service?.service_status ||
            (Number(e.is_active ?? 1) === 0 ? "separated" : e.job_base === "Permanent" ? "confirmed" : e.job_base === "Contractual" ? "contract" : "probation"),
          contract_end_date: toDate(snap.service?.contract_end_date),
          probation_months: snap.service?.probation_months ?? null,
          supervisor_code: supervisorEmp?.employee_id || null
        },
        profile: {
          first_name: e.name,
          middle_name: e.middle_name || null,
          gender: e.gender || null,
          date_of_birth: toDate(e.date_of_birth),
          age_years: toDate(e.date_of_birth) ? Math.floor(monthsBetween(toDate(e.date_of_birth)!, today) / 12) : null,
          nid: e.nid_ssn || null,
          nationality: e.nationality || null,
          marital_status: e.marital_status || null,
          blood_group: e.blood_group || null,
          religion: e.religion || null,
          email: e.email || null,
          personal_email: e.personal_email || null,
          phone: e.mobile || e.phone || null,
          telephone: e.telephone || null,
          present_address: [e.present_address, e.present_city, e.present_state, e.present_zip, e.present_country].filter(Boolean).join(", ") || null,
          permanent_address: [e.permanent_address, e.permanent_city, e.permanent_state, e.permanent_zip, e.permanent_country].filter(Boolean).join(", ") || null,
          division: e.division || null,
          unit: e.unit || null,
          employment_category: e.employment_category || null,
          job_status: e.job_status || null,
          review_month: e.review_month || null,
          zk_device_pin: e.zk_device_pin || null
        },
        summary: {
          service_months: serviceMonths,
          prior_experience_months: records.prior_experience_months,
          total_experience_months: (serviceMonths || 0) + records.prior_experience_months,
          highest_education: records.education[0] ? [records.education[0].degree, records.education[0].institute].filter(Boolean).join(", ") : null,
          gross_salary: canPayroll ? cur.gross_salary : null,
          loan_outstanding: loans ? loans.outstanding : null,
          active_loans: loans ? loans.loans.filter((l: any) => l.status === "active").length : null,
          leave_taken: leave.balances.reduce((s: number, b: any) => s + b.taken, 0),
          leave_remaining: leave.balances.filter((b: any) => b.key !== "without_pay").reduce((s: number, b: any) => s + b.balance, 0),
          attendance_month: att.month,
          attendance_percent: att.summary.attendance_percent,
          absent_this_month: att.summary.absent,
          late_this_month: att.summary.late + att.summary.extreme_late,
          claims_pending_count: claims.totals?.pending_count ?? 0,
          claims_pending_amount: claims.totals?.pending ?? 0,
          claims_approved_year: claims.totals?.approved ?? 0,
          documents: docs.documents.length,
          documents_missing: docs.missing.length,
          documents_expired: docs.documents.filter((d: any) => d.expired).length,
          assets_held: assets.assets.filter((a: any) => !a.returned_date).length,
          nominees: records.family.filter((f: any) => f.is_nominee).length,
          emergency_contacts: records.family.filter((f: any) => f.is_emergency).length
        },
        events
      });
    } catch (err) {
      fail(res, err);
    }
  }

  // ---- one section at a time (tabs load lazily) ----
  app.get("/api/hr-ops/p360/:employeeId/section/:section", ...gate, async (req: any, res: any) => {
    try {
      await sendSection(req, res, Number(req.params.employeeId), await viewerModules(req));
    } catch (err) {
      fail(res, err);
    }
  });
  async function sendSection(req: any, res: any, empId: number, mods: Set<string>) {
    try {
      const section = String(req.params.section);
      if (!(SECTIONS as readonly string[]).includes(section)) throw bad("Unknown section.", 404);
      if (PAYROLL_SECTIONS.has(section) && !has(mods, "payroll")) {
        throw bad("Salary and loan details need the Payroll module. Ask your Superadmin to grant it.", 403);
      }
      const e = await employeeRow(empId);
      const today = todayInDhaka();
      const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : today.slice(0, 7);
      const year = /^\d{4}$/.test(String(req.query.year || "")) ? Number(req.query.year) : Number(today.slice(0, 4));
      let data: any;
      if (section === "records") data = await recordsSection(empId);
      else if (section === "documents") data = await documentsSection(e);
      else if (section === "attendance") data = await attendanceSection(e, month);
      else if (section === "attendance_year") data = await attendanceYearSection(e, year);
      else if (section === "leave") data = await leaveSection(e, year);
      else if (section === "claims") data = await claimsSection(e, year);
      else if (section === "salary") data = await salarySection(empId);
      else if (section === "loans") data = await loansSection(empId);
      else if (section === "assets") data = await assetsSection(e);
      else if (section === "discipline") data = await disciplineSection(e);
      else data = await performanceSection(e);
      res.json(data);
    } catch (err) {
      fail(res, err);
    }
  }

  // ---- Self Service -> My Letters & Service Record -> Service Book ----
  // The employee's own book, read only, behind users.can_view_service_book
  // (Module Access; a Superadmin always). Salary and loans are their own, so
  // they show; no HR operations are offered.
  async function myEmployeeId(req: any): Promise<number> {
    if (req.user.role !== "superadmin") {
      const u: any[] = await queryDB("SELECT can_view_service_book FROM users WHERE id = ?", [Number(req.user.id)]);
      if (!Number(u[0]?.can_view_service_book || 0)) throw bad("You don't have access to My Service Book. Ask HR to turn it on.", 403);
    }
    const rows: any[] = await queryDB("SELECT id, is_active FROM all_employees WHERE user_id = ?", [Number(req.user.id)]);
    const mine = rows.filter((r: any) => Number(r.is_active ?? 1) !== 0)[0] || rows[0];
    if (!mine) throw bad("Your login isn't linked to an Employee record yet — please contact HR.", 404);
    return Number(mine.id);
  }
  const OWN = new Set(["payroll"]);
  app.get("/api/hr-ops/my/p360", authenticateToken, async (req: any, res: any) => {
    try {
      await sendOverview(res, await myEmployeeId(req), OWN);
    } catch (err) {
      fail(res, err);
    }
  });
  app.get("/api/hr-ops/my/p360/section/:section", authenticateToken, async (req: any, res: any) => {
    try {
      await sendSection(req, res, await myEmployeeId(req), OWN);
    } catch (err) {
      fail(res, err);
    }
  });
  app.get("/api/hr-ops/my/p360/documents/:docId/file", authenticateToken, async (req: any, res: any) => {
    try {
      await myEmployeeId(req);
      const rows: any[] = await queryDB("SELECT * FROM employee_documents WHERE id = ?", [Number(req.params.docId)]);
      const d = rows.find((x: any) => Number(x.id) === Number(req.params.docId));
      if (!d?.file_data || Number(d.user_id) !== Number(req.user.id)) throw bad("File not found.", 404);
      const buf: Buffer = Buffer.isBuffer(d.file_data) ? d.file_data : Buffer.from(d.file_data);
      res.setHeader("Content-Type", d.file_mimetype || "application/octet-stream");
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(d.file_name || "document")}"`);
      res.send(buf);
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Document Vault file, viewed from here with hr_operations ----
  app.get("/api/hr-ops/p360/documents/:docId/file", ...gate, async (req: any, res: any) => {
    try {
      const rows: any[] = await queryDB("SELECT * FROM employee_documents WHERE id = ?", [Number(req.params.docId)]);
      const d = rows.find((x: any) => Number(x.id) === Number(req.params.docId));
      if (!d?.file_data) throw bad("File not found.", 404);
      const buf: Buffer = Buffer.isBuffer(d.file_data) ? d.file_data : Buffer.from(d.file_data);
      res.setHeader("Content-Type", d.file_mimetype || "application/octet-stream");
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(d.file_name || "document")}"`);
      res.send(buf);
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- the four HR-maintained record types ----
  function specOf(kind: string): RecordSpec {
    const spec = RECORD_SPECS[kind];
    if (!spec) throw bad("Unknown record type.", 404);
    return spec;
  }
  function valuesFrom(spec: RecordSpec, body: any, partial: boolean) {
    const out: Record<string, any> = {};
    for (const [k, f] of Object.entries(spec.fields)) {
      if (partial && body[k] === undefined) continue;
      out[k] = cleanValue(f.type, body[k], f.max);
    }
    for (const r of spec.required) if (!partial || r in out) if (out[r] === null || out[r] === undefined) throw bad(`${r.replace(/_/g, " ")} is required.`);
    if (out.from_date && out.to_date && out.to_date < out.from_date) throw bad("The end date is before the start date.");
    if (out.nominee_percent != null && (out.nominee_percent < 0 || out.nominee_percent > 100)) throw bad("Nominee share must be between 0 and 100%.");
    return out;
  }
  async function checkNomineeTotal(employeeId: number, excludeId: number | null, values: Record<string, any>) {
    if (!values.is_nominee || values.nominee_percent == null) return;
    const rows = await rowsFor(queryDB, "hr_emp_family", "employee_id", employeeId);
    const others = rows.filter((r: any) => Number(r.id) !== excludeId && Number(r.is_nominee) && r.nominee_percent != null);
    const total = others.reduce((s: number, r: any) => s + Number(r.nominee_percent), 0) + Number(values.nominee_percent);
    if (total > 100.001) throw bad(`Nominee shares would add up to ${Math.round(total * 100) / 100}% — they can't exceed 100%.`);
  }
  async function saveFile(spec: RecordSpec, id: number, body: any) {
    if (!spec.hasFile) return;
    if (body.remove_file) {
      await queryDB(`UPDATE ${spec.table} SET file_name = ?, file_mime = ?, file_data = ? WHERE id = ?`, [null, null, null, id]);
      return;
    }
    if (!body.file_base64 || !body.file_name) return;
    const buf = Buffer.from(String(body.file_base64), "base64");
    if (buf.length > 8 * 1024 * 1024) throw bad("File is larger than 8 MB.");
    await queryDB(`UPDATE ${spec.table} SET file_name = ?, file_mime = ?, file_data = ? WHERE id = ?`, [
      String(body.file_name).slice(0, 255),
      String(body.file_mime || "application/octet-stream").slice(0, 100),
      buf,
      id
    ]);
  }
  async function recordById(spec: RecordSpec, id: number) {
    const rows: any[] = await queryDB(`SELECT * FROM ${spec.table} WHERE id = ?`, [id]);
    const r = rows.find((x: any) => Number(x.id) === id);
    if (!r) throw bad("Record not found.", 404);
    return r;
  }

  app.post("/api/hr-ops/p360/:employeeId/records/:kind", ...gate, async (req: any, res: any) => {
    try {
      const empId = Number(req.params.employeeId);
      await employeeRow(empId);
      const spec = specOf(req.params.kind);
      const body = req.body || {};
      const values = valuesFrom(spec, body, false);
      if (req.params.kind === "family") await checkNomineeTotal(empId, null, values);
      const cols = ["employee_id", ...Object.keys(values), "created_by"];
      const result: any = await queryDB(`INSERT INTO ${spec.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, [
        empId,
        ...Object.values(values),
        req.user.id
      ]);
      const id = Number(result.insertId);
      await saveFile(spec, id, body);
      if (spec.hasVerify && body.verified) {
        await queryDB(`UPDATE ${spec.table} SET verified = ?, verified_by = ?, verified_at = ?, verify_note = ? WHERE id = ?`, [1, req.user.id, new Date(), body.verify_note ? String(body.verify_note).slice(0, 500) : null, id]);
      }
      res.status(201).json({ success: true, id });
    } catch (err) {
      fail(res, err);
    }
  });

  // The Add / Edit Employee form (Employees module) also reads and adds
  // Experience & Education, so these two routes take either module.
  const careerGate = [
    authenticateToken,
    async (req: any, res: any, next: any) => {
      const mods = await viewerModules(req);
      if (has(mods, "hr_operations") || has(mods, "employees")) return next();
      res.status(403).json({ error: "You don't have access to this section. Ask your Superadmin to grant it." });
    }
  ];

  app.get("/api/hr-ops/p360/:employeeId/career", ...careerGate, async (req: any, res: any) => {
    try {
      const empId = Number(req.params.employeeId);
      await employeeRow(empId);
      const r = await recordsSection(empId);
      res.json({ experience: r.experience, education: r.education, prior_experience_months: r.prior_experience_months });
    } catch (err) {
      fail(res, err);
    }
  });

  // Several records at once — used by the Add Employee form, which collects
  // experience/education before the Employee row exists.
  app.post("/api/hr-ops/p360/:employeeId/records", ...careerGate, async (req: any, res: any) => {
    try {
      const empId = Number(req.params.employeeId);
      await employeeRow(empId);
      const items: any[] = Array.isArray(req.body?.items) ? req.body.items.slice(0, 100) : [];
      let created = 0;
      const errors: string[] = [];
      for (const it of items) {
        try {
          if (it.kind !== "experience" && it.kind !== "education") throw bad("Only experience and education can be added here.");
          const spec = specOf(String(it.kind));
          const values = valuesFrom(spec, it, false);
          const cols = ["employee_id", ...Object.keys(values), "created_by"];
          const result: any = await queryDB(`INSERT INTO ${spec.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, [
            empId,
            ...Object.values(values),
            req.user.id
          ]);
          await saveFile(spec, Number(result.insertId), it);
          created++;
        } catch (e: any) {
          errors.push(e.message);
        }
      }
      res.json({ success: errors.length === 0, created, errors });
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/hr-ops/p360/records/:kind/:id", ...gate, async (req: any, res: any) => {
    try {
      const spec = specOf(req.params.kind);
      const id = Number(req.params.id);
      const existing = await recordById(spec, id);
      const body = req.body || {};
      const values = valuesFrom(spec, body, true);
      if (req.params.kind === "family") {
        await checkNomineeTotal(Number(existing.employee_id), id, {
          is_nominee: values.is_nominee ?? Number(existing.is_nominee),
          nominee_percent: values.nominee_percent !== undefined ? values.nominee_percent : existing.nominee_percent
        });
      }
      const keys = Object.keys(values);
      if (keys.length) await queryDB(`UPDATE ${spec.table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...Object.values(values), id]);
      await saveFile(spec, id, body);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/hr-ops/p360/records/:kind/:id/verify", ...gate, async (req: any, res: any) => {
    try {
      const spec = specOf(req.params.kind);
      if (!spec.hasVerify) throw bad("This record type is not verified.");
      const id = Number(req.params.id);
      await recordById(spec, id);
      const verified = req.body?.verified !== false;
      await queryDB(`UPDATE ${spec.table} SET verified = ?, verified_by = ?, verified_at = ?, verify_note = ? WHERE id = ?`, [
        verified ? 1 : 0,
        verified ? req.user.id : null,
        verified ? new Date() : null,
        req.body?.verify_note ? String(req.body.verify_note).slice(0, 500) : null,
        id
      ]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/hr-ops/p360/records/:kind/:id", ...gate, async (req: any, res: any) => {
    try {
      const spec = specOf(req.params.kind);
      const id = Number(req.params.id);
      await recordById(spec, id);
      await queryDB(`DELETE FROM ${spec.table} WHERE id = ?`, [id]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/hr-ops/my/p360/records/:kind/:id/file", authenticateToken, async (req: any, res: any) => {
    try {
      const empId = await myEmployeeId(req);
      const spec = specOf(req.params.kind);
      const r = await recordById(spec, Number(req.params.id));
      if (Number(r.employee_id) !== empId || !r.file_data) throw bad("No file attached.", 404);
      const buf: Buffer = Buffer.isBuffer(r.file_data) ? r.file_data : Buffer.from(r.file_data);
      res.setHeader("Content-Type", r.file_mime || "application/octet-stream");
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(r.file_name || "attachment")}"`);
      res.send(buf);
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/hr-ops/p360/records/:kind/:id/file", ...gate, async (req: any, res: any) => {
    try {
      const spec = specOf(req.params.kind);
      const r = await recordById(spec, Number(req.params.id));
      if (!r.file_data) throw bad("No file attached.", 404);
      const buf: Buffer = Buffer.isBuffer(r.file_data) ? r.file_data : Buffer.from(r.file_data);
      res.setHeader("Content-Type", r.file_mime || "application/octet-stream");
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(r.file_name || "attachment")}"`);
      res.send(buf);
    } catch (err) {
      fail(res, err);
    }
  });
}
