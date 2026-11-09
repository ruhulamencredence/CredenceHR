/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Partner app -> CredenceHR single sign-on (360 ERP first, any number of
// other applications too — each with its own App ID / App Secret, IPs,
// limits and switch): someone already signed in to that app opens CredenceHR
// without typing a password. Full guide for a partner's developers:
// docs/CredenceHR-SSO-API.md. The mirror image of
// Erp360SsoRoutes.ts (CredenceHR -> 360 ERP) and of 360 ERP's own partner
// SSO flow:
//
//   1. 360 ERP's SERVER (never a browser) calls
//        POST /api/v1/service/sso/initiate
//        headers X-App-Id / X-App-Secret
//        body    { email, employee_id, name?, request_ip?, redirect_path? }
//      The API guard checks: HTTPS, the client is switched on, the secret
//      matches, the caller's IP is allowed, the per-minute limit, and that
//      this route is given to this client. Every call — refused ones too —
//      is written to api_access_logs.
//   2. The person is found by BOTH email and Employee ID (the same person,
//      active employee, account not blocked). A 64-character one-time token
//      is made; only its SHA-256 is stored (sso_login_requests), valid for
//      the client's token life (120 s by default).
//   3. The answer is { forward_url: <this site>/sso/consume/<token>,
//      expires_in }. 360 ERP sends the person's browser there.
//   4. That page (SsoConsume.tsx) calls POST /api/auth/sso/consume with the
//      token — and, in the Android app, the same location / device details
//      a password sign-in sends. The token is used up in one step (it can
//      never be used twice), then the sign-in finishes through the very same
//      finishLogin() as a password sign-in: blocked account, App access,
//      the phone limit, workspace, onboarding — nothing is skipped. Every
//      attempt, good or bad, is written to sso_login_logs. The person lands
//      on the Dashboard; anything wrong sends them to the login page.
//
// Applications are added in Admin Panel -> Active Users -> "Partner app
// sign-in (SSO)" (Superadmin only): each gets its own App ID and App Secret;
// the secret is shown once and only its hash is kept.

import crypto from "crypto";
import type { Express } from "express";
import { finishLogin, type RegisterAuthRoutesDeps } from "./AuthRoutes";
import { clientIp } from "./ActiveUsersRoutes";

const ROUTE_INITIATE = "sso.initiate";
const DEFAULT_TTL_SECONDS = 120;
const DEFAULT_RATE_PER_MINUTE = 60;

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const sameHash = (a: string, b: string) => {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
const bareIp = (ip: string) => String(ip || "").trim().replace(/^::ffff:/, "");

export async function ensureErp360InboundSsoSchema(dbPool: any): Promise<void> {
  const run = async (sql: string) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      if (!/Duplicate column|already exists/i.test(err.message)) console.warn("⚠️ partner sign-in schema: " + err.message);
    }
  };
  // The partner apps allowed to call this server's service API.
  await run(`
    CREATE TABLE IF NOT EXISTS api_clients (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      app_id VARCHAR(64) NOT NULL UNIQUE,
      secret_hash CHAR(64) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      allowed_ips TEXT NULL,
      allowed_routes VARCHAR(255) NOT NULL DEFAULT '${ROUTE_INITIATE}',
      rate_per_minute INT NOT NULL DEFAULT ${DEFAULT_RATE_PER_MINUTE},
      token_ttl_seconds INT NOT NULL DEFAULT ${DEFAULT_TTL_SECONDS},
      secret_rotated_at DATETIME NULL,
      last_used_at DATETIME NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  await run(`
    CREATE TABLE IF NOT EXISTS sso_login_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      client_id INT NOT NULL,
      user_id INT NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      request_ip VARCHAR(64) NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sso_req_user (user_id),
      INDEX idx_sso_req_expires (expires_at)
    )`);
  await run(`
    CREATE TABLE IF NOT EXISTS api_access_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      client_id INT NULL,
      app_id VARCHAR(64) NULL,
      route VARCHAR(100) NOT NULL,
      ip VARCHAR(64) NULL,
      status INT NOT NULL,
      message VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_api_log_created (created_at)
    )`);
  await run(`
    CREATE TABLE IF NOT EXISTS sso_login_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      request_id INT NULL,
      client_id INT NULL,
      user_id INT NULL,
      ip VARCHAR(64) NULL,
      platform VARCHAR(10) NULL,
      success TINYINT(1) NOT NULL,
      reason VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sso_log_created (created_at)
    )`);
}

interface Deps extends RegisterAuthRoutesDeps {
  requireSuperAdmin: any;
}

// Calls in the current minute, per client (one server process).
const minuteCounts = new Map<number, { minute: number; n: number }>();
const overLimit = (clientId: number, perMinute: number) => {
  const minute = Math.floor(Date.now() / 60000);
  const c = minuteCounts.get(clientId);
  if (!c || c.minute !== minute) {
    minuteCounts.set(clientId, { minute, n: 1 });
    return false;
  }
  c.n += 1;
  return c.n > Math.max(1, perMinute);
};
// Sign-in attempts with a token, per IP (stops guessing; tokens are 256-bit anyway).
const consumeCounts = new Map<string, { minute: number; n: number }>();
const consumeOverLimit = (ip: string) => {
  const minute = Math.floor(Date.now() / 60000);
  const c = consumeCounts.get(ip);
  if (!c || c.minute !== minute) {
    consumeCounts.set(ip, { minute, n: 1 });
    if (consumeCounts.size > 5000) consumeCounts.clear();
    return false;
  }
  c.n += 1;
  return c.n > 30;
};

const isHttps = (req: any) => {
  if (req.secure) return true;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (proto === "https") return true;
  // Trying it out on this machine (http://localhost) is allowed.
  const host = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1") return true;
  return process.env.SSO_ALLOW_HTTP === "1";
};

const ipAllowed = (allowed: string | null, ip: string) => {
  const list = String(allowed || "")
    .split(/[\s,]+/)
    .map((s) => bareIp(s))
    .filter(Boolean);
  return list.length === 0 || list.includes(bareIp(ip));
};

const publicBase = (req: any) => {
  const env = String(process.env.PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  if (env) return env;
  return `https://${String(req.headers.host || "localhost")}`;
};

