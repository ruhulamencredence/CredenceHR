/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Email a report: the "Email" button next to every report's PDF button
// (src/lib/reportEmail.ts, EmailReportPopup.tsx). The browser builds the
// same PDF the PDF button saves and sends it here; it goes out as an
// attachment through the server's SMTP mailer (mailer.ts).
//
//   users.can_email_reports — OFF by default, turned on per account in
//   Admin Panel -> Users -> Module Access. A Superadmin always passes. The
//   report itself is one the sender could already open and export.
//
//   GET  /api/reports/email/access      — { allowed, mailer }
//   GET  /api/reports/email/recipients  — people to pick (name + email)
//   POST /api/reports/email             — send it
//
// Every send is logged in report_email_log (who, to whom, what, when).

import type { Express } from "express";
import { isMailerConfigured, sendMail } from "./mailer";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface ReportEmailDeps {
  authenticateToken: any;
  queryDB: QueryDB;
}

export const MAX_REPORT_RECIPIENTS = 25;
const MAX_PDF_BYTES = 12 * 1024 * 1024;
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

export async function ensureReportEmailSchema(dbPool: any): Promise<void> {
  const run = async (label: string, sql: string, ignore: string[] = []) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      if (!ignore.includes(err.code)) console.warn(`⚠️ Report email (${label}): ${err.message}`);
    }
  };
  await run("users.can_email_reports", "ALTER TABLE users ADD COLUMN can_email_reports TINYINT(1) NOT NULL DEFAULT 0", ["ER_DUP_FIELDNAME"]);
  await run(
    "report_email_log",
    `CREATE TABLE IF NOT EXISTS report_email_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NULL,
      sent_by INT NULL,
      report_title VARCHAR(255) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      recipients_json TEXT NOT NULL,
      failed_json TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_report_email_log_sender (sent_by, created_at)
    )`
  );
}

export async function canEmailReports(queryDB: QueryDB, userId: number): Promise<boolean> {
  const u = ((await queryDB("SELECT role, can_email_reports, is_onboarding FROM users WHERE id = ?", [userId]).catch(() => [])) || [])[0];
  return !!u && (u.role === "superadmin" || (Number(u.can_email_reports) === 1 && !Number(u.is_onboarding)));
}

const esc = (v: any) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// The email body for a report with its file attached.
export function reportEmailHtml(opts: { title: string; message?: string | null; senderName: string; companyName?: string | null; fileName: string }): string {
  const msg = String(opts.message || "").trim();
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;max-width:640px">
${msg ? `${esc(msg).split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px;line-height:1.5">${p.replace(/\n/g, "<br>")}</p>`).join("\n")}` : `<p style="margin:0 0 12px">Please find the attached report.</p>`}
<table style="border-collapse:collapse;margin:8px 0 16px;font-size:13px">
<tr><td style="padding:2px 12px 2px 0;color:#64748b">Report</td><td style="padding:2px 0;font-weight:bold">${esc(opts.title)}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#64748b">File</td><td style="padding:2px 0">${esc(opts.fileName)}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#64748b">Sent by</td><td style="padding:2px 0">${esc(opts.senderName)}</td></tr>
</table>
<p style="margin:0;color:#94a3b8;font-size:12px">Sent from CredenceHR${opts.companyName ? ` — ${esc(opts.companyName)}` : ""}.</p>
</div>`;
}

