/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> My Payslip: an employee's own payslips.
//
//   users.can_view_payslip — OFF by default, turned on per account in
//   Admin Panel -> Users -> Module Access. A Superadmin always passes.
//
// Only months Payroll has approved or paid are shown (payment_status
// 'processed' / 'paid'); a draft run, or a salary on hold, never is.
//
//   GET /api/my-payslips        — the list, newest first
//   GET /api/my-payslips/:id    — one payslip with its pay lines

import type { Express } from "express";
import { loadPayLines } from "./PayrollItemsRoutes";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface PayslipDeps {
  authenticateToken: any;
  queryDB: QueryDB;
}

export async function ensurePayslipSchema(dbPool: any): Promise<void> {
  try {
    await dbPool.query("ALTER TABLE users ADD COLUMN can_view_payslip TINYINT(1) NOT NULL DEFAULT 0");
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") console.warn(`⚠️ My Payslip (users.can_view_payslip): ${err.message}`);
  }
}

const VISIBLE = "p.payment_status IN ('processed', 'paid') AND COALESCE(p.is_held, 0) = 0";

export function registerPayslipRoutes(app: Express, { authenticateToken, queryDB }: PayslipDeps) {
  // The caller's own Employee record, or a 403 / {linked:false}.
  async function ownEmployee(req: any, res: any): Promise<any | null | undefined> {
    const u = ((await queryDB("SELECT role, can_view_payslip, is_onboarding FROM users WHERE id = ?", [req.user.id])) || [])[0];
    const allowed = !!u && (u.role === "superadmin" || (Number(u.can_view_payslip) === 1 && !Number(u.is_onboarding)));
    if (!allowed) {
      res.status(403).json({ error: "My Payslip isn't turned on for your account." });
      return undefined;
    }
    const emp = ((await queryDB("SELECT id, employee_id, name, designation, department FROM all_employees WHERE user_id = ?", [req.user.id])) || [])[0];
    return emp || null;
  }

  app.get("/api/my-payslips", authenticateToken, async (req: any, res: any) => {
    try {
      const emp = await ownEmployee(req, res);
      if (emp === undefined) return;
      if (!emp) return res.json({ linked: false, payslips: [] });
      const rows: any[] = await queryDB(
        `SELECT p.id, p.month_year, p.gross_earned, p.total_deduction, p.net_salary, p.payment_status, p.payment_date, p.paid_at
           FROM payrolls p WHERE p.employee_id = ? AND ${VISIBLE} ORDER BY p.month_year DESC`,
        [emp.id]
      );
      res.json({
        linked: true,
        employee: { name: emp.name, employee_code: emp.employee_id, designation: emp.designation, department: emp.department },
        payslips: rows.map((r) => ({
          ...r,
          id: Number(r.id),
          gross_earned: Number(r.gross_earned),
          total_deduction: Number(r.total_deduction),
          net_salary: Number(r.net_salary)
        }))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/my-payslips/:id(\\d+)", authenticateToken, async (req: any, res: any) => {
    try {
      const emp = await ownEmployee(req, res);
      if (emp === undefined) return;
      const rows: any[] = emp
        ? await queryDB(
            `SELECT p.*, e.name AS employee_name, e.employee_id AS employee_code, e.designation, e.department
               FROM payrolls p JOIN all_employees e ON e.id = p.employee_id
              WHERE p.id = ? AND p.employee_id = ? AND ${VISIBLE}`,
            [req.params.id, emp.id]
          )
        : [];
      if (!rows.length) return res.status(404).json({ error: "Payslip not found." });
      const r = rows[0];
      // Who approved / paid it and the hold fields are payroll's own business.
      for (const k of ["generated_by", "paid_by", "held_by", "hold_reason", "held_at", "released_by", "released_at"]) delete r[k];
      const lines = await loadPayLines(queryDB, [Number(r.id)]);
      res.json({ ...r, id: Number(r.id), pay_lines: lines.get(Number(r.id)) || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
