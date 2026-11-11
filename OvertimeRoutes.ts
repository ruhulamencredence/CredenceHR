/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Overtime (OT): worked out by itself from attendance, set in the Duty
// Roster, approved by whoever the company's setting names, and paid in
// Payroll.
//
//   ot_settings   one row per company: how the hourly rate is worked out
//                 (labour law: basic / 208 x 2; a fixed ৳ an hour; or gross
//                 based), the 30-minute rules, daily / monthly limits, and
//                 WHO APPROVES OT (Team Supervisor / Roster manager / either /
//                 both, one after the other). Payroll -> OT Rules, layer
//                 "ot_rules" (explicit-only).
//   ot_rates      a designation's or one person's own rate (overrides the
//                 rule; a person's own wins over the designation's).
//   ot_entries    one row per Employee per day that had overtime: In / Out,
//                 minutes worked out, minutes already approved (OT built into
//                 a shift or set in the roster), minutes approved in the end,
//                 and its state (auto / pending / approved / rejected /
//                 not_eligible). Recalculated from attendance whenever a list
//                 or Payroll asks, except a row someone already decided.
//   ot_payroll_changes  OT hours / amount changed by hand in Run Payroll, with
//                 the reason.
//
// Who gets OT: all_employees.gets_ot (off for everyone at the start). Someone
// without it still gets ot_entries rows (status not_eligible) so the extra
// time shows, but it is never paid.
//
// A shift (Duty Roster -> Shifts) has normal hours: a 12-hour guard shift
// with 8 normal hours earns 4 hours of OT every day when its extra_mode is
// "ot", none when "salary" (the 12 hours are the salary). A roster day can
// carry planned OT (+1 h, +2 h…), approved in advance.
//
// Attendance is the same for everyone: the app's Check In / Out, the office
// device, or the Site Attendance muster — whichever exists (OvertimeCalc.ts
// reads the earliest In and the latest Out of the day's duty window).
//
// Approval (who may act on an entry, approverCan below):
//   Team Supervisor = the person's Direct Supervisor (Employees -> Supervisor,
//     with a login) or the supervisor / backup of their Site Attendance team.
//     A supervisor acts from Duty Roster -> OT Approval (layer "ot_approve")
//     or, without Admin Panel access, from Self Service -> Team OT
//     (users.can_approve_team_ot, off by default). Only their own team's OT.
//   Roster manager = an account with Duty Roster -> "ot_approve" whose Duty
//     Roster departments include the person (no departments = all).
//   Someone with no Team Supervisor goes to the Roster manager.
//   A Superadmin can always decide.
// Self Service -> My OT (users.can_view_my_ot, off by default): one's own OT.

import type { Express } from "express";
import { activeCompanyId } from "./companyContext";
import { getHolidayMapsByGroup, getEmployeeBranchTypeByEmployeeId } from "./holidayRoutes";
import { getRosterDeptScope } from "./RosterRoutes";
import { loadSiteEntries } from "./SiteAttendanceRoutes";
import {
  DEFAULT_OT_RULES,
  capMonthly,
  dayStart,
  otForDay,
  otRateFor,
  shiftSpan,
  wallMinutes,
  wallText,
  type OtApproverMode,
  type OtRateOverride,
  type OtRateType,
  type OtRules,
  type OtShift
} from "./OvertimeCalc";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export interface RegisterOvertimeRoutesDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModuleLayer: any;
  hasModuleLayer: (user: any, moduleKey: any, layer: string) => Promise<boolean>;
  queryDB: QueryDB;
  todayInDhaka: () => string;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
export async function ensureOvertimeSchema(dbPool: any): Promise<void> {
  const run = async (label: string, sql: string, ignore: string[] = []) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      if (!ignore.includes(err.code)) console.warn(`⚠️ Overtime (${label}): ${err.message}`);
    }
  };
  const dup = ["ER_DUP_FIELDNAME"];
  await run("all_employees.gets_ot", "ALTER TABLE all_employees ADD COLUMN gets_ot TINYINT(1) NOT NULL DEFAULT 0", dup);
  await run("users.can_view_my_ot", "ALTER TABLE users ADD COLUMN can_view_my_ot TINYINT(1) NOT NULL DEFAULT 0", dup);
  await run("users.can_approve_team_ot", "ALTER TABLE users ADD COLUMN can_approve_team_ot TINYINT(1) NOT NULL DEFAULT 0", dup);
  await run("duty_shifts.normal_minutes", "ALTER TABLE duty_shifts ADD COLUMN normal_minutes INT NULL", dup);
  await run("duty_shifts.extra_mode", "ALTER TABLE duty_shifts ADD COLUMN extra_mode VARCHAR(10) NOT NULL DEFAULT 'ot'", dup);
  await run("duty_roster.planned_ot_minutes", "ALTER TABLE duty_roster ADD COLUMN planned_ot_minutes INT NOT NULL DEFAULT 0", dup);
  await run("duty_roster.post_id", "ALTER TABLE duty_roster ADD COLUMN post_id INT NULL", dup);
  await run(
    "ot_settings",
    `CREATE TABLE IF NOT EXISTS ot_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL DEFAULT 1,
      rate_type VARCHAR(12) NOT NULL DEFAULT 'labour_law',
      divisor DECIMAL(8, 2) NOT NULL DEFAULT 208,
      multiplier DECIMAL(5, 2) NOT NULL DEFAULT 2,
      off_multiplier DECIMAL(5, 2) NOT NULL DEFAULT 2,
      fixed_rate DECIMAL(10, 2) NOT NULL DEFAULT 0,
      fixed_off_rate DECIMAL(10, 2) NOT NULL DEFAULT 0,
      min_minutes INT NOT NULL DEFAULT 30,
      round_minutes INT NOT NULL DEFAULT 30,
      daily_max_minutes INT NOT NULL DEFAULT 120,
      monthly_max_minutes INT NOT NULL DEFAULT 0,
      only_approved TINYINT(1) NOT NULL DEFAULT 1,
      planned_counts_approved TINYINT(1) NOT NULL DEFAULT 1,
      approver_mode VARCHAR(16) NOT NULL DEFAULT 'supervisor',
      office_start VARCHAR(5) NOT NULL DEFAULT '09:00',
      office_end VARCHAR(5) NOT NULL DEFAULT '18:00',
      updated_by INT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ot_settings_company (company_id)
    )`
  );
  await run(
    "ot_rates",
    `CREATE TABLE IF NOT EXISTS ot_rates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL DEFAULT 1,
      designation VARCHAR(150) NULL,
      employee_id INT NULL,
      rate_type VARCHAR(12) NOT NULL DEFAULT 'fixed',
      rate DECIMAL(10, 2) NULL,
      off_rate DECIMAL(10, 2) NULL,
      created_by INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ot_rates_company (company_id)
    )`
  );
  await run(
    "ot_entries",
    `CREATE TABLE IF NOT EXISTS ot_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      work_date DATE NOT NULL,
      day_kind VARCHAR(8) NOT NULL DEFAULT 'normal',
      shift_id INT NULL,
      relief TINYINT(1) NOT NULL DEFAULT 0,
      in_at DATETIME NULL,
      out_at DATETIME NULL,
      worked_minutes INT NOT NULL DEFAULT 0,
      built_in_minutes INT NOT NULL DEFAULT 0,
      calc_minutes INT NOT NULL DEFAULT 0,
      auto_minutes INT NOT NULL DEFAULT 0,
      over_limit_minutes INT NOT NULL DEFAULT 0,
      approved_minutes INT NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      step INT NOT NULL DEFAULT 1,
      step1_by INT NULL,
      step1_minutes INT NULL,
      decided_by INT NULL,
      decided_at DATETIME NULL,
      note VARCHAR(255) NULL,
      calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ot_entry (employee_id, work_date),
      INDEX idx_ot_entries_date (work_date)
    )`
  );
  await run(
    "ot_payroll_changes",
    `CREATE TABLE IF NOT EXISTS ot_payroll_changes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      month_year VARCHAR(7) NOT NULL,
      from_hours DECIMAL(7, 2) NOT NULL DEFAULT 0,
      to_hours DECIMAL(7, 2) NOT NULL DEFAULT 0,
      from_amount DECIMAL(12, 2) NOT NULL DEFAULT 0,
      to_amount DECIMAL(12, 2) NOT NULL DEFAULT 0,
      reason VARCHAR(500) NOT NULL,
      user_id INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ot_changes_month (month_year)
    )`
  );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_RANGE_DAYS = 62;
