/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll -> Approval: a salary month goes HR -> HR Director -> MD (on
// paper) -> HR (corrections) -> Accounts, and Audit may look at it after.
//
//   draft        HR generates and checks the month's runs
//   hrd_review   HR "Send to HR Director" — runs locked. The HR Director
//                reviews it in the app (layer "hrd_review"), or on paper and
//                HR attaches the returned copy (payroll_review_files)
//   md_review    printed for the MD, who reviews on paper — runs locked
//   corrections  the MD's copy came back with changes: HR attaches its scan
//                and enters each correction (payroll_corrections) — "Apply"
//                makes the change on the run itself
//   approved     ready for Accounts (MD signed with no changes, or HR sent
//                it on after the corrections); unpaid runs become Processed
//   returned     sent back to HR (HR Director / Accounts / HR's own recall)
//   paid         Accounts paid it (layer "accounts_pay") — every Processed
//                run becomes Paid (advance installments are recovered then)
//   + audit      optional, after payment (layer "audit_approve"): "Audited
//                — OK" or an audit note (post_audit_*). Never blocks paying.
//
// Duties stay apart (a Superadmin excepted): whoever ran any of the month's
// salaries or submitted it can't approve it, and whoever ran, submitted or
// approved it can't pay it. "View only" (payroll_view) lets Audit and
// Accounts read every Payroll page without HR's "read" layer. A salary on hold is
// left out; once released, Audit processes it and Accounts pays it on its
// own (the per-run Process / Mark Paid buttons, now behind the same layers).
//
// Payroll -> Activity Log (Payroll layer "access_log"): who opened Payroll,
// which pages they looked at, and everything they did there
// (payroll_access_log). Actions are logged on the server for every write to
// /api/payroll/*; the page reports the pages / tabs it opens.

import express, { type Express } from "express";
import fs from "fs";
import type { AlertType } from "./Alerts";
import { refreshRunItems, finesByRun } from "./PayrollItemsRoutes";
import { PAYROLL_FILE_MAX_BYTES, looksLikeType, payrollFileExtension, removePayrollFile, resolvePayrollPath, savePayrollFile } from "./payrollFiles";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;
type CreateAlert = (
  queryDB: QueryDB,
  params: { userId: number; type: AlertType; title: string; message: string; relatedType?: string; relatedId?: number }
) => Promise<void>;
type PayrollLayer = "read" | "payroll_view" | "salary_month" | "salary_hold" | "audit_approve" | "accounts_pay" | "access_log" | "approval_sheet" | "month_compare" | "top_sheet" | "hrd_review";

interface PayrollApprovalDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (moduleKey: "payroll") => any;
  requireModuleLayer: (moduleKey: "payroll", layer: PayrollLayer) => any;
  hasModuleLayer: (user: any, moduleKey: "payroll", layer: PayrollLayer) => Promise<boolean>;
  queryDB: QueryDB;
  createAlert: CreateAlert;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const LOCKED_BATCH = new Set(["submitted", "hrd_review", "md_review", "approved", "paid"]);
const money = (v: any) => Math.round((Number(v) || 0) * 100) / 100;
const tk = (v: any) => `৳${money(v).toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthText = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
};

export async function ensurePayrollApprovalSchema(dbPool: any) {
  if (!dbPool) return;
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS payroll_batches (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL DEFAULT 1,
      month_year VARCHAR(7) NOT NULL,
      status ENUM('draft','submitted','approved','returned','paid') NOT NULL DEFAULT 'draft',
      submitted_by INT NULL,
      submitted_at TIMESTAMP NULL DEFAULT NULL,
      audited_by INT NULL,
      audited_at TIMESTAMP NULL DEFAULT NULL,
      audit_note VARCHAR(1000) NULL,
      paid_by INT NULL,
      paid_at TIMESTAMP NULL DEFAULT NULL,
      payment_date DATE NULL,
      payment_method VARCHAR(50) NULL,
      payment_reference VARCHAR(150) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_payroll_batch (company_id, month_year)
    )
  `);
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS payroll_batch_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL DEFAULT 1,
      batch_id INT NOT NULL,
      action VARCHAR(30) NOT NULL,
      user_id INT NULL,
      note VARCHAR(1000) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_pbe_batch (batch_id)
    )
  `);
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS payroll_access_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL DEFAULT 1,
      user_id INT NULL,
      user_name VARCHAR(150) NULL,
      kind VARCHAR(10) NOT NULL,
      area VARCHAR(120) NOT NULL,
      detail VARCHAR(500) NULL,
      ip VARCHAR(64) NULL,
      device VARCHAR(200) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_pal_time (created_at),
      INDEX idx_pal_user (user_id)
    )
  `);
  // The review steps (HR Director, MD on paper, corrections) and the
  // optional audit after payment.
  await dbPool
    .query("ALTER TABLE payroll_batches MODIFY COLUMN status ENUM('draft','submitted','hrd_review','md_review','corrections','approved','returned','paid') NOT NULL DEFAULT 'draft'")
    .catch((e: any) => console.warn("⚠️ payroll_batches.status: " + e.message));
  for (const [col, def] of [
    ["hrd_by", "INT NULL"],
    ["hrd_at", "TIMESTAMP NULL DEFAULT NULL"],
    ["hrd_note", "VARCHAR(1000) NULL"],
    ["hrd_mode", "VARCHAR(10) NULL"],
    ["md_sent_at", "TIMESTAMP NULL DEFAULT NULL"],
    ["md_sent_by", "INT NULL"],
    ["md_back_at", "TIMESTAMP NULL DEFAULT NULL"],
    ["md_back_by", "INT NULL"],
    ["md_received_date", "DATE NULL"],
    ["md_signed", "TINYINT(1) NULL"],
    ["print_version", "INT NOT NULL DEFAULT 0"],
    ["sent_accounts_by", "INT NULL"],
    ["sent_accounts_at", "TIMESTAMP NULL DEFAULT NULL"],
    ["post_audit_status", "VARCHAR(10) NULL"],
    ["post_audit_by", "INT NULL"],
    ["post_audit_at", "TIMESTAMP NULL DEFAULT NULL"],
    ["post_audit_note", "VARCHAR(1000) NULL"]
  ]) {
    await dbPool.query(`ALTER TABLE payroll_batches ADD COLUMN ${col} ${def}`).catch((err: any) => {
      if (err?.code !== "ER_DUP_FIELDNAME") console.warn(`⚠️ payroll_batches.${col}: ${err.message}`);
    });
  }
  // A month that was "with Audit" before Audit moved after payment is now
  // with the HR Director.
  await dbPool.query("UPDATE payroll_batches SET status = 'hrd_review' WHERE status = 'submitted'").catch(() => {});
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS payroll_review_files (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL DEFAULT 1,
      batch_id INT NOT NULL,
      stage ENUM('hrd','md') NOT NULL,
      original_name VARCHAR(255) NOT NULL,
      mimetype VARCHAR(100) NOT NULL,
      size_bytes INT NOT NULL,
      file_path VARCHAR(500) NOT NULL,
      uploaded_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_prf_batch (batch_id)
    )
  `);
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS payroll_corrections (
      id INT AUTO_INCREMENT PRIMARY KEY,
      company_id INT NOT NULL DEFAULT 1,
      batch_id INT NOT NULL,
      payroll_id INT NOT NULL,
      employee_id INT NOT NULL,
      source ENUM('md','hrd') NOT NULL DEFAULT 'md',
      kind ENUM('waive_late','waive_fine','add','cut','other') NOT NULL,
      amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
      note VARCHAR(500) NOT NULL,
      page VARCHAR(20) NULL,
      status ENUM('open','applied','not_done') NOT NULL DEFAULT 'open',
      result_note VARCHAR(500) NULL,
      pay_item_id INT NULL,
      net_before DECIMAL(10, 2) NULL,
      net_after DECIMAL(10, 2) NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      done_by INT NULL,
      done_at TIMESTAMP NULL DEFAULT NULL,
      INDEX idx_pc_batch (batch_id)
    )
  `);
  // payrolls: what Accounts recorded when it was paid.
  // last_edited_by: who last changed a run by hand (PUT /api/payroll/:id) —
  // like generated_by, that person can't approve or pay it.
  for (const [col, def] of [
    ["payment_date", "DATE NULL"],
    ["payment_reference", "VARCHAR(150) NULL"],
    ["last_edited_by", "INT NULL"]
  ]) {
    try {
      await dbPool.query(`ALTER TABLE payrolls ADD COLUMN ${col} ${def}`);
    } catch (err: any) {
      if (err?.code !== "ER_DUP_FIELDNAME") console.warn(`⚠️ Could not add payrolls.${col}: ${err.message}`);
    }
  }
}

// The month's batch row, or null while it's still a draft nobody submitted.
export async function batchFor(queryDB: QueryDB, monthYear: string): Promise<any | null> {
  const rows: any[] = (await queryDB("SELECT * FROM payroll_batches WHERE month_year = ?", [monthYear])) || [];
  return rows[0] || null;
}
export async function monthLocked(queryDB: QueryDB, monthYear: string): Promise<string | null> {
  const b = await batchFor(queryDB, monthYear);
  return b && LOCKED_BATCH.has(b.status) ? b.status : null;
}
export const lockedMessage = (status: string) =>
  status === "paid"
    ? "This month's salary is already paid — it can't be changed."
    : status === "approved"
    ? "This month's salary is with Accounts — ask Accounts to return it before changing anything."
    : status === "md_review"
    ? "This month's salary sheet is with the MD — wait for his copy (or recall it) before changing anything."
    : "This month's salary is with the HR Director — ask for it back before changing anything.";

