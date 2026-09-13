/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Personal Alerts — split out of server.ts on purpose, same convention as
// profileRoutes.ts / holidayRoutes.ts: server.ts is already huge, so new
// features go in their own module from here on instead of growing it
// further. Registered from inside startServer() via registerAlertRoutes(),
// reusing that same request's `app`/`authenticateToken`/`queryDB` rather than
// creating a second Express app or a second DB connection.
//
// Purpose: a small, per-user notification inbox (bell icon + list, both on
// the web build and the Capacitor mobile app, since they share the same React
// code). Unlike every AdminModuleKey tab, this is NOT gated behind
// requireModule — every signed-in account gets it by default, no Superadmin
// grant needed. Something elsewhere in the app (right now: a Leave
// Application being Approved/Rejected) calls createAlert() below to drop a
// row in this account's inbox; the account only ever sees its OWN alerts.
//
// `type` is deliberately a plain string (not a DB enum) so more alert types
// can be added later without an ALTER TABLE each time. 'conveyance_claim'
// (Conveyance Bill Claim submitted — the current-step approver is notified,
// same idea as the Leave Application Reliever alert) was the second type
// added, after 'leave_application'.

import type { Express } from "express";

export type AlertType = "leave_application" | "conveyance_claim" | "conveyance_disbursed" | "asset_requisition";

export interface AlertRow {
  id: number;
  user_id: number;
  type: AlertType;
  title: string;
  message: string;
  related_type: string | null;
  related_id: number | null;
  is_read: boolean;
  created_at: string;
}

interface AlertRouteDeps {
  authenticateToken: any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
}

// Self-healing migration — same pattern as every other table in server.ts's
// ensureSchemaMigrations(): CREATE TABLE IF NOT EXISTS means a normal server
// restart is enough to pick this up on an already-running database, no
// manual SQL required.
export async function ensureAlertsSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        type VARCHAR(50) NOT NULL,
        title VARCHAR(200) NOT NULL,
        message TEXT NOT NULL,
        related_type VARCHAR(50) NULL,
        related_id INT NULL,
        is_read TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_alerts_user_unread (user_id, is_read)
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure alerts table exists: " + err.message);
  }
}

// Called from elsewhere in server.ts (e.g. the Leave Application
// approve/reject handler) whenever something worth notifying one account
// about happens. Fails soft — a notification that couldn't be written should
// never take down the action that triggered it (the leave decision itself
// already succeeded by the time this runs).
export async function createAlert(
  queryDB: (sql: string, params?: any[]) => Promise<any>,
  params: {
    userId: number;
    type: AlertType;
    title: string;
    message: string;
    relatedType?: string;
    relatedId?: number;
  }
): Promise<void> {
  try {
    await queryDB(
      "INSERT INTO alerts (user_id, type, title, message, related_type, related_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        params.userId,
        params.type,
        params.title,
        params.message,
        params.relatedType || null,
        params.relatedId ?? null
      ]
    );
  } catch (err: any) {
    console.warn("⚠️ Could not write alert: " + err.message);
  }
}

export function registerAlertRoutes(app: Express, deps: AlertRouteDeps) {
  const { authenticateToken, queryDB } = deps;

  // GET /api/alerts — this account's own inbox, newest first. No module gate:
  // every signed-in account (User/Admin/Superadmin) always has this. Capped
  // at 50 so the bell dropdown stays fast; older read alerts just fall off.
  app.get("/api/alerts", authenticateToken, async (req: any, res) => {
    try {
      const rows: any = await queryDB(
        "SELECT * FROM alerts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
        [req.user.id]
      );
      res.json(rows.map((r: any) => ({ ...r, is_read: !!r.is_read })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/alerts/unread-count — lightweight poll target for the bell's
  // badge, so the whole list doesn't need re-fetching just to check for
  // something new.
  app.get("/api/alerts/unread-count", authenticateToken, async (req: any, res) => {
    try {
      const rows: any = await queryDB(
        "SELECT COUNT(*) AS cnt FROM alerts WHERE user_id = ? AND is_read = 0",
        [req.user.id]
      );
      res.json({ count: Number(rows[0]?.cnt || 0) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/alerts/:id/read — mark one of THIS account's own alerts read
  // (the WHERE user_id guard stops anyone from marking someone else's).
  app.post("/api/alerts/:id/read", authenticateToken, async (req: any, res) => {
    try {
      await queryDB("UPDATE alerts SET is_read = 1 WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/alerts/read-all — the bell dropdown's "Mark all read".
  app.post("/api/alerts/read-all", authenticateToken, async (req: any, res) => {
    try {
      await queryDB("UPDATE alerts SET is_read = 1 WHERE user_id = ? AND is_read = 0", [req.user.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/alerts/:id — clear a single alert out of THIS account's own
  // inbox.
  app.delete("/api/alerts/:id", authenticateToken, async (req: any, res) => {
    try {
      await queryDB("DELETE FROM alerts WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