const RATE_TYPES: OtRateType[] = ["labour_law", "fixed", "gross"];
const APPROVER_MODES: OtApproverMode[] = ["supervisor", "roster_manager", "either", "both"];

const ymd = (v: any) => String(v || "").slice(0, 10);
export const addDays = (date: string, n: number) => {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

export async function loadOtRules(queryDB: QueryDB): Promise<OtRules & { saved: boolean }> {
  const rows: any[] = (await queryDB("SELECT * FROM ot_settings").catch(() => [])) || [];
  const r = rows.find((x) => Number(x.company_id ?? 1) === activeCompanyId()) || rows[0];
  if (!r) return { ...DEFAULT_OT_RULES, saved: false };
  const n = (v: any, d: number) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));
  return {
    rate_type: RATE_TYPES.includes(r.rate_type) ? r.rate_type : DEFAULT_OT_RULES.rate_type,
    divisor: n(r.divisor, 208),
    multiplier: n(r.multiplier, 2),
    off_multiplier: n(r.off_multiplier, 2),
    fixed_rate: n(r.fixed_rate, 0),
    fixed_off_rate: n(r.fixed_off_rate, 0),
    min_minutes: n(r.min_minutes, 30),
    round_minutes: n(r.round_minutes, 30),
    daily_max_minutes: n(r.daily_max_minutes, 120),
    monthly_max_minutes: n(r.monthly_max_minutes, 0),
    only_approved: Number(r.only_approved ?? 1) === 1,
    planned_counts_approved: Number(r.planned_counts_approved ?? 1) === 1,
    approver_mode: APPROVER_MODES.includes(r.approver_mode) ? r.approver_mode : "supervisor",
    office_start: HM_RE.test(String(r.office_start || "")) ? String(r.office_start) : "09:00",
    office_end: HM_RE.test(String(r.office_end || "")) ? String(r.office_end) : "18:00",
    saved: true
  };
}

async function companyEmployees(queryDB: QueryDB): Promise<any[]> {
  const rows: any[] =
    (await queryDB("SELECT id, name, employee_id, designation, department, user_id, zk_device_pin, gets_ot, is_active, company_id FROM all_employees")) || [];
  return rows.filter((e) => Number(e.company_id ?? 1) === activeCompanyId());
}

interface ShiftRow extends OtShift {
  id: number;
  name: string;
  code: string;
}
async function loadShiftRows(queryDB: QueryDB): Promise<Map<number, ShiftRow>> {
  const rows: any[] = (await queryDB("SELECT * FROM duty_shifts").catch(() => [])) || [];
  return new Map(
    rows.map((r) => [
      Number(r.id),
      {
        id: Number(r.id),
        name: String(r.name || ""),
        code: String(r.code || ""),
        start_time: String(r.start_time || "09:00").slice(0, 5),
        end_time: String(r.end_time || "18:00").slice(0, 5),
        normal_minutes: r.normal_minutes == null ? null : Number(r.normal_minutes),
        extra_mode: r.extra_mode === "salary" ? "salary" : "ot"
      }
    ])
  );
}

// ---------------------------------------------------------------------------
// Working it out: every Employee's OT for every day in [from, to]
// ---------------------------------------------------------------------------
const recalcStamp = new Map<string, number>();
const RECALC_FRESH_MS = 60_000;

