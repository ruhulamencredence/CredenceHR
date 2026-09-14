/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// User Management (Admin Panel -> Users) routes, split out of server.ts on
// purpose — same convention as profileRoutes.ts/holidayRoutes.ts/Alerts.ts:
// server.ts is already huge, so this module goes in its own file instead of
// growing it further. Registered from inside startServer() via
// registerUserManagementRoutes(), reusing that same request's
// `app`/`authenticateToken`/`requireAdmin`/`requireSuperAdmin`/
// `requireModule`/`queryDB` rather than creating a second Express app or a
// second DB connection.
//
// Extracted as-is from server.ts's "6. User Management (Admin Only)" and
// "6. User <-> Project Permissions (Admin-only)" sections — no logic
// changed, only moved.

import type { Express } from "express";
import bcrypt from "bcryptjs";

interface UserManagementRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireSuperAdmin: any;
  // Same requireModule(moduleKey) factory used by every other Admin Panel
  // module in server.ts — pass "users" through it here so a Superadmin can
  // grant/revoke the Users module's access independently of every other
  // module.
  requireModule: (moduleKey: "users") => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  // Valid module keys for the module-permissions PUT below — same
  // ADMIN_MODULE_KEYS array defined once in server.ts.
  adminModuleKeys: readonly string[];
}

