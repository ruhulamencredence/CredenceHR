/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Device access for the mobile app: an account signs in to the app on one
// phone only (users.max_devices, 1 by default). Signing in on another phone
// waits for a Superadmin, who either moves the account to the new phone or
// allows one more. The website is not limited. Superadmins and the system
// owner are never limited (their phones are still listed).
//
// The app sends a stable device id (Capacitor Device.getId()) with its
// login; the token it gets back carries that device's row id ("dev"), and
// removing the device ends that phone's session on its next request
// (deviceStillAllowed, checked in authenticateToken).

import type { Express } from "express";
import { DEFAULT_GROUP_ID, activeGroupId } from "./companyContext";
import { createAlert } from "./Alerts";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface DeviceRouteDeps {
  authenticateToken: any;
  requireSuperAdmin: any;
  queryDB: QueryDB;
}

export const MAX_DEVICES_LIMIT = 5;

export async function ensureDeviceSchema(queryDB: QueryDB) {
  await queryDB(`CREATE TABLE IF NOT EXISTS user_devices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    device_id VARCHAR(128) NOT NULL,
    device_name VARCHAR(200) NULL,
    platform VARCHAR(20) NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    requested_at TIMESTAMP NULL,
    approved_by INT NULL,
    approved_at TIMESTAMP NULL,
    last_seen_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_user_device (user_id, device_id),
    KEY idx_user_devices_user (user_id)
  )`);
  // Only when missing, so a restart doesn't log a duplicate-column error.
  const has: any[] = await queryDB(
    "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'max_devices'"
  );
  if (!Number(has?.[0]?.n || 0)) await queryDB("ALTER TABLE users ADD COLUMN max_devices INT NOT NULL DEFAULT 1").catch(() => {});
  // Every "new phone" request and what became of it, one row per ask (a
  // phone that asks again gets a new row), so Device Access can list the
  // waiting ones on top and the decided ones under them, newest first.
  // decision: NULL = waiting; moved / added = approved; turned_away;
  // allowed = signed in by itself after the phone limit was raised.
  await queryDB(`CREATE TABLE IF NOT EXISTS user_device_requests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    device_row_id INT NOT NULL,
    device_name VARCHAR(200) NULL,
    requested_at TIMESTAMP NULL,
    decision VARCHAR(20) NULL,
    decided_by INT NULL,
    decided_at TIMESTAMP NULL,
    KEY idx_udr_user (user_id),
    KEY idx_udr_device (device_row_id)
  )`);
  // Requests from before this table: one row per phone that ever asked.
  await queryDB(
    `INSERT INTO user_device_requests (user_id, device_row_id, device_name, requested_at, decision, decided_by, decided_at)
     SELECT d.user_id, d.id, d.device_name, d.requested_at,
            CASE WHEN d.status = 'pending' THEN NULL WHEN d.approved_at IS NOT NULL THEN 'moved' ELSE 'turned_away' END,
            d.approved_by, d.approved_at
       FROM user_devices d
      WHERE d.requested_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM user_device_requests r WHERE r.device_row_id = d.id)`
  ).catch(() => {});
}

// Close a phone's open request (if any) with what happened to it.
async function closeRequest(queryDB: QueryDB, deviceRowId: number, decision: string, by: number | null) {
  await queryDB("UPDATE user_device_requests SET decision = ?, decided_by = ?, decided_at = ? WHERE device_row_id = ? AND decision IS NULL", [
    decision,
    by,
    new Date(),
    deviceRowId
  ]).catch(() => {});
}

const exempt = (u: any) => u?.role === "superadmin" || Number(u?.is_platform_admin || 0) === 1;
const clean = (v: any, n: number) => String(v ?? "").trim().slice(0, n);

export type DeviceCheck = { ok: true; deviceRowId: number } | { ok: false; status: number; error: string; code: string };

