/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employee Directory (Admin Panel -> Employees) routes, moved out of server.ts unchanged.
// The shared helpers they use are passed in by startServer().

import { applyDueEmployeeTransfers } from "./EmployeeTransferRoutes";
import { recordEmployeeEditHistory } from "./EmployeeTransferRoutes";
import { applyDueHrActions } from "./HROperationsRoutes";
import { activeCompanyId } from "./companyContext";
import { EMPLOYEE_BOOL_FIELDS } from "./memoryDbFallback";
import bcrypt from "bcryptjs";
import type { Express } from "express";

export interface RegisterEmployeeRoutesDeps {
  ADMIN_MODULE_KEYS: any;
  EMPLOYEE_EXT_FIELDS: any;
  authenticateToken: any;
  normalizeEmployeeExtValue: any;
  queryDB: any;
  requireAdmin: any;
  requireModule: any;
  todayInDhaka: any;
}

export function registerEmployeeRoutes(app: Express, deps: RegisterEmployeeRoutesDeps) {
  const { ADMIN_MODULE_KEYS, EMPLOYEE_EXT_FIELDS, authenticateToken, normalizeEmployeeExtValue, queryDB, requireAdmin, requireModule, todayInDhaka } = deps;

  // Employee Directory (Admin Panel -> Employees) — plain hand-entered company
  // roster, gated behind the "employees" AdminModuleKey like every other tab
  // (a Superadmin always has it; an Admin/User only once the Superadmin grants
  // it via PUT /api/users/:id/module-permissions). Not linked to login
  // accounts (User rows) — most listed employees never get one.
  app.get("/api/employees", authenticateToken, requireAdmin, requireModule("employees"), async (req, res) => {
    try {
      // Promote any future-dated Transfer whose Effective Date has now
      // arrived before the list is read — see EmployeeTransferRoutes.ts.
      // No cron exists in this codebase, so this list (the most common way
      // an Employee's current Department/Designation gets read) is where
      // that lazily happens for everyone, not just whoever next opens the
      // Transfer modal for that one employee.
      await applyDueEmployeeTransfers(queryDB, todayInDhaka());
      // Same lazy catch-up for approved HR Operations actions (grade,
      // confirmation, separation…) whose Effective Date has arrived.
      await applyDueHrActions(queryDB, todayInDhaka());
      const rows = await queryDB("SELECT * FROM all_employees");
      const sorted = [...rows].sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
      res.json(
        sorted.map((e: any) => {
          const out: Record<string, any> = {
            id: e.id,
            employee_id: e.employee_id || null,
            name: e.name,
            designation: e.designation || null,
            department: e.department || null,
            // The structured Department (Admin Panel -> Departments) this row
            // is linked to, if any — `department` above stays a plain-text
            // mirror of departments.name for every existing reader (Notices
            // targeting, Attendance Reports, this panel's own search) that
            // never learned about department_id.
            department_id: e.department_id || null,
            // Same "structured link, free-text `branch` above stays a plain
            // mirror for existing readers" reasoning as department_id — see
            // resolveEmployeeBranch's own comment.
            branch: e.branch || null,
            branch_id: e.branch_id || null,
            email: e.email || null,
            phone: e.phone || null,
            is_active: !!Number(e.is_active),
            created_at: e.created_at,
            user_id: e.user_id || null
          };
          for (const field of EMPLOYEE_EXT_FIELDS) {
            out[field] = (EMPLOYEE_BOOL_FIELDS as readonly string[]).includes(field)
              ? !!Number(e[field])
              : e[field] ?? null;
          }
          return out;
        })
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Users with no all_employees row pointing at them yet — the pool "Link
  // Existing User" (below) can attach to an Employee that was added to the
  // directory AFTER its login already existed (the reverse of create-login,
  // which makes a brand-new login instead of reusing one). Scoped to the
  // "employees" module, not "users", so an Admin who only has Employees
  // access can still use this picker without also needing Users access.
  app.get("/api/employees/unlinked-users", authenticateToken, requireAdmin, requireModule("employees"), async (req: any, res) => {
    try {
      const rows: any = await queryDB(
        `SELECT id, name, email, username, role FROM users
         WHERE id NOT IN (SELECT user_id FROM all_employees WHERE user_id IS NOT NULL)`
      );
      // Same "plain Admin never sees the Superadmin account" rule as the
      // Users list.
      const visible = req.user.role === "superadmin" ? rows : rows.filter((u: any) => u.role !== "superadmin");
      res.json(visible.map((u: any) => ({ id: u.id, name: u.name, email: u.email || null, username: u.username || null, role: u.role })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Resolves a submitted department_id (Admin Panel -> Departments) into the
  // pair actually written to all_employees — falls back to the legacy
  // free-text `department` field when no department_id is given (old API
  // callers/import scripts that predate the Departments table), and to
  // null/null when neither is given. `department` is kept in sync with the
  // Department's own name (mirrored, not dropped) so every existing reader
  // that only ever knew about the free-text column — Notices targeting,
  // Attendance Reports, this panel's own search/filter — keeps working
  // unchanged; department_id is the new source of truth for the Supervisor/
  // Approval Workflow wiring (see resolveDepartmentSupervisor).
  async function resolveEmployeeDepartment(body: any): Promise<{ department_id: number | null; department_name: string | null }> {
    const departmentId = body.department_id ? Number(body.department_id) : null;
    if (departmentId) {
      const rows = await queryDB("SELECT id, name FROM departments WHERE id = ?", [departmentId]);
      if (rows.length > 0) return { department_id: Number(rows[0].id), department_name: rows[0].name };
    }
    const legacyText = body.department && String(body.department).trim() ? String(body.department).trim() : null;
    return { department_id: null, department_name: legacyText };
  }

  // Exact same shape as resolveEmployeeDepartment above, for Branch (Admin
  // Panel -> Branches — which of an Employee's own Holiday Calendars, Head
  // Office or Project site, applies to them is driven entirely by their
  // Branch's branch_type, see getEmployeeBranchTypeMap in holidayRoutes.ts).
  // `branch` is kept in sync with the resolved Branch's own name (mirrored,
  // not dropped) for every existing reader that only ever knew the free-text
  // column — same reasoning as department/department_id.
  async function resolveEmployeeBranch(body: any): Promise<{ branch_id: number | null; branch_name: string | null }> {
    const branchId = body.branch_id ? Number(body.branch_id) : null;
    if (branchId) {
      const rows = await queryDB("SELECT * FROM branches WHERE id = ?", [branchId]);
      if (rows.length > 0) return { branch_id: Number(rows[0].id), branch_name: rows[0].branch_name };
    }
    const legacyText = body.branch && String(body.branch).trim() ? String(body.branch).trim() : null;
    return { branch_id: null, branch_name: legacyText };
  }

  // create_login (optional): when true, a users row is created in the SAME
  // request as the all_employees row and linked via all_employees.user_id —
  // this is how "adding an Employee" can also make them a User with their own
  // login, instead of the two always being separate (see all_employees'
  // schema.sql comment). login_email/login_username/login_password drive the
  // new account; login_email falls back to the Employee's own `email` field
  // when not given separately, since most companies log in with the same
  // work email already on the directory row. Mirrors POST /api/users' own
  // validation (password length, duplicate email/username) so a bad login
  // request fails BEFORE the Employee row is ever inserted — never leaves a
  // half-created Employee-with-broken-login behind.
  //
  // login_project_ids/login_module_keys (optional, only used when create_login
  // is true): lets the same request that creates the login also grant Project
  // Access (user_project_permissions — same table/shape PUT /api/users/:id/
  // projects writes) and Admin Panel Module Access (admin_module_permissions —
  // same table PUT /api/users/:id/module-permissions writes), instead of
  // requiring a second trip to Admin Panel -> Users afterward. Module grants
  // stay Superadmin-only, same as that dedicated endpoint — a plain Admin
  // (even with the "employees" module) can still create the login and set
  // Project Access, but login_module_keys is silently ignored for them.
  // Office Attendance (ZKTeco) device PIN — the number this Employee is
  // enrolled under on the office terminals, which is how their punches in
  // zk_attendance_logs are matched to them (see zkSync.ts). Only touched when
  // the request actually carries zk_device_pin, so older callers that never
  // send it leave an existing PIN alone. Returns an error message for a PIN
  // already given to someone else (the column is UNIQUE), null when fine.
  async function checkZkDevicePin(body: any, employeeId: number | null): Promise<{ set: boolean; pin: string | null; error: string | null }> {
    if (!body || !Object.prototype.hasOwnProperty.call(body, "zk_device_pin")) return { set: false, pin: null, error: null };
    const pin = body.zk_device_pin != null && String(body.zk_device_pin).trim() ? String(body.zk_device_pin).trim().slice(0, 20) : null;
    if (pin) {
      const taken = await queryDB("SELECT id, name FROM all_employees WHERE zk_device_pin = ?", [pin]);
      const other = taken.find((r: any) => Number(r.id) !== Number(employeeId));
      if (other) return { set: true, pin, error: `Attendance Device PIN ${pin} is already used by ${other.name}.` };
    }
    return { set: true, pin, error: null };
  }

  app.post("/api/employees", authenticateToken, requireAdmin, requireModule("employees"), async (req: any, res) => {
    try {
      const { employee_id, name, designation, department, department_id, email, phone, is_active, create_login, login_email, login_username, login_password, login_project_ids, login_module_keys } = req.body;
      if (!name || !String(name).trim()) return res.status(400).json({ error: "Name is required" });
      const zkPin = await checkZkDevicePin(req.body, null);
      if (zkPin.error) return res.status(400).json({ error: zkPin.error });
      const branch = await resolveEmployeeBranch(req.body);

      let newUserId: number | null = null;
      let grantedProjectIds: number[] = [];
      let grantedModuleKeys: string[] = [];

      if (create_login) {
        const loginEmail = (login_email && String(login_email).trim()) || (email && String(email).trim()) || null;
        const loginUsername = login_username && String(login_username).trim() ? String(login_username).trim() : null;
        if (!loginEmail && !loginUsername) {
          return res.status(400).json({ error: "A login email or username is required to create a login for this employee." });
        }
        if (!login_password || String(login_password).length < 6) {
          return res.status(400).json({ error: "Login password must be at least 6 characters." });
        }
        if (loginEmail) {
          const existingEmail = await queryDB("SELECT id FROM users WHERE email = ?", [loginEmail]);
          if (existingEmail.length > 0) return res.status(400).json({ error: "That login email is already registered." });
        }
        if (loginUsername) {
          const existingUsername = await queryDB("SELECT id FROM users WHERE username = ?", [loginUsername]);
          if (existingUsername.length > 0) return res.status(400).json({ error: "That username is already taken." });
        }

        const password_hash = await bcrypt.hash(String(login_password), 10);
        const userResult = await queryDB(
          "INSERT INTO users (name, email, username, password_hash, role) VALUES (?, ?, ?, ?, 'user')",
          [String(name).trim(), loginEmail, loginUsername, password_hash]
        );
        newUserId = userResult.insertId;

        // Project Access — open to any Admin who reached this endpoint (same
        // rule PUT /api/users/:id/projects follows: requires the "employees"/
        // "users" module, not Superadmin specifically).
        if (Array.isArray(login_project_ids)) {
          grantedProjectIds = Array.from(new Set(login_project_ids.map((pid: any) => Number(pid)).filter((pid: number) => Number.isFinite(pid))));
          for (const pid of grantedProjectIds) {
            await queryDB("INSERT INTO user_project_permissions (user_id, project_id) VALUES (?, ?)", [newUserId, pid]);
          }
        }

        // Module Access — Superadmin-only grant, same gate PUT
        // /api/users/:id/module-permissions enforces; quietly skipped for a
        // plain Admin instead of failing the whole request.
        if (req.user.role === "superadmin" && Array.isArray(login_module_keys)) {
          grantedModuleKeys = login_module_keys.filter((m: any) => (ADMIN_MODULE_KEYS as readonly string[]).includes(m));
          for (const moduleKey of grantedModuleKeys) {
            await queryDB("INSERT INTO admin_module_permissions (user_id, module_key, company_id) VALUES (?, ?, ?)", [newUserId, moduleKey, activeCompanyId()]);
          }
        }
      }

      // Employee Info / Status / Contact tab fields — all optional, all
      // normalized the same way (trim to null, dates left as-is, booleans to
      // 0/1). See EMPLOYEE_EXT_FIELDS.
      const extColumns = EMPLOYEE_EXT_FIELDS;
      const extValues = extColumns.map((field) => normalizeEmployeeExtValue(field, req.body[field]));
      const dept = await resolveEmployeeDepartment(req.body);

      const columns = ["employee_id", "name", "designation", "department", "department_id", "branch", "branch_id", "email", "phone", "is_active", "user_id", ...extColumns];
      const placeholders = columns.map(() => "?").join(", ");
      const values = [
        employee_id && String(employee_id).trim() ? String(employee_id).trim() : null,
        String(name).trim(),
        designation && String(designation).trim() ? String(designation).trim() : null,
        dept.department_name,
        dept.department_id,
        branch.branch_name,
        branch.branch_id,
        email && String(email).trim() ? String(email).trim() : null,
        phone && String(phone).trim() ? String(phone).trim() : null,
        is_active === false ? 0 : 1,
        newUserId,
        ...extValues
      ];
      const result = await queryDB(
        `INSERT INTO all_employees (${columns.join(", ")}) VALUES (${placeholders})`,
        values
      );
      if (zkPin.set && zkPin.pin) {
        await queryDB("UPDATE all_employees SET zk_device_pin = ? WHERE id = ?", [zkPin.pin, result.insertId]);
      }
      res.status(201).json({ id: result.insertId, user_id: newUserId, project_ids: grantedProjectIds, module_keys: grantedModuleKeys });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/employees/:id", authenticateToken, requireAdmin, requireModule("employees"), async (req: any, res) => {
    try {
      // Catch up any future-dated Transfer whose Effective Date has arrived
      // BEFORE reading `existing`, so the history's FROM values are the true
      // current state (and a due-but-unapplied Transfer can't land later and
      // silently overwrite this edit) — same reasoning as POST /transfer.
      await applyDueEmployeeTransfers(queryDB, todayInDhaka());

      const id = Number(req.params.id);
      const existing = await queryDB("SELECT * FROM all_employees WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Employee not found" });

      const { employee_id, name, designation, department, department_id, email, phone, is_active } = req.body;
      if (!name || !String(name).trim()) return res.status(400).json({ error: "Name is required" });
      const zkPin = await checkZkDevicePin(req.body, id);
      if (zkPin.error) return res.status(400).json({ error: zkPin.error });
      const branch = await resolveEmployeeBranch(req.body);

      const extColumns = EMPLOYEE_EXT_FIELDS;
      const extValues = extColumns.map((field) => normalizeEmployeeExtValue(field, req.body[field]));
      const dept = await resolveEmployeeDepartment(req.body);
      const setClause = ["employee_id = ?", "name = ?", "designation = ?", "department = ?", "department_id = ?", "branch = ?", "branch_id = ?", "email = ?", "phone = ?", "is_active = ?", ...extColumns.map((c) => `${c} = ?`)].join(", ");

      const newEmployeeCode = employee_id && String(employee_id).trim() ? String(employee_id).trim() : null;
      const newName = String(name).trim();
      const newDesignation = designation && String(designation).trim() ? String(designation).trim() : null;
      const newEmail = email && String(email).trim() ? String(email).trim() : null;
      const newPhone = phone && String(phone).trim() ? String(phone).trim() : null;
      const newIsActive = is_active === false ? 0 : 1;

      // Audit trail — Department/Designation changes go to employee_transfers
      // (so they appear in the same Transfer History as a Transfer-modal
      // change), every other changed field to employee_change_log. Recorded
      // before the UPDATE, same order as POST /transfer. See
      // recordEmployeeEditHistory in EmployeeTransferRoutes.ts.
      const after: Record<string, any> = {
        employee_id: newEmployeeCode,
        name: newName,
        email: newEmail,
        phone: newPhone,
        is_active: newIsActive,
        branch: branch.branch_name,
        branch_id: branch.branch_id,
        department_id: dept.department_id,
        department: dept.department_name,
        designation: newDesignation
      };
      extColumns.forEach((c, i) => { after[c] = extValues[i]; });
      await recordEmployeeEditHistory(queryDB, {
        employeeId: id,
        before: existing[0],
        after,
        trackedFields: ["employee_id", "name", "email", "phone", "is_active", "branch", "branch_id", ...extColumns],
        actionBy: req.user?.id ?? null,
        today: todayInDhaka()
      });

      await queryDB(
        `UPDATE all_employees SET ${setClause} WHERE id = ?`,
        [
          newEmployeeCode,
          newName,
          newDesignation,
          dept.department_name,
          dept.department_id,
          branch.branch_name,
          branch.branch_id,
          newEmail,
          newPhone,
          newIsActive,
          ...extValues,
          id
        ]
      );
      if (zkPin.set && (existing[0].zk_device_pin ?? null) !== zkPin.pin) {
        await queryDB("UPDATE all_employees SET zk_device_pin = ? WHERE id = ?", [zkPin.pin, id]);
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/employees/:id", authenticateToken, requireAdmin, requireModule("employees"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await queryDB("SELECT * FROM all_employees WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Employee not found" });
      await queryDB("DELETE FROM all_employees WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Supervisor tab (Admin Panel -> Employees -> Edit -> Supervisor). The
  // Supervisor is always another row picked from the same all_employees
  // list — never typed free-hand — so these endpoints only ever store
  // supervisor_id, never a name. A given employee can be changed to a
  // different supervisor, or have one added/removed, at any time.
  app.get("/api/employees/:id/supervisors", authenticateToken, requireAdmin, requireModule("employees"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const rows = await queryDB(
        `SELECT es.id, es.employee_id, es.supervisor_id, es.effective_date, es.is_direct,
                s.name AS supervisor_name, s.employee_id AS supervisor_employee_code
         FROM employee_supervisors es
         JOIN all_employees s ON s.id = es.supervisor_id
         WHERE es.employee_id = ?
         ORDER BY es.effective_date DESC, es.id DESC`,
        [id]
      );
      res.json(rows.map((r: any) => ({
        id: r.id,
        employee_id: r.employee_id,
        supervisor_id: r.supervisor_id,
        supervisor_name: r.supervisor_name,
        supervisor_employee_code: r.supervisor_employee_code || null,
        effective_date: r.effective_date,
        is_direct: !!Number(r.is_direct)
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/employees/:id/supervisors", authenticateToken, requireAdmin, requireModule("employees"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { supervisor_id, effective_date, is_direct } = req.body;
      const supId = Number(supervisor_id);
      if (!supId || !Number.isFinite(supId)) return res.status(400).json({ error: "Please select an employee as the Supervisor." });
      if (supId === id) return res.status(400).json({ error: "An employee cannot be their own supervisor." });

      const employeeExists = await queryDB("SELECT id FROM all_employees WHERE id = ?", [id]);
      if (employeeExists.length === 0) return res.status(404).json({ error: "Employee not found" });
      const supExists = await queryDB("SELECT id FROM all_employees WHERE id = ?", [supId]);
      if (supExists.length === 0) return res.status(400).json({ error: "Selected supervisor was not found in the Employee list." });

      const result = await queryDB(
        "INSERT INTO employee_supervisors (employee_id, supervisor_id, effective_date, is_direct) VALUES (?, ?, ?, ?)",
        [id, supId, effective_date && String(effective_date).trim() ? String(effective_date).trim() : null, is_direct ? 1 : 0]
      );
      res.status(201).json({ id: result.insertId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/employees/:id/supervisors/:supervisorRowId", authenticateToken, requireAdmin, requireModule("employees"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const rowId = Number(req.params.supervisorRowId);
      const { supervisor_id, effective_date, is_direct } = req.body;
      const supId = Number(supervisor_id);
      if (!supId || !Number.isFinite(supId)) return res.status(400).json({ error: "Please select an employee as the Supervisor." });
      if (supId === id) return res.status(400).json({ error: "An employee cannot be their own supervisor." });

      const existing = await queryDB("SELECT id FROM employee_supervisors WHERE id = ? AND employee_id = ?", [rowId, id]);
      if (existing.length === 0) return res.status(404).json({ error: "Supervisor record not found" });

      await queryDB(
        "UPDATE employee_supervisors SET supervisor_id = ?, effective_date = ?, is_direct = ? WHERE id = ?",
        [supId, effective_date && String(effective_date).trim() ? String(effective_date).trim() : null, is_direct ? 1 : 0, rowId]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/employees/:id/supervisors/:supervisorRowId", authenticateToken, requireAdmin, requireModule("employees"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const rowId = Number(req.params.supervisorRowId);
      const existing = await queryDB("SELECT id FROM employee_supervisors WHERE id = ? AND employee_id = ?", [rowId, id]);
      if (existing.length === 0) return res.status(404).json({ error: "Supervisor record not found" });
      await queryDB("DELETE FROM employee_supervisors WHERE id = ?", [rowId]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // Payment Accounts (Admin Panel -> Employees -> Edit -> Payment tab) — an
  // Employee's Net Salary payroll disbursement split across any number of
  // Bank/MFS accounts, each carrying a percentage. Read by Run Payroll's
  // Preview & Calculate + Submit steps (PayrollRoutes.ts) to build each
  // employee's payment_split; a payroll row's own split is a SNAPSHOT taken
  // at generation time (payroll_payment_splits), so editing an employee's
  // accounts here never rewrites a past, already-generated payroll.
  // ==========================================================================
  app.get("/api/employees/:id/payment-accounts", authenticateToken, requireAdmin, requireModule("employees"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const rows = await queryDB(
        "SELECT * FROM employee_payment_accounts WHERE employee_id = ? ORDER BY sort_order ASC, id ASC",
        [id]
      );
      res.json(
        rows.map((r: any) => ({
          id: r.id,
          employee_id: r.employee_id,
          account_type: r.account_type,
          account_label: r.account_label,
          bank_name: r.bank_name,
          branch_name: r.branch_name,
          provider: r.provider,
          account_number: r.account_number,
          percentage: Number(r.percentage),
          is_active: !!Number(r.is_active),
          sort_order: Number(r.sort_order)
        }))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Shared validation for POST/PUT below — throws with a message safe to
  // send straight back to the client.
  function validatePaymentAccountBody(body: any) {
    const accountType = body?.account_type === "mfs" ? "mfs" : "bank";
    const accountLabel = typeof body?.account_label === "string" ? body.account_label.trim().slice(0, 100) : "";
    if (!accountLabel) throw new Error(accountType === "mfs" ? "Give this MFS account a label (e.g. bKash 1)." : "Give this Bank account a label (e.g. Bank 1).");
    const accountNumber = typeof body?.account_number === "string" ? body.account_number.trim().slice(0, 100) : "";
    if (!accountNumber) throw new Error(accountType === "mfs" ? "Mobile/Wallet number is required." : "Account number is required.");
    const percentage = Number(body?.percentage);
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) throw new Error("Percentage must be greater than 0 and at most 100.");
    return {
      accountType,
      accountLabel,
      bankName: accountType === "bank" && typeof body?.bank_name === "string" ? body.bank_name.trim().slice(0, 150) || null : null,
      branchName: accountType === "bank" && typeof body?.branch_name === "string" ? body.branch_name.trim().slice(0, 150) || null : null,
      provider: accountType === "mfs" && typeof body?.provider === "string" ? body.provider.trim().slice(0, 50) || null : null,
      accountNumber,
      percentage: Math.round(percentage * 100) / 100
    };
  }

  app.post("/api/employees/:id/payment-accounts", authenticateToken, requireAdmin, requireModule("employees"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const employeeExists = await queryDB("SELECT id FROM all_employees WHERE id = ?", [id]);
      if (employeeExists.length === 0) return res.status(404).json({ error: "Employee not found" });

      const v = validatePaymentAccountBody(req.body);
      const existingActive = await queryDB("SELECT percentage FROM employee_payment_accounts WHERE employee_id = ? AND is_active = 1", [id]);
      const currentTotal = existingActive.reduce((sum: number, r: any) => sum + Number(r.percentage), 0);
      if (currentTotal + v.percentage > 100.001) {
        return res.status(400).json({ error: `Total percentage across this employee's active accounts would be ${(currentTotal + v.percentage).toFixed(2)}% — it can't exceed 100%.` });
      }

      const result = await queryDB(
        `INSERT INTO employee_payment_accounts
           (employee_id, account_type, account_label, bank_name, branch_name, provider, account_number, percentage, is_active, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [id, v.accountType, v.accountLabel, v.bankName, v.branchName, v.provider, v.accountNumber, v.percentage, existingActive.length]
      );
      res.status(201).json({ id: result.insertId });
    } catch (err: any) {
      res.status(err.message?.includes("required") || err.message?.includes("Percentage") || err.message?.includes("label") ? 400 : 500).json({ error: err.message });
    }
  });

  app.put("/api/employees/:id/payment-accounts/:rowId", authenticateToken, requireAdmin, requireModule("employees"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const rowId = Number(req.params.rowId);
      const existing = await queryDB("SELECT * FROM employee_payment_accounts WHERE id = ? AND employee_id = ?", [rowId, id]);
      if (existing.length === 0) return res.status(404).json({ error: "Payment account not found" });

      const v = validatePaymentAccountBody(req.body);
      const isActive = req.body?.is_active === false ? false : true;
      if (isActive) {
        const otherActive = await queryDB("SELECT id, percentage FROM employee_payment_accounts WHERE employee_id = ? AND is_active = 1 AND id <> ?", [id, rowId]);
        const otherTotal = otherActive.reduce((sum: number, r: any) => sum + Number(r.percentage), 0);
        if (otherTotal + v.percentage > 100.001) {
          return res.status(400).json({ error: `Total percentage across this employee's active accounts would be ${(otherTotal + v.percentage).toFixed(2)}% — it can't exceed 100%.` });
        }
      }

      await queryDB(
        `UPDATE employee_payment_accounts
         SET account_type = ?, account_label = ?, bank_name = ?, branch_name = ?, provider = ?, account_number = ?, percentage = ?, is_active = ?
         WHERE id = ?`,
        [v.accountType, v.accountLabel, v.bankName, v.branchName, v.provider, v.accountNumber, v.percentage, isActive ? 1 : 0, rowId]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(err.message?.includes("required") || err.message?.includes("Percentage") || err.message?.includes("label") ? 400 : 500).json({ error: err.message });
    }
  });

  app.delete("/api/employees/:id/payment-accounts/:rowId", authenticateToken, requireAdmin, requireModule("employees"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const rowId = Number(req.params.rowId);
      const existing = await queryDB("SELECT id FROM employee_payment_accounts WHERE id = ? AND employee_id = ?", [rowId, id]);
      if (existing.length === 0) return res.status(404).json({ error: "Payment account not found" });
      await queryDB("DELETE FROM employee_payment_accounts WHERE id = ?", [rowId]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Gives an ALREADY-EXISTING Employee Directory row a login account after the
  // fact — same validation/insert logic POST /api/employees' create_login
  // branch uses, just for a row that was added before this feature existed (or
  // added without the checkbox ticked at the time). No-ops with a 400 if this
  // employee already has one (all_employees.user_id already set).
  //
  // login_project_ids/login_module_keys — same optional Project Access /
  // Module Access grant POST /api/employees' create_login branch supports; see
  // the comment there. Module grants stay Superadmin-only.
  app.post("/api/employees/:id/create-login", authenticateToken, requireAdmin, requireModule("employees"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await queryDB("SELECT * FROM all_employees WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Employee not found" });
      const employee = existing[0];
      if (employee.user_id) return res.status(400).json({ error: "This employee already has a login account." });

      const { login_email, login_username, login_password, login_project_ids, login_module_keys } = req.body;
      const loginEmail = (login_email && String(login_email).trim()) || (employee.email && String(employee.email).trim()) || null;
      const loginUsername = login_username && String(login_username).trim() ? String(login_username).trim() : null;
      if (!loginEmail && !loginUsername) {
        return res.status(400).json({ error: "A login email or username is required to create a login for this employee." });
      }
      if (!login_password || String(login_password).length < 6) {
        return res.status(400).json({ error: "Login password must be at least 6 characters." });
      }
      if (loginEmail) {
        const existingEmail = await queryDB("SELECT id FROM users WHERE email = ?", [loginEmail]);
        if (existingEmail.length > 0) return res.status(400).json({ error: "That login email is already registered." });
      }
      if (loginUsername) {
        const existingUsername = await queryDB("SELECT id FROM users WHERE username = ?", [loginUsername]);
        if (existingUsername.length > 0) return res.status(400).json({ error: "That username is already taken." });
      }

      const password_hash = await bcrypt.hash(String(login_password), 10);
      const userResult = await queryDB(
        "INSERT INTO users (name, email, username, password_hash, role) VALUES (?, ?, ?, ?, 'user')",
        [employee.name, loginEmail, loginUsername, password_hash]
      );
      const newUserId = userResult.insertId;
      await queryDB("UPDATE all_employees SET user_id = ? WHERE id = ?", [newUserId, id]);

      let grantedProjectIds: number[] = [];
      if (Array.isArray(login_project_ids)) {
        grantedProjectIds = Array.from(new Set(login_project_ids.map((pid: any) => Number(pid)).filter((pid: number) => Number.isFinite(pid))));
        for (const pid of grantedProjectIds) {
          await queryDB("INSERT INTO user_project_permissions (user_id, project_id) VALUES (?, ?)", [newUserId, pid]);
        }
      }

      let grantedModuleKeys: string[] = [];
      if (req.user.role === "superadmin" && Array.isArray(login_module_keys)) {
        grantedModuleKeys = login_module_keys.filter((m: any) => (ADMIN_MODULE_KEYS as readonly string[]).includes(m));
        for (const moduleKey of grantedModuleKeys) {
          await queryDB("INSERT INTO admin_module_permissions (user_id, module_key, company_id) VALUES (?, ?, ?)", [newUserId, moduleKey, activeCompanyId()]);
        }
      }

      res.status(201).json({ success: true, user_id: newUserId, project_ids: grantedProjectIds, module_keys: grantedModuleKeys });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Links an EXISTING login account to an existing Employee row — the reverse
  // situation from create-login above: the User was created first (or on its
  // own) and the matching Employee directory entry only got added afterward,
  // so the two ended up as separate, unlinked records. Sets all_employees.
  // user_id directly instead of inserting a new users row. One user can only
  // ever be linked to one Employee row, same as create-login's own 1:1
  // assumption.
  app.put("/api/employees/:id/link-user", authenticateToken, requireAdmin, requireModule("employees"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await queryDB("SELECT * FROM all_employees WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Employee not found" });
      if (existing[0].user_id) return res.status(400).json({ error: "This employee already has a linked login account." });

      const userId = Number(req.body?.user_id);
      if (!Number.isFinite(userId)) return res.status(400).json({ error: "Select a user account to link." });

      const userRows: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [userId]);
      if (userRows.length === 0) return res.status(404).json({ error: "User not found" });
      // A plain Admin must never be able to link the Superadmin's own account,
      // even by guessing its id directly — same rule as every other per-user
      // Admin action.
      if (userRows[0].role === "superadmin" && req.user.role !== "superadmin") {
        return res.status(404).json({ error: "User not found" });
      }

      const alreadyLinked: any = await queryDB("SELECT id FROM all_employees WHERE user_id = ?", [userId]);
      if (alreadyLinked.length > 0) {
        return res.status(400).json({ error: "This user account is already linked to another employee." });
      }

      await queryDB("UPDATE all_employees SET user_id = ? WHERE id = ?", [userId, id]);
      res.json({ success: true, user_id: userId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Undoes a link (either from create-login or link-user above) — in case the
  // wrong account got attached. The Employee row goes back to having no
  // user_id; the users row itself is left untouched either way.
  app.delete("/api/employees/:id/link-user", authenticateToken, requireAdmin, requireModule("employees"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await queryDB("SELECT * FROM all_employees WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Employee not found" });
      if (!existing[0].user_id) return res.status(400).json({ error: "This employee has no linked login account." });

      await queryDB("UPDATE all_employees SET user_id = NULL WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
