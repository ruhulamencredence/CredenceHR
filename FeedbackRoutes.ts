/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// User feedback about the app itself.
//
//   Self Service -> "Give feedback" (users.can_give_feedback, off by default,
//   Module Access): a 1–5 star rating, what kind (problem / idea / general),
//   which part of the app, the details and an optional screenshot. The page
//   it was sent from, phone / tablet / computer, app or website and the app
//   version are added on their own.
//
//   "How do you like the app?" — asked once, 7 days after an account first
//   opens the app (feedback_prompts). "Later" asks again in 7 days, "Don't
//   ask again" never does; answering it counts as asked. A Superadmin can
//   turn the question off, or change the 7 days (feedback_settings).
//
//   Admin Panel -> User Feedback (module "user_feedback"): every piece of
//   feedback with its screenshot, filters and the average rating.

import type { Express } from "express";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;
interface Deps {
  authenticateToken: any;
  requireAdmin: any;
  requireSuperAdmin: any;
  requireModule: (key: any) => any;
  queryDB: QueryDB;
}

const MAX_SHOT = 3 * 1024 * 1024;
const KINDS = ["bug", "idea", "general"];

export async function ensureFeedbackSchema(dbPool: any): Promise<void> {
  const run = async (sql: string, ignore: string[] = []) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      if (!ignore.includes(err?.code)) console.warn("⚠️ Feedback: " + err.message);
    }
  };
  await run(`
    CREATE TABLE IF NOT EXISTS app_feedback (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      rating TINYINT NULL,
      kind VARCHAR(10) NOT NULL DEFAULT 'general',
      module VARCHAR(80) NULL,
      message TEXT NULL,
      screenshot_mimetype VARCHAR(60) NULL,
      screenshot_data MEDIUMBLOB NULL,
      page VARCHAR(255) NULL,
      device VARCHAR(20) NULL,
      client VARCHAR(10) NULL,
      app_version VARCHAR(40) NULL,
      user_agent VARCHAR(255) NULL,
      source VARCHAR(10) NOT NULL DEFAULT 'button',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_app_feedback_created (created_at),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) DEFAULT CHARSET=utf8mb4
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS feedback_prompts (
      user_id INT NOT NULL PRIMARY KEY,
      first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      next_ask_at TIMESTAMP NULL DEFAULT NULL,
      never_ask TINYINT(1) NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS feedback_settings (
      id INT NOT NULL PRIMARY KEY,
      prompt_enabled TINYINT(1) NOT NULL DEFAULT 1,
      prompt_after_days INT NOT NULL DEFAULT 7
    )
  `);
  await run("INSERT IGNORE INTO feedback_settings (id, prompt_enabled, prompt_after_days) VALUES (1, 1, 7)");
  await run("ALTER TABLE users ADD COLUMN can_give_feedback TINYINT(1) NOT NULL DEFAULT 0", ["ER_DUP_FIELDNAME"]);
}