const newSecret = () => crypto.randomBytes(48).toString("base64url"); // 64 characters
// App ID: a readable prefix from the app's name + 16 random hex characters.
const newAppId = (name: string) => {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16) || "app";
  return `${slug}_${crypto.randomBytes(8).toString("hex")}`;
};

export function registerErp360InboundSsoRoutes(app: Express, deps: Deps) {
  const { authenticateToken, requireSuperAdmin, queryDB } = deps;

  const accessLog = (clientId: number | null, appId: string | null, route: string, ip: string, status: number, message: string) =>
    queryDB("INSERT INTO api_access_logs (client_id, app_id, route, ip, status, message) VALUES (?, ?, ?, ?, ?, ?)", [
      clientId,
      appId ? String(appId).slice(0, 64) : null,
      route,
      ip.slice(0, 64),
      status,
      message.slice(0, 255)
    ]).catch(() => undefined);
  const loginLog = (requestId: number | null, clientId: number | null, userId: number | null, ip: string, platform: string, success: boolean, reason: string) =>
    queryDB("INSERT INTO sso_login_logs (request_id, client_id, user_id, ip, platform, success, reason) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      requestId,
      clientId,
      userId,
      ip.slice(0, 64),
      platform,
      success ? 1 : 0,
      reason.slice(0, 255)
    ]).catch(() => undefined);

  // ---- 1-3. Partner app asks for a sign-in link ------------------------------
  app.post("/api/v1/service/sso/initiate", async (req: any, res) => {
    const ip = clientIp(req) || "";
    const appId = String(req.headers["x-app-id"] || "").trim();
    const secret = String(req.headers["x-app-secret"] || "");
    let clientId: number | null = null;
    const refuse = (status: number, message: string, errors?: Record<string, string[]>) => {
      void accessLog(clientId, appId || null, ROUTE_INITIATE, ip, status, message);
      return res.status(status).json(errors ? { message, errors } : { message });
    };
    try {
      if (!isHttps(req)) return refuse(403, "HTTPS is required.");
      if (!appId || !secret) return refuse(401, "Missing app credentials.");
      const rows: any[] = (await queryDB("SELECT * FROM api_clients WHERE app_id = ? LIMIT 1", [appId])) || [];
      const client = rows.find((r) => r.app_id === appId);
      if (!client) return refuse(401, "Invalid app credentials.");
      clientId = Number(client.id);
      if (Number(client.is_active) !== 1) return refuse(401, "This app is switched off.");
      if (!sameHash(sha256(secret), String(client.secret_hash))) return refuse(401, "Invalid app credentials.");
      if (!ipAllowed(client.allowed_ips, ip)) return refuse(403, "This IP address is not allowed.");
      if (overLimit(clientId, Number(client.rate_per_minute) || DEFAULT_RATE_PER_MINUTE)) return refuse(429, "Too many requests. Try again in a minute.");
      const routes = String(client.allowed_routes || "").split(/[\s,]+/).filter(Boolean);
      if (!routes.includes(ROUTE_INITIATE)) return refuse(403, "This app may not use this route.");

      const email = String(req.body?.email || "").trim();
      const employeeId = String(req.body?.employee_id ?? "").trim();
      const errors: Record<string, string[]> = {};
      if (!email) errors.email = ["The email field is required."];
      else if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 255) errors.email = ["The email must be a valid email address."];
      if (!employeeId) errors.employee_id = ["The employee id field is required."];
      else if (employeeId.length > 64) errors.employee_id = ["The employee id is too long."];
      if (Object.keys(errors).length) return refuse(422, "The given data was invalid.", errors);

      // The same person by BOTH email and Employee ID, active, not blocked.
      const people: any[] =
        (await queryDB(
          `/*unscoped*/ SELECT u.id, u.role, u.is_blocked, e.is_active AS employee_active
             FROM all_employees e JOIN users u ON u.id = e.user_id
            WHERE TRIM(e.employee_id) = ? AND (LOWER(TRIM(u.email)) = LOWER(?) OR LOWER(TRIM(e.email)) = LOWER(?))`,
          [employeeId, email, email]
        )) || [];
      const ids = Array.from(new Set(people.map((p) => Number(p.id))));
      if (ids.length !== 1) {
        return refuse(422, "No CredenceHR account matches this email and employee ID.", {
          employee_id: ["No CredenceHR account matches this email and employee ID."]
        });
      }
      const person = people.find((p) => Number(p.id) === ids[0]);
      if (Number(person.employee_active ?? 1) !== 1) return refuse(422, "This employee is not active.", { employee_id: ["This employee is not active."] });
      if (Number(person.is_blocked || 0) === 1 && person.role !== "superadmin") {
        return refuse(422, "This account is blocked.", { email: ["This account is blocked."] });
      }

      const token = crypto.randomBytes(32).toString("hex"); // 64 characters
      const ttl = Math.min(600, Math.max(30, Number(client.token_ttl_seconds) || DEFAULT_TTL_SECONDS));
      const requestIp = String(req.body?.request_ip || "").trim().slice(0, 64) || null;
      await queryDB("INSERT INTO sso_login_requests (client_id, user_id, token_hash, request_ip, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))", [
        clientId,
        ids[0],
        sha256(token),
        requestIp,
        ttl
      ]);
      await queryDB("UPDATE api_clients SET last_used_at = NOW() WHERE id = ?", [clientId]).catch(() => undefined);
      void accessLog(clientId, appId, ROUTE_INITIATE, ip, 200, `link made for user ${ids[0]}`);
      res.json({ forward_url: `${publicBase(req)}/sso/consume/${token}`, expires_in: ttl });
    } catch (err: any) {
      console.error("Partner sign-in initiate failed:", err?.message);
      void accessLog(clientId, appId || null, ROUTE_INITIATE, ip, 500, "unexpected error");
      res.status(500).json({ message: "Something went wrong. Please try again." });
    }
  });

  // ---- 4. The browser / app spends the token -------------------------------------
  app.post("/api/auth/sso/consume", async (req: any, res) => {
    const ip = clientIp(req) || "";
    const platform = req.body?.platform === "app" ? "app" : "web";
    const token = String(req.body?.token || "").trim().toLowerCase();
    if (consumeOverLimit(ip)) {
      void loginLog(null, null, null, ip, platform, false, "too many attempts");
      return res.status(429).json({ error: "Too many sign-in attempts. Try again in a minute." });
    }
    if (!/^[0-9a-f]{64}$/.test(token)) {
      void loginLog(null, null, null, ip, platform, false, "malformed token");
      return res.status(400).json({ error: "This sign-in link is not valid. Please open CredenceHR again from the app you came from." });
    }
    try {
      const hash = sha256(token);
      // Used up in one step: of two tries at once, only one can succeed.
      const upd: any = await queryDB("UPDATE sso_login_requests SET used_at = NOW() WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()", [hash]);
      const rows: any[] = (await queryDB("SELECT id, client_id, user_id, used_at, expires_at FROM sso_login_requests WHERE token_hash = ? LIMIT 1", [hash])) || [];
      const row = rows[0];
      if (!row || Number(upd?.affectedRows ?? 0) !== 1) {
        void loginLog(row ? Number(row.id) : null, row ? Number(row.client_id) : null, row ? Number(row.user_id) : null, ip, platform, false, row ? "link used or expired" : "unknown token");
        return res.status(401).json({ error: "This sign-in link has expired or was already used. Please open CredenceHR again from the app you came from.", code: "SSO_LINK_EXPIRED" });
      }
      const users: any[] = (await queryDB("/*unscoped*/ SELECT * FROM users WHERE id = ?", [Number(row.user_id)])) || [];
      const user = users[0];
      if (!user) {
        void loginLog(Number(row.id), Number(row.client_id), Number(row.user_id), ip, platform, false, "account gone");
        return res.status(401).json({ error: "This account no longer exists." });
      }
      // The sign-in is for this account's own workspace — whatever the page sent.
      const g: any[] = (await queryDB("/*unscoped*/ SELECT workspace_code FROM company_groups WHERE id = ?", [Number(user.group_id ?? 1)]).catch(() => [])) || [];
      req.body = { ...(req.body || {}), workspace: g[0]?.workspace_code || undefined };
      delete req.body.system;
      delete req.body.token;
      // finishLogin answers itself (sign-in or the reason it is refused).
      const status = { code: 200 };
      const origStatus = res.status.bind(res);
      res.status = (c: number) => {
        status.code = c;
        return origStatus(c);
      };
      const app: any[] = (await queryDB("SELECT name FROM api_clients WHERE id = ?", [Number(row.client_id)]).catch(() => [])) || [];
      await finishLogin(deps, req, res, user, { via: "sso", sso_app: app[0]?.name || null });
      void loginLog(Number(row.id), Number(row.client_id), Number(user.id), ip, platform, status.code < 400, status.code < 400 ? "signed in" : `refused (${status.code})`);
    } catch (err: any) {
      console.error("Partner sign-in consume failed:", err?.message);
      void loginLog(null, null, null, ip, platform, false, "unexpected error");
      if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Please sign in with your password." });
    }
  });

  // ---- Superadmin: credentials and logs -----------------------------------------------
  const clientView = (c: any) => ({
    id: Number(c.id),
    name: c.name,
    app_id: c.app_id,
    is_active: Number(c.is_active) === 1,
    allowed_ips: c.allowed_ips || "",
    rate_per_minute: Number(c.rate_per_minute),
    token_ttl_seconds: Number(c.token_ttl_seconds),
    secret_rotated_at: c.secret_rotated_at,
    last_used_at: c.last_used_at,
    created_at: c.created_at
  });

  app.get("/api/system/sso-clients", authenticateToken, requireSuperAdmin, async (_req: any, res) => {
    try {
      const clients: any[] = (await queryDB("SELECT * FROM api_clients ORDER BY id")) || [];
      const logins: any[] =
        (await queryDB(
          `/*unscoped*/ SELECT l.id, l.client_id, c.name AS app_name, l.success, l.reason, l.ip, l.platform, l.created_at, u.name AS user_name
             FROM sso_login_logs l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN api_clients c ON c.id = l.client_id
            ORDER BY l.id DESC LIMIT 100`
        )) || [];
      const calls: any[] =
        (await queryDB(
          "SELECT l.id, l.client_id, c.name AS app_name, l.app_id, l.ip, l.status, l.message, l.created_at FROM api_access_logs l LEFT JOIN api_clients c ON c.id = l.client_id ORDER BY l.id DESC LIMIT 100"
        )) || [];
      res.json({
        clients: clients.map(clientView),
        logins,
        calls,
        initiate_url: `${publicBase(_req)}/api/v1/service/sso/initiate`
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // New credentials: the secret is shown in this answer only.
  app.post("/api/system/sso-clients", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const name = String(req.body?.name || "").trim().slice(0, 100);
      if (!name) return res.status(400).json({ error: "Give the application a name (e.g. 360 ERP)." });
      const appId = newAppId(name);
      const secret = newSecret();
      await queryDB("INSERT INTO api_clients (name, app_id, secret_hash, created_by, secret_rotated_at) VALUES (?, ?, ?, ?, NOW())", [name, appId, sha256(secret), req.user.id]);
      res.json({ app_id: appId, secret });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/system/sso-clients/:id/rotate", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const secret = newSecret();
      const r: any = await queryDB("UPDATE api_clients SET secret_hash = ?, secret_rotated_at = NOW() WHERE id = ?", [sha256(secret), Number(req.params.id)]);
      if (Number(r?.affectedRows ?? 1) !== 1) return res.status(404).json({ error: "Not found." });
      const rows: any[] = (await queryDB("SELECT app_id FROM api_clients WHERE id = ?", [Number(req.params.id)])) || [];
      res.json({ app_id: rows[0]?.app_id, secret });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/system/sso-clients/:id", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const b = req.body || {};
      const ips = String(b.allowed_ips ?? "")
        .split(/[\s,]+/)
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (ips.some((s: string) => !/^[0-9a-fA-F:.]+$/.test(s))) return res.status(400).json({ error: "Allowed IPs: IP addresses only, separated by commas." });
      const rate = Math.min(1000, Math.max(1, Math.round(Number(b.rate_per_minute) || DEFAULT_RATE_PER_MINUTE)));
      const ttl = Math.min(600, Math.max(30, Math.round(Number(b.token_ttl_seconds) || DEFAULT_TTL_SECONDS)));
      const name = String(b.name ?? "").trim().slice(0, 100);
      if (!name) return res.status(400).json({ error: "The application needs a name." });
      await queryDB("UPDATE api_clients SET name = ?, is_active = ?, allowed_ips = ?, rate_per_minute = ?, token_ttl_seconds = ? WHERE id = ?", [
        name,
        b.is_active ? 1 : 0,
        ips.join(", ") || null,
        rate,
        ttl,
        id
      ]);
      const rows: any[] = (await queryDB("SELECT * FROM api_clients WHERE id = ?", [id])) || [];
      if (!rows[0]) return res.status(404).json({ error: "Not found." });
      res.json({ client: clientView(rows[0]) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Remove an application: its App ID stops working at once and any link it
  // made that isn't used yet is dropped. Its log rows stay (with its id).
  app.delete("/api/system/sso-clients/:id", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const r: any = await queryDB("DELETE FROM api_clients WHERE id = ?", [id]);
      if (Number(r?.affectedRows ?? 1) !== 1) return res.status(404).json({ error: "Not found." });
      await queryDB("DELETE FROM sso_login_requests WHERE client_id = ? AND used_at IS NULL", [id]).catch(() => undefined);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
