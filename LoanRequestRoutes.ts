/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> "My Loan / Advance": an employee applies for a loan or a
// salary advance and follows it (users.can_view_loan_request, off until HR
// turns it on in Module Access; a Superadmin always).
//
// A request (advance_requests) rides the Dynamic Approval Engine
// (request_type 'loan', source_type 'advance_request') — the Supervisor layer
// and the Template set for "Loan / Advance Request". When the chain is a
// Template (e.g. Supervisor -> HR), its final Approve creates the loan
// (employee_advances) and payroll takes the installments from the next run.
// When there is no Template (only a Supervisor, or nobody), the chain only
// recommends it and a Payroll holder makes the final decision in
// Payroll -> Loans & Advances -> Approvals — money is never lent on a
// Supervisor's word alone.
//
// advance_requests.chain_status: 'in_progress' while the chain is deciding,
// 'approved' when it recommended it (and the Payroll decision is next),
// 'none' when there was no chain at all.

import type { Express } from "express";
import type { AlertType } from "./Alerts";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;
type CreateAlert = (
  queryDB: QueryDB,
  params: { userId: number; type: AlertType; title: string; message: string; relatedType?: string; relatedId?: number }
) => Promise<void>;

interface LoanRequestRouteDeps {
  authenticateToken: any;
  queryDB: QueryDB;
  getAdminModules: (userId: number) => Promise<string[]>;
  createAlert: CreateAlert;
  createTemplateApprovalRequest: (
    requestType: "loan",
    sourceType: "advance_request",
    sourceId: number,
    requestedBy: number
  ) => Promise<{ autoApproved: boolean; template: any | null }>;
  getCurrentStepApprovers: (request: any) => Promise<{ user_id: number; user_name: string | null }[]>;
}

