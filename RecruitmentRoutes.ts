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
//                          where / how (in person, online, phone), feedback
//                          + a rating once completed.
//   candidate_interview_events — every set / move / venue change / cancel of
//                          an interview: who, when, from what to what.
//   candidate_emails     — every email sent (or that failed) to a candidate.
//
// Emailing a candidate is the explicit-only layer "email_candidates"; the
// interviewer gets a bell alert whenever their interview is set, moved or
// cancelled.
//
// Same convention as ExitOffboardingRoutes.ts: every write route only ever
// does `WHERE id = ?`, filtering happens in JS after a full-table SELECT,
// and every INSERT/UPDATE is all-`?`-placeholders (no inline SQL literals
// mixed into VALUES/SET) so the in-memory dev fallback's generic positional
// simulator stays correct.

import type { Express } from "express";
import { createAlert } from "./Alerts";
import { isMailerConfigured, sendMail } from "./mailer";

interface RecruitmentRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (moduleKey: "recruitment") => any;
  requireModuleLayer: (moduleKey: "recruitment", layer: "email_candidates") => any;
  hasModuleLayer: (user: any, moduleKey: "recruitment", layer: string) => Promise<boolean>;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
}

const INTERVIEW_MODES = ["in_person", "online", "phone"] as const;
const EMAIL_KINDS = ["interview_scheduled", "interview_rescheduled", "interview_cancelled", "offered", "rejected", "custom"] as const;
type EmailKind = (typeof EMAIL_KINDS)[number];

