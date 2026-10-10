/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Sign-in routes (/api/auth/register, /api/auth/login, /api/auth/me), moved out of server.ts unchanged.
// The shared helpers they use are passed in by startServer().

import { checkWorkspaceLogin } from "./CompanyRoutes";
import { sessionLifetimeSeconds } from "./SessionSecurity";
import { resolveCompanyContext } from "./CompanyRoutes";
import { workspaceStartCompany } from "./CompanyRoutes";
import { checkAppDevice } from "./DeviceRoutes";
import { activeCompanyId } from "./companyContext";
import { activeGroupId } from "./companyContext";
import { companyStore } from "./companyContext";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Express } from "express";

export interface RegisterAuthRoutesDeps {
  JWT_SECRET: any;
  authenticateToken: any;
  getAdminModules: any;
  getAllModulePermissionLayers: any;
  pepmEnabled: any;
  queryDB: any;
}

export function registerAuthRoutes(app: Express, deps: RegisterAuthRoutesDeps) {
  const { JWT_SECRET, authenticateToken, getAdminModules, getAllModulePermissionLayers, pepmEnabled, queryDB } = deps;
  // 1. Auth Routes
  // Public self-registration is disabled — only the Admin can create user accounts
  // (see POST /api/users below, Admin-only).
  app.post("/api/auth/register", async (req, res) => {
    res.status(403).json({ error: "Public registration is disabled. Please contact your Admin to get an account created." });
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      // "identifier" is either the Admin/Email-based login (email + password) or the
      // Project Name based login used by bulk-created users (Project Name, spaces
      // ignored, + password) — accept either in the same field. "email" is still
      // accepted for older frontend builds.
      const identifierRaw = req.body.identifier ?? req.body.email;
      const { password, latitude, longitude } = req.body;
      if (!identifierRaw || !password) {
        return res.status(400).json({ error: "Login ID and password are required" });
      }
      // Location is only required from the ANDROID APP build, not the web build —
      // AuthScreen.tsx only requests location and sets this flag when running as
      // a native Capacitor app (Capacitor.isNativePlatform()). A plain browser
      // login never sends it and is never asked to.
      const isAppClient = req.body.platform === "app";
      const hasValidCoords =
        typeof latitude === "number" && typeof longitude === "number" &&
        Number.isFinite(latitude) && Number.isFinite(longitude);
      if (isAppClient && !hasValidCoords) {
        return res.status(400).json({ error: "Location permission is required to sign in. Please allow location access and try again." });
      }
      const identifier = String(identifierRaw).trim();
      // Project Name login ignores spaces and case (matches how the username was
      // derived from the Project Name at bulk-creation time).
      const usernameCandidate = identifier.replace(/\s+/g, "").toLowerCase();

      const users = await queryDB(
        "SELECT * FROM users WHERE email = ? OR username = ?",
        [identifier, usernameCandidate]
      );
      if (users.length === 0) {
        return res.status(400).json({ error: "Invalid login ID or password" });
      }

      const user = users[0];
      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) {
        return res.status(400).json({ error: "Invalid login ID or password" });
      }
      // Multi-company: the workspace typed before the login form must be this
      // account's own group (CompanyRoutes.ts). Older app builds send none.
      // The <address>/system sign-in page is for the system owner only.
      if (req.body.system && Number(user.is_platform_admin || 0) !== 1) {
        return res.status(400).json({ error: "Invalid login ID or password" });
      }
      const workspaceProblem = await checkWorkspaceLogin(queryDB, req.body.system ? undefined : req.body.workspace, user);
      if (workspaceProblem) return res.status(workspaceProblem.status).json({ error: workspaceProblem.error });
      // Admin Panel -> Users -> Block, or an approved Termination / Resignation.
      if (Number(user.is_blocked || 0) === 1 && user.role !== "superadmin") {
        return res.status(403).json({ error: "This account has been blocked. Contact HR.", code: "ACCOUNT_BLOCKED" });
      }

      // The app signs in on one phone per account unless a Superadmin allows
      // more (DeviceRoutes.ts). The website isn't limited.
      let deviceRowId: number | null = null;
      if (isAppClient) {
        const device = await checkAppDevice(queryDB, user, req.body);
        if (!device.ok) {
          const refused = device as Extract<typeof device, { ok: false }>;
          return res.status(refused.status).json({ error: refused.error, code: refused.code });
        }
        deviceRowId = (device as Extract<typeof device, { ok: true }>).deviceRowId || null;
      }

      // Store only the latest login's coordinates (overwrites any previous value).
      // Web logins don't send coordinates at all, so this is skipped for them —
      // a web login never clears out the last known app-login location.
      if (hasValidCoords) {
        try {
          await queryDB(
            "UPDATE users SET last_login_lat = ?, last_login_lng = ?, last_login_at = NOW() WHERE id = ?",
            [latitude, longitude, user.id]
          );
        } catch (locErr: any) {
          // Never fail the login itself over a location-save error.
          console.warn("⚠️ Could not save login location for user " + user.id + ": " + locErr.message);
        }
      }

      const token = jwt.sign(
        { id: user.id, email: user.email, username: user.username, role: user.role, name: user.name, cl: isAppClient ? "app" : "web", iat_ms: Date.now(), ...(deviceRowId ? { dev: deviceRowId } : {}) },
        JWT_SECRET,
        // Admin Panel -> Active Users -> Session security (SessionSecurity.ts).
        { expiresIn: await sessionLifetimeSeconds(queryDB, isAppClient) }
      );
      // The account's default company — its Module Access below is that company's.
      // (The system owner signing in through another group's workspace starts inside it.)
      const startCompany = await workspaceStartCompany(queryDB, req.body.workspace, user).catch(() => undefined);
      const companyCtx = await resolveCompanyContext(queryDB, user, startCompany).catch(() => ({ companyId: 1, groupId: 1 }));

      res.json(await companyStore.run(companyCtx, async () => ({
        token,
        active_company_id: companyCtx.companyId,
        user: {
          id: user.id,
          pepm_enabled: pepmEnabled(companyCtx.groupId),
          name: user.name,
          email: user.email,
          username: user.username,
          role: user.role,
          can_edit_delivery_date: user.can_edit_delivery_date === undefined ? true : !!Number(user.can_edit_delivery_date),
          can_job_edit: !!Number(user.can_job_edit) && pepmEnabled(companyCtx.groupId),
          // Superadmin-granted (or implicit for the Superadmin itself): shows the
          // Remote Attendance Check In/Out card on THIS account's own Dashboard.
          // OFF by default — separate from the "attendance" Admin Panel module,
          // which is about reviewing everyone else's records, not this account's
          // own check-in ability.
          can_use_attendance: user.role === "superadmin" ? true : !!Number(user.can_use_attendance),
          // Superadmin/Admin-granted (Admin Panel -> Users -> "Attend. Project"):
          // pins this account to exactly one Project for Remote Attendance.
          // Null/undefined for everyone unrestricted, and always null for
          // 'superadmin' (never assigned one).
          attendance_project_id: user.role === "superadmin" ? null : (user.attendance_project_id ?? null),
          // Superadmin-granted (or implicit for the Superadmin itself): lets THIS
          // account's APK send background location pings for Employee Tracking.
          // OFF by default — separate from the "tracking" Admin Panel module,
          // which is about VIEWING everyone's live location.
          can_use_tracking: user.role === "superadmin" ? true : !!Number(user.can_use_tracking),
          // A Superadmin always sees the "Last Login Location" column; a plain Admin
          // only if the Superadmin has explicitly granted it (can_view_login_location).
          can_view_login_location: user.role === "superadmin" ? true : !!Number(user.can_view_login_location),
          // Superadmin-granted: lets this Admin ALSO use the User Panel (mark
          // Attendance, submit Claims, enter Job/MPR data) alongside their Admin
          // Panel. Always false for a plain User (irrelevant — they only ever see
          // the User Panel) and for a Superadmin (routes to Admin Panel only).
          can_access_user_panel: user.role === "admin" ? !!Number(user.can_access_user_panel) : false,
          // Superadmin-granted (or implicit for the Superadmin itself): can this
          // account edit OTHER accounts' Leave balances on Self Service -> Leave
          // Management? Applies to both 'admin' and 'user' roles, unlike the
          // Admin-only grant above.
          can_manage_leave: user.role === "superadmin" ? true : !!Number(user.can_manage_leave),
          // Superadmin-granted (or implicit for the Superadmin itself): can this
          // account see/use the Movement Claim (GPS Check In/Out) and Conveyance
          // Bill Claim sections on its own User Panel at all? Applies to both
          // 'admin' and 'user' roles, same pattern as can_manage_leave above —
          // OFF (hidden) until the Superadmin explicitly grants it.
          can_view_movement_claims: user.role === "superadmin" ? true : !!Number(user.can_view_movement_claims),
          can_view_conveyance_claims: user.role === "superadmin" ? true : !!Number(user.can_view_conveyance_claims),
          // Superadmin-granted (or implicit for the Superadmin itself, and ON
          // by default for everyone else — see the ALTER TABLE): can this
          // account see/use "Select a Budget", "Jobs" and "Job Entry Details"
          // on its own User Panel at all? Applies to both 'admin' and 'user'
          // roles, same pattern as can_view_movement_claims above but ON
          // unless a Superadmin has explicitly turned it off.
          can_view_budget_module: user.role === "superadmin" ? true : user.can_view_budget_module === undefined ? true : !!Number(user.can_view_budget_module),
          // Admin/Superadmin-granted (or implicit for the Superadmin itself):
          // shows the Leave Summary card on THIS account's own Dashboard. OFF
          // by default — same toggle pattern as can_use_attendance above.
          can_view_leave_summary: user.role === "superadmin" ? true : !!Number(user.can_view_leave_summary),
          // Superadmin-granted (or implicit for the Superadmin itself): can this
          // account see/use Self Service -> Timesheet / Leave Application / My
          // Leave at all? Applies to both 'admin' and 'user' roles, OFF by
          // default — same pattern as can_view_movement_claims above.
          can_view_timesheet: user.role === "superadmin" ? true : !!Number(user.can_view_timesheet),
          can_use_calls: user.role === "superadmin" ? true : !!Number(user.can_use_calls),
          can_view_tasks: user.role === "superadmin" ? true : !!Number(user.can_view_tasks),
          can_view_mobile_bill: user.role === "superadmin" ? true : !!Number(user.can_view_mobile_bill),
          can_view_service_book: user.role === "superadmin" ? true : !!Number(user.can_view_service_book),
          can_view_loan_request: user.role === "superadmin" ? true : !!Number(user.can_view_loan_request),
          can_view_leave_application: user.role === "superadmin" ? true : !!Number(user.can_view_leave_application),
          can_view_my_leave: user.role === "superadmin" ? true : !!Number(user.can_view_my_leave),
          // Superadmin-granted, only ever meaningful for role='admin': can this
          // Admin ALSO set OTHER accounts' Module Access themselves (see the
          // ALTER TABLE above for the full explanation and its 'user'-target-only
          // restriction).
          can_grant_module_access: user.role === "admin" ? !!Number(user.can_grant_module_access) : false,
          // So the Admin Panel can show/hide tabs right after login, before any
          // other fetch. Empty for Users and for Superadmin (who has every module
          // implicitly, not through explicit grants).
          module_permissions: (user.role === "admin" || user.role === "user") ? await getAdminModules(user.id) : [],
          // Same reasoning, one level more granular — see PERMISSION_LAYER_MODULES.
          module_permission_layers: (user.role === "admin" || user.role === "user") ? await getAllModulePermissionLayers(user.id) : {}
        }
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Login failed" });
    }
  });

  app.get("/api/auth/me", authenticateToken, async (req: any, res) => {
    try {
      const users = await queryDB(
        "SELECT id, name, email, role, created_at, can_edit_delivery_date, can_job_edit, can_use_attendance, can_view_login_location, can_access_user_panel, can_manage_leave, can_view_movement_claims, can_view_conveyance_claims, can_use_tracking, can_view_budget_module, can_view_leave_summary, can_view_timesheet, can_view_leave_application, can_view_my_leave, can_use_calls, can_view_tasks, can_view_mobile_bill, can_view_service_book, can_view_loan_request, can_grant_module_access, attendance_project_id FROM users WHERE id = ?",
        [req.user.id]
      );
      if (users.length === 0) return res.status(404).json({ error: "User not found" });
      const u = users[0];
      res.json({
        ...u,
        active_company_id: activeCompanyId(),
        pepm_enabled: pepmEnabled(activeGroupId()),
        can_edit_delivery_date: u.can_edit_delivery_date === undefined ? true : !!Number(u.can_edit_delivery_date),
        can_job_edit: !!Number(u.can_job_edit) && pepmEnabled(activeGroupId()),
        can_use_attendance: u.role === "superadmin" ? true : !!Number(u.can_use_attendance),
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
        can_use_calls: u.role === "superadmin" ? true : !!Number(u.can_use_calls),
        can_view_tasks: u.role === "superadmin" ? true : !!Number(u.can_view_tasks),
        can_view_mobile_bill: u.role === "superadmin" ? true : !!Number(u.can_view_mobile_bill),
        can_view_service_book: u.role === "superadmin" ? true : !!Number(u.can_view_service_book),
        can_view_loan_request: u.role === "superadmin" ? true : !!Number(u.can_view_loan_request),
        can_view_leave_application: u.role === "superadmin" ? true : !!Number(u.can_view_leave_application),
        can_view_my_leave: u.role === "superadmin" ? true : !!Number(u.can_view_my_leave),
        can_grant_module_access: u.role === "admin" ? !!Number(u.can_grant_module_access) : false,
        module_permissions: (u.role === "admin" || u.role === "user") ? await getAdminModules(u.id) : [],
        module_permission_layers: (u.role === "admin" || u.role === "user") ? await getAllModulePermissionLayers(u.id) : {}
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
