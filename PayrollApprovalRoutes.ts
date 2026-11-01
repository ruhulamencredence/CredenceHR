/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll -> Approval: a salary month goes HR -> Audit -> Accounts.
//
//   draft      HR generates and checks the month's runs (nothing new here)
//   submitted  HR "Submit for Audit" — the month's runs are locked
//   approved   Audit approved it (Payroll layer "audit_approve"); every
//              unpaid run that isn't on hold becomes Processed
//   returned   Audit sent it back with a note — unlocked for HR again
//   paid       Accounts paid it (Payroll layer "accounts_pay") with the
//              payment date, method and reference — every Processed run
//              becomes Paid (advance installments are recovered then)
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

import type { Express } from "express";
import type { AlertType } from "./Alerts";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;
type CreateAlert = (
  queryDB: QueryDB,
  params: { userId: number; type: AlertType; title: string; message: string; relatedType?: string; relatedId?: number }
) => Promise<void>;
type PayrollLayer = "read" | "payroll_view" | "salary_month" | "salary_hold" | "audit_approve" | "accounts_pay" | "access_log" | "approval_sheet" | "month_compare";

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
export const LOCKED_BATCH = new Set(["submitted", "approved", "paid"]);
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
    ? "Audit has approved this month's salary — ask Audit to return it before changing anything."
    : "This month's salary is with Audit — ask Audit to return it before changing anything.";

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
    [/^\/approval\/[^/]+\/submit$/, "Submit for Audit"],
    [/^\/approval\/[^/]+\/approve$/, "Audit Approve"],
    [/^\/approval\/[^/]+\/return$/, "Audit Return"],
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
    const [audit, pay, log, edit, sheet, compare] = await Promise.all([
      hasModuleLayer(req.user, "payroll", "audit_approve"),
      hasModuleLayer(req.user, "payroll", "accounts_pay"),
      hasModuleLayer(req.user, "payroll", "access_log"),
      hasModuleLayer(req.user, "payroll", "read"),
      hasModuleLayer(req.user, "payroll", "approval_sheet"),
      hasModuleLayer(req.user, "payroll", "month_compare")
    ]);
    // edit = HR's "Payroll" layer; without it the account only views.
    // approval_sheet = the Salary sheet table in Approval.
    res.json({ audit_approve: audit, accounts_pay: pay, access_log: log, edit, approval_sheet: sheet, month_compare: compare });
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
  function approveConflict(user: any, b: any, runs: any[]): string | null {
    if (user.role === "superadmin") return null;
    if (Number(b?.submitted_by) === Number(user.id)) return "You submitted this salary sheet — someone else from Audit has to approve it.";
    if (runs.some((r) => Number(r.generated_by) === Number(user.id) || Number(r.last_edited_by) === Number(user.id))) return "You ran or changed payroll for some employees in this month — someone else from Audit has to approve it.";
    return null;
  }
  function payConflict(user: any, b: any, runs: any[]): string | null {
    if (user.role === "superadmin") return null;
    if (Number(b?.submitted_by) === Number(user.id)) return "You submitted this salary sheet — someone else from Accounts has to pay it.";
    if (Number(b?.audited_by) === Number(user.id)) return "You approved this salary sheet for Audit — someone else from Accounts has to pay it.";
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
      const names = await userNames([b?.submitted_by, b?.audited_by, b?.paid_by, ...events.map((e) => e.user_id)]);
      const count = (s: string) => runs.filter((r) => r.payment_status === s).length;
      const [audit, pay, edit] = await Promise.all([
        hasModuleLayer(req.user, "payroll", "audit_approve"),
        hasModuleLayer(req.user, "payroll", "accounts_pay"),
        hasModuleLayer(req.user, "payroll", "read")
      ]);
      const status = b?.status || "draft";
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
              payment_reference: b.payment_reference
            }
          : null,
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
        can: {
          submit: edit && (status === "draft" || status === "returned") && runs.length > 0,
          approve: audit && status === "submitted" && !approveConflict(req.user, b, runs),
          return_: audit && (status === "submitted" || status === "approved"),
          pay: pay && status === "approved" && !payConflict(req.user, b, runs)
        },
        // Shown next to a button this account can't use, so it knows why.
        conflict: status === "submitted" && audit ? approveConflict(req.user, b, runs) : status === "approved" && pay ? payConflict(req.user, b, runs) : null,
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
        "UPDATE payroll_batches SET status = 'submitted', submitted_by = ?, submitted_at = CURRENT_TIMESTAMP, audit_note = NULL WHERE id = ? AND status IN ('draft', 'returned')",
        [req.user.id, b.id]
      );
      if (sub && sub.affectedRows === 0) return bad(res, "This month was just submitted by someone else.", 409);
      await event(b.id, "submitted", req.user.id, note);
      const total = runs.filter((r) => !Number(r.is_held)).reduce((s, r) => s + Number(r.net_salary || 0), 0);
      await notify(
        await layerHolders(queryDB, "audit_approve"),
        "Salary Sheet Waiting for Audit",
        `${req.user.name || "HR"} submitted the ${monthText(month)} salary (${runs.length} employees, ${tk(total)}) for audit. Open Payroll → Approval.`,
        req.user.id
      );
      res.json({ success: true, status: "submitted" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/payroll/approval/:month/approve", authenticateToken, requireAdmin, requireModuleLayer("payroll", "audit_approve"), async (req: any, res: any) => {
    try {
      const month = String(req.params.month);
      const b = await batchFor(queryDB, month);
      if (!b || b.status !== "submitted") return bad(res, "Only a salary sheet submitted for audit can be approved.");
      const monthList = await monthRuns(month);
      const conflict = approveConflict(req.user, b, monthList);
      if (conflict) return bad(res, conflict, 403);
      const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) || null : null;
      // Ids from the (company-scoped) month list — an UPDATE isn't scoped.
      // The month changes hands once, even if Approve is pressed twice at once.
      const got: any = await queryDB(
        "UPDATE payroll_batches SET status = 'approved', audited_by = ?, audited_at = CURRENT_TIMESTAMP, audit_note = ? WHERE id = ? AND status = 'submitted'",
        [req.user.id, note, b.id]
      );
      if (got && got.affectedRows === 0) return bad(res, "This salary sheet was just approved or returned by someone else.", 409);
      const ids = monthList.filter((r) => r.payment_status === "unpaid" && !Number(r.is_held)).map((r) => Number(r.id));
      if (ids.length) await queryDB(`UPDATE payrolls SET payment_status = 'processed' WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
      await event(b.id, "approved", req.user.id, note);
      await notify(
        [...(await layerHolders(queryDB, "accounts_pay")), Number(b.submitted_by)],
        "Salary Approved by Audit — Ready to Pay",
        `${req.user.name || "Audit"} approved the ${monthText(month)} salary${note ? `: ${note}` : ""}. Accounts can pay it from Payroll → Approval.`,
        req.user.id
      );
      res.json({ success: true, status: "approved" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/payroll/approval/:month/return", authenticateToken, requireAdmin, requireModuleLayer("payroll", "audit_approve"), async (req: any, res: any) => {
    try {
      const month = String(req.params.month);
      const b = await batchFor(queryDB, month);
      if (!b || (b.status !== "submitted" && b.status !== "approved")) return bad(res, "Only a salary sheet with Audit can be returned.");
      const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) : "";
      if (!note) return bad(res, "Write what HR needs to correct.");
      // What Audit had approved goes back to unpaid; anything already paid
      // individually stays paid.
      const got: any = await queryDB(
        "UPDATE payroll_batches SET status = 'returned', audited_by = ?, audited_at = CURRENT_TIMESTAMP, audit_note = ? WHERE id = ? AND status = ?",
        [req.user.id, note, b.id, b.status]
      );
      if (got && got.affectedRows === 0) return bad(res, "This salary sheet was just changed by someone else — reload it.", 409);
      const ids = (await monthRuns(month)).filter((r) => r.payment_status === "processed").map((r) => Number(r.id));
      if (ids.length) await queryDB(`UPDATE payrolls SET payment_status = 'unpaid' WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
      await event(b.id, "returned", req.user.id, note);
      await notify([Number(b.submitted_by)], "Salary Sheet Returned by Audit", `${req.user.name || "Audit"} returned the ${monthText(month)} salary: ${note}`, req.user.id);
      res.json({ success: true, status: "returned" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/payroll/approval/:month/pay", authenticateToken, requireAdmin, requireModuleLayer("payroll", "accounts_pay"), async (req: any, res: any) => {
    try {
      const month = String(req.params.month);
      const b = await batchFor(queryDB, month);
      if (!b || b.status !== "approved") return bad(res, "Audit has to approve this salary sheet before it can be paid.");
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
      await notify([Number(b.submitted_by), Number(b.audited_by)], "Salary Paid by Accounts", `${req.user.name || "Accounts"} paid the ${monthText(month)} salary — ${runs.length} employees, ${tk(total)}, on ${date}.`, req.user.id);
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
      const rows = runs.map((r: any) => {
        const last = prevNet.get(Number(r.employee_id));
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
          extra_deduction: money(r.item_deductions),
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