// "2026-11-03T10:30" / "2026-11-03 10:30:00" -> "2026-11-03 10:30:00", else null.
function cleanDateTime(v: any): string | null {
  const m = typeof v === "string" ? v.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/) : null;
  return m ? `${m[1]} ${m[2]}:00` : null;
}
const cleanText = (v: any, max: number): string | null => (typeof v === "string" ? v.trim().slice(0, max) || null : null);
function cleanLink(v: any): string | null {
  const t = cleanText(v, 500);
  return t && /^https?:\/\/[^\s<>"]+$/i.test(t) ? t : null;
}
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// "2026-11-03 10:30:00" -> "Tuesday, 3 November 2026, 10:30 AM" (Dhaka time,
// as entered — no timezone conversion).
function prettyWhen(dt: string | null): string {
  if (!dt) return "(time to be confirmed)";
  const [d, t] = String(dt).split(" ");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = (t || "00:00").split(":").map(Number);
  const day = new Date(Date.UTC(y, mo - 1, da)).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const hh = ((h + 11) % 12) + 1;
  return `${day}, ${hh}:${String(mi).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function whereLine(i: any): string {
  if (i.mode === "online") return `Online${i.meeting_link ? ` — ${i.meeting_link}` : ""}`;
  if (i.mode === "phone") return "Phone call — we will call you on your number";
  return i.venue ? `In person — ${i.venue}` : "In person";
}

// A calendar invite (.ics) the candidate's phone / mail app can add in one
// tap. The same UID with a higher SEQUENCE moves it; METHOD:CANCEL removes it.
function buildIcs(i: any, title: string, sequence: number, cancel: boolean): string {
  // Wall-clock Dhaka time both ends: "20261106T150000".
  const d = new Date(`${String(i.scheduled_at).slice(0, 16).replace(" ", "T")}:00Z`);
  const stampOf = (x: Date) => x.toISOString().replace(/[-:]/g, "").slice(0, 15);
  const start = stampOf(d);
  d.setUTCMinutes(d.getUTCMinutes() + (Number(i.duration_minutes) || 60));
  const end = stampOf(d);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const location = i.mode === "online" ? i.meeting_link || "Online" : i.mode === "phone" ? "Phone call" : i.venue || "";
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CredenceHR//Recruitment//EN",
    `METHOD:${cancel ? "CANCEL" : "REQUEST"}`,
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Dhaka",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0600",
    "TZOFFSETTO:+0600",
    "TZNAME:+06",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    `UID:interview-${i.id}@credencehr`,
    `SEQUENCE:${sequence}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=Asia/Dhaka:${start}`,
    `DTEND;TZID=Asia/Dhaka:${end}`,
    `SUMMARY:${esc(title)}`,
    ...(location ? [`LOCATION:${esc(location)}`] : []),
    `STATUS:${cancel ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
    ""
  ].join("\r\n");
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
  // The Employee a Hired candidate became, set when their New Joiner
  // Onboarding (OnboardingSelfServiceRoutes.ts) is approved.
  try {
    await dbPool.query("ALTER TABLE job_candidates ADD COLUMN employee_id INT NULL");
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") console.warn("⚠️ Could not add job_candidates.employee_id column: " + err.message);
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
  // Where / how the interview happens, and a note for the candidate.
  for (const [col, ddl] of [
    ["mode", "VARCHAR(20) NULL"],
    ["venue", "VARCHAR(500) NULL"],
    ["meeting_link", "VARCHAR(500) NULL"],
    ["duration_minutes", "INT NULL"],
    ["candidate_note", "TEXT NULL"]
  ]) {
    try {
      await dbPool.query(`ALTER TABLE candidate_interviews ADD COLUMN ${col} ${ddl}`);
    } catch (err: any) {
      if (err.code !== "ER_DUP_FIELDNAME") console.warn(`⚠️ Could not add candidate_interviews.${col} column: ` + err.message);
    }
  }
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS candidate_interview_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        interview_id INT NOT NULL,
        candidate_id INT NOT NULL,
        action VARCHAR(20) NOT NULL,
        old_scheduled_at DATETIME NULL,
        new_scheduled_at DATETIME NULL,
        old_place VARCHAR(600) NULL,
        new_place VARCHAR(600) NULL,
        reason VARCHAR(500) NULL,
        done_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_cie_interview (interview_id),
        FOREIGN KEY (interview_id) REFERENCES candidate_interviews(id) ON DELETE CASCADE,
        FOREIGN KEY (done_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure candidate_interview_events table exists: " + err.message);
  }
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS candidate_emails (
        id INT AUTO_INCREMENT PRIMARY KEY,
        candidate_id INT NOT NULL,
        interview_id INT NULL,
        kind VARCHAR(30) NOT NULL,
        to_email VARCHAR(255) NOT NULL,
        subject VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        status VARCHAR(10) NOT NULL,
        error VARCHAR(500) NULL,
        covers_event_id INT NULL,
        sent_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ce_candidate (candidate_id),
        FOREIGN KEY (candidate_id) REFERENCES job_candidates(id) ON DELETE CASCADE,
        FOREIGN KEY (sent_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure candidate_emails table exists: " + err.message);
  }
}

export function registerRecruitmentRoutes(app: Express, deps: RecruitmentRouteDeps) {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, hasModuleLayer, queryDB } = deps;
  const gate = [authenticateToken, requireAdmin, requireModule("recruitment")];
  const emailGate = [authenticateToken, requireAdmin, requireModuleLayer("recruitment", "email_candidates")];

  const placeOf = (i: any): string | null => (i.mode || i.venue || i.meeting_link ? whereLine(i).slice(0, 600) : null);

  const logEvent = async (i: any, action: string, old: any, reason: string | null, userId: number) => {
    await queryDB(
      "INSERT INTO candidate_interview_events (interview_id, candidate_id, action, old_scheduled_at, new_scheduled_at, old_place, new_place, reason, done_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [Number(i.id), Number(i.candidate_id), action, old ? old.scheduled_at || null : null, action === "cancelled" ? null : i.scheduled_at || null, old ? placeOf(old) : null, action === "cancelled" ? null : placeOf(i), reason, userId]
    ).catch((err: any) => console.warn("⚠️ Could not log interview change: " + err.message));
  };

  // The interviewer hears about their interview being set, moved or
  // cancelled (bell + push). Not to the person who made the change.
  const alertInterviewer = async (interviewerId: number | null, byUserId: number, title: string, i: any, candidateName: string) => {
    if (!interviewerId || Number(interviewerId) === Number(byUserId)) return;
    await createAlert(queryDB, {
      userId: Number(interviewerId),
      type: "interview",
      title,
      message: `${candidateName}: ${title === "Interview cancelled" ? "the interview is off" : `${prettyWhen(i.scheduled_at)} · ${whereLine(i)}`}`,
      relatedType: "candidate_interview",
      relatedId: Number(i.id)
    });
  };

  const readInterviewFields = (body: any, existing: any | null) => {
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
    const mode = has("mode") ? ((INTERVIEW_MODES as readonly string[]).includes(body.mode) ? body.mode : null) : existing?.mode ?? null;
    const duration = has("duration_minutes")
      ? Number.isFinite(Number(body.duration_minutes)) && Number(body.duration_minutes) >= 10 && Number(body.duration_minutes) <= 480
        ? Math.round(Number(body.duration_minutes))
        : null
      : existing?.duration_minutes ?? null;
    return {
      mode,
      venue: has("venue") ? cleanText(body.venue, 500) : existing?.venue ?? null,
      meeting_link: has("meeting_link") ? cleanLink(body.meeting_link) : existing?.meeting_link ?? null,
      duration_minutes: duration,
      candidate_note: has("candidate_note") ? cleanText(body.candidate_note, 2000) : existing?.candidate_note ?? null
    };
  };

  // Who the page should offer: emailing, and whether the server can send mail.
  app.get("/api/recruitment/access", ...gate, async (req: any, res: any) => {
    try {
      res.json({ email_candidates: await hasModuleLayer(req.user, "recruitment", "email_candidates"), mail_ready: isMailerConfigured() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // People who can be picked as the interviewer (active logins), with their
  // Employee ID, designation and department so the picker can be searched
  // by any of them.
  app.get("/api/recruitment/interviewers", ...gate, async (_req: any, res: any) => {
    try {
      const [users, emps]: [any, any] = await Promise.all([
        queryDB("SELECT id, name, is_blocked, is_onboarding FROM users"),
        queryDB("SELECT user_id, employee_id, designation, department, is_active FROM all_employees").catch(() => [])
      ]);
      const empByUser = new Map<number, any>();
      for (const e of emps || []) if (e.user_id && (!empByUser.has(Number(e.user_id)) || Number(e.is_active))) empByUser.set(Number(e.user_id), e);
      res.json(
        users
          .filter((u: any) => !Number(u.is_blocked) && !Number(u.is_onboarding))
          .map((u: any) => {
            const e = empByUser.get(Number(u.id));
            return { id: Number(u.id), name: u.name, employee_id: e?.employee_id || null, designation: e?.designation || null, department: e?.department || null };
          })
          .sort((a: any, b: any) => String(a.name || "").localeCompare(String(b.name || "")))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

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
      const [rows, interviews, events, emails]: [any, any, any, any] = await Promise.all([
        queryDB("SELECT * FROM job_candidates"),
        queryDB("SELECT * FROM candidate_interviews WHERE status = 'scheduled' ORDER BY scheduled_at ASC").catch(() => []),
        queryDB("SELECT id, interview_id FROM candidate_interview_events").catch(() => []),
        queryDB("SELECT interview_id, kind, status, covers_event_id FROM candidate_emails").catch(() => [])
      ]);
      // The candidate's scheduled interview (Admin Dashboard counts today's
      // and this week's from it).
      const nextInterview = new Map<number, any>();
      for (const i of interviews || []) if (!nextInterview.has(Number(i.candidate_id))) nextInterview.set(Number(i.candidate_id), i);
      // Was the candidate emailed after the interview's last change? Each
      // email remembers the newest change it told them about.
      const lastChange = new Map<number, number>();
      for (const e of events || []) lastChange.set(Number(e.interview_id), Math.max(lastChange.get(Number(e.interview_id)) || 0, Number(e.id)));
      const lastTold = new Map<number, number>();
      for (const m of emails || []) {
        if (m.status !== "sent" || !m.interview_id || !String(m.kind).startsWith("interview_")) continue;
        lastTold.set(Number(m.interview_id), Math.max(lastTold.get(Number(m.interview_id)) || 0, Number(m.covers_event_id) || 0));
      }
      const scoped = postingId ? rows.filter((c: any) => Number(c.posting_id) === postingId) : rows;
      res.json(
        scoped
          .sort((a: any, b: any) => Number(b.id) - Number(a.id))
          .map((c: any) => {
            const i = nextInterview.get(Number(c.id));
            return {
              ...c,
              interview_id: i?.id ?? null,
              interview_at: i?.scheduled_at ?? null,
              interview_mode: i?.mode ?? null,
              interview_venue: i?.venue ?? null,
              interview_link: i?.meeting_link ?? null,
              interview_informed: i ? lastTold.has(Number(i.id)) && lastTold.get(Number(i.id))! >= (lastChange.get(Number(i.id)) || 0) : null
            };
          })
      );
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
      // A Hired candidate with a New Joiner Onboarding under way (or done)
      // stays Hired — otherwise their temporary login would be left hanging.
      if (existing.status === "hired" && status !== "hired") {
        const apps: any[] = await queryDB("/*unscoped*/ SELECT status FROM onboarding_applications WHERE candidate_id = ?", [id]).catch(() => []);
        if (apps.some((a: any) => a.status === "approved"))
          return res.status(409).json({ error: "This candidate has already joined as an Employee, so they stay Hired." });
        if (apps.some((a: any) => ["draft", "submitted", "rejected"].includes(a.status)))
          return res.status(409).json({ error: "This candidate's onboarding is still open. Cancel it in HR Operations → Onboarding → New Joiners first." });
      }
      const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 2000) : existing.notes;
      await queryDB("UPDATE job_candidates SET status = ?, notes = ? WHERE id = ?", [status, notes, id]);
      const rows: any = await queryDB("SELECT * FROM job_candidates WHERE id = ?", [id]);
      res.json(rows[0]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- Interviews ----------
  const interviewOut = (i: any, userById: Map<number, any>) => ({
    id: Number(i.id),
    candidate_id: Number(i.candidate_id),
    scheduled_at: i.scheduled_at,
    interviewer_id: i.interviewer_id === null || i.interviewer_id === undefined ? null : Number(i.interviewer_id),
    interviewer_name: i.interviewer_id ? userById.get(Number(i.interviewer_id))?.name || null : null,
    mode: i.mode ?? null,
    venue: i.venue ?? null,
    meeting_link: i.meeting_link ?? null,
    duration_minutes: i.duration_minutes === null || i.duration_minutes === undefined ? null : Number(i.duration_minutes),
    candidate_note: i.candidate_note ?? null,
    feedback: i.feedback,
    rating: i.rating === null || i.rating === undefined ? null : Number(i.rating),
    status: i.status
  });

  app.get("/api/candidate-interviews", ...gate, async (req: any, res: any) => {
    try {
      const candidateId = req.query.candidate_id ? Number(req.query.candidate_id) : null;
      const [rows, users]: [any, any] = await Promise.all([
        queryDB("SELECT * FROM candidate_interviews"),
        queryDB("SELECT id, name FROM users")
      ]);
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      const scoped = candidateId ? rows.filter((i: any) => Number(i.candidate_id) === candidateId) : rows;
      res.json(scoped.sort((a: any, b: any) => Number(b.id) - Number(a.id)).map((i: any) => interviewOut(i, userById)));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // One candidate's interviews, every change made to them and every email
  // sent — the history in the Interview popup.
  app.get("/api/job-candidates/:id/interview-history", ...gate, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const [cand, interviews, events, emails, users]: [any, any, any, any, any] = await Promise.all([
        queryDB("SELECT id FROM job_candidates WHERE id = ?", [id]),
        queryDB("SELECT * FROM candidate_interviews WHERE candidate_id = ?", [id]),
        queryDB("SELECT * FROM candidate_interview_events WHERE candidate_id = ?", [id]),
        queryDB("SELECT id, interview_id, kind, to_email, subject, status, error, sent_by, created_at FROM candidate_emails WHERE candidate_id = ?", [id]),
        queryDB("SELECT id, name FROM users")
      ]);
      if (!cand.length) return res.status(404).json({ error: "Candidate not found." });
      const userById = new Map<number, any>(users.map((u: any): [number, any] => [Number(u.id), u]));
      const byNewest = (a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)) || Number(b.id) - Number(a.id);
      res.json({
        interviews: interviews.sort((a: any, b: any) => Number(b.id) - Number(a.id)).map((i: any) => interviewOut(i, userById)),
        events: events.sort(byNewest).map((e: any) => ({ ...e, done_by_name: e.done_by ? userById.get(Number(e.done_by))?.name || null : null })),
        emails: emails.sort(byNewest).map((m: any) => ({ ...m, sent_by_name: m.sent_by ? userById.get(Number(m.sent_by))?.name || null : null }))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/candidate-interviews", ...gate, async (req: any, res: any) => {
    try {
      const body = req.body || {};
      const candidateId = Number(body.candidate_id);
      if (!candidateId) return res.status(400).json({ error: "Candidate is required." });
      const cands: any = await queryDB("SELECT id, name FROM job_candidates WHERE id = ?", [candidateId]);
      if (!cands.length) return res.status(404).json({ error: "Candidate not found." });
      const scheduledAt = cleanDateTime(body.scheduled_at);
      if (body.scheduled_at && !scheduledAt) return res.status(400).json({ error: "Pick a valid interview date and time." });
      const interviewerId = body.interviewer_id ? Number(body.interviewer_id) : req.user.id;
      const f = readInterviewFields(body, null);
      if (body.meeting_link && !f.meeting_link) return res.status(400).json({ error: "The meeting link must start with http:// or https://." });
      const result: any = await queryDB(
        "INSERT INTO candidate_interviews (candidate_id, scheduled_at, interviewer_id, status, mode, venue, meeting_link, duration_minutes, candidate_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [candidateId, scheduledAt, interviewerId, "scheduled", f.mode, f.venue, f.meeting_link, f.duration_minutes, f.candidate_note]
      );
      await queryDB("UPDATE job_candidates SET status = ? WHERE id = ?", ["interview_scheduled", candidateId]);
      const rows: any = await queryDB("SELECT * FROM candidate_interviews WHERE id = ?", [Number(result.insertId)]);
      await logEvent(rows[0], "scheduled", null, null, req.user.id);
      await alertInterviewer(interviewerId, req.user.id, "Interview scheduled", rows[0], cands[0].name);
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
      if (existing.status === "cancelled" && body.status !== "scheduled")
        return res.status(409).json({ error: "This interview was cancelled. Schedule a new one instead." });
      const feedback = typeof body.feedback === "string" ? body.feedback.trim().slice(0, 2000) : existing.feedback;
      const rating =
        body.rating === undefined || body.rating === null || body.rating === "" ? existing.rating ?? null : Number(body.rating);
      if (rating !== null && (!Number.isFinite(rating) || rating < 0 || rating > 10)) return res.status(400).json({ error: "Rating must be between 0 and 10." });
      const status = ["scheduled", "completed", "cancelled"].includes(body.status) ? body.status : existing.status;
      const scheduledAt = body.scheduled_at !== undefined ? cleanDateTime(body.scheduled_at) : existing.scheduled_at;
      if (body.scheduled_at && !scheduledAt) return res.status(400).json({ error: "Pick a valid interview date and time." });
      const interviewerId = body.interviewer_id !== undefined ? (body.interviewer_id ? Number(body.interviewer_id) : null) : existing.interviewer_id;
      const f = readInterviewFields(body, existing);
      if (body.meeting_link && !f.meeting_link) return res.status(400).json({ error: "The meeting link must start with http:// or https://." });
      const reason = cleanText(body.reason, 500);
      await queryDB(
        "UPDATE candidate_interviews SET feedback = ?, rating = ?, status = ?, scheduled_at = ?, interviewer_id = ?, mode = ?, venue = ?, meeting_link = ?, duration_minutes = ?, candidate_note = ? WHERE id = ?",
        [feedback, rating, status, scheduledAt, interviewerId, f.mode, f.venue, f.meeting_link, f.duration_minutes, f.candidate_note, id]
      );
      if (status === "completed") {
        await queryDB("UPDATE job_candidates SET status = ? WHERE id = ?", ["interviewed", existing.candidate_id]);
      }
      const rows: any = await queryDB("SELECT * FROM candidate_interviews WHERE id = ?", [id]);
      const now = rows[0];
      // What changed, for the history and the interviewer's alert.
      const cands: any = await queryDB("SELECT name FROM job_candidates WHERE id = ?", [Number(existing.candidate_id)]);
      const candName = cands[0]?.name || "Candidate";
      const timeMoved = String(existing.scheduled_at || "") !== String(now.scheduled_at || "");
      const placeMoved = (placeOf(existing) || "") !== (placeOf(now) || "");
      if (existing.status === "cancelled" && status === "scheduled") {
        await logEvent(now, "scheduled", null, reason, req.user.id);
        await alertInterviewer(now.interviewer_id, req.user.id, "Interview scheduled", now, candName);
      } else if (status === "cancelled" && existing.status !== "cancelled") {
        await logEvent(now, "cancelled", existing, reason, req.user.id);
        await alertInterviewer(now.interviewer_id, req.user.id, "Interview cancelled", now, candName);
      } else if (status === "scheduled" && (timeMoved || placeMoved)) {
        await logEvent(now, timeMoved ? "rescheduled" : "venue_changed", existing, reason, req.user.id);
        await alertInterviewer(now.interviewer_id, req.user.id, timeMoved ? "Interview moved" : "Interview place changed", now, candName);
      }
      if (status === "scheduled" && existing.status !== "cancelled" && Number(existing.interviewer_id || 0) !== Number(now.interviewer_id || 0)) {
        await logEvent(now, "interviewer", existing, reason, req.user.id);
        await alertInterviewer(now.interviewer_id, req.user.id, "Interview scheduled", now, candName);
        await alertInterviewer(existing.interviewer_id, req.user.id, "Interview cancelled", now, candName);
      }
      res.json(now);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- Email the candidate (layer "email_candidates") ----------
  // The draft the popup shows; the person can change the subject and text
  // before sending. Interview details come from the interview as saved.
  const buildDraft = async (candidateId: number, interviewId: number | null, kind: EmailKind, senderId: number) => {
    const cands: any = await queryDB("SELECT * FROM job_candidates WHERE id = ?", [candidateId]);
    if (!cands.length) return { error: "Candidate not found.", code: 404 } as const;
    const c = cands[0];
    const postings: any = await queryDB("SELECT title FROM job_postings WHERE id = ?", [Number(c.posting_id)]);
    const job = postings[0]?.title || "the position";
    const senders: any = await queryDB("SELECT name FROM users WHERE id = ?", [senderId]);
    const sign = `Regards,\n${senders[0]?.name || "HR"}\nHR Department`;
    let interview: any = null;
    if (kind.startsWith("interview_")) {
      if (!interviewId) return { error: "Choose the interview this email is about.", code: 400 } as const;
      const rows: any = await queryDB("SELECT * FROM candidate_interviews WHERE id = ?", [interviewId]);
      if (!rows.length || Number(rows[0].candidate_id) !== candidateId) return { error: "Interview not found for this candidate.", code: 404 } as const;
      interview = rows[0];
      if (kind !== "interview_cancelled" && !interview.scheduled_at) return { error: "Set the interview date and time first.", code: 400 } as const;
    }
    const hello = `Dear ${c.name},`;
    const details = interview
      ? [`Position: ${job}`, `Date & time: ${prettyWhen(interview.scheduled_at)}`, `Duration: about ${Number(interview.duration_minutes) || 60} minutes`, `Where: ${whereLine(interview)}`, ...(interview.candidate_note ? [`Note: ${interview.candidate_note}`] : [])].join("\n")
      : "";
    const drafts: Record<EmailKind, { subject: string; body: string }> = {
      interview_scheduled: {
        subject: `Interview invitation — ${job}`,
        body: `${hello}\n\nThank you for applying. We would like to invite you to an interview.\n\n${details}\n\nPlease reply to this email to confirm, or if you need another time.\n\n${sign}`
      },
      interview_rescheduled: {
        subject: `Interview time changed — ${job}`,
        body: `${hello}\n\nYour interview has been changed. The new details are:\n\n${details}\n\nWe are sorry for any trouble. Please reply to confirm the new time.\n\n${sign}`
      },
      interview_cancelled: {
        subject: `Interview cancelled — ${job}`,
        body: `${hello}\n\nWe are sorry to let you know that your interview for ${job}${interview?.scheduled_at ? ` on ${prettyWhen(interview.scheduled_at)}` : ""} has been cancelled. We will contact you if a new time is set.\n\n${sign}`
      },
      offered: {
        subject: `Job offer — ${job}`,
        body: `${hello}\n\nWe are happy to offer you the position of ${job}. We will share the offer letter and joining details with you shortly.\n\n${sign}`
      },
      rejected: {
        subject: `Your application — ${job}`,
        body: `${hello}\n\nThank you for your interest in ${job} and for the time you gave us. After careful thought we will not be moving forward with your application this time. We wish you every success.\n\n${sign}`
      },
      custom: { subject: `About your application — ${job}`, body: `${hello}\n\n\n\n${sign}` }
    };
    return { candidate: c, interview, job, ...drafts[kind] } as const;
  };

  const readKind = (v: any): EmailKind | null => ((EMAIL_KINDS as readonly string[]).includes(v) ? (v as EmailKind) : null);

  app.post("/api/candidate-emails/draft", ...emailGate, async (req: any, res: any) => {
    try {
      const body = req.body || {};
      const kind = readKind(body.kind);
      if (!kind) return res.status(400).json({ error: "Unknown email type." });
      const d: any = await buildDraft(Number(body.candidate_id), body.interview_id ? Number(body.interview_id) : null, kind, req.user.id);
      if (d.error) return res.status(d.code).json({ error: d.error });
      res.json({ to: d.candidate.email || null, subject: d.subject, body: d.body, calendar: !!d.interview && !!d.interview.scheduled_at, mail_ready: isMailerConfigured() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/candidate-emails/send", ...emailGate, async (req: any, res: any) => {
    try {
      const body = req.body || {};
      const kind = readKind(body.kind);
      if (!kind) return res.status(400).json({ error: "Unknown email type." });
      const candidateId = Number(body.candidate_id);
      const interviewId = body.interview_id ? Number(body.interview_id) : null;
      const d: any = await buildDraft(candidateId, interviewId, kind, req.user.id);
      if (d.error) return res.status(d.code).json({ error: d.error });
      const to = String(d.candidate.email || "").trim();
      if (!EMAIL_RE.test(to)) return res.status(400).json({ error: "This candidate has no valid email address. Add one first." });
      const subject = (cleanText(body.subject, 255) || d.subject).replace(/[\r\n]+/g, " ");
      const text = cleanText(body.body, 8000) || d.body;
      const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#1e293b">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`;
      const attachments = [];
      const seqRows: any = d.interview ? await queryDB("SELECT id FROM candidate_interview_events WHERE interview_id = ?", [Number(d.interview.id)]).catch(() => []) : [];
      const coversEventId = seqRows.reduce((m: number, e: any) => Math.max(m, Number(e.id)), 0) || null;
      if (d.interview && d.interview.scheduled_at) {
        const ics = buildIcs(d.interview, `Interview — ${d.job}`, Math.max(0, seqRows.length - 1), kind === "interview_cancelled");
        attachments.push({ filename: kind === "interview_cancelled" ? "cancelled.ics" : "interview.ics", content: Buffer.from(ics, "utf8"), contentType: `text/calendar; charset=utf-8; method=${kind === "interview_cancelled" ? "CANCEL" : "REQUEST"}` });
      }
      const result = await sendMail({ to, subject, html, attachments });
      await queryDB(
        "INSERT INTO candidate_emails (candidate_id, interview_id, kind, to_email, subject, body, status, error, covers_event_id, sent_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [candidateId, d.interview ? Number(d.interview.id) : null, kind, to, subject, text, result.success ? "sent" : "failed", result.success ? null : String(result.error || "").slice(0, 500), coversEventId, req.user.id]
      );
      if (!result.success) return res.status(502).json({ error: `The email could not be sent: ${result.error}` });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