export function registerReportEmailRoutes(app: Express, { authenticateToken, queryDB }: ReportEmailDeps) {
  const gate = async (req: any, res: any, next: any) => {
    if (!(await canEmailReports(queryDB, Number(req.user.id)))) return res.status(403).json({ error: "Emailing reports isn't turned on for your account." });
    next();
  };

  app.get("/api/reports/email/access", authenticateToken, async (req: any, res: any) => {
    res.json({ allowed: await canEmailReports(queryDB, Number(req.user.id)), mailer: isMailerConfigured() });
  });

  app.get("/api/reports/email/recipients", authenticateToken, gate, async (req: any, res: any) => {
    try {
      const rows: any[] =
        (await queryDB(
          `SELECT u.id, u.name, u.email, e.personal_email, e.designation, e.department
             FROM users u LEFT JOIN all_employees e ON e.user_id = u.id
            WHERE COALESCE(u.is_blocked, 0) = 0 AND COALESCE(u.is_onboarding, 0) = 0`
        )) || [];
      res.json(
        rows
          .map((r) => ({ id: Number(r.id), name: r.name, email: r.email || r.personal_email || null, designation: r.designation || null, department: r.department || null }))
          .filter((r) => r.email)
          .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/reports/email", authenticateToken, gate, async (req: any, res: any) => {
    try {
      const b = req.body || {};
      const title = String(b.title || "").trim().slice(0, 200) || "Report";
      let fileName = String(b.file_name || "").trim().replace(/[\\/:*?"<>|]+/g, "_").slice(0, 150) || "report.pdf";
      if (!/\.(pdf|xlsx)$/i.test(fileName)) fileName += ".pdf";
      const subject = String(b.subject || "").trim().slice(0, 200) || title;
      const message = String(b.message || "").slice(0, 4000);
      const raw = String(b.file_base64 || "").replace(/^data:[^,]*,/, "");
      const content = Buffer.from(raw, "base64");
      if (!content.length) return res.status(400).json({ error: "The report file is missing." });
      if (content.length > MAX_PDF_BYTES) return res.status(413).json({ error: "This report is too big to email (over 12 MB). Narrow the filters and try again." });
      const isPdf = content.subarray(0, 5).toString("latin1") === "%PDF-";
      const isXlsx = content[0] === 0x50 && content[1] === 0x4b; // zip
      if (!(fileName.toLowerCase().endsWith(".pdf") ? isPdf : isXlsx)) return res.status(400).json({ error: "Only a PDF or Excel report can be emailed." });

      // Recipients: picked people (their email on file) plus typed addresses.
      const ids = [...new Set((Array.isArray(b.user_ids) ? b.user_ids : []).map(Number).filter((n: number) => n > 0))];
      const typed = [...new Set((Array.isArray(b.emails) ? b.emails : []).map((e: any) => String(e).trim().toLowerCase()).filter(Boolean))] as string[];
      const bad = typed.filter((e) => !EMAIL_RE.test(e) || e.length > 254);
      if (bad.length) return res.status(400).json({ error: `Not an email address: ${bad.join(", ")}` });
      const people: any[] = ids.length
        ? (await queryDB(
            `SELECT u.id, u.name, u.email, e.personal_email FROM users u LEFT JOIN all_employees e ON e.user_id = u.id
              WHERE u.id IN (${ids.map(() => "?").join(",")}) AND COALESCE(u.is_blocked, 0) = 0`,
            ids
          )) || []
        : [];
      const to = new Map<string, string>();
      for (const p of people) {
        const e = String(p.email || p.personal_email || "").trim().toLowerCase();
        if (e) to.set(e, p.name);
      }
      for (const e of typed) if (!to.has(e)) to.set(e, e);
      if (to.size === 0) return res.status(400).json({ error: "Pick at least one person or type an email address." });
      if (to.size > MAX_REPORT_RECIPIENTS) return res.status(400).json({ error: `At most ${MAX_REPORT_RECIPIENTS} recipients at a time.` });
      if (!isMailerConfigured()) return res.status(400).json({ error: "Email isn't set up on the server yet (SMTP settings). Ask the Superadmin." });

      const me = ((await queryDB("SELECT name FROM users WHERE id = ?", [req.user.id])) || [])[0];
      const company = ((await queryDB("/*unscoped*/ SELECT name FROM companies WHERE id = ?", [req.companyId ?? 1]).catch(() => [])) || [])[0];
      const html = reportEmailHtml({ title, message, senderName: me?.name || "CredenceHR", companyName: company?.name, fileName });
      const attachments = [{ filename: fileName, content, contentType: isPdf ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }];
      const sent: string[] = [];
      const failed: { email: string; error: string }[] = [];
      // One email per recipient, so nobody sees the others' addresses.
      for (const email of to.keys()) {
        const r = await sendMail({ to: email, subject, html, attachments });
        if (r.success) sent.push(email);
        else failed.push({ email, error: r.error || "Failed" });
      }
      await queryDB(
        "INSERT INTO report_email_log (company_id, sent_by, report_title, file_name, recipients_json, failed_json) VALUES (?, ?, ?, ?, ?, ?)",
        [req.companyId ?? null, req.user.id, title, fileName, JSON.stringify(sent), failed.length ? JSON.stringify(failed) : null]
      ).catch(() => {});
      if (!sent.length) return res.status(502).json({ error: failed[0]?.error || "Couldn't send the email.", failed });
      res.json({ success: true, sent, failed });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