const MAX_INSTALLMENTS = 24;
const money = (v: any) => Math.round((Number(v) || 0) * 100) / 100;
const tk = (v: any) => `৳${money(v).toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function ensureLoanRequestSchema(dbPool: any) {
  if (!dbPool) return;
  for (const [col, ddl] of [
    ["chain_status", "ALTER TABLE advance_requests ADD COLUMN chain_status VARCHAR(20) NULL"],
    ["request_kind", "ALTER TABLE advance_requests ADD COLUMN request_kind VARCHAR(10) NOT NULL DEFAULT 'loan'"],
    ["installments", "ALTER TABLE advance_requests ADD COLUMN installments INT NULL"]
  ] as const) {
    try {
      await dbPool.query(ddl);
    } catch (err: any) {
      if (err?.code !== "ER_DUP_FIELDNAME") console.warn(`⚠️ Could not add advance_requests.${col}: ${err.message}`);
    }
  }
  try {
    await dbPool.query("ALTER TABLE advance_requests MODIFY COLUMN status ENUM('pending', 'approved', 'rejected', 'cancelled') NOT NULL DEFAULT 'pending'");
  } catch (err: any) {
    console.warn("⚠️ Could not widen advance_requests.status: " + err.message);
  }
}

async function employeeUserId(queryDB: QueryDB, employeeId: number): Promise<number | null> {
  const rows: any[] = (await queryDB("SELECT user_id FROM all_employees WHERE id = ?", [employeeId])) || [];
  return rows[0]?.user_id ? Number(rows[0].user_id) : null;
}
const kindLabel = (r: any) => (r.request_kind === "advance" ? "Salary Advance" : "Loan");

// The final Approve: creates the loan (employee_advances) — from the
// approval chain's last step (performApprovalAction in server.ts) or a
// Payroll holder's decision.
export async function finalizeAdvanceRequest(queryDB: QueryDB, createAlert: CreateAlert, requestId: number, actorId: number | null, remarks: string | null) {
  const rows: any[] = (await queryDB("SELECT * FROM advance_requests WHERE id = ?", [requestId])) || [];
  const r = rows[0];
  if (!r) throw new Error("Request not found.");
  if (r.status !== "pending") throw new Error("This request has already been decided.");
  const result: any = await queryDB(
    "INSERT INTO employee_advances (employee_id, total_amount, monthly_installment, reason, created_by) VALUES (?, ?, ?, ?, ?)",
    [r.employee_id, money(r.total_amount), money(r.monthly_installment), r.reason, actorId]
  );
  await queryDB(
    "UPDATE advance_requests SET status = 'approved', chain_status = CASE WHEN chain_status = 'in_progress' THEN 'approved' ELSE chain_status END, decided_by = ?, decision_remarks = ?, decided_at = CURRENT_TIMESTAMP, advance_id = ? WHERE id = ?",
    [actorId, remarks, result.insertId, requestId]
  );
  const uid = await employeeUserId(queryDB, Number(r.employee_id));
  if (uid) {
    await createAlert(queryDB, {
      userId: uid,
      type: "loan_request",
      title: `${kindLabel(r)} Approved`,
      message: `Your ${kindLabel(r).toLowerCase()} of ${tk(r.total_amount)} was approved. ${tk(r.monthly_installment)} a month will be taken from your salary from the next payroll.`,
      relatedType: "advance_request",
      relatedId: requestId
    }).catch(() => {});
  }
  return { advance_id: Number(result.insertId) };
}

export async function rejectAdvanceRequest(queryDB: QueryDB, createAlert: CreateAlert, requestId: number, actorId: number | null, remarks: string | null) {
  const rows: any[] = (await queryDB("SELECT * FROM advance_requests WHERE id = ?", [requestId])) || [];
  const r = rows[0];
  if (!r || r.status !== "pending") return;
  await queryDB(
    "UPDATE advance_requests SET status = 'rejected', chain_status = CASE WHEN chain_status = 'in_progress' THEN 'rejected' ELSE chain_status END, decided_by = ?, decision_remarks = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?",
    [actorId, remarks, requestId]
  );
  const uid = await employeeUserId(queryDB, Number(r.employee_id));
  if (uid) {
    await createAlert(queryDB, {
      userId: uid,
      type: "loan_request",
      title: `${kindLabel(r)} Request Not Approved`,
      message: `Your ${kindLabel(r).toLowerCase()} request of ${tk(r.total_amount)} was not approved${remarks ? `: ${remarks}` : "."}`,
      relatedType: "advance_request",
      relatedId: requestId
    }).catch(() => {});
  }
}

// The chain's last step on a request with no Template: it's recommended,
// and a Payroll holder decides it.
export async function recommendAdvanceRequest(queryDB: QueryDB, createAlert: CreateAlert, getAdminModules: (id: number) => Promise<string[]>, requestId: number, actorName: string) {
  const rows: any[] = (await queryDB("SELECT * FROM advance_requests WHERE id = ?", [requestId])) || [];
  const r = rows[0];
  if (!r || r.status !== "pending") return;
  await queryDB("UPDATE advance_requests SET chain_status = 'approved' WHERE id = ?", [requestId]);
  const emp: any[] = (await queryDB("SELECT name FROM all_employees WHERE id = ?", [r.employee_id])) || [];
  for (const id of await payrollUserIds(queryDB, getAdminModules)) {
    await createAlert(queryDB, {
      userId: id,
      type: "loan_request",
      title: "Loan / Advance Request Ready for Decision",
      message: `${actorName} recommended ${emp[0]?.name || "an employee"}'s ${kindLabel(r).toLowerCase()} request of ${tk(r.total_amount)}. Decide it in Payroll → Loans & Advances → Approvals.`,
      relatedType: "advance_request",
      relatedId: requestId
    }).catch(() => {});
  }
}

async function payrollUserIds(queryDB: QueryDB, getAdminModules: (id: number) => Promise<string[]>): Promise<number[]> {
  const users: any[] = (await queryDB("SELECT id, role FROM users")) || [];
  const out: number[] = [];
  for (const u of users) {
    if (u.role === "superadmin") out.push(Number(u.id));
    else if (u.role === "admin" && (await getAdminModules(Number(u.id)).catch(() => [])).includes("payroll")) out.push(Number(u.id));
  }
  return out;
}