// Marks one run Paid and recovers its advance installment — the same thing
// the per-run "Mark Paid" always did, shared with Accounts' month payment.
export async function settlePaidPayroll(
  queryDB: QueryDB,
  payroll: any,
  userId: number,
  payment?: { date: string; method: string | null; reference: string | null }
): Promise<boolean> {
  // Marked Paid first, and only if it wasn't already: a second click (or a
  // second Accounts person at the same moment) changes nothing and never
  // recovers the loan installment twice.
  const done: any = await queryDB(
    "UPDATE payrolls SET payment_status = 'paid', paid_by = ?, paid_at = CURRENT_TIMESTAMP, payment_date = ?, payment_reference = ?, payment_method = COALESCE(?, payment_method) WHERE id = ? AND payment_status <> 'paid'",
    [userId, payment?.date || null, payment?.reference || null, payment?.method || null, payroll.id]
  );
  if (done && done.affectedRows === 0) return false;
  let remainingToRecover = Number(payroll.advance_deduction) || 0;
  if (remainingToRecover > 0) {
    const advances: any[] = await queryDB("SELECT * FROM employee_advances WHERE employee_id = ? AND status = 'active' ORDER BY created_at ASC", [payroll.employee_id]);
    for (const adv of advances) {
      if (remainingToRecover <= 0) break;
      const outstanding = Number(adv.total_amount) - Number(adv.paid_amount);
      if (outstanding <= 0) continue;
      const recover = money(Math.min(Number(adv.monthly_installment), outstanding, remainingToRecover));
      if (recover <= 0) continue;
      const newPaid = money(Number(adv.paid_amount) + recover);
      await queryDB("UPDATE employee_advances SET paid_amount = ?, status = ? WHERE id = ?", [newPaid, newPaid >= Number(adv.total_amount) ? "completed" : "active", adv.id]);
      remainingToRecover = money(remainingToRecover - recover);
    }
  }
  return true;
}

// Who holds a Payroll layer (Superadmins always do).
async function layerHolders(queryDB: QueryDB, layer: PayrollLayer): Promise<number[]> {
  const [supers, rows]: any[] = await Promise.all([
    queryDB("SELECT id FROM users WHERE role = 'superadmin'"),
    queryDB("SELECT DISTINCT l.user_id FROM admin_module_permission_layers l WHERE l.module_key = 'payroll' AND l.layer_key = ?", [layer]).catch(() => [])
  ]);
  return Array.from(new Set([...(supers || []), ...(rows || [])].map((r: any) => Number(r.id ?? r.user_id)).filter(Boolean)));
}

