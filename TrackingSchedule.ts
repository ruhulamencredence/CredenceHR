/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employee Tracking -> Schedule: WHEN each person is tracked.
//
//   tracking_schedules — one row per login (no row = "always", as before):
//     mode 'always' | 'fixed' | 'roster'
//     fixed:  days (0 = Sunday … 6 = Saturday, "0,1,2,3,4,6") + start / end
//             time; an end before the start runs past midnight;
//     roster: the person's Duty Roster shift that day (RosterRoutes.ts,
//             duty_roster + duty_shifts); off day / no shift = not tracked.
//   tracking_schedule_settings — the minutes added before and after every
//     window (default 30: the trip to and from work).
//
// Outside the window the phone stops tracking and its notification goes
// away (src/lib/backgroundTracking.ts, DutyTrackingService.java), and
// /api/tracking/ping stores nothing — an older app that still sends is
// answered "off schedule" with the next start, so nothing from the person's
// own time is kept. Times are Bangladesh time (UTC+6, no daylight saving).
//
// Who may set it: Employee Tracking module + its "Tracking Schedule" layer
// (explicit-only), and only for people inside their tracking scope
// (TrackingScope.ts). A Superadmin always may.

import type { Express } from "express";
import { getTrackingScope } from "./TrackingScope";

type Query = (sql: string, params?: any[]) => Promise<any>;

const TZ_MS = 6 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;
const DEFAULT_BUFFER = 30;

export type ScheduleMode = "always" | "fixed" | "roster";

export interface ScheduleRow {
  user_id: number;
  mode: ScheduleMode;
  days: number[];
  start_time: string | null; // HH:MM
  end_time: string | null;
}

export interface TrackingWindow {
  mode: ScheduleMode;
  on: boolean;
  // ISO times (UTC); null = no end / nothing within the next week.
  until: string | null;
  next_start: string | null;
}

export async function ensureTrackingScheduleSchema(dbPool: any): Promise<void> {
  const run = (sql: string) =>
    dbPool.query(sql).catch((err: any) => console.warn("⚠️ Tracking schedule: " + err.message));
  await run(
    `CREATE TABLE IF NOT EXISTS tracking_schedules (
      user_id INT NOT NULL PRIMARY KEY,
      mode VARCHAR(10) NOT NULL DEFAULT 'always',
      days VARCHAR(20) NULL,
      start_time TIME NULL,
      end_time TIME NULL,
      updated_by INT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  );
  await run(
    `CREATE TABLE IF NOT EXISTS tracking_schedule_settings (
      id INT NOT NULL PRIMARY KEY,
      buffer_minutes INT NOT NULL DEFAULT ${DEFAULT_BUFFER},
      updated_by INT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`
  );
}

const hm = (v: any): string | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v ?? ""));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}` : null;
};
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toRow = (r: any): ScheduleRow => ({
  user_id: Number(r.user_id),
  mode: r.mode === "fixed" || r.mode === "roster" ? r.mode : "always",
  days: String(r.days || "")
    .split(",")
    .filter((x) => x.trim() !== "")
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
  start_time: hm(r.start_time),
  end_time: hm(r.end_time)
});

export async function getBufferMinutes(queryDB: Query): Promise<number> {
  const r: any = ((await queryDB("SELECT buffer_minutes FROM tracking_schedule_settings WHERE id = 1").catch(() => [])) as any[])[0];
  const n = r ? Number(r.buffer_minutes) : DEFAULT_BUFFER;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BUFFER;
}

// Bangladesh wall clock as "local ms" (UTC ms + 6 h), and back.
const localNow = (nowUtc: number) => nowUtc + TZ_MS;
const ymdOfLocal = (localMs: number) => new Date(localMs).toISOString().slice(0, 10);
const dayStartLocal = (localMs: number) => Math.floor(localMs / DAY) * DAY;
const isoOfLocal = (localMs: number) => new Date(localMs - TZ_MS).toISOString();

type Shift = { date: string; start: string; end: string };

// Windows (local ms) for days [today-1 … today+7], buffer added, merged.
function windowsFor(row: ScheduleRow, shifts: Shift[], nowLocal: number, buffer: number): [number, number][] {
  const out: [number, number][] = [];
  const b = buffer * 60000;
  const add = (dayStart: number, start: string, end: string) => {
    const s = dayStart + minutesOf(start) * 60000;
    let e = dayStart + minutesOf(end) * 60000;
    if (e <= s) e += DAY; // past midnight
    out.push([s - b, e + b]);
  };
  const today = dayStartLocal(nowLocal);
  if (row.mode === "fixed" && row.start_time && row.end_time) {
    for (let i = -1; i <= 7; i++) {
      const d = today + i * DAY;
      if (row.days.includes(new Date(d).getUTCDay())) add(d, row.start_time, row.end_time);
    }
  } else if (row.mode === "roster") {
    for (const s of shifts) add(Date.parse(`${s.date}T00:00:00Z`), s.start, s.end);
  }
  out.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const w of out) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else merged.push([w[0], w[1]]);
  }
  return merged;
}

