/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll Module (Self Service -> Payroll / Admin Panel -> Payroll) — split
// into its own file from day one (same reasoning as
// ConveyanceBillClaimRoutes.ts, AttendanceRoutes.ts, LeaveRoutes.ts, etc. —
// keeps server.ts from growing further) and registered from inside
// startServer() via registerPayrollRoutes(), reusing that request's
// authenticateToken/requireAdmin/queryDB/requireModule rather than a second
// Express app or DB connection.
//
// Data model (see payroll_schema.sql / ensurePayrollSchema below):
//   salary_structures  — one row per (employee, effective_date). An
//                         employee's "current" structure is always resolved
//                         as the most recent row on or before the date in
//                         question — never overwritten in place — so past
//                         payroll runs keep referring to the numbers that
//                         were actually in effect at the time.
//   employee_advances  — company loans/advances recovered in fixed monthly
//                         installments; paid_amount accumulates every time a
//                         payroll run that deducted this advance is marked
//                         Paid, and status flips to 'completed' once
//                         paid_amount reaches total_amount.
//   payrolls           — one processed row per (employee, month_year),
//                         enforced by a UNIQUE KEY so generating twice for
//                         the same employee/month is refused, not duplicated.
//
// employee_id everywhere below points at all_employees(id) — the Employee
// Directory roster (Admin Panel -> Employees) — NOT users(id). Payroll
// covers the whole company roster, most of whom never get a login account,
// so all_employees is the correct anchor the same way employee_supervisors
// already uses it.
//
// Permission-gated behind the 'payroll' Admin Panel module throughout — a
// Superadmin always has access, anyone else needs it explicitly granted
// (Admin Panel -> Users -> Module Access), exactly like every other module.

import type { Express } from "express";
import { getHolidayMap } from "./holidayRoutes";
import { isMailerConfigured, sendMail } from "./mailer";

interface PayrollRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  // Same requireModule(moduleKey) factory every other Admin Panel module
  // uses (server.ts) — a Superadmin always passes; an Admin/User needs the
  // 'payroll' key granted via Admin Panel -> Users -> Module Access.
  requireModule: (moduleKey: "payroll") => any;
}

// Self-healing migration — same pattern as ensureHolidayCalendarSchema in
// holidayRoutes.ts: CREATE TABLE IF NOT EXISTS means a normal server restart
// is enough to pick this up on an already-running database, no manual SQL
// required. Called from server.ts's ensureSchemaMigrations() alongside every
// other table.
export async function ensurePayrollSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS salary_structures (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        basic_salary DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        house_rent DECIMAL(10, 2) DEFAULT 0.00,
        medical_allowance DECIMAL(10, 2) DEFAULT 0.00,
        conveyance_allowance DECIMAL(10, 2) DEFAULT 0.00,
        other_allowance DECIMAL(10, 2) DEFAULT 0.00,
        gross_salary DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        tax_deduction DECIMAL(10, 2) DEFAULT 0.00,
        pf_deduction DECIMAL(10, 2) DEFAULT 0.00,
        effective_date DATE NOT NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_salary_structures_employee_date (employee_id, effective_date)
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS employee_advances (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        total_amount DECIMAL(10, 2) NOT NULL,
        monthly_installment DECIMAL(10, 2) NOT NULL,
        paid_amount DECIMAL(10, 2) DEFAULT 0.00,
        reason VARCHAR(255) NULL,
        status ENUM('active', 'completed') DEFAULT 'active',
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS payrolls (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        month_year VARCHAR(7) NOT NULL,
        total_working_days INT NOT NULL,
        present_days INT NOT NULL DEFAULT 0,
        absent_days INT NOT NULL DEFAULT 0,
        leave_days INT NOT NULL DEFAULT 0,
        lwp_days INT NOT NULL DEFAULT 0,
        overtime_hours DECIMAL(5, 2) DEFAULT 0.00,
        basic_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        allowances_total DECIMAL(10, 2) DEFAULT 0.00,
        overtime_amount DECIMAL(10, 2) DEFAULT 0.00,
        bonus_amount DECIMAL(10, 2) DEFAULT 0.00,
        gross_earned DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        absent_deduction DECIMAL(10, 2) DEFAULT 0.00,
        tax_deduction DECIMAL(10, 2) DEFAULT 0.00,
        pf_deduction DECIMAL(10, 2) DEFAULT 0.00,
        advance_deduction DECIMAL(10, 2) DEFAULT 0.00,
        other_deduction DECIMAL(10, 2) DEFAULT 0.00,
        total_deduction DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        net_salary DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        payment_status ENUM('unpaid', 'processed', 'paid') DEFAULT 'unpaid',
        payment_method VARCHAR(50) DEFAULT 'Bank Transfer',
        remarks TEXT NULL,
        generated_by INT NULL,
        paid_by INT NULL,
        paid_at TIMESTAMP NULL DEFAULT NULL,
        processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE,
        FOREIGN KEY (generated_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (paid_by) REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE KEY unique_employee_month (employee_id, month_year)
      )
    `);
    // ---- Salary Structure Setup: Components & Pay Grades ------------------
    // salary_components — the reusable catalogue of Earning/Deduction line
    // items shown on the "Salary Templates / Components Setup" page (Basic,
    // House Rent, Conveyance, Medical, Special Allowance, PF, Tax, Advance
    // Salary, Fine/Penalty...). Nothing here touches payroll math directly —
    // it's config data that Pay Grades (below) and, eventually, a richer
    // Salary Structure form are built from.
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS salary_components (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        component_type ENUM('earning', 'deduction') NOT NULL,
        description VARCHAR(255) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE KEY unique_component_name (name)
      )
    `);
    // pay_grades — "Grade 1", "Grade 2"... each with a base Basic Salary and
    // a set of components (via pay_grade_components below) that together
    // describe the designation's default pay package. Assigning a grade to
    // an employee (POST .../assign) turns this into an actual
    // salary_structures row for that employee.
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS pay_grades (
        id INT AUTO_INCREMENT PRIMARY KEY,
        grade_name VARCHAR(100) NOT NULL,
        grade_code VARCHAR(20) NULL,
        basic_salary DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        description VARCHAR(255) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE KEY unique_grade_name (grade_name)
      )
    `);
    // pay_grade_components — the amount a given grade pays/deducts for each
    // component. Deleting a grade cascades here; a component that's in use
    // on a grade is protected from deletion (see the DELETE route below) so
    // grades never end up referencing a component that no longer exists.
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS pay_grade_components (
        id INT AUTO_INCREMENT PRIMARY KEY,
        pay_grade_id INT NOT NULL,
        component_id INT NOT NULL,
        amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        FOREIGN KEY (pay_grade_id) REFERENCES pay_grades(id) ON DELETE CASCADE,
        FOREIGN KEY (component_id) REFERENCES salary_components(id) ON DELETE RESTRICT,
        UNIQUE KEY unique_grade_component (pay_grade_id, component_id)
      )
    `);
    // ---- Loan/Advance Requests (employee submit -> Admin approve/reject) --
    // Fills the gap called out in PayrollModule_wiring_notes.md: logs a
    // *request* separately from the actual employee_advances row. Approving
    // one INSERTs into employee_advances (advance_id records which row) —
    // rejecting just closes the request out with a remark. Modeled on
    // ConveyanceBillClaimRoutes.ts's user_claims pending -> decision shape.
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS advance_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        total_amount DECIMAL(10, 2) NOT NULL,
        monthly_installment DECIMAL(10, 2) NOT NULL,
        reason VARCHAR(255) NULL,
        status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
        requested_by INT NULL,
        decided_by INT NULL,
        decision_remarks VARCHAR(255) NULL,
        advance_id INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        decided_at TIMESTAMP NULL DEFAULT NULL,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE,
        FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (advance_id) REFERENCES employee_advances(id) ON DELETE SET NULL
      )
    `);
    // ---- Pending Bonuses (stage a bonus before payroll is generated) ------
    // Fills the other gap called out in the wiring notes: lets
    // BonusIncentiveManagementPanel.tsx "stage" a bonus for an employee who
    // has no payroll run yet for the month. The Run Payroll Wizard's
    // attendance-summary step reads these back per employee/month, and
    // generate/generate-bulk delete the matching rows once the run that
    // used them is actually created, so a staged bonus is never applied
    // twice. Multiple rows per employee/month are allowed (e.g. a Festival
    // Bonus staged separately from a Performance Bonus) — they sum on read.
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS pending_bonuses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        month_year VARCHAR(7) NOT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        reason VARCHAR(255) NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_pending_bonuses_emp_month (employee_id, month_year)
      )
    `);
    // ---- Late Attendance Policy ---------------------------------------------
    // late_policy_settings — same "never update in place" history pattern as
    // salary_structures: changing the shift start time / grace period / lates-
    // per-deduction-day inserts a NEW row with a new effective_date rather than
    // overwriting the old one, so a payroll run for an old month always applies
    // whatever policy was actually in force that month, and Admin Panel can show
    // a change history (who changed what, when). "Current" policy for a given
    // month = the most recent row with effective_date <= that month's 1st.
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS late_policy_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        shift_start_time TIME NOT NULL DEFAULT '09:00:00',
        grace_minutes INT NOT NULL DEFAULT 10,
        lates_per_deduction_day INT NOT NULL DEFAULT 3,
        extreme_grace_minutes INT NOT NULL DEFAULT 60,
        extreme_lates_per_deduction_day INT NOT NULL DEFAULT 1,
        effective_date DATE NOT NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_late_policy_effective (effective_date)
      )
    `);
    // extreme_grace_minutes/extreme_lates_per_deduction_day — Extreme Delay,
    // a second, stricter check-in cutoff past the normal Delay grace period
    // (e.g. checking in past 10:00 instead of just past 9:10). Added via
    // ALTER since the table above may already exist on a running database
    // from before this tier existed.
    try {
      await dbPool.query(`ALTER TABLE late_policy_settings ADD COLUMN extreme_grace_minutes INT NOT NULL DEFAULT 60`);
    } catch (err: any) {
      if (err.code !== "ER_DUP_FIELDNAME") console.warn("⚠️ Could not add late_policy_settings.extreme_grace_minutes column: " + err.message);
    }
    try {
      await dbPool.query(`ALTER TABLE late_policy_settings ADD COLUMN extreme_lates_per_deduction_day INT NOT NULL DEFAULT 1`);
    } catch (err: any) {
      if (err.code !== "ER_DUP_FIELDNAME") console.warn("⚠️ Could not add late_policy_settings.extreme_lates_per_deduction_day column: " + err.message);
    }
    // Seed one default row (09:00 start, 10 min grace i.e. late past 9:10, 3
    // lates = 1 day deducted; Extreme Delay past 10:00, every occurrence = 1
    // day deducted) so the feature works out of the box on a fresh install —
    // only when the table is completely empty, never overwriting an Admin's
    // own settings.
    const [existingPolicyRows] = await dbPool.query(`SELECT COUNT(*) AS c FROM late_policy_settings`);
    if (Number(existingPolicyRows?.[0]?.c || 0) === 0) {
      await dbPool.query(
        `INSERT INTO late_policy_settings (shift_start_time, grace_minutes, lates_per_deduction_day, extreme_grace_minutes, extreme_lates_per_deduction_day, effective_date)
         VALUES ('09:00:00', 10, 3, 60, 1, '2000-01-01')`
      );
    }
    // late_waivers — HR/Admin excusing one specific (employee, date) late
    // mark so it's dropped from that month's late count before the "3 lates =
    // 1 day" threshold is evaluated. A row here means "don't count this day",
    // nothing more — deleting the row un-waives it.
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS late_waivers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        waiver_date DATE NOT NULL,
        reason VARCHAR(255) NULL,
        waived_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE,
        FOREIGN KEY (waived_by) REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE KEY unique_employee_waiver_date (employee_id, waiver_date)
      )
    `);
    // payrolls needs a place to record what the late policy actually charged
    // on this specific run, for the payslip and for history — added via
    // ALTER since the table above may already exist on a running database.
    try {
      await dbPool.query(`ALTER TABLE payrolls ADD COLUMN late_count INT NOT NULL DEFAULT 0`);
    } catch (err: any) {
      if (err.code !== "ER_DUP_FIELDNAME") console.warn("⚠️ Could not add payrolls.late_count column: " + err.message);
    }
    try {
      await dbPool.query(`ALTER TABLE payrolls ADD COLUMN late_deduction_days INT NOT NULL DEFAULT 0`);
    } catch (err: any) {
      if (err.code !== "ER_DUP_FIELDNAME") console.warn("⚠️ Could not add payrolls.late_deduction_days column: " + err.message);
    }
    try {
      await dbPool.query(`ALTER TABLE payrolls ADD COLUMN late_deduction_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00`);
    } catch (err: any) {
      if (err.code !== "ER_DUP_FIELDNAME") console.warn("⚠️ Could not add payrolls.late_deduction_amount column: " + err.message);
    }
  } catch (err: any) {
    console.warn("⚠️ Could not ensure payroll tables exist: " + err.message);
  }
}