/** Called by /api/auth/login for the app, after the password is checked. */
export async function checkAppDevice(queryDB: QueryDB, user: any, body: any): Promise<DeviceCheck> {
  const deviceId = clean(body?.device_id, 128);
  if (!deviceId)
    return { ok: false, status: 426, code: "APP_UPDATE_REQUIRED", error: "Please update the CredenceHR app to the latest version to sign in." };
  const name = clean(body?.device_name, 200) || null;
  const platform = clean(body?.device_platform, 20) || null;
  const userId = Number(user.id);
  const rows: any[] = (await queryDB("SELECT * FROM user_devices WHERE user_id = ?", [userId])) || [];
  const mine = rows.filter((r) => Number(r.user_id) === userId);
  const row = mine.find((r) => r.device_id === deviceId);
  const now = new Date();

  if (row && row.status === "active") {
    await queryDB("UPDATE user_devices SET last_seen_at = ?, device_name = COALESCE(?, device_name) WHERE id = ?", [now, name, row.id]);
    return { ok: true, deviceRowId: Number(row.id) };
  }
  const active = mine.filter((r) => r.status === "active").length;
  const limit = Math.max(1, Number(user.max_devices || 1));
  if (exempt(user) || active < limit) {
    if (row) {
      await queryDB("UPDATE user_devices SET status = 'active', last_seen_at = ?, device_name = COALESCE(?, device_name) WHERE id = ?", [now, name, row.id]);
      // It was waiting, and the limit has since been raised: done by itself.
      if (row.status === "pending") await closeRequest(queryDB, Number(row.id), "allowed", null);
    }
    else
      await queryDB("INSERT INTO user_devices (user_id, device_id, device_name, platform, status, last_seen_at) VALUES (?, ?, ?, ?, 'active', ?)", [
        userId,
        deviceId,
        name,
        platform,
        now
      ]);
    const again: any[] = (await queryDB("SELECT id, user_id, device_id FROM user_devices WHERE user_id = ?", [userId])) || [];
    const id = Number(again.find((r) => Number(r.user_id) === userId && r.device_id === deviceId)?.id || 0);
    return { ok: true, deviceRowId: id };
  }

  // Over the limit: this phone waits for a Superadmin.
  const firstAsk = !row || row.status !== "pending";
  if (row) await queryDB("UPDATE user_devices SET status = 'pending', requested_at = ?, device_name = COALESCE(?, device_name) WHERE id = ?", [now, name, row.id]);
  else
    await queryDB("INSERT INTO user_devices (user_id, device_id, device_name, platform, status, requested_at) VALUES (?, ?, ?, ?, 'pending', ?)", [
      userId,
      deviceId,
      name,
      platform,
      now
    ]);
  if (firstAsk) {
    const asked: any[] = (await queryDB("SELECT id, user_id, device_id FROM user_devices WHERE user_id = ?", [userId])) || [];
    const rowId = Number(asked.find((r) => Number(r.user_id) === userId && r.device_id === deviceId)?.id || 0);
    if (rowId)
      await queryDB("INSERT INTO user_device_requests (user_id, device_row_id, device_name, requested_at) VALUES (?, ?, ?, ?)", [userId, rowId, name || row?.device_name || null, now]).catch(
        () => {}
      );
    const groupId = Number(user.group_id ?? DEFAULT_GROUP_ID);
    const admins: any[] = (await queryDB("/*unscoped*/ SELECT id, role, group_id FROM users").catch(() => [])) || [];
    for (const a of admins)
      if (a.role === "superadmin" && Number(a.group_id ?? DEFAULT_GROUP_ID) === groupId)
        await createAlert(queryDB, {
          userId: Number(a.id),
          type: "device_request",
          title: "New phone waiting for approval",
          message: `${user.name || "An account"} wants to sign in to the app on ${name || "another phone"}. Admin Panel -> Device Access.`,
          relatedType: "user_device",
          relatedId: userId
        });
  }
  return {
    ok: false,
    status: 403,
    code: "DEVICE_APPROVAL_REQUIRED",
    error: "This account is already signed in on another phone. Your Superadmin has been asked to allow this phone — sign in again once they approve."
  };
}

// Whether a token issued for a phone may still be used (cached briefly).
const stillCache = new Map<number, { ok: boolean; at: number }>();
const STILL_TTL_MS = 30 * 1000;
export async function deviceStillAllowed(queryDB: QueryDB, deviceRowId: number): Promise<boolean> {
  const hit = stillCache.get(deviceRowId);
  if (hit && Date.now() - hit.at < STILL_TTL_MS) return hit.ok;
  const rows: any[] = (await queryDB("SELECT id, status FROM user_devices WHERE id = ?", [deviceRowId]).catch(() => null)) as any[];
  // A database hiccup never signs anyone out.
  if (!rows) return true;
  const ok = rows.some((r) => Number(r.id) === deviceRowId && r.status === "active");
  stillCache.set(deviceRowId, { ok, at: Date.now() });
  return ok;
}
const forget = (ids: number[]) => ids.forEach((id) => stillCache.delete(id));

