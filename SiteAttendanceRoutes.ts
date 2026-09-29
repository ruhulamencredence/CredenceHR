/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Site Attendance (supervisor muster roll) — attendance for people who never
// use the app themselves (project-site workers, labourers…) and have no ZK
// terminal nearby.
//
//   HR (Admin Panel -> Office Attendance -> Site Attendance, 'office_attendance'
//   module) sets up TEAMS: a name, optionally the Project it works at, one
//   supervisor account (plus an optional backup) and its members from the
//   Employee roster. A member needs no login of their own.
//
//   The supervisor opens Self Service -> Team Attendance on their phone, picks
//   the date (today, or a few days back — see backdate_days) and marks each
//   member Present / Late (with arrival time) / Absent / Leave, optionally
//   with a team photo; the phone's location is attached and checked against
//   the team's / Project's site circle (outside is flagged, not blocked).
//   One sheet per team per day (site_attendance_sheets) holding one entry per
//   member (site_attendance_entries, unique per employee per day, so the same
//   person can't be marked by two teams).
//
//   When settings.require_approval is on, a sheet waits for HR review and
//   only an approved sheet counts; otherwise it counts as soon as it's saved
//   (HR can still correct or send it back). Counting entries carry
//   confirmed = 1 — that's what Employee 360, Employee Reports and the
//   Payroll wizard read (loadSiteEntries below).
//
//   A supervisor who hasn't submitted today's sheet by 11:00 gets one
//   reminder alert per team per day (working days only).
//
// Same data-access convention as HROperationsRoutes.ts: reads are
// `SELECT * FROM x` (optionally narrowed by one `WHERE col = ?`) re-filtered
// in JS, writes only ever use `WHERE id = ?`.

import type { Express } from "express";
import type { AlertType } from "./Alerts";
import { getHolidayMapsByGroup, getEmployeeBranchTypeByEmployeeId, type HolidayAppliesTo } from "./holidayRoutes";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface SiteAttendanceRouteDeps {
  authenticateToken: any;
  requireModule: (moduleKey: "office_attendance") => any;
  queryDB: QueryDB;
  getAdminModules: (userId: number) => Promise<string[]>;
  todayInDhaka: () => string;
  haversineMeters: (lat1: number, lng1: number, lat2: number, lng2: number) => number;
  createAlert: (
    queryDB: QueryDB,
    params: { userId: number; type: AlertType; title: string; message: string; relatedType?: string; relatedId?: number }
  ) => Promise<void>;
}

export async function ensureSiteAttendanceSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  const tables = [
    `CREATE TABLE IF NOT EXISTS site_attendance_teams (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      project_id INT NULL,
      site_location VARCHAR(255) NULL,
      supervisor_user_id INT NOT NULL,
      backup_user_id INT NULL,
      -- optional own site circle; falls back to the Project's location
      lat DECIMAL(10, 7) NULL,
      lng DECIMAL(10, 7) NULL,
      radius_m INT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      reminded_on DATE NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS site_attendance_members (
      id INT AUTO_INCREMENT PRIMARY KEY,
      team_id INT NOT NULL,
      employee_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_site_member (employee_id),
      FOREIGN KEY (team_id) REFERENCES site_attendance_teams(id) ON DELETE CASCADE,
      FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS site_attendance_sheets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      team_id INT NOT NULL,
      attendance_date DATE NOT NULL,
      -- submitted -> approved | rejected (-> submitted again)
      status VARCHAR(20) NOT NULL DEFAULT 'submitted',
      submitted_by INT NULL,
      submitted_at TIMESTAMP NULL DEFAULT NULL,
      lat DECIMAL(10, 7) NULL,
      lng DECIMAL(10, 7) NULL,
      accuracy_m INT NULL,
      distance_m INT NULL,
      outside_site TINYINT(1) NOT NULL DEFAULT 0,
      photo_mime VARCHAR(100) NULL,
      photo_data LONGBLOB NULL,
      note VARCHAR(500) NULL,
      reviewed_by INT NULL,
      reviewed_at TIMESTAMP NULL DEFAULT NULL,
      review_note VARCHAR(500) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_site_sheet (team_id, attendance_date),
      FOREIGN KEY (team_id) REFERENCES site_attendance_teams(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS site_attendance_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sheet_id INT NOT NULL,
      team_id INT NOT NULL,
      employee_id INT NOT NULL,
      attendance_date DATE NOT NULL,
      -- present / late / absent / leave
      status VARCHAR(20) NOT NULL,
      in_time VARCHAR(5) NULL,
      out_time VARCHAR(5) NULL,
      remarks VARCHAR(255) NULL,
      confirmed TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_site_entry (employee_id, attendance_date),
      INDEX idx_site_entry_date (attendance_date),
      FOREIGN KEY (sheet_id) REFERENCES site_attendance_sheets(id) ON DELETE CASCADE,
      FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS site_attendance_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      require_approval TINYINT(1) NOT NULL DEFAULT 0,
      require_photo TINYINT(1) NOT NULL DEFAULT 0,
      require_location TINYINT(1) NOT NULL DEFAULT 0,
      backdate_days INT NOT NULL DEFAULT 2,
      reminder_time VARCHAR(5) NOT NULL DEFAULT '11:00',
      updated_by INT NULL,
      updated_at TIMESTAMP NULL DEFAULT NULL
    )`
  ];
  for (const sql of tables) {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      console.warn("⚠️ Could not ensure Site Attendance table: " + err.message);
    }
  }
}

export const SITE_STATUSES = ["present", "late", "absent", "leave"] as const;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const ymd = (v: any): string | null => {
  if (!v) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  const s = String(v).slice(0, 10);
  return DATE_RE.test(s) ? s : null;
};
const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const numOrNull = (v: any) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));

