/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Office Attendance (ZKTeco devices, PIN linking, raw punches) routes, moved out of server.ts unchanged.
// The shared helpers they use are passed in by startServer().

import { syncAllZkDevices } from "./zkSync";
import { syncZkDevice } from "./zkSync";
import type { Express } from "express";

export interface RegisterOfficeAttendanceRoutesDeps {
  authenticateToken: any;
  dbPool: any;
  queryDB: any;
  requireAdmin: any;
  requireModule: any;
  requireModuleLayer: any;
  todayInDhaka: any;
}

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

  app.post("/api/zk-devices", authenticateToken, requireAdmin, requireModule("office_attendance"), async (req: any, res) => {
    try {
      const { name, ip_address, port, serial_number } = req.body;
      if (!name || !ip_address) return res.status(400).json({ error: "name and ip_address are required" });
      const result: any = await queryDB(
        "INSERT INTO zk_devices (name, ip_address, port, serial_number) VALUES (?, ?, ?, ?)",
        [name, ip_address, port || 4370, serial_number || null]
      );
      res.json({ id: result.insertId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Edit a device's registry row (name/IP/port/serial, and is_active — a
  // device can be paused without deleting its punch history, since deleting
  // it would CASCADE-delete every zk_attendance_logs row tied to it).
  app.put("/api/zk-devices/:id", authenticateToken, requireAdmin, requireModule("office_attendance"), async (req: any, res) => {
    try {
      const { name, ip_address, port, serial_number, is_active } = req.body;
      if (!name || !ip_address) return res.status(400).json({ error: "name and ip_address are required" });
      await queryDB(
        "UPDATE zk_devices SET name = ?, ip_address = ?, port = ?, serial_number = ?, is_active = ? WHERE id = ?",
        [name, ip_address, port || 4370, serial_number || null, is_active ? 1 : 0, req.params.id]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/zk-devices/:id", authenticateToken, requireAdmin, requireModule("office_attendance"), async (req: any, res) => {
    try {
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
        const pin = String(p.pin);
        if (linked.has(pin)) continue;
        const cur = byPin.get(pin) || { pin, punches: 0, days: 0, first_punch: p.first_punch, last_punch: p.last_punch, devices: [] as string[] };
        cur.punches += Number(p.punches);
        cur.days = Math.max(cur.days, Number(p.days));
        if (String(p.first_punch) < String(cur.first_punch)) cur.first_punch = p.first_punch;
        if (String(p.last_punch) > String(cur.last_punch)) cur.last_punch = p.last_punch;
        const dn = deviceName.get(Number(p.device_id));
        if (dn && !cur.devices.includes(dn)) cur.devices.push(dn);
        byPin.set(pin, cur);
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

      const rows = Array.from(groups.values())
        .map(({ meta, kept }) => ({
          employee_id: meta.employee_id,
          name: meta.name,
          designation: meta.designation,
          department: meta.department,
          attendance_date: meta.attendance_date,
          // Same COUNT(*) > 1 guard as before: a day with only one KEPT tap
          // so far (typically today, before the person has punched Out)
          // must report check_out_at as NULL rather than repeating the
          // Check In time.
          check_in_at: kept[0] ?? null,
          check_out_at: kept.length > 1 ? kept[kept.length - 1] : null,
          punch_count: kept.length
        }))
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
