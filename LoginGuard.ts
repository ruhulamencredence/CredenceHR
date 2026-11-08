/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Stops guessing passwords at the sign-in page (POST /api/auth/login).
//
//   - One account: after 5 wrong passwords within 15 minutes it is locked
//     for 15 minutes — even the right password is refused until then.
//   - One IP address: after 30 wrong sign-ins (any accounts) within 15
//     minutes that address waits 15 minutes. Higher than the per-account
//     limit because a whole office can share one address.
//   - Counting starts again after a successful sign-in, and a password
//     reset (Forgot password, or an admin resetting it) lifts the lock.
//
// Trusted devices (OWASP "device cookie"): after a successful password
// sign-in the phone / browser gets a signed token for that account
// (trustedDeviceToken). Sent back on the next sign-in, it lets that device
// skip the two locks above — so someone typing wrong passwords for your ID
// from elsewhere, or a whole office sharing one address, can't keep you
// out — but the device has its own limit: 10 wrong passwords in 15 minutes
// lock that device for 15 minutes. Wrong tries from a trusted device don't
// count toward the account or address locks. The token is bound to the
// account, expires after 180 days unused, and stops working when the
// account's sessions are ended (password changed or reset, signed out
// everywhere — users.sessions_valid_after).
//
// Every attempt is kept in login_attempts (also an audit trail of failed
// sign-ins); rows older than 30 days are cleared now and then.

import crypto from "crypto";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

const WINDOW_MIN = 15;
const ACCOUNT_MAX = 5;
const IP_MAX = 30;
const DEVICE_MAX = 10;
const DEVICE_DAYS = 180;

// Whether login_attempts has the device column. Until it does (an older
// database the ALTER failed on) everything works exactly as before, with no
// trusted devices.
let deviceColumn = false;

export async function ensureLoginGuardSchema(dbPool: any): Promise<void> {
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ip VARCHAR(64) NOT NULL,
        identifier VARCHAR(190) NOT NULL,
        user_id INT NULL,
        success TINYINT(1) NOT NULL DEFAULT 0,
        device VARCHAR(32) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_login_attempts_ident (identifier, created_at),
        KEY idx_login_attempts_ip (ip, created_at),
        KEY idx_login_attempts_user (user_id, created_at),
        KEY idx_login_attempts_device (user_id, device, created_at)
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ login_attempts: " + err.message);
  }
  try {
    const [cols]: any = await dbPool.query("SHOW COLUMNS FROM login_attempts LIKE 'device'");
    if (!cols?.length) {
      await dbPool.query("ALTER TABLE login_attempts ADD COLUMN device VARCHAR(32) NULL AFTER success");
      await dbPool.query("ALTER TABLE login_attempts ADD KEY idx_login_attempts_device (user_id, device, created_at)").catch(() => {});
    }
    deviceColumn = true;
  } catch (err: any) {
    console.warn("⚠️ login_attempts.device (trusted devices off): " + err.message);
  }
}

const norm = (identifier: string) => String(identifier || "").trim().toLowerCase().slice(0, 190);
const minutesLeft = (oldest: any) => {
  const ms = new Date(oldest).getTime() + WINDOW_MIN * 60 * 1000 - Date.now();
  return Math.max(1, Math.ceil(ms / 60000));
};

// ---- trusted device tokens -------------------------------------------------
// "<userId>.<deviceId>.<issuedMs>.<hmac>" — HMAC-SHA256 with a key derived
// from the JWT secret, so nothing new to configure and it can't be forged.
const sign = (secret: string, payload: string) =>
  crypto.createHmac("sha256", `${secret}:login-device`).update(payload).digest("base64url");

export function trustedDeviceToken(secret: string, userId: number, deviceId?: string | null): string {
  const id = deviceId && /^[a-f0-9]{24}$/.test(deviceId) ? deviceId : crypto.randomBytes(12).toString("hex");
  const payload = `${Number(userId)}.${id}.${Date.now()}`;
  return `${payload}.${sign(secret, payload)}`;
}

