/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Recruitment / Applicant Tracking (Admin Panel -> HR Advanced ->
// "Recruitment (ATS)") — kept in its own file, same reasoning as
// ExitOffboardingRoutes.ts/PerformanceRoutes.ts.
//
// Data model:
//   job_postings        — a vacancy (title/department/designation/vacancy
//                          count), open -> on_hold -> closed.
//   job_candidates       — an applicant against one posting, moving through
//                          applied -> shortlisted -> interview_scheduled ->
//                          interviewed -> offered -> hired/rejected.
//   candidate_interviews — one or more interview rounds per candidate, with
//                          feedback + a rating once completed.
//
// Same convention as ExitOffboardingRoutes.ts: every write route only ever
// does `WHERE id = ?`, filtering happens in JS after a full-table SELECT,
// and every INSERT/UPDATE is all-`?`-placeholders (no inline SQL literals
// mixed into VALUES/SET) so the in-memory dev fallback's generic positional
// simulator stays correct.

import type { Express } from "express";

interface RecruitmentRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (moduleKey: "recruitment") => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
}

export async function ensureRecruitmentSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS job_postings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        department VARCHAR(255) NULL,
        designation VARCHAR(255) NULL,
        vacancy_count INT NOT NULL DEFAULT 1,
        description TEXT NULL,
        requirements TEXT NULL,
        status ENUM('open', 'on_hold', 'closed') NOT NULL DEFAULT 'open',
        closing_date DATE NULL,
        posted_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (posted_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure job_postings table exists: " + err.message);
  }
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS job_candidates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        posting_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NULL,
        phone VARCHAR(50) NULL,
        source VARCHAR(100) NULL,
        status ENUM('applied', 'shortlisted', 'interview_scheduled', 'interviewed', 'offered', 'hired', 'rejected') NOT NULL DEFAULT 'applied',
        notes TEXT NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (posting_id) REFERENCES job_postings(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure job_candidates table exists: " + err.message);
  }
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS candidate_interviews (
        id INT AUTO_INCREMENT PRIMARY KEY,
        candidate_id INT NOT NULL,
        scheduled_at DATETIME NULL,
        interviewer_id INT NULL,
        feedback TEXT NULL,
        rating DECIMAL(3, 1) NULL,
        status ENUM('scheduled', 'completed', 'cancelled') NOT NULL DEFAULT 'scheduled',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (candidate_id) REFERENCES job_candidates(id) ON DELETE CASCADE,
        FOREIGN KEY (interviewer_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure candidate_interviews table exists: " + err.message);
  }
}

