/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Office Attendance with several ZKTeco machines (zkSync.ts pulls them).
//
// 1) Where a machine is and how it connects (zk_devices):
//    - branch: the office / site it stands in, for the Machines list;
//    - connection 'lan'  — on the same network as this server (or a VPN):
//      pulled every 15 seconds at the busy hours, as before;
//      connection 'push' — over the internet: the machine itself sends its
//      punches to this server with ZKTeco's ADMS ("Cloud server") protocol,
//      at /iclock/... below. Only a registered, switched-on push machine is
//      answered, matched by its serial number (and, when set, the address it
//      calls from). Such a machine has no IP of its own here, so ip_address
//      keeps a placeholder ("push:<serial>") for the old NOT NULL / unique key.
//    - last_seen_at: last time it answered (a pull that worked, or a push);
//      offline_alerted_at: when "machine offline" was last sent, so it goes
//      out once per outage.
// 2) PIN numbers (pin_mode):
//    - 'shared' — the office-wide PIN on the Employee record
//      (all_employees.zk_device_pin), as before;
//    - 'own'    — this machine numbers people its own way, so PIN 15 here may
//      be someone else than PIN 15 at Head Office. zk_device_pins says who
//      each of its PINs is.
//    Every report matches punches on zk_attendance_logs.device_user_pin =
//    all_employees.zk_device_pin, so an 'own' machine's punch is stored under
//    that person's office-wide PIN (raw_pin keeps what the machine sent). A PIN
//    nobody is linked to yet is stored as "M<machine>-<pin>" and moved over
//    when it is linked; someone linked who has no office-wide PIN gets that
//    "M<machine>-<pin>" as theirs.

import express from "express";
import type { Express } from "express";
import type { Pool } from "mysql2/promise";

export const placeholderPin = (deviceId: number, pin: string) => `M${deviceId}-${pin}`.slice(0, 20);
const PLACEHOLDER = /^M(\d+)-(.+)$/;
export const parsePlaceholderPin = (stored: string): { deviceId: number; pin: string } | null => {
  const m = PLACEHOLDER.exec(String(stored || ""));
  return m ? { deviceId: Number(m[1]), pin: m[2] } : null;
};

export async function ensureZkMachinesSchema(dbPool: Pool | null): Promise<void> {
  if (!dbPool) return;
  const add = async (sql: string) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      if (err.code !== "ER_DUP_FIELDNAME" && err.code !== "ER_DUP_KEYNAME") console.warn("⚠️ zk machines: " + err.message);
    }
  };
  await add("ALTER TABLE zk_devices ADD COLUMN branch VARCHAR(100) NULL");
  await add("ALTER TABLE zk_devices ADD COLUMN connection VARCHAR(10) NOT NULL DEFAULT 'lan'");
  await add("ALTER TABLE zk_devices ADD COLUMN pin_mode VARCHAR(10) NOT NULL DEFAULT 'shared'");
  await add("ALTER TABLE zk_devices ADD COLUMN allowed_ip VARCHAR(64) NULL");
  await add("ALTER TABLE zk_devices ADD COLUMN last_seen_at TIMESTAMP NULL DEFAULT NULL");
  await add("ALTER TABLE zk_devices ADD COLUMN offline_alerted_at TIMESTAMP NULL DEFAULT NULL");
  await add("ALTER TABLE zk_attendance_logs ADD COLUMN raw_pin VARCHAR(20) NULL");
  await add("ALTER TABLE zk_attendance_logs ADD INDEX idx_zk_logs_device_raw (device_id, raw_pin)");
  try {
    await dbPool.query(`CREATE TABLE IF NOT EXISTS zk_device_pins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      device_id INT NOT NULL,
      pin VARCHAR(20) NOT NULL,
      employee_id INT NOT NULL,
      linked_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_zk_device_pin (device_id, pin),
      UNIQUE KEY uq_zk_device_employee (device_id, employee_id),
      CONSTRAINT fk_zk_device_pins_device FOREIGN KEY (device_id) REFERENCES zk_devices(id) ON DELETE CASCADE,
      CONSTRAINT fk_zk_device_pins_employee FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE
    )`);
  } catch (err: any) {
    console.warn("⚠️ Could not create zk_device_pins: " + err.message);
  }
}