export function registerPayrollApprovalRoutes(app: Express, deps: PayrollApprovalDeps) {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, hasModuleLayer, queryDB, createAlert } = deps;
  const gate = [authenticateToken, requireAdmin, requireModule("payroll")];
  const bad = (res: any, msg: string, code = 400) => res.status(code).json({ error: msg });

  // ---- activity log: every write to /api/payroll/* -----------------------
  const ipOf = (req: any) => String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim().slice(0, 64);
  async function logAccess(req: any, kind: string, area: string, detail: string | null) {
    if (!req.user) return;
    await queryDB("INSERT INTO payroll_access_log (user_id, user_name, kind, area, detail, ip, device) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      req.user.id,
      String(req.user.name || req.user.email || "").slice(0, 150),
      kind,
      area.slice(0, 120),
      detail ? detail.slice(0, 500) : null,
      ipOf(req),
      String(req.headers["user-agent"] || "").slice(0, 200)
    ]).catch(() => {});
  }
  const ACTION_NAMES: [RegExp, string][] = [
    [/^\/approval\/[^/]+\/submit$/, "Send to HR Director"],
    [/^\/approval\/[^/]+\/hrd-done$/, "HR Director reviewed"],
    [/^\/approval\/[^/]+\/md-back$/, "MD's copy back"],
    [/^\/approval\/[^/]+\/corrections/, "MD correction"],
    [/^\/approval\/[^/]+\/to-accounts$/, "Send to Accounts"],
    [/^\/approval\/[^/]+\/files/, "Attach reviewed copy"],
    [/^\/approval\/[^/]+\/printed$/, "Print salary sheet"],
    [/^\/approval\/[^/]+\/audit$/, "Audit (after payment)"],
    [/^\/approval\/[^/]+\/return$/, "Return to HR"],
    [/^\/approval\/[^/]+\/pay$/, "Accounts Pay"],
    [/^\/generate-bulk$/, "Run Payroll (bulk)"],
    [/^\/generate$/, "Run Payroll"],
    [/^\/generate-preview$/, "Run Payroll preview"],
    [/^\/\d+\/process$/, "Process salary"],
    [/^\/\d+\/mark-paid$/, "Mark salary Paid"],
    [/^\/\d+\/hold$/, "Hold salary"],
    [/^\/\d+\/release$/, "Release salary"],
    [/^\/\d+\/email$/, "Email payslip"],
    [/^\/email-bulk$/, "Email payslips (bulk)"],
    [/^\/salary-structures/, "Salary structure"],
    [/^\/salary-components/, "Salary component"],
    [/^\/pay-grades/, "Pay grade"],
    [/^\/advances/, "Loan / advance"],
    [/^\/advance-requests/, "Loan / advance request"],
    [/^\/pending-bonuses/, "Bonus"],
    [/^\/late-policy/, "Late policy"],
    [/^\/late-waivers/, "Late waiver"],
    [/^\/salary-month/, "Salary month setting"],
    [/^\/pay-items/, "Allowance / deduction"],
    [/^\/adjustments/, "Salary adjustment"],
    [/^\/\d+$/, "Salary run"]
  ];
  app.use("/api/payroll", (req: any, res: any, next: any) => {
    // req.path is relative to /api/payroll only while in here — keep it.
    const path = String(req.path || "");
    const write = req.method !== "GET" && path !== "/access-log";
    const viewRun = req.method === "GET" && /^\/\d+$/.test(path);
    if (write || viewRun) {
      res.on("finish", () => {
        // A refused write is kept too ("tried to…"); a failed read isn't.
        if (res.statusCode >= 400 && (viewRun || res.statusCode >= 500)) return;
        const refused = res.statusCode >= 400;
        const name = ACTION_NAMES.find(([re]) => re.test(path))?.[1] || path;
        const verb = req.method === "DELETE" ? "Delete" : req.method === "PUT" ? "Edit" : req.method === "GET" ? "View" : "";
        const b = req.body || {};
        const bits = [
          b.month_year ? `month ${b.month_year}` : /^\/approval\/(\d{4}-\d{2})/.test(path) ? `month ${path.split("/")[2]}` : "",
          b.employee_id ? `employee #${b.employee_id}` : "",
          Array.isArray(b.employee_ids) ? `${b.employee_ids.length} employees` : "",
          /^\/\d+/.test(path) ? `run #${path.split("/")[1]}` : "",
          refused ? `refused (${res.statusCode})` : "",
          b.note || b.reason ? `"${String(b.note || b.reason).slice(0, 120)}"` : ""
        ].filter(Boolean);
        logAccess(req, viewRun ? "view" : "action", [refused ? "Tried:" : "", verb, name].filter(Boolean).join(" "), bits.join(" · ") || null);
      });
    }
    next();
  });

  // The page reports where the person went (open / tabs / reports).
  app.post("/api/payroll/access-log", ...gate, async (req: any, res: any) => {
    const kind = req.body?.kind === "open" ? "open" : "view";
    const area = typeof req.body?.area === "string" ? req.body.area.trim() : "";
    if (!area) return bad(res, "area is required");
    await logAccess(req, kind, area, typeof req.body?.detail === "string" ? req.body.detail : null);
    res.json({ success: true });
  });

  app.get("/api/payroll/access-log", authenticateToken, requireAdmin, requireModuleLayer("payroll", "access_log"), async (req: any, res: any) => {
    try {
      const from = DATE_RE.test(String(req.query.from || "")) ? String(req.query.from) : null;
      const to = DATE_RE.test(String(req.query.to || "")) ? String(req.query.to) : null;
      const where: string[] = [];
      const params: any[] = [];
      if (from) {
        where.push("created_at >= ?");
        params.push(`${from} 00:00:00`);
      }
      if (to) {
        where.push("created_at <= ?");
        params.push(`${to} 23:59:59`);
      }
      if (req.query.user_id) {
        where.push("user_id = ?");
        params.push(Number(req.query.user_id));
      }
      if (["open", "view", "action"].includes(String(req.query.kind))) {
        where.push("kind = ?");
        params.push(String(req.query.kind));
      }
      const rows: any[] = await queryDB(
        `SELECT id, user_id, user_name, kind, area, detail, ip, device, created_at FROM payroll_access_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT 5000`,
        params
      );
      res.json({ rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- what this account may do -----------------------------------------
  app.get("/api/payroll/approval-access", ...gate, async (req: any, res: any) => {
    const [audit, pay, log, edit, sheet, compare, top, hrd] = await Promise.all([
      hasModuleLayer(req.user, "payroll", "audit_approve"),
      hasModuleLayer(req.user, "payroll", "accounts_pay"),
      hasModuleLayer(req.user, "payroll", "access_log"),
      hasModuleLayer(req.user, "payroll", "read"),
      hasModuleLayer(req.user, "payroll", "approval_sheet"),
      hasModuleLayer(req.user, "payroll", "month_compare"),
      hasModuleLayer(req.user, "payroll", "top_sheet"),
      hasModuleLayer(req.user, "payroll", "hrd_review")
    ]);
    // edit = HR's "Payroll" layer; without it the account only views.
    // approval_sheet = the Salary sheet table in Approval.
    res.json({ audit_approve: audit, accounts_pay: pay, access_log: log, edit, approval_sheet: sheet, month_compare: compare, top_sheet: top, hrd_review: hrd });
  });

  // ---- one month's approval state ---------------------------------------
  async function monthRuns(monthYear: string) {
    return ((await queryDB(
      `SELECT p.id, p.employee_id, p.net_salary, p.payment_status, p.is_held, p.hold_reason, p.payment_date, p.payment_reference, p.generated_by, p.last_edited_by,
              e.name AS employee_name, e.employee_id AS employee_code, e.department, e.designation, e.user_id
         FROM payrolls p JOIN all_employees e ON e.id = p.employee_id
        WHERE p.month_year = ? ORDER BY e.name ASC`,
      [monthYear]
    )) || []) as any[];
  }
  async function userNames(ids: any[]) {
    const list = Array.from(new Set(ids.filter(Boolean).map(Number)));
    if (!list.length) return new Map<number, string>();
    const rows: any[] = await queryDB(`SELECT id, name FROM users WHERE id IN (${list.map(() => "?").join(",")})`, list);
    return new Map<number, string>(rows.map((r: any) => [Number(r.id), r.name]));
  }
  // Why this account may not approve / pay the month (null = it may).
  // A Superadmin is never stopped.
  // The HR Director reviewing in the app can't be the one who sent it.
  function hrdConflict(user: any, b: any, runs: any[]): string | null {
    if (user.role === "superadmin") return null;
    if (Number(b?.submitted_by) === Number(user.id)) return "You sent this salary sheet — another HR Director has to review it.";
    if (runs.some((r) => Number(r.generated_by) === Number(user.id) || Number(r.last_edited_by) === Number(user.id))) return "You ran or changed payroll for some employees in this month — another HR Director has to review it.";
    return null;
  }
  // Audit after payment: not someone who prepared, sent on or paid it.
  function auditConflict(user: any, b: any, runs: any[]): string | null {
    if (user.role === "superadmin") return null;
    if ([b?.submitted_by, b?.sent_accounts_by, b?.paid_by].some((id) => Number(id) === Number(user.id))) return "You prepared, sent on or paid this salary — someone else has to audit it.";
    if (runs.some((r) => Number(r.generated_by) === Number(user.id) || Number(r.last_edited_by) === Number(user.id))) return "You ran or changed payroll for some employees in this month — someone else has to audit it.";
    return null;
  }
  function payConflict(user: any, b: any, runs: any[]): string | null {
    if (user.role === "superadmin") return null;
    if (Number(b?.submitted_by) === Number(user.id)) return "You submitted this salary sheet — someone else from Accounts has to pay it.";
    if (Number(b?.sent_accounts_by) === Number(user.id)) return "You sent this salary sheet to Accounts — someone else from Accounts has to pay it.";
    if (runs.some((r) => Number(r.generated_by) === Number(user.id) || Number(r.last_edited_by) === Number(user.id))) return "You ran or changed payroll for some employees in this month — someone else from Accounts has to pay it.";
    return null;
  }

  async function event(batchId: number, action: string, userId: number, note: string | null) {
    await queryDB("INSERT INTO payroll_batch_events (batch_id, action, user_id, note) VALUES (?, ?, ?, ?)", [batchId, action, userId, note]);
  }
  async function ensureBatch(monthYear: string) {
    let b = await batchFor(queryDB, monthYear);
    if (!b) {
      await queryDB("INSERT INTO payroll_batches (month_year, status) VALUES (?, 'draft')", [monthYear]);
      b = await batchFor(queryDB, monthYear);
    }
    return b;
  }
  async function notify(ids: number[], title: string, message: string, except?: number) {
    for (const id of Array.from(new Set(ids))) {
      if (!id || id === except) continue;
      await createAlert(queryDB, { userId: id, type: "payroll_approval" as AlertType, title, message, relatedType: "payroll_batch" }).catch(() => {});
    }
  }

  app.get("/api/payroll/approval/:month", ...gate, async (req: any, res: any) => {
    try {
      const month = String(req.params.month);
      if (!MONTH_RE.test(month)) return bad(res, "Choose a month.");
      const [b, runs] = await Promise.all([batchFor(queryDB, month), monthRuns(month)]);
      const events: any[] = b ? await queryDB("SELECT * FROM payroll_batch_events WHERE batch_id = ? ORDER BY id ASC", [b.id]) : [];
      const [files, corrs]: any[] = b
        ? await Promise.all([
            queryDB("SELECT id, stage, original_name, mimetype, size_bytes, uploaded_by, created_at FROM payroll_review_files WHERE batch_id = ? ORDER BY id", [b.id]),
            queryDB("SELECT * FROM payroll_corrections WHERE batch_id = ? ORDER BY id", [b.id])
          ])
        : [[], []];
      const names = await userNames([
        b?.submitted_by, b?.audited_by, b?.paid_by, b?.hrd_by, b?.md_sent_by, b?.md_back_by, b?.sent_accounts_by, b?.post_audit_by,
        ...events.map((e) => e.user_id), ...(files || []).map((f: any) => f.uploaded_by), ...(corrs || []).flatMap((c: any) => [c.created_by, c.done_by])
      ]);
      const count = (s: string) => runs.filter((r) => r.payment_status === s).length;
      const [audit, pay, edit, hrd] = await Promise.all([
        hasModuleLayer(req.user, "payroll", "audit_approve"),
        hasModuleLayer(req.user, "payroll", "accounts_pay"),
        hasModuleLayer(req.user, "payroll", "read"),
        hasModuleLayer(req.user, "payroll", "hrd_review")
      ]);
      const status = b?.status || "draft";
      const runById = new Map(runs.map((r) => [Number(r.id), r]));
      const fines = await finesByRun(queryDB, runs.map((r) => Number(r.id)));
      const openCorr = (corrs || []).filter((c: any) => c.status === "open").length;
      const mdFiles = (files || []).filter((f: any) => f.stage === "md").length;
      const hrdFiles = (files || []).filter((f: any) => f.stage === "hrd").length;
      res.json({
        month_year: month,
        status,
        batch: b
          ? {
              submitted_by: names.get(Number(b.submitted_by)) || null,
              submitted_at: b.submitted_at,
              audited_by: names.get(Number(b.audited_by)) || null,
              audited_at: b.audited_at,
              audit_note: b.audit_note,
              paid_by: names.get(Number(b.paid_by)) || null,
              paid_at: b.paid_at,
              payment_date: b.payment_date,
              payment_method: b.payment_method,
              payment_reference: b.payment_reference,
              hrd_by: names.get(Number(b.hrd_by)) || null,
              hrd_at: b.hrd_at,
              hrd_note: b.hrd_note,
              hrd_mode: b.hrd_mode,
              md_sent_at: b.md_sent_at,
              md_back_at: b.md_back_at,
              md_received_date: b.md_received_date,
              md_signed: b.md_signed == null ? null : !!Number(b.md_signed),
              print_version: Number(b.print_version) || 0,
              sent_accounts_by: names.get(Number(b.sent_accounts_by)) || null,
              sent_accounts_at: b.sent_accounts_at,
              post_audit_status: b.post_audit_status || null,
              post_audit_by: names.get(Number(b.post_audit_by)) || null,
              post_audit_at: b.post_audit_at,
              post_audit_note: b.post_audit_note
            }
          : null,
        files: (files || []).map((f: any) => ({ id: Number(f.id), stage: f.stage, name: f.original_name, mimetype: f.mimetype, size: Number(f.size_bytes), by: names.get(Number(f.uploaded_by)) || null, at: f.created_at })),
        corrections: (corrs || []).map((c: any) => {
          const r: any = runById.get(Number(c.payroll_id));
          return {
            id: Number(c.id), payroll_id: Number(c.payroll_id), employee_name: r?.employee_name || "", employee_code: r?.employee_code || "", department: r?.department || "",
            source: c.source, kind: c.kind, amount: money(c.amount), note: c.note, page: c.page, status: c.status, result_note: c.result_note,
            net_before: c.net_before == null ? null : money(c.net_before), net_after: c.net_after == null ? null : money(c.net_after),
            by: names.get(Number(c.created_by)) || null, at: c.created_at, done_by: names.get(Number(c.done_by)) || null, done_at: c.done_at
          };
        }),
        // Who a correction can be for: the month's runs, with what they are known by.
        people: runs.map((r) => ({ payroll_id: Number(r.id), name: r.employee_name, code: r.employee_code || "", designation: r.designation || "", department: r.department || "", net: money(r.net_salary), fine: fines.get(Number(r.id)) || 0 })),
        summary: {
          runs: runs.length,
          total_net: money(runs.reduce((s, r) => s + Number(r.net_salary || 0), 0)),
          payable_net: money(runs.filter((r) => !Number(r.is_held) && r.payment_status !== "paid").reduce((s, r) => s + Number(r.net_salary || 0), 0)),
          unpaid: count("unpaid"),
          processed: count("processed"),
          paid: count("paid"),
          held: runs.filter((r) => Number(r.is_held)).length
        },
        held: runs.filter((r) => Number(r.is_held)).map((r) => ({ name: r.employee_name, code: r.employee_code, reason: r.hold_reason })),
        events: events.map((e) => ({ action: e.action, by: names.get(Number(e.user_id)) || null, note: e.note, at: e.created_at })),
        open_corrections: openCorr,
        can: {
          submit: edit && (status === "draft" || status === "returned") && runs.length > 0,
          // HR Director in the app, or HR recording the HR Director's signed copy.
          hrd_review: hrd && status === "hrd_review" && !hrdConflict(req.user, b, runs),
          hrd_paper: edit && status === "hrd_review",
          md_back: edit && status === "md_review",
          corrections: edit && status === "corrections",
          to_accounts: edit && status === "corrections" && openCorr === 0,
          attach: edit && (status === "hrd_review" || status === "md_review" || status === "corrections"),
          print: edit || hrd,
          recall: edit && (status === "hrd_review" || status === "md_review" || status === "corrections"),
          return_: (hrd && status === "hrd_review") || (pay && status === "approved"),
          pay: pay && status === "approved" && !payConflict(req.user, b, runs),
          audit: audit && status === "paid" && !b?.post_audit_status && !auditConflict(req.user, b, runs)
        },
        // Shown next to a button this account can't use, so it knows why.
        conflict:
          status === "hrd_review" && hrd ? hrdConflict(req.user, b, runs) : status === "approved" && pay ? payConflict(req.user, b, runs) : status === "paid" && audit && !b?.post_audit_status ? auditConflict(req.user, b, runs) : null,
        md_files: mdFiles,
        hrd_files: hrdFiles,
        is_submitter: Number(b?.submitted_by) === Number(req.user.id)
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/payroll/approval/:month/submit", ...gate, async (req: any, res: any) => {
    try {
      const month = String(req.params.month);
      if (!MONTH_RE.test(month)) return bad(res, "Choose a month.");
      const runs = await monthRuns(month);
      if (!runs.length) return bad(res, "Run Payroll for this month first.");
      const b = await ensureBatch(month);
      if (b.status !== "draft" && b.status !== "returned") return bad(res, `This month is already ${b.status}.`);
      const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) || null : null;
      const sub: any = await queryDB(
        "UPDATE payroll_batches SET status = 'hrd_review', submitted_by = ?, submitted_at = CURRENT_TIMESTAMP, audit_note = NULL, hrd_by = NULL, hrd_at = NULL, hrd_note = NULL, hrd_mode = NULL, md_sent_at = NULL, md_back_at = NULL, md_signed = NULL, sent_accounts_by = NULL, sent_accounts_at = NULL WHERE id = ? AND status IN ('draft', 'returned')",
        [req.user.id, b.id]
      );
      if (sub && sub.affectedRows === 0) return bad(res, "This month was just submitted by someone else.", 409);
      await event(b.id, "submitted", req.user.id, note);
      const total = runs.filter((r) => !Number(r.is_held)).reduce((s, r) => s + Number(r.net_salary || 0), 0);
      await notify(
        await layerHolders(queryDB, "hrd_review"),
        "Salary Sheet for HR Director Review",
        `${req.user.name || "HR"} sent the ${monthText(month)} salary (${runs.length} employees, ${tk(total)}) for review. Open Payroll → Approval.`,
        req.user.id
      );
      res.json({ success: true, status: "hrd_review" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Back to HR with a note: the HR Director (in the app), Accounts, or HR
  // itself recalling the sheet (e.g. the paper was lost / needs reprinting).
  app.post("/api/payroll/approval/:month/return", ...gate, async (req: any, res: any) => {
    try {
      const month = String(req.params.month);
      const b = await batchFor(queryDB, month);
      if (!b) return bad(res, "Nothing to return.");
      const [hrd, pay, edit] = await Promise.all([
        hasModuleLayer(req.user, "payroll", "hrd_review"),
        hasModuleLayer(req.user, "payroll", "accounts_pay"),
        hasModuleLayer(req.user, "payroll", "read")
      ]);
      const allowed =
        (b.status === "hrd_review" && (hrd || edit)) || (b.status === "approved" && pay) || ((b.status === "md_review" || b.status === "corrections") && edit);
      if (!allowed) return bad(res, "You can't return this salary sheet now.", 403);
      const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) : "";
      if (!note) return bad(res, "Write why it goes back to HR.");
      const got: any = await queryDB("UPDATE payroll_batches SET status = 'returned', audit_note = ? WHERE id = ? AND status = ?", [note, b.id, b.status]);
      if (got && got.affectedRows === 0) return bad(res, "This salary sheet was just changed by someone else — reload it.", 409);
      const ids = (await monthRuns(month)).filter((r) => r.payment_status === "processed").map((r) => Number(r.id));
      if (ids.length) await queryDB(`UPDATE payrolls SET payment_status = 'unpaid' WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
      await event(b.id, "returned", req.user.id, note);
      await notify([Number(b.submitted_by)], "Salary Sheet Returned to HR", `${req.user.name || "Someone"} returned the ${monthText(month)} salary: ${note}`, req.user.id);
      res.json({ success: true, status: "returned" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // HR Director: reviewed in the app (layer hrd_review), or — on paper — HR
  // records it with the signed copy attached. It then goes to the MD.
  app.post("/api/payroll/approval/:month/hrd-done", ...gate, async (req: any, res: any) => {
    try {
      const month = String(req.params.month);
      const b = await batchFor(queryDB, month);
      if (!b || b.status !== "hrd_review") return bad(res, "This salary sheet isn't with the HR Director.");
      const runs = await monthRuns(month);
      const [hrd, edit] = await Promise.all([hasModuleLayer(req.user, "payroll", "hrd_review"), hasModuleLayer(req.user, "payroll", "read")]);
      const paper = req.body?.mode === "paper";
      const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) || null : null;
      if (paper) {
        if (!edit) return bad(res, "Only HR records the HR Director's paper copy.", 403);
        const f: any[] = await queryDB("SELECT id FROM payroll_review_files WHERE batch_id = ? AND stage = 'hrd'", [b.id]);
        if (!f.length) return bad(res, "Attach the HR Director's signed copy first.");
      } else {
        if (!hrd) return bad(res, "You don't have the HR Director review permission.", 403);
        const c = hrdConflict(req.user, b, runs);
        if (c) return bad(res, c, 403);
      }
      const got: any = await queryDB(
        "UPDATE payroll_batches SET status = 'md_review', hrd_by = ?, hrd_at = CURRENT_TIMESTAMP, hrd_note = ?, hrd_mode = ?, md_sent_at = CURRENT_TIMESTAMP, md_sent_by = ? WHERE id = ? AND status = 'hrd_review'",
        [req.user.id, note, paper ? "paper" : "app", req.user.id, b.id]
      );
      if (got && got.affectedRows === 0) return bad(res, "This salary sheet was just changed by someone else — reload it.", 409);
      await event(b.id, paper ? "hrd_paper" : "hrd_reviewed", req.user.id, note);
      await notify([Number(b.submitted_by)], "Salary Sheet Reviewed by HR Director", `The ${monthText(month)} salary was reviewed${note ? `: ${note}` : ""}. Print it for the MD from Payroll → Approval.`, req.user.id);
      res.json({ success: true, status: "md_review" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // The MD's copy came back (HR records it, with its scan attached): signed
  // with no changes -> to Accounts; with changes -> HR enters the corrections.
  app.post("/api/payroll/approval/:month/md-back", ...gate, async (req: any, res: any) => {
    try {
      if (!(await hasModuleLayer(req.user, "payroll", "read"))) return bad(res, "Only HR records the MD's copy.", 403);
      const month = String(req.params.month);
      const b = await batchFor(queryDB, month);
      if (!b || b.status !== "md_review") return bad(res, "This salary sheet isn't with the MD.");
      const f: any[] = await queryDB("SELECT id FROM payroll_review_files WHERE batch_id = ? AND stage = 'md'", [b.id]);
      if (!f.length) return bad(res, "Attach the scan / photo of the MD's copy first.");
      const changes = !!req.body?.changes;
      const received = DATE_RE.test(String(req.body?.received_date || "")) ? String(req.body.received_date) : null;
      const signed = req.body?.signed === false ? 0 : 1;
      const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) || null : null;
      const next = changes ? "corrections" : "approved";
      const got: any = await queryDB(
        `UPDATE payroll_batches SET status = ?, md_back_at = CURRENT_TIMESTAMP, md_back_by = ?, md_received_date = ?, md_signed = ?${changes ? "" : ", sent_accounts_by = ?, sent_accounts_at = CURRENT_TIMESTAMP"} WHERE id = ? AND status = 'md_review'`,
        changes ? [next, req.user.id, received, signed, b.id] : [next, req.user.id, received, signed, req.user.id, b.id]
      );
      if (got && got.affectedRows === 0) return bad(res, "This salary sheet was just changed by someone else — reload it.", 409);
      if (!changes) await processMonth(month);
      await event(b.id, changes ? "md_corrections" : "md_ok", req.user.id, note);
      if (!changes) await notifyAccounts(month, req.user);
      res.json({ success: true, status: next });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  async function processMonth(month: string) {
    const ids = (await monthRuns(month)).filter((r) => r.payment_status === "unpaid" && !Number(r.is_held)).map((r) => Number(r.id));
    if (ids.length) await queryDB(`UPDATE payrolls SET payment_status = 'processed' WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  }
  async function notifyAccounts(month: string, user: any) {
    const runs = await monthRuns(month);
    const total = runs.filter((r) => !Number(r.is_held)).reduce((s, r) => s + Number(r.net_salary || 0), 0);
    await notify(await layerHolders(queryDB, "accounts_pay"), "Salary Ready to Pay", `The ${monthText(month)} salary (MD reviewed, ${tk(total)}) is ready for Accounts in Payroll → Approval.`, user.id);
  }

  // ---- the MD's corrections, entered by HR from his copy ------------------
  const CORR_KINDS = ["waive_late", "waive_fine", "add", "cut", "other"];
  const CORR_NAME: Record<string, string> = { waive_late: "Late cut waived (MD)", waive_fine: "Fine waived (MD)", add: "Added (MD)", cut: "Deducted (MD)" };
  const CORR_CATEGORY: Record<string, string> = { waive_late: "late_waiver", waive_fine: "fine_waiver", add: "md_correction", cut: "md_correction" };
  const editableCorrections = async (req: any, res: any) => {
    if (!(await hasModuleLayer(req.user, "payroll", "read"))) return void bad(res, "Only HR enters the MD's corrections.", 403);
    const month = String(req.params.month);
    const b = await batchFor(queryDB, month);
    if (!b || b.status !== "corrections") return void bad(res, "Corrections are entered after the MD's copy came back with changes.");
    return b;
  };

  app.post("/api/payroll/approval/:month/corrections", ...gate, async (req: any, res: any) => {
    try {
      const b = await editableCorrections(req, res);
      if (!b) return;
      const month = String(req.params.month);
      const kind = String(req.body?.kind || "");
      if (!CORR_KINDS.includes(kind)) return bad(res, "Choose what changes.");
      const run: any = (await monthRuns(month)).find((r) => Number(r.id) === Number(req.body?.payroll_id));
      if (!run) return bad(res, "Choose an employee from this month's sheet.");
      const amount = money(req.body?.amount);
      if (kind !== "other" && !(amount > 0)) return bad(res, "Enter the amount.");
      const note = String(req.body?.note || "").trim().slice(0, 500);
      if (!note) return bad(res, "Write what the MD wrote.");
      const page = String(req.body?.page || "").trim().slice(0, 20) || null;
      const source = req.body?.source === "hrd" ? "hrd" : "md";
      const r: any = await queryDB(
        "INSERT INTO payroll_corrections (batch_id, payroll_id, employee_id, source, kind, amount, note, page, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [b.id, run.id, run.employee_id, source, kind, amount, note, page, req.user.id]
      );
      res.status(201).json({ id: r.insertId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Apply: the change is made on the run itself — a one-month pay line
  // named after it (so the payslip shows it), the run's totals recalculated.
  // "Other" is done by hand elsewhere and only marked here.
  app.post("/api/payroll/approval/:month/corrections/:id(\\d+)/apply", ...gate, async (req: any, res: any) => {
    try {
      const b = await editableCorrections(req, res);
      if (!b) return;
      const month = String(req.params.month);
      const c: any = ((await queryDB("SELECT * FROM payroll_corrections WHERE id = ? AND batch_id = ?", [Number(req.params.id), b.id])) || [])[0];
      if (!c) return bad(res, "Correction not found.", 404);
      if (c.status !== "open") return bad(res, "This correction is already done.");
      const run: any = ((await queryDB("SELECT * FROM payrolls WHERE id = ?", [c.payroll_id])) || [])[0];
      if (!run || run.payment_status === "paid") return bad(res, "That salary can't be changed any more.");
      const amount = money(c.amount);
      const resultNote = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) || null : null;
      if (c.kind === "waive_late" && amount > money(run.late_deduction_amount) + 0.009) {
        return bad(res, `The late cut on this salary is ${tk(run.late_deduction_amount)} — the waiver can't be more.`);
      }
      if (c.kind === "waive_fine") {
        const fine = (await finesByRun(queryDB, [Number(run.id)])).get(Number(run.id)) || 0;
        if (amount > fine + 0.009) return bad(res, `The fines on this salary come to ${tk(fine)} — the waiver can't be more.`);
      }
      let payItemId: number | null = null;
      let before = money(run.net_salary);
      let after = before;
      if (c.kind !== "other") {
        const it: any = await queryDB(
          `INSERT INTO employee_pay_items (employee_id, component_id, name, kind, amount, start_month, end_month, remarks, is_active, created_by, category)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [run.employee_id, CORR_NAME[c.kind], c.kind === "cut" ? "deduction" : "earning", amount, month, month, String(c.note).slice(0, 255), req.user.id, CORR_CATEGORY[c.kind]]
        );
        payItemId = Number(it.insertId);
        try {
          const r = await refreshRunItems(queryDB, Number(run.id));
          before = r.before;
          after = r.after;
        } catch (e: any) {
          await queryDB("DELETE FROM employee_pay_items WHERE id = ?", [payItemId]);
          return bad(res, e.message);
        }
      }
      await queryDB(
        "UPDATE payroll_corrections SET status = 'applied', pay_item_id = ?, net_before = ?, net_after = ?, result_note = ?, done_by = ?, done_at = CURRENT_TIMESTAMP WHERE id = ?",
        [payItemId, before, after, resultNote, req.user.id, c.id]
      );
      await queryDB("UPDATE payrolls SET last_edited_by = ? WHERE id = ?", [req.user.id, run.id]);
      res.json({ success: true, net_before: before, net_after: after });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Not done (with the reason), e.g. the MD changed his mind.
  app.post("/api/payroll/approval/:month/corrections/:id(\\d+)/skip", ...gate, async (req: any, res: any) => {
    try {
      const b = await editableCorrections(req, res);
      if (!b) return;
      const reason = String(req.body?.note || "").trim().slice(0, 500);
      if (!reason) return bad(res, "Write why it isn't done.");
      const got: any = await queryDB("UPDATE payroll_corrections SET status = 'not_done', result_note = ?, done_by = ?, done_at = CURRENT_TIMESTAMP WHERE id = ? AND batch_id = ? AND status = 'open'", [
        reason, req.user.id, Number(req.params.id), b.id
      ]);
      if (!got?.affectedRows) return bad(res, "Correction not found or already done.");
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Remove a correction (entered by mistake); an applied one is undone.
  app.delete("/api/payroll/approval/:month/corrections/:id(\\d+)", ...gate, async (req: any, res: any) => {
    try {
      const b = await editableCorrections(req, res);
      if (!b) return;
      const c: any = ((await queryDB("SELECT * FROM payroll_corrections WHERE id = ? AND batch_id = ?", [Number(req.params.id), b.id])) || [])[0];
      if (!c) return bad(res, "Correction not found.", 404);
      if (c.pay_item_id) {
        await queryDB("DELETE FROM employee_pay_items WHERE id = ?", [c.pay_item_id]);
        await refreshRunItems(queryDB, Number(c.payroll_id)).catch(() => {});
      }
      await queryDB("DELETE FROM payroll_corrections WHERE id = ?", [c.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Every correction done -> to Accounts.
  app.post("/api/payroll/approval/:month/to-accounts", ...gate, async (req: any, res: any) => {
    try {
      const b = await editableCorrections(req, res);
      if (!b) return;
      const month = String(req.params.month);
      const open: any[] = await queryDB("SELECT id FROM payroll_corrections WHERE batch_id = ? AND status = 'open'", [b.id]);
      if (open.length) return bad(res, `${open.length} correction${open.length === 1 ? " is" : "s are"} still open — apply or mark ${open.length === 1 ? "it" : "them"} first.`);
      const got: any = await queryDB("UPDATE payroll_batches SET status = 'approved', sent_accounts_by = ?, sent_accounts_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'corrections'", [req.user.id, b.id]);
      if (got && got.affectedRows === 0) return bad(res, "This salary sheet was just changed by someone else — reload it.", 409);
      await processMonth(month);
      const done: any[] = await queryDB("SELECT status FROM payroll_corrections WHERE batch_id = ?", [b.id]);
      await event(b.id, "to_accounts", req.user.id, `${done.filter((d) => d.status === "applied").length} corrections applied${done.some((d) => d.status === "not_done") ? `, ${done.filter((d) => d.status === "not_done").length} not done` : ""}`);
      await notifyAccounts(month, req.user);
      res.json({ success: true, status: "approved" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- the returned paper copies (scan / photo) -------------------------
  const rawFile = express.raw({ type: () => true, limit: PAYROLL_FILE_MAX_BYTES });
  app.post("/api/payroll/approval/:month/files", ...gate, rawFile, async (req: any, res: any) => {
    try {
      if (!(await hasModuleLayer(req.user, "payroll", "read"))) return bad(res, "Only HR attaches the reviewed copy.", 403);
      const month = String(req.params.month);
      const b = await batchFor(queryDB, month);
      const stage = req.query.stage === "hrd" ? "hrd" : "md";
      const okStatus = stage === "hrd" ? ["hrd_review"] : ["md_review", "corrections"];
      if (!b || !okStatus.includes(b.status)) return bad(res, stage === "hrd" ? "Attach the HR Director's copy while the sheet is with the HR Director." : "Attach the MD's copy while the sheet is with the MD or in corrections.");
      const mimetype = String(req.query.type || req.headers["content-type"] || "").toLowerCase().split(";")[0].trim();
      const ext = payrollFileExtension(mimetype);
      if (!ext) return bad(res, "Attach a PDF, JPG, PNG or WebP.");
      const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!buf.length) return bad(res, "The file is empty.");
      if (!looksLikeType(buf, mimetype)) return bad(res, "That file isn't really a PDF / picture of that type.");
      const name = String(req.query.name || `copy.${ext}`).replace(/[\r\n"\\/]/g, " ").trim().slice(0, 200) || `copy.${ext}`;
      const stored = await savePayrollFile(buf, ext);
      const r: any = await queryDB(
        "INSERT INTO payroll_review_files (batch_id, stage, original_name, mimetype, size_bytes, file_path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [b.id, stage, name, mimetype, buf.length, stored, req.user.id]
      );
      await event(b.id, "file", req.user.id, `${stage === "hrd" ? "HR Director's" : "MD's"} copy: ${name}`);
      res.status(201).json({ id: r.insertId, name, size: buf.length, mimetype, stage });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/payroll/approval/files/:id(\\d+)", ...gate, async (req: any, res: any) => {
    try {
      // Only the people in this approval chain see the signed copies.
      const may = await Promise.all(["read", "hrd_review", "accounts_pay", "audit_approve", "payroll_view"].map((l) => hasModuleLayer(req.user, "payroll", l as any)));
      if (!may.some(Boolean)) return bad(res, "You can't open this copy.", 403);
      const f: any = ((await queryDB("SELECT * FROM payroll_review_files WHERE id = ?", [Number(req.params.id)])) || [])[0];
      if (!f) return bad(res, "File not found.", 404);
      const full = resolvePayrollPath(f.file_path);
      if (!full || !fs.existsSync(full)) return bad(res, "The file is missing on the server.", 404);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Type", f.mimetype);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
      res.sendFile(full, { dotfiles: "deny", cacheControl: false, lastModified: false });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/payroll/approval/files/:id(\\d+)", ...gate, async (req: any, res: any) => {
    try {
      if (!(await hasModuleLayer(req.user, "payroll", "read"))) return bad(res, "Only HR removes a copy.", 403);
      const f: any = ((await queryDB("SELECT f.*, b.status FROM payroll_review_files f JOIN payroll_batches b ON b.id = f.batch_id WHERE f.id = ?", [Number(req.params.id)])) || [])[0];
      if (!f) return bad(res, "File not found.", 404);
      const okNow = f.stage === "hrd" ? ["hrd_review"] : ["md_review", "corrections"];
      if (!okNow.includes(f.status)) return bad(res, "This month has moved on — that copy stays as it is.");
      await queryDB("DELETE FROM payroll_review_files WHERE id = ?", [f.id]);
      await removePayrollFile(f.file_path);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Printed (for the HR Director / MD / final): each print is a new version
  // number, printed on the paper so an old copy is told apart.
  app.post("/api/payroll/approval/:month/printed", ...gate, async (req: any, res: any) => {
    try {
      const month = String(req.params.month);
      const b = await ensureBatch(month);
      const forWho = ["hrd", "md", "final"].includes(req.body?.for) ? req.body.for : "final";
      await queryDB("UPDATE payroll_batches SET print_version = print_version + 1 WHERE id = ?", [b.id]);
      const v = Number(((await queryDB("SELECT print_version FROM payroll_batches WHERE id = ?", [b.id])) || [])[0]?.print_version) || 1;
      await event(b.id, "printed", req.user.id, `v${v} for ${forWho === "hrd" ? "HR Director" : forWho === "md" ? "MD" : "file / Accounts"}`);
      res.json({ success: true, version: v });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Optional audit after payment: OK, or a note HR and Accounts hear about.
  app.post("/api/payroll/approval/:month/audit", authenticateToken, requireAdmin, requireModuleLayer("payroll", "audit_approve"), async (req: any, res: any) => {
    try {
      const month = String(req.params.month);
      const b = await batchFor(queryDB, month);
      if (!b || b.status !== "paid") return bad(res, "Audit looks at a month after it is paid.");
      if (b.post_audit_status) return bad(res, "This month is already audited.");
      const c = auditConflict(req.user, b, await monthRuns(month));
      if (c) return bad(res, c, 403);
      const result = req.body?.result === "note" ? "note" : "ok";
      const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) : "";
      if (result === "note" && !note) return bad(res, "Write the audit note.");
      const got: any = await queryDB(
        "UPDATE payroll_batches SET post_audit_status = ?, post_audit_by = ?, post_audit_at = CURRENT_TIMESTAMP, post_audit_note = ? WHERE id = ? AND post_audit_status IS NULL",
        [result, req.user.id, note || null, b.id]
      );
      if (got && got.affectedRows === 0) return bad(res, "Someone else just audited it.", 409);
      await event(b.id, result === "ok" ? "audited_ok" : "audit_note", req.user.id, note || null);
      await notify(
        [Number(b.submitted_by), Number(b.paid_by), Number(b.sent_accounts_by)],
        result === "ok" ? "Salary Audited — OK" : "Audit Note on Salary",
        `${req.user.name || "Audit"} ${result === "ok" ? "audited" : "left a note on"} the ${monthText(month)} salary${note ? `: ${note}` : ""}.`,
        req.user.id
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/payroll/approval/:month/pay", authenticateToken, requireAdmin, requireModuleLayer("payroll", "accounts_pay"), async (req: any, res: any) => {
    try {
      const month = String(req.params.month);
      const b = await batchFor(queryDB, month);
      if (!b || b.status !== "approved") return bad(res, "The salary sheet comes to Accounts after the MD's review.");
      const monthList = await monthRuns(month);
      const conflict = payConflict(req.user, b, monthList);
      if (conflict) return bad(res, conflict, 403);
      const date = String(req.body?.payment_date || "");
      if (!DATE_RE.test(date)) return bad(res, "Enter the payment date.");
      const method = typeof req.body?.payment_method === "string" ? req.body.payment_method.trim().slice(0, 50) || null : null;
      const reference = typeof req.body?.payment_reference === "string" ? req.body.payment_reference.trim().slice(0, 150) || null : null;
      if (!method) return bad(res, "Choose how it was paid.");
      // Claim the month first: a second Pay at the same moment stops here.
      const got: any = await queryDB(
        "UPDATE payroll_batches SET status = 'paid', paid_by = ?, paid_at = CURRENT_TIMESTAMP, payment_date = ?, payment_method = ?, payment_reference = ? WHERE id = ? AND status = 'approved'",
        [req.user.id, date, method, reference, b.id]
      );
      if (got && got.affectedRows === 0) return bad(res, "This salary sheet was just paid by someone else.", 409);
      const ids = monthList.filter((r) => r.payment_status === "processed" && !Number(r.is_held)).map((r) => Number(r.id));
      const runs: any[] = ids.length ? await queryDB(`SELECT * FROM payrolls WHERE id IN (${ids.map(() => "?").join(",")})`, ids) : [];
      for (const p of runs) await settlePaidPayroll(queryDB, p, req.user.id, { date, method, reference });
      const total = runs.reduce((s, r) => s + Number(r.net_salary || 0), 0);
      await event(b.id, "paid", req.user.id, [`${runs.length} employees`, tk(total), method, reference].filter(Boolean).join(" · "));
      // Employees and HR hear about it.
      const emps: any[] = runs.length
        ? await queryDB(`SELECT id, user_id FROM all_employees WHERE id IN (${runs.map(() => "?").join(",")})`, runs.map((r) => r.employee_id))
        : [];
      for (const r of runs) {
        const uid = Number(emps.find((e: any) => Number(e.id) === Number(r.employee_id))?.user_id || 0);
        if (uid) {
          await createAlert(queryDB, {
            userId: uid,
            type: "payroll_approval" as AlertType,
            title: "Salary Paid",
            message: `Your ${monthText(month)} salary of ${tk(r.net_salary)} was paid on ${date}${method ? ` (${method})` : ""}.`,
            relatedType: "payroll",
            relatedId: Number(r.id)
          }).catch(() => {});
        }
      }
      await notify([Number(b.submitted_by), Number(b.sent_accounts_by), ...(await layerHolders(queryDB, "audit_approve"))], "Salary Paid by Accounts", `${req.user.name || "Accounts"} paid the ${monthText(month)} salary — ${runs.length} employees, ${tk(total)}, on ${date}.`, req.user.id);
      res.json({ success: true, status: "paid", paid: runs.length, total: money(total) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Accounts' payment sheet: each employee's net pay split over their bank /
  // MFS accounts (the run's snapshot), for the bank upload / advice.
  // Payroll -> Approval -> Salary sheet (layer "approval_sheet"): the
  // month's salaries on screen, one row per employee — days, earnings,
  // deductions, net, hold and where it is paid — with last month's net
  // beside it, so Audit / Accounts can check the sheet before approving or
  // paying instead of only exporting it.
  app.get("/api/payroll/approval/:month/salary-sheet", authenticateToken, requireAdmin, requireModuleLayer("payroll", "approval_sheet"), async (req: any, res: any) => {
    try {
      const month = String(req.params.month);
      if (!MONTH_RE.test(month)) return bad(res, "Choose a month.");
      const runs: any[] =
        (await queryDB(
          `SELECT p.*, e.name AS employee_name, e.employee_id AS employee_code, e.department, e.designation
             FROM payrolls p JOIN all_employees e ON e.id = p.employee_id
            WHERE p.month_year = ? ORDER BY e.name ASC`,
          [month]
        )) || [];
      const [y, mo] = month.split("-").map(Number);
      const prevMonth = `${mo === 1 ? y - 1 : y}-${String(mo === 1 ? 12 : mo - 1).padStart(2, "0")}`;
      const prev: any[] = (await queryDB("SELECT employee_id, net_salary FROM payrolls WHERE month_year = ?", [prevMonth])) || [];
      const prevNet = new Map<number, number>(prev.map((r: any) => [Number(r.employee_id), money(r.net_salary)]));
      const splits: any[] = runs.length
        ? await queryDB(`SELECT * FROM payroll_payment_splits WHERE payroll_id IN (${runs.map(() => "?").join(",")}) ORDER BY id ASC`, runs.map((r) => r.id)).catch(() => [])
        : [];
      const paidTo = (id: number) =>
        splits
          .filter((s: any) => Number(s.payroll_id) === Number(id))
          .map((s: any) => {
            const where = s.account_type === "mfs" ? s.provider || s.account_label || "MFS" : s.account_type === "cash" ? "Cash" : s.bank_name || s.account_label || "Bank";
            return `${where}${s.account_number ? ` ${s.account_number}` : ""}`;
          })
          .join(" + ");
      const fines = await finesByRun(queryDB, runs.map((r: any) => Number(r.id)), true);
      const rows = runs.map((r: any) => {
        const last = prevNet.get(Number(r.employee_id));
        const fine = fines.get(Number(r.id)) || 0;
        return {
          id: Number(r.id),
          employee_id: Number(r.employee_id),
          employee_code: r.employee_code || "",
          employee_name: r.employee_name,
          department: r.department || "",
          designation: r.designation || "",
          working_days: Number(r.total_working_days) || 0,
          present_days: Number(r.present_days) || 0,
          absent_days: Number(r.absent_days) || 0,
          leave_days: Number(r.leave_days) || 0,
          lwp_days: Number(r.lwp_days) || 0,
          late_count: Number(r.late_count) || 0,
          late_deduction_days: Number(r.late_deduction_days) || 0,
          overtime_hours: Number(r.overtime_hours) || 0,
          basic: money(r.basic_amount),
          allowances: money(r.allowances_total),
          overtime: money(r.overtime_amount),
          bonus: money(r.bonus_amount),
          extra_pay: money(r.item_earnings),
          gross: money(r.gross_earned),
          absent_deduction: money(r.absent_deduction),
          late_deduction: money(r.late_deduction_amount),
          tax: money(r.tax_deduction),
          pf: money(r.pf_deduction),
          advance: money(r.advance_deduction),
          other_deduction: money(r.other_deduction),
          fine,
          extra_deduction: money(money(r.item_deductions) - fine),
          total_deduction: money(r.total_deduction),
          net: money(r.net_salary),
          last_net: last ?? null,
          status: Number(r.is_held) ? "held" : r.payment_status,
          hold_reason: Number(r.is_held) ? r.hold_reason || null : null,
          remarks: r.remarks || null,
          paid_to: paidTo(r.id)
        };
      });
      res.json({ month_year: month, previous_month: prevMonth, rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Payroll -> Approval -> Top Sheet (layer "top_sheet"): Accounts' salary
  // top sheet — the month's salary by Branch / site (?by=department for
  // Departments): Actual Salary, after the absent / late cut, Allowance,
  // Arrear, Gross, Other Deduction, Advance, Loan, TDS, Employee
  // Contribution (PF), Net, and how it is paid (Bank / Card / Cash / MFS),
  // with each site's own sheet (one line per employee) and the HR / Audit /
  // Accounts names that signed the month off. A salary on hold isn't paid
  // this month, so it is left out (listed apart).
  app.get("/api/payroll/approval/:month/top-sheet", authenticateToken, requireAdmin, requireModuleLayer("payroll", "top_sheet"), async (req: any, res: any) => {
    try {
      const month = String(req.params.month);
      if (!MONTH_RE.test(month)) return bad(res, "Choose a month.");
      const by = req.query.by === "department" ? "department" : "branch";
      const runs: any[] =
        (await queryDB(
          `SELECT p.*, e.name AS employee_name, e.employee_id AS employee_code, e.department, e.designation, e.branch AS branch_text, e.branch_id,
                  DATE_FORMAT(e.joining_date, '%Y-%m-%d') AS joining_date
             FROM payrolls p JOIN all_employees e ON e.id = p.employee_id
            WHERE p.month_year = ? ORDER BY e.name ASC`,
          [month]
        )) || [];
      const ids = runs.map((r) => Number(r.id));
      const inList = ids.map(() => "?").join(",");
      const [branches, splits, lines] = await Promise.all([
        queryDB("SELECT id, branch_name FROM branches").catch(() => []),
        ids.length ? queryDB(`SELECT * FROM payroll_payment_splits WHERE payroll_id IN (${inList})`, ids).catch(() => []) : [],
        ids.length ? queryDB(`SELECT payroll_id, source, kind, amount FROM payroll_line_items WHERE payroll_id IN (${inList})`, ids).catch(() => []) : []
      ]);
      const branchName = new Map<number, string>(((branches as any[]) || []).map((b: any) => [Number(b.id), String(b.branch_name || "")]));
      // How each run is paid: its Bank / MFS / Cash split (a bank account
      // named "... Card" — e.g. "EBL Card" — is the Card column), else the
      // run's payment method.
      const pay = new Map<number, { bank: number; card: number; cash: number; mfs: number }>();
      for (const r of runs) pay.set(Number(r.id), { bank: 0, card: 0, cash: 0, mfs: 0 });
      const withSplit = new Set<number>();
      for (const sp of (splits as any[]) || []) {
        const p = pay.get(Number(sp.payroll_id));
        if (!p) continue;
        withSplit.add(Number(sp.payroll_id));
        const amt = money(sp.amount);
        if (sp.account_type === "cash") p.cash += amt;
        else if (sp.account_type === "mfs") p.mfs += amt;
        else if (/card/i.test(`${sp.account_label || ""} ${sp.bank_name || ""}`)) p.card += amt;
        else p.bank += amt;
      }
      // Arrear lines (Allowance & Adjustment -> Arrear) apart from the other extra pay.
      const arrear = new Map<number, number>();
      for (const l of (lines as any[]) || []) {
        if (l.source === "adjustment" && l.kind === "earning") arrear.set(Number(l.payroll_id), money((arrear.get(Number(l.payroll_id)) || 0) + Number(l.amount)));
      }
      const groupOf = (r: any) =>
        by === "department"
          ? String(r.department || "").trim() || "No department"
          : branchName.get(Number(r.branch_id)) || String(r.branch_text || "").trim() || "No branch";
      const rowOf = (r: any) => {
        const net = money(r.net_salary);
        const p = pay.get(Number(r.id))!;
        if (!withSplit.has(Number(r.id))) {
          const m = String(r.payment_method || "");
          if (/cash/i.test(m)) p.cash = net;
          else if (/card/i.test(m)) p.card = net;
          else if (/bkash|nagad|rocket|upay|mfs/i.test(m) && !/bank/i.test(m)) p.mfs = net;
          else p.bank = net;
        }
        const actual = money(Number(r.basic_amount) + Number(r.allowances_total));
        const after = money(actual - Number(r.absent_deduction));
        const arr = arrear.get(Number(r.id)) || 0;
        const allowance = money(Number(r.overtime_amount) + Number(r.bonus_amount) + Number(r.item_earnings) - arr);
        const gross = money(after + allowance + arr);
        const loan = money(r.loan_deduction);
        const advance = money(Number(r.advance_deduction) - loan);
        const other = money(Number(r.other_deduction) + Number(r.item_deductions));
        const tds = money(r.tax_deduction);
        const pf = money(r.pf_deduction);
        return {
          id: Number(r.id),
          employee_code: r.employee_code || "",
          employee_name: r.employee_name,
          designation: r.designation || "",
          department: r.department || "",
          joining_date: r.joining_date || null,
          working_days: Number(r.total_working_days) || 0,
          present_days: Number(r.present_days) || 0,
          actual, after, allowance, arrear: arr, gross, other, advance, loan, tds, pf,
          total_deduction: money(other + advance + loan + tds + pf),
          net,
          bank: money(p.bank), card: money(p.card), cash: money(p.cash), mfs: money(p.mfs),
          status: r.payment_status,
          remarks: r.remarks || ""
        };
      };
      const KEYS = ["actual", "after", "allowance", "arrear", "gross", "other", "advance", "loan", "tds", "pf", "total_deduction", "net", "bank", "card", "cash", "mfs"] as const;
      const sum = (rows: any[]) => Object.fromEntries(KEYS.map((k) => [k, money(rows.reduce((t, x) => t + Number(x[k] || 0), 0))]));
      const held = runs.filter((r) => Number(r.is_held));
      const groups = new Map<string, any[]>();
      for (const r of runs.filter((x) => !Number(x.is_held))) {
        const g = groupOf(r);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g)!.push(rowOf(r));
      }
      // Head Office first (as on the paper top sheet), then A–Z.
      const names = [...groups.keys()].sort((a, b) => (/^head office$/i.test(a) ? -1 : /^head office$/i.test(b) ? 1 : a.localeCompare(b)));
      const out = names.map((name) => ({ name, employees: groups.get(name)!.length, totals: sum(groups.get(name)!), rows: groups.get(name)! }));
      const b = await batchFor(queryDB, month);
      const who = await userNames([b?.submitted_by, b?.hrd_by, b?.audited_by, b?.paid_by, ...runs.map((r) => r.generated_by)]);
      const company = ((await queryDB("/*unscoped*/ SELECT name FROM companies WHERE id = ?", [req.companyId ?? 1]).catch(() => [])) || [])[0];
      res.json({
        month_year: month,
        by,
        company: company?.name || "",
        status: b?.status || "draft",
        payment_date: b?.payment_date || null,
        payment_method: b?.payment_method || null,
        payment_reference: b?.payment_reference || null,
        signatures: {
          prepared: { name: (b?.submitted_by && who.get(Number(b.submitted_by))) || who.get(Number(runs[0]?.generated_by)) || null, at: b?.submitted_at || null },
          // The HR Director now (a month from before the HR Director step: Audit).
          authorized: b?.hrd_by ? { name: who.get(Number(b.hrd_by)) || null, at: b.hrd_at || null } : { name: (b?.audited_by && who.get(Number(b.audited_by))) || null, at: b?.audited_at || null },
          approved: { name: (b?.paid_by && who.get(Number(b.paid_by))) || null, at: b?.paid_at || null }
        },
        totals: { employees: out.reduce((t, g) => t + g.employees, 0), ...sum(out.flatMap((g) => g.rows)) },
        groups: out,
        held: { count: held.length, net: money(held.reduce((t, r) => t + Number(r.net_salary || 0), 0)), people: held.map((r) => ({ name: r.employee_name, code: r.employee_code, net: money(r.net_salary), reason: r.hold_reason || null })) }
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Payroll -> Approval -> Month comparison (layer "month_compare"): this
  // month's salaries against last month's — totals, a bridge from last
  // month's net to this month's (new joiners, people who left, and each
  // salary part that moved for everyone else), departments side by side,
  // and per person what changed and why. ?vs=YYYY-MM compares with another
  // month instead of the one before.
  app.get("/api/payroll/approval/:month/compare", authenticateToken, requireAdmin, requireModuleLayer("payroll", "month_compare"), async (req: any, res: any) => {
    try {
      const month = String(req.params.month);
      if (!MONTH_RE.test(month)) return bad(res, "Choose a month.");
      const [y, mo] = month.split("-").map(Number);
      const prevMonth = MONTH_RE.test(String(req.query.vs || "")) ? String(req.query.vs) : `${mo === 1 ? y - 1 : y}-${String(mo === 1 ? 12 : mo - 1).padStart(2, "0")}`;
      if (prevMonth === month) return bad(res, "Pick a different month to compare with.");
      const load = async (m: string) =>
        ((await queryDB(
          `SELECT p.*, e.name AS employee_name, e.employee_id AS employee_code, e.department, e.designation, e.joining_date, e.is_active AS employee_active, e.user_id
             FROM payrolls p JOIN all_employees e ON e.id = p.employee_id
            WHERE p.month_year = ?`,
          [m]
        )) || []) as any[];
      const [cur, prev] = await Promise.all([load(month), load(prevMonth)]);
      const curBy = new Map<number, any>(cur.map((r) => [Number(r.employee_id), r]));
      const prevBy = new Map<number, any>(prev.map((r) => [Number(r.employee_id), r]));
      const userIds = [...new Set([...cur, ...prev].map((r) => Number(r.user_id)).filter(Boolean))];
      const exits: any[] = userIds.length
        ? ((await queryDB(
            `SELECT user_id, exit_type, reason, last_working_day, status FROM exit_requests WHERE user_id IN (${userIds.map(() => "?").join(",")}) ORDER BY id DESC`,
            userIds
          ).catch(() => [])) || []).filter((x: any) => !["cancelled", "rejected", "withdrawn"].includes(String(x.status || "")))
        : [];
      const exitBy = new Map<number, any>();
      for (const x of exits) if (!exitBy.has(Number(x.user_id))) exitBy.set(Number(x.user_id), x);
      const ymd = (v: any) => (v ? String(v).slice(0, 10) : null);
      const plain = (v: number) => money(v).toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      // Salary parts and their effect on net (earnings +, deductions −).
      const PARTS: { key: string; label: string; col: string; sign: 1 | -1 }[] = [
        { key: "basic", label: "Basic", col: "basic_amount", sign: 1 },
        { key: "allowances", label: "Allowances", col: "allowances_total", sign: 1 },
        { key: "overtime", label: "Overtime", col: "overtime_amount", sign: 1 },
        { key: "bonus", label: "Bonus", col: "bonus_amount", sign: 1 },
        { key: "extra_pay", label: "Extra pay", col: "item_earnings", sign: 1 },
        { key: "absent_cut", label: "Absent / LWP / late cut", col: "absent_deduction", sign: -1 },
        { key: "tax", label: "Tax", col: "tax_deduction", sign: -1 },
        { key: "pf", label: "PF", col: "pf_deduction", sign: -1 },
        { key: "advance", label: "Loan / advance", col: "advance_deduction", sign: -1 },
        { key: "other_ded", label: "Other deduction", col: "other_deduction", sign: -1 },
        { key: "extra_ded", label: "Extra deduction", col: "item_deductions", sign: -1 }
      ];
      const n = (r: any, c: string) => money(r?.[c]);
      const people: any[] = [];
      const bridge: Record<string, number> = { new: 0, left: 0, other: 0 };
      for (const p of PARTS) bridge[p.key] = 0;
      const ids = new Set<number>([...curBy.keys(), ...prevBy.keys()]);
      for (const id of ids) {
        const c = curBy.get(id);
        const p = prevBy.get(id);
        const base = c || p;
        const row: any = {
          employee_id: id,
          employee_code: base.employee_code || "",
          employee_name: base.employee_name,
          department: base.department || "No department",
          designation: base.designation || "",
          last_net: p ? n(p, "net_salary") : null,
          this_net: c ? n(c, "net_salary") : null,
          diff: money((c ? n(c, "net_salary") : 0) - (p ? n(p, "net_salary") : 0)),
          held: !!(c && Number(c.is_held)),
          reasons: [] as { label: string; effect: number; note: string }[]
        };
        if (c && !p) {
          row.kind = "new";
          const jd = ymd(c.joining_date);
          row.why = jd && jd.slice(0, 7) >= prevMonth && jd.slice(0, 7) <= month ? `Joined ${jd}` : `No salary in ${prevMonth}${jd ? ` (joined ${jd})` : ""}`;
          bridge.new += row.this_net;
        } else if (p && !c) {
          row.kind = "left";
          const x = base.user_id ? exitBy.get(Number(base.user_id)) : null;
          row.why = x
            ? `${String(x.exit_type || "Exit").replace(/_/g, " ").replace(/^./, (ch: string) => ch.toUpperCase())}${ymd(x.last_working_day) ? ` — last working day ${ymd(x.last_working_day)}` : ""}${x.reason ? ` (${String(x.reason).slice(0, 120)})` : ""}`
            : Number(base.employee_active) === 0
              ? "Employee set Inactive"
              : `No salary run for ${month} yet`;
          bridge.left -= row.last_net;
        } else {
          row.kind = row.diff !== 0 ? "changed" : "same";
          let explained = 0;
          for (const part of PARTS) {
            const d = money(n(c, part.col) - n(p, part.col));
            if (!d) continue;
            const effect = money(d * part.sign);
            explained = money(explained + effect);
            bridge[part.key] += effect;
            let note = `${plain(n(p, part.col))} → ${plain(n(c, part.col))}`;
            if (part.key === "absent_cut") {
              const bits = [
                Number(c.absent_days) !== Number(p.absent_days) ? `absent ${Number(p.absent_days) || 0} → ${Number(c.absent_days) || 0} days` : "",
                Number(c.lwp_days) !== Number(p.lwp_days) ? `LWP ${Number(p.lwp_days) || 0} → ${Number(c.lwp_days) || 0} days` : "",
                Number(c.late_count) !== Number(p.late_count) ? `late ${Number(p.late_count) || 0} → ${Number(c.late_count) || 0} times` : ""
              ].filter(Boolean);
              if (bits.length) note += ` (${bits.join(", ")})`;
            } else if (part.key === "overtime") {
              note += ` (${Number(p.overtime_hours) || 0} → ${Number(c.overtime_hours) || 0} h)`;
            } else if (part.key === "basic" || part.key === "allowances") {
              note += " (salary structure changed)";
            }
            row.reasons.push({ label: part.label, effect, note });
          }
          const rest = money(row.diff - explained);
          if (rest) {
            bridge.other += rest;
            row.reasons.push({ label: "Other / rounding", effect: rest, note: "" });
          }
          if (Number(c.total_working_days) !== Number(p.total_working_days)) {
            row.reasons.push({ label: "Working days", effect: 0, note: `${Number(p.total_working_days) || 0} → ${Number(c.total_working_days) || 0} days in the month` });
          }
        }
        people.push(row);
      }
      people.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || String(a.employee_name).localeCompare(String(b.employee_name)));

      const deptMap = new Map<string, any>();
      for (const r of people) {
        if (!deptMap.has(r.department))
          deptMap.set(r.department, { department: r.department, last_count: 0, last_net: 0, this_count: 0, this_net: 0, new_count: 0, left_count: 0, changed_count: 0 });
        const d = deptMap.get(r.department);
        if (r.last_net != null) {
          d.last_count++;
          d.last_net = money(d.last_net + r.last_net);
        }
        if (r.this_net != null) {
          d.this_count++;
          d.this_net = money(d.this_net + r.this_net);
        }
        if (r.kind === "new") d.new_count++;
        if (r.kind === "left") d.left_count++;
        if (r.kind === "changed") d.changed_count++;
      }
      const departments = [...deptMap.values()]
        .map((d) => ({ ...d, diff: money(d.this_net - d.last_net) }))
        .sort((a, b) => a.department.localeCompare(b.department));
      const total = (rows: any[], k: string) => money(rows.reduce((a, r) => a + (Number(r[k]) || 0), 0));
      const lastTotal = total(prev, "net_salary");
      const thisTotal = total(cur, "net_salary");
      const steps = [
        { key: "new", label: "New this month", amount: money(bridge.new) },
        { key: "left", label: "Left / not paid this month", amount: money(bridge.left) },
        ...PARTS.map((p) => ({ key: p.key, label: p.label, amount: money(bridge[p.key]) })),
        { key: "other", label: "Other / rounding", amount: money(bridge.other) }
      ].filter((s) => s.amount !== 0);
      res.json({
        month_year: month,
        previous_month: prevMonth,
        summary: {
          last_count: prev.length,
          last_net: lastTotal,
          last_gross: total(prev, "gross_earned"),
          this_count: cur.length,
          this_net: thisTotal,
          this_gross: total(cur, "gross_earned"),
          diff: money(thisTotal - lastTotal),
          diff_pct: lastTotal ? Math.round(((thisTotal - lastTotal) / lastTotal) * 1000) / 10 : null,
          new_count: people.filter((r) => r.kind === "new").length,
          left_count: people.filter((r) => r.kind === "left").length,
          changed_count: people.filter((r) => r.kind === "changed").length,
          same_count: people.filter((r) => r.kind === "same").length
        },
        bridge: steps,
        departments,
        people
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/payroll/approval/:month/payment-sheet", ...gate, async (req: any, res: any) => {
    try {
      const month = String(req.params.month);
      if (!MONTH_RE.test(month)) return bad(res, "Choose a month.");
      const runs = await monthRuns(month);
      const splits: any[] = runs.length
        ? await queryDB(`SELECT * FROM payroll_payment_splits WHERE payroll_id IN (${runs.map(() => "?").join(",")}) ORDER BY id ASC`, runs.map((r) => r.id)).catch(() => [])
        : [];
      const rows: any[] = [];
      for (const r of runs) {
        const mine = splits.filter((s: any) => Number(s.payroll_id) === Number(r.id));
        const base = {
          employee_name: r.employee_name,
          employee_code: r.employee_code,
          department: r.department,
          designation: r.designation,
          net_salary: money(r.net_salary),
          status: Number(r.is_held) ? "held" : r.payment_status
        };
        if (!mine.length) rows.push({ ...base, account_type: "", bank: "", branch: "", account_number: "", amount: money(r.net_salary) });
        for (const s of mine) {
          rows.push({
            ...base,
            account_type: s.account_type === "mfs" ? "MFS" : s.account_type === "cash" ? "Cash" : "Bank",
            bank: s.account_type === "mfs" ? s.provider || s.account_label : s.account_type === "cash" ? "Cash" : s.bank_name || s.account_label,
            branch: s.branch_name || "",
            account_number: s.account_number,
            amount: money(s.amount)
          });
        }
      }
      res.json({ month_year: month, rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