function windowFrom(row: ScheduleRow | null, shifts: Shift[], nowUtc: number, buffer: number): TrackingWindow {
  if (!row || row.mode === "always") return { mode: "always", on: true, until: null, next_start: null };
  const now = localNow(nowUtc);
  const ws = windowsFor(row, shifts, now, buffer);
  const cur = ws.find((w) => w[0] <= now && now < w[1]);
  if (cur) return { mode: row.mode, on: true, until: isoOfLocal(cur[1]), next_start: null };
  const next = ws.find((w) => w[0] > now);
  return { mode: row.mode, on: false, until: null, next_start: next ? isoOfLocal(next[0]) : null };
}

// Shifts of these employees (all_employees.id) for [today-1 … today+7].
async function loadShifts(queryDB: Query, employeePks: number[], nowUtc: number): Promise<Map<number, Shift[]>> {
  const map = new Map<number, Shift[]>();
  if (!employeePks.length) return map;
  const today = dayStartLocal(localNow(nowUtc));
  const from = ymdOfLocal(today - DAY);
  const to = ymdOfLocal(today + 7 * DAY);
  const rows: any[] =
    ((await queryDB(
      `SELECT r.employee_id, DATE_FORMAT(r.roster_date, '%Y-%m-%d') AS d, s.start_time, s.end_time
         FROM duty_roster r JOIN duty_shifts s ON s.id = r.shift_id
        WHERE r.is_off = 0 AND r.roster_date BETWEEN ? AND ? AND r.employee_id IN (${employeePks.map(() => "?").join(",")})`,
      [from, to, ...employeePks]
    ).catch(() => [])) as any[]) || [];
  for (const r of rows) {
    const start = hm(r.start_time);
    const end = hm(r.end_time);
    if (!start || !end) continue;
    const k = Number(r.employee_id);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push({ date: String(r.d), start, end });
  }
  return map;
}

// One person's window right now (the phone asks; every ping is checked).
export async function trackingWindowFor(queryDB: Query, userId: number, nowUtc = Date.now()): Promise<TrackingWindow> {
  const r: any = ((await queryDB("SELECT * FROM tracking_schedules WHERE user_id = ?", [userId]).catch(() => [])) as any[])[0];
  const row = r ? toRow(r) : null;
  if (!row || row.mode === "always") return { mode: "always", on: true, until: null, next_start: null };
  let shifts: Shift[] = [];
  if (row.mode === "roster") {
    const e: any = ((await queryDB("SELECT id FROM all_employees WHERE user_id = ? ORDER BY is_active DESC, id LIMIT 1", [userId]).catch(() => [])) as any[])[0];
    if (e) shifts = (await loadShifts(queryDB, [Number(e.id)], nowUtc)).get(Number(e.id)) || [];
  }
  return windowFrom(row, shifts, nowUtc, await getBufferMinutes(queryDB));
}

// Many people at once (status board, schedule list): userId -> window.
export async function trackingWindowsFor(queryDB: Query, people: { user_id: number; employee_pk: number | null }[], nowUtc = Date.now()): Promise<Map<number, TrackingWindow>> {
  const out = new Map<number, TrackingWindow>();
  if (!people.length) return out;
  const rows: any[] = ((await queryDB("SELECT * FROM tracking_schedules").catch(() => [])) as any[]) || [];
  const byUser = new Map<number, ScheduleRow>(rows.map((r) => [Number(r.user_id), toRow(r)]));
  const rosterPks = people.filter((p) => p.employee_pk && byUser.get(p.user_id)?.mode === "roster").map((p) => Number(p.employee_pk));
  const shifts = await loadShifts(queryDB, rosterPks, nowUtc);
  const buffer = await getBufferMinutes(queryDB);
  for (const p of people) {
    out.set(p.user_id, windowFrom(byUser.get(p.user_id) || null, p.employee_pk ? shifts.get(Number(p.employee_pk)) || [] : [], nowUtc, buffer));
  }
  return out;
}

interface Deps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (key: any) => any;
  requireModuleLayer: (key: any, layer: string) => any;
  queryDB: Query;
}