export function registerRecruitmentRoutes(app: Express, deps: RecruitmentRouteDeps) {
  const { authenticateToken, requireAdmin, requireModule, queryDB } = deps;
  const gate = [authenticateToken, requireAdmin, requireModule("recruitment")];

  // ---------- Postings ----------
  app.get("/api/job-postings", ...gate, async (_req: any, res: any) => {
    try {
      const rows: any = await queryDB("SELECT * FROM job_postings");
      res.json(rows.sort((a: any, b: any) => Number(b.id) - Number(a.id)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/job-postings", ...gate, async (req: any, res: any) => {
    try {
      const body = req.body || {};
      const title = typeof body.title === "string" ? body.title.trim().slice(0, 255) : "";
      if (!title) return res.status(400).json({ error: "Job title is required." });
      const department = typeof body.department === "string" ? body.department.trim().slice(0, 255) || null : null;
      const designation = typeof body.designation === "string" ? body.designation.trim().slice(0, 255) || null : null;
      const vacancyCount = Number.isFinite(Number(body.vacancy_count)) && Number(body.vacancy_count) > 0 ? Number(body.vacancy_count) : 1;
      const description = typeof body.description === "string" ? body.description.trim().slice(0, 4000) || null : null;
      const requirements = typeof body.requirements === "string" ? body.requirements.trim().slice(0, 4000) || null : null;
      const closingDate = body.closing_date || null;
      const result: any = await queryDB(
        `INSERT INTO job_postings (title, department, designation, vacancy_count, description, requirements, status, closing_date, posted_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [title, department, designation, vacancyCount, description, requirements, "open", closingDate, req.user.id]
      );
      const rows: any = await queryDB("SELECT * FROM job_postings WHERE id = ?", [Number(result.insertId)]);
      res.status(201).json(rows[0]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/job-postings/:id", ...gate, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const status = req.body?.status;
      if (!["open", "on_hold", "closed"].includes(status)) return res.status(400).json({ error: "Invalid status." });
      await queryDB("UPDATE job_postings SET status = ? WHERE id = ?", [status, id]);
      const rows: any = await queryDB("SELECT * FROM job_postings WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Posting not found." });
      res.json(rows[0]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- Candidates ----------
  app.get("/api/job-candidates", ...gate, async (req: any, res: any) => {
    try {
      const postingId = req.query.posting_id ? Number(req.query.posting_id) : null;
      const rows: any = await queryDB("SELECT * FROM job_candidates");
      const scoped = postingId ? rows.filter((c: any) => Number(c.posting_id) === postingId) : rows;
      res.json(scoped.sort((a: any, b: any) => Number(b.id) - Number(a.id)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/job-candidates", ...gate, async (req: any, res: any) => {
    try {
      const body = req.body || {};
      const postingId = Number(body.posting_id);
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 255) : "";
      if (!postingId || !name) return res.status(400).json({ error: "Job posting and candidate name are required." });
      const email = typeof body.email === "string" ? body.email.trim().slice(0, 255) || null : null;
      const phone = typeof body.phone === "string" ? body.phone.trim().slice(0, 50) || null : null;
      const source = typeof body.source === "string" ? body.source.trim().slice(0, 100) || null : null;
      const result: any = await queryDB(
        "INSERT INTO job_candidates (posting_id, name, email, phone, source, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [postingId, name, email, phone, source, "applied", req.user.id]
      );
      const rows: any = await queryDB("SELECT * FROM job_candidates WHERE id = ?", [Number(result.insertId)]);
      res.status(201).json(rows[0]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/job-candidates/:id", ...gate, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const body = req.body || {};
      const existingRows: any = await queryDB("SELECT * FROM job_candidates WHERE id = ?", [id]);
      if (existingRows.length === 0) return res.status(404).json({ error: "Candidate not found." });
      const existing = existingRows[0];
      const validStatuses = ["applied", "shortlisted", "interview_scheduled", "interviewed", "offered", "hired", "rejected"];
      const status = validStatuses.includes(body.status) ? body.status : existing.status;
      const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 2000) : existing.notes;
      await queryDB("UPDATE job_candidates SET status = ?, notes = ? WHERE id = ?", [status, notes, id]);
      const rows: any = await queryDB("SELECT * FROM job_candidates WHERE id = ?", [id]);
      res.json(rows[0]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- Interviews ----------
  app.get("/api/candidate-interviews", ...gate, async (req: any, res: any) => {
    try {
      const candidateId = req.query.candidate_id ? Number(req.query.candidate_id) : null;
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM candidate_interviews"),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      const scoped = candidateId ? rows.filter((i: any) => Number(i.candidate_id) === candidateId) : rows;
      res.json(
        scoped
          .sort((a: any, b: any) => Number(b.id) - Number(a.id))
          .map((i: any) => ({
            id: Number(i.id),
            candidate_id: Number(i.candidate_id),
            scheduled_at: i.scheduled_at,
            interviewer_id: i.interviewer_id === null || i.interviewer_id === undefined ? null : Number(i.interviewer_id),
            interviewer_name: i.interviewer_id ? userById.get(Number(i.interviewer_id))?.name || null : null,
            feedback: i.feedback,
            rating: i.rating === null || i.rating === undefined ? null : Number(i.rating),
            status: i.status
          }))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/candidate-interviews", ...gate, async (req: any, res: any) => {
    try {
      const body = req.body || {};
      const candidateId = Number(body.candidate_id);
      if (!candidateId) return res.status(400).json({ error: "Candidate is required." });
      const scheduledAt = body.scheduled_at || null;
      const interviewerId = body.interviewer_id ? Number(body.interviewer_id) : req.user.id;
      const result: any = await queryDB(
        "INSERT INTO candidate_interviews (candidate_id, scheduled_at, interviewer_id, status) VALUES (?, ?, ?, ?)",
        [candidateId, scheduledAt, interviewerId, "scheduled"]
      );
      await queryDB("UPDATE job_candidates SET status = ? WHERE id = ?", ["interview_scheduled", candidateId]);
      const rows: any = await queryDB("SELECT * FROM candidate_interviews WHERE id = ?", [Number(result.insertId)]);
      res.status(201).json(rows[0]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/candidate-interviews/:id", ...gate, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const body = req.body || {};
      const existingRows: any = await queryDB("SELECT * FROM candidate_interviews WHERE id = ?", [id]);
      if (existingRows.length === 0) return res.status(404).json({ error: "Interview not found." });
      const existing = existingRows[0];
      const feedback = typeof body.feedback === "string" ? body.feedback.trim().slice(0, 2000) : existing.feedback;
      const rating =
        body.rating === undefined || body.rating === null || body.rating === "" ? existing.rating ?? null : Number(body.rating);
      const status = ["scheduled", "completed", "cancelled"].includes(body.status) ? body.status : existing.status;
      await queryDB("UPDATE candidate_interviews SET feedback = ?, rating = ?, status = ? WHERE id = ?", [feedback, rating, status, id]);
      if (status === "completed") {
        await queryDB("UPDATE job_candidates SET status = ? WHERE id = ?", ["interviewed", existing.candidate_id]);
      }
      const rows: any = await queryDB("SELECT * FROM candidate_interviews WHERE id = ?", [id]);
      res.json(rows[0]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
