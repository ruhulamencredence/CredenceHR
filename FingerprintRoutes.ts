/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Sign in with a fingerprint (or face) instead of typing the password.
//
// Who: accounts with users.can_use_fingerprint (Module Access -> "Fingerprint
// login", OFF by default); a Superadmin always. Each person turns it on for
// their own phone / computer from Profile, after signing in with the password.
//
//   - The app (Android / iOS): turning it on gives this phone a long random
//     secret. The phone keeps it in its hardware-protected store (Keystore /
//     Keychain) that only opens after the fingerprint; the server keeps only
//     its SHA-256. Signing in = fingerprint -> secret -> POST .../app/login.
//   - The website: a passkey (WebAuthn) on the computer / phone browser —
//     fingerprint, Windows Hello, Touch ID. The server keeps the public key.
//
// Either way the sign-in then goes through finishLogin (AuthRoutes.ts): the
// same workspace / block / onboarding / one-phone / location rules as the
// password. It stops working when the switch is turned off, the device is
// removed, or the password changes (pw_mark: a fingerprint of the password
// hash at turn-on time), and wrong tries count towards the sign-in lock
// (LoginGuard.ts) like wrong passwords.

import crypto from "crypto";
import type { Express } from "express";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from "@simplewebauthn/server";
import { finishLogin, type RegisterAuthRoutesDeps } from "./AuthRoutes";
import { loginBlocked, recordLogin } from "./LoginGuard";
import { clientIp } from "./ActiveUsersRoutes";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export async function ensureFingerprintSchema(dbPool: any): Promise<void> {
  const run = async (sql: string) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      if (!/Duplicate column/i.test(err.message)) console.warn("⚠️ fingerprint schema: " + err.message);
    }
  };
  await run(`
    CREATE TABLE IF NOT EXISTS fingerprint_logins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      kind VARCHAR(10) NOT NULL,
      device_id VARCHAR(128) NULL,
      label VARCHAR(200) NULL,
      secret_hash CHAR(64) NULL,
      credential_id VARCHAR(512) NULL,
      public_key TEXT NULL,
      counter BIGINT NOT NULL DEFAULT 0,
      transports VARCHAR(200) NULL,
      pw_mark CHAR(16) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME NULL,
      KEY idx_fingerprint_user (user_id),
      KEY idx_fingerprint_device (device_id),
      KEY idx_fingerprint_cred (credential_id(190))
    )
  `);
  await run("ALTER TABLE users ADD COLUMN can_use_fingerprint TINYINT(1) NOT NULL DEFAULT 0");
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const pwMark = (user: any) => sha256(String(user.password_hash || "")).slice(0, 16);
const allowed = (u: any) => u?.role === "superadmin" || !!Number(u?.can_use_fingerprint || 0);
const clean = (v: any, max: number) => String(v ?? "").trim().slice(0, max);

// Passkey challenges live a few minutes in memory (one server process).
const challenges = new Map<string, { challenge: string; userId?: number; expires: number }>();
const keepChallenge = (key: string, challenge: string, userId?: number) => {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
  challenges.set(key, { challenge, userId, expires: now + 5 * 60_000 });
};
const takeChallenge = (key: string) => {
  const c = challenges.get(key);
  challenges.delete(key);
  return c && c.expires > Date.now() ? c : null;
};

// The website's own address: the passkey belongs to it (rpID), and only a
// page from it may use one (origin).
function site(req: any): { rpID: string; origin: string } | null {
  const origin = String(req.headers.origin || "");
  try {
    const u = new URL(origin);
    if (u.hostname !== req.hostname) return null;
    return { rpID: u.hostname, origin: u.origin };
  } catch {
    return null;
  }
}