export async function recalcOt(queryDB: QueryDB, from: string, to: string, opts: { employeeIds?: number[]; force?: boolean } = {}) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
  if (to > today) to = today;
  if (from > to) return;
  const key = `${activeCompanyId()}|${from}|${to}|${(opts.employeeIds || []).join(",")}`;
  if (!opts.force && Date.now() - (recalcStamp.get(key) || 0) < RECALC_FRESH_MS) return;

  const rules = await loadOtRules(queryDB);
  const wanted = opts.employeeIds ? new Set(opts.employeeIds.map(Number)) : null;
  const emps = (await companyEmployees(queryDB)).filter((e) => Number(e.is_active ?? 1) === 1 && (!wanted || wanted.has(Number(e.id))));
  if (!emps.length) return;
  const ids = emps.map((e) => Number(e.id));
  const fromX = addDays(from, -1);
  const toX = addDays(to, 1);
  const inIds = (col: string, list: any[]) => (list.length ? ` AND ${col} IN (${list.map(() => "?").join(",")})` : " AND 1 = 0");

  const [shifts, rosterRows, maps, groups, reliefRows] = await Promise.all([
    loadShiftRows(queryDB),
    queryDB(`SELECT employee_id, roster_date, shift_id, is_off, planned_ot_minutes FROM duty_roster WHERE roster_date BETWEEN ? AND ?${inIds("employee_id", ids)}`, [fromX, toX, ...ids]).catch(() => []),
    getHolidayMapsByGroup(queryDB, fromX, toX),
    getEmployeeBranchTypeByEmployeeId(queryDB),
    queryDB(`SELECT employee_id, relief_date, shift_id FROM guard_relief WHERE relief_date BETWEEN ? AND ?${inIds("employee_id", ids)}`, [fromX, toX, ...ids]).catch(() => [])
  ]);
  const roster = new Map<string, any>();
  for (const r of rosterRows || []) roster.set(`${r.employee_id}|${ymd(r.roster_date)}`, r);
  const relief = new Map<string, number>();
  for (const r of reliefRows || []) relief.set(`${r.employee_id}|${ymd(r.relief_date)}`, Number(r.shift_id));

  // Every In / Out / punch of these people around the range, wall minutes.
  const stamps = new Map<number, number[]>();
  const add = (eid: number, v: any) => {
    const m = wallMinutes(v);
    if (m == null) return;
    if (!stamps.has(eid)) stamps.set(eid, []);
    stamps.get(eid)!.push(m);
  };
  const byUser = new Map<number, number>();
  const byPin = new Map<string, number>();
  for (const e of emps) {
    if (e.user_id) byUser.set(Number(e.user_id), Number(e.id));
    if (e.zk_device_pin) byPin.set(String(e.zk_device_pin), Number(e.id));
  }
  const uids = [...byUser.keys()];
  if (uids.length) {
    const att: any[] =
      (await queryDB(`SELECT user_id, check_in_at, check_out_at FROM attendance WHERE attendance_date BETWEEN ? AND ?${inIds("user_id", uids)}`, [fromX, toX, ...uids]).catch(() => [])) || [];
    for (const a of att) {
      const eid = byUser.get(Number(a.user_id));
      if (!eid) continue;
      add(eid, a.check_in_at);
      add(eid, a.check_out_at);
    }
  }
  const pins = [...byPin.keys()];
  if (pins.length) {
    const punches: any[] =
      (await queryDB(
        `SELECT device_user_pin, punch_time FROM zk_attendance_logs WHERE punch_time >= ? AND punch_time < ?${inIds("device_user_pin", pins)}`,
        [`${fromX} 00:00:00`, `${addDays(toX, 1)} 00:00:00`, ...pins]
      ).catch(() => [])) || [];
    for (const p of punches) {
      const eid = byPin.get(String(p.device_user_pin));
      if (eid) add(eid, p.punch_time);
    }
  }
  const wantedSet = new Set(ids);
  for (const s of await loadSiteEntries(queryDB, fromX, toX)) {
    const eid = Number(s.employee_id);
    if (!wantedSet.has(eid) || !(s.status === "present" || s.status === "late")) continue;
    const d = ymd(s.attendance_date);
    if (s.in_time) add(eid, `${d} ${String(s.in_time).slice(0, 5)}`);
    if (s.out_time) {
      const outNext = s.in_time && String(s.out_time).slice(0, 5) < String(s.in_time).slice(0, 5);
      add(eid, `${outNext ? addDays(d, 1) : d} ${String(s.out_time).slice(0, 5)}`);
    }
  }

  // The day as the roster / calendar has it.
  const dayOf = (e: any, date: string) => {
    const eid = Number(e.id);
    const r = roster.get(`${eid}|${date}`);
    const cal: Map<string, any> = (maps as any)[groups.get(eid) || "head_office"] || new Map();
    let kind: "normal" | "off" = "normal";
    let shift: ShiftRow | null = null;
    if (r && Number(r.is_off) === 1) kind = "off";
    else if (r && r.shift_id != null && shifts.get(Number(r.shift_id))) shift = shifts.get(Number(r.shift_id))!;
    else if (cal.get(date)) kind = "off";
    const reliefShift = relief.has(`${eid}|${date}`) ? shifts.get(relief.get(`${eid}|${date}`)!) || null : null;
    // Only a real duty (a rostered shift or a relief) limits the day before /
    // after: plain office hours on a day with nothing rostered must not cut
    // a night guard's morning check-out.
    const spans: (readonly [number, number])[] = [];
    if (kind === "normal" && shift) spans.push(shiftSpan(date, shift));
    if (reliefShift) spans.push(shiftSpan(date, reliefShift));
    return { kind, shift, relief: reliefShift, planned: Number(r?.planned_ot_minutes || 0), spans };
  };

  const existing: any[] =
    (await queryDB(`SELECT * FROM ot_entries WHERE work_date BETWEEN ? AND ?${inIds("employee_id", ids)}`, [from, to, ...ids]).catch(() => [])) || [];
  const have = new Map<string, any>(existing.map((x) => [`${x.employee_id}|${ymd(x.work_date)}`, x]));
  const upserts: any[][] = [];
  const deletes: number[] = [];

  for (const e of emps) {
    const eid = Number(e.id);
    const st = (stamps.get(eid) || []).sort((a, b) => a - b);
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const prev = have.get(`${eid}|${d}`);
      if (prev && prev.decided_by != null && (prev.status === "approved" || prev.status === "rejected")) continue; // decided: never changed
      if (!st.length) {
        if (prev) deletes.push(Number(prev.id));
        continue;
      }
      const day = dayOf(e, d);
      const before = dayOf(e, addDays(d, -1));
      const after = dayOf(e, addDays(d, 1));
      const res = otForDay(
        {
          date: d,
          kind: day.kind,
          shift: day.shift,
          relief: day.relief,
          planned_minutes: day.planned,
          stamps: st.filter((t) => t >= dayStart(d) - 1440 && t <= dayStart(d) + 2880),
          prev_duty_end: before.spans.length ? Math.max(...before.spans.map((s) => s[1])) : null,
          next_duty_start: after.spans.length ? Math.min(...after.spans.map((s) => s[0])) : null
        },
        rules
      );
      if (res.calc_minutes <= 0) {
        if (prev) deletes.push(Number(prev.id));
        continue;
      }
      const eligible = Number(e.gets_ot) === 1;
      let status = "pending";
      let approved = res.auto_minutes;
      if (!eligible) {
        status = "not_eligible";
        approved = 0;
      } else if (res.auto_minutes >= res.calc_minutes) {
        status = "auto";
        approved = res.calc_minutes;
      }
      upserts.push([
        eid,
        d,
        day.kind,
        day.shift?.id ?? null,
        day.relief ? 1 : 0,
        wallText(res.in_at),
        wallText(res.out_at),
        res.worked_minutes,
        res.built_in_minutes,
        res.calc_minutes,
        res.auto_minutes,
        res.over_limit_minutes,
        approved,
        status
      ]);
    }
  }
  for (let i = 0; i < deletes.length; i += 500) {
    const chunk = deletes.slice(i, i + 500);
    await queryDB(`DELETE FROM ot_entries WHERE id IN (${chunk.map(() => "?").join(",")}) AND decided_by IS NULL`, chunk);
  }
  for (let i = 0; i < upserts.length; i += 200) {
    const chunk = upserts.slice(i, i + 200);
    await queryDB(
      `INSERT INTO ot_entries (employee_id, work_date, day_kind, shift_id, relief, in_at, out_at, worked_minutes, built_in_minutes, calc_minutes, auto_minutes, over_limit_minutes, approved_minutes, status)
       VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
       ON DUPLICATE KEY UPDATE ${[
         "day_kind", "shift_id", "relief", "in_at", "out_at", "worked_minutes", "built_in_minutes", "calc_minutes", "auto_minutes", "over_limit_minutes", "approved_minutes"
       ]
         .map((c) => `${c} = IF(decided_by IS NULL, VALUES(${c}), ${c})`)
         .join(", ")},
         step = IF(decided_by IS NULL AND VALUES(status) <> 'pending', 1, step),
         status = IF(decided_by IS NULL, VALUES(status), status)`,
      chunk.flat()
    );
  }
  recalcStamp.set(key, Date.now());
}