export function registerUserManagementRoutes(app: Express, deps: UserManagementRouteDeps) {
  const { authenticateToken, requireAdmin, requireSuperAdmin, requireModule, queryDB, adminModuleKeys } = deps;

  // 6. User Management (Admin Only)
  app.post("/api/users", authenticateToken, requireAdmin, requireModule("users"), async (req: any, res) => {
    try {
      const { name, email, password, role } = req.body;
      if (!name || !email || !password) {
        return res.status(400).json({ error: "Name, email and password are required" });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters" });
      }

      const existing = await queryDB("SELECT id FROM users WHERE email = ?", [email]);
      if (existing.length > 0) {
        return res.status(400).json({ error: "Email already registered" });
      }

      // Only a Superadmin may hand out the Admin role. A plain Admin creating a new
      // account (even if they asked for role: "admin") always gets a regular User —
      // deciding who becomes an Admin is a Superadmin-only power.
      const userRole = role === "admin" && req.user.role === "superadmin" ? "admin" : "user";
      const password_hash = await bcrypt.hash(password, 10);

      const result = await queryDB(
        "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)",
        [name, email, password_hash, userRole]
      );

      res.json({ success: true, id: result.insertId, name, email, role: userRole });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to create user" });
    }
  });

  // Superadmin/Admin resets a user's password when they've forgotten it — no old
  // password needed, unlike a normal self-service "change password" flow (this
  // app doesn't have one; a forgotten password is always solved by an Admin from
  // here). Same "can't touch the Superadmin's own account" rule as every other
  // per-user Admin action.
  app.put("/api/users/:id/reset-password", authenticateToken, requireAdmin, requireModule("users"), async (req: any, res) => {
    try {
      const { id } = req.params;
      const { new_password } = req.body;
      if (!new_password || String(new_password).length < 6) {
        return res.status(400).json({ error: "New password must be at least 6 characters." });
      }

      const rows: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "User not found" });
      // A plain Admin must never be able to reach the Superadmin's account, even by
      // guessing its id directly — the Users list already hides it from them.
      if (rows[0].role === "superadmin" && req.user.role !== "superadmin") {
        return res.status(404).json({ error: "User not found" });
      }

      const password_hash = await bcrypt.hash(String(new_password), 10);
      await queryDB("UPDATE users SET password_hash = ? WHERE id = ?", [password_hash, id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to reset password" });
    }
  });

  // Superadmin/Admin changes a user's Login ID (the email address they log in
  // with) — same idea as reset-password above: the Admin sets it directly, no
  // confirmation email or old-value check needed. Same "can't touch the
  // Superadmin's own account" rule as every other per-user Admin action.
  app.put("/api/users/:id/email", authenticateToken, requireAdmin, requireModule("users"), async (req: any, res) => {
    try {
      const { id } = req.params;
      const new_email = String(req.body.new_email || "").trim();
      if (!new_email) {
        return res.status(400).json({ error: "New Login ID (email) is required." });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(new_email)) {
        return res.status(400).json({ error: "Enter a valid email address." });
      }

      const rows: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "User not found" });
      // A plain Admin must never be able to reach the Superadmin's account, even by
      // guessing its id directly — the Users list already hides it from them.
      if (rows[0].role === "superadmin" && req.user.role !== "superadmin") {
        return res.status(404).json({ error: "User not found" });
      }

      const dup: any = await queryDB("SELECT id FROM users WHERE email = ? AND id != ?", [new_email, id]);
      if (dup.length > 0) {
        return res.status(400).json({ error: "Email already registered" });
      }

      await queryDB("UPDATE users SET email = ? WHERE id = ?", [new_email, id]);
      res.json({ success: true, email: new_email });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to update Login ID" });
    }
  });

  app.get("/api/users", authenticateToken, requireAdmin, requireModule("users"), async (req: any, res) => {
    try {
      const users = await queryDB(
        "SELECT id, name, email, username, role, created_at, last_login_lat, last_login_lng, last_login_at, can_edit_delivery_date, can_job_edit, can_use_attendance, can_view_login_location, can_access_user_panel, can_manage_leave, can_view_movement_claims, can_view_conveyance_claims, can_use_tracking, can_view_budget_module, can_view_leave_summary, can_view_timesheet, can_view_leave_application, can_view_my_leave, attendance_project_id FROM users ORDER BY created_at DESC"
      );
      // Attach each Admin's module_permissions so the Superadmin's "Module Access"
      // UI has them without a separate round trip per row. Only role='admin' rows
      // carry a real (possibly empty) list — a Superadmin implicitly has every
      // module and a plain User never opens the Admin Panel, so both get [].
      const modulePermRows: any = await queryDB("SELECT user_id, module_key FROM admin_module_permissions");
      const modulesByUser = new Map<number, string[]>();
      for (const row of modulePermRows) {
        const list = modulesByUser.get(row.user_id) || [];
        list.push(row.module_key);
        modulesByUser.set(row.user_id, list);
      }

      // Last Login Location is sensitive (it's a precise coordinate, not just a
      // name) — only a Superadmin sees it by default. A plain Admin only sees it
      // if the Superadmin has explicitly switched on can_view_login_location for
      // THEIR OWN account. Enforced here server-side (not just hidden in the UI)
      // so a direct API call can't bypass it either.
      const requester = users.find((u: any) => u.id === req.user.id);
      const canSeeLocation =
        req.user.role === "superadmin" || (!!requester && !!Number(requester.can_view_login_location));

      // A plain Admin must never see the Superadmin's account in the Users list —
      // not even a read-only row. Enforced here server-side (not just hidden in the
      // UI) so a direct API call can't expose it either. Only the Superadmin itself
      // sees its own row.
      const visibleUsers = req.user.role === "superadmin"
        ? users
        : users.filter((u: any) => u.role !== "superadmin");

      res.json(visibleUsers.map((u: any) => ({
        ...u,
        last_login_lat: canSeeLocation ? u.last_login_lat : undefined,
        last_login_lng: canSeeLocation ? u.last_login_lng : undefined,
        last_login_at: canSeeLocation ? u.last_login_at : undefined,
        can_edit_delivery_date: u.can_edit_delivery_date === undefined ? true : !!Number(u.can_edit_delivery_date),
        can_job_edit: !!Number(u.can_job_edit),
        can_use_attendance: u.role === "superadmin" ? true : !!Number(u.can_use_attendance),
        // Pinned Project for Remote Attendance (Admin Panel -> Users -> "Attend.
        // Project", right next to can_use_attendance) — null means unrestricted.
        // Never set for 'superadmin'.
        attendance_project_id: u.role === "superadmin" ? null : (u.attendance_project_id ?? null),
        can_use_tracking: u.role === "superadmin" ? true : !!Number(u.can_use_tracking),
        can_view_login_location: u.role === "superadmin" ? true : !!Number(u.can_view_login_location),
        can_access_user_panel: u.role === "admin" ? !!Number(u.can_access_user_panel) : false,
        can_manage_leave: u.role === "superadmin" ? true : !!Number(u.can_manage_leave),
        can_view_movement_claims: u.role === "superadmin" ? true : !!Number(u.can_view_movement_claims),
        can_view_conveyance_claims: u.role === "superadmin" ? true : !!Number(u.can_view_conveyance_claims),
        can_view_budget_module: u.role === "superadmin" ? true : u.can_view_budget_module === undefined ? true : !!Number(u.can_view_budget_module),
        can_view_leave_summary: u.role === "superadmin" ? true : !!Number(u.can_view_leave_summary),
        can_view_timesheet: u.role === "superadmin" ? true : !!Number(u.can_view_timesheet),
        can_view_leave_application: u.role === "superadmin" ? true : !!Number(u.can_view_leave_application),
        can_view_my_leave: u.role === "superadmin" ? true : !!Number(u.can_view_my_leave),
        module_permissions: (u.role === "admin" || u.role === "user") ? (modulesByUser.get(u.id) || []) : []
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bulk User Import (Admin Panel -> Users -> Bulk Add Users): each row is just
  // { sl, project_name, password }. The Project Name becomes both the account's
  // display Name and its login ID (Project Name with spaces stripped + lowercased,
  // stored in users.username) — these users log in with Project Name + Password,
  // no email. Rules enforced per row, same order as given:
  //  - Project Name and Password are required.
  //  - Password must be exactly 6 characters.
  //  - A row is skipped (not imported) if its Project Name (login ID) is already
  //    taken by an existing user OR an earlier row in this same import.
  //  - A row is skipped if its Password matches any OTHER account's password —
  //    either an existing user's (checked via bcrypt against the stored hash,
  //    since passwords are never stored in plain text) or an earlier row in this
  //    same import. This is a deliberate business rule: no two accounts may share
  //    a password, even though the login ID would still disambiguate them.
  // Every row is reported back as either created or skipped (with a reason) so the
  // Admin can see exactly what happened without guessing from a single count.
  app.post("/api/users/bulk", authenticateToken, requireAdmin, requireModule("users"), async (req, res) => {
    try {
      const rows = req.body?.rows;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: "No rows to import" });
      }

      const existingUsers = await queryDB("SELECT username, password_hash FROM users");
      const existingUsernames = new Set(
        existingUsers.map((u: any) => (u.username || "").toLowerCase()).filter(Boolean)
      );
      // Grows as rows are created, so later rows in the same batch are also checked
      // against passwords created earlier in this same batch (not just pre-existing ones).
      const hashesToCheck: string[] = existingUsers.map((u: any) => u.password_hash).filter(Boolean);
      const usedPasswordsInBatch = new Set<string>();

      const created: any[] = [];
      const skipped: any[] = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] || {};
        const sl = row.sl ?? i + 1;
        const projectName = String(row.project_name ?? "").trim();
        const password = String(row.password ?? "");

        if (!projectName || !password) {
          skipped.push({ sl, project_name: projectName, reason: "Project Name and Password are required" });
          continue;
        }
        if (password.length !== 6) {
          skipped.push({ sl, project_name: projectName, reason: "Password must be exactly 6 characters" });
          continue;
        }

        const username = projectName.replace(/\s+/g, "").toLowerCase();
        if (existingUsernames.has(username)) {
          skipped.push({ sl, project_name: projectName, reason: "A user for this Project Name already exists" });
          continue;
        }

        if (usedPasswordsInBatch.has(password)) {
          skipped.push({ sl, project_name: projectName, reason: "Duplicate password (already used earlier in this import)" });
          continue;
        }
        let passwordReused = false;
        for (const hash of hashesToCheck) {
          if (await bcrypt.compare(password, hash)) {
            passwordReused = true;
            break;
          }
        }
        if (passwordReused) {
          skipped.push({ sl, project_name: projectName, reason: "This password is already used by another account" });
          continue;
        }

        const password_hash = await bcrypt.hash(password, 10);
        const result = await queryDB(
          "INSERT INTO users (name, email, username, password_hash, role) VALUES (?, NULL, ?, ?, 'user')",
          [projectName, username, password_hash]
        );

        existingUsernames.add(username);
        usedPasswordsInBatch.add(password);
        hashesToCheck.push(password_hash);
        created.push({ sl, id: result.insertId, project_name: projectName, username });
      }

      res.json({
        success: true,
        created,
        skipped,
        created_count: created.length,
        skipped_count: skipped.length
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Bulk import failed" });
    }
  });

  // Promote/demote a User <-> Admin. Superadmin-only — deciding who is an Admin and
  // who stays a plain User is the whole point of the Superadmin role, so this is
  // never reachable by a regular Admin even though they can otherwise manage users.
  app.put("/api/users/:id/role", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { role } = req.body;
      if (!["admin", "user"].includes(role)) {
        return res.status(400).json({ error: "Invalid role" });
      }

      const target: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
      if (target.length === 0) return res.status(404).json({ error: "User not found" });
      if (target[0].role === "superadmin") {
        return res.status(400).json({ error: "The Superadmin account's role can't be changed here." });
      }

      await queryDB("UPDATE users SET role = ? WHERE id = ?", [role, id]);
      // Demoting an Admin back to a plain User clears any module grants they had —
      // otherwise they'd silently keep them if a Superadmin later re-promotes them
      // without noticing the stale grants. Same reasoning for the two other
      // Admin-only toggles (Login Location visibility, User Panel access).
      if (role === "user") {
        await queryDB("DELETE FROM admin_module_permissions WHERE user_id = ?", [id]);
        await queryDB("DELETE FROM attendance_report_department_access WHERE user_id = ?", [id]);
        await queryDB("DELETE FROM leave_application_department_access WHERE user_id = ?", [id]);
        await queryDB("UPDATE users SET can_view_login_location = 0, can_access_user_panel = 0 WHERE id = ?", [id]);
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Superadmin sets which Admin Panel modules a given Admin may access — the tabs
  // are: projects, mprs, imports, reports, users, recycle, editlog.
  app.get("/api/users/:id/module-permissions", authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const rows: any = await queryDB("SELECT module_key FROM admin_module_permissions WHERE user_id = ?", [id]);
      res.json({ modules: rows.map((r: any) => r.module_key) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/users/:id/module-permissions", authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const modules: string[] = Array.isArray(req.body?.modules) ? req.body.modules : [];
      const valid = modules.filter((m) => adminModuleKeys.includes(m));

      const target: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
      if (target.length === 0) return res.status(404).json({ error: "User not found" });
      if (target[0].role !== "admin" && target[0].role !== "user") {
        return res.status(400).json({ error: "Module access only applies to Admin and User accounts." });
      }

      await queryDB("DELETE FROM admin_module_permissions WHERE user_id = ?", [id]);
      for (const moduleKey of valid) {
        await queryDB("INSERT INTO admin_module_permissions (user_id, module_key) VALUES (?, ?)", [id, moduleKey]);
      }
      res.json({ success: true, modules: valid });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Superadmin: department-wise scope for the 'attendance_reports' module
  // specifically (Admin Panel -> Users -> Module Access -> "Attendance
  // Report Departments", shown once that module's own checkbox above is
  // ticked). Layered on TOP of module-permissions, not a replacement for it —
  // the account still needs 'attendance_reports' granted there for any of
  // this to matter; see requireModule("attendance_reports") in
  // AttendanceRoutes.ts and getAttendanceReportDeptScope() in server.ts,
  // which every GET /api/attendance/report/* route now calls. No rows for a
  // user means unrestricted — every Department visible, exactly like before
  // this feature existed — so granting the module alone (leaving this unset)
  // keeps today's behavior. Applies equally to role 'admin' and role 'user'
  // accounts, and to accounts that supervise no Department at all — the
  // Department picker in the modal only uses supervisor_user_id client-side
  // to pre-tick a sensible starting selection, it isn't required here.
  app.get("/api/users/:id/attendance-report-departments", authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const rows: any = await queryDB(
        "SELECT department FROM attendance_report_department_access WHERE user_id = ? ORDER BY department ASC",
        [id]
      );
      res.json({ departments: rows.map((r: any) => r.department) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/users/:id/attendance-report-departments", authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const requested: string[] = Array.isArray(req.body?.departments) ? req.body.departments : [];

      const target: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
      if (target.length === 0) return res.status(404).json({ error: "User not found" });
      if (target[0].role !== "admin" && target[0].role !== "user") {
        return res.status(400).json({ error: "Attendance Report Department access only applies to Admin and User accounts." });
      }

      // Only real Department names (Admin Panel -> Departments) can be scoped
      // to — silently drops anything else (a stale/typo'd name) instead of
      // rejecting the whole request, same forgiving convention the
      // module-permissions `valid = modules.filter(...)` above uses.
      const realDepartments: any = await queryDB("SELECT name FROM departments");
      const realNames = new Set(realDepartments.map((d: any) => d.name));
      const valid = Array.from(
        new Set(requested.map((d) => String(d).trim()).filter((d) => d && realNames.has(d)))
      );

      await queryDB("DELETE FROM attendance_report_department_access WHERE user_id = ?", [id]);
      for (const department of valid) {
        await queryDB("INSERT INTO attendance_report_department_access (user_id, department) VALUES (?, ?)", [id, department]);
      }
      res.json({ success: true, departments: valid });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Superadmin: department-wise scope for the 'leave_applications' module —
  // exact same shape/rules as the 'attendance_report_departments' pair above,
  // just backed by leave_application_department_access instead (Admin Panel
  // -> Users -> Module Access -> "Leave Application Departments", shown once
  // 'leave_applications' is ticked). No rows for a user means unrestricted —
  // every Department's Leave Applications visible, exactly like granting the
  // module alone. Applies equally to role 'admin' and role 'user' accounts,
  // and to accounts that supervise no Department at all — the Department
  // picker in the modal only uses supervisor_user_id client-side to pre-tick
  // a sensible starting selection, it isn't required here.
  app.get("/api/users/:id/leave-application-departments", authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const rows: any = await queryDB(
        "SELECT department FROM leave_application_department_access WHERE user_id = ? ORDER BY department ASC",
        [id]
      );
      res.json({ departments: rows.map((r: any) => r.department) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/users/:id/leave-application-departments", authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const requested: string[] = Array.isArray(req.body?.departments) ? req.body.departments : [];

      const target: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
      if (target.length === 0) return res.status(404).json({ error: "User not found" });
      if (target[0].role !== "admin" && target[0].role !== "user") {
        return res.status(400).json({ error: "Leave Application Department access only applies to Admin and User accounts." });
      }

      // Only real Department names (Admin Panel -> Departments) can be scoped
      // to — same forgiving convention as attendance-report-departments above.
      const realDepartments: any = await queryDB("SELECT name FROM departments");
      const realNames = new Set(realDepartments.map((d: any) => d.name));
      const valid = Array.from(
        new Set(requested.map((d) => String(d).trim()).filter((d) => d && realNames.has(d)))
      );

      await queryDB("DELETE FROM leave_application_department_access WHERE user_id = ?", [id]);
      for (const department of valid) {
        await queryDB("INSERT INTO leave_application_department_access (user_id, department) VALUES (?, ?)", [id, department]);
      }
      res.json({ success: true, departments: valid });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Superadmin-only: grant/revoke a given Admin's ability to see OTHER users' Last
  // Login Location (the exact GPS coordinates captured at login) in Admin Panel ->
  // Users. OFF by default for every Admin — a Superadmin always sees it and this
  // never needs to be (and can't be) granted to a plain 'user' account.
  app.put("/api/users/:id/login-location-access", authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const canView = !!req.body?.can_view_login_location;

      const target: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
      if (target.length === 0) return res.status(404).json({ error: "User not found" });
      if (target[0].role !== "admin") {
        return res.status(400).json({ error: "Login Location access only applies to Admin accounts." });
      }

      await queryDB("UPDATE users SET can_view_login_location = ? WHERE id = ?", [canView ? 1 : 0, id]);
      res.json({ success: true, can_view_login_location: canView });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Superadmin-only: grant/revoke a given Admin's ability to ALSO use the User
  // Panel (mark Remote Attendance, submit Claims/Conveyance Bills, enter Job/MPR
  // data) alongside their normal Admin Panel — the same on/off switch pattern as
  // login-location-access above. OFF by default for every Admin; never applies to
  // a plain User (already has it by definition) or to a Superadmin.
  app.put("/api/users/:id/user-panel-access", authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const canAccess = !!req.body?.can_access_user_panel;

      const target: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
      if (target.length === 0) return res.status(404).json({ error: "User not found" });
      if (target[0].role !== "admin") {
        return res.status(400).json({ error: "User Panel access only applies to Admin accounts." });
      }

      await queryDB("UPDATE users SET can_access_user_panel = ? WHERE id = ?", [canAccess ? 1 : 0, id]);
      res.json({ success: true, can_access_user_panel: canAccess });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Superadmin-only: grant/revoke a given Admin OR User account's ability to edit
  // OTHER accounts' Leave balances on Self Service -> Leave Management (see
  // GET/PUT /api/leave-balances below) — same on/off switch pattern as
  // user-panel-access above, but (unlike that one) applies to BOTH roles since
  // Leave Management isn't Admin Panel-only. Never applies to the Superadmin
  // itself, which always has this implicitly.
  app.put("/api/users/:id/leave-management-access", authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const canManage = !!req.body?.can_manage_leave;

      const target: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
      if (target.length === 0) return res.status(404).json({ error: "User not found" });
      if (target[0].role !== "admin" && target[0].role !== "user") {
        return res.status(400).json({ error: "Leave Management access only applies to Admin and User accounts." });
      }

      await queryDB("UPDATE users SET can_manage_leave = ? WHERE id = ?", [canManage ? 1 : 0, id]);
      res.json({ success: true, can_manage_leave: canManage });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Superadmin-only: grant/revoke a given Admin OR User account's ability to
  // see/use the Movement Claim (GPS Check In/Out) section on their own User
  // Panel at all — same on/off switch pattern as leave-management-access above,
  // applying to BOTH roles. Nothing shows (and the underlying /api/claims/*
  // self-service routes are blocked server-side too — see requireMovementClaimAccess)
  // until the Superadmin explicitly grants it, matching every other module in
  // this app. Never applies to the Superadmin itself, which always has this
  // implicitly.
  app.put("/api/users/:id/movement-claim-access", authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const canView = !!req.body?.can_view_movement_claims;

      const target: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
      if (target.length === 0) return res.status(404).json({ error: "User not found" });
      if (target[0].role !== "admin" && target[0].role !== "user") {
        return res.status(400).json({ error: "Movement Claim access only applies to Admin and User accounts." });
      }

      await queryDB("UPDATE users SET can_view_movement_claims = ? WHERE id = ?", [canView ? 1 : 0, id]);
      res.json({ success: true, can_view_movement_claims: canView });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Superadmin-only: grant/revoke a given Admin OR User account's ability to
  // see/use the Conveyance Bill Claim section on their own User Panel at all —
  // same on/off switch pattern as movement-claim-access above.
  app.put("/api/users/:id/conveyance-claim-access", authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const canView = !!req.body?.can_view_conveyance_claims;

      const target: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
      if (target.length === 0) return res.status(404).json({ error: "User not found" });
      if (target[0].role !== "admin" && target[0].role !== "user") {
        return res.status(400).json({ error: "Conveyance Bill Claim access only applies to Admin and User accounts." });
      }

      await queryDB("UPDATE users SET can_view_conveyance_claims = ? WHERE id = ?", [canView ? 1 : 0, id]);
      res.json({ success: true, can_view_conveyance_claims: canView });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Superadmin-only: grant/revoke a given Admin OR User account's ability to
  // see/use the core Budget/Jobs/Job Entry Details workflow ("Select a
  // Budget", "Jobs", "Job Entry Details" — mobile tiles, BottomNav tabs, and
  // the Navbar/GlobalSidebar "Jobs" menu's Entry/Jobs/Entry Details items) on
  // their own User Panel at all — same on/off switch pattern as
  // movement-claim-access above, except ON by default (see the ALTER TABLE),
  // so this only ever needs to be called to turn it OFF for a given account.
  app.put("/api/users/:id/budget-module-access", authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const canView = !!req.body?.can_view_budget_module;

      const target: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
      if (target.length === 0) return res.status(404).json({ error: "User not found" });
      if (target[0].role !== "admin" && target[0].role !== "user") {
        return res.status(400).json({ error: "Budget/Jobs access only applies to Admin and User accounts." });
      }

      await queryDB("UPDATE users SET can_view_budget_module = ? WHERE id = ?", [canView ? 1 : 0, id]);
      res.json({ success: true, can_view_budget_module: canView });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Superadmin-only: grant/revoke a given Admin OR User account's ability to
  // see/use Self Service -> Timesheet at all — same on/off switch pattern as
  // movement-claim-access above.
  app.put("/api/users/:id/timesheet-access", authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const canView = !!req.body?.can_view_timesheet;

      const target: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
      if (target.length === 0) return res.status(404).json({ error: "User not found" });
      if (target[0].role !== "admin" && target[0].role !== "user") {
        return res.status(400).json({ error: "Timesheet access only applies to Admin and User accounts." });
      }

      await queryDB("UPDATE users SET can_view_timesheet = ? WHERE id = ?", [canView ? 1 : 0, id]);
      res.json({ success: true, can_view_timesheet: canView });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Superadmin-only: grant/revoke a given Admin OR User account's ability to
  // see/use Self Service -> Leave Application at all — same on/off switch
  // pattern as movement-claim-access above.
  app.put("/api/users/:id/leave-application-access", authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const canView = !!req.body?.can_view_leave_application;

      const target: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
      if (target.length === 0) return res.status(404).json({ error: "User not found" });
      if (target[0].role !== "admin" && target[0].role !== "user") {
        return res.status(400).json({ error: "Leave Application access only applies to Admin and User accounts." });
      }

      await queryDB("UPDATE users SET can_view_leave_application = ? WHERE id = ?", [canView ? 1 : 0, id]);
      res.json({ success: true, can_view_leave_application: canView });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Superadmin-only: grant/revoke a given Admin OR User account's ability to
  // see/use Self Service -> My Leave at all — same on/off switch pattern as
  // movement-claim-access above.
  app.put("/api/users/:id/my-leave-access", authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const canView = !!req.body?.can_view_my_leave;

      const target: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
      if (target.length === 0) return res.status(404).json({ error: "User not found" });
      if (target[0].role !== "admin" && target[0].role !== "user") {
        return res.status(400).json({ error: "My Leave access only applies to Admin and User accounts." });
      }

      await queryDB("UPDATE users SET can_view_my_leave = ? WHERE id = ?", [canView ? 1 : 0, id]);
      res.json({ success: true, can_view_my_leave: canView });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Toggle the per-user feature permissions (Admin-only):
  //  - can_edit_delivery_date: lets the user edit an entry's Delivery Date after it's
  //    been submitted, AND (unlike can_job_edit) even after the whole Budget is Final
  //    Submitted. Every other field stays locked either way. ON by default for everyone.
  //  - can_job_edit: unlocks the "Job Edit" section on the User Page — without it a
  //    user can't add, edit or delete any MPR inside a Job whose Budget has already
  //    been Final Submitted. OFF by default; the Admin must switch it on per user.
  //  - can_use_attendance: shows the Remote Attendance Check In/Out card on the
  //    User's own Dashboard at all. OFF by default; the Admin must switch it on
  //    per user. Separate from the "attendance" Admin Panel module (reviewing
  //    everyone else's records).
  //  - can_view_leave_summary: shows the Leave Summary card on the User's own
  //    Dashboard at all. OFF by default; the Admin must switch it on per user.
  //    Same toggle pattern as can_use_attendance above.
  //  - attendance_project_id: pins this 'user' OR 'admin' account to exactly one
  //    Project for Remote Attendance — send a Project id to set it, or null to
  //    clear it back to unrestricted. Ignored for a 'superadmin' target (never
  //    pinned). Completely separate from user_project_permissions (the "Projects"
  //    column/Manage Projects modal), which only ever governs the Budget/Jobs/MPR
  //    workflow, not Attendance.
  // Any field can be sent alone; the others keep their current value.
  app.put("/api/users/:id/feature-permissions", authenticateToken, requireAdmin, requireModule("users"), async (req, res) => {
    try {
      const { id } = req.params;
      const existingRows = await queryDB(
        "SELECT role, can_edit_delivery_date, can_job_edit, can_use_attendance, can_use_tracking, can_view_leave_summary, attendance_project_id FROM users WHERE id = ?",
        [id]
      );
      if (existingRows.length === 0) return res.status(404).json({ error: "User not found" });
      // A plain Admin must never be able to reach the Superadmin's account, even by
      // guessing its id directly — the Users list already hides it from them.
      if (existingRows[0].role === "superadmin" && req.user.role !== "superadmin") {
        return res.status(404).json({ error: "User not found" });
      }
      const current = existingRows[0];
      const can_edit_delivery_date =
        req.body.can_edit_delivery_date !== undefined
          ? (req.body.can_edit_delivery_date ? 1 : 0)
          : (current.can_edit_delivery_date ? 1 : 0);
      const can_job_edit =
        req.body.can_job_edit !== undefined
          ? (req.body.can_job_edit ? 1 : 0)
          : (current.can_job_edit ? 1 : 0);
      const can_use_attendance =
        req.body.can_use_attendance !== undefined
          ? (req.body.can_use_attendance ? 1 : 0)
          : (current.can_use_attendance ? 1 : 0);
      const can_use_tracking =
        req.body.can_use_tracking !== undefined
          ? (req.body.can_use_tracking ? 1 : 0)
          : (current.can_use_tracking ? 1 : 0);
      const can_view_leave_summary =
        req.body.can_view_leave_summary !== undefined
          ? (req.body.can_view_leave_summary ? 1 : 0)
          : (current.can_view_leave_summary ? 1 : 0);
      // Never lets a 'superadmin' target end up pinned, no matter what's sent.
      let attendance_project_id: number | null =
        current.attendance_project_id != null ? Number(current.attendance_project_id) : null;
      if (existingRows[0].role !== "superadmin" && req.body.attendance_project_id !== undefined) {
        attendance_project_id =
          req.body.attendance_project_id === null || req.body.attendance_project_id === ""
            ? null
            : Number(req.body.attendance_project_id);
        if (attendance_project_id !== null && !Number.isFinite(attendance_project_id)) {
          return res.status(400).json({ error: "Invalid attendance_project_id" });
        }
      }
      await queryDB(
        "UPDATE users SET can_edit_delivery_date = ?, can_job_edit = ?, can_use_attendance = ?, can_use_tracking = ?, can_view_leave_summary = ?, attendance_project_id = ? WHERE id = ?",
        [can_edit_delivery_date, can_job_edit, can_use_attendance, can_use_tracking, can_view_leave_summary, attendance_project_id, id]
      );
      res.json({
        success: true,
        can_edit_delivery_date: !!can_edit_delivery_date,
        can_job_edit: !!can_job_edit,
        can_use_attendance: !!can_use_attendance,
        can_use_tracking: !!can_use_tracking,
        can_view_leave_summary: !!can_view_leave_summary,
        attendance_project_id
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/users/:id", authenticateToken, requireAdmin, requireModule("users"), async (req: any, res) => {
    try {
      const { id } = req.params;
      if (Number(id) === req.user.id) {
        return res.status(400).json({ error: "Cannot delete your own admin account" });
      }
      const target: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
      if (target.length === 0) return res.status(404).json({ error: "User not found" });
      if (target[0].role === "superadmin") {
        return res.status(400).json({ error: "The Superadmin account can't be deleted." });
      }
      // Only the Superadmin may remove another Admin account — a plain Admin (even
      // with the Users module) can only manage/delete regular Users.
      if (target[0].role === "admin" && req.user.role !== "superadmin") {
        return res.status(403).json({ error: "Only the Superadmin can remove an Admin account." });
      }
      await queryDB("DELETE FROM user_project_permissions WHERE user_id = ?", [id]);
      await queryDB("DELETE FROM admin_module_permissions WHERE user_id = ?", [id]);
      await queryDB("DELETE FROM attendance_report_department_access WHERE user_id = ?", [id]);
      await queryDB("DELETE FROM leave_application_department_access WHERE user_id = ?", [id]);
      // A deleted user might still be linked from an Employees directory row
      // (all_employees.user_id — no FK/cascade on that column) — clear it so
      // the Employee doesn't keep showing a stale "Has Login" badge for an
      // account that no longer exists.
      await queryDB("UPDATE all_employees SET user_id = NULL WHERE user_id = ?", [id]);
      await queryDB("DELETE FROM users WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 6. User <-> Project Permissions (Admin-only)
  // Which User can see/use which Project — set from the Admin Panel.
  app.get("/api/permissions", authenticateToken, requireAdmin, requireModule("users"), async (req, res) => {
    try {
      const perms = await queryDB("SELECT * FROM user_project_permissions");
      res.json(perms);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Replaces the full set of Project permissions for one User in one call
  // (Admin Panel sends the complete list of checked Project IDs each save).
  app.put("/api/users/:id/projects", authenticateToken, requireAdmin, requireModule("users"), async (req, res) => {
    try {
      const { id } = req.params;
      const { project_ids } = req.body;
      if (!Array.isArray(project_ids)) {
        return res.status(400).json({ error: "project_ids must be an array" });
      }

      const userRows: any = await queryDB("SELECT id, role FROM users WHERE id = ?", [id]);
      if (userRows.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }
      // Same rule as the Users list — a plain Admin can't reach the Superadmin's
      // account by id even though it's never shown to them.
      if (userRows[0].role === "superadmin" && req.user.role !== "superadmin") {
        return res.status(404).json({ error: "User not found" });
      }

      await queryDB("DELETE FROM user_project_permissions WHERE user_id = ?", [id]);
      const uniqueProjectIds = Array.from(new Set(project_ids.map((pid: any) => Number(pid))));
      for (const pid of uniqueProjectIds) {
        await queryDB("INSERT INTO user_project_permissions (user_id, project_id) VALUES (?, ?)", [Number(id), pid]);
      }

      res.json({ success: true, project_ids: uniqueProjectIds });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