const MONTH_YEAR_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function num(v: any, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Rounds to 2 decimals the same way every DECIMAL(10,2) column here stores.
function money(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

// Currency string for the Email Payslip HTML body — same ৳/en-BD formatting
// PayrollModule.tsx and its panels use on the client.
function fmtMoney(v: number): string {
  return `৳${(Number(v) || 0).toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// One employee's payslip as an HTML email body — the "Email Payslips" gap
// called out in PayrollModule_wiring_notes.md. Deliberately a plain HTML
// table rather than a re-creation of the branded jsPDF letterhead (that
// PDF is built client-side using the browser's Image/Canvas APIs, which
// aren't available in this Node server) — the figures are identical, just
// laid out as an email instead of a PDF attachment.
function buildPayslipEmailHtml(record: any): string {
  const [y, m] = String(record.month_year).split("-").map(Number);
  const monthLabel = y && m ? new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" }) : record.month_year;
  const cell = "padding:6px 8px; border-bottom:1px solid #e2e8f0;";
  return `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; color:#0f172a;">
      <h2 style="color:#1e3a8a; margin-bottom:2px;">Payslip — ${monthLabel}</h2>
      <p style="color:#475569; margin-top:0; font-size:13px;">
        ${record.employee_name}${record.employee_code ? ` (${record.employee_code})` : ""} · ${record.designation || "—"} · ${record.department || "—"}
      </p>
      <table style="width:100%; border-collapse:collapse; font-size:13px;">
        <tr style="background:#2563eb; color:#ffffff;">
          <th style="padding:6px 8px; text-align:left;">Earnings</th>
          <th style="padding:6px 8px; text-align:right;">Amount</th>
          <th style="padding:6px 8px; text-align:left;">Deductions</th>
          <th style="padding:6px 8px; text-align:right;">Amount</th>
        </tr>
        <tr>
          <td style="${cell}">Basic Salary</td><td style="${cell} text-align:right;">${fmtMoney(record.basic_amount)}</td>
          <td style="${cell}">Absent / LWP Deduction</td><td style="${cell} text-align:right;">${fmtMoney(record.absent_deduction)}</td>
        </tr>
        <tr>
          <td style="${cell}">Allowances</td><td style="${cell} text-align:right;">${fmtMoney(record.allowances_total)}</td>
          <td style="${cell}">Tax Deduction</td><td style="${cell} text-align:right;">${fmtMoney(record.tax_deduction)}</td>
        </tr>
        <tr>
          <td style="${cell}">Overtime</td><td style="${cell} text-align:right;">${fmtMoney(record.overtime_amount)}</td>
          <td style="${cell}">Provident Fund</td><td style="${cell} text-align:right;">${fmtMoney(record.pf_deduction)}</td>
        </tr>
        <tr>
          <td style="padding:6px 8px;">Bonus</td><td style="padding:6px 8px; text-align:right;">${fmtMoney(record.bonus_amount)}</td>
          <td style="padding:6px 8px;">Advance Recovery</td><td style="padding:6px 8px; text-align:right;">${fmtMoney(record.advance_deduction)}</td>
        </tr>
        <tr style="background:#f1f5f9; font-weight:bold;">
          <td style="padding:6px 8px;">Gross Earned</td><td style="padding:6px 8px; text-align:right;">${fmtMoney(record.gross_earned)}</td>
          <td style="padding:6px 8px;">Total Deduction</td><td style="padding:6px 8px; text-align:right;">${fmtMoney(record.total_deduction)}</td>
        </tr>
      </table>
      <p style="font-size:15px; font-weight:bold; margin-top:14px;">Net Salary: ${fmtMoney(record.net_salary)}</p>
      <p style="font-size:11px; color:#64748b;">
        Attendance: ${record.present_days} present / ${record.absent_days} absent / ${record.leave_days} leave / ${record.lwp_days} LWP out of ${record.total_working_days} working days
      </p>
      ${record.remarks ? `<p style="font-size:11px; color:#64748b;">Remarks: ${record.remarks}</p>` : ""}
      <p style="font-size:10px; color:#94a3b8; margin-top:20px;">This is an automated message from the Payroll system. Please do not reply directly to this email.</p>
    </div>
  `;
}

export function registerPayrollRoutes(app: Express, deps: PayrollRouteDeps) {
  const { authenticateToken, requireAdmin, requireModule, queryDB } = deps;

  // Self Service -> Payroll landing ping. Kept for the existing frontend
  // call (PayrollModule.tsx) that confirms the module is wired end-to-end;
  // now reports "active" since real endpoints exist below instead of the
  // original "coming_soon" placeholder.
  app.get("/api/payroll/status", authenticateToken, requireModule("payroll"), async (req: any, res) => {
    try {
      res.json({ status: "active" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Dashboard ----------------------------------------------------------
  // Everything the Payroll Dashboard (PayrollModule.tsx) needs in one round
  // trip: the selected month's totals broken down by payment_status, the
  // company-wide bonus/deduction totals, the active headcount, a
  // department-wise breakdown of that month's net salary, and a trailing
  // 6-month expense trend (zero-filled for months with no runs yet) so the
  // chart never has gaps.
  app.get("/api/payroll/dashboard-summary", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const requested = req.query.month_year ? String(req.query.month_year) : "";
      const monthYear = MONTH_YEAR_RE.test(requested) ? requested : new Date().toISOString().slice(0, 7);

      const statusRows = await queryDB(
        `SELECT payment_status,
                COUNT(*) AS cnt,
                COALESCE(SUM(net_salary), 0) AS amt,
                COALESCE(SUM(bonus_amount), 0) AS bonus,
                COALESCE(SUM(total_deduction), 0) AS deductions
         FROM payrolls
         WHERE month_year = ?
         GROUP BY payment_status`,
        [monthYear]
      );

      const summary: Record<"unpaid" | "processed" | "paid", { count: number; amount: number }> = {
        unpaid: { count: 0, amount: 0 },
        processed: { count: 0, amount: 0 },
        paid: { count: 0, amount: 0 }
      };
      let totalExpense = 0;
      let totalBonus = 0;
      let totalDeductions = 0;
      for (const row of statusRows) {
        const key = row.payment_status as "unpaid" | "processed" | "paid";
        if (summary[key]) summary[key] = { count: Number(row.cnt), amount: money(num(row.amt)) };
        totalExpense = money(totalExpense + num(row.amt));
        totalBonus = money(totalBonus + num(row.bonus));
        totalDeductions = money(totalDeductions + num(row.deductions));
      }

      const activeEmployeesRows = await queryDB(`SELECT COUNT(*) AS cnt FROM all_employees WHERE is_active = 1`);
      const activeEmployees = Number(activeEmployeesRows[0]?.cnt || 0);

      const deptRows = await queryDB(
        `SELECT COALESCE(NULLIF(e.department, ''), 'Unassigned') AS department,
                COALESCE(SUM(p.net_salary), 0) AS total
         FROM payrolls p
         JOIN all_employees e ON e.id = p.employee_id
         WHERE p.month_year = ?
         GROUP BY department
         ORDER BY total DESC`,
        [monthYear]
      );

      // Trailing 6 months including the selected one, oldest first.
      const [yy, mm] = monthYear.split("-").map(Number);
      const monthKeys: string[] = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(yy, mm - 1 - i, 1);
        monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      }
      const trendRows = await queryDB(
        `SELECT month_year, COALESCE(SUM(net_salary), 0) AS total
         FROM payrolls
         WHERE month_year IN (?, ?, ?, ?, ?, ?)
         GROUP BY month_year`,
        monthKeys
      );
      const trendMap = new Map<string, number>(trendRows.map((r: any) => [r.month_year, money(num(r.total))]));
      const monthlyTrend = monthKeys.map((k) => ({ month_year: k, total: trendMap.get(k) || 0 }));

      res.json({
        month_year: monthYear,
        total_expense: totalExpense,
        total_bonus: totalBonus,
        total_deductions: totalDeductions,
        active_employees: activeEmployees,
        paid: summary.paid,
        unpaid: summary.unpaid,
        processed: summary.processed,
        department_distribution: deptRows.map((r: any) => ({ department: r.department, total: money(num(r.total)) })),
        monthly_trend: monthlyTrend
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Lightweight active-employee picker for the "Process Payroll" quick
  // action — deliberately scoped to Payroll's own module permission (same
  // pattern LeaveRoutes.ts uses for its own "SELECT * FROM all_employees")
  // rather than requiring the separate 'employees' module too.
  app.get("/api/payroll/employees", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const rows = await queryDB(
        `SELECT id, employee_id AS employee_code, name, department, designation
         FROM all_employees
         WHERE is_active = 1
         ORDER BY name ASC`
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Employee Salary Profiles / Payroll List (Payroll -> Payroll List) — one
  // row per employee's payroll run for the selected month, with the
  // combined allowances_total column broken back out into House Rent /
  // Medical / Other so the list can show the same categories the Salary
  // Structure was built from. The breakdown isn't stored per-run (only the
  // combined total is, see the `payrolls` table comment), but it's fully
  // recoverable: /generate always scaled every allowance category by the
  // same present/working-days ratio, so re-applying that ratio to the
  // structure that was in effect for that month reproduces the exact
  // earned split, not an estimate.
  app.get("/api/payroll/employee-list", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const requested = req.query.month_year ? String(req.query.month_year) : "";
      const monthYear = MONTH_YEAR_RE.test(requested) ? requested : new Date().toISOString().slice(0, 7);
      const department = req.query.department ? String(req.query.department).trim() : "";
      const paymentStatus = req.query.payment_status ? String(req.query.payment_status) : "";
      const search = req.query.search ? String(req.query.search).trim() : "";

      const conditions: string[] = ["p.month_year = ?"];
      const params: any[] = [monthYear];
      if (department) {
        conditions.push("e.department = ?");
        params.push(department);
      }
      if (["unpaid", "processed", "paid"].includes(paymentStatus)) {
        conditions.push("p.payment_status = ?");
        params.push(paymentStatus);
      }
      if (search) {
        conditions.push("(e.name LIKE ? OR e.employee_id LIKE ?)");
        params.push(`%${search}%`, `%${search}%`);
      }

      const rows = await queryDB(
        `SELECT p.id, p.employee_id, p.month_year, p.total_working_days, p.present_days,
                p.basic_amount, p.allowances_total, p.tax_deduction, p.pf_deduction,
                p.advance_deduction, p.other_deduction, p.absent_deduction, p.total_deduction,
                p.net_salary, p.payment_status,
                e.name AS employee_name, e.employee_id AS employee_code, e.designation, e.department
         FROM payrolls p
         JOIN all_employees e ON e.id = p.employee_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY e.name ASC`,
        params
      );

      // One salary structure per employee — the one in effect as of the
      // selected month's last day, same resolution rule /generate uses.
      const structureRows = await queryDB(
        `SELECT ss.employee_id, ss.house_rent, ss.medical_allowance, ss.conveyance_allowance, ss.other_allowance
         FROM (
           SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.employee_id ORDER BY s.effective_date DESC, s.id DESC) AS rn
           FROM salary_structures s
           WHERE s.effective_date <= LAST_DAY(?)
         ) ss
         WHERE ss.rn = 1`,
        [`${monthYear}-01`]
      );
      const structureByEmployee = new Map<number, any>(structureRows.map((s: any) => [s.employee_id, s]));

      const records = rows.map((r: any) => {
        const ratio = num(r.total_working_days) > 0 ? num(r.present_days) / num(r.total_working_days) : 0;
        const structure = structureByEmployee.get(r.employee_id);
        const houseRent = structure ? money(num(structure.house_rent) * ratio) : 0;
        const medicalAllowance = structure ? money(num(structure.medical_allowance) * ratio) : 0;
        const otherAllowance = structure
          ? money((num(structure.conveyance_allowance) + num(structure.other_allowance)) * ratio)
          : money(num(r.allowances_total) - houseRent - medicalAllowance);
        return {
          id: r.id,
          employee_id: r.employee_id,
          employee_code: r.employee_code,
          employee_name: r.employee_name,
          designation: r.designation,
          department: r.department,
          month_year: r.month_year,
          basic_salary: num(r.basic_amount),
          house_rent: houseRent,
          medical_allowance: medicalAllowance,
          other_allowance: otherAllowance,
          tax_deduction: num(r.tax_deduction),
          pf_deduction: num(r.pf_deduction),
          other_deduction: money(num(r.other_deduction) + num(r.advance_deduction) + num(r.absent_deduction)),
          total_deduction: num(r.total_deduction),
          net_salary: num(r.net_salary),
          payment_status: r.payment_status
        };
      });

      res.json({ month_year: monthYear, records });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Salary Structures -----------------------------------------------
  // A history table, not an edit-in-place record — see the table comment.

  // List salary structure rows, optionally scoped to one employee, most
  // recent effective_date first. Used both for the per-employee history view
  // and (with ?employee_id=) to populate an edit form with the latest row.
  app.get("/api/payroll/salary-structures", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const employeeId = req.query.employee_id ? Number(req.query.employee_id) : null;
      const params: any[] = [];
      let sql = `
        SELECT s.*, e.name AS employee_name, e.employee_id AS employee_code, e.designation, e.department
        FROM salary_structures s
        JOIN all_employees e ON e.id = s.employee_id
      `;
      if (employeeId) {
        sql += " WHERE s.employee_id = ?";
        params.push(employeeId);
      }
      sql += " ORDER BY s.employee_id ASC, s.effective_date DESC, s.id DESC";
      const rows = await queryDB(sql, params);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // The structure actually in effect for one employee right now (most recent
  // effective_date <= today) — what Generate Payroll uses under the hood,
  // exposed directly so the Admin UI can preview it before generating.
  app.get("/api/payroll/salary-structures/current/:employeeId", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const employeeId = Number(req.params.employeeId);
      const rows = await queryDB(
        `SELECT * FROM salary_structures
         WHERE employee_id = ? AND effective_date <= CURDATE()
         ORDER BY effective_date DESC, id DESC LIMIT 1`,
        [employeeId]
      );
      if (rows.length === 0) return res.status(404).json({ error: "No salary structure set for this employee yet." });
      res.json(rows[0]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // New structure row (a raise/promotion/correction) — gross_salary is
  // always computed here from basic + the four allowances, never trusted
  // from the request body, so it can never drift from its own parts.
  app.post("/api/payroll/salary-structures", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const { employee_id, basic_salary, house_rent, medical_allowance, conveyance_allowance, other_allowance, tax_deduction, pf_deduction, effective_date } = req.body || {};
      if (!employee_id) return res.status(400).json({ error: "employee_id is required." });
      if (!effective_date) return res.status(400).json({ error: "effective_date is required." });

      const empRows = await queryDB("SELECT id FROM all_employees WHERE id = ?", [Number(employee_id)]);
      if (empRows.length === 0) return res.status(404).json({ error: "Employee not found." });

      const basic = num(basic_salary);
      if (basic <= 0) return res.status(400).json({ error: "Basic Salary must be a positive number." });
      const hr = num(house_rent);
      const med = num(medical_allowance);
      const conv = num(conveyance_allowance);
      const other = num(other_allowance);
      const tax = num(tax_deduction);
      const pf = num(pf_deduction);
      const gross = money(basic + hr + med + conv + other);

      const result = await queryDB(
        `INSERT INTO salary_structures
           (employee_id, basic_salary, house_rent, medical_allowance, conveyance_allowance, other_allowance, gross_salary, tax_deduction, pf_deduction, effective_date, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [Number(employee_id), basic, hr, med, conv, other, gross, tax, pf, effective_date, req.user.id]
      );
      res.json({ success: true, id: result.insertId, gross_salary: gross });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to save salary structure." });
    }
  });

  // Corrects an existing structure row in place (typo fix) — does NOT
  // create a new history entry. For an actual raise/promotion use POST
  // above instead, so the old numbers stay on file for past payroll runs.
  app.put("/api/payroll/salary-structures/:id", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM salary_structures WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Salary structure not found." });
      const existing = rows[0];

      const basic = num(req.body?.basic_salary, existing.basic_salary);
      const hr = num(req.body?.house_rent, existing.house_rent);
      const med = num(req.body?.medical_allowance, existing.medical_allowance);
      const conv = num(req.body?.conveyance_allowance, existing.conveyance_allowance);
      const other = num(req.body?.other_allowance, existing.other_allowance);
      const tax = num(req.body?.tax_deduction, existing.tax_deduction);
      const pf = num(req.body?.pf_deduction, existing.pf_deduction);
      const effectiveDate = req.body?.effective_date || existing.effective_date;
      if (basic <= 0) return res.status(400).json({ error: "Basic Salary must be a positive number." });
      const gross = money(basic + hr + med + conv + other);

      await queryDB(
        `UPDATE salary_structures
         SET basic_salary = ?, house_rent = ?, medical_allowance = ?, conveyance_allowance = ?, other_allowance = ?, gross_salary = ?, tax_deduction = ?, pf_deduction = ?, effective_date = ?
         WHERE id = ?`,
        [basic, hr, med, conv, other, gross, tax, pf, effectiveDate, req.params.id]
      );
      res.json({ success: true, gross_salary: gross });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to update salary structure." });
    }
  });

  // Removing a structure row never touches already-generated payroll rows —
  // those keep the amounts they were generated with (basic_amount etc. are
  // copied at generate-time, not referenced live).
  app.delete("/api/payroll/salary-structures/:id", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const result = await queryDB("DELETE FROM salary_structures WHERE id = ?", [req.params.id]);
      if (result.affectedRows === 0) return res.status(404).json({ error: "Salary structure not found." });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Salary Structure Setup: Components & Pay Grades ---------------------
  // "বেতন কাঠামো সেটআপ" — Salary Templates/Components Setup (Earning &
  // Deduction line items) and Pay Grade Management (Grade 1, Grade 2...).
  // Config data consumed by the Pay Grades below; POST .../assign is the
  // bridge from a Grade into an actual employee salary_structures row.

  // ---- Salary Components ----
  app.get("/api/payroll/salary-components", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const type = req.query.component_type ? String(req.query.component_type) : "";
      const conditions: string[] = [];
      const params: any[] = [];
      if (type === "earning" || type === "deduction") {
        conditions.push("component_type = ?");
        params.push(type);
      }
      if (req.query.active_only === "1") conditions.push("is_active = 1");
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = await queryDB(
        `SELECT * FROM salary_components ${where} ORDER BY component_type ASC, name ASC`,
        params
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/payroll/salary-components", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 100) : "";
      const componentType = req.body?.component_type === "deduction" ? "deduction" : req.body?.component_type === "earning" ? "earning" : "";
      const description = typeof req.body?.description === "string" ? req.body.description.trim().slice(0, 255) : null;
      if (!name) return res.status(400).json({ error: "Component name is required." });
      if (!componentType) return res.status(400).json({ error: "component_type must be 'earning' or 'deduction'." });

      const result = await queryDB(
        `INSERT INTO salary_components (name, component_type, description, created_by) VALUES (?, ?, ?, ?)`,
        [name, componentType, description, req.user.id]
      );
      res.json({ success: true, id: result.insertId });
    } catch (err: any) {
      if (err && err.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ error: "A component with this name already exists." });
      }
      res.status(500).json({ error: err.message || "Failed to save component." });
    }
  });

  app.put("/api/payroll/salary-components/:id", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM salary_components WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Component not found." });
      const existing = rows[0];

      const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 100) : existing.name;
      const componentType = req.body?.component_type === "deduction" ? "deduction" : req.body?.component_type === "earning" ? "earning" : existing.component_type;
      const description = req.body?.description !== undefined ? String(req.body.description || "").trim().slice(0, 255) || null : existing.description;
      const isActive = req.body?.is_active === false || req.body?.is_active === 0 ? 0 : 1;

      await queryDB(
        `UPDATE salary_components SET name = ?, component_type = ?, description = ?, is_active = ? WHERE id = ?`,
        [name, componentType, description, isActive, req.params.id]
      );
      res.json({ success: true });
    } catch (err: any) {
      if (err && err.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ error: "A component with this name already exists." });
      }
      res.status(500).json({ error: err.message || "Failed to update component." });
    }
  });

  // A component already used on a Pay Grade is protected by the FK
  // (ON DELETE RESTRICT) — the caller is told to deactivate it instead of
  // deleting, same escape hatch is_active gives every other list here.
  app.delete("/api/payroll/salary-components/:id", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const result = await queryDB("DELETE FROM salary_components WHERE id = ?", [req.params.id]);
      if (result.affectedRows === 0) return res.status(404).json({ error: "Component not found." });
      res.json({ success: true });
    } catch (err: any) {
      if (err && (err.code === "ER_ROW_IS_REFERENCED_2" || err.code === "ER_ROW_IS_REFERENCED")) {
        return res.status(400).json({ error: "This component is used on one or more Pay Grades — deactivate it instead of deleting." });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Pay Grades ----
  async function loadGradeWithComponents(queryDB: any, gradeId: number) {
    const gradeRows = await queryDB("SELECT * FROM pay_grades WHERE id = ?", [gradeId]);
    if (gradeRows.length === 0) return null;
    const componentRows = await queryDB(
      `SELECT pgc.id, pgc.component_id, pgc.amount, sc.name, sc.component_type, sc.is_active
       FROM pay_grade_components pgc
       JOIN salary_components sc ON sc.id = pgc.component_id
       WHERE pgc.pay_grade_id = ?
       ORDER BY sc.component_type ASC, sc.name ASC`,
      [gradeId]
    );
    return { ...gradeRows[0], components: componentRows };
  }

  app.get("/api/payroll/pay-grades", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const grades = await queryDB("SELECT * FROM pay_grades ORDER BY grade_name ASC");
      const componentRows = await queryDB(
        `SELECT pgc.pay_grade_id, pgc.component_id, pgc.amount, sc.name, sc.component_type
         FROM pay_grade_components pgc
         JOIN salary_components sc ON sc.id = pgc.component_id`
      );
      const byGrade = new Map<number, any[]>();
      for (const c of componentRows) {
        if (!byGrade.has(c.pay_grade_id)) byGrade.set(c.pay_grade_id, []);
        byGrade.get(c.pay_grade_id)!.push(c);
      }
      const withTotals = grades.map((g: any) => {
        const comps = byGrade.get(g.id) || [];
        const earnings = comps.filter((c: any) => c.component_type === "earning").reduce((s: number, c: any) => s + num(c.amount), 0);
        const deductions = comps.filter((c: any) => c.component_type === "deduction").reduce((s: number, c: any) => s + num(c.amount), 0);
        return { ...g, components: comps, gross_salary: money(num(g.basic_salary) + earnings), total_deductions: money(deductions) };
      });
      res.json(withTotals);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/payroll/pay-grades/:id", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const grade = await loadGradeWithComponents(queryDB, Number(req.params.id));
      if (!grade) return res.status(404).json({ error: "Pay Grade not found." });
      res.json(grade);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Body: { grade_name, grade_code?, basic_salary, description?, components: [{component_id, amount}] }
  app.post("/api/payroll/pay-grades", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const gradeName = typeof req.body?.grade_name === "string" ? req.body.grade_name.trim().slice(0, 100) : "";
      if (!gradeName) return res.status(400).json({ error: "Grade name is required." });
      const basic = num(req.body?.basic_salary);
      if (basic <= 0) return res.status(400).json({ error: "Basic Salary must be a positive number." });
      const gradeCode = typeof req.body?.grade_code === "string" ? req.body.grade_code.trim().slice(0, 20) || null : null;
      const description = typeof req.body?.description === "string" ? req.body.description.trim().slice(0, 255) || null : null;
      const components: Array<{ component_id: any; amount: any }> = Array.isArray(req.body?.components) ? req.body.components : [];

      const result = await queryDB(
        `INSERT INTO pay_grades (grade_name, grade_code, basic_salary, description, created_by) VALUES (?, ?, ?, ?, ?)`,
        [gradeName, gradeCode, basic, description, req.user.id]
      );
      const gradeId = result.insertId;

      for (const c of components) {
        const componentId = Number(c?.component_id);
        const amount = num(c?.amount);
        if (!componentId || amount <= 0) continue;
        await queryDB(
          `INSERT INTO pay_grade_components (pay_grade_id, component_id, amount) VALUES (?, ?, ?)`,
          [gradeId, componentId, amount]
        );
      }

      const grade = await loadGradeWithComponents(queryDB, gradeId);
      res.json({ success: true, id: gradeId, grade });
    } catch (err: any) {
      if (err && err.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ error: "A Pay Grade with this name already exists." });
      }
      res.status(500).json({ error: err.message || "Failed to save Pay Grade." });
    }
  });

  // Replaces the grade's component set wholesale — same "history isn't
  // needed here" reasoning as Employee Advances edits: a grade is a live
  // template, not a per-employee record, so correcting it in place is fine.
  app.put("/api/payroll/pay-grades/:id", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM pay_grades WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Pay Grade not found." });
      const existing = rows[0];

      const gradeName = typeof req.body?.grade_name === "string" && req.body.grade_name.trim() ? req.body.grade_name.trim().slice(0, 100) : existing.grade_name;
      const basic = req.body?.basic_salary !== undefined ? num(req.body.basic_salary, existing.basic_salary) : existing.basic_salary;
      if (basic <= 0) return res.status(400).json({ error: "Basic Salary must be a positive number." });
      const gradeCode = req.body?.grade_code !== undefined ? String(req.body.grade_code || "").trim().slice(0, 20) || null : existing.grade_code;
      const description = req.body?.description !== undefined ? String(req.body.description || "").trim().slice(0, 255) || null : existing.description;
      const isActive = req.body?.is_active === false || req.body?.is_active === 0 ? 0 : 1;

      await queryDB(
        `UPDATE pay_grades SET grade_name = ?, grade_code = ?, basic_salary = ?, description = ?, is_active = ? WHERE id = ?`,
        [gradeName, gradeCode, basic, description, isActive, req.params.id]
      );

      if (Array.isArray(req.body?.components)) {
        await queryDB("DELETE FROM pay_grade_components WHERE pay_grade_id = ?", [req.params.id]);
        for (const c of req.body.components) {
          const componentId = Number(c?.component_id);
          const amount = num(c?.amount);
          if (!componentId || amount <= 0) continue;
          await queryDB(
            `INSERT INTO pay_grade_components (pay_grade_id, component_id, amount) VALUES (?, ?, ?)`,
            [req.params.id, componentId, amount]
          );
        }
      }

      const grade = await loadGradeWithComponents(queryDB, Number(req.params.id));
      res.json({ success: true, grade });
    } catch (err: any) {
      if (err && err.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ error: "A Pay Grade with this name already exists." });
      }
      res.status(500).json({ error: err.message || "Failed to update Pay Grade." });
    }
  });

  app.delete("/api/payroll/pay-grades/:id", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const result = await queryDB("DELETE FROM pay_grades WHERE id = ?", [req.params.id]);
      if (result.affectedRows === 0) return res.status(404).json({ error: "Pay Grade not found." });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Turns a Pay Grade template into an actual salary_structures row for one
  // employee — the bridge between "Grade Management" and the existing
  // per-employee Salary Structure history. Deduction components other than
  // Tax/PF (e.g. a grade-level "Fine") don't have a column to land in on
  // salary_structures (Advance Salary already has its own employee_advances
  // table instead) — those are reported back as `unmapped_deductions` so the
  // caller can show a note rather than silently dropping them.
  app.post("/api/payroll/pay-grades/:id/assign", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const grade = await loadGradeWithComponents(queryDB, Number(req.params.id));
      if (!grade) return res.status(404).json({ error: "Pay Grade not found." });

      const employeeId = Number(req.body?.employee_id);
      if (!employeeId) return res.status(400).json({ error: "employee_id is required." });
      const empRows = await queryDB("SELECT id FROM all_employees WHERE id = ?", [employeeId]);
      if (empRows.length === 0) return res.status(404).json({ error: "Employee not found." });

      const effectiveDate = req.body?.effective_date || new Date().toISOString().slice(0, 10);

      let houseRent = 0, medical = 0, conveyance = 0, otherAllowance = 0, tax = 0, pf = 0;
      const unmappedDeductions: Array<{ name: string; amount: number }> = [];
      for (const c of grade.components) {
        const label = String(c.name).toLowerCase();
        const amt = num(c.amount);
        if (c.component_type === "earning") {
          if (label.includes("house")) houseRent += amt;
          else if (label.includes("medical")) medical += amt;
          else if (label.includes("conveyance") || label.includes("transport")) conveyance += amt;
          else otherAllowance += amt;
        } else {
          if (label.includes("tax")) tax += amt;
          else if (label.includes("provident") || label === "pf" || label.includes(" pf")) pf += amt;
          else unmappedDeductions.push({ name: c.name, amount: amt });
        }
      }

      const basic = num(grade.basic_salary);
      const gross = money(basic + houseRent + medical + conveyance + otherAllowance);

      const result = await queryDB(
        `INSERT INTO salary_structures
           (employee_id, basic_salary, house_rent, medical_allowance, conveyance_allowance, other_allowance, gross_salary, tax_deduction, pf_deduction, effective_date, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [employeeId, basic, money(houseRent), money(medical), money(conveyance), money(otherAllowance), gross, money(tax), money(pf), effectiveDate, req.user.id]
      );
      res.json({ success: true, id: result.insertId, gross_salary: gross, unmapped_deductions: unmappedDeductions });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to assign Pay Grade." });
    }
  });

  // ---- Employee Advances --------------------------------------------------

  app.get("/api/payroll/advances", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const employeeId = req.query.employee_id ? Number(req.query.employee_id) : null;
      const status = req.query.status ? String(req.query.status) : null;
      const conditions: string[] = [];
      const params: any[] = [];
      if (employeeId) {
        conditions.push("a.employee_id = ?");
        params.push(employeeId);
      }
      if (status) {
        conditions.push("a.status = ?");
        params.push(status);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = await queryDB(
        `SELECT a.*, e.name AS employee_name, e.employee_id AS employee_code,
            (a.total_amount - a.paid_amount) AS remaining_amount
         FROM employee_advances a
         JOIN all_employees e ON e.id = a.employee_id
         ${where}
         ORDER BY a.status ASC, a.created_at DESC`,
        params
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/payroll/advances", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const { employee_id, total_amount, monthly_installment, reason } = req.body || {};
      if (!employee_id) return res.status(400).json({ error: "employee_id is required." });
      const empRows = await queryDB("SELECT id FROM all_employees WHERE id = ?", [Number(employee_id)]);
      if (empRows.length === 0) return res.status(404).json({ error: "Employee not found." });

      const total = num(total_amount);
      const installment = num(monthly_installment);
      if (total <= 0) return res.status(400).json({ error: "Total Amount must be a positive number." });
      if (installment <= 0) return res.status(400).json({ error: "Monthly Installment must be a positive number." });
      if (installment > total) return res.status(400).json({ error: "Monthly Installment can't be more than the Total Amount." });

      const result = await queryDB(
        `INSERT INTO employee_advances (employee_id, total_amount, monthly_installment, reason, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [Number(employee_id), total, installment, typeof reason === "string" ? reason.trim().slice(0, 255) : null, req.user.id]
      );
      res.json({ success: true, id: result.insertId });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to save advance." });
    }
  });

  // Lets an Admin correct the installment/reason, or manually close out an
  // advance (status='completed') without waiting for paid_amount to catch
  // up — e.g. the employee settled the rest in cash outside of Payroll.
  app.put("/api/payroll/advances/:id", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM employee_advances WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Advance not found." });
      const existing = rows[0];

      const installment = num(req.body?.monthly_installment, existing.monthly_installment);
      if (installment <= 0) return res.status(400).json({ error: "Monthly Installment must be a positive number." });
      const reason = req.body?.reason !== undefined ? String(req.body.reason).trim().slice(0, 255) : existing.reason;
      const status = req.body?.status === "completed" ? "completed" : req.body?.status === "active" ? "active" : existing.status;

      await queryDB(
        "UPDATE employee_advances SET monthly_installment = ?, reason = ?, status = ? WHERE id = ?",
        [installment, reason, status, req.params.id]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to update advance." });
    }
  });

  // Only removable before any money has actually been recovered against it —
  // once a Paid payroll run has deducted something, deleting the advance
  // would leave that payroll's advance_deduction pointing at nothing.
  app.delete("/api/payroll/advances/:id", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM employee_advances WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Advance not found." });
      if (Number(rows[0].paid_amount) > 0) {
        return res.status(400).json({ error: "This advance already has payments recovered against it and can't be deleted — mark it Completed instead." });
      }
      await queryDB("DELETE FROM employee_advances WHERE id = ?", [req.params.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Loan/Advance Requests (employee submit -> Admin approve/reject) -----
  // Fills the gap called out in PayrollModule_wiring_notes.md: an employee
  // with a linked login (all_employees.user_id) can submit a request here
  // without needing 'payroll' module access; an Admin with that access then
  // approves it (which creates the real employee_advances row — identical
  // validation to POST /api/payroll/advances above) or rejects it with a
  // remark. The existing "New Loan / Advance" flow is unchanged — an Admin
  // can still log one directly with no request step, exactly as before.

  app.post("/api/user-advance-requests", authenticateToken, async (req: any, res) => {
    try {
      const empRows = await queryDB("SELECT id FROM all_employees WHERE user_id = ?", [req.user.id]);
      if (empRows.length === 0) {
        return res.status(400).json({ error: "Your account isn't linked to an Employee Directory record, so a loan/advance request can't be submitted." });
      }
      const employeeId = empRows[0].id;
      const total = num(req.body?.total_amount);
      const installment = num(req.body?.monthly_installment);
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 255) : null;
      if (total <= 0) return res.status(400).json({ error: "Total Amount must be a positive number." });
      if (installment <= 0) return res.status(400).json({ error: "Monthly Installment must be a positive number." });
      if (installment > total) return res.status(400).json({ error: "Monthly Installment can't be more than the Total Amount." });

      const result = await queryDB(
        `INSERT INTO advance_requests (employee_id, total_amount, monthly_installment, reason, requested_by)
         VALUES (?, ?, ?, ?, ?)`,
        [employeeId, total, installment, reason, req.user.id]
      );
      res.json({ success: true, id: result.insertId });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to submit request." });
    }
  });

  app.get("/api/user-advance-requests/mine", authenticateToken, async (req: any, res) => {
    try {
      const empRows = await queryDB("SELECT id FROM all_employees WHERE user_id = ?", [req.user.id]);
      if (empRows.length === 0) return res.json([]);
      const rows = await queryDB("SELECT * FROM advance_requests WHERE employee_id = ? ORDER BY created_at DESC", [empRows[0].id]);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/payroll/advance-requests", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const status = req.query.status ? String(req.query.status) : "pending";
      const conditions: string[] = [];
      const params: any[] = [];
      if (status !== "all") {
        conditions.push("r.status = ?");
        params.push(status);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = await queryDB(
        `SELECT r.*, e.name AS employee_name, e.employee_id AS employee_code
         FROM advance_requests r
         JOIN all_employees e ON e.id = r.employee_id
         ${where}
         ORDER BY (r.status = 'pending') DESC, r.created_at DESC`,
        params
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/payroll/advance-requests/:id/decision", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM advance_requests WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Request not found." });
      const request = rows[0];
      if (request.status !== "pending") return res.status(400).json({ error: "This request has already been decided." });

      const action = req.body?.action;
      const remarks = typeof req.body?.remarks === "string" ? req.body.remarks.trim().slice(0, 255) : null;

      if (action === "reject") {
        await queryDB(
          "UPDATE advance_requests SET status = 'rejected', decided_by = ?, decision_remarks = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?",
          [req.user.id, remarks, req.params.id]
        );
        return res.json({ success: true, status: "rejected" });
      }
      if (action !== "approve") return res.status(400).json({ error: "action must be 'approve' or 'reject'." });

      const total = Number(request.total_amount);
      const installment = Number(request.monthly_installment);
      const result = await queryDB(
        `INSERT INTO employee_advances (employee_id, total_amount, monthly_installment, reason, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [request.employee_id, total, installment, request.reason, req.user.id]
      );
      await queryDB(
        "UPDATE advance_requests SET status = 'approved', decided_by = ?, decision_remarks = ?, decided_at = CURRENT_TIMESTAMP, advance_id = ? WHERE id = ?",
        [req.user.id, remarks, result.insertId, req.params.id]
      );
      res.json({ success: true, status: "approved", advance_id: result.insertId });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to record the decision." });
    }
  });

  // ---- Pending Bonuses (stage a bonus before payroll is generated) --------
  // Fills the other gap called out in the wiring notes: lets
  // BonusIncentiveManagementPanel.tsx "stage" a bonus for an employee who
  // has no payroll run yet for the month. GET .../wizard/attendance-summary
  // below reads these back per employee/month as pending_bonus_amount, and
  // generate/generate-bulk delete the matching rows once the run that used
  // them is actually created, so a staged bonus is never applied twice.
  app.get("/api/payroll/pending-bonuses", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const monthYear = req.query.month_year ? String(req.query.month_year) : null;
      const conditions: string[] = [];
      const params: any[] = [];
      if (monthYear) {
        conditions.push("b.month_year = ?");
        params.push(monthYear);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = await queryDB(
        `SELECT b.*, e.name AS employee_name, e.employee_id AS employee_code, e.department
         FROM pending_bonuses b
         JOIN all_employees e ON e.id = b.employee_id
         ${where}
         ORDER BY b.created_at DESC`,
        params
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/payroll/pending-bonuses", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const employeeId = Number(req.body?.employee_id);
      const monthYear = String(req.body?.month_year || "");
      const amount = money(num(req.body?.amount));
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 255) : null;
      if (!employeeId) return res.status(400).json({ error: "employee_id is required." });
      if (!MONTH_YEAR_RE.test(monthYear)) return res.status(400).json({ error: "month_year must be in 'YYYY-MM' format." });
      if (amount <= 0) return res.status(400).json({ error: "Amount must be a positive number." });

      const empRows = await queryDB("SELECT id FROM all_employees WHERE id = ?", [employeeId]);
      if (empRows.length === 0) return res.status(404).json({ error: "Employee not found." });

      const existing = await queryDB("SELECT id FROM payrolls WHERE employee_id = ? AND month_year = ?", [employeeId, monthYear]);
      if (existing.length > 0) {
        return res.status(400).json({ error: "Payroll for this employee/month already exists — apply the bonus directly to that run instead (Bonus & Incentive's main table)." });
      }

      const result = await queryDB(
        `INSERT INTO pending_bonuses (employee_id, month_year, amount, reason, created_by) VALUES (?, ?, ?, ?, ?)`,
        [employeeId, monthYear, amount, reason, req.user.id]
      );
      res.json({ success: true, id: result.insertId });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to stage bonus." });
    }
  });

  app.delete("/api/payroll/pending-bonuses/:id", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const result = await queryDB("DELETE FROM pending_bonuses WHERE id = ?", [req.params.id]);
      if (result.affectedRows === 0) return res.status(404).json({ error: "Pending bonus not found." });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Payroll runs --------------------------------------------------------

  app.get("/api/payroll", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const monthYear = req.query.month_year ? String(req.query.month_year) : null;
      const employeeId = req.query.employee_id ? Number(req.query.employee_id) : null;
      const paymentStatus = req.query.payment_status ? String(req.query.payment_status) : null;
      const conditions: string[] = [];
      const params: any[] = [];
      if (monthYear) {
        conditions.push("p.month_year = ?");
        params.push(monthYear);
      }
      if (employeeId) {
        conditions.push("p.employee_id = ?");
        params.push(employeeId);
      }
      if (paymentStatus) {
        conditions.push("p.payment_status = ?");
        params.push(paymentStatus);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = await queryDB(
        `SELECT p.*, e.name AS employee_name, e.employee_id AS employee_code, e.designation, e.department
         FROM payrolls p
         JOIN all_employees e ON e.id = p.employee_id
         ${where}
         ORDER BY p.month_year DESC, e.name ASC`,
        params
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/payroll/:id", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const rows = await queryDB(
        `SELECT p.*, e.name AS employee_name, e.employee_id AS employee_code, e.designation, e.department
         FROM payrolls p
         JOIN all_employees e ON e.id = p.employee_id
         WHERE p.id = ?`,
        [req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Payroll record not found." });
      res.json(rows[0]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Email Payslips -------------------------------------------------------
  // Fills the "Email Payslips" gap called out in PayrollModule_wiring_notes.md
  // for PayslipManagementPanel.tsx. Sends the payslip figures as an HTML
  // email (buildPayslipEmailHtml above) via the shared SMTP mailer
  // (mailer.ts) to the employee's Employee Directory email (falling back to
  // their personal email) — nothing sends if SMTP_* isn't configured in .env,
  // and that's reported back as a normal { error } response rather than a
  // silent failure.

  app.post("/api/payroll/:id/email", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const rows = await queryDB(
        `SELECT p.*, e.name AS employee_name, e.employee_id AS employee_code, e.designation, e.department,
                e.email AS employee_email, e.personal_email AS employee_personal_email
         FROM payrolls p JOIN all_employees e ON e.id = p.employee_id WHERE p.id = ?`,
        [req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Payroll record not found." });
      const record = rows[0];
      const to = record.employee_email || record.employee_personal_email;
      if (!to) return res.status(400).json({ error: `${record.employee_name} has no email on file in the Employee Directory.` });

      const result = await sendMail({ to, subject: `Payslip — ${record.month_year}`, html: buildPayslipEmailHtml(record) });
      if (!result.success) return res.status(400).json({ error: result.error });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to email payslip." });
    }
  });

  app.post("/api/payroll/email-bulk", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const monthYear = String(req.body?.month_year || "");
      if (!MONTH_YEAR_RE.test(monthYear)) return res.status(400).json({ error: "month_year must be in 'YYYY-MM' format." });
      if (!isMailerConfigured()) {
        return res.status(400).json({ error: "Email sending isn't set up on the server yet — set SMTP_HOST/SMTP_USER/SMTP_PASS in .env, then restart the server." });
      }
      const rows = await queryDB(
        `SELECT p.*, e.name AS employee_name, e.employee_id AS employee_code, e.designation, e.department,
                e.email AS employee_email, e.personal_email AS employee_personal_email
         FROM payrolls p JOIN all_employees e ON e.id = p.employee_id WHERE p.month_year = ?`,
        [monthYear]
      );
      const results: any[] = [];
      for (const record of rows) {
        const to = record.employee_email || record.employee_personal_email;
        if (!to) {
          results.push({ employee_id: record.employee_id, employee_name: record.employee_name, success: false, error: "No email on file." });
          continue;
        }
        const result = await sendMail({ to, subject: `Payslip — ${record.month_year}`, html: buildPayslipEmailHtml(record) });
        results.push({ employee_id: record.employee_id, employee_name: record.employee_name, success: result.success, error: result.error });
      }
      res.json({ month_year: monthYear, results });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to email payslips." });
    }
  });

  // ---- Late Attendance Policy helpers ---------------------------------------
  // Resolves whichever late_policy_settings row was actually in effect for a
  // given month (most recent effective_date on or before that month's 1st) —
  // same "look back to what was true then" resolution salary_structures uses,
  // so re-running payroll math for an old month never picks up today's policy.
  async function getLatePolicyForMonth(monthYear: string) {
    const rows = await queryDB(
      `SELECT * FROM late_policy_settings WHERE effective_date <= ? ORDER BY effective_date DESC, id DESC LIMIT 1`,
      [`${monthYear}-01`]
    );
    return (
      rows[0] || {
        shift_start_time: "09:00:00",
        grace_minutes: 10,
        lates_per_deduction_day: 3,
        extreme_grace_minutes: 60,
        extreme_lates_per_deduction_day: 1
      }
    );
  }

  // For every employee with a linked login, finds each calendar day in
  // [monthStart, monthEnd] where their earliest check-in (Remote GPS or
  // Office ZKTeco, whichever is earlier when both exist) is later than
  // shift_start_time + grace_minutes. Returns a Map<employee_id, string[]> of
  // the actual late dates (not just a count) so a waiver UI can show and
  // toggle each one individually. Holidays and any date already in
  // late_waivers for that employee are excluded before the caller ever sees
  // them, so "late_count" downstream is always the number that should count
  // toward the lates-per-deduction-day threshold.
  //
  // Every late check-in lands in exactly one of two mutually exclusive tiers
  // — "Delay" (past shift_start_time + grace_minutes) or the stricter
  // "Extreme Delay" (past shift_start_time + extreme_grace_minutes) — never
  // both, so a single late morning is never double-counted. Returns both
  // maps so the caller can price/report them separately.
  async function computeLateDatesByEmployee(
    employees: any[],
    monthStart: string,
    monthEnd: string,
    holidayMap: Map<string, any>,
    policy: any,
    excludeWaivers: boolean = true
  ): Promise<{ lateDatesByEmployee: Map<number, string[]>; extremeLateDatesByEmployee: Map<number, string[]> }> {
    const userIds = employees.filter((e: any) => e.user_id).map((e: any) => Number(e.user_id));
    const firstCheckInByUserDate = new Map<number, Map<string, Date>>();

    if (userIds.length > 0) {
      const placeholders = userIds.map(() => "?").join(",");
      const remoteRows = await queryDB(
        `SELECT user_id, attendance_date, MIN(check_in_at) AS first_check_in
         FROM attendance
         WHERE attendance_date BETWEEN ? AND ? AND check_in_at IS NOT NULL AND user_id IN (${placeholders})
         GROUP BY user_id, attendance_date`,
        [monthStart, monthEnd, ...userIds]
      );
      for (const r of remoteRows) {
        const dateStr = String(r.attendance_date).slice(0, 10);
        if (holidayMap.has(dateStr)) continue;
        if (!firstCheckInByUserDate.has(r.user_id)) firstCheckInByUserDate.set(r.user_id, new Map());
        firstCheckInByUserDate.get(r.user_id)!.set(dateStr, new Date(r.first_check_in));
      }

      const pinToUserId = new Map<string, number>();
      for (const e of employees) {
        if (e.user_id && e.zk_device_pin) pinToUserId.set(e.zk_device_pin, Number(e.user_id));
      }
      if (pinToUserId.size > 0) {
        const pins = Array.from(pinToUserId.keys());
        const pinPlaceholders = pins.map(() => "?").join(",");
        const officeRows = await queryDB(
          `SELECT device_user_pin, DATE(punch_time) AS attendance_date, MIN(punch_time) AS first_punch
           FROM zk_attendance_logs WHERE DATE(punch_time) BETWEEN ? AND ? AND device_user_pin IN (${pinPlaceholders})
           GROUP BY device_user_pin, DATE(punch_time)`,
          [monthStart, monthEnd, ...pins]
        );
        for (const r of officeRows) {
          const dateStr = String(r.attendance_date).slice(0, 10);
          if (holidayMap.has(dateStr)) continue;
          const userId = pinToUserId.get(r.device_user_pin);
          if (!userId) continue;
          const punchTime = new Date(r.first_punch);
          if (!firstCheckInByUserDate.has(userId)) firstCheckInByUserDate.set(userId, new Map());
          const existing = firstCheckInByUserDate.get(userId)!.get(dateStr);
          // Keep whichever source's check-in was earlier that day.
          if (!existing || punchTime < existing) firstCheckInByUserDate.get(userId)!.set(dateStr, punchTime);
        }
      }
    }

    // Waivers for this window, keyed the same "employeeId_date" way so a
    // lookup is a single Set.has() per day below. The drill-down view passes
    // excludeWaivers=false so it can show already-waived days too (flagged
    // separately) instead of silently dropping them.
    let waivedKeys = new Set<string>();
    if (excludeWaivers) {
      const waiverRows = await queryDB(
        `SELECT employee_id, waiver_date FROM late_waivers WHERE waiver_date BETWEEN ? AND ?`,
        [monthStart, monthEnd]
      );
      waivedKeys = new Set<string>(waiverRows.map((w: any) => `${w.employee_id}_${String(w.waiver_date).slice(0, 10)}`));
    }

    const [startH, startM] = String(policy.shift_start_time).split(":").map(Number);
    const thresholdMinutes = startH * 60 + startM + Number(policy.grace_minutes);
    const extremeThresholdMinutes = startH * 60 + startM + Number(policy.extreme_grace_minutes ?? 60);

    const userIdToEmployeeId = new Map<number, number>();
    for (const e of employees) {
      if (e.user_id) userIdToEmployeeId.set(Number(e.user_id), Number(e.id));
    }

    const lateDatesByEmployee = new Map<number, string[]>();
    const extremeLateDatesByEmployee = new Map<number, string[]>();
    for (const [userId, dateMap] of firstCheckInByUserDate.entries()) {
      const employeeId = userIdToEmployeeId.get(userId);
      if (!employeeId) continue;
      for (const [dateStr, checkInAt] of dateMap.entries()) {
        if (waivedKeys.has(`${employeeId}_${dateStr}`)) continue;
        const minutesOfDay = checkInAt.getHours() * 60 + checkInAt.getMinutes();
        if (minutesOfDay > extremeThresholdMinutes) {
          if (!extremeLateDatesByEmployee.has(employeeId)) extremeLateDatesByEmployee.set(employeeId, []);
          extremeLateDatesByEmployee.get(employeeId)!.push(dateStr);
        } else if (minutesOfDay > thresholdMinutes) {
          if (!lateDatesByEmployee.has(employeeId)) lateDatesByEmployee.set(employeeId, []);
          lateDatesByEmployee.get(employeeId)!.push(dateStr);
        }
      }
    }
    for (const dates of lateDatesByEmployee.values()) dates.sort();
    for (const dates of extremeLateDatesByEmployee.values()) dates.sort();
    return { lateDatesByEmployee, extremeLateDatesByEmployee };
  }

  // GET current policy + full change history (newest first) for the Settings
  // screen — one call gives the form its defaults and the table its rows.
  app.get("/api/payroll/late-policy", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const rows = await queryDB(
        `SELECT lp.*, u.name AS changed_by_name
         FROM late_policy_settings lp LEFT JOIN users u ON u.id = lp.created_by
         ORDER BY lp.effective_date DESC, lp.id DESC`
      );
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to load late policy history." });
    }
  });

  // POST always INSERTs a new row (history preserved) rather than updating
  // the existing one in place — identical reasoning to salary_structures: a
  // month that already had payroll generated under the old policy must stay
  // explainable, and a future-dated effective_date lets Admin schedule a
  // change in advance.
  app.post("/api/payroll/late-policy", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const shiftStart = typeof req.body?.shift_start_time === "string" ? req.body.shift_start_time.trim() : "";
      const graceMinutes = Math.round(num(req.body?.grace_minutes, NaN));
      const latesPerDay = Math.round(num(req.body?.lates_per_deduction_day, NaN));
      const extremeGraceMinutes = Math.round(num(req.body?.extreme_grace_minutes, NaN));
      const extremeLatesPerDay = Math.round(num(req.body?.extreme_lates_per_deduction_day, NaN));
      const effectiveDate = typeof req.body?.effective_date === "string" ? req.body.effective_date.trim() : "";

      if (!/^\d{2}:\d{2}(:\d{2})?$/.test(shiftStart)) {
        return res.status(400).json({ error: "shift_start_time must be in HH:MM format." });
      }
      if (!Number.isFinite(graceMinutes) || graceMinutes < 0) {
        return res.status(400).json({ error: "grace_minutes must be a non-negative number." });
      }
      if (!Number.isFinite(latesPerDay) || latesPerDay < 1) {
        return res.status(400).json({ error: "lates_per_deduction_day must be at least 1." });
      }
      if (!Number.isFinite(extremeGraceMinutes) || extremeGraceMinutes < 0) {
        return res.status(400).json({ error: "extreme_grace_minutes must be a non-negative number." });
      }
      if (extremeGraceMinutes <= graceMinutes) {
        return res.status(400).json({ error: "Extreme Delay's grace period must be greater than Delay's grace period." });
      }
      if (!Number.isFinite(extremeLatesPerDay) || extremeLatesPerDay < 1) {
        return res.status(400).json({ error: "extreme_lates_per_deduction_day must be at least 1." });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
        return res.status(400).json({ error: "effective_date must be in YYYY-MM-DD format." });
      }

      const normalizedTime = shiftStart.length === 5 ? `${shiftStart}:00` : shiftStart;
      const result = await queryDB(
        `INSERT INTO late_policy_settings
           (shift_start_time, grace_minutes, lates_per_deduction_day, extreme_grace_minutes, extreme_lates_per_deduction_day, effective_date, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [normalizedTime, graceMinutes, latesPerDay, extremeGraceMinutes, extremeLatesPerDay, effectiveDate, req.user.id]
      );
      res.json({ success: true, id: result.insertId });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to save late policy." });
    }
  });

  // Per-employee, per-day drill-down for one month — backs the "View Late
  // Days" modal, showing every late date plus whether it's currently waived,
  // so HR can toggle a specific day on/off without affecting any other day.
  app.get("/api/payroll/late-summary/:employeeId", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const employeeId = Number(req.params.employeeId);
      const requested = req.query.month_year ? String(req.query.month_year) : "";
      const monthYear = MONTH_YEAR_RE.test(requested) ? requested : new Date().toISOString().slice(0, 7);
      const [yy, mm] = monthYear.split("-").map(Number);
      const daysInMonth = new Date(yy, mm, 0).getDate();
      const monthStart = `${monthYear}-01`;
      const monthEnd = `${monthYear}-${String(daysInMonth).padStart(2, "0")}`;

      const empRows = await queryDB(
        "SELECT id, name, employee_id AS employee_code, user_id, zk_device_pin FROM all_employees WHERE id = ?",
        [employeeId]
      );
      if (empRows.length === 0) return res.status(404).json({ error: "Employee not found." });

      const holidayMap = await getHolidayMap(queryDB, monthStart, monthEnd);
      const policy = await getLatePolicyForMonth(monthYear);

      // Reuse the same computation but unwaived (pass no waivers) so this
      // view can show every raw late day, including already-waived ones,
      // then mark which are currently waived separately.
      const allWaivers = await queryDB(
        "SELECT id, waiver_date, reason FROM late_waivers WHERE employee_id = ? AND waiver_date BETWEEN ? AND ?",
        [employeeId, monthStart, monthEnd]
      );
      const waiverByDate = new Map<string, any>(allWaivers.map((w: any) => [String(w.waiver_date).slice(0, 10), w]));

      const { lateDatesByEmployee, extremeLateDatesByEmployee } = await computeLateDatesByEmployee(
        [empRows[0]], monthStart, monthEnd, holidayMap, policy, false
      );
      const rawLateDates: string[] = lateDatesByEmployee.get(employeeId) || [];
      const rawExtremeLateDates: string[] = extremeLateDatesByEmployee.get(employeeId) || [];

      const days = rawLateDates.map((d) => ({
        date: d,
        extreme: false,
        waived: waiverByDate.has(d),
        waiver_id: waiverByDate.get(d)?.id || null,
        reason: waiverByDate.get(d)?.reason || null
      }));
      const extremeDays = rawExtremeLateDates.map((d) => ({
        date: d,
        extreme: true,
        waived: waiverByDate.has(d),
        waiver_id: waiverByDate.get(d)?.id || null,
        reason: waiverByDate.get(d)?.reason || null
      }));
      const countedLate = days.filter((d) => !d.waived).length;
      const countedExtremeLate = extremeDays.filter((d) => !d.waived).length;

      res.json({
        employee_id: employeeId,
        month_year: monthYear,
        policy: {
          shift_start_time: policy.shift_start_time,
          grace_minutes: policy.grace_minutes,
          lates_per_deduction_day: policy.lates_per_deduction_day,
          extreme_grace_minutes: policy.extreme_grace_minutes,
          extreme_lates_per_deduction_day: policy.extreme_lates_per_deduction_day
        },
        days: [...days, ...extremeDays].sort((a, b) => a.date.localeCompare(b.date)),
        late_count: countedLate,
        deduction_days: Math.floor(countedLate / Number(policy.lates_per_deduction_day || 1)),
        extreme_late_count: countedExtremeLate,
        extreme_deduction_days: Math.floor(countedExtremeLate / Number(policy.extreme_lates_per_deduction_day || 1))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to load late-day details." });
    }
  });

  // Self-service counterpart to the two Admin-only endpoints above: the
  // CALLER'S OWN attendance standing for a month, so an employee can see the
  // Delay/Extreme Delay count that's going to cost them salary while there's
  // still time to do something about it, instead of meeting it for the first
  // time as a deduction line on their payslip.
  //
  // Deliberately NOT requireAdmin/requireModule("payroll"): it resolves the
  // employee from the authenticated user (all_employees.user_id = req.user.id)
  // and never accepts an employee id from the request, so it can only ever
  // report on the caller themselves.
  //
  // Every figure is computed with the same helpers, policy and waivers the
  // payroll wizard uses (getHolidayMap / getLatePolicyForMonth /
  // computeLateDatesByEmployee), because a number here that disagreed with the
  // eventual deduction would be worse than showing nothing at all.
  app.get("/api/my-attendance-summary", authenticateToken, async (req: any, res) => {
    try {
      const requested = req.query.month_year ? String(req.query.month_year) : "";
      const monthYear = MONTH_YEAR_RE.test(requested) ? requested : new Date().toISOString().slice(0, 7);
      const [yy, mm] = monthYear.split("-").map(Number);
      const daysInMonth = new Date(yy, mm, 0).getDate();
      const monthStart = `${monthYear}-01`;
      const monthEnd = `${monthYear}-${String(daysInMonth).padStart(2, "0")}`;

      const empRows = await queryDB(
        "SELECT id, user_id, zk_device_pin FROM all_employees WHERE user_id = ? LIMIT 1",
        [req.user.id]
      );
      // No Employee record is linked to this login, so there's no payroll
      // identity to report on — say so plainly rather than 404, and let the
      // caller render nothing.
      if (empRows.length === 0) return res.json({ linked: false, month_year: monthYear });
      const employee = empRows[0];

      const holidayMap = await getHolidayMap(queryDB, monthStart, monthEnd);
      const workingDays = Math.max(1, daysInMonth - holidayMap.size);

      // Present days — the same two sources the payroll wizard reads: Remote
      // Attendance check-ins, plus Office (ZKTeco) punches for any day with no
      // remote row. Held in a Set so a day recorded in both counts once.
      const presentDays = new Set<string>();
      const remoteRows = await queryDB(
        `SELECT attendance_date FROM attendance
         WHERE user_id = ? AND attendance_date BETWEEN ? AND ? AND check_in_at IS NOT NULL`,
        [employee.user_id, monthStart, monthEnd]
      );
      for (const r of remoteRows) {
        const dateStr = String(r.attendance_date).slice(0, 10);
        if (!holidayMap.has(dateStr)) presentDays.add(dateStr);
      }
      if (employee.zk_device_pin) {
        const officeRows = await queryDB(
          `SELECT DATE(punch_time) AS attendance_date FROM zk_attendance_logs
           WHERE device_user_pin = ? AND DATE(punch_time) BETWEEN ? AND ?
           GROUP BY DATE(punch_time)`,
          [employee.zk_device_pin, monthStart, monthEnd]
        );
        for (const r of officeRows) {
          const dateStr = String(r.attendance_date).slice(0, 10);
          if (!holidayMap.has(dateStr)) presentDays.add(dateStr);
        }
      }

      // Approved Leave overlapping this month, clipped to the part that
      // actually falls inside it (a range can straddle two months).
      let leaveDays = 0;
      const leaveRows = await queryDB(
        `SELECT start_date, end_date FROM leave_applications
         WHERE user_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?`,
        [employee.user_id, monthEnd, monthStart]
      );
      for (const l of leaveRows) {
        const rawStart = String(l.start_date).slice(0, 10);
        const rawEnd = String(l.end_date).slice(0, 10);
        const start = rawStart < monthStart ? monthStart : rawStart;
        const end = rawEnd > monthEnd ? monthEnd : rawEnd;
        leaveDays += Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000) + 1);
      }
      leaveDays = Math.min(workingDays, leaveDays);

      const policy = await getLatePolicyForMonth(monthYear);
      const { lateDatesByEmployee, extremeLateDatesByEmployee } = await computeLateDatesByEmployee(
        [employee], monthStart, monthEnd, holidayMap, policy
      );
      // Keyed by Number(e.id) inside computeLateDatesByEmployee, so look it up
      // the same way rather than with whatever type the driver handed back.
      const lateCount = lateDatesByEmployee.get(Number(employee.id))?.length || 0;
      const extremeLateCount = extremeLateDatesByEmployee.get(Number(employee.id))?.length || 0;
      const latesPerDay = Number(policy.lates_per_deduction_day || 1);
      const extremeLatesPerDay = Number(policy.extreme_lates_per_deduction_day || 1);

      // Working days elapsed so far. For the month in progress, counting the
      // whole month would report every day still to come as a day not yet
      // attended, which reads as alarming and isn't true yet; a past month
      // just uses the full figure. Local Y/M/D rather than toISOString(),
      // which is UTC and rolls back a day for timezones ahead of it (see the
      // same note on toDateOnly in server.ts).
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      let workingDaysSoFar = workingDays;
      if (today >= monthStart && today <= monthEnd) {
        let elapsed = 0;
        for (let d = 1; d <= daysInMonth; d++) {
          const dateStr = `${monthYear}-${String(d).padStart(2, "0")}`;
          if (dateStr > today) break;
          if (!holidayMap.has(dateStr)) elapsed++;
        }
        workingDaysSoFar = Math.max(1, elapsed);
      }

      res.json({
        linked: true,
        month_year: monthYear,
        working_days: workingDays,
        working_days_so_far: workingDaysSoFar,
        present_days: presentDays.size,
        leave_days: leaveDays,
        late_count: lateCount,
        late_deduction_days: Math.floor(lateCount / latesPerDay),
        extreme_late_count: extremeLateCount,
        extreme_late_deduction_days: Math.floor(extremeLateCount / extremeLatesPerDay),
        policy: {
          shift_start_time: policy.shift_start_time,
          grace_minutes: policy.grace_minutes,
          lates_per_deduction_day: latesPerDay,
          extreme_grace_minutes: policy.extreme_grace_minutes,
          extreme_lates_per_deduction_day: extremeLatesPerDay
        }
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to load your attendance summary." });
    }
  });

  // Excuse (or re-include) one specific late day for one employee. Unique
  // key on (employee_id, waiver_date) means calling this twice for the same
  // day just no-ops the second time rather than erroring.
  app.post("/api/payroll/late-waivers", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const employeeId = Number(req.body?.employee_id);
      const waiverDate = typeof req.body?.waiver_date === "string" ? req.body.waiver_date.trim() : "";
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 255) : null;
      if (!employeeId) return res.status(400).json({ error: "employee_id is required." });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(waiverDate)) return res.status(400).json({ error: "waiver_date must be in YYYY-MM-DD format." });

      const result = await queryDB(
        `INSERT IGNORE INTO late_waivers (employee_id, waiver_date, reason, waived_by) VALUES (?, ?, ?, ?)`,
        [employeeId, waiverDate, reason, req.user.id]
      );
      res.json({ success: true, id: result.insertId || null });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to waive late day." });
    }
  });

  // Undo a waiver — the day counts toward lateness again from here on.
  app.delete("/api/payroll/late-waivers/:id", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      await queryDB("DELETE FROM late_waivers WHERE id = ?", [Number(req.params.id)]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to remove waiver." });
    }
  });

  // ---- Payroll Processing Wizard -------------------------------------------
  // Backs the 5-step "Run Payroll" wizard (Select Month -> Attendance & Leave
  // Sync -> Adjustments -> Preview & Calculate -> Submit). Attendance/Leave
  // Sync and Preview are read-only best-effort helpers; the actual write
  // still goes through the same rules as a single POST /generate (one row
  // per employee/month, salary structure required) — generate-bulk below
  // just loops that per employee instead of the wizard calling /generate
  // once per row itself.

  // Step 2 data source: for each active employee, a best-effort
  // present/absent/leave count for the month, auto-filled from whatever
  // attendance the app already has — Remote (GPS) attendance and Office
  // (ZKTeco) punches for employees with a linked login (`user_id`), Approved
  // Leave Applications for leave days. An employee with neither a login nor
  // a ZK device PIN has no attendance source at all (most of the roster,
  // per all_employees) — for those, `has_attendance_data: false` and the
  // wizard defaults them to fully present so the Admin can hand-correct
  // instead of the page silently guessing.
  app.get("/api/payroll/wizard/attendance-summary", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const requested = req.query.month_year ? String(req.query.month_year) : "";
      const monthYear = MONTH_YEAR_RE.test(requested) ? requested : new Date().toISOString().slice(0, 7);
      const [yy, mm] = monthYear.split("-").map(Number);
      const daysInMonth = new Date(yy, mm, 0).getDate();
      const monthStart = `${monthYear}-01`;
      const monthEnd = `${monthYear}-${String(daysInMonth).padStart(2, "0")}`;

      const holidayMap = await getHolidayMap(queryDB, monthStart, monthEnd);
      const workingDays = Math.max(1, daysInMonth - holidayMap.size);

      const employees = await queryDB(
        `SELECT id, employee_id AS employee_code, name, department, designation, user_id, zk_device_pin
         FROM all_employees WHERE is_active = 1 ORDER BY name ASC`
      );

      const existingRows = await queryDB("SELECT employee_id FROM payrolls WHERE month_year = ?", [monthYear]);
      const alreadyGenerated = new Set<number>(existingRows.map((r: any) => Number(r.employee_id)));

      const structureRows = await queryDB(
        `SELECT ss.employee_id FROM (
           SELECT s.employee_id, ROW_NUMBER() OVER (PARTITION BY s.employee_id ORDER BY s.effective_date DESC, s.id DESC) AS rn
           FROM salary_structures s WHERE s.effective_date <= ?
         ) ss WHERE ss.rn = 1`,
        [monthEnd]
      );
      const hasStructure = new Set<number>(structureRows.map((r: any) => Number(r.employee_id)));

      const userIds = employees.filter((e: any) => e.user_id).map((e: any) => Number(e.user_id));
      const presentDaysByUser = new Map<number, Set<string>>();
      if (userIds.length > 0) {
        // queryDB uses dbPool.execute() (prepared statements), which does NOT
        // expand an array into an IN (?) list the way dbPool.query() would
        // (see LeaveRoutes.ts's own note on this) — a single '?' bound to an
        // array here silently matched zero rows instead of erroring, which is
        // why Present/Leave read as 0 for every employee even with real
        // attendance on file. Building the placeholder list ourselves and
        // spreading userIds as individual params is the fix.
        const placeholders = userIds.map(() => "?").join(",");
        const remoteRows = await queryDB(
          `SELECT user_id, attendance_date FROM attendance
           WHERE attendance_date BETWEEN ? AND ? AND check_in_at IS NOT NULL AND user_id IN (${placeholders})`,
          [monthStart, monthEnd, ...userIds]
        );
        for (const r of remoteRows) {
          const dateStr = String(r.attendance_date).slice(0, 10);
          if (holidayMap.has(dateStr)) continue;
          if (!presentDaysByUser.has(r.user_id)) presentDaysByUser.set(r.user_id, new Set());
          presentDaysByUser.get(r.user_id)!.add(dateStr);
        }
      }

      // Office (ZKTeco) fallback, same pin-based join AttendanceRoutes.ts's
      // monthly report uses — fills in a day that has no Remote row at all.
      const pinToUserId = new Map<string, number>();
      for (const e of employees) {
        if (e.user_id && e.zk_device_pin) pinToUserId.set(e.zk_device_pin, Number(e.user_id));
      }
      if (pinToUserId.size > 0) {
        const pins = Array.from(pinToUserId.keys());
        const pinPlaceholders = pins.map(() => "?").join(",");
        const officeRows = await queryDB(
          `SELECT device_user_pin, DATE(punch_time) AS attendance_date
           FROM zk_attendance_logs WHERE DATE(punch_time) BETWEEN ? AND ? AND device_user_pin IN (${pinPlaceholders})
           GROUP BY device_user_pin, DATE(punch_time)`,
          [monthStart, monthEnd, ...pins]
        );
        for (const r of officeRows) {
          const dateStr = String(r.attendance_date).slice(0, 10);
          if (holidayMap.has(dateStr)) continue;
          const userId = pinToUserId.get(r.device_user_pin);
          if (!userId) continue;
          if (!presentDaysByUser.has(userId)) presentDaysByUser.set(userId, new Set());
          presentDaysByUser.get(userId)!.add(dateStr);
        }
      }

      // Approved Leave Applications overlapping this month — clipped to the
      // days that actually fall inside the month, since a leave range can
      // straddle two months but only the overlapping part counts here.
      const leaveDaysByUser = new Map<number, number>();
      if (userIds.length > 0) {
        const leavePlaceholders = userIds.map(() => "?").join(",");
        const leaveRows = await queryDB(
          `SELECT user_id, start_date, end_date FROM leave_applications
           WHERE status = 'approved' AND start_date <= ? AND end_date >= ? AND user_id IN (${leavePlaceholders})`,
          [monthEnd, monthStart, ...userIds]
        );
        for (const l of leaveRows) {
          const start = String(l.start_date).slice(0, 10) < monthStart ? monthStart : String(l.start_date).slice(0, 10);
          const end = String(l.end_date).slice(0, 10) > monthEnd ? monthEnd : String(l.end_date).slice(0, 10);
          const days = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000) + 1);
          leaveDaysByUser.set(l.user_id, (leaveDaysByUser.get(l.user_id) || 0) + days);
        }
      }

      // Any bonus staged via Bonus & Incentive -> "Stage" for an employee
      // who had no run yet for this month (POST /api/payroll/pending-bonuses)
      // — summed per employee so the wizard's Step 3 Bonus field starts
      // pre-filled instead of 0, and generate/generate-bulk below consume
      // (delete) these rows once the run is actually created.
      const pendingBonusRows = await queryDB(
        "SELECT employee_id, SUM(amount) AS total FROM pending_bonuses WHERE month_year = ? GROUP BY employee_id",
        [monthYear]
      );
      const pendingBonusByEmployee = new Map<number, number>(
        pendingBonusRows.map((r: any) => [Number(r.employee_id), Number(r.total) || 0])
      );

      // Late Attendance Policy — whichever policy was in effect for this
      // month, applied against each employee's actual check-in times. Lates
      // already had any waived day dropped inside computeLateDatesByEmployee.
      const latePolicy = await getLatePolicyForMonth(monthYear);
      const { lateDatesByEmployee, extremeLateDatesByEmployee } = await computeLateDatesByEmployee(
        employees, monthStart, monthEnd, holidayMap, latePolicy
      );
      const latesPerDay = Number(latePolicy.lates_per_deduction_day || 1);
      const extremeLatesPerDay = Number(latePolicy.extreme_lates_per_deduction_day || 1);

      const result = employees.map((e: any) => {
        // has_attendance_data must mean "we actually found at least one
        // present day for this person", not just "their pin is registered
        // somewhere in the system" — pinToUserId.has(own pin) was always
        // true for anyone with a pin configured, even with zero punches on
        // file, which is what made the "Synced" badge show up falsely.
        const hasAttendanceData = !!(e.user_id && presentDaysByUser.has(Number(e.user_id)));
        const present = hasAttendanceData ? (presentDaysByUser.get(Number(e.user_id))?.size || 0) : workingDays;
        const leave = e.user_id ? Math.min(workingDays, leaveDaysByUser.get(Number(e.user_id)) || 0) : 0;
        const absent = Math.max(0, workingDays - present - leave);
        const lateCount = lateDatesByEmployee.get(e.id)?.length || 0;
        const lateDeductionDays = Math.floor(lateCount / latesPerDay);
        const extremeLateCount = extremeLateDatesByEmployee.get(e.id)?.length || 0;
        const extremeLateDeductionDays = Math.floor(extremeLateCount / extremeLatesPerDay);
        return {
          employee_id: e.id,
          employee_code: e.employee_code,
          employee_name: e.name,
          department: e.department,
          designation: e.designation,
          total_working_days: workingDays,
          present_days: hasAttendanceData ? present : workingDays,
          absent_days: hasAttendanceData ? absent : 0,
          leave_days: leave,
          lwp_days: 0,
          overtime_hours: 0,
          late_count: lateCount,
          late_deduction_days: lateDeductionDays,
          extreme_late_count: extremeLateCount,
          extreme_late_deduction_days: extremeLateDeductionDays,
          pending_bonus_amount: pendingBonusByEmployee.get(e.id) || 0,
          has_attendance_data: hasAttendanceData,
          has_salary_structure: hasStructure.has(e.id),
          already_generated: alreadyGenerated.has(e.id)
        };
      });

      res.json({
        month_year: monthYear,
        days_in_month: daysInMonth,
        working_days: workingDays,
        late_policy: {
          shift_start_time: latePolicy.shift_start_time,
          grace_minutes: latePolicy.grace_minutes,
          lates_per_deduction_day: latePolicy.lates_per_deduction_day,
          extreme_grace_minutes: latePolicy.extreme_grace_minutes,
          extreme_lates_per_deduction_day: latePolicy.extreme_lates_per_deduction_day
        },
        employees: result
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to load attendance summary." });
    }
  });

  // Step 4 data source: runs the exact same payroll math as POST /generate
  // for each row the wizard is about to submit, but never writes anything —
  // lets the Admin see the final Basic/Allowances/Deductions/Net Salary
  // breakdown (and catch a missing Salary Structure or a duplicate run)
  // before committing in Step 5.
  app.post("/api/payroll/generate-preview", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const monthYear = String(req.body?.month_year || "");
      if (!MONTH_YEAR_RE.test(monthYear)) return res.status(400).json({ error: "month_year must be in 'YYYY-MM' format." });
      const rows: any[] = Array.isArray(req.body?.employees) ? req.body.employees : [];

      const existingRows = await queryDB("SELECT employee_id FROM payrolls WHERE month_year = ?", [monthYear]);
      const alreadyGenerated = new Set<number>(existingRows.map((r: any) => Number(r.employee_id)));

      const results = [];
      for (const row of rows) {
        const employeeId = Number(row?.employee_id);
        if (!employeeId) {
          results.push({ employee_id: row?.employee_id, error: "Missing employee_id." });
          continue;
        }
        if (alreadyGenerated.has(employeeId)) {
          results.push({ employee_id: employeeId, already_generated: true, error: `Payroll for ${monthYear} already exists for this employee.` });
          continue;
        }
        const structureRows = await queryDB(
          `SELECT * FROM salary_structures WHERE employee_id = ? AND effective_date <= LAST_DAY(?) ORDER BY effective_date DESC, id DESC LIMIT 1`,
          [employeeId, `${monthYear}-01`]
        );
        if (structureRows.length === 0) {
          results.push({ employee_id: employeeId, error: "No Salary Structure set up for this employee yet." });
          continue;
        }
        const structure = structureRows[0];

        const workingDays = Math.max(1, Math.round(num(row.total_working_days)));
        const present = Math.max(0, Math.round(num(row.present_days)));
        const absent = Math.max(0, Math.round(num(row.absent_days)));
        const lwp = Math.max(0, Math.round(num(row.lwp_days)));
        const lateCount = Math.max(0, Math.round(num(row.late_count)));
        const lateDeductionDays = Math.max(0, Math.round(num(row.late_deduction_days)));
        const otAmount = money(num(row.overtime_amount));
        const bonus = money(num(row.bonus_amount));
        const otherDed = money(num(row.other_deduction));

        const grossSalary = Number(structure.gross_salary);
        const basicSalary = Number(structure.basic_salary);
        const allowancesTotal = money(grossSalary - basicSalary);
        const perDayGross = grossSalary / workingDays;
        // Late Attendance Policy folds in here as extra unpaid-equivalent
        // days, same rate as an absence — "3 lates = 1 day" means the 4th
        // "day" charged is priced exactly like an Absent/LWP day, not a
        // separate line item.
        const unpaidDays = absent + lwp + lateDeductionDays;
        const lateDeductionAmount = money(perDayGross * lateDeductionDays);
        const basicAmount = money(basicSalary * (present / workingDays));
        const allowancesEarned = money(allowancesTotal * (present / workingDays));
        const absentDeduction = money(perDayGross * unpaidDays);
        const grossEarned = money(basicAmount + allowancesEarned + otAmount + bonus);
        const taxDeduction = money(Number(structure.tax_deduction) || 0);
        const pfDeduction = money(Number(structure.pf_deduction) || 0);

        const advances = await queryDB(
          "SELECT * FROM employee_advances WHERE employee_id = ? AND status = 'active' ORDER BY created_at ASC",
          [employeeId]
        );
        let advanceDeduction = 0;
        for (const adv of advances) {
          const remaining = Number(adv.total_amount) - Number(adv.paid_amount);
          if (remaining <= 0) continue;
          advanceDeduction += Math.min(Number(adv.monthly_installment), remaining);
        }
        advanceDeduction = money(advanceDeduction);

        const totalDeduction = money(absentDeduction + taxDeduction + pfDeduction + advanceDeduction + otherDed);
        const netSalary = money(grossEarned - taxDeduction - pfDeduction - advanceDeduction - otherDed);

        results.push({
          employee_id: employeeId,
          basic_amount: basicAmount,
          allowances_earned: allowancesEarned,
          overtime_amount: otAmount,
          bonus_amount: bonus,
          gross_earned: grossEarned,
          absent_deduction: absentDeduction,
          late_count: lateCount,
          late_deduction_days: lateDeductionDays,
          late_deduction_amount: lateDeductionAmount,
          tax_deduction: taxDeduction,
          pf_deduction: pfDeduction,
          advance_deduction: advanceDeduction,
          other_deduction: otherDed,
          total_deduction: totalDeduction,
          net_salary: netSalary
        });
      }

      res.json({ month_year: monthYear, results });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to calculate payroll preview." });
    }
  });

  // Step 5: commits Step 3/4's rows the same way POST /generate does, one
  // INSERT per employee — just looped server-side so the wizard's "Submit"
  // is a single request. Any row that fails (duplicate, missing structure,
  // employee not found) is reported per-employee in `results` rather than
  // aborting the whole batch, so a batch of 50 with one bad row still
  // processes the other 49.
  app.post("/api/payroll/generate-bulk", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const monthYear = String(req.body?.month_year || "");
      if (!MONTH_YEAR_RE.test(monthYear)) return res.status(400).json({ error: "month_year must be in 'YYYY-MM' format." });
      const rows: any[] = Array.isArray(req.body?.employees) ? req.body.employees : [];
      const method = typeof req.body?.payment_method === "string" && req.body.payment_method.trim() ? req.body.payment_method.trim().slice(0, 50) : "Bank Transfer";

      const results = [];
      for (const row of rows) {
        const employeeId = Number(row?.employee_id);
        if (!employeeId) {
          results.push({ employee_id: row?.employee_id, success: false, error: "Missing employee_id." });
          continue;
        }
        try {
          const empRows = await queryDB("SELECT id FROM all_employees WHERE id = ?", [employeeId]);
          if (empRows.length === 0) {
            results.push({ employee_id: employeeId, success: false, error: "Employee not found." });
            continue;
          }
          const existing = await queryDB("SELECT id FROM payrolls WHERE employee_id = ? AND month_year = ?", [employeeId, monthYear]);
          if (existing.length > 0) {
            results.push({ employee_id: employeeId, success: false, error: `Payroll for ${monthYear} already exists for this employee.` });
            continue;
          }
          const structureRows = await queryDB(
            `SELECT * FROM salary_structures WHERE employee_id = ? AND effective_date <= LAST_DAY(?) ORDER BY effective_date DESC, id DESC LIMIT 1`,
            [employeeId, `${monthYear}-01`]
          );
          if (structureRows.length === 0) {
            results.push({ employee_id: employeeId, success: false, error: "No Salary Structure set up for this employee yet." });
            continue;
          }
          const structure = structureRows[0];

          const workingDays = Math.max(1, Math.round(num(row.total_working_days)));
          const present = Math.max(0, Math.round(num(row.present_days)));
          const absent = Math.max(0, Math.round(num(row.absent_days)));
          const leave = Math.max(0, Math.round(num(row.leave_days)));
          const lwp = Math.max(0, Math.round(num(row.lwp_days)));
          const lateCount = Math.max(0, Math.round(num(row.late_count)));
          const lateDeductionDays = Math.max(0, Math.round(num(row.late_deduction_days)));
          const otHours = num(row.overtime_hours);
          const otAmount = money(num(row.overtime_amount));
          const bonus = money(num(row.bonus_amount));
          const otherDed = money(num(row.other_deduction));
          const note = typeof row.remarks === "string" ? row.remarks.trim().slice(0, 1000) : null;

          const grossSalary = Number(structure.gross_salary);
          const basicSalary = Number(structure.basic_salary);
          const allowancesTotal = money(grossSalary - basicSalary);
          const perDayGross = grossSalary / workingDays;
          const unpaidDays = absent + lwp + lateDeductionDays;
          const lateDeductionAmount = money(perDayGross * lateDeductionDays);
          const basicAmount = money(basicSalary * (present / workingDays));
          const allowancesEarned = money(allowancesTotal * (present / workingDays));
          const absentDeduction = money(perDayGross * unpaidDays);
          const grossEarned = money(basicAmount + allowancesEarned + otAmount + bonus);
          const taxDeduction = money(Number(structure.tax_deduction) || 0);
          const pfDeduction = money(Number(structure.pf_deduction) || 0);

          const advances = await queryDB(
            "SELECT * FROM employee_advances WHERE employee_id = ? AND status = 'active' ORDER BY created_at ASC",
            [employeeId]
          );
          let advanceDeduction = 0;
          for (const adv of advances) {
            const remaining = Number(adv.total_amount) - Number(adv.paid_amount);
            if (remaining <= 0) continue;
            advanceDeduction += Math.min(Number(adv.monthly_installment), remaining);
          }
          advanceDeduction = money(advanceDeduction);

          const totalDeduction = money(absentDeduction + taxDeduction + pfDeduction + advanceDeduction + otherDed);
          const netSalary = money(grossEarned - taxDeduction - pfDeduction - advanceDeduction - otherDed);

          const result = await queryDB(
            `INSERT INTO payrolls
               (employee_id, month_year, total_working_days, present_days, absent_days, leave_days, lwp_days, overtime_hours,
                basic_amount, allowances_total, overtime_amount, bonus_amount, gross_earned,
                absent_deduction, late_count, late_deduction_days, late_deduction_amount,
                tax_deduction, pf_deduction, advance_deduction, other_deduction, total_deduction,
                net_salary, payment_status, payment_method, remarks, generated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?, ?, ?)`,
            [
              employeeId, monthYear, workingDays, present, absent, leave, lwp, otHours,
              basicAmount, allowancesEarned, otAmount, bonus, grossEarned,
              absentDeduction, lateCount, lateDeductionDays, lateDeductionAmount,
              taxDeduction, pfDeduction, advanceDeduction, otherDed, totalDeduction,
              netSalary, method, note, req.user.id
            ]
          );
          // Consume any staged bonus for this employee/month now that a
          // real run exists — prevents it from being offered/applied again.
          await queryDB("DELETE FROM pending_bonuses WHERE employee_id = ? AND month_year = ?", [employeeId, monthYear]);
          results.push({ employee_id: employeeId, success: true, id: result.insertId, net_salary: netSalary });
        } catch (rowErr: any) {
          results.push({ employee_id: employeeId, success: false, error: rowErr?.code === "ER_DUP_ENTRY" ? "Payroll for this employee/month has already been generated." : (rowErr?.message || "Failed to generate payroll.") });
        }
      }

      res.json({ month_year: monthYear, results });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to process payroll batch." });
    }
  });

  // Generate one employee's payroll for one month. Pulls the salary
  // structure in effect as of the LAST day of month_year (so a mid-month
  // raise applies from the month it took effect, not retroactively to
  // structures set up after the fact) and any active advance(s) for the
  // employee, then computes every earnings/deduction column server-side —
  // the request body only supplies attendance counts and the few figures
  // that genuinely vary run-to-run (overtime, bonus, ad-hoc deduction).
  app.post("/api/payroll/generate", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const {
        employee_id,
        month_year,
        total_working_days,
        present_days,
        absent_days,
        leave_days,
        lwp_days,
        late_count,
        late_deduction_days,
        overtime_hours,
        overtime_amount,
        bonus_amount,
        other_deduction,
        payment_method,
        remarks
      } = req.body || {};

      if (!employee_id) return res.status(400).json({ error: "employee_id is required." });
      if (!month_year || !MONTH_YEAR_RE.test(String(month_year))) {
        return res.status(400).json({ error: "month_year must be in 'YYYY-MM' format." });
      }
      const empRows = await queryDB("SELECT id, name FROM all_employees WHERE id = ?", [Number(employee_id)]);
      if (empRows.length === 0) return res.status(404).json({ error: "Employee not found." });

      const existing = await queryDB("SELECT id FROM payrolls WHERE employee_id = ? AND month_year = ?", [Number(employee_id), String(month_year)]);
      if (existing.length > 0) {
        return res.status(400).json({ error: `Payroll for ${month_year} has already been generated for this employee.` });
      }

      const structureRows = await queryDB(
        `SELECT * FROM salary_structures
         WHERE employee_id = ? AND effective_date <= LAST_DAY(?)
         ORDER BY effective_date DESC, id DESC LIMIT 1`,
        [Number(employee_id), `${month_year}-01`]
      );
      if (structureRows.length === 0) {
        return res.status(400).json({ error: "This employee has no Salary Structure set up yet — add one before generating Payroll." });
      }
      const structure = structureRows[0];

      const workingDays = Math.max(1, Math.round(num(total_working_days)));
      const present = Math.max(0, Math.round(num(present_days)));
      const absent = Math.max(0, Math.round(num(absent_days)));
      const leave = Math.max(0, Math.round(num(leave_days)));
      const lwp = Math.max(0, Math.round(num(lwp_days)));
      const lateCount = Math.max(0, Math.round(num(late_count)));
      const lateDeductionDays = Math.max(0, Math.round(num(late_deduction_days)));
      const otHours = num(overtime_hours);
      const otAmount = money(num(overtime_amount));
      const bonus = money(num(bonus_amount));
      const otherDed = money(num(other_deduction));
      const method = typeof payment_method === "string" && payment_method.trim() ? payment_method.trim().slice(0, 50) : "Bank Transfer";
      const note = typeof remarks === "string" ? remarks.trim().slice(0, 1000) : null;

      const grossSalary = Number(structure.gross_salary);
      const basicSalary = Number(structure.basic_salary);
      const allowancesTotal = money(grossSalary - basicSalary);
      const perDayGross = grossSalary / workingDays;

      // Basic + Allowances scale with days actually present; Absent/LWP/Late-
      // deduction days are the ones that cost the employee pay (Leave days
      // are paid, hence excluded here).
      const unpaidDays = absent + lwp + lateDeductionDays;
      const lateDeductionAmount = money(perDayGross * lateDeductionDays);
      const basicAmount = money(basicSalary * (present / workingDays));
      const allowancesEarned = money(allowancesTotal * (present / workingDays));
      const absentDeduction = money(perDayGross * unpaidDays);
      const grossEarned = money(basicAmount + allowancesEarned + otAmount + bonus);

      const taxDeduction = money(Number(structure.tax_deduction) || 0);
      const pfDeduction = money(Number(structure.pf_deduction) || 0);

      // Active advances for this employee — deduct up to whatever's left on
      // each one, never more than the outstanding balance, and never more
      // than net pay can absorb across all of them combined.
      const advances = await queryDB(
        "SELECT * FROM employee_advances WHERE employee_id = ? AND status = 'active' ORDER BY created_at ASC",
        [Number(employee_id)]
      );
      let advanceDeduction = 0;
      for (const adv of advances) {
        const remaining = Number(adv.total_amount) - Number(adv.paid_amount);
        if (remaining <= 0) continue;
        advanceDeduction += Math.min(Number(adv.monthly_installment), remaining);
      }
      advanceDeduction = money(advanceDeduction);

      const totalDeduction = money(absentDeduction + taxDeduction + pfDeduction + advanceDeduction + otherDed);
      const netSalary = money(grossEarned - taxDeduction - pfDeduction - advanceDeduction - otherDed);

      const result = await queryDB(
        `INSERT INTO payrolls
           (employee_id, month_year, total_working_days, present_days, absent_days, leave_days, lwp_days, overtime_hours,
            basic_amount, allowances_total, overtime_amount, bonus_amount, gross_earned,
            absent_deduction, late_count, late_deduction_days, late_deduction_amount,
            tax_deduction, pf_deduction, advance_deduction, other_deduction, total_deduction,
            net_salary, payment_status, payment_method, remarks, generated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?, ?, ?)`,
        [
          Number(employee_id), month_year, workingDays, present, absent, leave, lwp, otHours,
          basicAmount, allowancesEarned, otAmount, bonus, grossEarned,
          absentDeduction, lateCount, lateDeductionDays, lateDeductionAmount,
          taxDeduction, pfDeduction, advanceDeduction, otherDed, totalDeduction,
          netSalary, method, note, req.user.id
        ]
      );
      // Consume any staged bonus for this employee/month now that a real
      // run exists — prevents it from being offered/applied again.
      await queryDB("DELETE FROM pending_bonuses WHERE employee_id = ? AND month_year = ?", [Number(employee_id), month_year]);
      res.json({ success: true, id: result.insertId, net_salary: netSalary });
    } catch (err: any) {
      if (err && err.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ error: "Payroll for this employee/month has already been generated." });
      }
      res.status(500).json({ error: err.message || "Failed to generate payroll." });
    }
  });

  // Edits an un-paid or processed run (e.g. correcting attendance counts
  // after the fact) — recomputes the same way generate does. Once Paid, a
  // run is part of the disbursed record and can no longer be edited here
  // (undo the payment first via a Superadmin-reviewed process outside this
  // route, same caution the app takes with Conveyance disbursement).
  app.put("/api/payroll/:id", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM payrolls WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Payroll record not found." });
      const existing = rows[0];
      if (existing.payment_status === "paid") {
        return res.status(400).json({ error: "A Paid payroll run can't be edited." });
      }

      const workingDays = Math.max(1, Math.round(num(req.body?.total_working_days, existing.total_working_days)));
      const present = Math.max(0, Math.round(num(req.body?.present_days, existing.present_days)));
      const absent = Math.max(0, Math.round(num(req.body?.absent_days, existing.absent_days)));
      const leave = Math.max(0, Math.round(num(req.body?.leave_days, existing.leave_days)));
      const lwp = Math.max(0, Math.round(num(req.body?.lwp_days, existing.lwp_days)));
      const otHours = num(req.body?.overtime_hours, existing.overtime_hours);
      const otAmount = money(num(req.body?.overtime_amount, existing.overtime_amount));
      const bonus = money(num(req.body?.bonus_amount, existing.bonus_amount));
      const otherDed = money(num(req.body?.other_deduction, existing.other_deduction));
      const method = typeof req.body?.payment_method === "string" && req.body.payment_method.trim() ? req.body.payment_method.trim().slice(0, 50) : existing.payment_method;
      const note = req.body?.remarks !== undefined ? String(req.body.remarks).trim().slice(0, 1000) : existing.remarks;

      const structureRows = await queryDB(
        `SELECT * FROM salary_structures
         WHERE employee_id = ? AND effective_date <= LAST_DAY(?)
         ORDER BY effective_date DESC, id DESC LIMIT 1`,
        [existing.employee_id, `${existing.month_year}-01`]
      );
      if (structureRows.length === 0) {
        return res.status(400).json({ error: "This employee no longer has a Salary Structure covering this month." });
      }
      const structure = structureRows[0];
      const grossSalary = Number(structure.gross_salary);
      const basicSalary = Number(structure.basic_salary);
      const allowancesTotal = money(grossSalary - basicSalary);
      const perDayGross = grossSalary / workingDays;
      const unpaidDays = absent + lwp;

      const basicAmount = money(basicSalary * (present / workingDays));
      const allowancesEarned = money(allowancesTotal * (present / workingDays));
      const absentDeduction = money(perDayGross * unpaidDays);
      const grossEarned = money(basicAmount + allowancesEarned + otAmount + bonus);
      const taxDeduction = money(Number(structure.tax_deduction) || 0);
      const pfDeduction = money(Number(structure.pf_deduction) || 0);

      const advances = await queryDB(
        "SELECT * FROM employee_advances WHERE employee_id = ? AND status = 'active' ORDER BY created_at ASC",
        [existing.employee_id]
      );
      let advanceDeduction = 0;
      for (const adv of advances) {
        const remaining = Number(adv.total_amount) - Number(adv.paid_amount);
        if (remaining <= 0) continue;
        advanceDeduction += Math.min(Number(adv.monthly_installment), remaining);
      }
      advanceDeduction = money(advanceDeduction);

      const totalDeduction = money(absentDeduction + taxDeduction + pfDeduction + advanceDeduction + otherDed);
      const netSalary = money(grossEarned - taxDeduction - pfDeduction - advanceDeduction - otherDed);

      await queryDB(
        `UPDATE payrolls SET
           total_working_days = ?, present_days = ?, absent_days = ?, leave_days = ?, lwp_days = ?, overtime_hours = ?,
           basic_amount = ?, allowances_total = ?, overtime_amount = ?, bonus_amount = ?, gross_earned = ?,
           absent_deduction = ?, tax_deduction = ?, pf_deduction = ?, advance_deduction = ?, other_deduction = ?, total_deduction = ?,
           net_salary = ?, payment_method = ?, remarks = ?
         WHERE id = ?`,
        [
          workingDays, present, absent, leave, lwp, otHours,
          basicAmount, allowancesEarned, otAmount, bonus, grossEarned,
          absentDeduction, taxDeduction, pfDeduction, advanceDeduction, otherDed, totalDeduction,
          netSalary, method, note, req.params.id
        ]
      );
      res.json({ success: true, net_salary: netSalary });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to update payroll." });
    }
  });

  // Intermediate step before disbursement — lets Payroll flag a batch as
  // reviewed/ready without yet committing the irreversible advance-recovery
  // bookkeeping that only happens on "mark as paid" below.
  app.post("/api/payroll/:id/process", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM payrolls WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Payroll record not found." });
      if (rows[0].payment_status !== "unpaid") return res.status(400).json({ error: "Only an Unpaid payroll run can be marked Processed." });
      await queryDB("UPDATE payrolls SET payment_status = 'processed' WHERE id = ?", [req.params.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Marks the run as actually disbursed AND, in the same step, applies its
  // advance_deduction against the employee's active advance(s) — the one
  // moment this app permanently records that money as recovered, mirroring
  // how Conveyance Disbursement is the one place is_disbursed flips.
  app.post("/api/payroll/:id/mark-paid", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM payrolls WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Payroll record not found." });
      const payroll = rows[0];
      if (payroll.payment_status === "paid") return res.status(400).json({ error: "This payroll run is already marked Paid." });

      let remainingToRecover = Number(payroll.advance_deduction) || 0;
      if (remainingToRecover > 0) {
        const advances = await queryDB(
          "SELECT * FROM employee_advances WHERE employee_id = ? AND status = 'active' ORDER BY created_at ASC",
          [payroll.employee_id]
        );
        for (const adv of advances) {
          if (remainingToRecover <= 0) break;
          const outstanding = Number(adv.total_amount) - Number(adv.paid_amount);
          if (outstanding <= 0) continue;
          const recover = money(Math.min(Number(adv.monthly_installment), outstanding, remainingToRecover));
          if (recover <= 0) continue;
          const newPaid = money(Number(adv.paid_amount) + recover);
          const newStatus = newPaid >= Number(adv.total_amount) ? "completed" : "active";
          await queryDB("UPDATE employee_advances SET paid_amount = ?, status = ? WHERE id = ?", [newPaid, newStatus, adv.id]);
          remainingToRecover = money(remainingToRecover - recover);
        }
      }

      await queryDB(
        "UPDATE payrolls SET payment_status = 'paid', paid_by = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?",
        [req.user.id, req.params.id]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to mark payroll as paid." });
    }
  });

  // A duplicate/mistaken run can be removed before it's Paid; once Paid it's
  // part of the disbursed record (and its advance recovery already
  // happened), so it can no longer be deleted from here.
  app.delete("/api/payroll/:id", authenticateToken, requireAdmin, requireModule("payroll"), async (req: any, res) => {
    try {
      const rows = await queryDB("SELECT * FROM payrolls WHERE id = ?", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Payroll record not found." });
      if (rows[0].payment_status === "paid") {
        return res.status(400).json({ error: "A Paid payroll run can't be deleted." });
      }
      await queryDB("DELETE FROM payrolls WHERE id = ?", [req.params.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}