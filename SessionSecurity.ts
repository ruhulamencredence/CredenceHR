/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// How long a sign-in stays valid (Admin Panel -> Active Users -> Session
// security, Superadmin only).
//
//   web_hours          a website sign-in ends this many hours after it began
//   web_idle_minutes   ...or after this many minutes without anyone using
//                      the page (the page itself watches mouse / keyboard /
//                      touch; the server ends a sign-in nobody has called
//                      with for that long). 0 = off.
//   app_days           an app sign-in ends this many days after it began
//   app_idle_days      ...or after this many days without the app being
//                      opened. 0 = off.
//
// A sign-in can also be ended early: Logout ends that one sign-in, a
// Superadmin can sign out any sign-in from Active Users, a changed password
// ends the account's other sign-ins and a password reset by an Admin ends all
// of them. The token stays a JWT; what was ended is kept on its user_sessions
// row (ActiveUsersRoutes.ts — keyed by a hash of the token, never the token)
// and users.sessions_valid_after.

import type { Express } from "express";
import crypto from "crypto";
import { DEFAULT_GROUP_ID, activeGroupId } from "./companyContext";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export interface SessionPolicy {
  web_hours: number;
  web_idle_minutes: number;
  app_days: number;
  app_idle_days: number;
}
export const DEFAULT_SESSION_POLICY: SessionPolicy = { web_hours: 12, web_idle_minutes: 60, app_days: 7, app_idle_days: 3 };
const LIMITS: Record<keyof SessionPolicy, [number, number]> = {
  web_hours: [1, 168],
  web_idle_minutes: [0, 1440],
  // user_sessions rows are cleared after 30 days without use, so an app
  // sign-in can't outlive what is remembered about it.
  app_days: [1, 30],
  app_idle_days: [0, 30]
};

export type SessionEnd = "expired" | "idle" | "signed_out" | "password";
const END_MESSAGES: Record<SessionEnd, string> = {
  expired: "Your session has expired. Sign in again.",
  idle: "You were signed out because the session wasn't used for a while. Sign in again.",
  signed_out: "This sign-in was ended. Sign in again.",
  password: "The password of this account was changed. Sign in again with the new password."
};
export const sessionEndMessage = (end: SessionEnd) => END_MESSAGES[end];

export const sessionKeyOf = (token: string) => crypto.createHash("sha1").update(token).digest("hex");

// The app sends platform "app" at sign-in and the token carries cl: "app";
// older tokens are told apart the way Active Users does it.
export const isAppSession = (user: any, req?: any) =>
  user?.cl === "app" || (!user?.cl && (!!user?.dev || /;\s*wv\)/.test(String(req?.headers?.["user-agent"] || ""))));

export async function ensureSessionSecuritySchema(queryDB: QueryDB) {
  await queryDB(`CREATE TABLE IF NOT EXISTS session_policy (
    id INT PRIMARY KEY,
    web_hours INT NOT NULL DEFAULT ${DEFAULT_SESSION_POLICY.web_hours},
    web_idle_minutes INT NOT NULL DEFAULT ${DEFAULT_SESSION_POLICY.web_idle_minutes},
    app_days INT NOT NULL DEFAULT ${DEFAULT_SESSION_POLICY.app_days},
    app_idle_days INT NOT NULL DEFAULT ${DEFAULT_SESSION_POLICY.app_idle_days},
    updated_by INT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  for (const [table, col, ddl] of [
    ["user_sessions", "revoked_at", "DATETIME NULL"],
    ["user_sessions", "revoked_reason", "VARCHAR(20) NULL"],
    ["users", "sessions_valid_after", "DATETIME(3) NULL"]
  ]) {
    try {
      await queryDB(`/*unscoped*/ ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    } catch (err: any) {
      if (err?.code !== "ER_DUP_FIELDNAME") console.warn(`⚠️ Could not add ${table}.${col}: ${err?.message}`);
    }
  }
}

let policyCache: { at: number; policy: SessionPolicy } | null = null;
export async function loadSessionPolicy(queryDB: QueryDB): Promise<SessionPolicy> {
  if (policyCache && Date.now() - policyCache.at < 60_000) return policyCache.policy;
  const rows: any[] = (await queryDB("/*unscoped*/ SELECT * FROM session_policy WHERE id = 1").catch(() => null)) || [];
  const r = rows[0];
  const policy: SessionPolicy = r
    ? {
        web_hours: Number(r.web_hours),
        web_idle_minutes: Number(r.web_idle_minutes),
        app_days: Number(r.app_days),
        app_idle_days: Number(r.app_idle_days)
      }
    : { ...DEFAULT_SESSION_POLICY };
  policyCache = { at: Date.now(), policy };
  return policy;
}