// The month's payable OT per Employee (approved minutes, Off days at the Off
// day rate), for Run Payroll. `employees` carry id + designation; salary is
// read from their latest salary structure on or before `to`.
export async function payableOt(queryDB: QueryDB, from: string, to: string, employeeIds: number[]) {
  const out = new Map<number, { normal_minutes: number; off_minutes: number; hours: number; normal_rate: number; off_rate: number; rate: number; amount: number; pending: number; entries: number; rate_type: OtRateType }>();
  if (!employeeIds.length) return out;
  await recalcOt(queryDB, from, to, { employeeIds });
  const rules = await loadOtRules(queryDB);
  const ids = [...new Set(employeeIds.map(Number))];
  const ph = ids.map(() => "?").join(",");
  const [entries, emps, rates, structures] = await Promise.all([
    queryDB(`SELECT employee_id, day_kind, approved_minutes, status FROM ot_entries WHERE work_date BETWEEN ? AND ? AND employee_id IN (${ph})`, [from, to, ...ids]),
    queryDB(`SELECT id, designation, gets_ot FROM all_employees WHERE id IN (${ph})`, ids),
    queryDB("SELECT * FROM ot_rates").catch(() => []),
    queryDB(`SELECT employee_id, basic_salary, gross_salary, effective_date, id FROM salary_structures WHERE employee_id IN (${ph}) AND effective_date <= ? ORDER BY effective_date DESC, id DESC`, [...ids, to]).catch(() => [])
  ]);
  const salary = new Map<number, { basic: number; gross: number }>();
  for (const s of structures || []) if (!salary.has(Number(s.employee_id))) salary.set(Number(s.employee_id), { basic: Number(s.basic_salary) || 0, gross: Number(s.gross_salary) || 0 });
  const empById = new Map<number, any>((emps || []).map((e: any) => [Number(e.id), e]));
  const sums = new Map<number, { n: number; o: number; pending: number; entries: number }>();
  for (const x of entries || []) {
    const id = Number(x.employee_id);
    if (!sums.has(id)) sums.set(id, { n: 0, o: 0, pending: 0, entries: 0 });
    const s = sums.get(id)!;
    if (x.status === "not_eligible") continue;
    s.entries++;
    if (x.status === "pending") s.pending++;
    if (x.day_kind === "off") s.o += Number(x.approved_minutes) || 0;
    else s.n += Number(x.approved_minutes) || 0;
  }
  for (const id of ids) {
    const e = empById.get(id);
    const s = sums.get(id);
    if (!e || !s || Number(e.gets_ot) !== 1) continue;
    const capped = capMonthly(s.n, s.o, rules.monthly_max_minutes);
    const ov = rateOverride(rates || [], id, e.designation);
    const rate = otRateFor(rules, salary.get(id) || { basic: 0, gross: 0 }, ov);
    const amount = Math.round(((capped.normal / 60) * rate.exact_normal + (capped.off / 60) * rate.exact_off) * 100) / 100;
    const hours = Math.round(((capped.normal + capped.off) / 60) * 100) / 100;
    out.set(id, {
      normal_minutes: capped.normal,
      off_minutes: capped.off,
      hours,
      normal_rate: rate.normal,
      off_rate: rate.off,
      rate: hours > 0 ? Math.round((amount / hours) * 100) / 100 : rate.normal,
      amount,
      pending: s.pending,
      entries: s.entries,
      rate_type: rate.type
    });
  }
  return out;
}

