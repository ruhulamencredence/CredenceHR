/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Performance Management / KPI & Appraisal (Admin Panel -> HR Advanced ->
// "Performance Management") — kept in its own file, same reasoning as
// ExitOffboardingRoutes.ts/EmployeeTransferRoutes.ts.
//
// Data model:
//   performance_cycles — a named appraisal period (e.g. "2026 H1"), draft ->
//                        active -> closed.
//   performance_goals  — one KPI/goal per (cycle, employee), with a weight,
//                        a target description, and self/manager ratings.
//   performance_reviews — one overall review per (cycle, employee,
//                        reviewer) — strengths/improvements + an overall
//                        rating, pending -> submitted -> acknowledged.
//
// Same convention as ExitOffboardingRoutes.ts: every write route only ever
// does `WHERE id = ?`; filtering/scoping happens in JS after a full-table
// SELECT. Every INSERT/UPDATE is all-`?`-placeholders (no inline SQL
// literals mixed into the VALUES/SET list) so the in-memory dev fallback's
// generic positional-param simulator stays correct.

import type { Express } from "express";

interface PerformanceRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (moduleKey: "performance_management") => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  getAdminModules: (userId: number) => Promise<string[]>;
}

export async function ensurePerformanceSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS performance_cycles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        period_start DATE NULL,
        period_end DATE NULL,
        status ENUM('draft', 'active', 'closed') NOT NULL DEFAULT 'draft',
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure performance_cycles table exists: " + err.message);
  }
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS performance_goals (
        id INT AUTO_INCREMENT PRIMARY KEY,
        cycle_id INT NOT NULL,
        user_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT NULL,
        weight DECIMAL(5, 2) NOT NULL DEFAULT 0,
        self_rating DECIMAL(3, 1) NULL,
        manager_rating DECIMAL(3, 1) NULL,
        status ENUM('active', 'completed') NOT NULL DEFAULT 'active',
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (cycle_id) REFERENCES performance_cycles(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure performance_goals table exists: " + err.message);
  }
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS performance_reviews (
        id INT AUTO_INCREMENT PRIMARY KEY,
        cycle_id INT NOT NULL,
        user_id INT NOT NULL,
        reviewer_id INT NULL,
        overall_rating DECIMAL(3, 1) NULL,
        strengths TEXT NULL,
        improvements TEXT NULL,
        status ENUM('pending', 'submitted', 'acknowledged') NOT NULL DEFAULT 'pending',
        submitted_at TIMESTAMP NULL,
        acknowledged_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (cycle_id) REFERENCES performance_cycles(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure performance_reviews table exists: " + err.message);
  }
}

export function registerPerformanceRoutes(app: Express, deps: PerformanceRouteDeps) {
  const { authenticateToken, requireAdmin, requireModule, queryDB } = deps;
  const gate = [authenticateToken, requireAdmin, requireModule("performance_management")];

  // ---------- Cycles ----------
  app.get("/api/performance-cycles", ...gate, async (_req: any, res: any) => {
    try {
      const rows: any = await queryDB("SELECT * FROM performance_cycles");
      res.json(rows.sort((a: any, b: any) => Number(b.id) - Number(a.id)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/performance-cycles", ...gate, async (req: any, res: any) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 150) : "";
      if (!name) return res.status(400).json({ error: "Cycle name is required." });
      const periodStart = req.body?.period_start || null;
      const periodEnd = req.body?.period_end || null;
      const result: any = await queryDB(
        "INSERT INTO performance_cycles (name, period_start, period_end, status, created_by) VALUES (?, ?, ?, ?, ?)",
        [name, periodStart, periodEnd, "draft", req.user.id]
      );
      const rows: any = await queryDB("SELECT * FROM performance_cycles WHERE id = ?", [Number(result.insertId)]);
      res.status(201).json(rows[0]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/performance-cycles/:id", ...gate, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const status = req.body?.status;
      if (!["draft", "active", "closed"].includes(status)) return res.status(400).json({ error: "Invalid status." });
      await queryDB("UPDATE performance_cycles SET status = ? WHERE id = ?", [status, id]);
      const rows: any = await queryDB("SELECT * FROM performance_cycles WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Cycle not found." });
      res.json(rows[0]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- Goals ----------
  async function serializeGoal(g: any, userById: Map<number, any>) {
    return {
      id: Number(g.id),
      cycle_id: Number(g.cycle_id),
      user_id: Number(g.user_id),
      user_name: userById.get(Number(g.user_id))?.name || null,
      title: g.title,
      description: g.description,
      weight: Number(g.weight),
      self_rating: g.self_rating === null || g.self_rating === undefined ? null : Number(g.self_rating),
      manager_rating: g.manager_rating === null || g.manager_rating === undefined ? null : Number(g.manager_rating),
      status: g.status
    };
  }

  app.get("/api/performance-goals", ...gate, async (req: any, res: any) => {
    try {
      const cycleId = req.query.cycle_id ? Number(req.query.cycle_id) : null;
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM performance_goals"),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      const scoped = cycleId ? rows.filter((g: any) => Number(g.cycle_id) === cycleId) : rows;
      res.json(await Promise.all(scoped.map((g: any) => serializeGoal(g, userById))));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/performance-goals", ...gate, async (req: any, res: any) => {
    try {
      const body = req.body || {};
      const cycleId = Number(body.cycle_id);
      const userId = Number(body.user_id);
      const title = typeof body.title === "string" ? body.title.trim().slice(0, 255) : "";
      if (!cycleId || !userId || !title) return res.status(400).json({ error: "Cycle, employee and goal title are required." });
      const weight = Number.isFinite(Number(body.weight)) ? Number(body.weight) : 0;
      const description = typeof body.description === "string" ? body.description.trim().slice(0, 2000) : null;
      const result: any = await queryDB(
        "INSERT INTO performance_goals (cycle_id, user_id, title, description, weight, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [cycleId, userId, title, description, weight, "active", req.user.id]
      );
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM performance_goals WHERE id = ?", [Number(result.insertId)]),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      res.status(201).json(await serializeGoal(rows[0], userById));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/performance-goals/:id", ...gate, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const body = req.body || {};
      const existingRows: any = await queryDB("SELECT * FROM performance_goals WHERE id = ?", [id]);
      if (existingRows.length === 0) return res.status(404).json({ error: "Goal not found." });
      const existing = existingRows[0];
      const managerRating =
        body.manager_rating === undefined || body.manager_rating === null || body.manager_rating === ""
          ? existing.manager_rating ?? null
          : Number(body.manager_rating);
      const status = ["active", "completed"].includes(body.status) ? body.status : existing.status;
      await queryDB("UPDATE performance_goals SET manager_rating = ?, status = ? WHERE id = ?", [managerRating, status, id]);
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM performance_goals WHERE id = ?", [id]),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      res.json(await serializeGoal(rows[0], userById));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- Reviews ----------
  async function serializeReview(r: any, userById: Map<number, any>) {
    return {
      id: Number(r.id),
      cycle_id: Number(r.cycle_id),
      user_id: Number(r.user_id),
      user_name: userById.get(Number(r.user_id))?.name || null,
      reviewer_id: r.reviewer_id === null || r.reviewer_id === undefined ? null : Number(r.reviewer_id),
      reviewer_name: r.reviewer_id ? userById.get(Number(r.reviewer_id))?.name || null : null,
      overall_rating: r.overall_rating === null || r.overall_rating === undefined ? null : Number(r.overall_rating),
      strengths: r.strengths,
      improvements: r.improvements,
      status: r.status
    };
  }

  app.get("/api/performance-reviews", ...gate, async (req: any, res: any) => {
    try {
      const cycleId = req.query.cycle_id ? Number(req.query.cycle_id) : null;
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM performance_reviews"),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      const scoped = cycleId ? rows.filter((r: any) => Number(r.cycle_id) === cycleId) : rows;
      res.json(await Promise.all(scoped.map((r: any) => serializeReview(r, userById))));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/performance-reviews", ...gate, async (req: any, res: any) => {
    try {
      const body = req.body || {};
      const cycleId = Number(body.cycle_id);
      const userId = Number(body.user_id);
      if (!cycleId || !userId) return res.status(400).json({ error: "Cycle and employee are required." });
      const reviewerId = body.reviewer_id ? Number(body.reviewer_id) : req.user.id;
      const result: any = await queryDB(
        "INSERT INTO performance_reviews (cycle_id, user_id, reviewer_id, status) VALUES (?, ?, ?, ?)",
        [cycleId, userId, reviewerId, "pending"]
      );
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM performance_reviews WHERE id = ?", [Number(result.insertId)]),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      res.status(201).json(await serializeReview(rows[0], userById));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/performance-reviews/:id", ...gate, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const body = req.body || {};
      const existingRows: any = await queryDB("SELECT * FROM performance_reviews WHERE id = ?", [id]);
      if (existingRows.length === 0) return res.status(404).json({ error: "Review not found." });
      const existing = existingRows[0];
      const overallRating =
        body.overall_rating === undefined || body.overall_rating === null || body.overall_rating === ""
          ? existing.overall_rating ?? null
          : Number(body.overall_rating);
      const strengths = typeof body.strengths === "string" ? body.strengths.trim().slice(0, 2000) : existing.strengths;
      const improvements = typeof body.improvements === "string" ? body.improvements.trim().slice(0, 2000) : existing.improvements;
      const markSubmitted = !!body.submit;
      await queryDB(
        "UPDATE performance_reviews SET overall_rating = ?, strengths = ?, improvements = ?, status = ?, submitted_at = ? WHERE id = ?",
        [overallRating, strengths, improvements, markSubmitted ? "submitted" : existing.status, markSubmitted ? new Date() : existing.submitted_at, id]
      );
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM performance_reviews WHERE id = ?", [id]),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      res.json(await serializeReview(rows[0], userById));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
