/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Active Users (Superadmin only): who is using the app right
// now, from which IP address and on which device.
//
// Every signed-in request already passes authenticateToken; touchSession
// (called from there) keeps one row per sign-in — keyed by a hash of that
// sign-in's token, never the token itself — with its latest IP, browser /
// phone and the time it was last used. The app and the website both poll
// alerts every 30 seconds while open, so a session that stops being touched
// for a few minutes has been closed or put away. Rows are written at most
// once a minute per sign-in (or at once when its IP changes), and rows not
// used for 30 days are cleared.

import type { Express } from "express";
import crypto from "crypto";
import { DEFAULT_GROUP_ID, activeGroupId } from "./companyContext";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface ActiveUsersDeps {
  authenticateToken: any;
  requireSuperAdmin: any;
  queryDB: QueryDB;
}

const WRITE_EVERY_MS = 60 * 1000;
const ONLINE_MS = 3 * 60 * 1000;
const KEEP_DAYS = 30;

export async function ensureActiveUsersSchema(queryDB: QueryDB) {
  await queryDB(`CREATE TABLE IF NOT EXISTS user_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    session_key CHAR(40) NOT NULL,
    user_id INT NOT NULL,
    client VARCHAR(10) NOT NULL DEFAULT 'web',
    device_row_id INT NULL,
    ip VARCHAR(64) NULL,
    user_agent VARCHAR(400) NULL,
    signed_in_at TIMESTAMP NULL,
    first_seen_at TIMESTAMP NULL,
    last_seen_at TIMESTAMP NULL,
    UNIQUE KEY uniq_session_key (session_key),
    KEY idx_user_sessions_user (user_id),
    KEY idx_user_sessions_seen (last_seen_at)
  )`);
}

const bareIp = (v: any) => {
  let ip = String(v ?? "").trim().replace(/^"|"$/g, "");
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  // "1.2.3.4:5678" (some proxies keep the port) and "[::1]:80"
  const v4port = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4port) ip = v4port[1];
  const v6port = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (v6port) ip = v6port[1];
  return ip.slice(0, 64);
};
export const isLoopbackIp = (ip: string | null) => !ip || ip === "::1" || ip.startsWith("127.") || ip === "localhost" || ip === "0.0.0.0";
const isPrivateIp = (ip: string) =>
  isLoopbackIp(ip) ||
  /^10\./.test(ip) ||
  /^192\.168\./.test(ip) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
  /^169\.254\./.test(ip) ||
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ||
  /^(fc|fd|fe80)/i.test(ip);

// The visitor's address. Behind a web server / panel proxy the connection
// itself comes from 127.0.0.1, so read what the proxy passed along: the
// nearest public address in X-Forwarded-For (right to left — the left end is
// whatever the visitor claimed), X-Real-IP, or a CDN's own header. A private
// address is kept only when nothing public is there (an office-LAN server).
export const clientIp = (req: any) => {
  const h = req.headers || {};
  const xff = String(h["x-forwarded-for"] || "")
    .split(",")
    .map(bareIp)
    .filter(Boolean)
    .reverse();
  const candidates = [
    ...xff,
    bareIp(h["x-real-ip"]),
    bareIp(h["cf-connecting-ip"]),
    bareIp(h["true-client-ip"]),
    bareIp(h["x-client-ip"]),
    bareIp(req.ip),
    bareIp(req.socket?.remoteAddress)
  ].filter(Boolean);
  return candidates.find((ip) => !isPrivateIp(ip)) || candidates.find((ip) => !isLoopbackIp(ip)) || candidates[0] || null;
};

// key -> { at: last write, ip } so most requests never touch the database.
const lastWrite = new Map<string, { at: number; ip: string | null }>();

/** Called by authenticateToken once the token checks out. Never throws. */
export function touchSession(queryDB: QueryDB, req: any, token: string, user: any) {
  try {
    const userId = Number(user?.id);
    if (!userId) return;
    const key = crypto.createHash("sha1").update(token).digest("hex");
    const ip = clientIp(req);
    const now = Date.now();
    const prev = lastWrite.get(key);
    if (prev && now - prev.at < WRITE_EVERY_MS && prev.ip === ip) return;
    lastWrite.set(key, { at: now, ip });
    if (lastWrite.size > 20000) {
      for (const [k, v] of lastWrite) if (now - v.at > ONLINE_MS) lastWrite.delete(k);
    }
    const ua = String(req.headers?.["user-agent"] || "").slice(0, 400) || null;
    const dev = user?.dev ? Number(user.dev) : null;
    const client = dev || /;\s*wv\)/.test(ua || "") ? "app" : "web";
    const signedIn = Number(user?.iat) ? new Date(Number(user.iat) * 1000) : null;
    const at = new Date(now);
    void queryDB(
      `INSERT INTO user_sessions (session_key, user_id, client, device_row_id, ip, user_agent, signed_in_at, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE ip = VALUES(ip), user_agent = VALUES(user_agent), last_seen_at = VALUES(last_seen_at)`,
      [key, userId, client, dev, ip, ua, signedIn, at, at]
    ).catch(() => {});
  } catch {
    // Tracking never gets in the way of the request itself.
  }
}