function rateOverride(rates: any[], employeeId: number, designation: string | null): OtRateOverride | null {
  const own = rates.find((r) => r.employee_id != null && Number(r.employee_id) === employeeId);
  const byDesig = designation ? rates.find((r) => r.employee_id == null && r.designation && String(r.designation).trim().toLowerCase() === String(designation).trim().toLowerCase()) : null;
  const r = own || byDesig;
  if (!r) return null;
  return { rate_type: RATE_TYPES.includes(r.rate_type) ? r.rate_type : "fixed", rate: r.rate == null ? null : Number(r.rate), off_rate: r.off_rate == null ? null : Number(r.off_rate) };
}

// ---------------------------------------------------------------------------
// Who may decide an entry
// ---------------------------------------------------------------------------
interface ApproverCtx {
  superadmin: boolean;
  hasLayer: boolean;
  teamSwitch: boolean;
  deptScope: string[] | null;
  team: Set<number>; // Employees this account supervises
  supervised: Set<number>; // Employees that have any Team Supervisor
  mode: OtApproverMode;
}

async function approverContext(queryDB: QueryDB, user: any, hasModuleLayer: RegisterOvertimeRoutesDeps["hasModuleLayer"]): Promise<ApproverCtx> {
  const superadmin = user.role === "superadmin";
  const [hasLayer, me, rules] = await Promise.all([
    hasModuleLayer(user, "duty_roster", "ot_approve"),
    queryDB("SELECT can_approve_team_ot, is_onboarding FROM users WHERE id = ?", [user.id]).catch(() => []),
    loadOtRules(queryDB)
  ]);
  const teamSwitch = !!me?.[0] && Number(me[0].can_approve_team_ot) === 1 && !Number(me[0].is_onboarding);
  const deptScope = superadmin ? null : await getRosterDeptScope(queryDB, Number(user.id));
  const sup: any[] =
    (await queryDB(
      "SELECT es.employee_id, s.user_id FROM employee_supervisors es JOIN all_employees s ON s.id = es.supervisor_id WHERE es.is_direct = 1 AND s.user_id IS NOT NULL"
    ).catch(() => [])) || [];
  const site: any[] =
    (await queryDB(
      "SELECT m.employee_id, t.supervisor_user_id, t.backup_user_id FROM site_attendance_members m JOIN site_attendance_teams t ON t.id = m.team_id WHERE t.is_active = 1"
    ).catch(() => [])) || [];
  const team = new Set<number>();
  const supervised = new Set<number>();
  const uid = Number(user.id);
  for (const r of sup) {
    supervised.add(Number(r.employee_id));
    if (Number(r.user_id) === uid) team.add(Number(r.employee_id));
  }
  for (const r of site) {
    supervised.add(Number(r.employee_id));
    if (Number(r.supervisor_user_id) === uid || Number(r.backup_user_id) === uid) team.add(Number(r.employee_id));
  }
  return { superadmin, hasLayer, teamSwitch, deptScope, team, supervised, mode: rules.approver_mode };
}

