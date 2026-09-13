/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employee Transfer (Admin Panel -> Employees -> "Transfer / Change Role")
// — kept in its own file, same reasoning as profileRoutes.ts /
// ConveyanceBillClaimRoutes.ts / PayrollRoutes.ts / AssetManagementRoutes.ts:
// server.ts is already huge, so new features go in their own module and are
// registered from inside startServer() via registerEmployeeTransferRoutes(),
// reusing that request's authenticateToken/requireAdmin/requireModule/queryDB
// rather than a second Express app or DB connection.
//
// Data model (see ensureEmployeeTransferSchema below):
//   employee_transfers — one row per Department/Designation/Supervisor change
//                        made to an all_employees row, keeping the FROM and
//                        TO value of each field so the Employee's job history
//                        stays auditable instead of being silently overwritten
//                        the way a plain "Edit Employee" save does today.
//
// A transfer always does two things together: it records the history row AND
// updates all_employees' own current department/designation (and, when a new
// Supervisor is picked, the employee_supervisors table already owned by the
// Employees module's Supervisor tab — this reuses that table instead of
// tracking supervisor history a second time). queryDB() only ever runs one
// statement at a time (no transaction wrapper exists in this codebase — see
// server.ts), so these are sequential awaits guarded by a try/catch, the same
// pattern POST /api/employees' own create_login branch already uses for its
// own multi-step write (create the login, then the Employee row).

import type { Express } from "express";

interface EmployeeTransferRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  // Same requireModule(moduleKey) factory every other Admin Panel module
  // uses (server.ts) — this feature lives under the existing 'employees'
  // module, not a new one, since it's just another action on the same
  // Employee Directory row.
  requireModule: (moduleKey: "employees") => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
}

// Self-healing migration — same pattern as ensureAssetManagementSchema /
// ensurePayrollSchema: CREATE TABLE IF NOT EXISTS means a normal server
// restart is enough to pick this up on an already-running database, no
// manual SQL required. Called from server.ts's ensureSchemaMigrations()
// alongside every other table.
export async function ensureEmployeeTransferSchema(dbPool: any): Promise<void> {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS employee_transfers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        from_department_id INT NULL,
        from_department_name VARCHAR(255) NULL,
        to_department_id INT NULL,
        to_department_name VARCHAR(255) NULL,
        from_designation VARCHAR(255) NULL,
        to_designation VARCHAR(255) NULL,
        from_supervisor_id INT NULL,
        to_supervisor_id INT NULL,
        effective_date DATE NULL,
        reason VARCHAR(255) NULL,
        action_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES all_employees(id) ON DELETE CASCADE,
        FOREIGN KEY (from_supervisor_id) REFERENCES all_employees(id) ON DELETE SET NULL,
        FOREIGN KEY (to_supervisor_id) REFERENCES all_employees(id) ON DELETE SET NULL,
        FOREIGN KEY (action_by) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
  } catch (err: any) {
    console.warn("⚠️ Could not ensure employee_transfers table exists: " + err.message);
  }
}

