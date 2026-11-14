/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Office Attendance (ZKTeco devices, PIN linking, raw punches) routes, moved out of server.ts unchanged.
// The shared helpers they use are passed in by startServer().

import { syncAllZkDevices } from "./zkSync";
import { syncZkDevice } from "./zkSync";
import type { Express } from "express";
import { loadRoster, lateThresholds, nightShiftCheckIn } from "./RosterRoutes";

export interface RegisterOfficeAttendanceRoutesDeps {
  authenticateToken: any;
  dbPool: any;
  queryDB: any;
  requireAdmin: any;
  requireModule: any;
  requireModuleLayer: any;
  todayInDhaka: any;
}

import { parsePlaceholderPin, placeholderPin, repointEmployeePunches } from "./zkMachines";

export function registerOfficeAttendanceRoutes(app: Express, deps: RegisterOfficeAttendanceRoutesDeps) {
  const { authenticateToken, dbPool, queryDB, requireAdmin, requireModule, requireModuleLayer, todayInDhaka } = deps;
  // 2b-2. Office Attendance (ZKTeco) — raw biometric punches pulled automatically
  // off the office terminals by zkSync.ts every 5 minutes, kept in
  // zk_attendance_logs and mapped to the company roster via
  // all_employees.zk_device_pin. Deliberately separate from the project-based
  // `attendance` (Remote Attendance) table above — no GPS/project involved here.
  app.get("/api/zk-devices", authenticateToken, requireAdmin, requireModule("office_attendance"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM zk_devices ORDER BY name", []);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // A machine's form (Office Attendance -> Machines): where it is, how it
  // connects (LAN: IP + port; Cloud push: serial number, optionally the one
  // address it may call from) and whether its PIN numbers are the office-wide
  // ones or its own (zkMachines.ts). Returns the row to store, or an error.
  async function machineFields(body: any, id: number | null): Promise<{ row: any } | { error: string }> {
    const name = String(body?.name || "").trim().slice(0, 100);
    const connection = body?.connection === "push" ? "push" : "lan";
    const pin_mode = body?.pin_mode === "own" ? "own" : "shared";
    const branch = String(body?.branch || "").trim().slice(0, 100) || null;
    const serial = String(body?.serial_number || "").trim().slice(0, 100) || null;
    const allowed_ip = connection === "push" ? String(body?.allowed_ip || "").trim().slice(0, 64) || null : null;
    if (!name) return { error: "Give the machine a name." };
    let ip = String(body?.ip_address || "").trim().slice(0, 45);
    let port = Number(body?.port) || 4370;
    if (connection === "lan") {
      if (!ip || ip.startsWith("push:")) return { error: "Enter the machine's IP address." };
      if (port < 1 || port > 65535) return { error: "Port must be 1–65535." };
    } else {
      if (!serial) return { error: "Enter the machine's serial number (Menu -> System Info) — it is how the machine is recognised over the internet." };
      const dup: any[] = await queryDB("SELECT id, name FROM zk_devices WHERE serial_number = ? AND connection = 'push'" + (id ? " AND id <> ?" : ""), id ? [serial, id] : [serial]);
      if (dup.length) return { error: `Serial ${serial} is already used by ${dup[0].name}.` };
      ip = `push:${serial}`.slice(0, 45);
      port = 4370;
    }
    return { row: { name, branch, connection, pin_mode, ip_address: ip, port, serial_number: serial, allowed_ip } };
  }

  app.post("/api/zk-devices", authenticateToken, requireAdmin, requireModule("office_attendance"), async (req: any, res) => {
    try {
      const f = await machineFields(req.body, null);
      if ("error" in f) return res.status(400).json({ error: f.error });
      const r = f.row;
      const result: any = await queryDB(
        "INSERT INTO zk_devices (name, branch, connection, pin_mode, ip_address, port, serial_number, allowed_ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [r.name, r.branch, r.connection, r.pin_mode, r.ip_address, r.port, r.serial_number, r.allowed_ip]
      );
      res.json({ id: result.insertId });
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Another machine already uses this IP address and port." });
      res.status(500).json({ error: err.message });
    }
  });

  // Edit a device's registry row (and is_active — a device can be paused
  // without deleting its punch history, since deleting it would
  // CASCADE-delete every zk_attendance_logs row tied to it). Switching a
  // machine between shared and own PINs re-points its stored punches.
  app.put("/api/zk-devices/:id", authenticateToken, requireAdmin, requireModule("office_attendance"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const cur: any[] = await queryDB("SELECT id, pin_mode FROM zk_devices WHERE id = ?", [id]);
      if (!cur.length) return res.status(404).json({ error: "Machine not found." });
      const f = await machineFields(req.body, id);
      if ("error" in f) return res.status(400).json({ error: f.error });
      const r = f.row;
      await queryDB(
        "UPDATE zk_devices SET name = ?, branch = ?, connection = ?, pin_mode = ?, ip_address = ?, port = ?, serial_number = ?, allowed_ip = ?, is_active = ? WHERE id = ?",
        [r.name, r.branch, r.connection, r.pin_mode, r.ip_address, r.port, r.serial_number, r.allowed_ip, req.body?.is_active === false || req.body?.is_active === 0 ? 0 : 1, id]
      );
      if ((cur[0].pin_mode || "shared") !== r.pin_mode) {
        if (r.pin_mode === "shared") {
          // Back to office-wide PINs: what the machine sent is the PIN again.
          await queryDB("UPDATE IGNORE zk_attendance_logs SET device_user_pin = raw_pin WHERE device_id = ? AND raw_pin IS NOT NULL", [id]);
        } else {
          // Its own numbers from now on: every punch is a placeholder until linked.
          const logs: any[] = await queryDB("SELECT DISTINCT COALESCE(raw_pin, device_user_pin) AS pin FROM zk_attendance_logs WHERE device_id = ?", [id]);
          for (const l of logs) {
            await queryDB("UPDATE IGNORE zk_attendance_logs SET device_user_pin = ?, raw_pin = ? WHERE device_id = ? AND COALESCE(raw_pin, device_user_pin) = ?", [
              placeholderPin(id, String(l.pin)),
              String(l.pin),
              id,
              String(l.pin)
            ]);
          }
          const linked: any[] = await queryDB("SELECT DISTINCT employee_id FROM zk_device_pins WHERE device_id = ?", [id]);
          for (const e of linked) await repointEmployeePunches(queryDB, Number(e.employee_id));
        }
      }
      res.json({ success: true });
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Another machine already uses this IP address and port." });
      res.status(500).json({ error: err.message });
    }
  });

  // Office Attendance -> Machines: each machine with where it is, how it
  // connects, when it was last heard from and how many punches came in today.
  app.get("/api/zk-devices/overview", authenticateToken, requireAdmin, requireModule("office_attendance"), async (req: any, res) => {
    try {
      const today = todayInDhaka();
      const [rows, counts, pins]: any[] = await Promise.all([
        queryDB("SELECT * FROM zk_devices ORDER BY name"),
        queryDB("SELECT device_id, COUNT(*) AS n FROM zk_attendance_logs WHERE punch_time >= ? AND punch_time < ? + INTERVAL 1 DAY GROUP BY device_id", [today, today]),
        queryDB("SELECT device_id, COUNT(*) AS n FROM zk_device_pins GROUP BY device_id")
      ]);
      const todayBy = new Map<number, number>(counts.map((c: any) => [Number(c.device_id), Number(c.n)]));
      const pinsBy = new Map<number, number>(pins.map((c: any) => [Number(c.device_id), Number(c.n)]));
      const now = Date.now();
      res.json(
        rows.map((d: any) => {
          const seen = d.last_seen_at || d.last_synced_at || null;
          const ago = seen ? Math.round((now - new Date(seen).getTime()) / 60000) : null;
          return {
            id: Number(d.id),
            name: d.name,
            branch: d.branch || null,
            connection: d.connection || "lan",
            pin_mode: d.pin_mode || "shared",
            ip_address: String(d.ip_address || "").startsWith("push:") ? null : d.ip_address,
            port: Number(d.port) || 4370,
            serial_number: d.serial_number || null,
            allowed_ip: d.allowed_ip || null,
            is_active: !!Number(d.is_active),
            last_seen_at: seen,
            last_sync_status: d.last_sync_status || null,
            status: !Number(d.is_active) ? "off" : ago == null ? "never" : ago <= 30 ? "online" : ago <= 180 ? "quiet" : "offline",
            minutes_ago: ago,
            today_punches: todayBy.get(Number(d.id)) || 0,
            linked_pins: pinsBy.get(Number(d.id)) || 0
          };
        })
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // An 'own PIN' machine's links: who each of its PINs is (Link Device PINs).
  app.get("/api/zk-devices/:id(\\d+)/pins", authenticateToken, requireAdmin, requireModuleLayer("office_attendance", "link_pins"), async (req: any, res) => {
    try {
      const rows: any[] = await queryDB(
        `SELECT m.pin, m.employee_id, e.name, e.employee_id AS employee_code, e.designation, e.department, e.zk_device_pin
         FROM zk_device_pins m JOIN all_employees e ON e.id = m.employee_id WHERE m.device_id = ? ORDER BY m.pin + 0, m.pin`,
        [Number(req.params.id)]
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Unlink one PIN of an 'own PIN' machine — its punches go back to unlinked.
  app.delete("/api/zk-devices/:id(\\d+)/pins/:pin", authenticateToken, requireAdmin, requireModuleLayer("office_attendance", "link_pins"), async (req: any, res) => {
    try {
      const deviceId = Number(req.params.id);
      const pin = String(req.params.pin).slice(0, 20);
      const link: any[] = await queryDB("SELECT employee_id FROM zk_device_pins WHERE device_id = ? AND pin = ?", [deviceId, pin]);
      if (!link.length) return res.status(404).json({ error: "That PIN isn't linked." });
      await queryDB("DELETE FROM zk_device_pins WHERE device_id = ? AND pin = ?", [deviceId, pin]);
      await queryDB("UPDATE IGNORE zk_attendance_logs SET device_user_pin = ? WHERE device_id = ? AND raw_pin = ?", [placeholderPin(deviceId, pin), deviceId, pin]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/zk-devices/:id", authenticateToken, requireAdmin, requireModule("office_attendance"), async (req: any, res) => {
    try {
      // Deleting a machine would take every punch pulled from it with it
      // (zk_attendance_logs ... ON DELETE CASCADE) — attendance and payroll
      // history. A machine with punches is turned off (Inactive) instead.
      const used: any[] = (await queryDB("SELECT COUNT(*) AS n FROM zk_attendance_logs WHERE device_id = ?", [req.params.id])) || [];
      const n = Number(used[0]?.n || 0);
      if (n > 0)
        return res.status(400).json({
          error: `This machine has ${n} punch${n === 1 ? "" : "es"} saved — deleting it would delete them too. Edit it and turn it off (Inactive) instead; its punches stay.`
        });
      await queryDB("DELETE FROM zk_devices WHERE id = ?", [req.params.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Manual "Sync Now" button on the Office Attendance tab — pulls every active
  // device immediately instead of waiting for the next 5-minute cron tick.
  app.post("/api/zk-devices/sync-now", authenticateToken, requireAdmin, requireModule("office_attendance"), async (req: any, res) => {
    try {
      const results = await syncAllZkDevices(dbPool);
      res.json(results);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Manual "Sync" on a single device badge — pulls just that one device
  // immediately, without waiting on (or blocking on) the others. Reuses the
  // exact same syncZkDevice() the all-device sync-now uses per device, just
  // called once instead of Promise.all'd across every active device.
  app.post("/api/zk-devices/:id/sync-now", authenticateToken, requireAdmin, requireModule("office_attendance"), async (req: any, res) => {
    try {
      const rows: any = await queryDB("SELECT * FROM zk_devices WHERE id = ?", [req.params.id]);
      const device = rows[0];
      if (!device) return res.status(404).json({ error: "Device not found" });
      if (device.connection === "push") return res.json({ device: device.name, ok: true, count: 0, note: "This machine sends its punches itself over the internet — nothing to pull." });
      const result = await syncZkDevice(dbPool, device);
      res.json({ device: device.name, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Map a roster employee to their ZKTeco device PIN (Admin Panel -> Employees).
  app.put("/api/employees/:id/zk-pin", authenticateToken, requireAdmin, requireModule("employees"), async (req: any, res) => {
    try {
      const { zk_device_pin } = req.body;
      await queryDB("UPDATE all_employees SET zk_device_pin = ? WHERE id = ?", [zk_device_pin || null, req.params.id]);
      // Punches from machines with their own PINs follow the new office-wide PIN.
      await repointEmployeePunches(queryDB, Number(req.params.id)).catch(() => {});
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Office Attendance report — one row per employee per day: first punch of the
  // day = Check In, last punch = Check Out, plus the raw punch count so an
  // Admin can spot a likely missed punch (an odd count).
  // Office Attendance -> Unlinked PINs: device PINs that have punches but no
  // Employee carries them (all_employees.zk_device_pin), so those punches
  // reach nobody's attendance — the usual reason someone who punched in still
  // reads Absent. Needs Office Attendance's "Link Device PINs" layer.
  app.get("/api/office-attendance/unlinked-pins", authenticateToken, requireAdmin, requireModuleLayer("office_attendance", "link_pins"), async (req: any, res) => {
    try {
      const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
      const since = new Date(Date.now() - days * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
      const [pins, devices, employees]: any[] = await Promise.all([
        queryDB(
          `SELECT device_user_pin AS pin, device_id, COUNT(*) AS punches, MIN(punch_time) AS first_punch, MAX(punch_time) AS last_punch,
                  COUNT(DISTINCT DATE(punch_time)) AS days
           FROM zk_attendance_logs WHERE DATE(punch_time) >= ? GROUP BY device_user_pin, device_id`,
          [since]
        ),
        queryDB("SELECT id, name FROM zk_devices"),
        queryDB("SELECT id, employee_id, name, designation, department, user_id, zk_device_pin, is_active FROM all_employees")
      ]);
      const linked = new Set<string>(employees.filter((e: any) => e.zk_device_pin).map((e: any) => String(e.zk_device_pin)));
      const deviceName = new Map<number, string>(devices.map((d: any) => [Number(d.id), d.name]));
      const byPin = new Map<string, any>();
      for (const p of pins) {
        // A machine with its own PIN numbers: "M<machine>-<pin>" = that
        // machine's PIN nobody is linked to yet — listed per machine.
        const own = parsePlaceholderPin(String(p.pin));
        const pin = own ? own.pin : String(p.pin);
        const key = own ? String(p.pin) : pin;
        if (linked.has(String(p.pin))) continue;
        const cur = byPin.get(key) || { pin, device_id: own ? own.deviceId : null, own_machine: own ? deviceName.get(own.deviceId) || `Machine #${own.deviceId}` : null, punches: 0, days: 0, first_punch: p.first_punch, last_punch: p.last_punch, devices: [] as string[] };
        cur.punches += Number(p.punches);
        cur.days = Math.max(cur.days, Number(p.days));
        if (String(p.first_punch) < String(cur.first_punch)) cur.first_punch = p.first_punch;
        if (String(p.last_punch) > String(cur.last_punch)) cur.last_punch = p.last_punch;
        const dn = deviceName.get(Number(p.device_id));
        if (dn && !cur.devices.includes(dn)) cur.devices.push(dn);
        byPin.set(key, cur);
      }
      // A likely match: an Employee with no PIN whose Employee ID is the PIN
      // (or ends with it, e.g. PIN 14 for 241221014).
      const noPin = employees.filter((e: any) => !e.zk_device_pin && Number(e.is_active ?? 1) === 1);
      const unlinked = Array.from(byPin.values())
        .map((u: any) => {
          const exact = noPin.find((e: any) => String(e.employee_id || "") === u.pin);
          const tail = exact ? null : noPin.filter((e: any) => String(e.employee_id || "").endsWith(u.pin));
          const suggestion = exact || (tail && tail.length === 1 ? tail[0] : null);
          return { ...u, suggestion: suggestion ? { id: Number(suggestion.id), name: suggestion.name, employee_code: suggestion.employee_id } : null };
        })
        .sort((a: any, b: any) => String(b.last_punch).localeCompare(String(a.last_punch)));
      res.json({
        days,
        unlinked,
        // A machine with its own PIN numbers can link anyone (their office PIN stays).
        employees: employees
          .filter((e: any) => Number(e.is_active ?? 1) === 1)
          .map((e: any) => ({ id: Number(e.id), name: e.name, employee_code: e.employee_id, designation: e.designation, department: e.department, has_login: !!e.user_id }))
          .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name))),
        employees_without_pin: noPin
          .map((e: any) => ({ id: Number(e.id), name: e.name, employee_code: e.employee_id, designation: e.designation, department: e.department, has_login: !!e.user_id }))
          .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Body: { pin, employee_id } — gives that Employee the device PIN, so its
  // punches (past and future) count as their Office Attendance.
  app.post("/api/office-attendance/link-pin", authenticateToken, requireAdmin, requireModuleLayer("office_attendance", "link_pins"), async (req: any, res) => {
    try {
      const pin = String(req.body?.pin ?? "").trim().slice(0, 20);
      const employeeId = Number(req.body?.employee_id);
      if (!pin || !employeeId) return res.status(400).json({ error: "Pick the employee for this PIN." });
      const emp: any[] = await queryDB("SELECT id, name, zk_device_pin FROM all_employees WHERE id = ?", [employeeId]);
      if (!emp.length) return res.status(404).json({ error: "Employee not found." });
      // A machine with its own PIN numbers: this PIN is who it is on that
      // machine only (zk_device_pins); the Employee's office-wide PIN stays.
      const deviceId = Number(req.body?.device_id) || 0;
      if (deviceId) {
        const dev: any[] = await queryDB("SELECT id, name, pin_mode FROM zk_devices WHERE id = ?", [deviceId]);
        if (!dev.length) return res.status(404).json({ error: "Machine not found." });
        if ((dev[0].pin_mode || "shared") === "own") {
          const taken: any[] = await queryDB(
            "SELECT m.pin, m.employee_id, e.name FROM zk_device_pins m JOIN all_employees e ON e.id = m.employee_id WHERE m.device_id = ? AND (m.pin = ? OR m.employee_id = ?)",
            [deviceId, pin, employeeId]
          );
          const pinOther = taken.find((t: any) => String(t.pin) === pin && Number(t.employee_id) !== employeeId);
          if (pinOther) return res.status(400).json({ error: `PIN ${pin} on ${dev[0].name} already belongs to ${pinOther.name}.` });
          const empOther = taken.find((t: any) => Number(t.employee_id) === employeeId && String(t.pin) !== pin);
          if (empOther) return res.status(400).json({ error: `${emp[0].name} already has PIN ${empOther.pin} on ${dev[0].name}.` });
          await queryDB("INSERT IGNORE INTO zk_device_pins (device_id, pin, employee_id, linked_by) VALUES (?, ?, ?, ?)", [deviceId, pin, employeeId, req.user.id]);
          await repointEmployeePunches(queryDB, employeeId);
          return res.json({ success: true, own_machine: true });
        }
      }
      if (emp[0].zk_device_pin && String(emp[0].zk_device_pin) !== pin) {
        return res.status(400).json({ error: `${emp[0].name} already has PIN ${emp[0].zk_device_pin}. Change it in Employees first.` });
      }
      const taken: any[] = await queryDB("SELECT id, name FROM all_employees WHERE zk_device_pin = ?", [pin]);
      const other = taken.find((t: any) => Number(t.id) !== employeeId);
      if (other) return res.status(400).json({ error: `PIN ${pin} already belongs to ${other.name}.` });
      await queryDB("UPDATE all_employees SET zk_device_pin = ? WHERE id = ?", [pin, employeeId]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/office-attendance", authenticateToken, requireAdmin, requireModule("office_attendance"), async (req: any, res) => {
    try {
      const dateFrom = req.query.from ? String(req.query.from) : todayInDhaka();
      const dateTo = req.query.to ? String(req.query.to) : todayInDhaka();

      // Raw punches for the range, one row per punch. Aggregation now
      // happens below in JS (not in SQL) so the debounce logic is easy to
      // read and adjust.
      const rawRows = await queryDB(
        `SELECT
           e.id AS employee_id, e.name, e.designation, e.department,
           DATE(l.punch_time) AS attendance_date,
           l.punch_time
         FROM zk_attendance_logs l
         JOIN all_employees e ON e.zk_device_pin = l.device_user_pin
         WHERE DATE(l.punch_time) BETWEEN ? AND ?
         ORDER BY e.id, DATE(l.punch_time), l.punch_time`,
        [dateFrom, dateTo]
      );

      // 2 minutes covers a slow/retried scan comfortably. Raise it if a
      // particular device's sensor needs more attempts; lower it only if
      // genuinely-quick legitimate in/out pairs are getting collapsed
      // (unusual, but possible for someone stepping out very briefly).
      const DEBOUNCE_SECONDS = 120;

      const groups = new Map<string, { meta: any; kept: Date[] }>();
      for (const row of rawRows as any[]) {
        const key = `${row.employee_id}|${row.attendance_date}`;
        let g = groups.get(key);
        if (!g) {
          g = { meta: row, kept: [] };
          groups.set(key, g);
        }
        const t = new Date(row.punch_time);
        const lastKept = g.kept[g.kept.length - 1];
        if (!lastKept || (t.getTime() - lastKept.getTime()) / 1000 >= DEBOUNCE_SECONDS) {
          g.kept.push(t);
        }
        // else: within the debounce window of the previous kept punch —
        // same physical tap, skipped.
      }

      // Duty Roster: each row's shift, and Delay / Extreme Delay measured
      // from that shift's start (or the Late Attendance Policy's when no
      // shift is rostered). A night shift's Check In is its first punch near
      // the shift start, not the previous night's early-morning check-out.
      const roster = await loadRoster(queryDB, dateFrom, dateTo);
      const policies: any[] = (await queryDB("SELECT * FROM late_policy_settings").catch(() => [])) || [];
      const policyOn = (date: string) =>
        policies
          .filter((p: any) => String(p.effective_date || "").slice(0, 10) <= `${date.slice(0, 7)}-01`)
          .sort((a: any, b: any) => String(b.effective_date).localeCompare(String(a.effective_date)) || Number(b.id) - Number(a.id))[0] || null;
      const rows = Array.from(groups.values())
        .map(({ meta, kept }) => {
          const date = String(meta.attendance_date).slice(0, 10);
          const shift = roster.shiftOn(Number(meta.employee_id), date);
          const rosterDay = roster.get(Number(meta.employee_id), date);
          const checkIn = shift?.crosses_midnight ? nightShiftCheckIn(kept, shift) : kept[0] ?? null;
          let late: "delay" | "extreme" | null = null;
          if (checkIn && !rosterDay?.is_off) {
            const th = lateThresholds(policyOn(date), shift);
            const m = checkIn.getHours() * 60 + checkIn.getMinutes();
            late = m > th.extreme ? "extreme" : m > th.delay ? "delay" : null;
          }
          return {
            employee_id: meta.employee_id,
            name: meta.name,
            designation: meta.designation,
            department: meta.department,
            attendance_date: meta.attendance_date,
            // Same COUNT(*) > 1 guard as before: a day with only one KEPT tap
            // so far (typically today, before the person has punched Out)
            // must report check_out_at as NULL rather than repeating the
            // Check In time.
            check_in_at: checkIn,
            check_out_at: kept.length > 1 && kept[kept.length - 1] !== checkIn ? kept[kept.length - 1] : null,
            punch_count: kept.length,
            shift: shift ? { name: shift.name, code: shift.code, start: shift.start_time.slice(0, 5), end: shift.end_time.slice(0, 5), color: shift.color } : null,
            roster_off: !!rosterDay?.is_off,
            late
          };
        })
        .sort((a, b) => {
          const ad = new Date(a.attendance_date).getTime();
          const bd = new Date(b.attendance_date).getTime();
          if (ad !== bd) return bd - ad; // newest date first
          return String(a.name).localeCompare(String(b.name));
        });

      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