// The device id from the first token in `tokens` that is valid for this
// account right now, else null. `user` is the users row (id,
// sessions_valid_after).
export function trustedDeviceFor(secret: string, tokens: unknown, user: any): string | null {
  if (!deviceColumn || !Array.isArray(tokens) || !user) return null;
  const validAfter = user.sessions_valid_after ? new Date(user.sessions_valid_after).getTime() || 0 : 0;
  for (const t of tokens.slice(0, 10)) {
    if (typeof t !== "string" || t.length > 200) continue;
    const parts = t.split(".");
    if (parts.length !== 4) continue;
    const [uid, deviceId, issued, mac] = parts;
    if (Number(uid) !== Number(user.id) || !/^[a-f0-9]{24}$/.test(deviceId)) continue;
    const at = Number(issued);
    if (!Number.isFinite(at) || at > Date.now() + 60_000 || Date.now() - at > DEVICE_DAYS * 24 * 60 * 60 * 1000) continue;
    if (at <= validAfter) continue;
    const want = Buffer.from(sign(secret, `${uid}.${deviceId}.${issued}`));
    const got = Buffer.from(mac);
    if (want.length === got.length && crypto.timingSafeEqual(want, got)) return deviceId;
  }
  return null;
}

// null = may try; otherwise the message to show (HTTP 429). deviceId: a
// trusted device of this account (trustedDeviceFor) — only its own limit
// applies then.
export async function loginBlocked(queryDB: QueryDB, ip: string, identifier: string, userId: number | null, deviceId: string | null = null): Promise<string | null> {
  if (deviceId && userId && deviceColumn) {
    const dev: any[] =
      (await queryDB(
        `/*unscoped*/ SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM login_attempts
          WHERE user_id = ? AND device = ? AND success = 0 AND created_at > NOW() - INTERVAL ${WINDOW_MIN} MINUTE
            AND id > COALESCE((SELECT MAX(id) FROM login_attempts s WHERE s.user_id = ? AND s.success = 1), 0)`,
        [userId, deviceId, userId]
      ).catch(() => [])) || [];
    if (Number(dev[0]?.n || 0) >= DEVICE_MAX) {
      return `Too many wrong passwords on this device. Try again in ${minutesLeft(dev[0].oldest)} minute(s), or use "Forgot password?".`;
    }
    return null;
  }
  const ident = norm(identifier);
  // Only tries from devices that aren't trusted for the account count here.
  const untrusted = deviceColumn ? " AND device IS NULL" : "";
  // The account (by its id when known, else by what was typed): wrong tries
  // since its last successful sign-in, inside the window.
  const who = userId ? "user_id = ?" : "identifier = ?";
  const key = userId ?? ident;
  const acc: any[] =
    (await queryDB(
      `/*unscoped*/ SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM login_attempts
        WHERE ${who} AND success = 0${untrusted} AND created_at > NOW() - INTERVAL ${WINDOW_MIN} MINUTE
          AND id > COALESCE((SELECT MAX(id) FROM login_attempts s WHERE s.${who} AND s.success = 1), 0)`,
      [key, key]
    ).catch(() => [])) || [];
  if (Number(acc[0]?.n || 0) >= ACCOUNT_MAX) {
    return `Too many wrong passwords for this account. Try again in ${minutesLeft(acc[0].oldest)} minute(s), or use "Forgot password?".`;
  }
  const byIp: any[] =
    (await queryDB(
      `/*unscoped*/ SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM login_attempts WHERE ip = ? AND success = 0${untrusted} AND created_at > NOW() - INTERVAL ${WINDOW_MIN} MINUTE`,
      [ip]
    ).catch(() => [])) || [];
  if (Number(byIp[0]?.n || 0) >= IP_MAX) {
    return `Too many wrong sign-ins from this network. Try again in ${minutesLeft(byIp[0].oldest)} minute(s).`;
  }
  return null;
}

let lastSweep = 0;
export async function recordLogin(queryDB: QueryDB, ip: string, identifier: string, userId: number | null, success: boolean, deviceId: string | null = null): Promise<void> {
  if (deviceId && deviceColumn) {
    await queryDB("/*unscoped*/ INSERT INTO login_attempts (ip, identifier, user_id, success, device) VALUES (?, ?, ?, ?, ?)", [ip, norm(identifier), userId, success ? 1 : 0, deviceId]).catch(() => {});
  } else {
    await queryDB("/*unscoped*/ INSERT INTO login_attempts (ip, identifier, user_id, success) VALUES (?, ?, ?, ?)", [ip, norm(identifier), userId, success ? 1 : 0]).catch(() => {});
  }
  if (Date.now() - lastSweep > 6 * 60 * 60 * 1000) {
    lastSweep = Date.now();
    void queryDB("/*unscoped*/ DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL 30 DAY").catch(() => {});
  }
}

// A password reset lifts the lock: it counts as a fresh start.
export async function clearLoginLock(queryDB: QueryDB, userId: number): Promise<void> {
  await queryDB("/*unscoped*/ INSERT INTO login_attempts (ip, identifier, user_id, success) VALUES ('reset', '', ?, 1)", [userId]).catch(() => {});
}