// What a punch from this machine is stored under: its own PIN on a 'shared'
// machine; on an 'own' machine the linked person's office-wide PIN, else the
// "M<machine>-<pin>" placeholder. One lookup per call, cached per batch.
export async function pinMapperFor(dbPool: Pool, device: { id: number; pin_mode?: string | null }): Promise<(raw: string) => string> {
  if ((device.pin_mode || "shared") !== "own") return (raw) => raw;
  const [rows]: any = await dbPool.query(
    `SELECT m.pin, e.zk_device_pin FROM zk_device_pins m JOIN all_employees e ON e.id = m.employee_id WHERE m.device_id = ?`,
    [device.id]
  );
  const map = new Map<string, string>();
  for (const r of rows || []) if (r.zk_device_pin) map.set(String(r.pin), String(r.zk_device_pin));
  return (raw) => map.get(raw) || placeholderPin(device.id, raw);
}

// Re-points every stored punch of one linked person on 'own' machines to
// their current office-wide PIN (after linking, unlinking or a PIN change).
export async function repointEmployeePunches(queryDB: (sql: string, p?: any[]) => Promise<any>, employeeId: number): Promise<void> {
  const emp: any[] = await queryDB("SELECT id, zk_device_pin FROM all_employees WHERE id = ?", [employeeId]);
  if (!emp.length) return;
  const links: any[] = await queryDB("SELECT device_id, pin FROM zk_device_pins WHERE employee_id = ? ORDER BY id", [employeeId]);
  let global = emp[0].zk_device_pin ? String(emp[0].zk_device_pin) : "";
  if (!global && links.length) {
    // Linked on a machine but no office-wide PIN: that machine's placeholder becomes it.
    global = placeholderPin(Number(links[0].device_id), String(links[0].pin));
    await queryDB("UPDATE all_employees SET zk_device_pin = ? WHERE id = ?", [global, employeeId]);
  }
  for (const l of links) {
    const ph = placeholderPin(Number(l.device_id), String(l.pin));
    await queryDB(
      "UPDATE IGNORE zk_attendance_logs SET device_user_pin = ? WHERE device_id = ? AND (raw_pin = ? OR (raw_pin IS NULL AND device_user_pin = ?))",
      [global, Number(l.device_id), String(l.pin), ph]
    );
    // A punch already stored under both (pulled again after the link) keeps one copy.
    if (ph !== global) await queryDB("DELETE FROM zk_attendance_logs WHERE device_id = ? AND device_user_pin = ?", [Number(l.device_id), ph]);
  }
}