export function registerEmployeeTransferRoutes(app: Express, deps: EmployeeTransferRouteDeps) {
  const { authenticateToken, requireAdmin, requireModule, queryDB } = deps;

  // Same department resolution POST/PUT /api/employees already does
  // (server.ts's resolveEmployeeDepartment) — kept as a small local copy
  // here since that one isn't exported. A department_id that no longer
  // matches any row just falls back to "no structured Department", same as
  // the original.
  async function resolveDepartment(
    departmentId: number | null
  ): Promise<{ department_id: number | null; department_name: string | null }> {
    if (departmentId) {
      const rows = await queryDB("SELECT id, name FROM departments WHERE id = ?", [departmentId]);
      if (rows.length > 0) return { department_id: Number(rows[0].id), department_name: rows[0].name };
    }
    return { department_id: null, department_name: null };
  }

  // History list for the "Transfer History" view on an Employee row —
  // newest first, with Department/Supervisor names joined in for display
  // (mirrors GET /api/employees/:id/supervisors' own join style).
  app.get(
    "/api/employees/:id/transfers",
    authenticateToken,
    requireAdmin,
    requireModule("employees"),
    async (req, res) => {
      try {
        const id = Number(req.params.id);
        const rows = await queryDB(
          `SELECT t.*,
                  fs.name AS from_supervisor_name,
                  ts.name AS to_supervisor_name,
                  u.name AS action_by_name
           FROM employee_transfers t
           LEFT JOIN all_employees fs ON fs.id = t.from_supervisor_id
           LEFT JOIN all_employees ts ON ts.id = t.to_supervisor_id
           LEFT JOIN users u ON u.id = t.action_by
           WHERE t.employee_id = ?
           ORDER BY t.effective_date DESC, t.id DESC`,
          [id]
        );
        res.json(rows);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  // Transfer / Change Role — Admin Panel -> Employees -> row action. Changes
  // Department and/or Designation (job title) and, optionally, Supervisor,
  // recording a full FROM/TO snapshot in employee_transfers before touching
  // the live all_employees row.
  app.post(
    "/api/employees/:id/transfer",
    authenticateToken,
    requireAdmin,
    requireModule("employees"),
    async (req: any, res) => {
      try {
        const id = Number(req.params.id);
        const employeeRows = await queryDB("SELECT * FROM all_employees WHERE id = ?", [id]);
        if (employeeRows.length === 0) return res.status(404).json({ error: "Employee not found" });
        const current = employeeRows[0];

        const { to_department_id, to_designation, to_supervisor_id, effective_date, reason } = req.body;

        if (!effective_date || !String(effective_date).trim()) {
          return res.status(400).json({ error: "Effective date is required." });
        }

        const newSupervisorId = to_supervisor_id ? Number(to_supervisor_id) : null;
        if (newSupervisorId === id) {
          return res.status(400).json({ error: "An employee cannot be their own supervisor." });
        }
        if (newSupervisorId) {
          const supExists = await queryDB("SELECT id FROM all_employees WHERE id = ?", [newSupervisorId]);
          if (supExists.length === 0) {
            return res.status(400).json({ error: "Selected supervisor was not found in the Employee list." });
          }
        }

        // Nothing typed means "keep as-is" — a Transfer only needs to touch
        // Department, only Designation, or both; Supervisor is optional on
        // top of either.
        const toDept =
          to_department_id !== undefined && to_department_id !== null && to_department_id !== ""
            ? await resolveDepartment(Number(to_department_id))
            : { department_id: current.department_id ?? null, department_name: current.department ?? null };
        const toDesignation =
          to_designation && String(to_designation).trim() ? String(to_designation).trim() : current.designation;

        // Current direct Supervisor on file (employee_supervisors), if any —
        // this table already IS the Employees module's Supervisor history,
        // so a Transfer reads/writes it instead of duplicating supervisor
        // tracking a second time inside employee_transfers.
        const currentSupervisorRows = await queryDB(
          "SELECT supervisor_id FROM employee_supervisors WHERE employee_id = ? AND is_direct = 1 ORDER BY effective_date DESC, id DESC LIMIT 1",
          [id]
        );
        const fromSupervisorId = currentSupervisorRows.length > 0 ? currentSupervisorRows[0].supervisor_id : null;

        // 1. Record the history row first.
        const insertResult = await queryDB(
          `INSERT INTO employee_transfers
           (employee_id, from_department_id, from_department_name, to_department_id, to_department_name,
            from_designation, to_designation, from_supervisor_id, to_supervisor_id, effective_date, reason, action_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            current.department_id ?? null,
            current.department ?? null,
            toDept.department_id,
            toDept.department_name,
            current.designation ?? null,
            toDesignation ?? null,
            fromSupervisorId,
            newSupervisorId,
            String(effective_date).trim(),
            reason && String(reason).trim() ? String(reason).trim() : null,
            req.user?.id ?? null
          ]
        );

        // 2. Update the live Employee row — Department + Designation always;
        // designation_effective_date follows the same field PUT /api/employees
        // already exposes on the Status tab, so this stays consistent with a
        // manually-typed effective date there.
        await queryDB(
          `UPDATE all_employees
           SET department_id = ?, department = ?, designation = ?, designation_effective_date = ?
           WHERE id = ?`,
          [toDept.department_id, toDept.department_name, toDesignation, String(effective_date).trim(), id]
        );

        // 3. Only touch Supervisor if a new one was actually picked and it's
        // different from the current one — otherwise leave the Supervisor
        // tab's own history untouched.
        if (newSupervisorId && newSupervisorId !== fromSupervisorId) {
          await queryDB(
            "UPDATE employee_supervisors SET is_direct = 0 WHERE employee_id = ? AND is_direct = 1",
            [id]
          );
          await queryDB(
            "INSERT INTO employee_supervisors (employee_id, supervisor_id, effective_date, is_direct) VALUES (?, ?, ?, 1)",
            [id, newSupervisorId, String(effective_date).trim()]
          );
        }

        res.status(201).json({ success: true, id: insertResult.insertId });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }
  );
}