/** jwt.sign expiresIn, in seconds, for a new sign-in. */
export async function sessionLifetimeSeconds(queryDB: QueryDB, app: boolean): Promise<number> {
  const p = await loadSessionPolicy(queryDB);
  return app ? p.app_days * 86400 : p.web_hours * 3600;
}

// session key -> what is known about that sign-in, so most requests never
// read the database. lastSeen is kept here; touchSession (ActiveUsersRoutes)
// writes it to user_sessions once a minute.
const sessions = new Map<string, { userId: number; lastSeen: number; ended: SessionEnd | null }>();
// user id -> users.sessions_valid_after (ms, 0 = none), re-read every 30 s.
const validAfter = new Map<number, { at: number; value: number }>();

async function validAfterOf(queryDB: QueryDB, userId: number): Promise<number> {
  const hit = validAfter.get(userId);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const rows: any[] | null = await queryDB("/*unscoped*/ SELECT sessions_valid_after FROM users WHERE id = ?", [userId]).catch(() => null);
  if (!rows) return hit?.value || 0;
  const v = rows[0]?.sessions_valid_after ? new Date(rows[0].sessions_valid_after).getTime() : 0;
  validAfter.set(userId, { at: Date.now(), value: Number.isFinite(v) ? v : 0 });
  return validAfter.get(userId)!.value;
}

/**
 * Called for every signed-in request (and chat connection) once the JWT
 * checks out. Returns why the sign-in has ended, or null while it's good.
 * A database hiccup never signs anyone out.
 */
export async function checkSession(queryDB: QueryDB, token: string, user: any, req?: any): Promise<SessionEnd | null> {
  const userId = Number(user?.id);
  if (!userId) return null;
  const now = Date.now();
  // iat_ms (set at sign-in) is exact; older tokens only have whole seconds.
  const issued = Number(user?.iat_ms) || Number(user?.iat) * 1000 || now;
  const app = isAppSession(user, req);
  const policy = await loadSessionPolicy(queryDB);

  // A shorter lifetime set after this sign-in began applies to it too.
  const maxMs = app ? policy.app_days * 86400000 : policy.web_hours * 3600000;
  if (now - issued > maxMs) return "expired";

  const after = await validAfterOf(queryDB, userId);
  if (after && issued < after) return "password";

  const key = sessionKeyOf(token);
  let s = sessions.get(key);
  if (!s) {
    const rows: any[] | null = await queryDB("/*unscoped*/ SELECT revoked_at, revoked_reason, last_seen_at FROM user_sessions WHERE session_key = ?", [key]).catch(
      () => null
    );
    const row = rows?.[0];
    const seen = row?.last_seen_at ? new Date(row.last_seen_at).getTime() : NaN;
    s = {
      userId,
      // Never used yet: counted from when it was signed in. (Unknown because
      // the database didn't answer: from now.)
      lastSeen: Number.isFinite(seen) ? seen : rows ? issued : now,
      ended: row?.revoked_at ? ((["idle", "signed_out", "password", "expired"].includes(row.revoked_reason) ? row.revoked_reason : "signed_out") as SessionEnd) : null
    };
    sessions.set(key, s);
    if (sessions.size > 50000) {
      for (const [k, v] of sessions) if (now - v.lastSeen > 31 * 86400000) sessions.delete(k);
    }
  }
  if (s.ended) return s.ended;

  const idleMs = app ? policy.app_idle_days * 86400000 : policy.web_idle_minutes * 60000;
  if (idleMs > 0 && now - s.lastSeen > idleMs) {
    await endSession(queryDB, key, userId, "idle");
    return "idle";
  }
  s.lastSeen = now;
  return null;
}

/** Ends one sign-in. */
export async function endSession(queryDB: QueryDB, key: string, userId: number, why: SessionEnd) {
  const s = sessions.get(key);
  if (s) s.ended = why;
  else sessions.set(key, { userId, lastSeen: Date.now(), ended: why });
  const at = new Date();
  await queryDB(
    `/*unscoped*/ INSERT INTO user_sessions (session_key, user_id, revoked_at, revoked_reason, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE revoked_at = COALESCE(revoked_at, VALUES(revoked_at)), revoked_reason = COALESCE(revoked_reason, VALUES(revoked_reason))`,
    [key, userId, at, why, at, at]
  ).catch(() => {});
}

