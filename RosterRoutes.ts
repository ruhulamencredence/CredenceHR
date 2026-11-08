/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Duty Roster — shifts and who works which shift on which day.
//
//   duty_shifts   the company's shifts (name, code, start / end time, its own
//                 grace minutes). Company-owned (companyScope.ts OWN_TABLES).
//   duty_roster   one row per Employee per date: a shift, or an Off day.
//                 Follows the Employee (EMPLOYEE_TABLES).
//
// A date with no roster row behaves exactly as before: the Holiday Calendar
// decides whether it is a working day and the Late Attendance Policy decides
// when someone is late. A roster row overrides both for that one Employee on
// that one date:
//   - Off day  -> not a working day (counts like a Weekend), never Absent or late;
//   - a shift  -> a working day even on a calendar Weekend/Holiday (on duty),
//                 and late is measured from the shift's own start time.
// Every attendance figure (office punches, site muster roll, payroll's
// present / absent / late, Employee 360, Reports) reads the roster through
// loadRoster() below, so they all agree.
//
// Access:
//   Admin Panel module "duty_roster" — layer "read" sees shifts and the
//   roster; layer "roster_manage" (explicit-only) adds / edits shifts and sets
//   the roster.
//   Department Access (Module Access -> Duty Roster -> departments,
//   duty_roster_department_access): an account with departments ticked sees
//   and sets the roster of those departments' employees only, and can't
//   change the shifts themselves; no departments ticked = every department
//   and the shifts too (HR's full setup). Same "no rows = unrestricted" rule
//   as attendance_report_department_access.
//   Self Service -> My Duty Roster: users.can_view_roster, OFF by default,
//   toggled in Module Access.

import type { Express } from "express";
import type { AlertType } from "./Alerts";
import { getHolidayMapsByGroup, getEmployeeBranchTypeByEmployeeId, type HolidayAppliesTo } from "./holidayRoutes";
import { activeCompanyId } from "./companyContext";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export interface RegisterRosterRoutesDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: any;
  requireModuleLayer: any;
  hasModuleLayer: (user: any, moduleKey: any, layer: string) => Promise<boolean>;
  queryDB: QueryDB;
  todayInDhaka: () => string;
  createAlert: (queryDB: QueryDB, params: { userId: number; type: AlertType; title: string; message: string; relatedType?: string; relatedId?: number }) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
