/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employee Tracking routes (phone pings and heartbeat, live board, status, notices, history),
// moved out of server.ts unchanged. The shared helpers they use are passed in by startServer().

import { wallMinutes } from "./TrackingStayReport";
import type { Express } from "express";

export interface RegisterEmployeeTrackingRoutesDeps {
  announceNotice: any;
  authenticateToken: any;
  getAdminModules: any;
  liveTracking: any;
  queryDB: any;
  requireAdmin: any;
  requireModule: any;
  requireModuleLayer: any;
  requireTrackingAccess: any;
}

export function registerEmployeeTrackingRoutes(app: Express, deps: RegisterEmployeeTrackingRoutesDeps) {
  const { announceNotice, authenticateToken, getAdminModules, liveTracking, queryDB, requireAdmin, requireModule, requireModuleLayer, requireTrackingAccess } = deps;
  // Remembers what the phone said about itself; a ping (a real fix) proves
  // Location is on, so it also clears an earlier "off" report.
  const saveTrackingState = async (userId: number, st: any, fromPing = false) => {
    const flag = (v: any) => (v === null || v === undefined ? null : v ? 1 : 0);
    const battery = st?.battery_pct != null && Number.isFinite(Number(st.battery_pct)) ? Math.round(Number(st.battery_pct)) : null;
    const mode = typeof st?.mode === "string" ? String(st.mode).slice(0, 10) : null;
    try {
      await queryDB(
        `INSERT INTO tracking_device_state (user_id, location_on, foreground_granted, background_granted, precise_granted, mode, battery_pct, reported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE location_on = VALUES(location_on),
           foreground_granted = COALESCE(VALUES(foreground_granted), foreground_granted),
           background_granted = COALESCE(VALUES(background_granted), background_granted),
           precise_granted = COALESCE(VALUES(precise_granted), precise_granted),
           mode = COALESCE(VALUES(mode), mode), battery_pct = COALESCE(VALUES(battery_pct), battery_pct), reported_at = NOW()`,
        [userId, fromPing ? 1 : flag(st?.location_on), flag(st?.foreground), flag(st?.background), flag(st?.precise), mode, battery]
      );
    } catch {
      // Table missing / in-memory mode — the plain ping history still works.
    }
  };

  app.post("/api/tracking/ping", authenticateToken, requireTrackingAccess, async (req: any, res) => {
    try {
      const lat = Number(req.body.lat);
      const lng = Number(req.body.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ error: "lat/lng are required." });
      }
      const accuracy_m = req.body.accuracy_m != null && Number.isFinite(Number(req.body.accuracy_m)) ? Math.round(Number(req.body.accuracy_m)) : null;
      const battery_pct = req.body.battery_pct != null && Number.isFinite(Number(req.body.battery_pct)) ? Math.round(Number(req.body.battery_pct)) : null;
      const recorded_at = req.body.recorded_at ? new Date(req.body.recorded_at) : new Date();
      // A phone standing still re-sends its last fix as a heartbeat: nothing new
      // to store (that only added duplicate rows), but it still answers
      // "should I go live?".
      if (!req.body.repeat) {
        // Fixes collected since the last send, oldest first (the batch ends
        // with the lat/lng above, which is skipped here so it isn't stored twice).
        const extra: any[] = Array.isArray(req.body.points) ? req.body.points.slice(-300) : [];
        for (const pt of extra) {
          const plat = Number(pt?.lat);
          const plng = Number(pt?.lng);
          const pat = pt?.recorded_at ? new Date(pt.recorded_at) : null;
          if (!Number.isFinite(plat) || !Number.isFinite(plng) || !pat || Number.isNaN(pat.getTime())) continue;
          if (pat.getTime() >= recorded_at.getTime()) continue;
          await queryDB("INSERT INTO location_pings (user_id, lat, lng, accuracy_m, battery_pct, recorded_at) VALUES (?, ?, ?, ?, ?, ?)", [
            req.user.id,
            plat,
            plng,
            pt?.accuracy_m != null && Number.isFinite(Number(pt.accuracy_m)) ? Math.round(Number(pt.accuracy_m)) : null,
            battery_pct,
            pat
          ]);
        }
        await queryDB(
          "INSERT INTO location_pings (user_id, lat, lng, accuracy_m, battery_pct, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
          [req.user.id, lat, lng, accuracy_m, battery_pct, recorded_at]
        );
      }
      await saveTrackingState(Number(req.user.id), { battery_pct, mode: req.body.mode, foreground: true }, true);
      const live_until = await liveTracking.onPing(Number(req.user.id), { lat, lng, accuracy_m, battery_pct, recorded_at });
      res.json({ success: true, live_until });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Heartbeat from the APK, sent every couple of minutes and whenever the app
  // comes back to the front — works even with no GPS fix (e.g. Location off).
  app.post("/api/tracking/state", authenticateToken, requireTrackingAccess, async (req: any, res) => {
    try {
      await saveTrackingState(Number(req.user.id), req.body || {});
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Live board (Admin Panel -> Employee Tracking): the SINGLE most recent ping
  // per user, plus how long ago it was — this is the "where is everyone right
  // now" map, not a history. Only users with at least one ping ever show up.
  app.get("/api/tracking/live", authenticateToken, requireAdmin, requireModule("tracking"), requireModuleLayer("tracking", "read"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM location_pings", []);
      const users = await queryDB("SELECT id, name, email, role FROM users", []);
      const userMap = new Map<number, any>(users.map((u: any) => [u.id, u]));
      const latestByUser = new Map<number, any>();
      for (const r of rows) {
        const existing = latestByUser.get(r.user_id);
        if (!existing || new Date(r.recorded_at).getTime() > new Date(existing.recorded_at).getTime()) {
          latestByUser.set(r.user_id, r);
        }
      }
      const result = Array.from(latestByUser.values())
        .map((r: any) => ({
          ...r,
          user_name: userMap.get(r.user_id)?.name || null,
          user_email: userMap.get(r.user_id)?.email || null
        }))
        .sort((a: any, b: any) => (a.recorded_at < b.recorded_at ? 1 : -1));
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Employee Tracking -> "Currently Under Tracking" / "Currently Not Tracked"
  // (and the same pair on the Admin Dashboard's quick card): every active
  // employee of the company, split by whether their phone has sent a location
  // in the last TRACKING_LIVE_MIN minutes (same 20 min the Live map uses
  // before a dot turns grey). Anyone not tracked gets the reason.
  const TRACKING_LIVE_MIN = 20;
  const TRACKING_STATE_MIN = 8;
  const trackingStatusRows = async () => {
    const employees: any[] = (await queryDB(
      `SELECT e.id, e.employee_id, e.name, e.designation, e.department, e.user_id, u.can_use_tracking
         FROM all_employees e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.is_active = 1`,
      []
    )) || [];
    const pings: any[] = (await queryDB(
      `SELECT user_id, MAX(recorded_at) AS last_ping, TIMESTAMPDIFF(MINUTE, MAX(recorded_at), NOW()) AS minutes_ago
         FROM location_pings GROUP BY user_id`,
      []
    )) || [];
    const byUser = new Map<number, any>(pings.map((p) => [Number(p.user_id), p]));
    const states: any[] =
      (await queryDB(
        `SELECT user_id, location_on, foreground_granted, background_granted, mode, TIMESTAMPDIFF(MINUTE, reported_at, NOW()) AS state_minutes_ago FROM tracking_device_state`,
        []
      ).catch(() => [])) || [];
    const stateByUser = new Map<number, any>(states.map((x) => [Number(x.user_id), x]));
    return employees.map((e) => {
      const p = e.user_id ? byUser.get(Number(e.user_id)) : null;
      const minutesAgo = p && p.minutes_ago != null ? Number(p.minutes_ago) : null;
      const enabled = !!e.user_id && !!Number(e.can_use_tracking);
      // The phone's own heartbeat (every ~2 min while the app runs); older than
      // TRACKING_STATE_MIN means the app isn't running or the phone is offline.
      const st = e.user_id ? stateByUser.get(Number(e.user_id)) : null;
      const stateFresh = !!st && st.state_minutes_ago != null && Number(st.state_minutes_ago) <= TRACKING_STATE_MIN;
      const locOff = stateFresh && st.location_on !== null && !Number(st.location_on);
      const noPerm = stateFresh && st.foreground_granted !== null && !Number(st.foreground_granted);
      const noAllTime = stateFresh && st.background_granted !== null && !Number(st.background_granted);
      const pingFresh = minutesAgo != null && minutesAgo <= TRACKING_LIVE_MIN;
      // Fresh heartbeat with Location on = the phone is reporting, even if it
      // hasn't moved (no new fix is sent while standing still).
      // …but a phone that has given no GPS fix for 2 hours is not really being
      // tracked (battery saver / weak signal), whatever its heartbeat says.
      const gpsOn = stateFresh && !locOff && !noPerm && st.location_on !== null && !!Number(st.location_on);
      const alive = gpsOn && minutesAgo != null && minutesAgo <= 120;
      const tracked = enabled && !locOff && !noPerm && (pingFresh || alive);
      const reason = tracked
        ? null
        : !e.user_id
        ? "No login account"
        : !enabled
        ? "Tracking not turned on"
        : locOff
        ? "Phone Location (GPS) is OFF"
        : noPerm
        ? "Location permission removed in the phone"
        : noAllTime
        ? "Location is not set to 'Allow all the time'"
        : gpsOn
        ? "Phone is on but gives no GPS fix (battery saver or weak signal)"
        : minutesAgo == null && !st
        ? "Never sent a location"
        : "App closed or phone offline";
      const standing = tracked && !pingFresh;
      return {
        employee_pk: e.id,
        employee_id: e.employee_id || "",
        name: e.name,
        designation: e.designation || "",
        department: e.department || "Unassigned",
        user_id: e.user_id || null,
        tracking_enabled: enabled,
        tracked,
        last_ping: p?.last_ping || null,
        minutes_ago: minutesAgo,
        standing_still: standing,
        reason
      };
    });
  };
  // Sending a notice from the Not Tracked list needs the Notices module too.
  const canSendTrackingNotice = async (user: any) =>
    user.role === "superadmin" || (await getAdminModules(user.id)).includes("notices");

  app.get("/api/tracking/status", authenticateToken, requireAdmin, requireModule("tracking"), requireModuleLayer("tracking", "read"), async (req: any, res) => {
    try {
      const rows = await trackingStatusRows();
      res.json({
        live_minutes: TRACKING_LIVE_MIN,
        tracked: rows.filter((r) => r.tracked).length,
        not_tracked: rows.filter((r) => !r.tracked).length,
        can_send_notice: await canSendTrackingNotice(req.user),
        employees: rows
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Employee Tracking -> Currently Not Tracked -> Send Notice. Saved as an
  // ordinary Notice for the picked accounts (Admin Panel -> Notices lists it,
  // marked "Employee Tracking", with who has seen it), plus one
  // tracking_notice_recipients row per person recording why they weren't
  // tracked right then. Only people currently not tracked who have a login.

  app.post("/api/tracking/notices", authenticateToken, requireAdmin, requireModule("tracking"), requireModule("notices"), async (req: any, res) => {
    try {
      const title = String(req.body?.title || "").trim();
      const message = String(req.body?.message || "").trim();
      if (!title) return res.status(400).json({ error: "Title is required." });
      if (!message) return res.status(400).json({ error: "Message is required." });
      const wanted = new Set<number>((Array.isArray(req.body?.user_ids) ? req.body.user_ids : []).map(Number).filter((n: number) => Number.isFinite(n) && n > 0));
      if (wanted.size === 0) return res.status(400).json({ error: "Pick at least one employee." });
      const rows = (await trackingStatusRows()).filter((r) => !r.tracked && r.user_id && wanted.has(Number(r.user_id)));
      if (rows.length === 0) return res.status(400).json({ error: "None of the picked employees is currently not tracked." });
      const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const html = message.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br/>")}</p>`).join("");
      const result = await queryDB(
        "INSERT INTO notices (title, content_html, target_type, is_active, created_by, source) VALUES (?, ?, 'specific', 1, ?, 'tracking')",
        [title.slice(0, 200), html, req.user.id]
      );
      const noticeId = result.insertId;
      for (const r of rows) {
        await queryDB("INSERT IGNORE INTO notice_targets (notice_id, user_id) VALUES (?, ?)", [noticeId, r.user_id]);
        await queryDB(
          "INSERT INTO tracking_notice_recipients (notice_id, user_id, employee_pk, reason, last_ping, sent_by) VALUES (?, ?, ?, ?, ?, ?)",
          [noticeId, r.user_id, r.employee_pk, r.reason, r.last_ping || null, req.user.id]
        );
      }
      void announceNotice(noticeId, title, rows.map((r) => Number(r.user_id)), req.user.id);
      res.status(201).json({ id: noticeId, sent_to: rows.length, skipped: wanted.size - rows.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Month-end Tracking Notice Report: everyone sent a not-tracked notice in
  // the month (YYYY-MM), how many times, when, why, and whether they opened it.
  app.get("/api/tracking/notice-report", authenticateToken, requireAdmin, requireModule("tracking"), async (req: any, res) => {
    try {
      const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : null;
      if (!month) return res.status(400).json({ error: "month=YYYY-MM is required." });
      const [y, m] = month.split("-").map(Number);
      const from = `${month}-01 00:00:00`;
      const next = m === 12 ? `${y + 1}-01-01 00:00:00` : `${y}-${String(m + 1).padStart(2, "0")}-01 00:00:00`;
      const sends: any[] = (await queryDB(
        `SELECT r.notice_id, r.user_id, r.employee_pk, r.reason, r.sent_at, n.title, s.name AS sent_by_name,
                (SELECT d.dismissed_at FROM notice_dismissals d WHERE d.notice_id = r.notice_id AND d.user_id = r.user_id LIMIT 1) AS seen_at
           FROM tracking_notice_recipients r
           JOIN notices n ON n.id = r.notice_id
           LEFT JOIN users s ON s.id = r.sent_by
          WHERE r.sent_at >= ? AND r.sent_at < ?
          ORDER BY r.sent_at`,
        [from, next]
      )) || [];
      const employees: any[] = (await queryDB("SELECT id, employee_id, name, designation, department, user_id FROM all_employees", [])) || [];
      const empByUser = new Map<number, any>(employees.filter((e) => e.user_id).map((e) => [Number(e.user_id), e]));
      const users: any[] = (await queryDB("SELECT id, name FROM users", [])) || [];
      const userName = new Map<number, string>(users.map((u) => [Number(u.id), u.name]));
      const byUser = new Map<number, any>();
      for (const s of sends) {
        const uid = Number(s.user_id);
        const e = empByUser.get(uid);
        const row = byUser.get(uid) || {
          user_id: uid,
          employee_id: e?.employee_id || "",
          name: e?.name || userName.get(uid) || "Unknown",
          designation: e?.designation || "",
          department: e?.department || "Unassigned",
          notices: 0,
          seen: 0,
          sends: [] as any[]
        };
        row.notices += 1;
        if (s.seen_at) row.seen += 1;
        row.sends.push({ notice_id: s.notice_id, title: s.title, sent_at: s.sent_at, reason: s.reason, sent_by: s.sent_by_name || null, seen_at: s.seen_at || null });
        byUser.set(uid, row);
      }
      const rows = Array.from(byUser.values()).sort((a, b) => b.notices - a.notices || a.department.localeCompare(b.department) || a.name.localeCompare(b.name));
      res.json({
        month,
        total_notices: new Set(sends.map((s) => s.notice_id)).size,
        total_sends: sends.length,
        employees: rows
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Path history for ONE user (Admin Panel -> Employee Tracking -> click a user
  // -> "View path today"), optionally bounded by from/to — lets an Admin/
  // Superadmin play back where that user actually went, not just their latest dot.
  app.get("/api/tracking/history", authenticateToken, requireAdmin, requireModule("tracking"), requireModuleLayer("tracking", "read"), async (req: any, res) => {
    try {
      const user_id = req.query.user_id ? Number(req.query.user_id) : null;
      if (!user_id) return res.status(400).json({ error: "user_id is required" });
      const rows = await queryDB("SELECT * FROM location_pings WHERE user_id = ? ORDER BY recorded_at DESC", [user_id]);
      const from = req.query.from ? String(req.query.from) : null;
      const to = req.query.to ? String(req.query.to) : null;
      // Time-of-day window (HH:MM, 24h), independent of the from/to DATE filter
      // above — e.g. from=2026-09-01&to=2026-09-30&from_time=09:00&to_time=18:00
      // narrows a report to "office hours" across that whole month, for
      // "where was this employee between X and Y" style reports. from_time >
      // to_time (e.g. 22:00 -> 06:00) is treated as an overnight window that
      // wraps past midnight rather than an always-empty one.
      const from_time = req.query.from_time ? String(req.query.from_time) : null;
      const to_time = req.query.to_time ? String(req.query.to_time) : null;
      const filtered = rows.filter((r: any) => {
        // The ping's own wall-clock date/time (as the app shows it) — not
        // toISOString(), which is UTC and moved a 09:00–18:00 window six
        // hours on a server running on Bangladesh time.
        const wm = wallMinutes(r.recorded_at);
        const iso = wm != null ? new Date(wm * 60000).toISOString() : new Date(r.recorded_at).toISOString();
        const day = iso.slice(0, 10);
        if (from && day < from) return false;
        if (to && day > to) return false;
        if (from_time || to_time) {
          const hm = iso.slice(11, 16); // "HH:MM"
          if (from_time && to_time) {
            const overnight = from_time > to_time;
            const inWindow = overnight ? (hm >= from_time || hm <= to_time) : (hm >= from_time && hm <= to_time);
            if (!inWindow) return false;
          } else if (from_time && hm < from_time) {
            return false;
          } else if (to_time && hm > to_time) {
            return false;
          }
        }
        return true;
      });
      // Was capped at 500 — fine for a quick "view path today" playback, but a
      // report spanning a wider date/time range shouldn't silently lose points.
      // At one ping every 5-10 min, 5000 rows covers roughly a month before
      // truncating.
      res.json(filtered.slice(0, 5000));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