export function registerDeviceRoutes(app: Express, deps: DeviceRouteDeps) {
  const { authenticateToken, requireSuperAdmin, queryDB } = deps;
  const fail = (res: any, err: any) => res.status(err?.statusCode || 500).json({ error: err?.message || String(err) });
  const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

  // Accounts of the group being worked in.
  const groupUsers = async () => {
    const gid = activeGroupId();
    const users: any[] = (await queryDB("/*unscoped*/ SELECT * FROM users")) || [];
    return users.filter((u) => Number(u.group_id ?? DEFAULT_GROUP_ID) === gid);
  };
  const deviceOfGroup = async (id: number) => {
    const rows: any[] = (await queryDB("SELECT * FROM user_devices WHERE id = ?", [id])) || [];
    const d = rows.find((r) => Number(r.id) === id);
    const u = d && (await groupUsers()).find((x) => Number(x.id) === Number(d.user_id));
    if (!d || !u) throw bad("Device not found.", 404);
    return { d, u };
  };

  app.get("/api/devices", authenticateToken, requireSuperAdmin, async (_req: any, res) => {
    try {
      const users = await groupUsers();
      const ids = new Set(users.map((u) => Number(u.id)));
      // Department and work station (branch) — to tell people apart.
      const [emps, depts, branches, reqs, deciders]: any[][] = await Promise.all([
        queryDB("/*unscoped*/ SELECT user_id, employee_id, designation, department, department_id, branch, branch_id FROM all_employees WHERE user_id IS NOT NULL").catch(() => []),
        queryDB("/*unscoped*/ SELECT id, name FROM departments").catch(() => []),
        queryDB("/*unscoped*/ SELECT id, branch_name FROM branches").catch(() => []),
        queryDB("SELECT * FROM user_device_requests ORDER BY id DESC").catch(() => []),
        queryDB("/*unscoped*/ SELECT id, name FROM users WHERE role IN ('superadmin', 'admin')").catch(() => [])
      ]);
      const deptName = new Map((depts || []).map((d: any) => [Number(d.id), d.name]));
      const branchName = new Map((branches || []).map((b: any) => [Number(b.id), b.branch_name]));
      const empOf = new Map<number, any>();
      for (const e of emps || []) if (!empOf.has(Number(e.user_id))) empOf.set(Number(e.user_id), e);
      const who = (userId: number) => {
        const e = empOf.get(userId);
        return {
          employee_code: e?.employee_id || null,
          designation: e?.designation || null,
          department: (e?.department_id && deptName.get(Number(e.department_id))) || e?.department || null,
          location: (e?.branch_id && branchName.get(Number(e.branch_id))) || e?.branch || null
        };
      };
      const deciderName = new Map((deciders || []).map((u: any) => [Number(u.id), u.name]));
      const devices: any[] = ((await queryDB("SELECT * FROM user_devices")) || []).filter((d: any) => ids.has(Number(d.user_id)) && d.status !== "removed");
      const lite = (d: any) => ({
        id: Number(d.id),
        name: d.device_name || "Unknown phone",
        platform: d.platform || null,
        status: d.status,
        requested_at: d.requested_at,
        approved_at: d.approved_at,
        last_seen_at: d.last_seen_at,
        created_at: d.created_at
      });
      res.json({
        max_limit: MAX_DEVICES_LIMIT,
        users: users
          .map((u) => {
            const mine = devices.filter((d) => Number(d.user_id) === Number(u.id));
            return {
              id: Number(u.id),
              name: u.name,
              email: u.email || u.username || null,
              role: u.role,
              ...who(Number(u.id)),
              exempt: exempt(u),
              max_devices: Math.max(1, Number(u.max_devices || 1)),
              devices: mine.filter((d) => d.status === "active").map(lite),
              pending: mine.filter((d) => d.status === "pending").map(lite)
            };
          })
          .sort((a, b) => b.pending.length - a.pending.length || String(a.name).localeCompare(String(b.name))),
        // Waiting first (oldest ask first), then decided ones, newest first.
        requests: (reqs || [])
          .filter((r: any) => ids.has(Number(r.user_id)))
          .map((r: any) => {
            const u = users.find((x) => Number(x.id) === Number(r.user_id));
            const dev = devices.find((d: any) => Number(d.id) === Number(r.device_row_id));
            return {
              id: Number(r.id),
              device_id: Number(r.device_row_id),
              user_id: Number(r.user_id),
              name: u?.name || "",
              email: u?.email || u?.username || null,
              ...who(Number(r.user_id)),
              phone: r.device_name || dev?.device_name || "Unknown phone",
              requested_at: r.requested_at,
              // Still waiting only while the phone itself is (a request left
              // open by an older path is shown as closed).
              decision: r.decision || (dev?.status === "pending" ? null : "closed"),
              decided_at: r.decided_at,
              decided_by: r.decided_by ? deciderName.get(Number(r.decided_by)) || null : null
            };
          })
          .sort((a: any, b: any) => {
            if (!a.decision !== !b.decision) return a.decision ? 1 : -1;
            const t = (v: any) => (v ? new Date(String(v).replace(" ", "T")).getTime() || 0 : 0);
            if (!a.decision) return t(a.requested_at) - t(b.requested_at) || a.id - b.id;
            return t(b.decided_at || b.requested_at) - t(a.decided_at || a.requested_at) || b.id - a.id;
          })
      });
    } catch (err) {
      fail(res, err);
    }
  });

  // mode "replace": the account moves to this phone (its other phones are
  // signed out); mode "add": it keeps its phones and gets one more.
  app.post("/api/devices/:id/approve", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const { d, u } = await deviceOfGroup(Number(req.params.id));
      if (d.status !== "pending") throw bad("This phone isn't waiting for approval.");
      const mode = req.body?.mode === "add" ? "add" : "replace";
      const all: any[] = ((await queryDB("SELECT * FROM user_devices WHERE user_id = ?", [Number(u.id)])) || []).filter((r: any) => Number(r.user_id) === Number(u.id));
      const active = all.filter((r) => r.status === "active");
      if (mode === "replace") {
        for (const r of active) await queryDB("UPDATE user_devices SET status = 'removed' WHERE id = ?", [Number(r.id)]);
        forget(active.map((r) => Number(r.id)));
      } else {
        if (active.length + 1 > MAX_DEVICES_LIMIT) throw bad(`At most ${MAX_DEVICES_LIMIT} phones per account.`);
        if (active.length + 1 > Number(u.max_devices || 1)) await queryDB("/*unscoped*/ UPDATE users SET max_devices = ? WHERE id = ?", [active.length + 1, Number(u.id)]);
      }
      await queryDB("UPDATE user_devices SET status = 'active', approved_by = ?, approved_at = ? WHERE id = ?", [req.user.id, new Date(), Number(d.id)]);
      forget([Number(d.id)]);
      await closeRequest(queryDB, Number(d.id), mode === "add" ? "added" : "moved", Number(req.user.id));
      // The account hears it (its other phones get the push), so nobody keeps
      // waiting on a phone that can already sign in.
      await createAlert(queryDB, {
        userId: Number(u.id),
        type: "device_request",
        title: "New phone approved",
        message: `${d.device_name || "Your new phone"} can now sign in to the app.${mode === "replace" ? " Your other phone was signed out." : ""}`,
        relatedType: "user_device_decision",
        relatedId: Number(d.id)
      }).catch(() => {});
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Turn a waiting phone away, or remove a phone (it is signed out).
  app.delete("/api/devices/:id", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const { d } = await deviceOfGroup(Number(req.params.id));
      await queryDB("UPDATE user_devices SET status = 'removed' WHERE id = ?", [Number(d.id)]);
      forget([Number(d.id)]);
      if (d.status === "pending") {
        await closeRequest(queryDB, Number(d.id), "turned_away", Number(req.user.id));
        await createAlert(queryDB, {
          userId: Number(d.user_id),
          type: "device_request",
          title: "New phone not approved",
          message: `${d.device_name || "The new phone"} was not approved for this account. Ask your Superadmin if you need it.`,
          relatedType: "user_device_decision",
          relatedId: Number(d.id)
        }).catch(() => {});
      }
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // How many phones an account may use.
  app.put("/api/devices/users/:userId/limit", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const userId = Number(req.params.userId);
      if (!(await groupUsers()).some((u) => Number(u.id) === userId)) throw bad("Account not found.", 404);
      const n = Math.trunc(Number(req.body?.max_devices));
      if (!(n >= 1 && n <= MAX_DEVICES_LIMIT)) throw bad(`Choose 1 to ${MAX_DEVICES_LIMIT} phones.`);
      await queryDB("/*unscoped*/ UPDATE users SET max_devices = ? WHERE id = ?", [n, userId]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });
}
