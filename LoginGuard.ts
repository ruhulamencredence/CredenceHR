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
// Every attempt is kept in login_attempts (also an audit trail of failed
// sign-ins); rows older than 30 days are cleared now and then.

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

const WINDOW_MIN = 15;
const ACCOUNT_MAX = 5;
const IP_MAX = 30;

export async function ensureLoginGuardSchema(dbPool: any): Promise<void> {
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ip VARCHAR(64) NOT NULL,
        identifier VARCHAR(190) NOT NULL,
        user_id INT NULL,
        success TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_login_attempts_ident (identifier, created_at),
        KEY idx_login_attempts_ip (ip, created_at),
        KEY idx_login_attempts_user (user_id, created_at)
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ login_attempts: " + err.message);
  }
}

const norm = (identifier: string) => String(identifier || "").trim().toLowerCase().slice(0, 190);
const minutesLeft = (oldest: any) => {
  const ms = new Date(oldest).getTime() + WINDOW_MIN * 60 * 1000 - Date.now();
  return Math.max(1, Math.ceil(ms / 60000));
};

// null = may try; otherwise the message to show (HTTP 429).
export async function loginBlocked(queryDB: QueryDB, ip: string, identifier: string, userId: number | null): Promise<string | null> {
  const ident = norm(identifier);
  // The account (by its id when known, else by what was typed): wrong tries
  // since its last successful sign-in, inside the window.
  const who = userId ? "user_id = ?" : "identifier = ?";
  const key = userId ?? ident;
  const acc: any[] =
    (await queryDB(
      `/*unscoped*/ SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM login_attempts
        WHERE ${who} AND success = 0 AND created_at > NOW() - INTERVAL ${WINDOW_MIN} MINUTE
          AND id > COALESCE((SELECT MAX(id) FROM login_attempts s WHERE s.${who} AND s.success = 1), 0)`,
      [key, key]
    ).catch(() => [])) || [];
  if (Number(acc[0]?.n || 0) >= ACCOUNT_MAX) {
    return `Too many wrong passwords for this account. Try again in ${minutesLeft(acc[0].oldest)} minute(s), or use "Forgot password?".`;
  }
  const byIp: any[] =
    (await queryDB(
      `/*unscoped*/ SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM login_attempts WHERE ip = ? AND success = 0 AND created_at > NOW() - INTERVAL ${WINDOW_MIN} MINUTE`,
      [ip]
    ).catch(() => [])) || [];
  if (Number(byIp[0]?.n || 0) >= IP_MAX) {
    return `Too many wrong sign-ins from this network. Try again in ${minutesLeft(byIp[0].oldest)} minute(s).`;
  }
  return null;
}

let lastSweep = 0;
export async function recordLogin(queryDB: QueryDB, ip: string, identifier: string, userId: number | null, success: boolean): Promise<void> {
  await queryDB("/*unscoped*/ INSERT INTO login_attempts (ip, identifier, user_id, success) VALUES (?, ?, ?, ?)", [ip, norm(identifier), userId, success ? 1 : 0]).catch(() => {});
  if (Date.now() - lastSweep > 6 * 60 * 60 * 1000) {
    lastSweep = Date.now();
    void queryDB("/*unscoped*/ DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL 30 DAY").catch(() => {});
  }
}

// A password reset lifts the lock: it counts as a fresh start.
export async function clearLoginLock(queryDB: QueryDB, userId: number): Promise<void> {
  await queryDB("/*unscoped*/ INSERT INTO login_attempts (ip, identifier, user_id, success) VALUES ('reset', '', ?, 1)", [userId]).catch(() => {});
}