export function registerFeedbackRoutes(app: Express, deps: Deps) {
  const { authenticateToken, requireAdmin, requireSuperAdmin, requireModule, queryDB } = deps;
  const str = (v: any, max: number) => (v === null || v === undefined ? "" : String(v).trim().slice(0, max));
  const settings = async () =>
    ((await queryDB("/*unscoped*/ SELECT prompt_enabled, prompt_after_days FROM feedback_settings WHERE id = 1").catch(() => [])) || [])[0] || { prompt_enabled: 1, prompt_after_days: 7 };

  // The Self Service switch (a Superadmin always has it).
  const requireFeedback = async (req: any, res: any, next: any) => {
    try {
      if (req.user?.role === "superadmin") return next();
      const rows: any[] = (await queryDB("SELECT can_give_feedback FROM users WHERE id = ?", [req.user.id])) || [];
      if (Number(rows[0]?.can_give_feedback) === 1) return next();
      res.status(403).json({ error: "Feedback isn't turned on for your account." });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  // Should "How do you like the app?" show now? The first call starts the
  // account's 7 days.
  app.get("/api/feedback/prompt", authenticateToken, requireFeedback, async (req: any, res) => {
    try {
      const s = await settings();
      await queryDB("INSERT IGNORE INTO feedback_prompts (user_id) VALUES (?)", [req.user.id]);
      if (!Number(s.prompt_enabled)) return res.json({ show: false });
      const days = Math.max(1, Number(s.prompt_after_days) || 7);
      const rows: any[] =
        (await queryDB(
          `SELECT (never_ask = 0 AND NOW() >= COALESCE(next_ask_at, first_seen_at + INTERVAL ${days} DAY)) AS due FROM feedback_prompts WHERE user_id = ?`,
          [req.user.id]
        )) || [];
      res.json({ show: Number(rows[0]?.due) === 1 });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  // { action: 'later' | 'never' }
  app.post("/api/feedback/prompt", authenticateToken, requireFeedback, async (req: any, res) => {
    try {
      const action = req.body?.action === "never" ? "never" : "later";
      const days = Math.max(1, Number((await settings()).prompt_after_days) || 7);
      await queryDB("INSERT IGNORE INTO feedback_prompts (user_id) VALUES (?)", [req.user.id]);
      if (action === "never") await queryDB("UPDATE feedback_prompts SET never_ask = 1 WHERE user_id = ?", [req.user.id]);
      else await queryDB(`UPDATE feedback_prompts SET next_ask_at = NOW() + INTERVAL ${days} DAY WHERE user_id = ?`, [req.user.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Sends feedback: { rating, kind, module, message, screenshot_base64,
  // screenshot_mimetype, page, device, client, app_version, source }.
  app.post("/api/feedback", authenticateToken, requireFeedback, async (req: any, res) => {
    try {
      const b = req.body || {};
      const rating = b.rating === null || b.rating === undefined || b.rating === "" ? null : Math.round(Number(b.rating));
      if (rating !== null && !(rating >= 1 && rating <= 5)) return res.status(400).json({ error: "Rating is 1 to 5 stars." });
      const kind = KINDS.includes(b.kind) ? b.kind : "general";
      const message = str(b.message, 4000);
      if (!rating && !message) return res.status(400).json({ error: "Give a rating or write a few words." });
      if (kind === "bug" && !message) return res.status(400).json({ error: "Tell us what went wrong." });
      let shot: Buffer | null = null;
      const mime = str(b.screenshot_mimetype, 60);
      if (b.screenshot_base64) {
        if (!/^image\/(png|jpe?g|webp|gif)$/i.test(mime)) return res.status(400).json({ error: "The screenshot must be an image (PNG / JPG / WEBP)." });
        shot = Buffer.from(String(b.screenshot_base64), "base64");
        if (shot.length > MAX_SHOT) return res.status(400).json({ error: "The screenshot must be under 3 MB." });
      }
      const source = b.source === "prompt" ? "prompt" : "button";
      const r: any = await queryDB(
        `INSERT INTO app_feedback (user_id, rating, kind, module, message, screenshot_mimetype, screenshot_data, page, device, client, app_version, user_agent, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.id,
          rating,
          kind,
          str(b.module, 80) || null,
          message || null,
          shot ? mime : null,
          shot,
          str(b.page, 255) || null,
          ["phone", "tablet", "computer"].includes(b.device) ? b.device : null,
          b.client === "app" ? "app" : "web",
          str(b.app_version, 40) || null,
          str(req.headers["user-agent"], 255) || null,
          source
        ]
      );
      // Answering "How do you like the app?" means it was asked.
      if (source === "prompt") {
        await queryDB("INSERT IGNORE INTO feedback_prompts (user_id) VALUES (?)", [req.user.id]);
        await queryDB("UPDATE feedback_prompts SET never_ask = 1 WHERE user_id = ?", [req.user.id]);
      }
      res.status(201).json({ id: Number(r.insertId) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Admin Panel -> User Feedback ----
  const adminGate = [authenticateToken, requireAdmin, requireModule("user_feedback")];
  // ?kind=&rating=&from=&to=&q=  — newest first (500 at most) and a summary.
  app.get("/api/feedback", ...adminGate, async (req: any, res) => {
    try {
      const where: string[] = ["1 = 1"];
      const params: any[] = [];
      if (KINDS.includes(String(req.query.kind))) {
        where.push("f.kind = ?");
        params.push(String(req.query.kind));
      }
      const rating = Number(req.query.rating);
      if (rating >= 1 && rating <= 5) {
        where.push("f.rating = ?");
        params.push(rating);
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from))) {
        where.push("f.created_at >= ?");
        params.push(`${req.query.from} 00:00:00`);
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to))) {
        where.push("f.created_at <= ?");
        params.push(`${req.query.to} 23:59:59`);
      }
      const q = str(req.query.q, 100);
      if (q) {
        where.push("(f.message LIKE ? OR f.module LIKE ? OR u.name LIKE ?)");
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }
      const rows: any[] =
        (await queryDB(
          `SELECT f.id, f.user_id, u.name AS user_name, u.email AS user_email, f.rating, f.kind, f.module, f.message,
                  (f.screenshot_data IS NOT NULL) AS has_screenshot, f.page, f.device, f.client, f.app_version, f.source, f.created_at
             FROM app_feedback f JOIN users u ON u.id = f.user_id
            WHERE ${where.join(" AND ")} ORDER BY f.id DESC LIMIT 500`,
          params
        )) || [];
      const rated = rows.filter((r) => r.rating);
      const summary = {
        total: rows.length,
        average: rated.length ? Math.round((rated.reduce((n, r) => n + Number(r.rating), 0) / rated.length) * 10) / 10 : null,
        byStars: [1, 2, 3, 4, 5].map((s) => rated.filter((r) => Number(r.rating) === s).length),
        byKind: Object.fromEntries(KINDS.map((k) => [k, rows.filter((r) => r.kind === k).length]))
      };
      res.setHeader("Cache-Control", "no-store");
      res.json({ summary, rows: rows.map((r) => ({ ...r, has_screenshot: !!Number(r.has_screenshot) })), settings: await settings() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get("/api/feedback/:id/screenshot", ...adminGate, async (req: any, res) => {
    try {
      const row: any = ((await queryDB("SELECT f.screenshot_mimetype, f.screenshot_data FROM app_feedback f WHERE f.id = ?", [Number(req.params.id)])) || [])[0];
      if (!row?.screenshot_data) return res.status(404).json({ error: "No screenshot." });
      res.setHeader("Content-Type", row.screenshot_mimetype || "image/png");
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.send(Buffer.isBuffer(row.screenshot_data) ? row.screenshot_data : Buffer.from(row.screenshot_data));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  // The "How do you like the app?" question: on/off and after how many days.
  app.put("/api/feedback/settings", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const enabled = req.body?.prompt_enabled ? 1 : 0;
      const days = Math.min(365, Math.max(1, Math.round(Number(req.body?.prompt_after_days) || 7)));
      await queryDB("/*unscoped*/ UPDATE feedback_settings SET prompt_enabled = ?, prompt_after_days = ? WHERE id = 1", [enabled, days]);
      res.json({ prompt_enabled: enabled, prompt_after_days: days });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