/**
 * Ends every sign-in of an account. With keepKey (the account holder changed
 * their own password) the sign-in they did it from stays.
 */
export async function endAllSessions(queryDB: QueryDB, userId: number, why: SessionEnd, keepKey?: string) {
  for (const [k, s] of sessions) if (s.userId === userId && k !== keepKey && !s.ended) s.ended = why;
  if (keepKey) {
    await queryDB(
      "/*unscoped*/ UPDATE user_sessions SET revoked_at = NOW(), revoked_reason = ? WHERE user_id = ? AND session_key <> ? AND revoked_at IS NULL",
      [why, userId, keepKey]
    ).catch(() => {});
  } else {
    await queryDB("/*unscoped*/ UPDATE users SET sessions_valid_after = ? WHERE id = ?", [new Date(), userId]).catch(() => {});
    validAfter.delete(userId);
    await queryDB("/*unscoped*/ UPDATE user_sessions SET revoked_at = NOW(), revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL", [why, userId]).catch(
      () => {}
    );
  }
}

interface SessionSecurityDeps {
  authenticateToken: any;
  requireSuperAdmin: any;
  queryDB: QueryDB;
}

export function registerSessionSecurityRoutes(app: Express, deps: SessionSecurityDeps) {
  const { authenticateToken, requireSuperAdmin, queryDB } = deps;
  const bearer = (req: any) => String(req.headers["authorization"] || "").split(" ")[1] || "";

  // Logout: this sign-in can't be used again, even by someone holding a copy.
  app.post("/api/auth/logout", authenticateToken, async (req: any, res) => {
    await endSession(queryDB, sessionKeyOf(bearer(req)), Number(req.user.id), "signed_out");
    res.json({ success: true });
  });

  // What the page needs to sign itself out when left unused. The policy
  // itself only for the Superadmin.
  app.get("/api/session-policy", authenticateToken, async (req: any, res) => {
    const policy = await loadSessionPolicy(queryDB);
    const app = isAppSession(req.user, req);
    res.json({
      client: app ? "app" : "web",
      // The app is watched by the server alone (it runs in the background for tracking).
      idle_minutes: app ? 0 : policy.web_idle_minutes,
      ...(req.user.role === "superadmin" ? { policy, defaults: DEFAULT_SESSION_POLICY, limits: LIMITS } : {})
    });
  });

  app.put("/api/session-policy", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const next: any = {};
      for (const k of Object.keys(LIMITS) as (keyof SessionPolicy)[]) {
        const n = Number(req.body?.[k]);
        const [lo, hi] = LIMITS[k];
        if (!Number.isInteger(n) || n < lo || n > hi) return res.status(400).json({ error: `${k.replace(/_/g, " ")} must be a whole number from ${lo} to ${hi}.` });
        next[k] = n;
      }
      await queryDB(
        `/*unscoped*/ INSERT INTO session_policy (id, web_hours, web_idle_minutes, app_days, app_idle_days, updated_by) VALUES (1, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE web_hours = VALUES(web_hours), web_idle_minutes = VALUES(web_idle_minutes), app_days = VALUES(app_days),
           app_idle_days = VALUES(app_idle_days), updated_by = VALUES(updated_by)`,
        [next.web_hours, next.web_idle_minutes, next.app_days, next.app_idle_days, Number(req.user.id)]
      );
      policyCache = null;
      res.json({ success: true, policy: await loadSessionPolicy(queryDB) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Active Users -> Sign out: ends one sign-in of an account in this workspace.
  app.post("/api/active-users/:id/sign-out", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const rows: any[] = (await queryDB("/*unscoped*/ SELECT id, session_key, user_id FROM user_sessions WHERE id = ?", [Number(req.params.id)])) || [];
      const row = rows[0];
      if (!row) return res.status(404).json({ error: "That sign-in isn't there any more." });
      const owner: any[] = (await queryDB("/*unscoped*/ SELECT group_id FROM users WHERE id = ?", [Number(row.user_id)])) || [];
      if (!owner.length || Number(owner[0].group_id ?? DEFAULT_GROUP_ID) !== activeGroupId())
        return res.status(404).json({ error: "That sign-in isn't there any more." });
      if (row.session_key === sessionKeyOf(bearer(req))) return res.status(400).json({ error: "This is your own sign-in — use Logout instead." });
      await endSession(queryDB, String(row.session_key), Number(row.user_id), "signed_out");
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
}
