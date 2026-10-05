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
// The one who submitted a month can't also approve it. A salary on hold is
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
type PayrollLayer = "read" | "salary_month" | "salary_hold" | "audit_approve" | "accounts_pay" | "access_log";

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
  for (const [col, def] of [
    ["payment_date", "DATE NULL"],
    ["payment_reference", "VARCHAR(150) NULL"]
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
) {
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
  await queryDB(
    "UPDATE payrolls SET payment_status = 'paid', paid_by = ?, paid_at = CURRENT_TIMESTAMP, payment_date = ?, payment_reference = ?, payment_method = COALESCE(?, payment_method) WHERE id = ?",
    [userId, payment?.date || null, payment?.reference || null, payment?.method || null, payroll.id]
  );
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
    const [audit, pay, log] = await Promise.all([
      hasModuleLayer(req.user, "payroll", "audit_approve"),
      hasModuleLayer(req.user, "payroll", "accounts_pay"),
      hasModuleLayer(req.user, "payroll", "access_log")
    ]);
    res.json({ audit_approve: audit, accounts_pay: pay, access_log: log });
  });

  // ---- one month's approval state ---------------------------------------
  async function monthRuns(monthYear: string) {
    return ((await queryDB(
      `SELECT p.id, p.employee_id, p.net_salary, p.payment_status, p.is_held, p.hold_reason, p.payment_date, p.payment_reference,
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
      const [audit, pay] = await Promise.all([hasModuleLayer(req.user, "payroll", "audit_approve"), hasModuleLayer(req.user, "payroll", "accounts_pay")]);
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
          submit: (status === "draft" || status === "returned") && runs.length > 0,
          approve: audit && status === "submitted" && (req.user.role === "superadmin" || Number(b?.submitted_by) !== Number(req.user.id)),
          return_: audit && (status === "submitted" || status === "approved"),
          pay: pay && status === "approved"
        },
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
      await queryDB("UPDATE payroll_batches SET status = 'submitted', submitted_by = ?, submitted_at = CURRENT_TIMESTAMP, audit_note = NULL WHERE id = ?", [req.user.id, b.id]);
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
      if (req.user.role !== "superadmin" && Number(b.submitted_by) === Number(req.user.id)) {
        return bad(res, "You submitted this salary sheet — someone else from Audit has to approve it.", 403);
      }
      const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) || null : null;
      // Ids from the (company-scoped) month list — an UPDATE isn't scoped.
      const ids = (await monthRuns(month)).filter((r) => r.payment_status === "unpaid" && !Number(r.is_held)).map((r) => Number(r.id));
      if (ids.length) await queryDB(`UPDATE payrolls SET payment_status = 'processed' WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
      await queryDB("UPDATE payroll_batches SET status = 'approved', audited_by = ?, audited_at = CURRENT_TIMESTAMP, audit_note = ? WHERE id = ?", [req.user.id, note, b.id]);
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
      const ids = (await monthRuns(month)).filter((r) => r.payment_status === "processed").map((r) => Number(r.id));
      if (ids.length) await queryDB(`UPDATE payrolls SET payment_status = 'unpaid' WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
      await queryDB("UPDATE payroll_batches SET status = 'returned', audited_by = ?, audited_at = CURRENT_TIMESTAMP, audit_note = ? WHERE id = ?", [req.user.id, note, b.id]);
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
      const date = String(req.body?.payment_date || "");
      if (!DATE_RE.test(date)) return bad(res, "Enter the payment date.");
      const method = typeof req.body?.payment_method === "string" ? req.body.payment_method.trim().slice(0, 50) || null : null;
      const reference = typeof req.body?.payment_reference === "string" ? req.body.payment_reference.trim().slice(0, 150) || null : null;
      if (!method) return bad(res, "Choose how it was paid.");
      const ids = (await monthRuns(month)).filter((r) => r.payment_status === "processed" && !Number(r.is_held)).map((r) => Number(r.id));
      const runs: any[] = ids.length ? await queryDB(`SELECT * FROM payrolls WHERE id IN (${ids.map(() => "?").join(",")})`, ids) : [];
      for (const p of runs) await settlePaidPayroll(queryDB, p, req.user.id, { date, method, reference });
      await queryDB(
        "UPDATE payroll_batches SET status = 'paid', paid_by = ?, paid_at = CURRENT_TIMESTAMP, payment_date = ?, payment_method = ?, payment_reference = ? WHERE id = ?",
        [req.user.id, date, method, reference, b.id]
      );
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
            account_type: s.account_type === "mfs" ? "MFS" : "Bank",
            bank: s.account_type === "mfs" ? s.provider || s.account_label : s.bank_name || s.account_label,
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
