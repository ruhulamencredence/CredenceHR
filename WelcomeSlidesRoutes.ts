/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Welcome slides (src/components/WelcomeSlides.tsx): four full-screen slides
// shown once to an account — the first time it signs in after this exists —
// on the website and in the app alike, then never again (Skip or Get
// started both count). Kept per account (users.welcome_seen_at), so a
// second phone or computer doesn't show them again.
//
// Admin Panel -> Active Users -> "Welcome slides" (Superadmin only): switch
// them off for everyone, or "Show again to everyone" (after a big update) —
// that sets reset_at, and anyone who saw them before it sees them once more.
//
// Tutorials (src/lib/tutorials.ts — guided tours over the real screens, from
// the last slide's "Show me around" and the Tutorials menu item): which ones
// an account finished (users.tutorials_done, a JSON list), and the same
// card's "Tutorials" switch (welcome_slides_settings.tutorials_enabled).

import type { Express } from "express";

export async function ensureWelcomeSlidesSchema(dbPool: any): Promise<void> {
  const run = async (sql: string) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      if (!/Duplicate column|already exists/i.test(err.message)) console.warn("⚠️ welcome slides schema: " + err.message);
    }
  };
  await run("ALTER TABLE users ADD COLUMN welcome_seen_at DATETIME NULL");
  await run(`
    CREATE TABLE IF NOT EXISTS welcome_slides_settings (
      id INT PRIMARY KEY,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      reset_at DATETIME NULL,
      updated_by INT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
  await run("INSERT IGNORE INTO welcome_slides_settings (id, enabled) VALUES (1, 1)");
  await run("ALTER TABLE users ADD COLUMN tutorials_done TEXT NULL");
  await run("ALTER TABLE welcome_slides_settings ADD COLUMN tutorials_enabled TINYINT(1) NOT NULL DEFAULT 1");
}

interface Deps {
  authenticateToken: any;
  requireSuperAdmin: any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
}

// The tours that exist (src/lib/tutorials.ts TOURS) — nothing else is saved.
const TOUR_IDS = new Set(["dashboard", "checkin", "leave", "timesheet"]);
const parseDone = (v: any): string[] => {
  try {
    const a = JSON.parse(String(v || "[]"));
    return Array.isArray(a) ? a.filter((x) => TOUR_IDS.has(String(x))).map(String) : [];
  } catch {
    return [];
  }
};

export function registerWelcomeSlidesRoutes(app: Express, deps: Deps) {
  const { authenticateToken, requireSuperAdmin, queryDB } = deps;
  const settings = async () => {
    const rows: any[] = (await queryDB("/*unscoped*/ SELECT enabled, reset_at, tutorials_enabled FROM welcome_slides_settings WHERE id = 1").catch(() => [])) || [];
    return {
      enabled: rows[0] ? Number(rows[0].enabled) === 1 : true,
      reset_at: rows[0]?.reset_at || null,
      tutorials_enabled: rows[0] ? Number(rows[0].tutorials_enabled ?? 1) === 1 : true
    };
  };

  // Should this account see the slides now?
  app.get("/api/welcome-slides/status", authenticateToken, async (req: any, res) => {
    try {
      const s = await settings();
      if (!s.enabled) return res.json({ show: false });
      const rows: any[] =
        (await queryDB(
          "/*unscoped*/ SELECT (welcome_seen_at IS NULL OR (? IS NOT NULL AND welcome_seen_at < ?)) AS due, is_onboarding FROM users WHERE id = ?",
          [s.reset_at, s.reset_at, req.user.id]
        ).catch(() => [])) || [];
      // A new joiner's temporary login only ever sees My Onboarding.
      res.json({ show: !!rows[0] && Number(rows[0].due) === 1 && Number(rows[0].is_onboarding || 0) !== 1 });
    } catch {
      res.json({ show: false });
    }
  });

  // Skipped or finished: never again (until a Superadmin shows them again).
  app.post("/api/welcome-slides/seen", authenticateToken, async (req: any, res) => {
    try {
      await queryDB("/*unscoped*/ UPDATE users SET welcome_seen_at = NOW() WHERE id = ?", [req.user.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Tutorials: switched on for this account? which ones did it finish?
  // A new joiner's temporary login (My Onboarding only) gets none.
  const tutorialsFor = async (userId: number) => {
    const s = await settings();
    const rows: any[] = (await queryDB("/*unscoped*/ SELECT tutorials_done, is_onboarding FROM users WHERE id = ?", [userId]).catch(() => [])) || [];
    const enabled = s.tutorials_enabled && !!rows[0] && Number(rows[0].is_onboarding || 0) !== 1;
    return { enabled, done: enabled ? parseDone(rows[0]?.tutorials_done) : [] };
  };
  app.get("/api/tutorials", authenticateToken, async (req: any, res) => {
    try {
      res.json(await tutorialsFor(req.user.id));
    } catch {
      res.json({ enabled: false, done: [] });
    }
  });
  app.post("/api/tutorials/done", authenticateToken, async (req: any, res) => {
    try {
      const id = String(req.body?.id || "");
      if (!TOUR_IDS.has(id)) return res.status(400).json({ error: "Unknown tutorial." });
      const t = await tutorialsFor(req.user.id);
      if (!t.enabled) return res.status(403).json({ error: "Tutorials are switched off." });
      const done = Array.from(new Set([...t.done, id]));
      await queryDB("/*unscoped*/ UPDATE users SET tutorials_done = ? WHERE id = ?", [JSON.stringify(done), req.user.id]);
      res.json({ enabled: true, done });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Superadmin ----
  app.get("/api/system/welcome-slides", authenticateToken, requireSuperAdmin, async (_req: any, res) => {
    try {
      const s = await settings();
      const c: any[] =
        (await queryDB(
          "/*unscoped*/ SELECT COUNT(*) AS total, SUM(welcome_seen_at IS NOT NULL AND (? IS NULL OR welcome_seen_at >= ?)) AS seen FROM users",
          [s.reset_at, s.reset_at]
        ).catch(() => [])) || [];
      res.json({ ...s, accounts: Number(c[0]?.total || 0), seen: Number(c[0]?.seen || 0) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/system/welcome-slides", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      // Only what was sent changes (the slides switch, the tutorials switch).
      const b = req.body || {};
      if (b.enabled !== undefined) await queryDB("/*unscoped*/ UPDATE welcome_slides_settings SET enabled = ?, updated_by = ? WHERE id = 1", [b.enabled ? 1 : 0, req.user.id]);
      if (b.tutorials_enabled !== undefined)
        await queryDB("/*unscoped*/ UPDATE welcome_slides_settings SET tutorials_enabled = ?, updated_by = ? WHERE id = 1", [b.tutorials_enabled ? 1 : 0, req.user.id]);
      res.json(await settings());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/system/welcome-slides/show-again", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      await queryDB("/*unscoped*/ UPDATE welcome_slides_settings SET reset_at = NOW(), updated_by = ? WHERE id = 1", [req.user.id]);
      res.json(await settings());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Every account's tutorials back to "not done" (e.g. after a big update).
  app.post("/api/system/welcome-slides/reset-tutorials", authenticateToken, requireSuperAdmin, async (_req: any, res) => {
    try {
      await queryDB("/*unscoped*/ UPDATE users SET tutorials_done = NULL WHERE tutorials_done IS NOT NULL");
      res.json(await settings());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
