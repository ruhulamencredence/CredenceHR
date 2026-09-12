-- ============================================================================
-- Payroll Module schema — adapted from the uploaded Payroll.sql to this app's
-- real conventions:
--   * This app has NO `employees` table — the company roster is
--     `all_employees` (Admin Panel -> Employees, see schema.sql). Every
--     employee_id below points at all_employees(id), not a table that
--     doesn't exist here.
--   * created_by/generated_by/paid_by columns added, mirroring how every
--     other module (budgets, notices, conveyance_bills, holiday_calendar...)
--     records which logged-in `users` account performed the action.
--   * INDEX/UNIQUE KEYs added where the routes need fast/duplicate-safe
--     lookups (one salary structure history per employee, one payroll row
--     per employee per month).
-- These are created at server startup (self-healing migration, same pattern
-- as holiday_calendar/conveyance_bills/etc.) — see ensurePayrollSchema() in
-- PayrollRoutes.ts. This file is kept alongside schema.sql purely for
-- reference/manual import; the server does not read this file directly.
-- ============================================================================

-- 1. Salary Structure Table — one row per (employee, effective_date). An
-- employee can have several rows over time (a raise, a promotion); the ROUTES
-- always resolve "current structure" as the most recent row whose
-- effective_date is on or before the date in question, never a straight
-- UPDATE-in-place, so old payroll runs keep referring to the numbers that were
-- actually in effect at the time.
CREATE TABLE IF NOT EXISTS salary_structures (
    id INT AUTO_INCREMENT PRIMARY KEY,
    employee_id INT NOT NULL,
    basic_salary DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    house_rent DECIMAL(10, 2) DEFAULT 0.00,
    medical_allowance DECIMAL(10, 2) DEFAULT 0.00,
    conveyance_allowance DECIMAL(10, 2) DEFAULT 0.00,
    other_allowance DECIMAL(10, 2) DEFAULT 0.00,
    -- Always server-computed (basic + the four allowances above) — never
    -- trusted from the request body, so it can't drift from its parts.
    gross_salary DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    tax_deduction DECIMAL(10, 2) DEFAULT 0.00,
    pf_deduction DECIMAL(10, 2) DEFAULT 0.00,
    effective_date DATE NOT NULL,
    created_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_salary_structures_employee_date (employee_id, effective_date)
);

-- 2. Employee Loans/Advances Table — status flips to 'completed' automatically
-- (in the routes) once paid_amount reaches total_amount via Payroll's
-- advance_deduction on each "mark as paid" payroll run.
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
);

-- 3. Monthly Payroll Table — one processed row per (employee, month_year).
-- UNIQUE KEY below is what makes POST /api/payroll/generate safe to call
-- twice for the same employee/month without creating a duplicate.
CREATE TABLE IF NOT EXISTS payrolls (
    id INT AUTO_INCREMENT PRIMARY KEY,
    employee_id INT NOT NULL,
    month_year VARCHAR(7) NOT NULL, -- Format: 'YYYY-MM' (e.g. '2026-09')

    -- Attendance Details (entered by the Admin generating the run; not
    -- auto-derived from the Remote Attendance table, which only covers
    -- project check-ins, not the whole company roster)
    total_working_days INT NOT NULL,
    present_days INT NOT NULL DEFAULT 0,
    absent_days INT NOT NULL DEFAULT 0,
    leave_days INT NOT NULL DEFAULT 0,
    lwp_days INT NOT NULL DEFAULT 0, -- Leave Without Pay
    overtime_hours DECIMAL(5, 2) DEFAULT 0.00,

    -- Earnings Breakdown
    basic_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    allowances_total DECIMAL(10, 2) DEFAULT 0.00,
    overtime_amount DECIMAL(10, 2) DEFAULT 0.00,
    bonus_amount DECIMAL(10, 2) DEFAULT 0.00,
    gross_earned DECIMAL(10, 2) NOT NULL DEFAULT 0.00,

    -- Deductions Breakdown
    absent_deduction DECIMAL(10, 2) DEFAULT 0.00,
    tax_deduction DECIMAL(10, 2) DEFAULT 0.00,
    pf_deduction DECIMAL(10, 2) DEFAULT 0.00,
    advance_deduction DECIMAL(10, 2) DEFAULT 0.00,
    other_deduction DECIMAL(10, 2) DEFAULT 0.00,
    total_deduction DECIMAL(10, 2) NOT NULL DEFAULT 0.00,

    -- Final Salary
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
);