// "Chrome on Windows", "Android 14 · Samsung SM-A515F" and the like.
export function describeAgent(ua: string | null): { browser: string; os: string } {
  const s = String(ua || "");
  let os = "Unknown";
  const android = s.match(/Android\s([\d.]+)/);
  const ios = s.match(/(?:iPhone|iPad|iPod).*?OS\s([\d_]+)/);
  if (android) os = `Android ${android[1]}`;
  else if (ios) os = `iOS ${ios[1].replace(/_/g, ".")}`;
  else if (/Windows NT 10/.test(s)) os = "Windows 10/11";
  else if (/Windows/.test(s)) os = "Windows";
  else if (/Mac OS X|Macintosh/.test(s)) os = "macOS";
  else if (/CrOS/.test(s)) os = "ChromeOS";
  else if (/Linux/.test(s)) os = "Linux";
  let browser = "Browser";
  if (/;\s*wv\)/.test(s)) browser = "App";
  else if (/Edg\//.test(s)) browser = "Edge";
  else if (/OPR\//.test(s)) browser = "Opera";
  else if (/SamsungBrowser\//.test(s)) browser = "Samsung Internet";
  else if (/Firefox\//.test(s)) browser = "Firefox";
  else if (/Chrome\//.test(s)) browser = "Chrome";
  else if (/Safari\//.test(s)) browser = "Safari";
  return { browser, os };
}

export function registerActiveUsersRoutes(app: Express, deps: ActiveUsersDeps) {
  const { authenticateToken, requireSuperAdmin, queryDB } = deps;
  let lastPurge = 0;

  // ?range=online (default) | today | 7d
  app.get("/api/active-users", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const now = Date.now();
      if (now - lastPurge > 60 * 60 * 1000) {
        lastPurge = now;
        await queryDB("DELETE FROM user_sessions WHERE last_seen_at < ?", [new Date(now - KEEP_DAYS * 86400000)]).catch(() => {});
      }
      const range = ["today", "7d"].includes(String(req.query.range)) ? String(req.query.range) : "online";
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const since = range === "online" ? now - ONLINE_MS : range === "today" ? startOfToday.getTime() : now - 7 * 86400000;
      // A whole week covers every range's counts at once.
      const weekAgo = Math.min(since, now - 7 * 86400000);

      const gid = activeGroupId();
      const users: any[] = ((await queryDB("/*unscoped*/ SELECT * FROM users")) || []).filter(
        (u: any) => Number(u.group_id ?? DEFAULT_GROUP_ID) === gid
      );
      const byId = new Map(users.map((u) => [Number(u.id), u]));
      const rows: any[] = ((await queryDB("SELECT * FROM user_sessions WHERE last_seen_at >= ?", [new Date(weekAgo)])) || []).filter((r: any) =>
        byId.has(Number(r.user_id))
      );
      const devices: any[] = (await queryDB("SELECT id, device_name, platform FROM user_devices").catch(() => [])) || [];
      const devName = new Map(devices.map((d: any) => [Number(d.id), d.device_name || null]));

      // The pool returns DATETIMEs as server-local strings; hand the page
      // real instants so it shows them in the viewer's own time.
      const iso = (v: any) => {
        const t = v ? new Date(v).getTime() : NaN;
        return Number.isFinite(t) ? new Date(t).toISOString() : null;
      };
      const seen = (r: any) => new Date(r.last_seen_at).getTime();
      const sessions = rows
        .filter((r) => seen(r) >= since)
        .sort((a, b) => seen(b) - seen(a))
        .map((r) => {
          const u = byId.get(Number(r.user_id));
          const { browser, os } = describeAgent(r.user_agent);
          return {
            id: Number(r.id),
            user_id: Number(r.user_id),
            name: u?.name || "Unknown",
            login: u?.email || u?.username || null,
            role: u?.role || null,
            client: r.client === "app" ? "app" : "web",
            device_name: r.device_row_id ? devName.get(Number(r.device_row_id)) || null : null,
            browser,
            os,
            ip: r.ip || null,
            signed_in_at: iso(r.signed_in_at || r.first_seen_at),
            last_seen_at: iso(r.last_seen_at),
            online: now - seen(r) < ONLINE_MS
          };
        });

      const usersIn = (from: number, client?: string) =>
        new Set(rows.filter((r) => seen(r) >= from && (!client || r.client === client)).map((r) => Number(r.user_id))).size;
      res.json({
        range,
        online_minutes: ONLINE_MS / 60000,
        // Every address is the server's own: the proxy in front isn't
        // passing the visitor's address on (X-Forwarded-For / X-Real-IP).
        proxy_hides_ip: sessions.length > 0 && sessions.every((x) => isLoopbackIp(x.ip)),
        summary: {
          online_users: usersIn(now - ONLINE_MS),
          online_app: usersIn(now - ONLINE_MS, "app"),
          online_web: usersIn(now - ONLINE_MS, "web"),
          today_users: usersIn(startOfToday.getTime()),
          week_users: usersIn(now - 7 * 86400000),
          total_accounts: users.length
        },
        sessions
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
}
