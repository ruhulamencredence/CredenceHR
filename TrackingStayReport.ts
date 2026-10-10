/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employee Tracking -> Stay Report (GET /api/tracking/stay-report): from one
// employee's location pings, how long they stayed at each place, day by day,
// inside a time window (e.g. 09:00–18:00), plus a summary per place.
//
// How a day is worked out (all times are the pings' own wall-clock times, the
// same ones the app shows):
//   1. Pings inside that day's window, oldest first; very inaccurate ones
//      (accuracy worse than MAX_ACCURACY_M) are left out.
//   2. Consecutive pings within `radius` metres of the running centre of the
//      current group stay in it; a ping farther away starts a new group.
//   3. A group lasting at least `min_stay` minutes is a stay (first ping ->
//      last ping); a shorter one counts as moving.
//   4. Time between two groups is moving when the gap is at most `max_gap`
//      minutes, otherwise "no signal" (phone off, tracking off, no network).
//      Before the first ping and after the last one in the window is "not
//      seen".
//   5. Stays of every day are matched to places: a stay within `radius` of a
//      place already found is that place; otherwise it is a new place.
//
// Gated by the tracking module's "Stay Report" permission layer
// (requireModuleLayer("tracking", "stay_report") in server.ts).

import type { Express } from "express";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_ACCURACY_M = 300;
const MAX_DAYS = 62;