// Confirmed (counting) site entries in [from, to], optionally for one Employee
// — the shared reader for Employee 360 / Employee Reports / Payroll.
export async function loadSiteEntries(queryDB: QueryDB, from: string, to: string, employeeId?: number): Promise<any[]> {
  const rows: any[] =
    (employeeId
      ? await queryDB("SELECT * FROM site_attendance_entries WHERE employee_id = ?", [employeeId]).catch(() => [])
      : await queryDB("SELECT * FROM site_attendance_entries WHERE attendance_date BETWEEN ? AND ?", [from, to]).catch(() =>
          queryDB("SELECT * FROM site_attendance_entries").catch(() => [])
        )) || [];
  return rows.filter((r: any) => {
    const d = ymd(r.attendance_date);
    return Number(r.confirmed) === 1 && d && d >= from && d <= to && (!employeeId || Number(r.employee_id) === employeeId);
  });
}

async function loadSettings(queryDB: QueryDB) {
  const rows: any[] = (await queryDB("SELECT * FROM site_attendance_settings").catch(() => [])) || [];
  const r = rows.sort((a, b) => Number(a.id) - Number(b.id))[0];
  return {
    id: r ? Number(r.id) : null,
    require_approval: !!Number(r?.require_approval ?? 0),
    require_photo: !!Number(r?.require_photo ?? 0),
    require_location: !!Number(r?.require_location ?? 0),
    backdate_days: Math.max(0, Math.min(31, Number(r?.backdate_days ?? 2))),
    reminder_time: TIME_RE.test(String(r?.reminder_time || "")) ? String(r.reminder_time) : "11:00"
  };
}