export async function ensureRosterSchema(dbPool: any): Promise<void> {
  const run = async (label: string, sql: string, ignore: string[] = []) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      if (!ignore.includes(err.code)) console.warn(`⚠️ Duty Roster (${label}): ${err.message}`);
    }
  };
  await run("users.can_view_roster", "ALTER TABLE users ADD COLUMN can_view_roster TINYINT(1) NOT NULL DEFAULT 0", ["ER_DUP_FIELDNAME"]);
  await run(
    "duty_roster_department_access",
    `CREATE TABLE IF NOT EXISTS duty_roster_department_access (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      department VARCHAR(150) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user_department (user_id, department),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  );
  await run(
    "duty_shifts",
    `CREATE TABLE IF NOT EXISTS duty_shifts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL DEFAULT 1,
      name VARCHAR(100) NOT NULL,
      code VARCHAR(8) NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      grace_minutes INT NULL,
      extreme_grace_minutes INT NULL,
      color VARCHAR(16) NOT NULL DEFAULT '#7F00FF',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_duty_shifts_company (company_id)
    )`
  );
  await run(
    "duty_roster",
    `CREATE TABLE IF NOT EXISTS duty_roster (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      roster_date DATE NOT NULL,
      shift_id INT NULL,
      is_off TINYINT(1) NOT NULL DEFAULT 0,
      note VARCHAR(255) NULL,
      updated_by INT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_duty_roster_day (employee_id, roster_date),
      INDEX idx_duty_roster_date (roster_date)
    )`
  );
}

// ---------------------------------------------------------------------------
// Reading the roster (used by every attendance figure)
// ---------------------------------------------------------------------------
export interface RosterShift {
  id: number;
  name: string;
  code: string;
  start_time: string; // "HH:MM:SS"
  end_time: string;
  grace_minutes: number | null;
  extreme_grace_minutes: number | null;
  color: string;
  crosses_midnight: boolean;
}
export interface RosterDay {
  is_off: boolean;
  shift: RosterShift | null;
  note: string | null;
}

export const ROSTER_OFF_TITLE = "Off day (roster)";

const ymd = (v: any): string => {
  if (!v) return "";
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  return String(v).slice(0, 10);
};
const hms = (v: any): string => {
  const s = String(v || "").trim();
  return /^\d{2}:\d{2}$/.test(s) ? `${s}:00` : s.slice(0, 8);
};
const minutesOf = (t: string) => {
  const [h, m] = String(t || "00:00").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

export function shiftFromRow(r: any): RosterShift {
  const start = hms(r.start_time);
  const end = hms(r.end_time);
  return {
    id: Number(r.id),
    name: String(r.name || ""),
    code: String(r.code || ""),
    start_time: start,
    end_time: end,
    grace_minutes: r.grace_minutes == null ? null : Number(r.grace_minutes),
    extreme_grace_minutes: r.extreme_grace_minutes == null ? null : Number(r.extreme_grace_minutes),
    color: String(r.color || "#7F00FF"),
    crosses_midnight: minutesOf(end) <= minutesOf(start)
  };
}

export class RosterIndex {
  private byEmp = new Map<number, Map<string, RosterDay>>();
  private holidayCache = new Map<string, Map<string, any>>();

  set(employeeId: number, date: string, day: RosterDay) {
    if (!this.byEmp.has(employeeId)) this.byEmp.set(employeeId, new Map());
    this.byEmp.get(employeeId)!.set(date, day);
  }
  get(employeeId: number, date: string): RosterDay | undefined {
    return this.byEmp.get(Number(employeeId))?.get(date);
  }
  shiftOn(employeeId: number, date: string): RosterShift | null {
    const d = this.get(employeeId, date);
    return d && !d.is_off ? d.shift : null;
  }
  daysOf(employeeId: number): Map<string, RosterDay> {
    return this.byEmp.get(Number(employeeId)) || new Map();
  }
  get isEmpty() {
    return this.byEmp.size === 0;
  }
  // That Employee's own Weekend/Holiday map: the calendar map of their group
  // (Head Office / Project site) with their roster laid over it — an Off day
  // is added (as a Weekend), a rostered shift on a calendar Weekend/Holiday
  // takes that date out (they are on duty). Cached per (employee, base map).
  holidaysFor(employeeId: number, base: Map<string, any>): Map<string, any> {
    const days = this.byEmp.get(Number(employeeId));
    if (!days || !days.size) return base;
    const key = `${employeeId}|${this.baseId(base)}`;
    const hit = this.holidayCache.get(key);
    if (hit) return hit;
    const out = new Map(base);
    for (const [date, d] of days) {
      if (d.is_off) out.set(date, { entry_date: date, title: ROSTER_OFF_TITLE, day_type: "weekend", roster_off: true });
      else if (d.shift) out.delete(date);
    }
    this.holidayCache.set(key, out);
    return out;
  }
  private baseIds = new WeakMap<Map<string, any>, number>();
  private nextBaseId = 1;
  private baseId(m: Map<string, any>) {
    let id = this.baseIds.get(m);
    if (!id) {
      id = this.nextBaseId++;
      this.baseIds.set(m, id);
    }
    return id;
  }
}

// The Departments an account may set the roster for, or null for every
// Department (no rows). A Superadmin is never restricted — callers check.
export async function getRosterDeptScope(queryDB: QueryDB, userId: number): Promise<string[] | null> {
  try {
    const rows: any[] = (await queryDB("SELECT department FROM duty_roster_department_access WHERE user_id = ?", [userId])) || [];
    return rows.length ? rows.map((r) => String(r.department)) : null;
  } catch {
    return null;
  }
}

export async function loadShifts(queryDB: QueryDB, activeOnly = false): Promise<RosterShift[]> {
  const rows: any[] = (await queryDB("SELECT * FROM duty_shifts ORDER BY start_time, name").catch(() => [])) || [];
  return rows.filter((r) => !activeOnly || Number(r.is_active ?? 1) === 1).map(shiftFromRow);
}

// Every roster row in [from, to] (both "YYYY-MM-DD"), optionally for some
// Employees only. Fails soft — no roster table yet means an empty roster,
// i.e. everything behaves as it did before the roster existed.
export async function loadRoster(queryDB: QueryDB, from: string, to: string, employeeIds?: number[]): Promise<RosterIndex> {
  const idx = new RosterIndex();
  try {
    if (employeeIds && !employeeIds.length) return idx;
    const ids = employeeIds ? [...new Set(employeeIds.map(Number))] : null;
    const rows: any[] =
      (await queryDB(
        `SELECT employee_id, roster_date, shift_id, is_off, note FROM duty_roster WHERE roster_date BETWEEN ? AND ?${ids ? ` AND employee_id IN (${ids.map(() => "?").join(",")})` : ""}`,
        [from, to, ...(ids || [])]
      )) || [];
    if (!rows.length) return idx;
    const shifts = new Map<number, RosterShift>((await loadShifts(queryDB)).map((s) => [s.id, s]));
    for (const r of rows) {
      const isOff = Number(r.is_off) === 1;
      const shift = r.shift_id != null ? shifts.get(Number(r.shift_id)) || null : null;
      if (!isOff && !shift) continue;
      idx.set(Number(r.employee_id), ymd(r.roster_date), { is_off: isOff, shift: isOff ? null : shift, note: r.note || null });
    }
  } catch {
    // Best-effort, same as the Holiday Calendar lookups.
  }
  return idx;
}

// When someone on `shift` (or on the plain Late Attendance Policy when no
// shift is rostered) counts as Delay / Extreme Delay, in minutes of the day.
// A shift's own grace minutes win over the policy's; Extreme Delay always
// stays later than Delay.
export function lateThresholds(policy: any, shift: RosterShift | null) {
  const start = minutesOf(shift ? shift.start_time : String(policy?.shift_start_time || "09:00"));
  const grace = shift && shift.grace_minutes != null ? shift.grace_minutes : Number(policy?.grace_minutes ?? 10);
  let extreme = shift && shift.extreme_grace_minutes != null ? shift.extreme_grace_minutes : Number(policy?.extreme_grace_minutes ?? 60);
  if (extreme <= grace) extreme = grace + 1;
  return { start, delay: start + grace, extreme: start + extreme, crossesMidnight: !!shift?.crosses_midnight };
}

// A night shift's check-in: the first punch of the date that is no earlier
// than 4 hours before the shift starts — the early-morning punches on that
// date are the previous night's check-out, not an arrival.
export const NIGHT_SHIFT_EARLY_WINDOW_MIN = 240;
export function nightShiftCheckIn(punches: Date[], shift: RosterShift): Date | null {
  const from = minutesOf(shift.start_time) - NIGHT_SHIFT_EARLY_WINDOW_MIN;
  let best: Date | null = null;
  for (const p of punches) {
    const m = p.getHours() * 60 + p.getMinutes();
    if (m < from) continue;
    if (!best || p < best) best = p;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_CELLS = 6000;
const MAX_RANGE_DAYS = 62;

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
};
const daysBetween = (from: string, to: string) => Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86400000);

export function registerRosterRoutes(app: Express, deps: RegisterRosterRoutesDeps) {
  const { authenticateToken, requireAdmin, requireModuleLayer, hasModuleLayer, queryDB, todayInDhaka, createAlert } = deps;
  const canRead = [authenticateToken, requireAdmin, requireModuleLayer("duty_roster", "read")];
  const canManage = [authenticateToken, requireAdmin, requireModuleLayer("duty_roster", "roster_manage")];
  const fail = (res: any, err: any) => res.status(err?.statusCode || 500).json({ error: err?.message || String(err) });
  const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

  const scopeOf = (user: any) => (user.role === "superadmin" ? Promise.resolve(null) : getRosterDeptScope(queryDB, Number(user.id)));
  // Shifts are the whole company's; an account limited to some Departments
  // only sets those Departments' roster.
  const shiftEditGuard = async (req: any, res: any, next: any) => {
    if (await scopeOf(req.user)) return res.status(403).json({ error: "Your Duty Roster access is limited to some departments, so you can't change the shifts. Ask HR." });
    next();
  };
  const canEditShifts = [...canManage, shiftEditGuard];

  async function companyEmployees(): Promise<any[]> {
    const rows: any[] = (await queryDB("SELECT * FROM all_employees")) || [];
    return rows.filter((e) => Number(e.company_id ?? 1) === activeCompanyId());
  }

  function readShiftBody(body: any) {
    const name = String(body?.name || "").trim().slice(0, 100);
    const code = String(body?.code || "").trim().toUpperCase().slice(0, 8);
    const start = String(body?.start_time || "").trim();
    const end = String(body?.end_time || "").trim();
    const num = (v: any) => (v === null || v === undefined || v === "" ? null : Math.round(Number(v)));
    const grace = num(body?.grace_minutes);
    const extreme = num(body?.extreme_grace_minutes);
    const color = COLOR_RE.test(String(body?.color || "")) ? String(body.color) : "#7F00FF";
    if (!name) throw bad("Give the shift a name.");
    if (!code) throw bad("Give the shift a short code (e.g. M, E, N).");
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) throw bad("Start and end time must be HH:MM.");
    if (hms(start) === hms(end)) throw bad("Start and end time can't be the same.");
    for (const [label, v] of [["Grace minutes", grace], ["Extreme Delay minutes", extreme]] as const) {
      if (v !== null && (!Number.isFinite(v) || v < 0 || v > 600)) throw bad(`${label} must be between 0 and 600.`);
    }
    if (grace !== null && extreme !== null && extreme <= grace) throw bad("Extreme Delay minutes must be more than the grace minutes.");
    return { name, code, start_time: hms(start), end_time: hms(end), grace_minutes: grace, extreme_grace_minutes: extreme, color };
  }

  // ---- shifts ----
  app.get("/api/roster/shifts", ...canRead, async (req: any, res) => {
    try {
      const scope = await scopeOf(req.user);
      const canManageRoster = await hasModuleLayer(req.user, "duty_roster", "roster_manage");
      res.json({ can_manage: canManageRoster, can_edit_shifts: canManageRoster && !scope, departments: scope, shifts: await loadShifts(queryDB), inactive: ((await queryDB("SELECT id, is_active FROM duty_shifts").catch(() => [])) || []).filter((r: any) => Number(r.is_active ?? 1) !== 1).map((r: any) => Number(r.id)) });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/roster/shifts", ...canEditShifts, async (req: any, res) => {
    try {
      const s = readShiftBody(req.body);
      const dup = (await loadShifts(queryDB, true)).find((x) => x.code === s.code);
      if (dup) throw bad(`Code ${s.code} is already used by "${dup.name}".`);
      const r: any = await queryDB(
        "INSERT INTO duty_shifts (name, code, start_time, end_time, grace_minutes, extreme_grace_minutes, color, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [s.name, s.code, s.start_time, s.end_time, s.grace_minutes, s.extreme_grace_minutes, s.color, req.user.id]
      );
      res.json({ id: r.insertId });
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/roster/shifts/:id", ...canEditShifts, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const s = readShiftBody(req.body);
      const all = await loadShifts(queryDB);
      if (!all.some((x) => x.id === id)) throw bad("Shift not found.", 404);
      const dup = (await loadShifts(queryDB, true)).find((x) => x.code === s.code && x.id !== id);
      if (dup) throw bad(`Code ${s.code} is already used by "${dup.name}".`);
      const isActive = req.body?.is_active === undefined ? 1 : req.body.is_active ? 1 : 0;
      await queryDB(
        "UPDATE duty_shifts SET name = ?, code = ?, start_time = ?, end_time = ?, grace_minutes = ?, extreme_grace_minutes = ?, color = ?, is_active = ? WHERE id = ?",
        [s.name, s.code, s.start_time, s.end_time, s.grace_minutes, s.extreme_grace_minutes, s.color, isActive, id]
      );
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // A shift already on the roster is only switched off (kept for the days it
  // was worked); an unused one is removed.
  app.delete("/api/roster/shifts/:id", ...canEditShifts, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const used: any[] = (await queryDB("SELECT id FROM duty_roster WHERE shift_id = ? LIMIT 1", [id])) || [];
      if (used.length) {
        await queryDB("UPDATE duty_shifts SET is_active = 0 WHERE id = ?", [id]);
        return res.json({ success: true, archived: true });
      }
      await queryDB("DELETE FROM duty_shifts WHERE id = ?", [id]);
      res.json({ success: true, archived: false });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- the roster grid ----
  // ?from&to (at most 62 days) — every active Employee of this company with
  // their roster rows and their own calendar Weekends/Holidays in the range.
  app.get("/api/roster", ...canRead, async (req: any, res) => {
    try {
      const from = String(req.query.from || "");
      const to = String(req.query.to || "");
      if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw bad("from and to must be YYYY-MM-DD dates, from on or before to.");
      if (daysBetween(from, to) >= MAX_RANGE_DAYS) throw bad(`Pick at most ${MAX_RANGE_DAYS} days.`);
      const [employees, maps, groups, branches] = await Promise.all([
        companyEmployees(),
        getHolidayMapsByGroup(queryDB, from, to),
        getEmployeeBranchTypeByEmployeeId(queryDB),
        queryDB("SELECT id, branch_name FROM branches").catch(() => [])
      ]);
      const scope = await scopeOf(req.user);
      const active = employees.filter((e) => Number(e.is_active ?? 1) === 1 && (!scope || scope.includes(String(e.department || ""))));
      const raw: any[] =
        (await queryDB("SELECT employee_id, roster_date, shift_id, is_off, note FROM duty_roster WHERE roster_date BETWEEN ? AND ?", [from, to]).catch(() => [])) || [];
      const branchName = new Map<number, string>((branches || []).map((b: any) => [Number(b.id), b.branch_name]));
      const byEmp = new Map<number, Record<string, { shift_id: number | null; is_off: boolean; note: string | null }>>();
      for (const r of raw) {
        const id = Number(r.employee_id);
        if (!byEmp.has(id)) byEmp.set(id, {});
        byEmp.get(id)![ymd(r.roster_date)] = { shift_id: r.shift_id == null ? null : Number(r.shift_id), is_off: Number(r.is_off) === 1, note: r.note || null };
      }
      const holidayCells = (g: HolidayAppliesTo) => {
        const out: Record<string, { title: string; type: string }> = {};
        for (const [d, h] of (maps as any)[g] as Map<string, any>) out[d] = { title: h.title || (h.day_type === "weekend" ? "Weekend" : "Holiday"), type: h.day_type };
        return out;
      };
      const holidays = { head_office: holidayCells("head_office"), project_site: holidayCells("project_site") };
      res.json({
        from,
        to,
        departments: scope,
        holidays,
        employees: active
          .map((e) => ({
            id: Number(e.id),
            name: e.name,
            employee_code: e.employee_id || null,
            designation: e.designation || null,
            department: e.department || null,
            branch: e.branch_id != null ? branchName.get(Number(e.branch_id)) || null : null,
            group: groups.get(Number(e.id)) || "head_office",
            days: byEmp.get(Number(e.id)) || {}
          }))
          .sort((a, b) => String(a.department || "").localeCompare(String(b.department || "")) || String(a.name).localeCompare(String(b.name)))
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // Body: { cells: [{ employee_id, date, shift_id | null, is_off }] } — sets
  // each (Employee, date); a cell with neither a shift nor Off is cleared
  // (back to the calendar and the plain policy).
  app.put("/api/roster/cells", ...canManage, async (req: any, res) => {
    try {
      const cells: any[] = Array.isArray(req.body?.cells) ? req.body.cells : [];
      if (!cells.length) throw bad("Nothing to save.");
      if (cells.length > MAX_CELLS) throw bad(`At most ${MAX_CELLS} cells at a time.`);
      const employees = new Map<number, any>((await companyEmployees()).map((e) => [Number(e.id), e]));
      const scope = await scopeOf(req.user);
      const shifts = new Map<number, RosterShift>((await loadShifts(queryDB)).map((s) => [s.id, s]));
      const inactive = new Set<number>(((await queryDB("SELECT id, is_active FROM duty_shifts").catch(() => [])) || []).filter((r: any) => Number(r.is_active ?? 1) !== 1).map((r: any) => Number(r.id)));
      const seen = new Set<string>();
      const sets: [number, string, number | null, number, string | null][] = [];
      const clears: [number, string][] = [];
      for (const c of cells) {
        const employeeId = Number(c?.employee_id);
        const date = String(c?.date || "");
        if (!employees.has(employeeId)) throw bad("One of the employees isn't in this company.");
        if (scope && !scope.includes(String(employees.get(employeeId).department || ""))) {
          throw bad(`${employees.get(employeeId).name} isn't in your departments (${scope.join(", ")}).`, 403);
        }
        if (!DATE_RE.test(date)) throw bad("Every date must be YYYY-MM-DD.");
        const key = `${employeeId}|${date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const isOff = !!c?.is_off;
        const shiftId = c?.shift_id == null || c.shift_id === "" ? null : Number(c.shift_id);
        if (shiftId !== null && !shifts.has(shiftId)) throw bad("One of the shifts doesn't exist.");
        if (shiftId !== null && inactive.has(shiftId)) throw bad(`Shift "${shifts.get(shiftId)!.name}" is switched off — switch it on first.`);
        const note = c?.note ? String(c.note).trim().slice(0, 255) || null : null;
        if (!isOff && shiftId === null) clears.push([employeeId, date]);
        else sets.push([employeeId, date, isOff ? null : shiftId, isOff ? 1 : 0, note]);
      }
      // What changes for whom, for their alert (only real changes).
      const touchedIds = [...new Set([...sets.map((s) => s[0]), ...clears.map((c) => c[0])])];
      const dates = [...sets.map((s) => s[1]), ...clears.map((c) => c[1])].sort();
      const before = await loadRoster(queryDB, dates[0], dates[dates.length - 1], touchedIds);
      const changedDates = new Map<number, string[]>();
      const markChange = (id: number, d: string) => {
        if (!changedDates.has(id)) changedDates.set(id, []);
        changedDates.get(id)!.push(d);
      };
      for (const [id, d, shiftId, off] of sets) {
        const was = before.get(id, d);
        if (!was || was.is_off !== !!off || (was.shift?.id ?? null) !== shiftId) markChange(id, d);
      }
      for (const [id, d] of clears) if (before.get(id, d)) markChange(id, d);

      for (let i = 0; i < sets.length; i += 300) {
        const chunk = sets.slice(i, i + 300);
        await queryDB(
          `INSERT INTO duty_roster (employee_id, roster_date, shift_id, is_off, note, updated_by) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}
           ON DUPLICATE KEY UPDATE shift_id = VALUES(shift_id), is_off = VALUES(is_off), note = VALUES(note), updated_by = VALUES(updated_by)`,
          chunk.flatMap((s) => [...s, req.user.id])
        );
      }
      for (const [id, d] of clears) await queryDB("DELETE FROM duty_roster WHERE employee_id = ? AND roster_date = ?", [id, d]);

      // An alert for everyone whose roster changed and who can see their own
      // roster (Self Service -> My Duty Roster).
      const today = todayInDhaka();
      const userIds = [...changedDates.keys()].map((id) => Number(employees.get(id)?.user_id)).filter(Boolean);
      if (userIds.length) {
        const users: any[] =
          (await queryDB(`SELECT id, role, can_view_roster FROM users WHERE id IN (${userIds.map(() => "?").join(",")})`, userIds).catch(() => [])) || [];
        const canView = new Set<number>(users.filter((u) => u.role === "superadmin" || Number(u.can_view_roster) === 1).map((u) => Number(u.id)));
        for (const [id, ds] of changedDates) {
          const uid = Number(employees.get(id)?.user_id);
          if (!uid || !canView.has(uid) || Number(uid) === Number(req.user.id)) continue;
          const upcoming = ds.filter((d) => d >= today).sort();
          if (!upcoming.length) continue;
          const span = upcoming.length === 1 ? upcoming[0] : `${upcoming[0]} – ${upcoming[upcoming.length - 1]}`;
          await createAlert(queryDB, {
            userId: uid,
            type: "roster",
            title: "Your duty roster changed",
            message: `${upcoming.length} day${upcoming.length === 1 ? "" : "s"} changed (${span}). Open Self Service → My Duty Roster to see your shifts.`,
            relatedType: "duty_roster"
          });
        }
      }
      res.json({ success: true, saved: sets.length, cleared: clears.length, changed: [...changedDates.values()].reduce((n, d) => n + d.length, 0) });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Self Service -> My Duty Roster ----
  async function canViewOwnRoster(userId: number) {
    const rows: any[] = (await queryDB("SELECT role, can_view_roster, is_onboarding FROM users WHERE id = ?", [userId]).catch(() => [])) || [];
    const u = rows[0];
    return !!u && (u.role === "superadmin" || (Number(u.can_view_roster) === 1 && !Number(u.is_onboarding)));
  }

  app.get("/api/my-roster", authenticateToken, async (req: any, res) => {
    try {
      if (!(await canViewOwnRoster(Number(req.user.id)))) return res.status(403).json({ error: "My Duty Roster isn't turned on for your account." });
      const today = todayInDhaka();
      const from = DATE_RE.test(String(req.query.from || "")) ? String(req.query.from) : today;
      const to = DATE_RE.test(String(req.query.to || "")) ? String(req.query.to) : addDays(from, 30);
      if (from > to || daysBetween(from, to) >= MAX_RANGE_DAYS) throw bad(`Pick at most ${MAX_RANGE_DAYS} days.`);
      const emp: any[] = (await queryDB("SELECT id, name FROM all_employees WHERE user_id = ? LIMIT 1", [req.user.id])) || [];
      if (!emp.length) return res.json({ linked: false, from, to, today, days: [] });
      const employeeId = Number(emp[0].id);
      const [roster, maps, groups] = await Promise.all([
        loadRoster(queryDB, from, to, [employeeId]),
        getHolidayMapsByGroup(queryDB, from, to),
        getEmployeeBranchTypeByEmployeeId(queryDB)
      ]);
      const cal: Map<string, any> = (maps as any)[groups.get(employeeId) || "head_office"];
      const days = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const r = roster.get(employeeId, d);
        const h = cal.get(d);
        days.push({
          date: d,
          weekday: new Date(`${d}T00:00:00`).getDay(),
          is_off: !!r?.is_off,
          shift: r && !r.is_off ? r.shift : null,
          note: r?.note || null,
          holiday: h ? { title: h.title || (h.day_type === "weekend" ? "Weekend" : "Holiday"), type: h.day_type } : null
        });
      }
      res.json({ linked: true, from, to, today, days });
    } catch (err) {
      fail(res, err);
    }
  });
}
