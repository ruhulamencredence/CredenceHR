/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employee Directory (Self Service -> "Employee Directory") — kept in its
// own file, same reasoning as profileRoutes.ts/AssetManagementRoutes.ts/
// EmployeeTransferRoutes.ts: server.ts is already huge, so new features go
// in their own module and are registered from inside startServer() via
// registerEmployeeDirectoryRoutes(), reusing that request's
// authenticateToken/queryDB rather than a second Express app or DB
// connection.
//
// Unlike Admin Panel -> Employees (EmployeesPanel.tsx / the /api/employees
// routes in server.ts), which is the HR editing view gated behind
// requireAdmin + requireModule('employees'), this is a read-only, company-
// wide roster every signed-in account can browse — authenticateToken only,
// deliberately no requireAdmin/requireModule gate. Because of that, the
// SELECT below only ever returns directory-safe columns (name, designation,
// department, work contact info, office location, supervisor) — it never
// exposes the Employee Info/Status/Contact tab's more personal fields (NID,
// date of birth, religion, marital status, blood group, home addresses)
// that a plain 'user' account has no business seeing about a colleague.

import type { Express } from "express";
import { companyStore } from "./companyContext";

interface EmployeeDirectoryRouteDeps {
  authenticateToken: any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
}

export function registerEmployeeDirectoryRoutes(app: Express, deps: EmployeeDirectoryRouteDeps) {
  const { authenticateToken, queryDB } = deps;

  // Multi-company: normally the roster of the company being worked in. An
  // account allowed the whole group's directory (users.can_view_group_directory,
  // set in Admin Panel -> Companies -> Who can work where) and the Superadmin
  // see every company of the group at once — mother and sister companies —
  // without switching company. Never another group's.
  app.get("/api/employee-directory", authenticateToken, async (req: any, res) => {
    try {
      const ctx = companyStore.getStore();
      let wholeGroup = req.user?.role === "superadmin";
      if (!wholeGroup && ctx) {
        const me: any[] = (await queryDB("SELECT can_view_group_directory FROM users WHERE id = ?", [req.user.id]).catch(() => [])) || [];
        wholeGroup = !!Number(me[0]?.can_view_group_directory || 0);
      }
      const load = () => queryDB(
        `SELECT e.id, e.employee_id, e.name, e.designation, e.department, e.department_id,
                e.email, e.phone, e.mobile, e.telephone, e.branch, e.division, e.unit,
                e.is_active, e.user_id, e.company_id,
                sup.name AS supervisor_name
         FROM all_employees e
         LEFT JOIN (
           -- Most recent is_direct=1 row per employee — same "current
           -- Supervisor" resolution GET /api/employees' departmentSupervisorLabel
           -- and the Transfer feature use, just picked here via MAX(id)
           -- instead of an ORDER BY/LIMIT 1 correlated subquery.
           SELECT es1.employee_id, es1.supervisor_id
           FROM employee_supervisors es1
           INNER JOIN (
             SELECT employee_id, MAX(id) AS max_id
             FROM employee_supervisors
             WHERE is_direct = 1
             GROUP BY employee_id
           ) latest ON latest.employee_id = es1.employee_id AND latest.max_id = es1.id
         ) cur ON cur.employee_id = e.id
         LEFT JOIN all_employees sup ON sup.id = cur.supervisor_id
         ORDER BY e.name ASC`
      );
      const rows: any[] = wholeGroup && ctx ? await companyStore.run({ ...ctx, wholeGroup: true }, load) : await load();
      const companies: any[] = (await queryDB("SELECT * FROM companies").catch(() => [])) || [];
      const companyOf = new Map(companies.map((c: any) => [Number(c.id), c]));
      res.json(
        rows.map((r: any) => ({
          id: r.id,
          employee_id: r.employee_id,
          name: r.name,
          designation: r.designation,
          department: r.department,
          department_id: r.department_id,
          email: r.email,
          phone: r.phone,
          mobile: r.mobile,
          telephone: r.telephone,
          branch: r.branch,
          division: r.division,
          unit: r.unit,
          is_active: !!Number(r.is_active),
          user_id: r.user_id,
          supervisor_name: r.supervisor_name || null,
          company_id: r.company_id != null ? Number(r.company_id) : null,
          company_name: companyOf.get(Number(r.company_id ?? 1))?.name || null,
          company_code: companyOf.get(Number(r.company_id ?? 1))?.short_code || null
        }))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