export function registerFingerprintRoutes(app: Express, deps: RegisterAuthRoutesDeps & { authenticateToken: any }) {
  const { authenticateToken } = deps;
  const queryDB: QueryDB = deps.queryDB;
  const me = async (req: any) => ((await queryDB("SELECT * FROM users WHERE id = ?", [req.user.id])) || [])[0];

  // This account's fingerprint sign-ins (and whether it may add one).
  app.get("/api/auth/fingerprint", authenticateToken, async (req: any, res) => {
    try {
      const user = await me(req);
      if (!user) return res.status(404).json({ error: "User not found" });
      const rows: any[] = allowed(user)
        ? (await queryDB("SELECT id, kind, device_id, label, created_at, last_used_at FROM fingerprint_logins WHERE user_id = ? ORDER BY id DESC", [user.id])) || []
        : [];
      res.json({ allowed: allowed(user), devices: rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // App: turn on for this phone. Returns the secret once; the phone stores it
  // behind its fingerprint.
  app.post("/api/auth/fingerprint/app", authenticateToken, async (req: any, res) => {
    try {
      const user = await me(req);
      if (!allowed(user)) return res.status(403).json({ error: "Fingerprint login isn't turned on for your account. Ask HR / Superadmin." });
      if (req.user.cl !== "app") return res.status(400).json({ error: "Open the CredenceHR app on your phone to turn this on." });
      const deviceId = clean(req.body?.device_id, 128);
      if (!deviceId) return res.status(400).json({ error: "Please update the CredenceHR app." });
      const secret = crypto.randomBytes(32).toString("base64url");
      // One per phone: turning it on again replaces the old one.
      await queryDB("DELETE FROM fingerprint_logins WHERE user_id = ? AND kind = 'app' AND device_id = ?", [user.id, deviceId]);
      await queryDB("INSERT INTO fingerprint_logins (user_id, kind, device_id, label, secret_hash, pw_mark) VALUES (?, 'app', ?, ?, ?, ?)", [
        user.id,
        deviceId,
        clean(req.body?.device_name, 200) || "Phone",
        sha256(secret),
        pwMark(user)
      ]);
      res.json({ secret });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Website: passkey options, then the browser's answer.
  app.post("/api/auth/fingerprint/passkey/options", authenticateToken, async (req: any, res) => {
    try {
      const user = await me(req);
      if (!allowed(user)) return res.status(403).json({ error: "Fingerprint login isn't turned on for your account. Ask HR / Superadmin." });
      const s = site(req);
      if (!s) return res.status(400).json({ error: "Open the CredenceHR website directly to turn this on." });
      const existing: any[] = (await queryDB("SELECT credential_id, transports FROM fingerprint_logins WHERE user_id = ? AND kind = 'passkey'", [user.id])) || [];
      const options = await generateRegistrationOptions({
        rpName: "CredenceHR",
        rpID: s.rpID,
        userName: String(user.email || user.username || `user${user.id}`),
        userDisplayName: String(user.name || user.email || ""),
        userID: new TextEncoder().encode(`credencehr-user-${user.id}`),
        attestationType: "none",
        excludeCredentials: existing.map((r) => ({ id: r.credential_id, transports: r.transports ? String(r.transports).split(",") : undefined })) as any,
        authenticatorSelection: { residentKey: "required", userVerification: "required", authenticatorAttachment: "platform" }
      });
      keepChallenge(`reg:${user.id}`, options.challenge, user.id);
      res.json(options);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/auth/fingerprint/passkey", authenticateToken, async (req: any, res) => {
    try {
      const user = await me(req);
      if (!allowed(user)) return res.status(403).json({ error: "Fingerprint login isn't turned on for your account. Ask HR / Superadmin." });
      const s = site(req);
      const ch = takeChallenge(`reg:${user.id}`);
      if (!s || !ch) return res.status(400).json({ error: "This took too long — please try again." });
      const v = await verifyRegistrationResponse({
        response: req.body?.response,
        expectedChallenge: ch.challenge,
        expectedOrigin: s.origin,
        expectedRPID: s.rpID,
        requireUserVerification: true
      }).catch(() => null);
      if (!v?.verified || !v.registrationInfo) return res.status(400).json({ error: "The fingerprint couldn't be saved. Please try again." });
      const cred = v.registrationInfo.credential;
      await queryDB(
        "INSERT INTO fingerprint_logins (user_id, kind, label, credential_id, public_key, counter, transports, pw_mark) VALUES (?, 'passkey', ?, ?, ?, ?, ?, ?)",
        [user.id, clean(req.body?.label, 200) || "This browser", cred.id, Buffer.from(cred.publicKey).toString("base64"), cred.counter || 0, (cred.transports || []).join(","), pwMark(user)]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/auth/fingerprint/:id", authenticateToken, async (req: any, res) => {
    try {
      await queryDB("DELETE FROM fingerprint_logins WHERE id = ? AND user_id = ?", [Number(req.params.id), req.user.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Signing in (no token yet) ----
  const NOT_SET = "Fingerprint sign-in isn't set up on this device any more. Sign in with your password and turn it on again from Profile.";
  // The account behind a saved fingerprint, if it may still use it.
  const checkRow = async (req: any, res: any, row: any, ident: string): Promise<any | null> => {
    const ip = clientIp(req);
    const user = row ? ((await queryDB("/*unscoped*/ SELECT * FROM users WHERE id = ?", [row.user_id])) || [])[0] : null;
    if (!row || !user) {
      await recordLogin(queryDB, ip, ident, null, false);
      res.status(400).json({ error: NOT_SET, code: "FINGERPRINT_NOT_SET" });
      return null;
    }
    const blocked = await loginBlocked(queryDB, ip, ident, Number(user.id));
    if (blocked) {
      res.status(429).json({ error: blocked, code: "LOGIN_LOCKED" });
      return null;
    }
    if (!allowed(user) || row.pw_mark !== pwMark(user)) {
      // Switched off, or the password changed since: this one is gone.
      await queryDB("/*unscoped*/ DELETE FROM fingerprint_logins WHERE id = ?", [row.id]);
      res.status(400).json({ error: allowed(user) ? `Your password was changed. ${NOT_SET}` : "Fingerprint login has been turned off for your account. Sign in with your password.", code: "FINGERPRINT_NOT_SET" });
      return null;
    }
    return user;
  };

  // App: the secret the phone released after the fingerprint.
  app.post("/api/auth/fingerprint/app/login", async (req: any, res) => {
    try {
      const deviceId = clean(req.body?.device_id, 128);
      const secret = String(req.body?.secret || "");
      const ident = `fingerprint:${deviceId}`;
      const ip = clientIp(req);
      const ipBlocked = await loginBlocked(queryDB, ip, ident, null);
      if (ipBlocked) return res.status(429).json({ error: ipBlocked, code: "LOGIN_LOCKED" });
      const rows: any[] = deviceId && secret
        ? (await queryDB("/*unscoped*/ SELECT * FROM fingerprint_logins WHERE kind = 'app' AND device_id = ?", [deviceId])) || []
        : [];
      const hash = Buffer.from(sha256(secret));
      const row = rows.find((r) => r.secret_hash && crypto.timingSafeEqual(Buffer.from(String(r.secret_hash)), hash));
      const user = await checkRow(req, res, row, ident);
      if (!user) return;
      if (req.body?.platform !== "app") return res.status(400).json({ error: "Please update the CredenceHR app." });
      await recordLogin(queryDB, ip, ident, Number(user.id), true);
      await queryDB("/*unscoped*/ UPDATE fingerprint_logins SET last_used_at = NOW() WHERE id = ?", [row.id]);
      await finishLogin(deps, req, res, user);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Login failed" });
    }
  });

  // Website: a passkey question, then the browser's signed answer.
  app.post("/api/auth/fingerprint/passkey/login-options", async (req: any, res) => {
    try {
      const s = site(req);
      if (!s) return res.status(400).json({ error: "Open the CredenceHR website directly to use fingerprint sign-in." });
      const options = await generateAuthenticationOptions({ rpID: s.rpID, userVerification: "required" });
      const key = crypto.randomBytes(16).toString("hex");
      keepChallenge(`auth:${key}`, options.challenge);
      res.json({ ...options, key });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post("/api/auth/fingerprint/passkey/login", async (req: any, res) => {
    try {
      const s = site(req);
      const ch = takeChallenge(`auth:${clean(req.body?.key, 64)}`);
      if (!s || !ch) return res.status(400).json({ error: "This took too long — please try again." });
      const response = req.body?.response;
      const credId = clean(response?.id, 512);
      const ident = `fingerprint:${credId.slice(0, 60)}`;
      const ip = clientIp(req);
      const ipBlocked = await loginBlocked(queryDB, ip, ident, null);
      if (ipBlocked) return res.status(429).json({ error: ipBlocked, code: "LOGIN_LOCKED" });
      const row = credId ? ((await queryDB("/*unscoped*/ SELECT * FROM fingerprint_logins WHERE kind = 'passkey' AND credential_id = ?", [credId])) || [])[0] : null;
      const user = await checkRow(req, res, row, ident);
      if (!user) return;
      const v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: s.origin,
        expectedRPID: s.rpID,
        requireUserVerification: true,
        credential: {
          id: row.credential_id,
          publicKey: new Uint8Array(Buffer.from(String(row.public_key), "base64")),
          counter: Number(row.counter || 0),
          transports: row.transports ? String(row.transports).split(",") : undefined
        } as any
      }).catch(() => null);
      if (!v?.verified) {
        await recordLogin(queryDB, ip, ident, Number(user.id), false);
        return res.status(400).json({ error: "The fingerprint didn't match. Try again or sign in with your password." });
      }
      await recordLogin(queryDB, ip, ident, Number(user.id), true);
      await queryDB("/*unscoped*/ UPDATE fingerprint_logins SET counter = ?, last_used_at = NOW() WHERE id = ?", [v.authenticationInfo.newCounter, row.id]);
      // The website never sends app-only fields.
      req.body = { workspace: req.body?.workspace, system: req.body?.system };
      await finishLogin(deps, req, res, user);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Login failed" });
    }
  });
}
