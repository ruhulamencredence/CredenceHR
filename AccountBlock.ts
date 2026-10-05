/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Account Block — stops a login account from signing in, and signs out every
// session it already has (authenticateToken checks accountBlocked() on each
// request). Set three ways:
//   - by hand: Admin Panel -> Users -> Block / Unblock, which needs the
//     Users module's "Block Account" layer (an explicit-only layer — see
//     EXPLICIT_ONLY_LAYERS in src/types.ts);
//   - automatically when a Resignation / Termination / Retirement takes
//     effect (HR Operations personnel action, Exit / Offboarding completion);
//   - for a Suspension, when "Block login during suspension" is ticked.
// A Superadmin account can never be blocked. Unblocking is always by hand.

import type { Express } from "express";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export async function ensureAccountBlockSchema(dbPool: any) {
  const columns: [string, string][] = [
    ["is_blocked", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["blocked_reason", "VARCHAR(255) NULL"],
    ["blocked_at", "DATETIME NULL"],
    ["blocked_by", "INT NULL"]
  ];
  for (const [name, def] of columns) {
    try {
      await dbPool.query(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
    } catch (err: any) {
      if (err.code !== "ER_DUP_FIELDNAME") console.warn(`⚠️ Could not add users.${name} column: ` + err.message);
    }
  }
}

// Checked on every authenticated request, so cached briefly; a block made
// through setAccountBlocked() clears the cache entry at once.
const cache = new Map<number, { blocked: boolean; at: number }>();
const TTL_MS = 30_000;

export async function accountBlocked(queryDB: QueryDB, userId: number): Promise<boolean> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.blocked;
  const rows: any[] | null = await queryDB("/*unscoped*/ SELECT is_blocked FROM users WHERE id = ?", [userId]).catch(() => null);
  // A database hiccup never signs anyone out.
  if (!rows) return false;
  const blocked = Number(rows[0]?.is_blocked || 0) === 1;
  cache.set(userId, { blocked, at: Date.now() });
  return blocked;
}

// Returns false when the account is a Superadmin (never blocked) or missing.
export async function setAccountBlocked(
  queryDB: QueryDB,
  userId: number,
  blocked: boolean,
  reason: string | null,
  actorId: number | null
): Promise<boolean> {
  const rows: any[] = await queryDB("/*unscoped*/ SELECT id, role FROM users WHERE id = ?", [userId]);
  if (!rows.length || (blocked && rows[0].role === "superadmin")) return false;
  if (blocked) {
    await queryDB("/*unscoped*/ UPDATE users SET is_blocked = 1, blocked_reason = ?, blocked_at = NOW(), blocked_by = ? WHERE id = ?", [
      reason ? String(reason).slice(0, 255) : null,
      actorId,
      userId
    ]);
  } else {
    await queryDB("/*unscoped*/ UPDATE users SET is_blocked = 0, blocked_reason = NULL, blocked_at = NULL, blocked_by = NULL WHERE id = ?", [userId]);
  }
  cache.delete(userId);
  return true;
}

// Blocks the login linked to an Employee record, if there is one.
export async function blockEmployeeLogin(queryDB: QueryDB, employeeId: number, reason: string, actorId: number | null) {
  const rows: any[] = await queryDB("SELECT user_id FROM all_employees WHERE id = ?", [employeeId]);
  const userId = rows[0]?.user_id ? Number(rows[0].user_id) : null;
  if (userId) await setAccountBlocked(queryDB, userId, true, reason, actorId);
}

interface AccountBlockDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (k: "users") => any;
  requireModuleLayer: (k: "users", layer: "block_account") => any;
  queryDB: QueryDB;
}

export function registerAccountBlockRoutes(app: Express, deps: AccountBlockDeps) {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, queryDB } = deps;

  // Body: { blocked: boolean, reason?: string }
  app.put(
    "/api/users/:id/block",
    authenticateToken,
    requireAdmin,
    requireModule("users"),
    requireModuleLayer("users", "block_account"),
    async (req: any, res) => {
      try {
        const id = Number(req.params.id);
        const blocked = req.body?.blocked === true;
        const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
        if (!id) return res.status(400).json({ error: "A valid user id is required." });
        if (id === Number(req.user.id)) return res.status(400).json({ error: "You can't block your own account." });
        const target: any[] = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
        if (!target.length) return res.status(404).json({ error: "User not found" });
        if (target[0].role === "superadmin") return res.status(400).json({ error: "The Superadmin account can't be blocked." });
        // Same rule as deleting: only the Superadmin may act on an Admin account.
        if (target[0].role === "admin" && req.user.role !== "superadmin") {
          return res.status(403).json({ error: "Only the Superadmin can block or unblock an Admin account." });
        }
        if (blocked && !reason) return res.status(400).json({ error: "Write the reason for blocking this account." });
        await setAccountBlocked(queryDB, id, blocked, blocked ? reason : null, Number(req.user.id));
        res.json({ success: true, is_blocked: blocked });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );
}
