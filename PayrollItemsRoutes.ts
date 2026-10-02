/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll -> Allowance & Adjustment: money that is added to or taken from a
// salary on top of the Salary Structure, each shown on the payslip under its
// own name.
//
//   employee_pay_items   — a fixed monthly line for one employee from a
//                          start month (optionally to an end month): Food
//                          Allowance deduction, Bike Maintenance payment,
//                          Mobile bill… Named after a Salary Component
//                          (Salary Setup) or typed in.
//   salary_adjustments   — fixing an earlier month's salary: an Arrear (paid
//                          too little, paid back) or a Recovery (paid too
//                          much, taken back), applied from a chosen month,
//                          in one go or in equal monthly installments.
//   payroll_line_items   — what a payroll run actually added/took for each
//                          of the above, snapshotted by name and amount when
//                          the run is generated (or edited while unpaid).
//                          An adjustment's remaining balance is its total
//                          less these rows, so deleting an unpaid run gives
//                          the balance back (ON DELETE CASCADE).
//
// The run's totals sit on payrolls.item_earnings / item_deductions, and are
// part of gross_earned / total_deduction, so Net Salary and every existing
// report stay right without knowing about the lines.

import type { Express } from "express";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface PayrollItemsDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (moduleKey: "payroll") => any;
  queryDB: QueryDB;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const num = (v: any, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const money = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const clean = (v: any, n: number) => String(v ?? "").trim().slice(0, n);
export const monthLabel = (ym: string) => {
  const [y, m] = String(ym).split("-").map(Number);
  return y && m ? new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short", year: "numeric" }) : String(ym);
};

export async function ensurePayrollItemsSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS employee_pay_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        component_id INT NULL,
        name VARCHAR(100) NOT NULL,
        kind ENUM('earning', 'deduction') NOT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        start_month VARCHAR(7) NOT NULL,
        end_month VARCHAR(7) NULL,
        remarks VARCHAR(255) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_pay_items_employee (employee_id)
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS salary_adjustments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        kind ENUM('arrear', 'recovery') NOT NULL,
        for_month VARCHAR(7) NOT NULL,
        total_amount DECIMAL(10, 2) NOT NULL,
        installment_amount DECIMAL(10, 2) NOT NULL,
        start_month VARCHAR(7) NOT NULL,
        reason VARCHAR(500) NULL,
        status ENUM('active', 'cancelled') NOT NULL DEFAULT 'active',
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        cancelled_by INT NULL,
        cancelled_at TIMESTAMP NULL DEFAULT NULL,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_salary_adjustments_employee (employee_id)
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS payroll_line_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        payroll_id INT NOT NULL,
        employee_id INT NOT NULL,
        month_year VARCHAR(7) NOT NULL,
        source ENUM('pay_item', 'adjustment') NOT NULL,
        source_id INT NOT NULL,
        name VARCHAR(150) NOT NULL,
        kind ENUM('earning', 'deduction') NOT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (payroll_id) REFERENCES payrolls(id) ON DELETE CASCADE,
        INDEX idx_payroll_line_items_payroll (payroll_id),
        INDEX idx_payroll_line_items_source (source, source_id)
      )
    `);
    for (const col of ["item_earnings", "item_deductions"]) {
      try {
        await dbPool.query(`ALTER TABLE payrolls ADD COLUMN ${col} DECIMAL(10, 2) NOT NULL DEFAULT 0.00`);
      } catch (err: any) {
        if (err.code !== "ER_DUP_FIELDNAME") console.warn(`⚠️ Could not add payrolls.${col} column: ` + err.message);
      }
    }
  } catch (err: any) {
    console.warn("⚠️ Could not ensure payroll allowance/adjustment tables exist: " + err.message);
  }
}

export interface PayLine {
  source: "pay_item" | "adjustment";
  source_id: number;
  name: string;
  kind: "earning" | "deduction";
  amount: number;
}

const adjustmentName = (a: any) => `${a.kind === "arrear" ? "Arrear" : "Recovery"} (${monthLabel(a.for_month)})`;

// What applying an adjustment has used up so far, per adjustment id —
// leaving out one payroll run (the one being recalculated).
async function appliedByAdjustment(queryDB: QueryDB, ids: number[], excludePayrollId?: number) {
  const used = new Map<number, number>();
  if (ids.length === 0) return used;
  const rows: any[] =
    (await queryDB(
      `SELECT source_id, payroll_id, amount FROM payroll_line_items WHERE source = 'adjustment' AND source_id IN (${ids.map(() => "?").join(",")})`,
      ids
    ).catch(() => [])) || [];
  for (const r of rows) {
    if (excludePayrollId && Number(r.payroll_id) === excludePayrollId) continue;
    used.set(Number(r.source_id), money((used.get(Number(r.source_id)) || 0) + num(r.amount)));
  }
  return used;
}

/** The allowance/deduction lines one employee's salary gets for one month. */
export async function computePayLines(
  queryDB: QueryDB,
  employeeId: number,
  monthYear: string,
  excludePayrollId?: number
): Promise<{ lines: PayLine[]; earnings: number; deductions: number }> {
  const lines: PayLine[] = [];
  const items: any[] = (await queryDB("SELECT * FROM employee_pay_items WHERE employee_id = ?", [employeeId]).catch(() => [])) || [];
  for (const it of items) {
    if (Number(it.employee_id) !== employeeId || !Number(it.is_active)) continue;
    if (String(it.start_month) > monthYear) continue;
    if (it.end_month && String(it.end_month) < monthYear) continue;
    const amount = money(num(it.amount));
    if (amount <= 0) continue;
    lines.push({ source: "pay_item", source_id: Number(it.id), name: String(it.name), kind: it.kind === "deduction" ? "deduction" : "earning", amount });
  }
  const adjustments: any[] = ((await queryDB("SELECT * FROM salary_adjustments WHERE employee_id = ?", [employeeId]).catch(() => [])) || []).filter(
    (a: any) => Number(a.employee_id) === employeeId && a.status === "active" && String(a.start_month) <= monthYear
  );
  const used = await appliedByAdjustment(
    queryDB,
    adjustments.map((a) => Number(a.id)),
    excludePayrollId
  );
  for (const a of adjustments) {
    const remaining = money(num(a.total_amount) - (used.get(Number(a.id)) || 0));
    if (remaining <= 0) continue;
    const amount = money(Math.min(num(a.installment_amount) || remaining, remaining));
    lines.push({ source: "adjustment", source_id: Number(a.id), name: adjustmentName(a), kind: a.kind === "recovery" ? "deduction" : "earning", amount });
  }
  const sum = (k: string) => money(lines.filter((l) => l.kind === k).reduce((s, l) => s + l.amount, 0));
  return { lines, earnings: sum("earning"), deductions: sum("deduction") };
}

/** Records a run's lines (replacing whatever it had). */
export async function savePayLines(queryDB: QueryDB, payrollId: number, employeeId: number, monthYear: string, lines: PayLine[]) {
  await queryDB("DELETE FROM payroll_line_items WHERE payroll_id = ?", [payrollId]);
  for (const l of lines) {
    await queryDB(
      `INSERT INTO payroll_line_items (payroll_id, employee_id, month_year, source, source_id, name, kind, amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [payrollId, employeeId, monthYear, l.source, l.source_id, l.name, l.kind, l.amount]
    );
  }
}