export function registerLoanRequestRoutes(app: Express, deps: LoanRequestRouteDeps) {
  const { authenticateToken, queryDB, getAdminModules, createAlert, createTemplateApprovalRequest, getCurrentStepApprovers } = deps;

  async function canApply(user: any): Promise<boolean> {
    if (user.role === "superadmin") return true;
    const rows: any[] = (await queryDB("SELECT can_view_loan_request FROM users WHERE id = ?", [user.id])) || [];
    return !!Number(rows[0]?.can_view_loan_request || 0);
  }
  const selfOnly = async (req: any, res: any, next: any) => {
    try {
      if (!(await canApply(req.user))) return res.status(403).json({ error: "Loan / Advance requests aren't turned on for your account. Ask HR." });
      next();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };
  async function myEmployee(userId: number) {
    const rows: any[] = (await queryDB("SELECT * FROM all_employees WHERE user_id = ?", [userId])) || [];
    return rows.filter((r: any) => Number(r.is_active ?? 1) !== 0)[0] || rows[0] || null;
  }

  // Everything the page shows: own requests (with where each is in the
  // chain), own loans and what's left on them, and whether a new request
  // is allowed right now.
  app.get("/api/my-loans", authenticateToken, selfOnly, async (req: any, res: any) => {
    try {
      const emp = await myEmployee(Number(req.user.id));
      if (!emp) return res.json({ linked: false, requests: [], loans: [], can_request: false, blocked_reason: "Your login isn't linked to an Employee record yet — please contact HR." });
      const [requests, loans, approvals, structures]: any[] = await Promise.all([
        queryDB("SELECT * FROM advance_requests WHERE employee_id = ? ORDER BY id DESC", [emp.id]),
        queryDB("SELECT * FROM employee_advances WHERE employee_id = ? ORDER BY id DESC", [emp.id]),
        queryDB("SELECT * FROM approval_requests WHERE source_type = 'advance_request'").catch(() => []),
        queryDB("SELECT gross_salary FROM salary_structures WHERE employee_id = ? ORDER BY effective_date DESC, id DESC LIMIT 1", [emp.id]).catch(() => [])
      ]);
      const outRequests = [];
      for (const r of requests || []) {
        const ap = (approvals || []).find((a: any) => Number(a.source_id) === Number(r.id));
        let waiting_on: string[] = [];
        if (ap && ap.status === "pending") waiting_on = (await getCurrentStepApprovers(ap)).map((x) => x.user_name || "Unknown");
        else if (r.status === "pending" && r.chain_status !== "in_progress") waiting_on = ["Payroll (HR)"];
        outRequests.push({
          id: Number(r.id),
          kind: r.request_kind === "advance" ? "advance" : "loan",
          total_amount: money(r.total_amount),
          monthly_installment: money(r.monthly_installment),
          installments: r.installments != null ? Number(r.installments) : null,
          reason: r.reason,
          status: r.status,
          chain_status: r.chain_status,
          step: ap ? { current: Number(ap.current_step), total: Number(ap.total_steps) } : null,
          waiting_on,
          decision_remarks: r.decision_remarks,
          created_at: r.created_at,
          decided_at: r.decided_at
        });
      }
      const outLoans = (loans || []).map((l: any) => ({
        id: Number(l.id),
        total_amount: money(l.total_amount),
        monthly_installment: money(l.monthly_installment),
        paid_amount: money(l.paid_amount),
        remaining: money(Number(l.total_amount) - Number(l.paid_amount)),
        reason: l.reason,
        status: l.status,
        created_at: l.created_at
      }));
      const pending = outRequests.find((r) => r.status === "pending");
      const running = outLoans.find((l: any) => l.status === "active" && l.remaining > 0);
      res.json({
        linked: true,
        gross_salary: structures?.[0]?.gross_salary != null ? money(structures[0].gross_salary) : null,
        max_installments: MAX_INSTALLMENTS,
        requests: outRequests,
        loans: outLoans,
        can_request: !pending && !running,
        blocked_reason: pending
          ? "You already have a request waiting for a decision."
          : running
          ? `Your current loan still has ${tk(running.remaining)} to repay — you can apply again once it's paid off.`
          : null
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/my-loans/requests", authenticateToken, selfOnly, async (req: any, res: any) => {
    try {
      const uid = Number(req.user.id);
      const emp = await myEmployee(uid);
      if (!emp) return res.status(400).json({ error: "Your login isn't linked to an Employee record yet — please contact HR." });
      const kind = req.body?.kind === "advance" ? "advance" : "loan";
      const total = money(req.body?.total_amount);
      const installments = Math.round(Number(req.body?.installments) || 0);
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 255) : "";
      if (!(total > 0)) return res.status(400).json({ error: "Enter the amount you need." });
      if (!(installments >= 1 && installments <= MAX_INSTALLMENTS)) {
        return res.status(400).json({ error: `Repay it in 1 to ${MAX_INSTALLMENTS} monthly installments.` });
      }
      if (!reason) return res.status(400).json({ error: "Write what you need it for." });
      const pending: any[] = (await queryDB("SELECT id FROM advance_requests WHERE employee_id = ? AND status = 'pending'", [emp.id])) || [];
      if (pending.length) return res.status(400).json({ error: "You already have a request waiting for a decision." });
      const loans: any[] = (await queryDB("SELECT * FROM employee_advances WHERE employee_id = ? AND status = 'active'", [emp.id])) || [];
      const running = loans.find((l: any) => Number(l.total_amount) - Number(l.paid_amount) > 0);
      if (running) {
        return res.status(400).json({ error: `Your current loan still has ${tk(Number(running.total_amount) - Number(running.paid_amount))} to repay — apply again once it's paid off.` });
      }
      const installment = money(Math.ceil((total / installments) * 100) / 100);
      const r: any = await queryDB(
        `INSERT INTO advance_requests (employee_id, total_amount, monthly_installment, reason, requested_by, request_kind, installments, chain_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress')`,
        [emp.id, total, installment, reason, uid, kind, installments]
      );
      const id = Number(r.insertId);
      const what = `${req.user.name || "An employee"} applied for a ${kind === "advance" ? "salary advance" : "loan"} of ${tk(total)}, ${installments} installment${installments === 1 ? "" : "s"} of ${tk(installment)}: ${reason}`;
      const { autoApproved } = await createTemplateApprovalRequest("loan", "advance_request", id, uid);
      if (autoApproved) {
        // No Supervisor and no Template: Payroll decides it straight away.
        await queryDB("UPDATE advance_requests SET chain_status = 'none' WHERE id = ?", [id]);
        for (const p of await payrollUserIds(queryDB, getAdminModules)) {
          if (p === uid) continue;
          await createAlert(queryDB, { userId: p, type: "loan_request", title: "New Loan / Advance Request", message: `${what}. Decide it in Payroll → Loans & Advances → Approvals.`, relatedType: "advance_request", relatedId: id }).catch(() => {});
        }
      } else {
        const ap: any[] = (await queryDB("SELECT * FROM approval_requests WHERE source_type = 'advance_request' AND source_id = ?", [id])) || [];
        if (ap[0]) {
          for (const a of await getCurrentStepApprovers(ap[0])) {
            await createAlert(queryDB, { userId: a.user_id, type: "loan_approval", title: "Loan / Advance Request Awaiting Your Approval", message: what, relatedType: "advance_request", relatedId: id }).catch(() => {});
          }
        }
      }
      res.status(201).json({ success: true, id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/my-loans/requests/:id(\\d+)/cancel", authenticateToken, selfOnly, async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      const emp = await myEmployee(Number(req.user.id));
      const rows: any[] = (await queryDB("SELECT * FROM advance_requests WHERE id = ?", [id])) || [];
      const r = rows[0];
      if (!r || !emp || Number(r.employee_id) !== Number(emp.id)) return res.status(404).json({ error: "Request not found." });
      if (r.status !== "pending") return res.status(400).json({ error: `This request was already ${r.status}.` });
      await queryDB("UPDATE advance_requests SET status = 'cancelled', decided_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
      await queryDB("UPDATE approval_requests SET status = 'rejected' WHERE source_type = 'advance_request' AND source_id = ? AND status = 'pending'", [id]).catch(() => {});
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