export function registerSiteAttendanceRoutes(app: Express, deps: SiteAttendanceRouteDeps) {
  const { authenticateToken, requireModule, queryDB, getAdminModules, todayInDhaka, haversineMeters, createAlert } = deps;
  const gate = [authenticateToken, requireModule("office_attendance")];
  const fail = (res: any, err: any, status = 500) => res.status(err?.statusCode || status).json({ error: err?.message || String(err) });
  const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

  async function isHR(user: any) {
    if (user?.role === "superadmin") return true;
    if (user?.role !== "admin" && user?.role !== "user") return false;
    return (await getAdminModules(Number(user.id)).catch(() => [])).includes("office_attendance");
  }
  const notify = (userId: number, title: string, message: string, id?: number) =>
    createAlert(queryDB, { userId, type: "site_attendance", title, message, relatedType: "site_attendance_sheet", relatedId: id }).catch(() => {});

  const all = async (table: string) => ((await queryDB(`SELECT * FROM ${table}`).catch(() => [])) || []) as any[];
  const one = async (table: string, id: number) => {
    const rows: any[] = (await queryDB(`SELECT * FROM ${table} WHERE id = ?`, [id]).catch(() => [])) || [];
    return rows.find((r) => Number(r.id) === id) || null;
  };

  // Everything the team screens need in one go.
  async function world() {
    const [teams, members, employees, users, projects] = await Promise.all([
      all("site_attendance_teams"),
      all("site_attendance_members"),
      all("all_employees"),
      all("users"),
      all("projects")
    ]);
    return {
      teams,
      members,
      empById: new Map<number, any>(employees.map((e) => [Number(e.id), e])),
      userById: new Map<number, any>(users.map((u) => [Number(u.id), u])),
      projectById: new Map<number, any>(projects.map((p) => [Number(p.id), p])),
      employees,
      users,
      projects
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const empLite = (e: any) => ({
    employee_id: Number(e.id),
    employee_code: e.employee_id || null,
    name: e.name,
    designation: e.designation || null,
    department: e.department || null,
    has_login: e.user_id != null
  });

  function teamView(t: any, w: World) {
    const project = t.project_id ? w.projectById.get(Number(t.project_id)) : null;
    const members = w.members
      .filter((m) => Number(m.team_id) === Number(t.id))
      .map((m) => w.empById.get(Number(m.employee_id)))
      .filter((e) => e && Number(e.is_active ?? 1) !== 0)
      .map(empLite)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const site = siteCircle(t, project);
    return {
      id: Number(t.id),
      name: t.name,
      project_id: t.project_id ? Number(t.project_id) : null,
      project_name: project?.project_name || null,
      site_location: t.site_location || project?.location_label || null,
      supervisor_user_id: Number(t.supervisor_user_id),
      supervisor_name: w.userById.get(Number(t.supervisor_user_id))?.name || null,
      backup_user_id: t.backup_user_id ? Number(t.backup_user_id) : null,
      backup_name: t.backup_user_id ? w.userById.get(Number(t.backup_user_id))?.name || null : null,
      lat: numOrNull(t.lat),
      lng: numOrNull(t.lng),
      radius_m: numOrNull(t.radius_m),
      has_site_circle: !!site,
      is_active: Number(t.is_active ?? 1) === 1,
      members
    };
  }

  // The team's own circle, else its Project's (Remote Attendance's circle).
  function siteCircle(t: any, project: any): { lat: number; lng: number; radius: number } | null {
    const lat = numOrNull(t.lat);
    const lng = numOrNull(t.lng);
    if (lat !== null && lng !== null) return { lat, lng, radius: numOrNull(t.radius_m) || 300 };
    if (project && numOrNull(project.location_lat) !== null && numOrNull(project.location_lng) !== null)
      return { lat: Number(project.location_lat), lng: Number(project.location_lng), radius: numOrNull(project.location_radius) || 300 };
    return null;
  }

  const canMark = (t: any, userId: number) => Number(t.supervisor_user_id) === userId || (t.backup_user_id && Number(t.backup_user_id) === userId);

  async function sheetFor(teamId: number, date: string) {
    const rows: any[] = (await queryDB("SELECT * FROM site_attendance_sheets WHERE team_id = ?", [teamId]).catch(() => [])) || [];
    return rows.find((s) => Number(s.team_id) === teamId && ymd(s.attendance_date) === date) || null;
  }
  async function entriesOfSheet(sheetId: number) {
    const rows: any[] = (await queryDB("SELECT * FROM site_attendance_entries WHERE sheet_id = ?", [sheetId]).catch(() => [])) || [];
    return rows.filter((r) => Number(r.sheet_id) === sheetId);
  }
  async function entriesOnDate(date: string) {
    const rows: any[] = (await queryDB("SELECT * FROM site_attendance_entries WHERE attendance_date = ?", [date]).catch(() => [])) || [];
    return rows.filter((r) => ymd(r.attendance_date) === date);
  }

  const sheetLite = (s: any, w: World) =>
    s
      ? {
          id: Number(s.id),
          team_id: Number(s.team_id),
          date: ymd(s.attendance_date),
          status: s.status,
          submitted_by: s.submitted_by ? Number(s.submitted_by) : null,
          submitted_by_name: s.submitted_by ? w.userById.get(Number(s.submitted_by))?.name || null : null,
          submitted_at: s.submitted_at || null,
          lat: numOrNull(s.lat),
          lng: numOrNull(s.lng),
          accuracy_m: numOrNull(s.accuracy_m),
          distance_m: numOrNull(s.distance_m),
          outside_site: !!Number(s.outside_site || 0),
          has_photo: !!s.photo_mime,
          note: s.note || null,
          reviewed_by_name: s.reviewed_by ? w.userById.get(Number(s.reviewed_by))?.name || null : null,
          reviewed_at: s.reviewed_at || null,
          review_note: s.review_note || null
        }
      : null;

  const countsOf = (entries: any[], memberCount: number) => {
    const c = { present: 0, late: 0, absent: 0, leave: 0, unmarked: 0, total: memberCount };
    for (const e of entries) if ((c as any)[e.status] !== undefined) (c as any)[e.status]++;
    c.unmarked = Math.max(0, memberCount - entries.length);
    return c;
  };

  // Approved leave applications (employees who DO have a login) on a date.
  async function appLeaveOn(date: string) {
    const rows: any[] = await all("leave_applications");
    const m = new Map<number, string>();
    for (const l of rows) {
      if (l.status !== "approved" || l.user_id == null) continue;
      const s = ymd(l.start_date);
      const e = ymd(l.end_date);
      if (s && e && s <= date && e >= date) m.set(Number(l.user_id), String(l.leave_type || "leave"));
    }
    return m;
  }

  async function holidayFor(date: string, employeeIds: number[]) {
    const [maps, groups] = await Promise.all([getHolidayMapsByGroup(queryDB, date, date), getEmployeeBranchTypeByEmployeeId(queryDB)]);
    const out = new Map<number, { title: string; type: string } | null>();
    for (const id of employeeIds) {
      const g: HolidayAppliesTo = groups.get(id) || "head_office";
      const h: any = (maps as any)[g]?.get(date);
      out.set(id, h ? { title: h.title || (h.day_type === "weekend" ? "Weekend" : "Holiday"), type: h.day_type } : null);
    }
    return out;
  }

  // ======================= supervisor =======================

  app.get("/api/site-attendance/my-teams", authenticateToken, async (req: any, res) => {
    try {
      const me = Number(req.user.id);
      const w = await world();
      const today = todayInDhaka();
      const mine = w.teams.filter((t) => Number(t.is_active ?? 1) === 1 && canMark(t, me));
      const out = [];
      for (const t of mine) {
        const v = teamView(t, w);
        const s = await sheetFor(v.id, today);
        const entries = s ? await entriesOfSheet(Number(s.id)) : [];
        out.push({ ...v, today: { sheet: sheetLite(s, w), counts: countsOf(entries, v.members.length) } });
      }
      res.json({ today, teams: out, settings: await loadSettings(queryDB), is_hr: await isHR(req.user) });
    } catch (err) {
      fail(res, err);
    }
  });

  // One team's sheet for a date (supervisor or HR).
  app.get("/api/site-attendance/sheet", authenticateToken, async (req: any, res) => {
    try {
      const teamId = Number(req.query.team_id);
      const today = todayInDhaka();
      const date = DATE_RE.test(String(req.query.date || "")) ? String(req.query.date) : today;
      const w = await world();
      const t = w.teams.find((x) => Number(x.id) === teamId);
      if (!t) throw bad("Team not found.", 404);
      const hr = await isHR(req.user);
      if (!hr && !canMark(t, Number(req.user.id))) throw bad("You are not the supervisor of this team.", 403);
      const settings = await loadSettings(queryDB);
      const view = teamView(t, w);
      const s = await sheetFor(teamId, date);
      const entries = s ? await entriesOfSheet(Number(s.id)) : [];
      const byEmp = new Map<number, any>(entries.map((e) => [Number(e.employee_id), e]));
      // Members, plus anyone already on this sheet who has since moved team.
      const people = [...view.members];
      for (const e of entries) {
        if (!people.some((p) => p.employee_id === Number(e.employee_id))) {
          const emp = w.empById.get(Number(e.employee_id));
          if (emp) people.push(empLite(emp));
        }
      }
      const otherTeam = new Map<number, string>();
      for (const e of await entriesOnDate(date)) {
        if (s && Number(e.sheet_id) === Number(s.id)) continue;
        const ot = w.teams.find((x) => Number(x.id) === Number(e.team_id));
        otherTeam.set(Number(e.employee_id), ot?.name || "another team");
      }
      const leaves = await appLeaveOn(date);
      const holidays = await holidayFor(date, people.map((p) => p.employee_id));
      const lock = lockReason(s, date, today, settings, hr);
      res.json({
        team: view,
        date,
        today,
        settings,
        is_hr: hr,
        editable: !lock,
        locked_reason: lock,
        min_date: hr ? null : addDays(today, -settings.backdate_days),
        sheet: sheetLite(s, w),
        counts: countsOf(entries, people.length),
        rows: people.map((p) => {
          const e = byEmp.get(p.employee_id);
          const emp = w.empById.get(p.employee_id);
          return {
            ...p,
            status: e?.status || null,
            in_time: e?.in_time || null,
            out_time: e?.out_time || null,
            remarks: e?.remarks || null,
            app_leave: emp?.user_id != null ? leaves.get(Number(emp.user_id)) || null : null,
            holiday: holidays.get(p.employee_id) || null,
            marked_by_other_team: otherTeam.get(p.employee_id) || null
          };
        })
      });
    } catch (err) {
      fail(res, err);
    }
  });

  function lockReason(s: any, date: string, today: string, settings: Awaited<ReturnType<typeof loadSettings>>, hr: boolean): string | null {
    if (date > today) return "You can't mark attendance for a future date.";
    if (hr) return null;
    if (date < addDays(today, -settings.backdate_days))
      return `Only the last ${settings.backdate_days} day(s) can be marked here. Ask HR to correct older dates.`;
    if (s && s.status === "approved" && settings.require_approval) return "HR has already approved this sheet. Ask HR if something needs changing.";
    return null;
  }

  // Save / submit a sheet (supervisor within the window, HR any past date).
  app.post("/api/site-attendance/sheet", authenticateToken, async (req: any, res) => {
    try {
      const me = Number(req.user.id);
      const b = req.body || {};
      const teamId = Number(b.team_id);
      const date = String(b.date || "");
      if (!DATE_RE.test(date)) throw bad("Pick a valid date.");
      const today = todayInDhaka();
      const w = await world();
      const t = w.teams.find((x) => Number(x.id) === teamId);
      if (!t) throw bad("Team not found.", 404);
      const hr = await isHR(req.user);
      if (!hr && !canMark(t, me)) throw bad("You are not the supervisor of this team.", 403);
      if (!hr && Number(t.is_active ?? 1) !== 1) throw bad("This team is no longer active.");
      const settings = await loadSettings(queryDB);
      const existing = await sheetFor(teamId, date);
      const lock = lockReason(existing, date, today, settings, hr);
      if (lock) throw bad(lock, 409);

      const view = teamView(t, w);
      const allowed = new Set<number>(view.members.map((m) => m.employee_id));
      const oldEntries = existing ? await entriesOfSheet(Number(existing.id)) : [];
      for (const e of oldEntries) allowed.add(Number(e.employee_id));

      const raw: any[] = Array.isArray(b.entries) ? b.entries : [];
      const clean = new Map<number, { status: string; in_time: string | null; out_time: string | null; remarks: string | null }>();
      for (const r of raw) {
        const id = Number(r?.employee_id);
        if (!allowed.has(id)) continue;
        const status = String(r?.status || "");
        if (!status) continue;
        if (!(SITE_STATUSES as readonly string[]).includes(status)) throw bad(`Unknown status "${status}".`);
        const inT = r?.in_time ? String(r.in_time).slice(0, 5) : null;
        const outT = r?.out_time ? String(r.out_time).slice(0, 5) : null;
        const who = w.empById.get(id)?.name || "a member";
        if (inT && !TIME_RE.test(inT)) throw bad(`Arrival time for ${who} must look like 09:30.`);
        if (outT && !TIME_RE.test(outT)) throw bad(`Leaving time for ${who} must look like 18:00.`);
        if (status === "late" && !inT) throw bad(`Enter the arrival time for ${who} (marked Late).`);
        if (inT && outT && outT <= inT) throw bad(`Leaving time for ${who} must be after the arrival time.`);
        const worked = status === "present" || status === "late";
        clean.set(id, {
          status,
          in_time: worked ? inT : null,
          out_time: worked ? outT : null,
          remarks: r?.remarks ? String(r.remarks).trim().slice(0, 255) || null : null
        });
      }
      if (!clean.size) throw bad("Mark at least one person before submitting.");

      // Photo (optional, or required by settings for supervisors).
      let photo: { mime: string; data: Buffer } | null = null;
      if (b.photo?.data) {
        const mime = String(b.photo.mime || "image/jpeg");
        if (!/^image\//.test(mime)) throw bad("The photo must be an image.");
        const data = Buffer.from(String(b.photo.data).replace(/^data:[^,]*,/, ""), "base64");
        if (data.length > MAX_PHOTO_BYTES) throw bad("The photo is larger than 5 MB.");
        photo = { mime, data };
      }
      if (!hr && settings.require_photo && !photo && !existing?.photo_mime) throw bad("Take a team photo before submitting.");

      // Location, checked against the site circle.
      const lat = numOrNull(b.lat);
      const lng = numOrNull(b.lng);
      if (!hr && settings.require_location && (lat === null || lng === null))
        throw bad("Turn on location for this app and try again — HR needs the site location with each sheet.");
      const circle = siteCircle(t, t.project_id ? w.projectById.get(Number(t.project_id)) : null);
      let distance: number | null = null;
      let outside = 0;
      if (lat !== null && lng !== null && circle) {
        distance = Math.round(haversineMeters(lat, lng, circle.lat, circle.lng));
        outside = distance > circle.radius ? 1 : 0;
      }

      // Nobody may be on two teams' sheets for the same day.
      const conflicts: string[] = [];
      for (const e of await entriesOnDate(date)) {
        if (existing && Number(e.sheet_id) === Number(existing.id)) continue;
        if (clean.has(Number(e.employee_id))) {
          const ot = w.teams.find((x) => Number(x.id) === Number(e.team_id));
          conflicts.push(`${w.empById.get(Number(e.employee_id))?.name || "Someone"} (already marked by ${ot?.name || "another team"})`);
          clean.delete(Number(e.employee_id));
        }
      }
      if (!clean.size) throw bad(`Everyone here was already marked by another team: ${conflicts.join(", ")}.`, 409);

      const status = settings.require_approval && !hr ? "submitted" : "approved";
      const confirmed = status === "approved" ? 1 : 0;
      let sheetId: number;
      if (existing) {
        sheetId = Number(existing.id);
        await queryDB(
          `UPDATE site_attendance_sheets SET status = ?, submitted_by = ?, submitted_at = ?, lat = ?, lng = ?, accuracy_m = ?, distance_m = ?, outside_site = ?,
             note = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?`,
          [
            status,
            me,
            new Date(),
            lat ?? numOrNull(existing.lat),
            lng ?? numOrNull(existing.lng),
            lat !== null ? numOrNull(b.accuracy) : numOrNull(existing.accuracy_m),
            lat !== null ? distance : numOrNull(existing.distance_m),
            lat !== null ? outside : Number(existing.outside_site || 0),
            b.note ? String(b.note).trim().slice(0, 500) : existing.note || null,
            status === "approved" && hr ? me : null,
            status === "approved" ? new Date() : null,
            null,
            sheetId
          ]
        );
        if (photo) await queryDB("UPDATE site_attendance_sheets SET photo_mime = ?, photo_data = ? WHERE id = ?", [photo.mime, photo.data, sheetId]);
      } else {
        const r: any = await queryDB(
          `INSERT INTO site_attendance_sheets (team_id, attendance_date, status, submitted_by, submitted_at, lat, lng, accuracy_m, distance_m, outside_site,
             photo_mime, photo_data, note, reviewed_by, reviewed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            teamId,
            date,
            status,
            me,
            new Date(),
            lat,
            lng,
            numOrNull(b.accuracy),
            distance,
            outside,
            photo?.mime || null,
            photo?.data || null,
            b.note ? String(b.note).trim().slice(0, 500) : null,
            status === "approved" && hr ? me : null,
            status === "approved" ? new Date() : null
          ]
        );
        sheetId = Number(r.insertId);
      }

      const oldByEmp = new Map<number, any>(oldEntries.map((e) => [Number(e.employee_id), e]));
      for (const [empId, v] of clean) {
        const old = oldByEmp.get(empId);
        if (old) {
          await queryDB("UPDATE site_attendance_entries SET status = ?, in_time = ?, out_time = ?, remarks = ?, confirmed = ? WHERE id = ?", [
            v.status,
            v.in_time,
            v.out_time,
            v.remarks,
            confirmed,
            Number(old.id)
          ]);
        } else {
          await queryDB(
            "INSERT INTO site_attendance_entries (sheet_id, team_id, employee_id, attendance_date, status, in_time, out_time, remarks, confirmed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [sheetId, teamId, empId, date, v.status, v.in_time, v.out_time, v.remarks, confirmed]
          );
        }
      }
      for (const [empId, old] of oldByEmp) if (!clean.has(empId)) await queryDB("DELETE FROM site_attendance_entries WHERE id = ?", [Number(old.id)]);

      res.json({ success: true, sheet_id: sheetId, status, conflicts, outside_site: !!outside, distance_m: distance });
    } catch (err) {
      fail(res, err);
    }
  });

  // Supervisor's month at a glance (one line per day).
  app.get("/api/site-attendance/history", authenticateToken, async (req: any, res) => {
    try {
      const teamId = Number(req.query.team_id);
      const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : todayInDhaka().slice(0, 7);
      const w = await world();
      const t = w.teams.find((x) => Number(x.id) === teamId);
      if (!t) throw bad("Team not found.", 404);
      if (!(await isHR(req.user)) && !canMark(t, Number(req.user.id))) throw bad("You are not the supervisor of this team.", 403);
      const sheets: any[] = ((await queryDB("SELECT * FROM site_attendance_sheets WHERE team_id = ?", [teamId]).catch(() => [])) || []).filter(
        (s: any) => Number(s.team_id) === teamId && String(ymd(s.attendance_date)).startsWith(month)
      );
      const out = [];
      for (const s of sheets.sort((a, b) => String(ymd(b.attendance_date)).localeCompare(String(ymd(a.attendance_date))))) {
        const entries = await entriesOfSheet(Number(s.id));
        out.push({ ...sheetLite(s, w), counts: countsOf(entries, entries.length) });
      }
      res.json({ month, sheets: out });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/site-attendance/sheets/:id/photo", authenticateToken, async (req: any, res) => {
    try {
      const s = await one("site_attendance_sheets", Number(req.params.id));
      if (!s || !s.photo_mime) throw bad("No photo.", 404);
      const t = await one("site_attendance_teams", Number(s.team_id));
      if (!(await isHR(req.user)) && !(t && canMark(t, Number(req.user.id)))) throw bad("Not allowed.", 403);
      const data = Buffer.isBuffer(s.photo_data) ? s.photo_data : Buffer.from(s.photo_data || "");
      res.setHeader("Content-Type", s.photo_mime);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.send(data);
    } catch (err) {
      fail(res, err);
    }
  });

  // ======================= HR =======================

  app.get("/api/site-attendance/settings", ...gate, async (_req: any, res) => {
    try {
      res.json(await loadSettings(queryDB));
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/site-attendance/settings", ...gate, async (req: any, res) => {
    try {
      const b = req.body || {};
      const cur = await loadSettings(queryDB);
      const next = {
        require_approval: b.require_approval === undefined ? cur.require_approval : !!b.require_approval,
        require_photo: b.require_photo === undefined ? cur.require_photo : !!b.require_photo,
        require_location: b.require_location === undefined ? cur.require_location : !!b.require_location,
        backdate_days: b.backdate_days === undefined ? cur.backdate_days : Math.max(0, Math.min(31, Math.round(Number(b.backdate_days) || 0))),
        reminder_time: b.reminder_time === undefined ? cur.reminder_time : String(b.reminder_time).slice(0, 5)
      };
      if (!TIME_RE.test(next.reminder_time)) throw bad("Reminder time must look like 11:00.");
      const vals = [next.require_approval ? 1 : 0, next.require_photo ? 1 : 0, next.require_location ? 1 : 0, next.backdate_days, next.reminder_time, Number(req.user.id)];
      if (cur.id)
        await queryDB(
          "UPDATE site_attendance_settings SET require_approval = ?, require_photo = ?, require_location = ?, backdate_days = ?, reminder_time = ?, updated_by = ?, updated_at = ? WHERE id = ?",
          [...vals, new Date(), cur.id]
        );
      else
        await queryDB(
          "INSERT INTO site_attendance_settings (require_approval, require_photo, require_location, backdate_days, reminder_time, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [...vals, new Date()]
        );
      res.json(await loadSettings(queryDB));
    } catch (err) {
      fail(res, err);
    }
  });

  // Teams + pickers (people, supervisors, projects).
  app.get("/api/site-attendance/teams", ...gate, async (_req: any, res) => {
    try {
      const w = await world();
      const teamOf = new Map<number, number>(w.members.map((m) => [Number(m.employee_id), Number(m.team_id)]));
      const teamName = new Map<number, string>(w.teams.map((t) => [Number(t.id), t.name]));
      res.json({
        teams: w.teams.map((t) => teamView(t, w)).sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.name.localeCompare(b.name)),
        employees: w.employees
          .filter((e) => Number(e.is_active ?? 1) !== 0)
          .map((e) => ({ ...empLite(e), team_id: teamOf.get(Number(e.id)) || null, team_name: teamName.get(teamOf.get(Number(e.id)) || 0) || null }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name))),
        users: w.users.map((u) => ({ id: Number(u.id), name: u.name, email: u.email || u.username || null })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
        projects: w.projects.map((p) => ({ id: Number(p.id), name: p.project_name, has_location: numOrNull(p.location_lat) !== null })).sort((a, b) => String(a.name).localeCompare(String(b.name)))
      });
    } catch (err) {
      fail(res, err);
    }
  });

  function cleanTeam(b: any, w: World) {
    const name = String(b?.name || "").trim().slice(0, 150);
    if (!name) throw bad("Give the team a name.");
    const sup = Number(b?.supervisor_user_id);
    if (!sup || !w.userById.has(sup)) throw bad("Pick the supervisor (an account that can log in).");
    const backup = b?.backup_user_id ? Number(b.backup_user_id) : null;
    if (backup && !w.userById.has(backup)) throw bad("The backup supervisor account was not found.");
    const project = b?.project_id ? Number(b.project_id) : null;
    if (project && !w.projectById.has(project)) throw bad("Project not found.");
    const lat = numOrNull(b?.lat);
    const lng = numOrNull(b?.lng);
    if ((lat === null) !== (lng === null)) throw bad("Enter both latitude and longitude, or neither.");
    return {
      name,
      project_id: project,
      site_location: b?.site_location ? String(b.site_location).trim().slice(0, 255) : null,
      supervisor_user_id: sup,
      backup_user_id: backup && backup !== sup ? backup : null,
      lat,
      lng,
      radius_m: numOrNull(b?.radius_m) !== null ? Math.max(20, Math.round(Number(b.radius_m))) : null,
      is_active: b?.is_active === undefined ? 1 : b.is_active ? 1 : 0
    };
  }

  async function setMembers(teamId: number, ids: number[], w: World) {
    const want = new Set(ids.filter((id) => w.empById.has(id)));
    for (const m of w.members) {
      const emp = Number(m.employee_id);
      if (Number(m.team_id) === teamId && !want.has(emp)) await queryDB("DELETE FROM site_attendance_members WHERE id = ?", [Number(m.id)]);
      // Joining this team moves them out of any other.
      if (Number(m.team_id) !== teamId && want.has(emp)) await queryDB("DELETE FROM site_attendance_members WHERE id = ?", [Number(m.id)]);
    }
    const already = new Set(w.members.filter((m) => Number(m.team_id) === teamId).map((m) => Number(m.employee_id)));
    for (const id of want) if (!already.has(id)) await queryDB("INSERT INTO site_attendance_members (team_id, employee_id) VALUES (?, ?)", [teamId, id]);
  }

  app.post("/api/site-attendance/teams", ...gate, async (req: any, res) => {
    try {
      const w = await world();
      const t = cleanTeam(req.body, w);
      const r: any = await queryDB(
        "INSERT INTO site_attendance_teams (name, project_id, site_location, supervisor_user_id, backup_user_id, lat, lng, radius_m, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [t.name, t.project_id, t.site_location, t.supervisor_user_id, t.backup_user_id, t.lat, t.lng, t.radius_m, t.is_active, Number(req.user.id)]
      );
      const id = Number(r.insertId);
      if (Array.isArray(req.body?.employee_ids)) await setMembers(id, req.body.employee_ids.map(Number), w);
      await notify(t.supervisor_user_id, "You supervise a team's attendance", `You now mark daily attendance for "${t.name}". Open Self Service → Team Attendance.`);
      res.json({ success: true, id });
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/site-attendance/teams/:id", ...gate, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const w = await world();
      const cur = w.teams.find((x) => Number(x.id) === id);
      if (!cur) throw bad("Team not found.", 404);
      const t = cleanTeam(req.body, w);
      await queryDB(
        "UPDATE site_attendance_teams SET name = ?, project_id = ?, site_location = ?, supervisor_user_id = ?, backup_user_id = ?, lat = ?, lng = ?, radius_m = ?, is_active = ? WHERE id = ?",
        [t.name, t.project_id, t.site_location, t.supervisor_user_id, t.backup_user_id, t.lat, t.lng, t.radius_m, t.is_active, id]
      );
      if (Array.isArray(req.body?.employee_ids)) await setMembers(id, req.body.employee_ids.map(Number), w);
      if (Number(cur.supervisor_user_id) !== t.supervisor_user_id)
        await notify(t.supervisor_user_id, "You supervise a team's attendance", `You now mark daily attendance for "${t.name}". Open Self Service → Team Attendance.`);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Deleting a team with history only deactivates it — its sheets are
  // attendance records.
  app.delete("/api/site-attendance/teams/:id", ...gate, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const sheets: any[] = ((await queryDB("SELECT * FROM site_attendance_sheets WHERE team_id = ?", [id]).catch(() => [])) || []).filter(
        (s: any) => Number(s.team_id) === id
      );
      if (sheets.length) {
        await queryDB("UPDATE site_attendance_teams SET is_active = 0 WHERE id = ?", [id]);
        const members: any[] = (await all("site_attendance_members")).filter((m) => Number(m.team_id) === id);
        for (const m of members) await queryDB("DELETE FROM site_attendance_members WHERE id = ?", [Number(m.id)]);
        return res.json({ success: true, deactivated: true });
      }
      const members: any[] = (await all("site_attendance_members")).filter((m) => Number(m.team_id) === id);
      for (const m of members) await queryDB("DELETE FROM site_attendance_members WHERE id = ?", [Number(m.id)]);
      await queryDB("DELETE FROM site_attendance_teams WHERE id = ?", [id]);
      res.json({ success: true, deleted: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Day overview: every active team — submitted or not, and the counts.
  app.get("/api/site-attendance/overview", ...gate, async (req: any, res) => {
    try {
      const date = DATE_RE.test(String(req.query.date || "")) ? String(req.query.date) : todayInDhaka();
      const w = await world();
      const settings = await loadSettings(queryDB);
      const sheets: any[] = (await all("site_attendance_sheets")).filter((s) => ymd(s.attendance_date) === date);
      const entries = await entriesOnDate(date);
      const teams = w.teams
        .filter((t) => Number(t.is_active ?? 1) === 1 || sheets.some((s) => Number(s.team_id) === Number(t.id)))
        .map((t) => {
          const v = teamView(t, w);
          const s = sheets.find((x) => Number(x.team_id) === v.id) || null;
          const es = s ? entries.filter((e) => Number(e.sheet_id) === Number(s.id)) : [];
          return { ...v, members: undefined, member_count: v.members.length, sheet: sheetLite(s, w), counts: countsOf(es, Math.max(v.members.length, es.length)) };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const total = { teams: teams.length, submitted: teams.filter((t) => t.sheet).length, present: 0, late: 0, absent: 0, leave: 0, unmarked: 0, people: 0 };
      for (const t of teams) {
        total.present += t.counts.present;
        total.late += t.counts.late;
        total.absent += t.counts.absent;
        total.leave += t.counts.leave;
        total.unmarked += t.counts.unmarked;
        total.people += t.counts.total;
      }
      const pending = (await all("site_attendance_sheets")).filter((s) => s.status === "submitted").length;
      res.json({ date, settings, teams, total, pending_review: pending });
    } catch (err) {
      fail(res, err);
    }
  });

  // Sheets waiting for review (or any status), newest first.
  app.get("/api/site-attendance/sheets", ...gate, async (req: any, res) => {
    try {
      const status = String(req.query.status || "submitted");
      const w = await world();
      const sheets = (await all("site_attendance_sheets"))
        .filter((s) => status === "all" || s.status === status)
        .sort((a, b) => String(ymd(b.attendance_date)).localeCompare(String(ymd(a.attendance_date))) || Number(b.id) - Number(a.id))
        .slice(0, 300);
      const entries = await all("site_attendance_entries");
      const out = sheets.map((s) => {
        const es = entries.filter((e) => Number(e.sheet_id) === Number(s.id));
        const t = w.teams.find((x) => Number(x.id) === Number(s.team_id));
        return { ...sheetLite(s, w), team_name: t?.name || "—", counts: countsOf(es, es.length) };
      });
      res.json({ sheets: out });
    } catch (err) {
      fail(res, err);
    }
  });

  async function review(sheetId: number, decision: string, note: string | null, reviewer: number) {
    const s = await one("site_attendance_sheets", sheetId);
    if (!s) throw bad("Sheet not found.", 404);
    if (decision !== "approve" && decision !== "reject") throw bad("Decision must be approve or reject.");
    if (decision === "reject" && !note) throw bad("Say what needs fixing, so the supervisor can correct it.");
    const status = decision === "approve" ? "approved" : "rejected";
    await queryDB("UPDATE site_attendance_sheets SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?", [status, reviewer, new Date(), note, sheetId]);
    for (const e of await entriesOfSheet(sheetId))
      await queryDB("UPDATE site_attendance_entries SET confirmed = ? WHERE id = ?", [status === "approved" ? 1 : 0, Number(e.id)]);
    const t = await one("site_attendance_teams", Number(s.team_id));
    const date = ymd(s.attendance_date);
    if (s.submitted_by && Number(s.submitted_by) !== reviewer) {
      if (status === "rejected")
        await notify(
          Number(s.submitted_by),
          "Attendance sent back",
          `${t?.name || "Team"} — ${date}: ${note}. Correct it in Self Service → Team Attendance and submit again.`,
          sheetId
        );
      else await notify(Number(s.submitted_by), "Attendance approved", `${t?.name || "Team"} — ${date} was approved by HR.`, sheetId);
    }
  }

  app.post("/api/site-attendance/sheets/:id/review", ...gate, async (req: any, res) => {
    try {
      const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) || null : null;
      await review(Number(req.params.id), String(req.body?.decision || ""), note, Number(req.user.id));
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/site-attendance/sheets/review-bulk", ...gate, async (req: any, res) => {
    try {
      const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
      if (!ids.length) throw bad("Pick at least one sheet.");
      for (const id of ids) await review(id, "approve", null, Number(req.user.id));
      res.json({ success: true, approved: ids.length });
    } catch (err) {
      fail(res, err);
    }
  });

  // Monthly muster register: one row per person, one cell per day.
  app.get("/api/site-attendance/register", ...gate, async (req: any, res) => {
    try {
      const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : todayInDhaka().slice(0, 7);
      const teamId = req.query.team_id ? Number(req.query.team_id) : null;
      const [y, m] = month.split("-").map(Number);
      const days = new Date(y, m, 0).getDate();
      const from = `${month}-01`;
      const to = `${month}-${String(days).padStart(2, "0")}`;
      const w = await world();
      const entries = (await all("site_attendance_entries")).filter((e) => {
        const d = ymd(e.attendance_date);
        return d && d >= from && d <= to && (!teamId || Number(e.team_id) === teamId);
      });
      const ids = new Set<number>(entries.map((e) => Number(e.employee_id)));
      for (const mem of w.members) if (!teamId || Number(mem.team_id) === teamId) ids.add(Number(mem.employee_id));
      const [maps, groups] = await Promise.all([getHolidayMapsByGroup(queryDB, from, to), getEmployeeBranchTypeByEmployeeId(queryDB)]);
      const teamOf = new Map<number, number>(w.members.map((mm) => [Number(mm.employee_id), Number(mm.team_id)]));
      const today = todayInDhaka();
      const rows = [...ids]
        .map((id) => w.empById.get(id))
        .filter(Boolean)
        .map((e: any) => {
          const id = Number(e.id);
          const hol = (maps as any)[groups.get(id) || "head_office"] as Map<string, any>;
          const mine = entries.filter((x) => Number(x.employee_id) === id);
          const cells: Record<string, { code: string; confirmed: boolean; in: string | null; out: string | null }> = {};
          const tot = { present: 0, late: 0, absent: 0, leave: 0, not_marked: 0, holiday: 0 };
          for (let d = 1; d <= days; d++) {
            const ds = `${month}-${String(d).padStart(2, "0")}`;
            const x = mine.find((q) => ymd(q.attendance_date) === ds);
            if (x) {
              const code = x.status === "present" ? "P" : x.status === "late" ? "L" : x.status === "absent" ? "A" : "LV";
              cells[ds] = { code, confirmed: Number(x.confirmed) === 1, in: x.in_time || null, out: x.out_time || null };
              (tot as any)[x.status]++;
            } else if (hol?.get(ds)) {
              cells[ds] = { code: hol.get(ds).day_type === "weekend" ? "W" : "H", confirmed: true, in: null, out: null };
              tot.holiday++;
            } else if (ds <= today) tot.not_marked++;
          }
          const tid = teamOf.get(id) || Number(mine[0]?.team_id) || null;
          return { ...empLite(e), team_name: tid ? w.teams.find((t) => Number(t.id) === tid)?.name || null : null, cells, totals: tot };
        })
        .sort((a: any, b: any) => String(a.team_name || "").localeCompare(String(b.team_name || "")) || String(a.name).localeCompare(String(b.name)));
      res.json({ month, days, rows });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---------------- reminders ----------------
  // From settings.reminder_time on a working day, a supervisor whose team has
  // no sheet for today gets one alert (per team per day).
  const remind = async () => {
    try {
      const today = todayInDhaka();
      const settings = await loadSettings(queryDB);
      const now = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Dhaka", hour12: false }).slice(0, 5);
      if (now < settings.reminder_time) return;
      const w = await world();
      const sheets = (await all("site_attendance_sheets")).filter((s) => ymd(s.attendance_date) === today);
      for (const t of w.teams) {
        if (Number(t.is_active ?? 1) !== 1 || ymd(t.reminded_on) === today) continue;
        if (sheets.some((s) => Number(s.team_id) === Number(t.id))) continue;
        const v = teamView(t, w);
        if (!v.members.length) continue;
        const hol = await holidayFor(today, v.members.map((mm) => mm.employee_id));
        if (v.members.every((mm) => hol.get(mm.employee_id))) continue;
        await notify(Number(t.supervisor_user_id), "Today's attendance not submitted", `Please mark today's attendance for "${t.name}" in Self Service → Team Attendance.`);
        await queryDB("UPDATE site_attendance_teams SET reminded_on = ? WHERE id = ?", [today, Number(t.id)]);
      }
    } catch (err: any) {
      console.warn("⚠️ Site attendance reminders: " + err.message);
    }
  };
  setTimeout(remind, 2 * 60 * 1000);
  setInterval(remind, 30 * 60 * 1000);
}