/** payroll id -> its lines, for the list / payslip / salary sheet. */
export async function loadPayLines(queryDB: QueryDB, payrollIds: number[]) {
  const out = new Map<number, { name: string; kind: string; amount: number; source: string }[]>();
  const ids = Array.from(new Set(payrollIds.filter((n) => Number.isFinite(n) && n > 0)));
  if (ids.length === 0) return out;
  const rows: any[] =
    (await queryDB(
      `SELECT payroll_id, name, kind, amount, source FROM payroll_line_items WHERE payroll_id IN (${ids.map(() => "?").join(",")}) ORDER BY id ASC`,
      ids
    ).catch(() => [])) || [];
  for (const r of rows) {
    const id = Number(r.payroll_id);
    if (!out.has(id)) out.set(id, []);
    out.get(id)!.push({ name: r.name, kind: r.kind, amount: num(r.amount), source: r.source });
  }
  return out;
}

export function registerPayrollItemsRoutes(app: Express, deps: PayrollItemsDeps) {
  const { authenticateToken, requireAdmin, requireModule, queryDB } = deps;
  const guard = [authenticateToken, requireAdmin, requireModule("payroll")];
  const fail = (res: any, err: any) => res.status(err?.statusCode || 500).json({ error: err?.message || String(err) });
  const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

  const employeesById = async (ids: number[]) => {
    const unique = Array.from(new Set(ids.filter((n) => n > 0)));
    if (unique.length === 0) return new Map<number, any>();
    const rows: any[] = await queryDB(
      `SELECT id, name, employee_id AS employee_code, department, designation FROM all_employees WHERE id IN (${unique.map(() => "?").join(",")})`,
      unique
    );
    return new Map<number, any>(rows.map((r) => [Number(r.id), r]));
  };

  // ---- Allowance / Deduction lines -------------------------------------

  app.get("/api/payroll/pay-items", ...guard, async (req: any, res) => {
    try {
      const employeeId = Number(req.query.employee_id) || 0;
      const rows: any[] = employeeId
        ? await queryDB("SELECT * FROM employee_pay_items WHERE employee_id = ? ORDER BY id DESC", [employeeId])
        : await queryDB("SELECT * FROM employee_pay_items ORDER BY id DESC");
      const emps = await employeesById(rows.map((r) => Number(r.employee_id)));
      const ids = rows.map((r) => Number(r.id));
      // How many runs each line has been on so far.
      const usage = new Map<number, number>();
      if (ids.length) {
        const used: any[] =
          (await queryDB(
            `SELECT source_id FROM payroll_line_items WHERE source = 'pay_item' AND source_id IN (${ids.map(() => "?").join(",")})`,
            ids
          ).catch(() => [])) || [];
        for (const u of used) usage.set(Number(u.source_id), (usage.get(Number(u.source_id)) || 0) + 1);
      }
      res.json(
        rows
          .filter((r) => emps.has(Number(r.employee_id)))
          .map((r) => {
            const e = emps.get(Number(r.employee_id));
            return {
              id: Number(r.id),
              employee_id: Number(r.employee_id),
              employee_name: e.name,
              employee_code: e.employee_code,
              department: e.department,
              component_id: r.component_id ? Number(r.component_id) : null,
              name: r.name,
              kind: r.kind,
              amount: num(r.amount),
              start_month: r.start_month,
              end_month: r.end_month || null,
              remarks: r.remarks || null,
              is_active: !!Number(r.is_active),
              runs: usage.get(Number(r.id)) || 0
            };
          })
      );
    } catch (err) {
      fail(res, err);
    }
  });

  // One line for one or many employees at once (a whole department, say).
  app.post("/api/payroll/pay-items", ...guard, async (req: any, res) => {
    try {
      const b = req.body || {};
      const employeeIds: number[] = (Array.isArray(b.employee_ids) ? b.employee_ids : [b.employee_id]).map(Number).filter((n: number) => n > 0);
      if (employeeIds.length === 0) throw bad("Choose at least one employee.");
      let name = clean(b.name, 100);
      let kind = b.kind === "deduction" ? "deduction" : b.kind === "earning" ? "earning" : "";
      const componentId = Number(b.component_id) || null;
      if (componentId) {
        const comp: any[] = await queryDB("SELECT * FROM salary_components WHERE id = ?", [componentId]);
        if (!comp.length) throw bad("That Salary Component no longer exists.");
        name = name || String(comp[0].name);
        kind = kind || comp[0].component_type;
      }
      if (!name) throw bad("Give the allowance or deduction a name.");
      if (!kind) throw bad("Choose whether this is paid (allowance) or taken (deduction).");
      const amount = money(num(b.amount));
      if (!(amount > 0)) throw bad("Enter an amount more than 0.");
      const start = String(b.start_month || "");
      if (!MONTH_RE.test(start)) throw bad("Choose the month it starts from.");
      const end = b.end_month ? String(b.end_month) : null;
      if (end && (!MONTH_RE.test(end) || end < start)) throw bad("The end month must be the start month or later.");
      const emps = await employeesById(employeeIds);
      let created = 0;
      for (const id of employeeIds) {
        if (!emps.has(id)) continue;
        await queryDB(
          `INSERT INTO employee_pay_items (employee_id, component_id, name, kind, amount, start_month, end_month, remarks, is_active, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          [id, componentId, name, kind, amount, start, end, clean(b.remarks, 255) || null, req.user.id]
        );
        created++;
      }
      if (!created) throw bad("None of those employees were found.");
      res.json({ success: true, created });
    } catch (err) {
      fail(res, err);
    }
  });

  const payItem = async (id: number) => {
    const rows: any[] = await queryDB("SELECT * FROM employee_pay_items WHERE id = ?", [id]);
    const row = rows.find((r) => Number(r.id) === id);
    if (!row) throw bad("Allowance / deduction not found.", 404);
    return row;
  };

  app.put("/api/payroll/pay-items/:id", ...guard, async (req: any, res) => {
    try {
      const row = await payItem(Number(req.params.id));
      const b = req.body || {};
      const amount = b.amount !== undefined ? money(num(b.amount)) : num(row.amount);
      if (!(amount > 0)) throw bad("Enter an amount more than 0.");
      const start = b.start_month !== undefined ? String(b.start_month) : String(row.start_month);
      if (!MONTH_RE.test(start)) throw bad("Choose the month it starts from.");
      const end = b.end_month !== undefined ? (b.end_month ? String(b.end_month) : null) : row.end_month || null;
      if (end && (!MONTH_RE.test(end) || end < start)) throw bad("The end month must be the start month or later.");
      const name = b.name !== undefined ? clean(b.name, 100) : row.name;
      if (!name) throw bad("Give the allowance or deduction a name.");
      const active = b.is_active !== undefined ? (b.is_active ? 1 : 0) : Number(row.is_active) ? 1 : 0;
      const remarks = b.remarks !== undefined ? clean(b.remarks, 255) || null : row.remarks;
      await queryDB("UPDATE employee_pay_items SET name = ?, amount = ?, start_month = ?, end_month = ?, is_active = ?, remarks = ? WHERE id = ?", [
        name,
        amount,
        start,
        end,
        active,
        remarks,
        Number(row.id)
      ]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Runs already generated keep their own copy of the line; this only stops
  // it from being added again.
  app.delete("/api/payroll/pay-items/:id", ...guard, async (req: any, res) => {
    try {
      const row = await payItem(Number(req.params.id));
      await queryDB("DELETE FROM employee_pay_items WHERE id = ?", [Number(row.id)]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Salary adjustments (arrear / recovery) ---------------------------

  app.get("/api/payroll/adjustments", ...guard, async (req: any, res) => {
    try {
      const employeeId = Number(req.query.employee_id) || 0;
      const rows: any[] = employeeId
        ? await queryDB("SELECT * FROM salary_adjustments WHERE employee_id = ? ORDER BY id DESC", [employeeId])
        : await queryDB("SELECT * FROM salary_adjustments ORDER BY id DESC");
      const emps = await employeesById(rows.map((r) => Number(r.employee_id)));
      const ids = rows.map((r) => Number(r.id));
      const applied: any[] = ids.length
        ? (await queryDB(
            `SELECT li.source_id, li.month_year, li.amount, p.payment_status
             FROM payroll_line_items li JOIN payrolls p ON p.id = li.payroll_id
             WHERE li.source = 'adjustment' AND li.source_id IN (${ids.map(() => "?").join(",")})
             ORDER BY li.month_year ASC`,
            ids
          ).catch(() => [])) || []
        : [];
      const users: any[] = (await queryDB("SELECT id, name FROM users").catch(() => [])) || [];
      const userName = new Map(users.map((u: any) => [Number(u.id), u.name]));
      res.json(
        rows
          .filter((r) => emps.has(Number(r.employee_id)))
          .map((r) => {
            const e = emps.get(Number(r.employee_id));
            const mine = applied.filter((a) => Number(a.source_id) === Number(r.id));
            const used = money(mine.reduce((s, a) => s + num(a.amount), 0));
            const remaining = money(Math.max(0, num(r.total_amount) - used));
            return {
              id: Number(r.id),
              employee_id: Number(r.employee_id),
              employee_name: e.name,
              employee_code: e.employee_code,
              department: e.department,
              kind: r.kind,
              for_month: r.for_month,
              label: adjustmentName(r),
              total_amount: num(r.total_amount),
              installment_amount: num(r.installment_amount),
              start_month: r.start_month,
              reason: r.reason || null,
              status: r.status === "cancelled" ? "cancelled" : remaining <= 0 ? "settled" : "active",
              applied_amount: used,
              remaining_amount: r.status === "cancelled" ? 0 : remaining,
              applications: mine.map((a) => ({ month_year: a.month_year, amount: num(a.amount), payment_status: a.payment_status })),
              created_by_name: userName.get(Number(r.created_by)) || null,
              created_at: r.created_at
            };
          })
      );
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/payroll/adjustments", ...guard, async (req: any, res) => {
    try {
      const b = req.body || {};
      const employeeId = Number(b.employee_id);
      if (!(await employeesById([employeeId])).has(employeeId)) throw bad("Choose the employee.");
      const kind = b.kind === "recovery" ? "recovery" : b.kind === "arrear" ? "arrear" : "";
      if (!kind) throw bad("Choose Arrear (paid too little) or Recovery (paid too much).");
      const forMonth = String(b.for_month || "");
      if (!MONTH_RE.test(forMonth)) throw bad("Choose the month that was paid wrong.");
      const total = money(num(b.total_amount));
      if (!(total > 0)) throw bad("Enter the difference amount.");
      const start = String(b.start_month || "");
      if (!MONTH_RE.test(start)) throw bad("Choose the month to settle it in.");
      if (start <= forMonth) throw bad("Settle it in a month after the one that was paid wrong.");
      const installments = Math.max(1, Math.min(24, Math.round(num(b.installments, 1))));
      const installment = money(Math.ceil((total / installments) * 100) / 100);
      const reason = clean(b.reason, 500);
      if (!reason) throw bad("Write the reason, so the employee and auditors understand it.");
      await queryDB(
        `INSERT INTO salary_adjustments (employee_id, kind, for_month, total_amount, installment_amount, start_month, reason, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        [employeeId, kind, forMonth, total, installment, start, reason, req.user.id]
      );
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  const adjustment = async (id: number) => {
    const rows: any[] = await queryDB("SELECT * FROM salary_adjustments WHERE id = ?", [id]);
    const row = rows.find((r) => Number(r.id) === id);
    if (!row) throw bad("Adjustment not found.", 404);
    return row;
  };

  // Stops what's left; whatever runs already carried stays on them.
  app.post("/api/payroll/adjustments/:id/cancel", ...guard, async (req: any, res) => {
    try {
      const row = await adjustment(Number(req.params.id));
      if (row.status === "cancelled") throw bad("Already cancelled.");
      await queryDB("UPDATE salary_adjustments SET status = 'cancelled', cancelled_by = ?, cancelled_at = ? WHERE id = ?", [req.user.id, new Date(), Number(row.id)]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Only while no payroll run has carried any of it.
  app.delete("/api/payroll/adjustments/:id", ...guard, async (req: any, res) => {
    try {
      const row = await adjustment(Number(req.params.id));
      const used = await appliedByAdjustment(queryDB, [Number(row.id)]);
      if ((used.get(Number(row.id)) || 0) > 0) throw bad("A payroll run already carries part of this — cancel it instead, so the record stays.");
      await queryDB("DELETE FROM salary_adjustments WHERE id = ?", [Number(row.id)]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // The figures of the month being corrected, to compare against.
  app.get("/api/payroll/adjustments/reference", ...guard, async (req: any, res) => {
    try {
      const employeeId = Number(req.query.employee_id) || 0;
      const monthYear = String(req.query.month_year || "");
      if (!employeeId || !MONTH_RE.test(monthYear)) return res.json(null);
      const rows: any[] = await queryDB("SELECT * FROM payrolls WHERE employee_id = ? AND month_year = ?", [employeeId, monthYear]);
      const p = rows.find((r) => Number(r.employee_id) === employeeId && r.month_year === monthYear);
      if (!p) return res.json(null);
      res.json({
        id: Number(p.id),
        gross_earned: num(p.gross_earned),
        total_deduction: num(p.total_deduction),
        net_salary: num(p.net_salary),
        payment_status: p.payment_status
      });
    } catch (err) {
      fail(res, err);
    }
  });
}