// "final": deciding finishes it; "step1": passes it on to the Roster manager
// ("both, one after the other"); null: not this account's.
export function approverCan(ctx: ApproverCtx, emp: { id: number; department: string | null }, entry: { status: string; step: number }): "final" | "step1" | null {
  if (entry.status !== "pending") return null;
  if (ctx.superadmin) return "final";
  const isSup = ctx.team.has(emp.id) && (ctx.hasLayer || ctx.teamSwitch);
  const isMgr = ctx.hasLayer && (!ctx.deptScope || ctx.deptScope.includes(String(emp.department || "")));
  const hasSup = ctx.supervised.has(emp.id);
  switch (ctx.mode) {
    case "roster_manager":
      return isMgr ? "final" : null;
    case "either":
      return isSup || isMgr ? "final" : null;
    case "both":
      if (Number(entry.step) >= 2 || !hasSup) return isMgr ? "final" : null;
      if (isSup && isMgr) return "final";
      return isSup ? "step1" : null;
    case "supervisor":
    default:
      return hasSup ? (isSup ? "final" : null) : isMgr ? "final" : null;
  }
}
const canSee = (ctx: ApproverCtx, emp: { id: number; department: string | null }) =>
  ctx.superadmin || (ctx.team.has(emp.id) && (ctx.hasLayer || ctx.teamSwitch)) || (ctx.hasLayer && (!ctx.deptScope || ctx.deptScope.includes(String(emp.department || ""))));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function registerOvertimeRoutes(app: Express, deps: RegisterOvertimeRoutesDeps) {
  const { authenticateToken, requireAdmin, requireModuleLayer, hasModuleLayer, queryDB, todayInDhaka } = deps;
  const canRules = [authenticateToken, requireAdmin, requireModuleLayer("payroll", "ot_rules")];
  const fail = (res: any, err: any) => res.status(err?.statusCode || 500).json({ error: err?.message || String(err) });
  const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
  const seesAmounts = (user: any) => hasModuleLayer(user, "payroll", "salary_amounts");
  const MASK = "*****";

  // ---- Payroll -> OT Rules ----
  app.get("/api/ot/settings", ...canRules, async (req: any, res) => {
    try {
      const amounts = await seesAmounts(req.user);
      const rules = await loadOtRules(queryDB);
      const rates: any[] = (await queryDB("SELECT * FROM ot_rates").catch(() => [])) || [];
      const emps = (await companyEmployees(queryDB)).filter((e) => Number(e.is_active ?? 1) === 1);
      const empById = new Map<number, any>(emps.map((e) => [Number(e.id), e]));
      const money = (v: any) => (amounts ? (v == null ? null : Number(v)) : MASK);
      res.json({
        can_see_amounts: amounts,
        rules: { ...rules, fixed_rate: money(rules.fixed_rate), fixed_off_rate: money(rules.fixed_off_rate) },
        rates: rates
          .filter((r) => Number(r.company_id ?? 1) === activeCompanyId())
          .map((r) => {
            const e = r.employee_id != null ? empById.get(Number(r.employee_id)) : null;
            return {
              id: Number(r.id),
              designation: r.employee_id == null ? r.designation : null,
              employee_id: r.employee_id == null ? null : Number(r.employee_id),
              employee_name: e ? e.name : null,
              employee_code: e ? e.employee_id : null,
              rate_type: r.rate_type,
              rate: r.rate_type === "fixed" ? money(r.rate) : null,
              off_rate: r.rate_type === "fixed" ? money(r.off_rate) : null
            };
          }),
        designations: [...new Set(emps.map((e) => String(e.designation || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
        people: emps
          .map((e) => ({ id: Number(e.id), name: e.name, employee_code: e.employee_id || null, designation: e.designation || null, department: e.department || null, gets_ot: Number(e.gets_ot) === 1 }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/ot/settings", ...canRules, async (req: any, res) => {
    try {
      const b = req.body || {};
      const cur = await loadOtRules(queryDB);
      const amounts = await seesAmounts(req.user);
      const num = (v: any, d: number, min: number, max: number, label: string) => {
        if (v === undefined || v === null || v === "") return d;
        const n = Number(v);
        if (!Number.isFinite(n) || n < min || n > max) throw bad(`${label} must be between ${min} and ${max}.`);
        return n;
      };
      const rate_type: OtRateType = b.rate_type === undefined ? cur.rate_type : RATE_TYPES.includes(b.rate_type) ? b.rate_type : (() => { throw bad("Pick how the hourly rate is worked out."); })();
      const approver_mode: OtApproverMode = b.approver_mode === undefined ? cur.approver_mode : APPROVER_MODES.includes(b.approver_mode) ? b.approver_mode : (() => { throw bad("Pick who approves OT."); })();
      const office_start = b.office_start === undefined ? cur.office_start : String(b.office_start);
      const office_end = b.office_end === undefined ? cur.office_end : String(b.office_end);
      if (!HM_RE.test(office_start) || !HM_RE.test(office_end)) throw bad("Office hours must be HH:MM.");
      const next = {
        rate_type,
        divisor: num(b.divisor, cur.divisor, 1, 400, "Divide by"),
        multiplier: num(b.multiplier, cur.multiplier, 0, 10, "Working-day multiplier"),
        off_multiplier: num(b.off_multiplier, cur.off_multiplier, 0, 10, "Off day multiplier"),
        // Money: only someone who sees salary amounts can change it.
        fixed_rate: amounts ? num(b.fixed_rate, cur.fixed_rate, 0, 100000, "Fixed rate") : cur.fixed_rate,
        fixed_off_rate: amounts ? num(b.fixed_off_rate, cur.fixed_off_rate, 0, 100000, "Fixed Off day rate") : cur.fixed_off_rate,
        min_minutes: Math.round(num(b.min_minutes, cur.min_minutes, 0, 600, "Counts after (minutes)")),
        round_minutes: Math.round(num(b.round_minutes, cur.round_minutes, 0, 240, "Round down to (minutes)")),
        daily_max_minutes: Math.round(num(b.daily_max_minutes, cur.daily_max_minutes, 0, 1440, "Most a working day (minutes)")),
        monthly_max_minutes: Math.round(num(b.monthly_max_minutes, cur.monthly_max_minutes, 0, 44640, "Monthly limit (minutes)")),
        only_approved: b.only_approved === undefined ? cur.only_approved : !!b.only_approved,
        planned_counts_approved: b.planned_counts_approved === undefined ? cur.planned_counts_approved : !!b.planned_counts_approved,
        approver_mode,
        office_start,
        office_end
      };
      if (rate_type === "fixed" && !amounts && !(cur.fixed_rate > 0)) throw bad("A fixed rate needs an amount — ask someone who can see salary amounts.", 403);
      await queryDB(
        `INSERT INTO ot_settings (company_id, rate_type, divisor, multiplier, off_multiplier, fixed_rate, fixed_off_rate, min_minutes, round_minutes, daily_max_minutes, monthly_max_minutes,
           only_approved, planned_counts_approved, approver_mode, office_start, office_end, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE rate_type = VALUES(rate_type), divisor = VALUES(divisor), multiplier = VALUES(multiplier), off_multiplier = VALUES(off_multiplier),
           fixed_rate = VALUES(fixed_rate), fixed_off_rate = VALUES(fixed_off_rate), min_minutes = VALUES(min_minutes), round_minutes = VALUES(round_minutes),
           daily_max_minutes = VALUES(daily_max_minutes), monthly_max_minutes = VALUES(monthly_max_minutes), only_approved = VALUES(only_approved),
           planned_counts_approved = VALUES(planned_counts_approved), approver_mode = VALUES(approver_mode), office_start = VALUES(office_start),
           office_end = VALUES(office_end), updated_by = VALUES(updated_by)`,
        [
          activeCompanyId(), next.rate_type, next.divisor, next.multiplier, next.off_multiplier, next.fixed_rate, next.fixed_off_rate, next.min_minutes, next.round_minutes,
          next.daily_max_minutes, next.monthly_max_minutes, next.only_approved ? 1 : 0, next.planned_counts_approved ? 1 : 0, next.approver_mode, next.office_start, next.office_end, req.user.id
        ]
      );
      recalcStamp.clear();
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // A designation's or one person's own rate. Body: { designation | employee_id, rate_type, rate, off_rate }.
  app.post("/api/ot/rates", ...canRules, async (req: any, res) => {
    try {
      const b = req.body || {};
      const rate_type: OtRateType = RATE_TYPES.includes(b.rate_type) ? b.rate_type : "fixed";
      const designation = b.employee_id ? null : String(b.designation || "").trim().slice(0, 150);
      const employeeId = b.employee_id ? Number(b.employee_id) : null;
      if (!designation && !employeeId) throw bad("Pick a designation or a person.");
      if (employeeId && !(await companyEmployees(queryDB)).some((e) => Number(e.id) === employeeId)) throw bad("That person isn't in this company.");
      let rate: number | null = null;
      let offRate: number | null = null;
      if (rate_type === "fixed") {
        if (!(await seesAmounts(req.user))) throw bad("Setting a rate in ৳ needs \"See salary amounts\".", 403);
        rate = Number(b.rate);
        offRate = b.off_rate === "" || b.off_rate == null ? null : Number(b.off_rate);
        if (!Number.isFinite(rate) || rate <= 0 || rate > 100000) throw bad("Give the rate in ৳ an hour.");
        if (offRate !== null && (!Number.isFinite(offRate) || offRate < 0 || offRate > 100000)) throw bad("The Off day rate must be a number of ৳ an hour.");
      }
      const rows: any[] = (await queryDB("SELECT * FROM ot_rates").catch(() => [])) || [];
      const same = rows.find((r) =>
        Number(r.company_id ?? 1) === activeCompanyId() && (employeeId ? Number(r.employee_id) === employeeId : r.employee_id == null && String(r.designation || "").toLowerCase() === String(designation).toLowerCase())
      );
      if (same) {
        await queryDB("UPDATE ot_rates SET rate_type = ?, rate = ?, off_rate = ? WHERE id = ?", [rate_type, rate, offRate, same.id]);
        recalcStamp.clear();
        return res.json({ id: Number(same.id), updated: true });
      }
      const r: any = await queryDB("INSERT INTO ot_rates (company_id, designation, employee_id, rate_type, rate, off_rate, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        activeCompanyId(), designation, employeeId, rate_type, rate, offRate, req.user.id
      ]);
      recalcStamp.clear();
      res.json({ id: r.insertId });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/ot/rates/:id", ...canRules, async (req: any, res) => {
    try {
      await queryDB("DELETE FROM ot_rates WHERE id = ?", [Number(req.params.id)]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Who gets OT. Body: { employee_ids: [...] | designation, on: bool }.
  app.put("/api/ot/gets-ot", ...canRules, async (req: any, res) => {
    try {
      const on = !!req.body?.on;
      const emps = await companyEmployees(queryDB);
      let ids: number[] = [];
      if (Array.isArray(req.body?.employee_ids)) {
        const mine = new Set(emps.map((e) => Number(e.id)));
        ids = req.body.employee_ids.map(Number).filter((id: number) => mine.has(id));
      } else if (req.body?.designation) {
        const d = String(req.body.designation).trim().toLowerCase();
        ids = emps.filter((e) => Number(e.is_active ?? 1) === 1 && String(e.designation || "").trim().toLowerCase() === d).map((e) => Number(e.id));
      }
      if (!ids.length) throw bad("Nobody to change.");
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        await queryDB(`UPDATE all_employees SET gets_ot = ? WHERE id IN (${chunk.map(() => "?").join(",")})`, [on ? 1 : 0, ...chunk]);
      }
      recalcStamp.clear();
      res.json({ success: true, changed: ids.length });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- OT Approval (Duty Roster -> OT Approval, or Self Service -> Team OT) ----
  const approvalGate = async (req: any, res: any): Promise<ApproverCtx | null> => {
    if (req.user?.onb) {
      res.status(403).json({ error: "Not available while onboarding." });
      return null;
    }
    const ctx = await approverContext(queryDB, req.user, hasModuleLayer);
    if (ctx.superadmin || ctx.hasLayer || (ctx.teamSwitch && ctx.team.size)) return ctx;
    res.status(403).json({ error: "You can't approve overtime. Ask your Superadmin to grant it." });
    return null;
  };

  // ?from&to (at most 62 days), ?status=pending|approved|rejected|all.
  app.get("/api/ot/approvals", authenticateToken, async (req: any, res) => {
    try {
      const ctx = await approvalGate(req, res);
      if (!ctx) return;
      const today = todayInDhaka();
      const from = DATE_RE.test(String(req.query.from || "")) ? String(req.query.from) : `${today.slice(0, 7)}-01`;
      const to = DATE_RE.test(String(req.query.to || "")) ? String(req.query.to) : today;
      if (from > to || daysBetween(from, to) >= MAX_RANGE_DAYS) throw bad(`Pick at most ${MAX_RANGE_DAYS} days.`);
      const status = ["pending", "approved", "rejected", "all"].includes(String(req.query.status)) ? String(req.query.status) : "pending";
      await recalcOt(queryDB, from, to);
      const emps = await companyEmployees(queryDB);
      const empById = new Map<number, any>(emps.map((e) => [Number(e.id), e]));
      const [rows, shifts, users] = await Promise.all([
        queryDB("SELECT * FROM ot_entries WHERE work_date BETWEEN ? AND ? ORDER BY work_date, employee_id", [from, to]),
        loadShiftRows(queryDB),
        queryDB("SELECT id, name FROM users").catch(() => [])
      ]);
      const userName = new Map<number, string>((users || []).map((u: any) => [Number(u.id), u.name]));
      const list = [];
      for (const r of rows || []) {
        const e = empById.get(Number(r.employee_id));
        if (!e) continue;
        const emp = { id: Number(e.id), department: e.department || null };
        if (!canSee(ctx, emp)) continue;
        if (r.status === "not_eligible") continue;
        const decided = r.status === "approved" || r.status === "rejected";
        if (status === "pending" && r.status !== "pending") continue;
        if (status === "approved" && !(r.status === "approved" || r.status === "auto")) continue;
        if (status === "rejected" && r.status !== "rejected") continue;
        const can = approverCan(ctx, emp, r);
        const shift = r.shift_id != null ? shifts.get(Number(r.shift_id)) : null;
        list.push({
          id: Number(r.id),
          employee_id: emp.id,
          employee_name: e.name,
          employee_code: e.employee_id || null,
          designation: e.designation || null,
          department: e.department || null,
          date: ymd(r.work_date),
          day_kind: r.day_kind,
          relief: Number(r.relief) === 1,
          shift: shift ? { code: shift.code, name: shift.name, start: shift.start_time, end: shift.end_time } : null,
          in_at: r.in_at,
          out_at: r.out_at,
          worked_minutes: Number(r.worked_minutes),
          built_in_minutes: Number(r.built_in_minutes),
          calc_minutes: Number(r.calc_minutes),
          auto_minutes: Number(r.auto_minutes),
          over_limit_minutes: Number(r.over_limit_minutes),
          approved_minutes: Number(r.approved_minutes),
          status: r.status,
          step: Number(r.step) || 1,
          step1_by: r.step1_by ? userName.get(Number(r.step1_by)) || null : null,
          decided_by: decided && r.decided_by ? userName.get(Number(r.decided_by)) || null : null,
          decided_at: decided ? r.decided_at : null,
          note: r.note || null,
          can_act: can,
          waiting_for: r.status !== "pending" ? null : ctx.mode === "both" && Number(r.step) < 2 && ctx.supervised.has(emp.id) ? "Team Supervisor" : ctx.mode === "roster_manager" || ctx.mode === "both" || !ctx.supervised.has(emp.id) ? "Roster manager" : ctx.mode === "either" ? "Team Supervisor or Roster manager" : "Team Supervisor"
        });
      }
      res.json({ from, to, status, approver_mode: ctx.mode, entries: list });
    } catch (err) {
      fail(res, err);
    }
  });

  // Body: { action: "approve" | "reject", items: [{ id, minutes? }], note? }.
  app.post("/api/ot/approvals/decide", authenticateToken, async (req: any, res) => {
    try {
      const ctx = await approvalGate(req, res);
      if (!ctx) return;
      const action = req.body?.action === "reject" ? "reject" : req.body?.action === "approve" ? "approve" : null;
      if (!action) throw bad("Approve or reject?");
      const items: any[] = Array.isArray(req.body?.items) ? req.body.items.slice(0, 2000) : [];
      if (!items.length) throw bad("Nothing selected.");
      const note = req.body?.note ? String(req.body.note).trim().slice(0, 255) : null;
      const emps = new Map<number, any>((await companyEmployees(queryDB)).map((e) => [Number(e.id), e]));
      let finalized = 0;
      let passed = 0;
      const skipped: { id: number; reason: string }[] = [];
      for (const it of items) {
        const id = Number(it?.id);
        const row = ((await queryDB("SELECT * FROM ot_entries WHERE id = ?", [id])) || [])[0];
        const e = row ? emps.get(Number(row.employee_id)) : null;
        if (!row || !e) {
          skipped.push({ id, reason: "not found" });
          continue;
        }
        const can = approverCan(ctx, { id: Number(e.id), department: e.department || null }, row);
        if (!can) {
          skipped.push({ id, reason: row.status === "pending" ? "not yours to decide" : "already decided" });
          continue;
        }
        const calc = Number(row.calc_minutes) || 0;
        let minutes = it?.minutes === undefined || it?.minutes === null || it?.minutes === "" ? calc : Math.round(Number(it.minutes));
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > calc) {
          skipped.push({ id, reason: `hours must be between 0 and ${Math.round((calc / 60) * 100) / 100}` });
          continue;
        }
        if (action === "reject") {
          await queryDB("UPDATE ot_entries SET status = 'rejected', approved_minutes = auto_minutes, decided_by = ?, decided_at = NOW(), note = ? WHERE id = ? AND status = 'pending'", [req.user.id, note, id]);
          finalized++;
        } else if (can === "step1") {
          await queryDB("UPDATE ot_entries SET step = 2, step1_by = ?, step1_minutes = ?, note = ? WHERE id = ? AND status = 'pending'", [req.user.id, minutes, note, id]);
          passed++;
        } else {
          await queryDB("UPDATE ot_entries SET status = 'approved', approved_minutes = ?, decided_by = ?, decided_at = NOW(), note = ? WHERE id = ? AND status = 'pending'", [minutes, req.user.id, note, id]);
          finalized++;
        }
      }
      res.json({ success: true, finalized, passed_on: passed, skipped });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Self Service -> My OT ----
  app.get("/api/my-ot", authenticateToken, async (req: any, res) => {
    try {
      const u = ((await queryDB("SELECT role, can_view_my_ot, is_onboarding FROM users WHERE id = ?", [req.user.id]).catch(() => [])) || [])[0];
      if (!u || !(u.role === "superadmin" || (Number(u.can_view_my_ot) === 1 && !Number(u.is_onboarding)))) {
        return res.status(403).json({ error: "My OT isn't turned on for your account." });
      }
      const today = todayInDhaka();
      const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : today.slice(0, 7);
      const from = `${month}-01`;
      const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
      const emp = ((await queryDB("SELECT id, name, gets_ot FROM all_employees WHERE user_id = ? LIMIT 1", [req.user.id])) || [])[0];
      if (!emp) return res.json({ linked: false, month, entries: [] });
      await recalcOt(queryDB, from, last, { employeeIds: [Number(emp.id)] });
      const rows: any[] = (await queryDB("SELECT * FROM ot_entries WHERE employee_id = ? AND work_date BETWEEN ? AND ? ORDER BY work_date", [emp.id, from, last])) || [];
      const entries = rows.map((r) => ({
        date: ymd(r.work_date),
        day_kind: r.day_kind,
        in_at: r.in_at,
        out_at: r.out_at,
        calc_minutes: Number(r.calc_minutes),
        approved_minutes: Number(r.approved_minutes),
        status: r.status
      }));
      const paid = entries.filter((x) => x.status !== "not_eligible").reduce((a, x) => a + x.approved_minutes, 0);
      const waiting = entries.filter((x) => x.status === "pending").reduce((a, x) => a + (x.calc_minutes - x.approved_minutes), 0);
      res.json({ linked: true, gets_ot: Number(emp.gets_ot) === 1, month, approved_minutes: paid, waiting_minutes: waiting, entries });
    } catch (err) {
      fail(res, err);
    }
  });
}