// ---- ADMS ("Cloud server") push -------------------------------------------
// The machine calls, over plain HTTP(S):
//   GET  /iclock/cdata?SN=...&options=all   -> its settings (handshake)
//   POST /iclock/cdata?SN=...&table=ATTLOG  -> punches, one per line:
//        PIN \t YYYY-MM-DD HH:MM:SS \t status \t verify \t workcode ...
//   GET  /iclock/getrequest?SN=...          -> commands for it ("OK" = none)
//   POST /iclock/devicecmd?SN=...           -> command results
// It sends its own local (Bangladesh) time, stored as is like a LAN pull.
export function registerZkPushRoutes(app: Express, pool: () => Pool | null) {
  const clientIp = (req: any) => String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim().replace(/^::ffff:/, "");
  // A registered, switched-on push machine with this serial (and, if set,
  // calling from the allowed address) — else null and a plain 403.
  const machineFor = async (req: any, res: any) => {
    const dbPool = pool();
    const sn = String(req.query.SN || req.query.sn || "").trim().slice(0, 100);
    if (!dbPool || !sn) {
      res.status(400).type("text/plain").send("ERROR");
      return null;
    }
    const [rows]: any = await dbPool.query(
      "SELECT id, name, pin_mode, allowed_ip, is_active, connection FROM zk_devices WHERE serial_number = ? AND connection = 'push' LIMIT 1",
      [sn]
    );
    const d = rows?.[0];
    if (!d || !Number(d.is_active)) {
      res.status(403).type("text/plain").send("Unknown device");
      return null;
    }
    if (d.allowed_ip && d.allowed_ip.trim() && d.allowed_ip.trim() !== clientIp(req)) {
      res.status(403).type("text/plain").send("Not allowed");
      return null;
    }
    await dbPool.query("UPDATE zk_devices SET last_seen_at = NOW(), offline_alerted_at = NULL WHERE id = ?", [d.id]);
    return { ...d, sn };
  };

  app.get("/iclock/cdata", async (req: any, res) => {
    try {
      const d = await machineFor(req, res);
      if (!d) return;
      res.type("text/plain").send(
        [
          `GET OPTION FROM: ${d.sn}`,
          "ATTLOGStamp=None",
          "OPERLOGStamp=9999",
          "ATTPHOTOStamp=None",
          "ErrorDelay=60",
          "Delay=30",
          "TransTimes=00:00;14:05",
          "TransInterval=1",
          "TransFlag=TransData AttLog",
          "TimeZone=6",
          "Realtime=1",
          "Encrypt=None"
        ].join("\n")
      );
    } catch {
      res.status(500).type("text/plain").send("ERROR");
    }
  });

  app.post("/iclock/cdata", express.text({ type: "*/*", limit: "2mb" }), async (req: any, res) => {
    try {
      const d = await machineFor(req, res);
      if (!d) return;
      const table = String(req.query.table || "").toUpperCase();
      const body = typeof req.body === "string" ? req.body : "";
      if (table !== "ATTLOG") return res.type("text/plain").send("OK");
      const dbPool = pool()!;
      const mapPin = await pinMapperFor(dbPool, d);
      let count = 0;
      for (const line of body.split(/\r?\n/)) {
        const f = line.split("\t");
        const raw = String(f[0] || "").trim().slice(0, 20);
        const when = String(f[1] || "").trim();
        if (!raw || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(when)) continue;
        await dbPool.execute(
          `INSERT IGNORE INTO zk_attendance_logs (device_id, device_user_pin, raw_pin, punch_time, verify_mode, work_code)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [d.id, mapPin(raw), raw, when, Number.isFinite(Number(f[3])) ? Number(f[3]) : null, Number.isFinite(Number(f[4])) ? Number(f[4]) : null]
        );
        count++;
      }
      await dbPool.query("UPDATE zk_devices SET last_synced_at = NOW(), last_sync_status = ? WHERE id = ?", [`ok (push, ${count} punches)`, d.id]);
      res.type("text/plain").send(`OK: ${count}`);
    } catch {
      res.status(500).type("text/plain").send("ERROR");
    }
  });

  app.get("/iclock/getrequest", async (req: any, res) => {
    try {
      const d = await machineFor(req, res);
      if (!d) return;
      res.type("text/plain").send("OK");
    } catch {
      res.status(500).type("text/plain").send("ERROR");
    }
  });

  app.post("/iclock/devicecmd", express.text({ type: "*/*", limit: "256kb" }), async (req: any, res) => {
    try {
      const d = await machineFor(req, res);
      if (!d) return;
      res.type("text/plain").send("OK");
    } catch {
      res.status(500).type("text/plain").send("ERROR");
    }
  });
}

// Machines that have gone quiet: an active machine not heard from for
// `minutes` (a pull that worked, or a push) is told once to the people with
// the Office Attendance module, until it is heard from again. Only between
// 07:00 and 21:00 Bangladesh time, when machines are expected to be on.
export async function checkZkMachinesOffline(
  dbPool: Pool | null,
  notify: (title: string, message: string) => Promise<void>,
  minutes = 60
): Promise<void> {
  if (!dbPool) return;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", hour: "2-digit", hour12: false }).format(new Date()));
  if (hour < 7 || hour >= 21) return;
  const [rows]: any = await dbPool.query(
    `SELECT id, name, branch, connection, COALESCE(last_seen_at, last_synced_at) AS seen
     FROM zk_devices
     WHERE is_active = 1 AND offline_alerted_at IS NULL
       AND (COALESCE(last_seen_at, last_synced_at) IS NULL OR COALESCE(last_seen_at, last_synced_at) < NOW() - INTERVAL ? MINUTE)
       AND created_at < NOW() - INTERVAL ? MINUTE`,
    [minutes, minutes]
  );
  for (const d of rows || []) {
    await dbPool.query("UPDATE zk_devices SET offline_alerted_at = NOW() WHERE id = ?", [d.id]);
    await notify(
      "Attendance machine offline",
      `${d.name}${d.branch ? ` (${d.branch})` : ""} hasn't been heard from ${d.seen ? `since ${String(d.seen).slice(0, 16)}` : "yet"} — punches there aren't reaching CredenceHR. Check its power and ${d.connection === "push" ? "internet / Cloud server setting" : "network cable"}.`
    );
  }
}