export function registerTrackingScheduleRoutes(app: Express, deps: Deps) {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, queryDB } = deps;
  const gate = [authenticateToken, requireAdmin, requireModule("tracking"), requireModuleLayer("tracking", "tracking_schedule")];

  // The phone: am I tracked now, until when / from when.
  app.get("/api/tracking/schedule/me", authenticateToken, async (req: any, res) => {
    try {
      res.json(await trackingWindowFor(queryDB, Number(req.user.id)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Everyone with a login this account may track, with their schedule and
  // whether they are tracked right now.
  app.get("/api/tracking/schedules", ...gate, async (req: any, res) => {
    try {
      const scope = await getTrackingScope(queryDB, req.user);
      const emps: any[] =
        ((await queryDB(
          `SELECT e.id, e.employee_id, e.name, e.designation, e.department, e.branch, e.user_id, u.can_use_tracking
             FROM all_employees e JOIN users u ON u.id = e.user_id
            WHERE e.is_active = 1 AND u.role <> 'superadmin'
            ORDER BY e.name`
        )) as any[]) || [];
      const list = scope ? emps.filter((e) => scope.employeePks.has(Number(e.id))) : emps;
      const rows: any[] = ((await queryDB("SELECT * FROM tracking_schedules").catch(() => [])) as any[]) || [];
      const byUser = new Map<number, ScheduleRow>(rows.map((r) => [Number(r.user_id), toRow(r)]));
      const windows = await trackingWindowsFor(
        queryDB,
        list.map((e) => ({ user_id: Number(e.user_id), employee_pk: Number(e.id) }))
      );
      res.json({
        buffer_minutes: await getBufferMinutes(queryDB),
        people: list.map((e) => {
          const s = byUser.get(Number(e.user_id));
          return {
            user_id: Number(e.user_id),
            employee_pk: Number(e.id),
            employee_id: e.employee_id || "",
            name: e.name,
            designation: e.designation || "",
            department: e.department || "",
            branch: e.branch || "",
            tracking_enabled: !!Number(e.can_use_tracking),
            mode: s?.mode || "always",
            days: s?.days || [],
            start_time: s?.start_time || null,
            end_time: s?.end_time || null,
            now: windows.get(Number(e.user_id)) || null
          };
        })
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Set one schedule for many people: { user_ids, mode, days?, start_time?, end_time? }.
  app.put("/api/tracking/schedules", ...gate, async (req: any, res) => {
    try {
      const b = req.body || {};
      const mode: ScheduleMode = b.mode === "fixed" || b.mode === "roster" ? b.mode : b.mode === "always" ? "always" : (null as any);
      if (!mode) return res.status(400).json({ error: "Pick Always, Fixed hours or Duty Roster." });
      const ids: number[] = Array.isArray(b.user_ids) ? [...new Set<number>(b.user_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0))] : [];
      if (!ids.length) return res.status(400).json({ error: "Pick at least one person." });
      if (ids.length > 2000) return res.status(400).json({ error: "Too many people at once." });
      let days: number[] = [];
      let start: string | null = null;
      let end: string | null = null;
      if (mode === "fixed") {
        days = Array.isArray(b.days) ? [...new Set<number>(b.days.map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 6))].sort() : [];
        start = hm(b.start_time);
        end = hm(b.end_time);
        if (!days.length) return res.status(400).json({ error: "Pick at least one day." });
        if (!start || !end) return res.status(400).json({ error: "Give a start and an end time." });
        if (start === end) return res.status(400).json({ error: "Start and end can't be the same." });
      }
      // Only people this account may track.
      const scope = await getTrackingScope(queryDB, req.user);
      const users: any[] = (await queryDB(`SELECT u.id, u.role, e.id AS employee_pk FROM users u LEFT JOIN all_employees e ON e.user_id = u.id WHERE u.id IN (${ids.map(() => "?").join(",")})`, ids)) || [];
      let changed = 0;
      const skipped: number[] = [];
      const seen = new Set<number>();
      for (const u of users) {
        const uid = Number(u.id);
        if (seen.has(uid)) continue;
        seen.add(uid);
        if (u.role === "superadmin" || (scope && !scope.userIds.has(uid))) {
          skipped.push(uid);
          continue;
        }
        if (mode === "always") await queryDB("DELETE FROM tracking_schedules WHERE user_id = ?", [uid]);
        else
          await queryDB(
            `INSERT INTO tracking_schedules (user_id, mode, days, start_time, end_time, updated_by) VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE mode = VALUES(mode), days = VALUES(days), start_time = VALUES(start_time), end_time = VALUES(end_time), updated_by = VALUES(updated_by)`,
            [uid, mode, mode === "fixed" ? days.join(",") : null, start, end, Number(req.user.id)]
          );
        changed++;
      }
      res.json({ changed, skipped: skipped.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Minutes before / after every window (0–180).
  app.put("/api/tracking/schedule-settings", ...gate, async (req: any, res) => {
    try {
      const n = Number(req.body?.buffer_minutes);
      if (!Number.isInteger(n) || n < 0 || n > 180) return res.status(400).json({ error: "Minutes must be 0 to 180." });
      await queryDB(
        "INSERT INTO tracking_schedule_settings (id, buffer_minutes, updated_by) VALUES (1, ?, ?) ON DUPLICATE KEY UPDATE buffer_minutes = VALUES(buffer_minutes), updated_by = VALUES(updated_by)",
        [n, Number(req.user.id)]
      );
      res.json({ buffer_minutes: n });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