// "YYYY-MM-DD HH:MM:SS" (dateStrings) -> minutes since 1970 on a naive
// wall-clock scale, so a ping's clock time is read as the app shows it.
export function wallMinutes(v: any): number | null {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), v.getHours(), v.getMinutes(), v.getSeconds()) / 60000;
  }
  const m = String(v ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 60000;
}
const dayStart = (day: string) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / 60000;
const hmToMin = (hm: string) => +hm.slice(0, 2) * 60 + +hm.slice(3, 5);
const clock = (min: number) => {
  const d = new Date(min * 60000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const addDays = (day: string, n: number) => new Date((dayStart(day) + n * 1440) * 60000).toISOString().slice(0, 10);

function metres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

interface Ping {
  t: number;
  lat: number;
  lng: number;
}
interface Group {
  pings: Ping[];
  lat: number;
  lng: number;
}

export interface StayOptions {
  from: string;
  to: string;
  fromTime: string;
  toTime: string;
  radius: number;
  minStay: number;
  maxGap: number;
}

export function buildStayReport(rawPings: any[], o: StayOptions) {
  const pings: Ping[] = rawPings
    .filter((r) => r.accuracy_m == null || Number(r.accuracy_m) <= MAX_ACCURACY_M)
    .map((r) => ({ t: wallMinutes(r.recorded_at)!, lat: Number(r.lat), lng: Number(r.lng) }))
    .filter((p) => p.t != null && Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .sort((a, b) => a.t - b.t);

  const overnight = o.fromTime > o.toTime;
  const places: { id: number; lat: number; lng: number; weight: number; total_min: number; days: Set<string>; visits: number }[] = [];
  const placeFor = (lat: number, lng: number, minutes: number, day: string) => {
    let best: (typeof places)[number] | null = null;
    let bestD = Infinity;
    for (const p of places) {
      const d = metres(lat, lng, p.lat, p.lng);
      if (d <= o.radius && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    if (!best) {
      best = { id: places.length + 1, lat, lng, weight: 0, total_min: 0, days: new Set(), visits: 0 };
      places.push(best);
    }
    // Keep the place's centre on the time-weighted average of its stays.
    const w = Math.max(1, minutes);
    best.lat = (best.lat * best.weight + lat * w) / (best.weight + w);
    best.lng = (best.lng * best.weight + lng * w) / (best.weight + w);
    best.weight += w;
    best.total_min += minutes;
    best.days.add(day);
    best.visits += 1;
    return best.id;
  };

  const days: any[] = [];
  for (let day = o.from; day <= o.to; day = addDays(day, 1)) {
    const winStart = dayStart(day) + hmToMin(o.fromTime);
    const winEnd = dayStart(day) + hmToMin(o.toTime) + (overnight ? 1440 : 0);
    const inWin = pings.filter((p) => p.t >= winStart && p.t <= winEnd);
    const windowMin = winEnd - winStart;
    if (!inWin.length) {
      days.push({ date: day, window_min: windowMin, pings: 0, first_seen: null, last_seen: null, stays: [], stay_min: 0, moving_min: 0, no_signal_min: 0, not_seen_min: windowMin });
      continue;
    }

    // 2. group consecutive nearby pings
    const groups: Group[] = [];
    for (const p of inWin) {
      const g = groups[groups.length - 1];
      if (g && metres(p.lat, p.lng, g.lat, g.lng) <= o.radius) {
        g.pings.push(p);
        const n = g.pings.length;
        g.lat = (g.lat * (n - 1) + p.lat) / n;
        g.lng = (g.lng * (n - 1) + p.lng) / n;
      } else {
        groups.push({ pings: [p], lat: p.lat, lng: p.lng });
      }
    }

    // 3. stays vs. short stops; 4. the time between them
    let stayMin = 0;
    let movingMin = 0;
    let noSignalMin = 0;
    const stays: any[] = [];
    groups.forEach((g, i) => {
      const start = g.pings[0].t;
      const end = g.pings[g.pings.length - 1].t;
      const len = end - start;
      if (len >= o.minStay) {
        stays.push({ group: g, from: start, to: end, minutes: Math.round(len) });
        stayMin += len;
      } else {
        movingMin += len;
      }
      const next = groups[i + 1];
      if (next) {
        const gap = next.pings[0].t - end;
        if (gap <= o.maxGap) movingMin += gap;
        else noSignalMin += gap;
      }
    });
    const first = inWin[0].t;
    const last = inWin[inWin.length - 1].t;

    days.push({
      date: day,
      window_min: windowMin,
      pings: inWin.length,
      first_seen: clock(first),
      last_seen: clock(last),
      stays: stays.map((s) => ({
        place_id: placeFor(s.group.lat, s.group.lng, s.minutes, day),
        lat: s.group.lat,
        lng: s.group.lng,
        from: clock(s.from),
        to: clock(s.to),
        minutes: s.minutes,
        pings: s.group.pings.length
      })),
      stay_min: Math.round(stayMin),
      moving_min: Math.round(movingMin),
      no_signal_min: Math.round(noSignalMin),
      not_seen_min: Math.round(first - winStart + (winEnd - last))
    });
  }

  const placeList = places
    .map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, total_min: Math.round(p.total_min), days: p.days.size, visits: p.visits }))
    .sort((a, b) => b.total_min - a.total_min);
  const sum = (k: string) => days.reduce((a, d) => a + Number(d[k] || 0), 0);
  return {
    settings: { from: o.from, to: o.to, from_time: o.fromTime, to_time: o.toTime, radius_m: o.radius, min_stay_min: o.minStay, max_gap_min: o.maxGap },
    places: placeList,
    days,
    totals: {
      days: days.length,
      days_seen: days.filter((d) => d.pings > 0).length,
      pings: sum("pings"),
      window_min: sum("window_min"),
      stay_min: sum("stay_min"),
      moving_min: sum("moving_min"),
      no_signal_min: sum("no_signal_min"),
      not_seen_min: sum("not_seen_min")
    }
  };
}

export function registerTrackingStayReportRoutes(app: Express, deps: { authenticateToken: any; requireAdmin: any; requireModule: (k: any) => any; requireModuleLayer: (k: any, l: any) => any; queryDB: QueryDB }) {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, queryDB } = deps;
  const num = (v: any, def: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };

  app.get("/api/tracking/stay-report", authenticateToken, requireAdmin, requireModule("tracking"), requireModuleLayer("tracking", "stay_report"), async (req: any, res: any) => {
    try {
      const userId = Number(req.query.user_id);
      if (!userId) return res.status(400).json({ error: "Pick an employee." });
      const from = String(req.query.from || "");
      const to = String(req.query.to || from);
      if (!DATE_RE.test(from) || !DATE_RE.test(to)) return res.status(400).json({ error: "Pick the dates." });
      if (from > to) return res.status(400).json({ error: "The start date is after the end date." });
      if ((dayStart(to) - dayStart(from)) / 1440 + 1 > MAX_DAYS) return res.status(400).json({ error: `Pick at most ${MAX_DAYS} days.` });
      const fromTime = TIME_RE.test(String(req.query.from_time || "")) ? String(req.query.from_time) : "09:00";
      const toTime = TIME_RE.test(String(req.query.to_time || "")) ? String(req.query.to_time) : "18:00";
      if (fromTime === toTime) return res.status(400).json({ error: "The time range is empty." });
      const opts: StayOptions = {
        from,
        to,
        fromTime,
        toTime,
        radius: num(req.query.radius, 150, 30, 1000),
        minStay: num(req.query.min_stay, 10, 1, 240),
        maxGap: num(req.query.max_gap, 30, 5, 240)
      };
      const users: any[] = (await queryDB("SELECT id, name FROM users WHERE id = ?", [userId])) || [];
      if (!users.length) return res.status(404).json({ error: "Employee not found." });
      const rows: any[] =
        (await queryDB(
          "SELECT lat, lng, accuracy_m, recorded_at FROM location_pings WHERE user_id = ? AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at ASC",
          [userId, `${from} 00:00:00`, `${addDays(to, 2)} 00:00:00`]
        )) || [];
      res.json({ user: { id: Number(users[0].id), name: users[0].name }, ...buildStayReport(rows, opts) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
