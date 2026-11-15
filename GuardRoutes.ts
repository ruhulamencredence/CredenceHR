/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Security guards — posts, who stands at which post on which shift, a month
// filled from a pattern, empty posts, and relief.
//
//   guard_posts       a post at a site (Main Gate, Store…). Company-owned.
//   guard_post_needs  how many guards a post needs on each shift (Day 2, Night 2).
//   duty_roster.post_id  the post a rostered shift is at (Duty Roster cell).
//   guard_relief      an extra relief duty: a guard put on a post for one
//                     shift on top of (or instead of an Off day in) their own
//                     roster. Counted by OvertimeRoutes.ts — the relief
//                     time is overtime waiting for approval.
//
// Attendance is nothing special: guards check in like every employee (app
// Check In / Out, office device) or the site supervisor marks them in Site
// Attendance. Posts only say who should be where.
//
// Access (Admin Panel -> Duty Roster -> Guard Posts): layer "guard_posts"
// (explicit-only) — see posts, coverage and who is free; add / change posts,
// fill a month from a pattern, put / remove a relief guard. Duty Roster
// Department Access applies: only those departments' people.

import type { Express } from "express";
import { activeCompanyId } from "./companyContext";
import { getRosterDeptScope } from "./RosterRoutes";
import { addDays } from "./OvertimeRoutes";
import { shiftSpan } from "./OvertimeCalc";
import { createAlert } from "./Alerts";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export interface RegisterGuardRoutesDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModuleLayer: any;
  hasModuleLayer: (user: any, moduleKey: any, layer: string) => Promise<boolean>;
  queryDB: QueryDB;
}

export async function ensureGuardSchema(dbPool: any): Promise<void> {
  const run = async (label: string, sql: string) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      console.warn(`⚠️ Guard posts (${label}): ${err.message}`);
    }
  };
  await run(
    "guard_posts",
    `CREATE TABLE IF NOT EXISTS guard_posts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL DEFAULT 1,
      name VARCHAR(120) NOT NULL,
      site VARCHAR(150) NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_guard_posts_company (company_id)
    )`
  );
  await run(
    "guard_post_needs",
    `CREATE TABLE IF NOT EXISTS guard_post_needs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      post_id INT NOT NULL,
      shift_id INT NOT NULL,
      headcount INT NOT NULL DEFAULT 1,
      UNIQUE KEY uniq_guard_need (post_id, shift_id),
      FOREIGN KEY (post_id) REFERENCES guard_posts(id) ON DELETE CASCADE
    )`
  );
  await run(
    "guard_relief",
    `CREATE TABLE IF NOT EXISTS guard_relief (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      relief_date DATE NOT NULL,
      post_id INT NOT NULL,
      shift_id INT NOT NULL,
      note VARCHAR(255) NULL,
      created_by INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_guard_relief (employee_id, relief_date),
      INDEX idx_guard_relief_date (relief_date)
    )`
  );
  // The Project (check-in site) a post stands at: a relief guard may check
  // in there during that duty (activeReliefProjects below).
  try {
    await dbPool.query("ALTER TABLE guard_posts ADD COLUMN project_id INT NULL");
  } catch (err: any) {
    if (err?.code !== "ER_DUP_FIELDNAME") console.warn(`⚠️ Guard posts (project_id): ${err.message}`);
  }
}

