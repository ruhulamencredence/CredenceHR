/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Superadmin-only diagnostic routes, moved out of server.ts unchanged.
// The shared helpers they use are passed in by startServer().

import type { Express } from "express";

export interface RegisterDebugRoutesDeps {
  authenticateToken: any;
  queryDB: any;
  requireSuperAdmin: any;
  resolveSupervisorApprover: any;
}

export function registerDebugRoutes(app: Express, deps: RegisterDebugRoutesDeps) {
  const { authenticateToken, queryDB, requireSuperAdmin, resolveSupervisorApprover } = deps;
  // GET /api/debug/supervisor-resolution?email=... — Superadmin-only
  // diagnostic for "why did this Employee's Asset/Vehicle/Conveyance/Leave/
  // Timesheet requisition skip the auto-Supervisor layer even though they
  // have a Supervisor set" (a support question with several possible real
  // causes — see below — that's otherwise invisible from the UI). Reports
  // every step resolveSupervisorApprover (this file) actually walks through
  // for that account, so a Superadmin can see exactly which check failed
  // instead of guessing. Read-only, no side effects.
  app.get("/api/debug/supervisor-resolution", authenticateToken, requireSuperAdmin, async (req: any, res: any) => {
    try {
      const email = String(req.query.email || "").trim().toLowerCase();
      if (!email) return res.status(400).json({ error: "?email=... is required." });
      const userRows = await queryDB("SELECT id, name, email, role FROM users WHERE LOWER(email) = ?", [email]);
      if (userRows.length === 0) return res.status(404).json({ error: `No login account found for ${email}.` });
      const user = userRows[0];

      const employeeRows = await queryDB("SELECT * FROM all_employees WHERE user_id = ?", [user.id]);
      const employee = employeeRows[0] || null;
      if (!employee) {
        return res.json({
          user,
          employee_directory_row: null,
          verdict: "No Employee Directory row is linked to this login account (all_employees.user_id) — both the Direct Supervisor and Department Supervisor lookups need this link, so neither can ever resolve. Link this account to its Employee Directory record first."
        });
      }

      const directRows = await queryDB(
        `SELECT es.*, sup.user_id AS supervisor_user_id, sup.name AS supervisor_employee_name, u2.name AS supervisor_login_name, u2.email AS supervisor_login_email
         FROM employee_supervisors es
         JOIN all_employees sup ON sup.id = es.supervisor_id
         LEFT JOIN users u2 ON u2.id = sup.user_id
         WHERE es.employee_id = ?
         ORDER BY es.id DESC`,
        [employee.id]
      );
      const directCandidates = directRows.map((r: any) => ({
        is_direct: !!Number(r.is_direct),
        supervisor_employee_name: r.supervisor_employee_name,
        supervisor_has_login_account: r.supervisor_user_id != null,
        supervisor_login_email: r.supervisor_login_email || null,
        usable: !!Number(r.is_direct) && r.supervisor_user_id != null && Number(r.supervisor_user_id) !== Number(user.id)
      }));

      const deptRows = employee.department_id
        ? await queryDB(
            `SELECT d.name, d.is_active, d.include_supervisor_approval, d.supervisor_user_id,
                    u3.name AS dept_supervisor_login_name, u3.email AS dept_supervisor_login_email
               FROM departments d
               LEFT JOIN users u3 ON u3.id = d.supervisor_user_id
              WHERE d.id = ?`,
            [employee.department_id]
          )
        : [];
      const department = deptRows[0] || null;
      const departmentUsable =
        !!department &&
        !!Number(department.is_active) &&
        !!Number(department.include_supervisor_approval) &&
        department.supervisor_user_id != null &&
        Number(department.supervisor_user_id) !== Number(user.id);

      const resolvedSupervisorId = await resolveSupervisorApprover(user.id);

      let verdict: string;
      if (resolvedSupervisorId) {
        verdict = `Resolved to user_id ${resolvedSupervisorId} — a request SHOULD get an auto-Supervisor step. If one still didn't, check the Template actually used (Admin Panel -> Approvals -> Templates -> this Request Type) for skip_auto_supervisor / Layer 1 set to Employee instead of Supervisor.`;
      } else if (directCandidates.some((c) => c.is_direct && !c.usable)) {
        verdict =
          "A Direct Supervisor row exists but isn't usable — most likely the assigned Supervisor's own Employee Directory record has no login account linked (supervisor_has_login_account: false above), or the Supervisor IS this employee themselves.";
      } else if (directCandidates.length === 0 && !departmentUsable) {
        verdict = department
          ? "No Direct Supervisor is set for this employee, and the Department fallback isn't usable — either the department's 'Include Supervisor Approval' toggle is off, it has no Supervisor assigned, that Supervisor has no login account, or the department itself is inactive."
          : "No Direct Supervisor is set for this employee, and they have no Department at all for the fallback to use.";
      } else {
        verdict = "No usable Supervisor found by either path — see direct_supervisor_candidates / department below for the specific reason.";
      }

      res.json({
        user,
        employee_directory_row: { id: employee.id, department_id: employee.department_id },
        direct_supervisor_candidates: directCandidates,
        department,
        department_fallback_usable: departmentUsable,
        resolved_supervisor_user_id: resolvedSupervisorId,
        verdict
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