// ---- Relief duty: when, where, and check-in at that site ------------------
// A relief guard (guard_relief) may check in / out at the post's Project
// from 30 min before the shift starts to 30 min after it ends — and only
// then (AttendanceRoutes.ts getAllowedProjectIds). A night duty's check-out
// the next morning goes on the In of the duty's own day.
export const RELIEF_MARGIN_MIN = 30;
// A guard not checked in this long after the shift started counts as absent.
export const NO_SHOW_MIN = 30;
const dhakaYmd = (ms = Date.now()) => new Date(ms + 6 * 3600e3).toISOString().slice(0, 10);
const dhakaMs = (date: string, hm: string) => Date.parse(`${date}T${String(hm).slice(0, 5)}:00+06:00`);
export interface ReliefDuty {
  id: number;
  employee_id: number;
  date: string;
  post_id: number;
  post_name: string;
  site: string | null;
  project_id: number | null;
  project_name: string | null;
  shift_id: number;
  shift_name: string;
  start_time: string;
  end_time: string;
  start: number;
  end: number;
  from: number;
  to: number;
}
export async function reliefDuties(queryDB: QueryDB, dates: string[], employeeIds?: number[]): Promise<ReliefDuty[]> {
  if (!dates.length || (employeeIds && !employeeIds.length)) return [];
  const rows: any[] =
    (await queryDB(
      `SELECT r.id, r.employee_id, r.relief_date, r.post_id, r.shift_id, p.name AS post_name, p.site, p.project_id, pr.project_name,
              s.name AS shift_name, s.start_time, s.end_time
         FROM guard_relief r JOIN guard_posts p ON p.id = r.post_id JOIN duty_shifts s ON s.id = r.shift_id
         LEFT JOIN projects pr ON pr.id = p.project_id
        WHERE r.relief_date IN (${dates.map(() => "?").join(",")})${employeeIds ? ` AND r.employee_id IN (${employeeIds.map(() => "?").join(",")})` : ""}`,
      [...dates, ...(employeeIds || [])]
    ).catch(() => [])) || [];
  return rows.map((r) => {
    const date = ymd(r.relief_date);
    const st = String(r.start_time).slice(0, 5);
    const et = String(r.end_time).slice(0, 5);
    const start = dhakaMs(date, st);
    let end = dhakaMs(date, et);
    if (end <= start) end += 864e5;
    return {
      id: Number(r.id),
      employee_id: Number(r.employee_id),
      date,
      post_id: Number(r.post_id),
      post_name: r.post_name,
      site: r.site || null,
      project_id: r.project_id ? Number(r.project_id) : null,
      project_name: r.project_name || null,
      shift_id: Number(r.shift_id),
      shift_name: r.shift_name,
      start_time: st,
      end_time: et,
      start,
      end,
      from: start - RELIEF_MARGIN_MIN * 60e3,
      to: end + RELIEF_MARGIN_MIN * 60e3
    };
  });
}
async function employeeIdsOfUser(queryDB: QueryDB, userId: number): Promise<number[]> {
  const rows: any[] = (await queryDB("SELECT id FROM all_employees WHERE user_id = ?", [userId]).catch(() => [])) || [];
  return rows.map((r) => Number(r.id));
}
/** This account's relief duties running now (with their margin) — the Projects it may check in at for them. */
export async function activeReliefDuties(queryDB: QueryDB, userId: number, now = Date.now()): Promise<ReliefDuty[]> {
  const emp = await employeeIdsOfUser(queryDB, userId);
  if (!emp.length) return [];
  const today = dhakaYmd(now);
  const duties = await reliefDuties(queryDB, [addDays(today, -1), today], emp);
  return duties.filter((d) => d.project_id && now >= d.from && now <= d.to);
}
/** Relief guards on duty at a Project on a date (the site supervisor's muster). */
export async function reliefAtProjectOn(queryDB: QueryDB, projectId: number, date: string): Promise<ReliefDuty[]> {
  return (await reliefDuties(queryDB, [date])).filter((d) => d.project_id === projectId);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ymd = (v: any) => String(v || "").slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
export const GUARD_PATTERNS = ["six_one", "day_night_week", "four_four_two"] as const;
type Pattern = (typeof GUARD_PATTERNS)[number];

// What a guard does on day k (0 = the start date) of a pattern; `index`
// staggers the guards so their Off days don't all fall together.
export function patternDay(pattern: Pattern, k: number, index: number): "day" | "night" | "off" {
  if (pattern === "four_four_two") {
    const pos = (k + index * 5) % 10;
    return pos < 4 ? "day" : pos < 8 ? "night" : "off";
  }
  const pos = (k + index) % 7;
  if (pos === 6) return "off";
  if (pattern === "day_night_week") return (Math.floor(k / 7) + index) % 2 === 0 ? "day" : "night";
  return "day";
}

export function registerGuardRoutes(app: Express, deps: RegisterGuardRoutesDeps) {
  const { authenticateToken, requireAdmin, requireModuleLayer, hasModuleLayer, queryDB } = deps;
  // A new part of Duty Roster: seeing it needs the layer too, not just "read".
  const canManage = [authenticateToken, requireAdmin, requireModuleLayer("duty_roster", "guard_posts")];
  const canRead = canManage;
  const fail = (res: any, err: any) => res.status(err?.statusCode || 500).json({ error: err?.message || String(err) });
  const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
  const scopeOf = (user: any) => (user.role === "superadmin" ? Promise.resolve(null) : getRosterDeptScope(queryDB, Number(user.id)));

  async function companyEmployees() {
    const rows: any[] = (await queryDB("SELECT id, name, employee_id, designation, department, is_active, company_id FROM all_employees")) || [];
    return rows.filter((e) => Number(e.company_id ?? 1) === activeCompanyId() && Number(e.is_active ?? 1) === 1);
  }
  async function posts() {
    const rows: any[] = (await queryDB("SELECT * FROM guard_posts ORDER BY name").catch(() => [])) || [];
    const needs: any[] = (await queryDB("SELECT * FROM guard_post_needs").catch(() => [])) || [];
    const projects: any[] = (await queryDB("SELECT id, project_name, location_lat, location_lng FROM projects").catch(() => [])) || [];
    const projectById = new Map<number, any>(projects.map((x) => [Number(x.id), x]));
    return rows
      .filter((p) => Number(p.company_id ?? 1) === activeCompanyId())
      .map((p) => ({
        id: Number(p.id),
        name: p.name,
        site: p.site || null,
        project_id: p.project_id ? Number(p.project_id) : null,
        project_name: p.project_id ? projectById.get(Number(p.project_id))?.project_name || null : null,
        lat: p.project_id && projectById.get(Number(p.project_id))?.location_lat != null ? Number(projectById.get(Number(p.project_id)).location_lat) : null,
        lng: p.project_id && projectById.get(Number(p.project_id))?.location_lng != null ? Number(projectById.get(Number(p.project_id)).location_lng) : null,
        is_active: Number(p.is_active ?? 1) === 1,
        needs: needs.filter((n) => Number(n.post_id) === Number(p.id)).map((n) => ({ shift_id: Number(n.shift_id), headcount: Number(n.headcount) || 1 }))
      }));
  }
  async function shifts() {
    const rows: any[] = (await queryDB("SELECT id, name, code, start_time, end_time, color, is_active FROM duty_shifts ORDER BY start_time").catch(() => [])) || [];
    return rows.map((s) => ({ id: Number(s.id), name: s.name, code: s.code, start_time: String(s.start_time).slice(0, 5), end_time: String(s.end_time).slice(0, 5), color: s.color, is_active: Number(s.is_active ?? 1) === 1 }));
  }
  const inScope = (scope: string[] | null, e: any) => !scope || scope.includes(String(e?.department || ""));

  app.get("/api/guard/posts", ...canRead, async (req: any, res) => {
    try {
      const scope = await scopeOf(req.user);
      const emps = (await companyEmployees()).filter((e) => inScope(scope, e));
      res.json({
        can_manage: true,
        posts: await posts(),
        shifts: await shifts(),
        projects: (((await queryDB("SELECT id, project_name FROM projects ORDER BY project_name").catch(() => [])) as any[]) || []).map((x) => ({ id: Number(x.id), name: x.project_name })),
        people: emps
          .map((e) => ({ id: Number(e.id), name: e.name, employee_code: e.employee_id || null, designation: e.designation || null, department: e.department || null }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      });
    } catch (err) {
      fail(res, err);
    }
  });

  const readPost = async (b: any) => {
    const name = String(b?.name || "").trim().slice(0, 120);
    if (!name) throw bad("Give the post a name.");
    const site = b?.site ? String(b.site).trim().slice(0, 150) || null : null;
    const valid = new Set((await shifts()).map((s) => s.id));
    const needs = (Array.isArray(b?.needs) ? b.needs : [])
      .map((n: any) => ({ shift_id: Number(n?.shift_id), headcount: Math.round(Number(n?.headcount)) }))
      .filter((n: any) => n.headcount > 0);
    for (const n of needs) {
      if (!valid.has(n.shift_id)) throw bad("One of the shifts doesn't exist.");
      if (n.headcount > 50) throw bad("At most 50 guards a shift.");
    }
    if (!needs.length) throw bad("Say how many guards the post needs on at least one shift.");
    let projectId: number | null = b?.project_id ? Number(b.project_id) : null;
    if (projectId) {
      const pr: any[] = (await queryDB("SELECT id FROM projects WHERE id = ?", [projectId]).catch(() => [])) || [];
      if (!pr.length) throw bad("That project doesn't exist.");
    } else projectId = null;
    return { name, site, needs, projectId };
  };
  const saveNeeds = async (postId: number, needs: { shift_id: number; headcount: number }[]) => {
    await queryDB("DELETE FROM guard_post_needs WHERE post_id = ?", [postId]);
    for (const n of needs) await queryDB("INSERT INTO guard_post_needs (post_id, shift_id, headcount) VALUES (?, ?, ?)", [postId, n.shift_id, n.headcount]);
  };
  const ownPost = async (id: number) => {
    const p = (await posts()).find((x) => x.id === id);
    if (!p) throw bad("Post not found.", 404);
    return p;
  };

  app.post("/api/guard/posts", ...canManage, async (req: any, res) => {
    try {
      const p = await readPost(req.body);
      const r: any = await queryDB("INSERT INTO guard_posts (company_id, name, site, project_id, created_by) VALUES (?, ?, ?, ?, ?)", [activeCompanyId(), p.name, p.site, p.projectId, req.user.id]);
      await saveNeeds(Number(r.insertId), p.needs);
      res.json({ id: r.insertId });
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/guard/posts/:id", ...canManage, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      await ownPost(id);
      const p = await readPost(req.body);
      const active = req.body?.is_active === undefined ? 1 : req.body.is_active ? 1 : 0;
      await queryDB("UPDATE guard_posts SET name = ?, site = ?, project_id = ?, is_active = ? WHERE id = ?", [p.name, p.site, p.projectId, active, id]);
      await saveNeeds(id, p.needs);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // A post already on the roster is only switched off; an unused one goes.
  app.delete("/api/guard/posts/:id", ...canManage, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      await ownPost(id);
      const used: any[] = (await queryDB("SELECT id FROM duty_roster WHERE post_id = ? LIMIT 1", [id]).catch(() => [])) || [];
      const usedRelief: any[] = (await queryDB("SELECT id FROM guard_relief WHERE post_id = ? LIMIT 1", [id]).catch(() => [])) || [];
      if (used.length || usedRelief.length) {
        await queryDB("UPDATE guard_posts SET is_active = 0 WHERE id = ?", [id]);
        return res.json({ success: true, archived: true });
      }
      await queryDB("DELETE FROM guard_posts WHERE id = ?", [id]);
      res.json({ success: true, archived: false });
    } catch (err) {
      fail(res, err);
    }
  });

  // ?from&to (at most 31 days): each post x shift x date — who is there
  // (roster + relief) and how many are missing.
  app.get("/api/guard/coverage", ...canRead, async (req: any, res) => {
    try {
      const from = String(req.query.from || "");
      const to = String(req.query.to || "");
      if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to || daysBetween(from, to) > 30) throw bad("Pick up to 31 days.");
      const scope = await scopeOf(req.user);
      const emps = new Map<number, any>((await companyEmployees()).map((e) => [Number(e.id), e]));
      const ps = (await posts()).filter((p) => p.is_active);
      const roster: any[] =
        (await queryDB("SELECT id, employee_id, roster_date, shift_id, is_off, post_id FROM duty_roster WHERE roster_date BETWEEN ? AND ? AND post_id IS NOT NULL", [from, to]).catch(() => [])) || [];
      const relief: any[] = (await queryDB("SELECT * FROM guard_relief WHERE relief_date BETWEEN ? AND ?", [from, to]).catch(() => [])) || [];
      const name = (id: number) => {
        const e = emps.get(id);
        return e ? (inScope(scope, e) ? e.name : "Someone (other department)") : null;
      };
      const dates: string[] = [];
      for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
      // Approved leave (sick, casual…) — the person isn't there that day.
      const allEmps: any[] = (await queryDB("SELECT id, user_id, zk_device_pin FROM all_employees").catch(() => [])) || [];
      const userOfEmp = new Map<number, number>();
      const pinOfEmp = new Map<number, string>();
      for (const e of allEmps) {
        if (e.user_id) userOfEmp.set(Number(e.id), Number(e.user_id));
        if (e.zk_device_pin) pinOfEmp.set(Number(e.id), String(e.zk_device_pin));
      }
      const leaves: any[] =
        (await queryDB("SELECT user_id, leave_type, start_date, end_date FROM leave_applications WHERE status = 'approved' AND start_date <= ? AND end_date >= ?", [to, from]).catch(() => [])) || [];
      const leaveOf = (empId: number, d: string): string | null => {
        const uid = userOfEmp.get(empId);
        if (!uid) return null;
        const l = leaves.find((x) => Number(x.user_id) === uid && ymd(x.start_date) <= d && ymd(x.end_date) >= d);
        return l ? String(l.leave_type || "Leave") : null;
      };
      // Today only: a shift that started 30+ min ago with no check-in yet
      // (app, office device or the site supervisor's muster) — absent.
      const now = Date.now();
      const today = dhakaYmd(now);
      const checkedIn = new Set<string>();
      if (dates.includes(today) || dates.includes(addDays(today, -1))) {
        const days = [addDays(today, -1), today];
        const att: any[] = (await queryDB("SELECT user_id, attendance_date FROM attendance WHERE attendance_date IN (?, ?) AND check_in_at IS NOT NULL", days).catch(() => [])) || [];
        const site: any[] = (await queryDB("SELECT employee_id, attendance_date FROM site_attendance_entries WHERE attendance_date IN (?, ?) AND status IN ('present', 'late')", days).catch(() => [])) || [];
        const zk: any[] = (await queryDB("SELECT device_user_pin, DATE(punch_time) AS d FROM zk_attendance_logs WHERE DATE(punch_time) IN (?, ?)", days).catch(() => [])) || [];
        const empOfUser = new Map<number, number>();
        for (const [eid, uid] of userOfEmp) empOfUser.set(uid, eid);
        const empOfPin = new Map<string, number>();
        for (const [eid, pin] of pinOfEmp) empOfPin.set(pin, eid);
        for (const a of att) {
          const e = empOfUser.get(Number(a.user_id));
          if (e) checkedIn.add(`${e}|${ymd(a.attendance_date)}`);
        }
        for (const x of site) checkedIn.add(`${Number(x.employee_id)}|${ymd(x.attendance_date)}`);
        for (const z of zk) {
          const e = empOfPin.get(String(z.device_user_pin));
          if (e) checkedIn.add(`${e}|${ymd(z.d)}`);
        }
      }
      const shiftList = await shifts();
      const noShow = (empId: number, d: string, shiftId: number): boolean => {
        if (d !== today && d !== addDays(today, -1)) return false;
        const sh = shiftList.find((x) => x.id === shiftId);
        if (!sh) return false;
        const start = dhakaMs(d, sh.start_time);
        let end = dhakaMs(d, sh.end_time);
        if (end <= start) end += 864e5;
        if (now < start + NO_SHOW_MIN * 60e3 || now > end) return false;
        return !checkedIn.has(`${empId}|${d}`);
      };
      const out = ps.map((p) => ({
        id: p.id,
        name: p.name,
        site: p.site,
        rows: p.needs.map((n) => ({
          shift_id: n.shift_id,
          headcount: n.headcount,
          days: dates.map((d) => {
            const people = [
              ...roster
                .filter((r) => Number(r.post_id) === p.id && Number(r.shift_id) === n.shift_id && Number(r.is_off) !== 1 && ymd(r.roster_date) === d)
                .map((r) => ({ employee_id: Number(r.employee_id), name: name(Number(r.employee_id)), relief: false, relief_id: null as number | null })),
              ...relief
                .filter((r) => Number(r.post_id) === p.id && Number(r.shift_id) === n.shift_id && ymd(r.relief_date) === d)
                .map((r) => ({ employee_id: Number(r.employee_id), name: name(Number(r.employee_id)), relief: true, relief_id: Number(r.id) as number | null }))
            ]
              .filter((x) => x.name)
              .map((x) => {
                const leave = leaveOf(x.employee_id, d);
                // away: on approved leave, or not checked in 30+ min after the start (today).
                const away: "leave" | "absent" | null = leave ? "leave" : noShow(x.employee_id, d, n.shift_id) ? "absent" : null;
                return { ...x, away, leave_type: leave };
              });
            const there = people.filter((x) => !x.away).length;
            return { date: d, people, empty: Math.max(0, n.headcount - there) };
          })
        }))
      }));
      res.json({ from, to, dates, today, shifts: shiftList, posts: out });
    } catch (err) {
      fail(res, err);
    }
  });

  // ?date&shift_id: who could cover that shift — Off that day or not
  // rostered (plain relief), or on another shift that doesn't overlap
  // ("double duty" — the extra shift is overtime). Guards (anyone on a post
  // in the last 60 days) first.
  app.get("/api/guard/free", ...canRead, async (req: any, res) => {
    try {
      const date = String(req.query.date || "");
      const shiftId = Number(req.query.shift_id);
      if (!DATE_RE.test(date)) throw bad("Pick a date.");
      const allShifts = await shifts();
      const target = allShifts.find((s) => s.id === shiftId);
      if (!target) throw bad("Pick a shift.");
      // The post being covered (optional): candidates from its own site come
      // first, the rest by distance from it (each one's usual post this month).
      const allPosts = await posts();
      const forPost = req.query.post_id ? allPosts.find((x) => x.id === Number(req.query.post_id)) || null : null;
      const scope = await scopeOf(req.user);
      const emps = (await companyEmployees()).filter((e) => inScope(scope, e));
      const roster: any[] = (await queryDB("SELECT employee_id, shift_id, is_off FROM duty_roster WHERE roster_date = ?", [date]).catch(() => [])) || [];
      const relief: any[] = (await queryDB("SELECT employee_id FROM guard_relief WHERE relief_date = ?", [date]).catch(() => [])) || [];
      const recent: any[] = (await queryDB("SELECT employee_id, post_id, roster_date FROM duty_roster WHERE post_id IS NOT NULL AND roster_date BETWEEN ? AND ? ORDER BY roster_date", [addDays(date, -60), addDays(date, 30)]).catch(() => [])) || [];
      const guards = new Set(recent.map((r) => Number(r.employee_id)));
      // Each guard's usual post: the one nearest this date.
      const homePost = new Map<number, number>();
      const homeGap = new Map<number, number>();
      for (const r of recent) {
        const id = Number(r.employee_id);
        const gap = Math.abs(daysBetween(ymd(r.roster_date), date));
        if (!homeGap.has(id) || gap < homeGap.get(id)!) {
          homeGap.set(id, gap);
          homePost.set(id, Number(r.post_id));
        }
      }
      // Approved leave that day.
      const onLeave: any[] =
        (await queryDB("SELECT e.id FROM leave_applications l JOIN all_employees e ON e.user_id = l.user_id WHERE l.status = 'approved' AND l.start_date <= ? AND l.end_date >= ?", [date, date]).catch(() => [])) || [];
      const leaveSet = new Set(onLeave.map((r) => Number(r.id)));
      const km = (a: any, b: any) => {
        if (!a || !b || a.lat == null || b.lat == null || a.lng == null || b.lng == null) return null;
        const R = 6371, rad = (x: number) => (x * Math.PI) / 180;
        const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
      };
      const busy = new Set(relief.map((r) => Number(r.employee_id)));
      const rosterBy = new Map<number, any>(roster.map((r) => [Number(r.employee_id), r]));
      const [ta, tb] = shiftSpan(date, target);
      const people = [];
      for (const e of emps) {
        const id = Number(e.id);
        if (busy.has(id) || leaveSet.has(id)) continue;
        const r = rosterBy.get(id);
        let kind: "off" | "free" | "double" = "free";
        let own: string | null = null;
        let backToBack = false;
        if (r && Number(r.is_off) === 1) kind = "off";
        else if (r && r.shift_id != null) {
          const s = allShifts.find((x) => x.id === Number(r.shift_id));
          if (!s) continue;
          if (s.id === target.id) continue;
          const [a, b] = shiftSpan(date, s);
          if (a < tb && ta < b) continue; // overlaps — can't be in two places
          kind = "double";
          own = `${s.code} ${s.start_time}–${s.end_time}`;
          // Ends as the relief starts (or starts as it ends): a long stretch in a row.
          backToBack = b === ta || a === tb;
        }
        const hp = homePost.has(id) ? allPosts.find((x) => x.id === homePost.get(id)) || null : null;
        const sameSite = !!forPost && !!hp && (hp.id === forPost.id || (!!forPost.project_id && hp.project_id === forPost.project_id) || (!!forPost.site && hp.site === forPost.site));
        people.push({
          id,
          name: e.name,
          employee_code: e.employee_id || null,
          designation: e.designation || null,
          department: e.department || null,
          guard: guards.has(id),
          kind,
          own_shift: own,
          back_to_back: backToBack,
          home_post: hp ? hp.name : null,
          home_site: hp ? hp.project_name || hp.site || null : null,
          same_site: sameSite,
          distance_km: forPost && hp && !sameSite ? km(forPost, hp) : null
        });
      }
      const rank = (x: any) => (x.same_site ? 0 : 1);
      people.sort(
        (a, b) =>
          Number(b.guard) - Number(a.guard) ||
          rank(a) - rank(b) ||
          (a.distance_km ?? 9999) - (b.distance_km ?? 9999) ||
          Number(a.back_to_back) - Number(b.back_to_back) ||
          (a.kind === "double" ? 1 : 0) - (b.kind === "double" ? 1 : 0) ||
          String(a.name).localeCompare(String(b.name))
      );
      res.json({ date, shift: target, post: forPost ? { id: forPost.id, name: forPost.name, site: forPost.site, project_id: forPost.project_id, project_name: forPost.project_name } : null, people });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/guard/relief", ...canManage, async (req: any, res) => {
    try {
      const employeeId = Number(req.body?.employee_id);
      const date = String(req.body?.date || "");
      const postId = Number(req.body?.post_id);
      const shiftId = Number(req.body?.shift_id);
      if (!DATE_RE.test(date)) throw bad("Pick a date.");
      const e = (await companyEmployees()).find((x) => Number(x.id) === employeeId);
      if (!e) throw bad("That person isn't in this company.");
      const scope = await scopeOf(req.user);
      if (!inScope(scope, e)) throw bad(`${e.name} isn't in your departments.`, 403);
      const p = await ownPost(postId);
      if (!p.needs.some((n) => n.shift_id === shiftId)) throw bad("That post has no such shift.");
      const note = req.body?.note ? String(req.body.note).trim().slice(0, 255) : null;
      try {
        const r: any = await queryDB("INSERT INTO guard_relief (employee_id, relief_date, post_id, shift_id, note, created_by) VALUES (?, ?, ?, ?, ?, ?)", [employeeId, date, postId, shiftId, note, req.user.id]);
        // The guard is told (alert + push): where, when, and that check-in there is open for it.
        const who: any = (((await queryDB("SELECT user_id FROM all_employees WHERE id = ?", [employeeId]).catch(() => [])) as any[]) || [])[0];
        const sh = (await shifts()).find((x) => x.id === shiftId);
        if (who?.user_id && sh) {
          await createAlert(queryDB, {
            userId: Number(who.user_id),
            type: "roster",
            title: "Relief duty",
            message: `${date} · ${sh.name} ${sh.start_time}–${sh.end_time} · ${p.name}${p.project_name || p.site ? `, ${p.project_name || p.site}` : ""}. ${p.project_id ? `You can check in there from ${RELIEF_MARGIN_MIN} min before the start.` : ""}`.trim(),
            relatedType: "guard_relief",
            relatedId: Number(r.insertId)
          }).catch(() => undefined);
        }
        res.json({ id: r.insertId });
      } catch (err: any) {
        if (err?.code === "ER_DUP_ENTRY") throw bad(`${e.name} already has a relief duty that day.`);
        throw err;
      }
    } catch (err) {
      fail(res, err);
    }
  });

  // The signed-in guard's own relief duties: running now or starting within
  // 36 h — the My Attendance card's "Relief duty" box. Own data only.
  app.get("/api/guard/my-relief", authenticateToken, async (req: any, res) => {
    try {
      const emp = await employeeIdsOfUser(queryDB, Number(req.user.id));
      const now = Date.now();
      const today = dhakaYmd(now);
      const duties = (await reliefDuties(queryDB, [addDays(today, -1), today, addDays(today, 1)], emp)).filter((d) => d.to >= now && d.start <= now + 36 * 3600e3);
      const out = [];
      for (const d of duties) {
        // Checked in for this duty and not out yet (a night duty's morning Out).
        let open: any = null;
        if (d.project_id) {
          open = (((await queryDB("SELECT id, check_in_at FROM attendance WHERE user_id = ? AND project_id = ? AND attendance_date = ? AND check_in_at IS NOT NULL AND check_out_at IS NULL", [req.user.id, d.project_id, d.date]).catch(() => [])) as any[]) || [])[0] || null;
        }
        out.push({
          id: d.id,
          date: d.date,
          post_name: d.post_name,
          site: d.project_name || d.site,
          project_id: d.project_id,
          shift_name: d.shift_name,
          start_time: d.start_time,
          end_time: d.end_time,
          start: new Date(d.start).toISOString(),
          end: new Date(d.end).toISOString(),
          check_in_from: new Date(d.from).toISOString(),
          check_in_until: new Date(d.to).toISOString(),
          active: now >= d.from && now <= d.to,
          checked_in: !!open,
          check_in_at: open?.check_in_at || null
        });
      }
      out.sort((a, b) => a.start.localeCompare(b.start));
      res.json({ duties: out });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/guard/relief/:id", ...canManage, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const r = ((await queryDB("SELECT * FROM guard_relief WHERE id = ?", [id]).catch(() => [])) || [])[0];
      if (!r) throw bad("Not found.", 404);
      const e = (await companyEmployees()).find((x) => Number(x.id) === Number(r.employee_id));
      if (!e) throw bad("Not found.", 404);
      if (!inScope(await scopeOf(req.user), e)) throw bad(`${e.name} isn't in your departments.`, 403);
      await queryDB("DELETE FROM guard_relief WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Fill [from, to] (at most 62 days) for some guards at one post from a
  // pattern. Body: { post_id, employee_ids, from, to, pattern, day_shift_id, night_shift_id? }.
  app.post("/api/guard/pattern", ...canManage, async (req: any, res) => {
    try {
      const b = req.body || {};
      const pattern = GUARD_PATTERNS.includes(b.pattern) ? (b.pattern as Pattern) : null;
      if (!pattern) throw bad("Pick a pattern.");
      const from = String(b.from || "");
      const to = String(b.to || "");
      if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to || daysBetween(from, to) > 61) throw bad("Pick a start and end date, at most 62 days.");
      const post = await ownPost(Number(b.post_id));
      const dayShift = Number(b.day_shift_id);
      const nightShift = b.night_shift_id ? Number(b.night_shift_id) : null;
      const active = new Set((await shifts()).filter((s) => s.is_active).map((s) => s.id));
      if (!active.has(dayShift)) throw bad("Pick the day shift.");
      if (pattern !== "six_one" && (!nightShift || !active.has(nightShift))) throw bad("This pattern needs a night shift too.");
      const ids: number[] = (Array.isArray(b.employee_ids) ? b.employee_ids : []).map(Number);
      if (!ids.length || ids.length > 100) throw bad("Pick the guards (at most 100).");
      const emps = new Map<number, any>((await companyEmployees()).map((e) => [Number(e.id), e]));
      const scope = await scopeOf(req.user);
      for (const id of ids) {
        const e = emps.get(id);
        if (!e) throw bad("One of the guards isn't in this company.");
        if (!inScope(scope, e)) throw bad(`${e.name} isn't in your departments.`, 403);
      }
      const rows: any[][] = [];
      const n = daysBetween(from, to);
      ids.forEach((id, index) => {
        for (let k = 0; k <= n; k++) {
          const what = patternDay(pattern, k, index);
          const d = addDays(from, k);
          if (what === "off") rows.push([id, d, null, 1, null, req.user.id]);
          else rows.push([id, d, what === "day" ? dayShift : nightShift, 0, post.id, req.user.id]);
        }
      });
      for (let i = 0; i < rows.length; i += 300) {
        const chunk = rows.slice(i, i + 300);
        await queryDB(
          `INSERT INTO duty_roster (employee_id, roster_date, shift_id, is_off, post_id, updated_by) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}
           ON DUPLICATE KEY UPDATE shift_id = VALUES(shift_id), is_off = VALUES(is_off), post_id = VALUES(post_id), updated_by = VALUES(updated_by)`,
          chunk.flat()
        );
      }
      res.json({ success: true, saved: rows.length });
    } catch (err) {
      fail(res, err);
    }
  });
}
