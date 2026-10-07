import express from "express";
import path from "path";
import http from "http";
import cors from "cors";
import compression from "compression";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mysql from "mysql2/promise";
import { createServer as createViteServer } from "vite";
import { syncAllZkDevices, syncZkDevice, startZkSyncSchedule, ensureZkSchema } from "./zkSync";
import { resolveMinLeadDays, addDaysToDateStr, DeliveryConditionType } from "./deliveryDateConditions";
import { registerProfileRoutes } from "./profileRoutes";
import { registerHolidayRoutes, ensureHolidayCalendarSchema } from "./holidayRoutes";
import { registerAlertRoutes, ensureAlertsSchema, createAlert } from "./Alerts";
import { registerUserManagementRoutes } from "./UserManagement";
import { registerConveyanceBillClaimRoutes, disburseConveyanceBill } from "./ConveyanceBillClaimRoutes";
import { registerLiveTrackingRoutes } from "./LiveTrackingRoutes";
import { registerDepartmentsAndBranchesRoutes } from "./DepartmentsAndBranches";
import { registerAttendanceRoutes } from "./AttendanceRoutes";
import { registerApprovalRoutes } from "./ApprovalRoutes";
import { registerLeaveRoutes } from "./LeaveRoutes";
import { registerPayrollRoutes, ensurePayrollSchema, arrearForLateLeave } from "./PayrollRoutes";
import { registerPayrollApprovalRoutes, ensurePayrollApprovalSchema } from "./PayrollApprovalRoutes";
import { registerPayrollItemsRoutes, ensurePayrollItemsSchema } from "./PayrollItemsRoutes";
import { registerAssetManagementRoutes, ensureAssetManagementSchema, logAssetRequisitionEvent } from "./AssetManagementRoutes";
import { registerVehicleManagementRoutes, ensureVehicleManagementSchema } from "./VehicleManagementRoutes";
import { registerEntriesRoutes } from "./EntriesRoutes";
import { registerDebugRoutes } from "./DebugRoutes";
import { registerProjectRoutes } from "./ProjectRoutes";
import { registerAuthRoutes } from "./AuthRoutes";
import { ensureSchemaMigrations } from "./schemaMigrations";
import { registerBudgetImportRoutes } from "./BudgetImportRoutes";
import { registerMovementClaimRoutes } from "./MovementClaimRoutes";
import { registerOfficeAttendanceRoutes } from "./OfficeAttendanceRoutes";
import { registerEmployeeTrackingRoutes } from "./EmployeeTrackingRoutes";
import { registerNoticeRoutes } from "./NoticeRoutes";
import { registerEmployeeRoutes } from "./EmployeeRoutes";
import { registerEmployeeTransferRoutes, ensureEmployeeTransferSchema, applyDueEmployeeTransfers, recordEmployeeEditHistory } from "./EmployeeTransferRoutes";
import { registerAdminDashboardRoutes } from "./AdminDashboardRoutes";
import { registerDeviceRoutes, ensureDeviceSchema, checkAppDevice, deviceStillAllowed } from "./DeviceRoutes";
import { ensureAccountBlockSchema, accountState, registerAccountBlockRoutes } from "./AccountBlock";
import { registerActiveUsersRoutes, ensureActiveUsersSchema, touchSession } from "./ActiveUsersRoutes";
import { registerDataImportRoutes } from "./DataImportRoutes";
import { registerCallRoutes, setupCallSocket } from "./CallRoutes";
import { registerWebPushRoutes, ensureWebPushSchema } from "./WebPushService";
import { sendPushToUserIds } from "./PushNotificationService";
import { registerEmployeeDirectoryRoutes } from "./EmployeeDirectoryRoutes";
import { registerExitOffboardingRoutes, ensureExitOffboardingSchema } from "./ExitOffboardingRoutes";
import { registerPerformanceRoutes, ensurePerformanceSchema } from "./PerformanceRoutes";
import { registerRecruitmentRoutes, ensureRecruitmentSchema } from "./RecruitmentRoutes";
import { registerGrievanceRoutes, ensureGrievanceSchema } from "./GrievanceRoutes";
import { registerTaskRoutes, ensureTaskSchema } from "./TaskRoutes";
import { registerTrackingStayReportRoutes, wallMinutes } from "./TrackingStayReport";
import { registerMobileBillRoutes, ensureMobileBillSchema, finalizeMobileLimitRequest, rejectMobileLimitRequest } from "./MobileBillRoutes";
import { registerLoanRequestRoutes, ensureLoanRequestSchema, finalizeAdvanceRequest, rejectAdvanceRequest, recommendAdvanceRequest } from "./LoanRequestRoutes";
import { registerHROperationsRoutes, ensureHROperationsSchema, applyDueHrActions } from "./HROperationsRoutes";
import { registerEmployee360Routes, ensureEmployee360Schema } from "./HrOps360Routes";
import { registerHrReportsRoutes, ensureHrReportsSchema } from "./HrOpsReportsRoutes";
import { registerReportsInsightsRoutes } from "./ReportsInsightsRoutes";
import { registerInfoRequestRoutes, ensureInfoRequestsSchema } from "./HrOpsInfoRequestsRoutes";
import { registerSiteAttendanceRoutes, ensureSiteAttendanceSchema } from "./SiteAttendanceRoutes";
import { registerBillClaimPolicyRoutes, ensureBillClaimPolicySchema, loadPolicy as loadBillClaimPolicy } from "./BillClaimPolicy";
import { recordClaimHistory } from "./ConveyanceClaimHistory";
import { registerCompanyRoutes, ensureCompanySchema, resolveCompanyContext, checkWorkspaceLogin, workspaceStartCompany } from "./CompanyRoutes";
import { companyStore, activeCompanyId, activeGroupId, type CompanyContext } from "./companyContext";
import { scopeSql, scopeColumnsFor } from "./companyScope";
import { registerHRAnalyticsRoutes } from "./HRAnalyticsRoutes";
import { registerDocumentVaultRoutes, ensureDocumentVaultSchema } from "./DocumentVaultRoutes";
import { registerErp360SsoRoutes } from "./Erp360SsoRoutes";
import { Server as SocketIOServer } from "socket.io";
import { ensureChatSchema, registerChatRoutes, setupChatSocket } from "./ChatRoutes";
import { memoryDb, queryMemoryDb, EMPLOYEE_BOOL_FIELDS } from "./memoryDbFallback";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || "mpr_tracker_secret_key_2026";
const PORT = Number(process.env.PORT) || 3000;

// Normalizes a MySQL DATE value (which mysql2 may return as a JS Date object or as a
// "YYYY-MM-DD" string depending on driver config) down to a plain "YYYY-MM-DD" string,
// so it always drops cleanly into an <input type="date"> value/min/max on the client.
// Today's calendar date in Asia/Dhaka, regardless of what timezone the server process
// itself is running in. `new Date().toISOString().split("T")[0]` would use the
// server's UTC date instead — since Bangladesh is UTC+6, that reads as YESTERDAY for
// the first 6 hours of every Bangladesh calendar day (00:00–05:59 BD = 18:00–23:59 UTC
// the previous day), which is exactly the kind of "date shown one day behind" bug this
// app has been chasing.
export function todayInDhaka(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

function toDateOnlyString(value: any): string | null {
  if (value === null || value === undefined || value === "") return null;
  // Read local Y/M/D components rather than .toISOString() (which converts to UTC and
  // rolls a local-midnight Date back a calendar day for timezones ahead of UTC, e.g.
  // Bangladesh). With the pool's `dateStrings: true` this branch shouldn't normally be
  // hit for DB values, but it's kept safe as a fallback (e.g. in-memory DB fixtures).
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const str = String(value);
  return str.length >= 10 ? str.slice(0, 10) : str;
}

// Great-circle distance in meters between two lat/lng points (Haversine formula).
// Used by Remote Attendance to check whether a User's check-in/out location falls
// inside a Project's location_radius circle around its location_lat/location_lng.
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// budget_items.req_qty (and the client's Requisitioned Qty input) are free-text
// strings imported straight from the Excel sheet — this pulls out just the leading
// numeric portion (e.g. "120.50 pcs" -> 120.5) so it can be compared/summed. Returns
// null if no usable number is found (an unbounded/unparseable Qty is never treated as
// "0 remaining" — it simply isn't capped).
function parseQtyNumber(value: any): number | null {
  if (value === null || value === undefined) return null;
  const match = String(value).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

let dbPool: mysql.Pool | null = null;
// Socket.IO server, set once it starts (see httpServer below); used to tell
// open apps that a Notice was published.
let liveIo: SocketIOServer | null = null;
let isMySQLConnected = false;

async function initDB() {
  try {
    dbPool = mysql.createPool({
      host: process.env.DB_HOST || "localhost",
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "",
      database: process.env.DB_NAME || "mpr_tracker_db",
      port: Number(process.env.DB_PORT) || 3306,
      waitForConnections: true,
      // The Dashboard alone fires off ~10 concurrent API calls on a single
      // app open (master data, entries, MPR usage, Attendance, Leave
      // Summary, Pending Approvals, Holiday Calendar, Notices, ...), each
      // needing its own connection for the length of its query. At the old
      // limit of 10, one person opening the app could already saturate the
      // whole pool; with queueLimit unbounded, every request after that
      // just waits its turn instead of failing outright — which is exactly
      // the "takes forever to reach the Dashboard" symptom. Raised well
      // above that single-user burst so concurrent opens don't queue behind
      // each other; MySQL's own default max_connections (151) has plenty of
      // headroom above this for the one app process using it. Each PM2
      // cluster worker (see ecosystem.config.cjs) gets its own pool of this
      // size, so once running with `instances` > 1 in production, raise
      // MySQL's max_connections to comfortably cover instances * 30, or
      // lower this per-worker limit to fit.
      connectionLimit: 30,
      queueLimit: 0,
      // Without this, mysql2 hands back DATE/DATETIME columns as JS Date objects built
      // from LOCAL midnight. Those then get flattened to a string either by our own
      // `.toISOString()` calls or implicitly by JSON.stringify (which also calls
      // toISOString() on any Date) — and toISOString() converts to UTC, which for a
      // timezone ahead of UTC (e.g. Bangladesh, UTC+6) rolls every DATE-only column
      // back by one calendar day. Returning them as plain "YYYY-MM-DD" strings instead
      // sidesteps timezone conversion entirely, which is what every date field in this
      // app (delivery_date_from/to, item_date, approved_date, site_sup_date, entry_date,
      // delivery_date, etc.) actually needs.
      dateStrings: true
    });

    const connection = await dbPool.getConnection();
    console.log(" Connected to MySQL Database successfully!");
    isMySQLConnected = true;
    connection.release();
    await ensureSchemaMigrations(dbPool, { EMPLOYEE_EXT_FIELD_DDL, getApprovalChain, queryDB });
    await ensureZkSchema(dbPool);
    startZkSyncSchedule(dbPool);
  } catch (err: any) {
    console.warn("⚠️ MySQL Connection failed (" + err.message + "). Falling back to in-memory storage for preview/testing. (To use MySQL, ensure XAMPP MySQL is running and .env is configured).");
    isMySQLConnected = false;
  }
}

// Every Admin Panel tab, gated per-Admin by the Superadmin. Kept as a single source
// of truth here and mirrored in src/types.ts (ADMIN_MODULES) for the UI.
const USER_CLAIM_CATEGORIES = ["Transport", "Fuel", "Toll", "Parking", "Others"] as const;

// 'vehicle_maintainer' — deliberately separate from 'vehicle_management':
// grants ONLY the Vehicle Requisition bypass actions in
// VehicleManagementRoutes.ts (POST .../direct-book, PUT .../:id/direct-assign)
// so a Superadmin can hand this out to whoever actually keeps the vehicles
// running day-to-day without also giving them the full Admin Panel ->
// Vehicle Management tab (fleet CRUD, the Approval Workflow's own queue,
// etc.). See the two routes' own comments for what the bypass does.
const ADMIN_MODULE_KEYS = ["projects", "branches", "mprs", "imports", "reports", "users", "attendance", "attendance_reports", "leave_applications", "recycle", "editlog", "notices", "claims", "approvals", "conveyance", "disbursement", "employees", "departments", "tracking", "office_attendance", "holidays", "payroll", "asset_management", "vehicle_management", "vehicle_maintainer", "exit_offboarding", "performance_management", "recruitment", "grievance_disciplinary", "hr_analytics", "document_vault", "hr_operations", "admin_dashboard", "task_management", "mobile_bill"] as const;

// Granular per-module action layers — mirrors PermissionLayerKey/
// PERMISSION_LAYERS in src/types.ts (single source of truth is duplicated
// here, not imported, same convention as ADMIN_MODULE_KEYS/ADMIN_MODULES
// above — this file has no import of the frontend's types.ts).
const PERMISSION_LAYER_KEYS = ["read", "edit_add", "entry_upload", "delete_trash", "permanent_delete"] as const;
// Users: the generic layers plus "block_account" (Block / Unblock a login,
// AccountBlock.ts) — never part of the no-saved-layers default.
const USERS_LAYER_KEYS = [...PERMISSION_LAYER_KEYS, "block_account"] as const;
// Which modules currently enforce PERMISSION_LAYER_KEYS — mirrors
// PERMISSION_LAYER_MODULES in src/types.ts. Rolled out module by module.
const PERMISSION_LAYER_MODULES = ["departments", "projects", "approvals", "users", "reports", "tracking", "payroll", "mobile_bill", "office_attendance", "conveyance"] as const;
// Employee Tracking's layers: "read" = the live map, history and status
// cards; "stay_report" = the Stay Report (TrackingStayReport.ts). Both are
// reading, so an account with Employee Tracking and no saved layers has both.
const TRACKING_LAYER_KEYS = ["read", "stay_report", "live"] as const;
// What an account with the tracking module but no saved layers gets — Live
// Follow ("live") is explicit-only, so it is left out.
const TRACKING_DEFAULT_LAYERS = ["read", "stay_report"] as const;
// Payroll's layers: "read" = the whole Payroll module as it was (runs,
// payslips, salary setup, late policy…); "salary_month" = changing the day
// a salary month starts (26 -> "26 to 25"). salary_month changes every
// payroll figure, so it is never part of the no-saved-layers default: only
// an account it is ticked for (and the Superadmin) can change it.
// "salary_hold" = holding / releasing one employee's salary for a month
// (kept out of disbursement until released) — also explicit-only.
// "audit_approve" = Audit approves / returns a month's salary sheet;
// "accounts_pay" = Accounts pays an approved month; "access_log" = Payroll ->
// Activity Log (who opened Payroll, what they looked at and did). All
// explicit-only (PayrollApprovalRoutes.ts).
const PAYROLL_LAYER_KEYS = ["read", "salary_month", "salary_hold", "audit_approve", "accounts_pay", "access_log"] as const;
// Mobile Bill's layers: "read" = the module as it was; "limit_history" =
// Reports -> Limit changes (who changed which SIM's limit, when). Both are
// reading, so an account with Mobile Bill and no saved layers has both.
const MOBILE_BILL_LAYER_KEYS = ["read", "limit_history"] as const;
// Office Attendance: "read" = the module as it was; "link_pins" = Unlinked
// PINs — tie a device PIN that has punches to an Employee (edits the
// Employee record, so never part of the no-saved-layers default).
const OFFICE_ATTENDANCE_LAYER_KEYS = ["read", "link_pins"] as const;
// Conveyance Bill Claim: "read" = the module as it was; "on_behalf" = file a
// Conveyance Bill Claim for another employee (it goes through that
// employee's approval chain like their own would) — explicit-only.
const CONVEYANCE_LAYER_KEYS = ["read", "on_behalf"] as const;
// PEPM Reports uses four of them: Read Only, Edit, Delete/Trash, Permanent Delete
// — plus its own "Budget Submission Status" (the second report on that page),
// which, like Permanent Delete, is never part of the no-saved-rows default:
// only an account it's explicitly ticked for can open it.
const REPORT_LAYER_KEYS = ["read", "edit_add", "delete_trash", "permanent_delete", "submission_status"] as const;

// Leave Manage's own operation-specific layers — mirrors LeaveManageLayerKey/
// LEAVE_MANAGE_LAYERS in src/types.ts. Not part of PERMISSION_LAYER_MODULES/
// PERMISSION_LAYER_KEYS above since Leave Manage isn't an Admin Panel
// "module" (no admin_module_permissions grant) and its operations don't map
// onto the generic Read/Edit-Add/Entry-Upload/Delete-Trash/Permanent-Delete
// set — see requireLeaveManagerLayer() below.
const LEAVE_MANAGE_LAYER_KEYS = ["edit_balance", "bulk_set_balance", "add_category", "edit_policy", "year_settings", "workflow_manage"] as const;

// Every (module_key -> its allowed layer keys) the Module Access Layers PUT
// endpoint (UserManagement.ts) accepts — a single map instead of one flat
// key list, since Leave Manage uses its own distinct set instead of
// PERMISSION_LAYER_KEYS. Add an entry here (and to
// src/components/AdminPanel.tsx's rendering) whenever a new module/feature
// is rolled onto this system.
const MODULE_LAYER_KEY_SETS: Record<string, readonly string[]> = {
  departments: PERMISSION_LAYER_KEYS,
  projects: PERMISSION_LAYER_KEYS,
  approvals: PERMISSION_LAYER_KEYS,
  users: USERS_LAYER_KEYS,
  reports: REPORT_LAYER_KEYS,
  tracking: TRACKING_LAYER_KEYS,
  payroll: PAYROLL_LAYER_KEYS,
  mobile_bill: MOBILE_BILL_LAYER_KEYS,
  office_attendance: OFFICE_ATTENDANCE_LAYER_KEYS,
  conveyance: CONVEYANCE_LAYER_KEYS,
  leave_manage: LEAVE_MANAGE_LAYER_KEYS,
};

// Employee Directory extended profile fields (Admin Panel -> Employees ->
// Edit -> Employee Info / Status / Contact tabs). Single source of truth for
// column names — used to build the ALTER TABLE migration above and the
// dynamic INSERT/UPDATE in POST/PUT /api/employees below, so the three never
// drift out of sync. DATE fields are stored/sent as 'YYYY-MM-DD' strings (or
// null); everything else is a plain string column (or null) except
// is_foreigner, which is 0/1.
const EMPLOYEE_TEXT_FIELDS = [
  "middle_name", "gender", "nid_ssn", "nationality", "marital_status", "blood_group", "religion",
  // "branch" pulled out — like "department" before it, it's now a
  // structured column (branch/branch_id, resolved by resolveEmployeeBranch)
  // instead of a generic free-text ext field. See that function's comment.
  "division", "unit", "job_status", "job_base", "review_month", "employment_category",
  "mobile", "telephone", "personal_email",
  "present_address", "present_country", "present_state", "present_city", "present_zip",
  "permanent_address", "permanent_country", "permanent_state", "permanent_city", "permanent_zip"
] as const;
const EMPLOYEE_DATE_FIELDS = [
  // The day this person actually started — attendance summaries don't count
  // any day before it as Absent (see /api/my-attendance-summary and the
  // Monthly Attendance Report).
  "joining_date",
  "date_of_birth", "status_effective_date", "job_status_effective_date", "job_base_effective_date",
  "employment_category_effective_date", "designation_effective_date"
] as const;
// Full ordered list of extended columns, in the order they're written to
// all_employees by POST/PUT /api/employees.
const EMPLOYEE_EXT_FIELDS: string[] = [...EMPLOYEE_TEXT_FIELDS, ...EMPLOYEE_DATE_FIELDS, ...EMPLOYEE_BOOL_FIELDS];
const EMPLOYEE_EXT_FIELD_DDL: { name: string; ddl: string }[] = [
  ...EMPLOYEE_TEXT_FIELDS.map((name) => ({
    name,
    ddl: name.endsWith("_address") ? "TEXT NULL" : name === "gender" || name === "blood_group" ? "VARCHAR(20) NULL" : "VARCHAR(255) NULL"
  })),
  ...EMPLOYEE_DATE_FIELDS.map((name) => ({ name, ddl: "DATE NULL" })),
  ...EMPLOYEE_BOOL_FIELDS.map((name) => ({ name, ddl: "TINYINT(1) NOT NULL DEFAULT 0" }))
];

// Normalizes one extended-field value coming from the request body before it
// hits the DB: trims strings to null-if-empty, coerces booleans to 0/1,
// leaves dates as the 'YYYY-MM-DD' string (or null) the <input type="date">
// fields already send.
function normalizeEmployeeExtValue(field: string, value: any): any {
  if ((EMPLOYEE_BOOL_FIELDS as readonly string[]).includes(field)) return value ? 1 : 0;
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}
type AdminModuleKey = typeof ADMIN_MODULE_KEYS[number];

async function getAdminModules(userId: number): Promise<string[]> {
  try {
    // Module Access is per company — the one this request is working in.
    const rows: any = await queryDB("SELECT module_key FROM admin_module_permissions WHERE user_id = ? AND company_id = ?", [userId, activeCompanyId()]);
    return rows.map((r: any) => r.module_key);
  } catch {
    return [];
  }
}

// The layers explicitly granted for one (user, module) pair — NOT the
// effective set (see requireModuleLayer()'s fallback for that); an empty
// array here just means no rows exist yet, which the caller interprets.
async function getModulePermissionLayersForModule(userId: number, moduleKey: string): Promise<string[]> {
  try {
    const rows: any = await queryDB(
      "SELECT layer_key FROM admin_module_permission_layers WHERE user_id = ? AND module_key = ? AND company_id = ?",
      [userId, moduleKey, activeCompanyId()]
    );
    return rows.map((r: any) => r.layer_key);
  } catch {
    return [];
  }
}

// Every (module -> layers[]) row for this account in one query — used to
// serialize module_permission_layers on login/me/the Users list, same shape
// as getAdminModules()'s modulesByUser grouping in UserManagement.ts.
async function getAllModulePermissionLayers(userId: number): Promise<Record<string, string[]>> {
  try {
    const rows: any = await queryDB(
      "SELECT module_key, layer_key FROM admin_module_permission_layers WHERE user_id = ? AND company_id = ?",
      [userId, activeCompanyId()]
    );
    const byModule: Record<string, string[]> = {};
    for (const row of rows) {
      (byModule[row.module_key] ||= []).push(row.layer_key);
    }
    return byModule;
  } catch {
    return {};
  }
}

// Department-wise scope for the 'attendance_reports' module — see the
// attendance_report_department_access table comment in initDB() for the full
// design. Returns null for "unrestricted" (no rows for this user — every
// Department is visible, same as before this feature existed) or the exact
// list of Department names this account may see otherwise. A Superadmin is
// never restricted; callers should check req.user.role themselves the same
// way they already do for getAdminModules (this helper doesn't special-case
// it, matching that function's own convention).
async function getAttendanceReportDeptScope(userId: number): Promise<string[] | null> {
  try {
    const rows: any = await queryDB("SELECT department FROM attendance_report_department_access WHERE user_id = ?", [userId]);
    if (rows.length === 0) return null;
    return rows.map((r: any) => r.department);
  } catch {
    return null;
  }
}

// Department-wise scope for the 'leave_applications' module — same shape and
// same "no rows = unrestricted" convention as getAttendanceReportDeptScope
// above, backed by leave_application_department_access instead. See that
// table's comment in initDB() for the full design.
async function getLeaveApplicationDeptScope(userId: number): Promise<string[] | null> {
  try {
    const rows: any = await queryDB("SELECT department FROM leave_application_department_access WHERE user_id = ?", [userId]);
    if (rows.length === 0) return null;
    return rows.map((r: any) => r.department);
  } catch {
    return null;
  }
}

// Department-wise scope for the 'conveyance' module — same shape and same
// "no rows = unrestricted" convention as getAttendanceReportDeptScope/
// getLeaveApplicationDeptScope above, backed by
// conveyance_claim_department_access instead. See that table's comment in
// initDB() for the full design.
async function getConveyanceClaimDeptScope(userId: number): Promise<string[] | null> {
  try {
    const rows: any = await queryDB("SELECT department FROM conveyance_claim_department_access WHERE user_id = ?", [userId]);
    if (rows.length === 0) return null;
    return rows.map((r: any) => r.department);
  } catch {
    return null;
  }
}

// The current global Approval Chain, in order (step_order ASC) — empty if the
// Superadmin hasn't configured one yet (Admin Panel -> Approvals -> Manage Chain).
async function getApprovalChain(): Promise<any[]> {
  try {
    return await queryDB(
      "SELECT acs.*, u.name AS user_name, u.role AS user_role FROM approval_chain_steps acs LEFT JOIN users u ON u.id = acs.user_id ORDER BY acs.step_order ASC"
    );
  } catch {
    return [];
  }
}

// Fires an Approval Request through the configured global chain whenever a User
// Checks In / Checks Out (Remote Attendance OR Movement Claims). This is called
// AFTER the check-in/out itself is already recorded, and deliberately never throws
// — the workflow is non-blocking, so a failure here must never undo or block the
// User's actual check-in/out. If no chain is configured yet, this is a no-op.
async function createApprovalRequest(
  sourceType: "attendance" | "claim" | "user_claim",
  eventType: "check_in" | "check_out" | "submit",
  sourceId: number,
  requestedBy: number
) {
  try {
    const chain = await getApprovalChain();
    if (chain.length === 0) return;
    await queryDB(
      "INSERT INTO approval_requests (source_type, event_type, source_id, requested_by, status, current_step, total_steps, actions_json) VALUES (?, ?, ?, ?, 'pending', 1, ?, '[]')",
      [sourceType, eventType, sourceId, requestedBy, chain.length]
    );
  } catch (err: any) {
    console.warn("⚠️ Could not create approval request: " + err.message);
  }
}

// ============================================================================
// Dynamic Approval Engine (Part 3 of 5) — reads the Templates built in Part 2
// to route a freshly-submitted Conveyance Bill Claim / Timesheet (Attendance
// Correction) request. (Leave Application is intentionally NOT wired to this
// yet — see the Leave Balance + migration work grouped into Part 5.) Remote
// Attendance / Movement Claims ('attendance'/'claim' source types) are also
// untouched — they keep using the OLD global chain (createApprovalRequest
// above) exactly as before.
//
// This is a full cutover, not an additional fallback: from here on,
// Conveyance/Timesheet submissions no longer consult the old global chain at
// all — only Templates. A brand-new install with no Template created yet
// will auto-approve every Conveyance/Timesheet submission (the explicit
// edge-case the original spec asked for) until at least a default Template
// exists for that request_type, or Part 5's migration seeds one from the old
// chain.
// ============================================================================

// Employee-specific assignment first (must point at an ACTIVE template — a
// deactivated assignment is treated the same as no assignment at all, not an
// error), else that request_type's active default, else null.
async function resolveApprovalTemplate(employeeUserId: number, requestType: "conveyance" | "leave" | "timesheet" | "asset" | "vehicle" | "mobile" | "loan"): Promise<any | null> {
  try {
    const assigned = await queryDB(
      `SELECT t.* FROM employee_template_assignments eta
       JOIN approval_templates t ON t.id = eta.template_id
       WHERE eta.employee_user_id = ? AND eta.request_type = ? AND t.is_active = 1`,
      [employeeUserId, requestType]
    );
    if (assigned.length > 0) return assigned[0];
  } catch (err: any) {
    console.warn("⚠️ Could not resolve employee template assignment: " + err.message);
  }
  try {
    const allTemplates = await queryDB("SELECT * FROM approval_templates");
    const def = allTemplates.find(
      (t: any) => t.request_type === requestType && Number(t.is_default) === 1 && Number(t.is_active) === 1
    );
    if (def) return def;
  } catch (err: any) {
    console.warn("⚠️ Could not resolve default template: " + err.message);
  }
  return null;
}

// Department Supervisor auto-layer — the submitting Employee's Department
// (all_employees.department_id -> departments), if it has a Supervisor set
// AND include_supervisor_approval is on, becomes this request's step 1
// (see createTemplateApprovalRequest/getCurrentStepApprovers). Returns null
// (no gate) for: no linked Department, no Supervisor set, the toggle turned
// off, or the Supervisor IS the requester (never make someone approve their
// own request — falls through to the Template as if no Supervisor existed).
// This is the FALLBACK layer — resolveSupervisorApprover below tries the
// Employee's own Direct Supervisor (employee_supervisors) first and only
// calls this when that isn't usable.
async function resolveDepartmentSupervisor(employeeUserId: number): Promise<number | null> {
  try {
    const rows = await queryDB(
      `SELECT d.supervisor_user_id
       FROM all_employees e
       JOIN departments d ON d.id = e.department_id
       WHERE e.user_id = ? AND d.is_active = 1 AND d.include_supervisor_approval = 1 AND d.supervisor_user_id IS NOT NULL
       LIMIT 1`,
      [employeeUserId]
    );
    if (rows.length === 0) return null;
    const supervisorId = Number(rows[0].supervisor_user_id);
    if (!supervisorId || supervisorId === Number(employeeUserId)) return null;
    return supervisorId;
  } catch (err: any) {
    console.warn("⚠️ Could not resolve department supervisor: " + err.message);
    return null;
  }
}

// Employee's own Direct Supervisor (Admin Panel -> Employees -> Edit ->
// Supervisor tab, employee_supervisors.is_direct = 1) — tried BEFORE the
// Department Supervisor. Returns null (falls through to
// resolveDepartmentSupervisor) when: the Employee has no linked login
// account, no Supervisor row at all, no row marked Direct, that Direct
// Supervisor's own Employee Directory row has no login account to actually
// act on approvals with, or the Supervisor IS the requester. When an
// Employee has more than one row marked Direct (shouldn't normally happen,
// but the tab doesn't enforce it), the most recently added one wins.
async function resolveEmployeeDirectSupervisor(employeeUserId: number): Promise<number | null> {
  try {
    const rows = await queryDB(
      `SELECT sup.user_id AS supervisor_user_id
       FROM all_employees e
       JOIN employee_supervisors es ON es.employee_id = e.id AND es.is_direct = 1
       JOIN all_employees sup ON sup.id = es.supervisor_id
       WHERE e.user_id = ? AND sup.user_id IS NOT NULL
       ORDER BY es.id DESC
       LIMIT 1`,
      [employeeUserId]
    );
    if (rows.length === 0) return null;
    const supervisorId = Number(rows[0].supervisor_user_id);
    if (!supervisorId || supervisorId === Number(employeeUserId)) return null;
    return supervisorId;
  } catch (err: any) {
    console.warn("⚠️ Could not resolve employee direct supervisor: " + err.message);
    return null;
  }
}

// The actual Supervisor gate used by createTemplateApprovalRequest — the
// Employee's own Direct Supervisor (resolveEmployeeDirectSupervisor) first;
// only when that resolves to null does the Department Supervisor
// (resolveDepartmentSupervisor) apply as the fallback.
async function resolveSupervisorApprover(employeeUserId: number): Promise<number | null> {
  const direct = await resolveEmployeeDirectSupervisor(employeeUserId);
  if (direct) return direct;
  return resolveDepartmentSupervisor(employeeUserId);
}

// Creates a Template-driven approval_requests row for a just-submitted
// Conveyance/Timesheet request, OR reports back that no Template applies at
// all (autoApproved: true) so the caller finalizes the request immediately
// instead — see the two POST /api/user-claims and POST
// /api/attendance/corrections call sites below for how that edge case is
// actually handled (each source type finalizes differently).
//
// Department Supervisor auto-layer: if resolveDepartmentSupervisor finds one,
// it's inserted as this request's step_order 1, and the Template's own steps
// (if any) shift down to step_order 2, 3, ... (approval_requests.
// supervisor_step_user_id records this so getCurrentStepApprovers knows to
// apply the shift). A Supervisor with NO Template beneath them still creates
// a real (Supervisor-only) request rather than auto-approving — only when
// there's neither a Supervisor gate NOR a Template does this auto-approve.
// "Supervisor" here means resolveSupervisorApprover's result — the
// Employee's own Direct Supervisor (employee_supervisors) when set and
// usable, otherwise the Department Supervisor as a fallback.
async function createTemplateApprovalRequest(
  requestType: "conveyance" | "leave" | "timesheet" | "asset" | "vehicle" | "mobile" | "loan",
  sourceType: "user_claim" | "attendance_correction" | "leave_application" | "asset_requisition" | "vehicle_requisition" | "mobile_limit_request" | "advance_request",
  sourceId: number,
  requestedBy: number,
  // Vehicle Requisition Flowchart v2.0's "জরুরি/HR Direct" initiator path —
  // HR/Admin manually files a requisition on someone else's behalf and may
  // not want (or trust) that person's auto-resolved employee_supervisors row
  // to be the Layer 1 approver (e.g. an emergency, or the requester has no
  // Direct Supervisor set). When provided (any value other than undefined,
  // including null to explicitly force NO Supervisor gate), this REPLACES
  // resolveSupervisorApprover's own lookup instead of running it. Every
  // existing caller omits this (stays undefined), so this is a zero-
  // behavior-change addition for Conveyance/Leave/Timesheet/Asset — see
  // VehicleManagementRoutes.ts's POST .../admin-create for the one caller
  // that passes it.
  overrideSupervisorId?: number | null
): Promise<{ autoApproved: boolean; template: any | null }> {
  let template = await resolveApprovalTemplate(requestedBy, requestType);
  let templateSteps = 0;
  if (template) {
    const allSteps = await queryDB("SELECT * FROM approval_template_steps");
    templateSteps = allSteps.filter((s: any) => Number(s.template_id) === Number(template.id)).length;
    // A Template somehow has zero steps (Part 2's editor always requires at
    // least one, but defend against a row created some other way) — treat
    // this exactly like "no template at all" (the Supervisor gate above, if
    // any, still applies on its own).
    if (templateSteps === 0) template = null;
  }

  // Approver Type override: a Template whose Layer 1 was explicitly set to
  // Employee/Admin (skip_auto_supervisor) skips the automatic Supervisor gate
  // below entirely — that Template's own step_order 1 becomes this request's
  // real first step instead. Every pre-existing template defaults to
  // skip_auto_supervisor = false, so this is a no-op for them.
  const supervisorId = template?.skip_auto_supervisor
    ? null
    : overrideSupervisorId !== undefined
    ? overrideSupervisorId
    : await resolveSupervisorApprover(requestedBy);

  const totalSteps = (supervisorId ? 1 : 0) + templateSteps;
  if (totalSteps === 0) return { autoApproved: true, template: null };

  await queryDB(
    `INSERT INTO approval_requests (source_type, event_type, source_id, requested_by, status, current_step, total_steps, actions_json, template_id, supervisor_step_user_id)
     VALUES (?, 'submit', ?, ?, 'pending', 1, ?, '[]', ?, ?)`,
    [sourceType, sourceId, requestedBy, totalSteps, template ? template.id : null, supervisorId || null]
  );
  return { autoApproved: false, template };
}

// Who's authorized to act on an approval_requests row's CURRENT step, whether
// it's riding the OLD global chain (template_id IS NULL — one approver) or a
// NEW Template (template_id set — one or more approvers, ANY ONE of whom
// clears the step). Used by POST /api/approvals/:id/act (who MAY act) and by
// the GET /api/approvals list / attach*Approval enrichers (who to display as
// "waiting on"). Department Supervisor auto-layer: when
// supervisor_step_user_id is set on the request, step_order 1 is that
// Supervisor and the Template's own steps are shifted down by one (its own
// step_order 1 is this request's step_order 2, and so on).
async function getCurrentStepApprovers(request: any): Promise<{ user_id: number; user_name: string | null }[]> {
  const hasSupervisorStep = !!request.supervisor_step_user_id;
  if (hasSupervisorStep && Number(request.current_step) === 1) {
    const rows = await queryDB("SELECT id, name FROM users WHERE id = ?", [request.supervisor_step_user_id]);
    return rows.length > 0 ? [{ user_id: Number(rows[0].id), user_name: rows[0].name }] : [];
  }
  if (request.template_id) {
    const templateStepOrder = hasSupervisorStep ? Number(request.current_step) - 1 : Number(request.current_step);
    const rows = await queryDB(
      `SELECT sa.user_id, u.name AS user_name
       FROM approval_template_step_approvers sa
       JOIN approval_template_steps s ON s.id = sa.step_id
       LEFT JOIN users u ON u.id = sa.user_id
       WHERE s.template_id = ? AND s.step_order = ?`,
      [request.template_id, templateStepOrder]
    );
    return rows.map((r: any) => ({ user_id: Number(r.user_id), user_name: r.user_name }));
  }
  const chain = await getApprovalChain();
  const step = chain.find((s: any) => Number(s.step_order) === Number(request.current_step));
  return step ? [{ user_id: Number(step.user_id), user_name: step.user_name }] : [];
}

// True when a pending request's CURRENT step is a Template step whose
// approver_type is 'vehicle_maintainer' — used to word the "waiting on you"
// alert as an assign-a-vehicle task instead of an approval.
async function getCurrentTemplateStepType(request: any): Promise<string | null> {
  if (!request?.template_id) return null;
  const hasSupervisorStep = !!request.supervisor_step_user_id;
  if (hasSupervisorStep && Number(request.current_step) === 1) return null;
  const templateStepOrder = hasSupervisorStep ? Number(request.current_step) - 1 : Number(request.current_step);
  const steps = await queryDB("SELECT * FROM approval_template_steps");
  const step = steps.find((s: any) => Number(s.template_id) === Number(request.template_id) && Number(s.step_order) === templateStepOrder);
  return step ? step.approver_type || null : null;
}
async function isVehicleMaintainerStep(request: any): Promise<boolean> {
  return (await getCurrentTemplateStepType(request)) === "vehicle_maintainer";
}
// Same idea for an Asset Requisition whose current Layer is the Template's
// 'asset_fulfiller' Layer — that approver fulfills the items instead of
// approving them.
async function isAssetFulfillerStep(request: any): Promise<boolean> {
  return (await getCurrentTemplateStepType(request)) === "asset_fulfiller";
}
// Conveyance counterpart — a 'conveyance' Template's last Layer set to
// 'conveyance_disburser': that approver pays the claim out (Bill + voucher)
// instead of only approving it. See performApprovalAction.
async function isConveyanceDisburserStep(request: any): Promise<boolean> {
  return (await getCurrentTemplateStepType(request)) === "conveyance_disburser";
}

// A small typed error so callers (both the Admin-queue route and the
// personal-queue route below) can map it to the right HTTP status without
// duplicating the status-picking logic.
class ApprovalActionError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Shared Approve/Reject logic (Part 4) — the actual step-advance/finalize
// work used by BOTH POST /api/approvals/:id/act (the Admin Panel's full
// queue, module-gated) and POST /api/my-approvals/:id/act (Part 4's personal
// "waiting on me" queue, open to ANY logged-in account regardless of Admin
// Panel access). Authorization is identical either way — a Superadmin may
// act at any step as an override; anyone else must be one of the CURRENT
// step's approvers (getCurrentStepApprovers), role='user' included — see the
// long design note on Part 4 above the personal-queue routes.
async function performApprovalAction(
  requestId: number,
  actorUser: { id: number; name: string; role: string },
  action: "approved" | "rejected" | "returned",
  remarks: string | null,
  billId: number | null,
  approvedAmount?: number | null,
  voucherNo?: string | null,
  // Conveyance Bill Claims only: `claimVersion` = the claim version the
  // approver looked at (refused if the employee has edited it since);
  // `allowReclaim` = Reject, but let the employee edit and resubmit it.
  claimOpts: { claimVersion?: number | null; allowReclaim?: boolean } = {}
): Promise<{ status: string; current_step: number; billInfo: { bill_id: number; bill_item_id: number; voucher_no?: string } | null }> {
  const rows = await queryDB("SELECT * FROM approval_requests WHERE id = ?", [requestId]);
  if (rows.length === 0) throw new ApprovalActionError(404, "Approval request not found.");
  const request = rows[0];
  if (request.status !== "pending") {
    throw new ApprovalActionError(400, `This request was already ${request.status}.`);
  }

  const currentApprovers = await getCurrentStepApprovers(request);
  const isAssignedApprover = currentApprovers.some((a) => Number(a.user_id) === Number(actorUser.id));
  if (actorUser.role !== "superadmin" && !isAssignedApprover) {
    throw new ApprovalActionError(403, "This request isn't waiting on you yet.");
  }

  // Conveyance Bill Claim review rules (Bill Claim Policy -> Editing & review).
  let claimPolicy: any = null;
  if (request.source_type === "user_claim") {
    claimPolicy = await loadBillClaimPolicy(queryDB);
    if (claimOpts.claimVersion != null) {
      const v = await queryDB("SELECT version FROM user_claims WHERE id = ?", [request.source_id]);
      if (v.length > 0 && Number(v[0].version || 1) !== Number(claimOpts.claimVersion)) {
        throw new ApprovalActionError(409, "The employee changed this claim after you opened it — reload it and check the changes first.");
      }
    }
    if ((action === "returned" || action === "rejected") && claimPolicy.decision_reason_required && !remarks) {
      throw new ApprovalActionError(400, `Write a reason for the ${action === "returned" ? "Return" : "Rejection"} — the employee sees it.`);
    }
    if (action === "returned" && !claimPolicy.allow_return) {
      throw new ApprovalActionError(400, "Returning claims is turned off in the Bill Claim Policy.");
    }
  } else if (action === "returned") {
    throw new ApprovalActionError(400, "Only a Conveyance Bill Claim can be returned for correction.");
  }

  // Return for correction: the claim goes back to the employee (out of every
  // queue) and, once they resubmit, starts again from Layer 1.
  if (action === "returned") {
    let trail: any[] = [];
    try {
      trail = JSON.parse(request.actions_json || "[]");
    } catch {
      trail = [];
    }
    trail.push({
      step_order: Number(request.current_step),
      approver_id: actorUser.id,
      approver_name: actorUser.name,
      action: "returned",
      remarks,
      acted_at: new Date().toISOString()
    });
    await queryDB("UPDATE approval_requests SET status = 'returned', current_step = 1, actions_json = ? WHERE id = ?", [JSON.stringify(trail), requestId]);
    await queryDB("UPDATE user_claims SET edit_state = 'returned', return_reason = ?, approved_amount = NULL WHERE id = ?", [remarks, request.source_id]);
    await recordClaimHistory(queryDB, Number(request.source_id), "returned", { id: actorUser.id, name: actorUser.name }, remarks);
    try {
      const ucRows = await queryDB("SELECT id, user_id, filed_by FROM user_claims WHERE id = ?", [request.source_id]);
      const uc = ucRows[0];
      const notifyIds = [...new Set([Number(uc?.user_id), Number(uc?.filed_by || 0)].filter((x) => x > 0))];
      for (const uid of notifyIds) {
        await createAlert(queryDB, {
          userId: uid,
          type: "conveyance_claim",
          title: "Conveyance Bill Claim Returned",
          message: `${actorUser.name} returned Conveyance Bill Claim #${request.source_id} for correction${remarks ? `: ${remarks}` : "."} Edit it and submit it again.`,
          relatedType: "user_claim",
          relatedId: Number(request.source_id)
        });
      }
    } catch (alertErr: any) {
      console.warn("⚠️ Could not notify about returned Conveyance Bill Claim #" + request.source_id + ": " + alertErr.message);
    }
    return { status: "returned", current_step: 1, billInfo: null };
  }
  // The Conveyance Disburser Layer pays out as it approves: the claim gets its
  // own new Bill (never folded into an existing one) and that Bill is marked
  // disbursed in the same action.
  const disburseOnApprove =
    request.source_type === "user_claim" &&
    action === "approved" &&
    Number(request.current_step) >= Number(request.total_steps) &&
    (await isConveyanceDisburserStep(request));

  let actions: any[] = [];
  try {
    actions = JSON.parse(request.actions_json || "[]");
  } catch {
    actions = [];
  }

  // Approved Amount history (for the Admin's Conveyance Bill Claim "History" —
  // ConveyanceBillPanel.tsx's UserClaimDetailModal): only meaningful for a
  // 'user_claim' Approve. Records the amount THIS Layer actually decided
  // (whatever was submitted, or whatever was already on record if they left
  // it untouched) and whether that's a change from what was on record
  // immediately before this action — so "who approved" and "how many times
  // was the Approved Amount edited" can both be read straight off the
  // actions trail already stored per request, without a separate history
  // table.
  let actionApprovedAmount: number | null = null;
  let actionAmountEdited = false;
  if (request.source_type === "user_claim" && action === "approved") {
    const ucRows = await queryDB("SELECT amount, approved_amount FROM user_claims WHERE id = ?", [request.source_id]);
    if (ucRows.length > 0) {
      // Checked before anything is written, so a refused amount leaves the
      // request exactly where it was.
      if (approvedAmount != null) {
        if (!Number.isFinite(Number(approvedAmount)) || Number(approvedAmount) <= 0) {
          throw new ApprovalActionError(400, "Approved Amount must be a positive number.");
        }
        try {
          assertWithinApprovedCap(ucRows[0], Number(approvedAmount));
        } catch (capErr: any) {
          throw new ApprovalActionError(400, capErr.message);
        }
      }
      const priorAmount = ucRows[0].approved_amount != null ? Number(ucRows[0].approved_amount) : Number(ucRows[0].amount);
      actionApprovedAmount = approvedAmount != null ? Number(approvedAmount) : priorAmount;
      actionAmountEdited = actionApprovedAmount !== priorAmount;
    }
  }

  actions.push({
    step_order: Number(request.current_step),
    approver_id: actorUser.id,
    approver_name: actorUser.name,
    action,
    remarks,
    acted_at: new Date().toISOString(),
    ...(actionApprovedAmount != null ? { approved_amount: actionApprovedAmount, amount_edited: actionAmountEdited } : {})
  });

  let newStatus = request.status;
  let newStep = Number(request.current_step);
  if (action === "rejected") {
    newStatus = "rejected";
  } else if (Number(request.current_step) >= Number(request.total_steps)) {
    newStatus = "approved";
  } else {
    newStep = Number(request.current_step) + 1;
  }

  await queryDB("UPDATE approval_requests SET status = ?, current_step = ?, actions_json = ? WHERE id = ?", [
    newStatus,
    newStep,
    JSON.stringify(actions),
    requestId
  ]);

  // Only a 'user_claim' request actually gates something further — a
  // Conveyance Bill Claim only becomes a real Bill line item the moment its
  // request finishes 'approved' here (the LAST step), and is freed up again
  // the moment it's 'rejected' (at any step). Attendance/Movement Claims are
  // already recorded regardless — this Approval Workflow is purely their
  // review trail — so nothing further happens for those.
  let billInfo: { bill_id: number; bill_item_id: number; voucher_no?: string } | null = null;
  if (request.source_type === "user_claim") {
    try {
      if (newStatus === "approved") {
        billInfo = await finalizeUserClaimApproval(Number(request.source_id), actorUser.id, disburseOnApprove ? null : billId, remarks, approvedAmount);
        if (disburseOnApprove) {
          billInfo.voucher_no = await disburseConveyanceBill(queryDB, createAlert, todayInDhaka, billInfo.bill_id, actorUser.id, voucherNo);
        }
      } else if (newStatus === "rejected") {
        await rejectUserClaimRecord(Number(request.source_id), actorUser.id, remarks, !!claimOpts.allowReclaim && !!claimPolicy?.allow_reclaim_on_reject, actorUser.name);
      } else if (action === "approved" && approvedAmount != null) {
        // Approved on a NON-final step (e.g. the Supervisor auto-layer at
        // step 1 of a multi-step chain) with an Approved Amount edit — same
        // capability the last step already had, just recorded as a running
        // draft instead of finalizing a Bill line item yet. See
        // updateUserClaimApprovedAmountDraft.
        await updateUserClaimApprovedAmountDraft(Number(request.source_id), approvedAmount);
      }
    } catch (finalizeErr: any) {
      // The Approval Request itself already recorded above — surface the
      // Bill-side problem (e.g. a stale bill_id) without pretending the
      // approval action never happened.
      throw new ApprovalActionError(400, finalizeErr.message || "Approved, but could not attach this claim to a Bill.");
    }
  } else if (request.source_type === "attendance_correction") {
    try {
      if (newStatus === "approved") {
        await finalizeAttendanceCorrection(Number(request.source_id), actorUser.id, remarks);
      } else if (newStatus === "rejected") {
        await rejectAttendanceCorrection(Number(request.source_id), actorUser.id, remarks);
      }
    } catch (finalizeErr: any) {
      throw new ApprovalActionError(400, finalizeErr.message || "Approved, but could not apply this Attendance Correction.");
    }
  } else if (request.source_type === "leave_application") {
    try {
      if (newStatus === "approved") {
        await finalizeLeaveApplicationApproval(Number(request.source_id), actorUser.id, remarks);
      } else if (newStatus === "rejected") {
        await rejectLeaveApplicationRecord(Number(request.source_id), actorUser.id, remarks);
      }
    } catch (finalizeErr: any) {
      throw new ApprovalActionError(400, finalizeErr.message || "Approved, but could not finalize this Leave Application.");
    }
  } else if (request.source_type === "asset_requisition") {
    try {
      if (newStatus === "approved") {
        await finalizeAssetRequisitionApproval(Number(request.source_id), actorUser.id, remarks);
      } else if (newStatus === "rejected") {
        await rejectAssetRequisitionRecord(Number(request.source_id), actorUser.id, remarks);
      }
    } catch (finalizeErr: any) {
      throw new ApprovalActionError(400, finalizeErr.message || "Approved, but could not finalize this Asset Requisition.");
    }
    // Requisition history — the final approve/reject already alert the
    // requester above, so only an intermediate Layer's approval notifies.
    const layerLabel = `Layer ${actions[actions.length - 1].step_order} of ${request.total_steps}`;
    await logAssetRequisitionEvent(queryDB, createAlert, {
      requisitionId: Number(request.source_id),
      actor: actorUser,
      action: action === "rejected" ? "rejected" : newStatus === "approved" ? "approved" : "approved_step",
      message:
        action === "rejected"
          ? `${actorUser.name} rejected the requisition (${layerLabel})${remarks ? `: ${remarks}` : "."}`
          : newStatus === "approved"
            ? `${actorUser.name} gave the final approval (${layerLabel})${remarks ? `: ${remarks}` : "."}`
            : `${actorUser.name} approved ${layerLabel}${remarks ? `: ${remarks}` : ""} — now with the next approver.`,
      details: remarks ? { remarks } : undefined,
      notify: newStatus === "pending"
    });
  } else if (request.source_type === "vehicle_requisition") {
    try {
      if (newStatus === "approved") {
        await finalizeVehicleRequisitionApproval(Number(request.source_id), actorUser.id, remarks);
      } else if (newStatus === "rejected") {
        await rejectVehicleRequisitionRecord(Number(request.source_id), actorUser.id, remarks);
      }
    } catch (finalizeErr: any) {
      throw new ApprovalActionError(400, finalizeErr.message || "Approved, but could not finalize this Vehicle Requisition.");
    }
  } else if (request.source_type === "mobile_limit_request") {
    try {
      if (newStatus === "approved") {
        await finalizeMobileLimitRequest(queryDB, createAlert, Number(request.source_id), actorUser.id, remarks);
      } else if (newStatus === "rejected") {
        await rejectMobileLimitRequest(queryDB, createAlert, Number(request.source_id), actorUser.id, remarks);
      }
    } catch (finalizeErr: any) {
      throw new ApprovalActionError(400, finalizeErr.message || "Approved, but could not change this SIM's limit.");
    }
  } else if (request.source_type === "advance_request") {
    // With a Template the chain's final Approve lends the money; with only a
    // Supervisor it's a recommendation and Payroll decides (LoanRequestRoutes.ts).
    try {
      if (newStatus === "approved") {
        if (request.template_id) await finalizeAdvanceRequest(queryDB, createAlert, Number(request.source_id), actorUser.id, remarks);
        else await recommendAdvanceRequest(queryDB, createAlert, getAdminModules, Number(request.source_id), actorUser.name || "The approver");
      } else if (newStatus === "rejected") {
        await rejectAdvanceRequest(queryDB, createAlert, Number(request.source_id), actorUser.id, remarks);
      }
    } catch (finalizeErr: any) {
      throw new ApprovalActionError(400, finalizeErr.message || "Approved, but could not create this loan.");
    }
  }

  return { status: newStatus, current_step: newStep, billInfo };
}

// Attaches { check_in_approval, check_out_approval } (each either null — no chain
// was configured for that event — or { status, current_step, total_steps }) onto a
// set of Attendance or Claims rows, so the User/Admin screens can show a
// Pending/Approved/Rejected badge next to a check-in/out without a separate call.
// Returns a NEW array; never mutates the rows passed in.
async function attachApprovalStatuses(sourceType: "attendance" | "claim", rows: any[]): Promise<any[]> {
  if (rows.length === 0) return rows;
  let requests: any[] = [];
  try {
    requests = await queryDB("SELECT * FROM approval_requests WHERE source_type = ?", [sourceType]);
  } catch {
    requests = [];
  }
  const byRow = new Map<number, { check_in?: any; check_out?: any }>();
  for (const r of requests) {
    const key = Number(r.source_id);
    const entry = byRow.get(key) || {};
    (entry as any)[r.event_type === "check_in" ? "check_in" : "check_out"] = r;
    byRow.set(key, entry);
  }
  const summarize = (r: any) => (r ? { status: r.status, current_step: r.current_step, total_steps: r.total_steps } : null);
  return rows.map((row: any) => {
    const entry = byRow.get(Number(row.id));
    return {
      ...row,
      check_in_approval: summarize(entry?.check_in),
      check_out_approval: summarize(entry?.check_out)
    };
  });
}

// Same idea as attachApprovalStatuses above, but for User Claims (Conveyance Bill
// Claim) — only ONE Approval Request per claim (event_type 'submit'), not a
// check-in/check-out pair, so this attaches a single `approval` field instead.
// Also resolves current_approver_name (who the request is sitting with right
// now, while still 'pending') and the request's actions trail — same
// enrichment attachAttendanceCorrectionApproval does for Timesheet — so a User
// can tell exactly which Layer their Conveyance Bill Claim is waiting on.
async function attachUserClaimApproval(rows: any[]): Promise<any[]> {
  if (rows.length === 0) return rows;
  let requests: any[] = [];
  try {
    requests = await queryDB("SELECT * FROM approval_requests WHERE source_type = ?", ["user_claim"]);
  } catch {
    requests = [];
  }
  const byId = new Map<number, any>(requests.map((r: any) => [Number(r.source_id), r]));
  return Promise.all(
    rows.map(async (row: any) => {
      const r = byId.get(Number(row.id));
      if (!r) return { ...row, approval: null };
      const currentApprovers = r.status === "pending" ? await getCurrentStepApprovers(r) : [];
      let actions: any[] = [];
      try {
        actions = JSON.parse(r.actions_json || "[]");
      } catch {
        actions = [];
      }
      return {
        ...row,
        approval: {
          status: r.status,
          current_step: r.current_step,
          total_steps: r.total_steps,
          current_approver_name: currentApprovers.length > 0 ? currentApprovers.map((a) => a.user_name || `User #${a.user_id}`).join(" or ") : null,
          actions
        }
      };
    })
  );
}

// Same idea as attachUserClaimApproval above, but for Attendance Correction
// requests (single Approval Request per request, event_type 'submit').
// Additionally resolves current_approver_name (who the request is sitting
// with right now, while still 'pending') and the request's actions trail —
// same enrichment GET /api/approvals does for the Admin queue — so Timesheet
// can tell the User exactly which link of the chain a correction is waiting
// on, or who approved/rejected it and any remarks they left, without a
// separate Admin-only call.
async function attachAttendanceCorrectionApproval(rows: any[]): Promise<any[]> {
  if (rows.length === 0) return rows;
  let requests: any[] = [];
  try {
    requests = await queryDB("SELECT * FROM approval_requests WHERE source_type = ?", ["attendance_correction"]);
  } catch {
    requests = [];
  }
  const byId = new Map<number, any>(requests.map((r: any) => [Number(r.source_id), r]));
  return Promise.all(
    rows.map(async (row: any) => {
      const r = byId.get(Number(row.id));
      if (!r) return { ...row, approval: null };
      // Dynamic Approval Engine (Part 3) — getCurrentStepApprovers resolves
      // this from the Template if r.template_id is set, else falls back to
      // the OLD single-approver global chain exactly as before.
      const currentApprovers = r.status === "pending" ? await getCurrentStepApprovers(r) : [];
      let actions: any[] = [];
      try {
        actions = JSON.parse(r.actions_json || "[]");
      } catch {
        actions = [];
      }
      return {
        ...row,
        approval: {
          status: r.status,
          current_step: r.current_step,
          total_steps: r.total_steps,
          current_approver_name: currentApprovers.length > 0 ? currentApprovers.map((a) => a.user_name || `User #${a.user_id}`).join(" or ") : null,
          actions
        }
      };
    })
  );
}

// Actually applies an Approved Attendance Correction's requested In/Out Time
// onto the `attendance` table — updating that day's row if one already exists
// (e.g. only the Out Time was missing) or creating it fresh (the day was fully
// Absent). Shared by two callers: POST /api/attendance/corrections/:id/decision
// (the no-chain-configured / legacy single-step path) and
// POST /api/approvals/:id/act (the moment the LAST step of a configured chain
// approves an 'attendance_correction' request). Throws on any problem —
// callers decide how to surface that.
async function finalizeAttendanceCorrection(correctionId: number, approvedBy: number, remarks: string | null) {
  const rows = await queryDB("SELECT * FROM attendance_corrections WHERE id = ?", [correctionId]);
  if (rows.length === 0) throw new Error("Correction request not found");
  const c = rows[0];
  if (c.status !== "pending") throw new Error("This request has already been reviewed.");

  const existing = await queryDB("SELECT * FROM attendance WHERE user_id = ? AND project_id = ? AND attendance_date = ?", [
    c.user_id,
    c.project_id,
    c.attendance_date
  ]);
  if (existing.length > 0) {
    await queryDB(
      "UPDATE attendance SET check_in_at = COALESCE(?, check_in_at), check_out_at = COALESCE(?, check_out_at) WHERE id = ?",
      [c.requested_check_in_at, c.requested_check_out_at, existing[0].id]
    );
  } else {
    await queryDB(
      "INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at, check_out_at) VALUES (?, ?, ?, ?, ?)",
      [c.user_id, c.project_id, c.attendance_date, c.requested_check_in_at, c.requested_check_out_at]
    );
  }

  await queryDB("UPDATE attendance_corrections SET status = 'approved', admin_remarks = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?", [
    remarks,
    approvedBy,
    correctionId
  ]);
}

// Rejects an Attendance Correction request — never touches `attendance` at all.
// Shared by the same two callers as finalizeAttendanceCorrection above.
async function rejectAttendanceCorrection(correctionId: number, rejectedBy: number, remarks: string | null) {
  await queryDB("UPDATE attendance_corrections SET status = 'rejected', admin_remarks = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?", [
    remarks,
    rejectedBy,
    correctionId
  ]);
}

// Sets an Asset Requisition to 'approved' once every step of its Approval
// Workflow has signed off (Layer 1 defaults to the requester's own
// Supervisor per the Asset Management flowchart, Layer 2+ is whatever
// Template a Superadmin built for request_type 'asset' — see
// createTemplateApprovalRequest), or immediately on submit when neither a
// Supervisor nor a Template resolve (autoApproved). Approving here does NOT
// hand over an asset yet — IT/Admin still has to pick a specific inventory
// item via POST /api/assets/requisitions/:id/fulfill. Shared by
// performApprovalAction's 'asset_requisition' branch and the auto-approve
// path on POST /api/assets/requisitions.
async function finalizeAssetRequisitionApproval(requisitionId: number, approvedBy: number, remarks: string | null) {
  const rows = await queryDB("SELECT * FROM asset_requisitions WHERE id = ?", [requisitionId]);
  if (rows.length === 0) throw new Error("Requisition not found");
  const r = rows[0];
  if (r.status !== "pending") throw new Error("This requisition has already been reviewed.");
  await queryDB(
    "UPDATE asset_requisitions SET status = 'approved', admin_decided_by = ?, admin_decided_at = NOW() WHERE id = ?",
    [approvedBy, requisitionId]
  );
  await createAlert(queryDB, {
    userId: r.employee_user_id,
    type: "asset_requisition",
    title: "Requisition Approved",
    message: `Your ${r.asset_category} request was approved and will be dispatched shortly.`,
    relatedType: "asset_requisition",
    relatedId: requisitionId
  });
}

// Rejects an Asset Requisition at ANY step — never touches inventory.
// Shared by the same two callers as finalizeAssetRequisitionApproval above.
async function rejectAssetRequisitionRecord(requisitionId: number, rejectedBy: number, remarks: string | null) {
  const rows = await queryDB("SELECT * FROM asset_requisitions WHERE id = ?", [requisitionId]);
  if (rows.length === 0) throw new Error("Requisition not found");
  const r = rows[0];
  await queryDB(
    "UPDATE asset_requisitions SET status = 'rejected', admin_decided_by = ?, admin_decided_at = NOW(), rejection_reason = ? WHERE id = ?",
    [rejectedBy, remarks || "Rejected", requisitionId]
  );
  await createAlert(queryDB, {
    userId: r.employee_user_id,
    type: "asset_requisition",
    title: "Requisition Rejected",
    message: `Your ${r.asset_category} request was rejected.${remarks ? " Reason: " + remarks : ""}`,
    relatedType: "asset_requisition",
    relatedId: requisitionId
  });
}

// Sets a Vehicle Requisition to 'approved' once its Approval Workflow's
// single "HR/Admin Review" layer (the flowchart's only decision diamond —
// see LAYER_NAMES in ApprovalTemplateManager.tsx / request_type 'vehicle')
// signs off, or immediately on submit when no Template/Supervisor resolves
// at all (autoApproved). Approving here does NOT assign a vehicle+driver
// yet — IT/Admin still has to do that via PUT
// /api/vehicles/requisitions/:id/assign (VehicleManagementRoutes.ts), same
// two-step shape as finalizeAssetRequisitionApproval/POST .../fulfill above.
// Shared by performApprovalAction's 'vehicle_requisition' branch and the
// auto-approve path on POST /api/vehicles/requisitions.
async function finalizeVehicleRequisitionApproval(requisitionId: number, approvedBy: number, remarks: string | null) {
  const rows = await queryDB("SELECT * FROM vehicle_requisitions WHERE id = ?", [requisitionId]);
  if (rows.length === 0) throw new Error("Requisition not found");
  const r = rows[0];
  if (r.status !== "pending") throw new Error("This requisition has already been reviewed.");
  // Every SET value is its own `?` placeholder (no NOW()/literal mixed in) —
  // vehicle_requisitions is registered as a GENERIC_TABLES entry in
  // memoryDbFallback.ts (see VehicleManagementRoutes.ts's own top comment),
  // whose UPDATE simulator maps SET columns to params positionally; a
  // literal value in the SET clause desyncs that mapping for every column
  // after it (caught by the in-memory smoke test — see this function's
  // commit message).
  await queryDB("UPDATE vehicle_requisitions SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?", [
    "approved",
    approvedBy,
    new Date(),
    requisitionId
  ]);
  await createAlert(queryDB, {
    userId: r.employee_user_id,
    type: "vehicle_requisition",
    title: "Ride Request Approved",
    message: `Your ride request (${r.pickup_location} → ${r.destination}) was approved — a vehicle and driver will be assigned shortly.`,
    relatedType: "vehicle_requisition",
    relatedId: requisitionId
  });
}

// Rejects a Vehicle Requisition at ANY step (the flowchart's "গাড়ির
// অ্যাভেইলেবিলিটি চেক -> না -> ক্যানসেল" branch) — never touches vehicle
// inventory. Shared by the same two callers as
// finalizeVehicleRequisitionApproval above.
async function rejectVehicleRequisitionRecord(requisitionId: number, rejectedBy: number, remarks: string | null) {
  const rows = await queryDB("SELECT * FROM vehicle_requisitions WHERE id = ?", [requisitionId]);
  if (rows.length === 0) throw new Error("Requisition not found");
  const r = rows[0];
  await queryDB(
    "UPDATE vehicle_requisitions SET status = ?, decided_by = ?, decided_at = ?, rejection_reason = ? WHERE id = ?",
    ["rejected", rejectedBy, new Date(), remarks || "Rejected", requisitionId]
  );
  await createAlert(queryDB, {
    userId: r.employee_user_id,
    type: "vehicle_requisition",
    title: "Ride Request Rejected",
    message: `Your ride request (${r.pickup_location} → ${r.destination}) was rejected.${remarks ? " Reason: " + remarks : ""}`,
    relatedType: "vehicle_requisition",
    relatedId: requisitionId
  });
}

// Actually attaches an Approved User Claim onto a Conveyance Bill as a line item
// (creating a new Bill for that User if billId isn't given) and flips the claim to
// 'approved'. Shared by two callers: POST /api/user-claims/:id/decision (the
// no-chain-configured / legacy single-step path) and POST /api/approvals/:id/act
// (the moment the LAST step of a configured chain approves a 'user_claim'
// request). Throws on any problem — callers decide how to surface that.
async function finalizeUserClaimApproval(
  userClaimId: number,
  approvedBy: number,
  billId: number | null,
  remarks: string | null,
  approvedAmount?: number | null
) {
  const rows = await queryDB("SELECT * FROM user_claims WHERE id = ?", [userClaimId]);
  if (rows.length === 0) throw new Error("Claim not found");
  const uc = rows[0];
  if (uc.status !== "pending") throw new Error("This claim has already been reviewed.");

  // Approver may partially approve — Approved Amount must be a positive number
  // no greater than what was actually claimed. Falls back to whatever an
  // EARLIER Layer already set as a running draft (see
  // updateUserClaimApprovedAmountDraft — e.g. the Supervisor auto-layer
  // editing it at step 1 of a multi-step chain), and only falls back further
  // to the full Claim Amount when nobody has touched it yet (also covers the
  // legacy /api/user-claims/:id/decision path, which never supports partial
  // approval).
  let finalAmount = uc.approved_amount != null ? Number(uc.approved_amount) : Number(uc.amount);
  if (approvedAmount != null) {
    const amt = Number(approvedAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      throw new Error("Approved Amount must be a positive number.");
    }
    assertWithinApprovedCap(uc, amt);
    finalAmount = amt;
  }

  let targetBillId = billId;
  if (targetBillId) {
    const bills = await queryDB("SELECT * FROM conveyance_bills WHERE id = ?", [targetBillId]);
    if (bills.length === 0) throw new Error("Bill not found");
    if (Number(bills[0].user_id) !== Number(uc.user_id)) {
      throw new Error("That Bill belongs to a different User than this Claim.");
    }
  } else {
    const created = await queryDB(
      "INSERT INTO conveyance_bills (user_id, bill_date, remarks, created_by) VALUES (?, CURDATE(), ?, ?)",
      [uc.user_id, "Auto-created from an approved Conveyance Bill Claim", approvedBy]
    );
    targetBillId = created.insertId;
  }

  const particulars = String(uc.description || `${uc.category} claim`).slice(0, 255);
  const dateRangeNote =
    String(uc.from_date) !== String(uc.to_date)
      ? `Covers ${toDateOnlyString(uc.from_date)} to ${toDateOnlyString(uc.to_date)}.`
      : null;
  const refRows = await queryDB("SELECT claim_id FROM user_claim_references WHERE user_claim_id = ?", [uc.id]);
  const refNote = refRows.length > 0 ? `Includes ${refRows.length} referenced check-in/out(s).` : null;
  const itemRemarks = [dateRangeNote, refNote, remarks].filter(Boolean).join(" ") || null;

  const item = await queryDB(
    `INSERT INTO conveyance_bill_items
       (bill_id, source, user_claim_id, entry_date, particulars, amount, remarks)
     VALUES (?, 'user_claim', ?, ?, ?, ?, ?)`,
    [targetBillId, uc.id, toDateOnlyString(uc.claim_date), particulars, finalAmount, itemRemarks]
  );

  await queryDB(
    "UPDATE user_claims SET status = 'approved', approved_amount = ?, admin_remarks = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?",
    [finalAmount, remarks, approvedBy, userClaimId]
  );
  await notifyUserClaimDecision(uc, "approved", finalAmount, remarks);

  return { bill_id: targetBillId, bill_item_id: item.insertId };
}

// Tells the claimant their Conveyance Bill Claim was approved or rejected.
async function notifyUserClaimDecision(uc: any, decision: "approved" | "rejected", amount: number | null, remarks: string | null) {
  try {
    const amt = amount != null ? `\u09f3${Number(amount).toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;
    await createAlert(queryDB, {
      userId: Number(uc.user_id),
      type: "conveyance_claim",
      title: decision === "approved" ? "Conveyance Bill Claim Approved" : "Conveyance Bill Claim Rejected",
      message:
        decision === "approved"
          ? `Your ${uc.category} claim (${toDateOnlyString(uc.claim_date)}) has been approved${amt ? ` for ${amt}` : ""}.${remarks ? ` Remarks: ${remarks}` : ""}`
          : `Your ${uc.category} claim (${toDateOnlyString(uc.claim_date)}) was rejected.${remarks ? ` Reason: ${remarks}` : ""}`,
      relatedType: "user_claim",
      relatedId: Number(uc.id)
    });
  } catch (err: any) {
    console.warn("⚠️ Could not notify the claimant for Conveyance Bill Claim #" + uc.id + ": " + err.message);
  }
}

// Records an Approved Amount edit made at a NON-final step of a still-pending
// 'user_claim' chain (e.g. the Department/Direct Supervisor auto-layer at
// step 1 of a 2+ step chain, or any earlier Template Layer) — same Approved
// Amount capability the LAST step already had via finalizeUserClaimApproval,
// just without creating a Bill line item yet, since the claim isn't decided
// until the chain finishes. The value is stored as a running draft on
// user_claims.approved_amount so it carries forward as the next Layer's
// pre-fill (GET /api/my-approvals' source_approved_amount) and as
// finalizeUserClaimApproval's own fallback if the LAST approver doesn't
// change it. Same validation as finalizeUserClaimApproval: positive, and
// never more than the Claim Amount. No-ops quietly if the claim was somehow
// already decided by the time this runs (status changed underneath it) or
// the row is gone — the Approval Request's own step still advanced either
// way, this only affects the pre-fill an approver later sees.
async function updateUserClaimApprovedAmountDraft(userClaimId: number, approvedAmount: number) {
  const rows = await queryDB("SELECT * FROM user_claims WHERE id = ?", [userClaimId]);
  if (rows.length === 0) return;
  const uc = rows[0];
  if (uc.status !== "pending") return;

  const amt = Number(approvedAmount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error("Approved Amount must be a positive number.");
  }
  assertWithinApprovedCap(uc, amt);

  await queryDB("UPDATE user_claims SET approved_amount = ? WHERE id = ?", [amt, userClaimId]);
}

// A Layer may cut a claim's amount but never raise it: the ceiling is what the
// previous Layer approved (user_claims.approved_amount, the running draft), or
// the Claim Amount when no Layer has set one yet.
function assertWithinApprovedCap(uc: any, amt: number) {
  const prior = uc.approved_amount != null ? Number(uc.approved_amount) : null;
  if (amt > Number(uc.amount)) {
    throw new Error("Approved Amount can't be more than the Claim Amount.");
  }
  if (prior != null && amt > prior + 0.0001) {
    throw new Error(
      `Approved Amount can't be more than the \u09f3${prior.toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} the previous Layer approved.`
    );
  }
}

// Rejects a User Claim — frees up any referenced check-in/out(s) (a rejected claim
// never becomes a Bill line item, so there's no reason to keep them unavailable)
// and marks the claim 'rejected'. Shared by the same two callers as
// finalizeUserClaimApproval above.
// allowReclaim: the approver ticked "Allow re-claim" — the employee may edit
// and resubmit this same claim (its check-in/outs stay with it). Otherwise the
// rejection is final: its check-in/outs are freed, its dates stay closed.
async function rejectUserClaimRecord(userClaimId: number, rejectedBy: number, remarks: string | null, allowReclaim = false, rejectedByName = "") {
  if (!allowReclaim) await queryDB("DELETE FROM user_claim_references WHERE user_claim_id = ?", [userClaimId]);
  await queryDB(
    "UPDATE user_claims SET status = 'rejected', admin_remarks = ?, reviewed_by = ?, reviewed_at = NOW(), edit_state = NULL, reclaim_allowed = ? WHERE id = ?",
    [remarks, rejectedBy, allowReclaim ? 1 : 0, userClaimId]
  );
  await recordClaimHistory(queryDB, userClaimId, "rejected", { id: rejectedBy, name: rejectedByName }, remarks);
  const rows = await queryDB("SELECT * FROM user_claims WHERE id = ?", [userClaimId]);
  if (rows.length > 0) {
    await notifyUserClaimDecision(rows[0], "rejected", null, allowReclaim ? `${remarks || ""}${remarks ? " — " : ""}You may edit it and submit it again.` : remarks);
  }
}

// Approves a Leave Application (Part 5 of 5) — day_count was ALREADY deducted
// from leave_balances at submission time (see POST /api/leave-applications),
// so approving here only flips status + notifies the applicant; nothing else
// to move. Shared by the no-Template auto-approve edge case and
// performApprovalAction's LAST-step approval — same pattern as
// finalizeAttendanceCorrection/finalizeUserClaimApproval above.
// --- Leave Type helpers (fixed Casual/Sick/Leave-without-Pay + custom Leave
// Categories) ---
// leave_applications.leave_type (and, before it, POST /api/leave-applications'
// validation) used to only ever be one of the three fixed columns on
// leave_balances. Custom Leave Categories (leave_categories +
// leave_category_balances, added for Leave Manage -> Set Balance in Bulk ->
// Add Category) could hold a balance, but a Leave Application could never
// actually be submitted against one. These four helpers are the one place
// that now understands BOTH kinds of Leave Type, so every caller below
// (submit, reject/refund, approve, reliever, notifications) goes through
// them instead of re-deriving casual/sick/without_pay by hand.

const FIXED_LEAVE_TYPES = ["casual", "sick", "without_pay"] as const;

function isFixedLeaveType(leaveType: string): leaveType is (typeof FIXED_LEAVE_TYPES)[number] {
  return (FIXED_LEAVE_TYPES as readonly string[]).includes(leaveType);
}

// True for one of the 3 fixed types, or a category_key that actually exists
// in leave_categories — never trusts a client-supplied key without checking.
async function isValidLeaveType(leaveType: string): Promise<boolean> {
  if (isFixedLeaveType(leaveType)) return true;
  const rows = await queryDB("SELECT id, category_key, label FROM leave_categories WHERE category_key = ?", [leaveType]);
  return rows.length > 0;
}

// Human label for a Leave Type — fixed types use the same static labels
// every caller used to hardcode; a custom category looks up its stored
// label (falling back to the raw key itself if it's somehow gone missing,
// e.g. deleted after an application already referenced it).
async function getLeaveTypeLabel(leaveType: string): Promise<string> {
  if (leaveType === "casual") return "Casual";
  if (leaveType === "sick") return "Sick";
  if (leaveType === "without_pay") return "Leave Without Pay";
  const rows = await queryDB("SELECT id, category_key, label FROM leave_categories WHERE category_key = ?", [leaveType]);
  return rows[0]?.label || leaveType;
}

// This account's current balance for a Leave Type — fixed types read the
// matching leave_balances column; a custom category reads its
// leave_category_balances row (0 if that account has never had one set).
async function getLeaveTypeBalance(userId: number, leaveType: string): Promise<number> {
  if (isFixedLeaveType(leaveType)) {
    const balanceColumn = leaveType === "casual" ? "casual_leave" : leaveType === "sick" ? "sick_leave" : "leave_without_pay";
    const rows = await queryDB("SELECT * FROM leave_balances WHERE user_id = ?", [userId]);
    return rows.length > 0 ? Number(rows[0][balanceColumn]) : 0;
  }
  const catRows = await queryDB("SELECT id, category_key, label FROM leave_categories WHERE category_key = ?", [leaveType]);
  if (catRows.length === 0) return 0;
  const balRows = await queryDB("SELECT * FROM leave_category_balances WHERE user_id = ?", [userId]);
  const row = balRows.find((b: any) => Number(b.category_id) === Number(catRows[0].id));
  return row ? Number(row.balance) : 0;
}

// Adds `delta` days to an account's balance for a Leave Type (negative delta
// to deduct at submission time, positive to refund on reject) — fixed types
// update the leave_balances row (insert one if it's never had one), a
// custom category upserts its leave_category_balances row. Shared by submit,
// reject (both the Dynamic Approval Engine path and the legacy
// approver-picked decision route), so a day_count is always moved the exact
// same way regardless of which kind of Leave Type it's for.
async function adjustLeaveTypeBalance(userId: number, leaveType: string, delta: number): Promise<void> {
  if (isFixedLeaveType(leaveType)) {
    const balanceColumn = leaveType === "casual" ? "casual_leave" : leaveType === "sick" ? "sick_leave" : "leave_without_pay";
    const rows = await queryDB("SELECT * FROM leave_balances WHERE user_id = ?", [userId]);
    const casual = Number(rows[0]?.casual_leave || 0) + (balanceColumn === "casual_leave" ? delta : 0);
    const sick = Number(rows[0]?.sick_leave || 0) + (balanceColumn === "sick_leave" ? delta : 0);
    const lwp = Number(rows[0]?.leave_without_pay || 0) + (balanceColumn === "leave_without_pay" ? delta : 0);
    if (rows.length > 0) {
      await queryDB("UPDATE leave_balances SET casual_leave = ?, sick_leave = ?, leave_without_pay = ? WHERE user_id = ?", [
        casual,
        sick,
        lwp,
        userId
      ]);
    } else {
      await queryDB("INSERT INTO leave_balances (user_id, casual_leave, sick_leave, leave_without_pay) VALUES (?, ?, ?, ?)", [
        userId,
        casual,
        sick,
        lwp
      ]);
    }
    return;
  }
  const catRows = await queryDB("SELECT id, category_key, label FROM leave_categories WHERE category_key = ?", [leaveType]);
  if (catRows.length === 0) return; // Shouldn't happen — isValidLeaveType already checked at submission time.
  const categoryId = Number(catRows[0].id);
  const balRows = await queryDB("SELECT * FROM leave_category_balances WHERE user_id = ?", [userId]);
  const existing = balRows.find((b: any) => Number(b.category_id) === categoryId);
  const next = Number(existing?.balance || 0) + delta;
  await queryDB(
    "INSERT INTO leave_category_balances (user_id, category_id, balance) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE balance = VALUES(balance)",
    [userId, categoryId, next]
  );
}

async function finalizeLeaveApplicationApproval(leaveId: number, approvedBy: number | null, remarks: string | null) {
  const rows = await queryDB("SELECT * FROM leave_applications WHERE id = ?", [leaveId]);
  if (rows.length === 0) throw new Error("Leave Application not found");
  const application = rows[0];
  if (application.status !== "pending") throw new Error("This Leave Application has already been reviewed.");

  await queryDB("UPDATE leave_applications SET status = 'approved', remarks = ?, decided_by = ?, decided_at = NOW() WHERE id = ?", [
    remarks,
    approvedBy,
    leaveId
  ]);

  const leaveTypeLabel = await getLeaveTypeLabel(application.leave_type);
  await createAlert(queryDB, {
    userId: application.user_id,
    type: "leave_application",
    title: "Leave Application Approved",
    message: `Your ${leaveTypeLabel} Leave (${toDateOnlyString(application.start_date)} to ${toDateOnlyString(application.end_date)}) has been approved.`,
    relatedType: "leave_application",
    relatedId: application.id
  });

  // Days whose salary already went out as Absent are paid back next month
  // (PayrollRoutes.ts arrearForLateLeave). Best-effort — never fails the approval.
  try {
    const arrears = await arrearForLateLeave(leaveId, approvedBy);
    const tk = (n: number) => `\u09f3${n.toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const ml = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    for (const a of arrears) {
      await createAlert(queryDB, {
        userId: application.user_id,
        type: "leave_application",
        title: "Salary Deduction Will Be Paid Back",
        message: `${a.days} day${a.days === 1 ? "" : "s"} cut as Absent from your ${ml(a.for_month)} salary (${tk(a.amount)}) will be paid back with your ${ml(a.start_month)} salary as an Arrear.`,
        relatedType: "leave_application",
        relatedId: application.id
      });
    }
  } catch (err: any) {
    console.warn("⚠️ Could not add the salary arrear for Leave #" + leaveId + ": " + err.message);
  }
}

// Rejects a Leave Application at ANY step (Part 5 of 5) — refunds day_count
// back to the applicant's leave_balances row for that Leave Type, since it
// was deducted up front at submission and was never actually taken. Shared
// by the same two callers as finalizeLeaveApplicationApproval above.
async function rejectLeaveApplicationRecord(leaveId: number, rejectedBy: number | null, remarks: string | null) {
  const rows = await queryDB("SELECT * FROM leave_applications WHERE id = ?", [leaveId]);
  if (rows.length === 0) throw new Error("Leave Application not found");
  const application = rows[0];
  if (application.status !== "pending") throw new Error("This Leave Application has already been reviewed.");

  await adjustLeaveTypeBalance(application.user_id, application.leave_type, Number(application.day_count));

  await queryDB("UPDATE leave_applications SET status = 'rejected', remarks = ?, decided_by = ?, decided_at = NOW() WHERE id = ?", [
    remarks,
    rejectedBy,
    leaveId
  ]);

  const leaveTypeLabel = await getLeaveTypeLabel(application.leave_type);
  await createAlert(queryDB, {
    userId: application.user_id,
    type: "leave_application",
    title: "Leave Application Rejected",
    message: `Your ${leaveTypeLabel} Leave (${toDateOnlyString(application.start_date)} to ${toDateOnlyString(application.end_date)}) was rejected.${
      remarks ? ` Reason: ${remarks}` : ""
    }`,
    relatedType: "leave_application",
    relatedId: application.id
  });
}

// Reliever workflow — a just-submitted Leave Application with a reliever_id
// sits with reliever_status 'pending' and is NOT yet handed to the Dynamic
// Approval Engine (no approval_requests row exists for it yet). Called by
// POST /api/leave-applications/:id/reliever-decision once the picked
// Reliever Approves: flips reliever_status to 'approved', then hands off to
// createTemplateApprovalRequest exactly the way POST /api/leave-applications
// itself would have if there'd been no Reliever at all — auto-approving via
// finalizeLeaveApplicationApproval when the applicant has no Template
// assigned, otherwise leaving it 'pending' on the Template's first Layer.
// Tells whoever a just-routed Leave Application is now sitting with (the
// Supervisor, or the Template's first Layer) that it's waiting on them —
// same idea as the Conveyance Bill Claim submit alert. Best-effort.
async function notifyLeaveFirstApprovers(leaveId: number) {
  try {
    const [appRows, requestRows] = await Promise.all([
      queryDB("SELECT * FROM leave_applications WHERE id = ?", [leaveId]),
      queryDB("SELECT * FROM approval_requests WHERE source_type = ?", ["leave_application"])
    ]);
    const application = appRows[0];
    const request = requestRows.find((r: any) => Number(r.source_id) === Number(leaveId) && r.status === "pending");
    if (!application || !request) return;
    const applicantRows = await queryDB("SELECT id, name FROM users WHERE id = ?", [application.user_id]);
    const applicantName = applicantRows[0]?.name || "An employee";
    const leaveTypeLabel = await getLeaveTypeLabel(application.leave_type);
    const approvers = await getCurrentStepApprovers(request);
    for (const approver of approvers) {
      await createAlert(queryDB, {
        userId: approver.user_id,
        type: "leave_approval",
        title: "Leave Application Awaiting Your Approval",
        message: `${applicantName} applied for ${leaveTypeLabel} Leave (${toDateOnlyString(application.start_date)} to ${toDateOnlyString(application.end_date)}). Please review it.`,
        relatedType: "leave_application",
        relatedId: Number(leaveId)
      });
    }
  } catch (err: any) {
    console.warn("⚠️ Could not notify the approver(s) for Leave Application #" + leaveId + ": " + err.message);
  }
}

async function approveLeaveApplicationReliever(leaveId: number, relieverUserId: number, remarks: string | null) {
  const rows = await queryDB("SELECT * FROM leave_applications WHERE id = ?", [leaveId]);
  if (rows.length === 0) throw new Error("Leave Application not found");
  const application = rows[0];
  if (application.status !== "pending") throw new Error("This Leave Application has already been reviewed.");
  if (application.reliever_status !== "pending") throw new Error("You've already reviewed this Leave Application.");

  await queryDB(
    "UPDATE leave_applications SET reliever_status = 'approved', reliever_remarks = ?, reliever_decided_by = ?, reliever_decided_at = NOW() WHERE id = ?",
    [remarks, relieverUserId, leaveId]
  );

  const { autoApproved } = await createTemplateApprovalRequest("leave", "leave_application", leaveId, application.user_id);
  if (autoApproved) {
    await finalizeLeaveApplicationApproval(leaveId, relieverUserId, "Auto-approved (no Approval Template configured for Leave) after Reliever approval.");
  } else {
    const leaveTypeLabel = await getLeaveTypeLabel(application.leave_type);
    await createAlert(queryDB, {
      userId: application.user_id,
      type: "leave_application",
      title: "Reliever Approved Your Leave Application",
      message: `Your Reliever approved your ${leaveTypeLabel} Leave (${toDateOnlyString(application.start_date)} to ${toDateOnlyString(application.end_date)}). It's now with the Approval Workflow.`,
      relatedType: "leave_application",
      relatedId: application.id
    });
    await notifyLeaveFirstApprovers(leaveId);
  }
}

// Reliever Rejects — ends the application immediately, same as a normal
// Template-step Reject (refunds day_count, notifies the applicant), reusing
// rejectLeaveApplicationRecord itself since the application is still fully
// 'pending' at this point (no approval_requests row was ever created). Also
// stamps the reliever_* columns so the applicant/admin views can show it was
// specifically the Reliever who declined.
async function rejectLeaveApplicationReliever(leaveId: number, relieverUserId: number, remarks: string | null) {
  const rows = await queryDB("SELECT * FROM leave_applications WHERE id = ?", [leaveId]);
  if (rows.length === 0) throw new Error("Leave Application not found");
  const application = rows[0];
  if (application.status !== "pending") throw new Error("This Leave Application has already been reviewed.");
  if (application.reliever_status !== "pending") throw new Error("You've already reviewed this Leave Application.");

  await rejectLeaveApplicationRecord(leaveId, relieverUserId, remarks);
  await queryDB(
    "UPDATE leave_applications SET reliever_status = 'rejected', reliever_remarks = ?, reliever_decided_by = ?, reliever_decided_at = NOW() WHERE id = ?",
    [remarks, relieverUserId, leaveId]
  );
}

// Seed the Superadmin account strictly from .env (ADMIN_NAME, ADMIN_EMAIL,
// ADMIN_PASSWORD). This is the ONLY way a 'superadmin' account is ever created —
// there is no API route that grants the superadmin role. From here, the
// Superadmin creates/promotes Admins and Users, and sets each Admin's module
// access, from the Admin Panel -> Users tab.
async function seedAdminFromEnv() {
  const adminName = process.env.ADMIN_NAME || "System Admin";
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    console.warn("⚠️ ADMIN_EMAIL / ADMIN_PASSWORD not set in .env — no superadmin account will be created. Please set them and restart.");
    return;
  }

  const password_hash = await bcrypt.hash(adminPassword, 10);

  if (isMySQLConnected && dbPool) {
    const existing: any = await queryDB("SELECT id, role FROM users WHERE email = ?", [adminEmail]);
    if (existing.length === 0) {
      await queryDB(
        "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'superadmin')",
        [adminName, adminEmail, password_hash]
      );
      console.log(`✅ Superadmin account created from .env: ${adminEmail}`);
    } else {
      // Keep the account in sync with .env (name + password). Role is only forced
      // back to 'superadmin' the first time — if it somehow got changed we still
      // guarantee at least one superadmin exists to administer the system.
      await queryDB(
        "UPDATE users SET name = ?, password_hash = ?, role = 'superadmin' WHERE email = ?",
        [adminName, password_hash, adminEmail]
      );
      console.log(`✅ Superadmin account synced from .env: ${adminEmail}`);
    }
    // Multi-company: the .env account is the system owner — in the original
    // (Credence) workspace and the one who manages every workspace.
    await queryDB("UPDATE users SET group_id = 1, is_platform_admin = 1 WHERE email = ?", [adminEmail]).catch((err: any) =>
      console.warn("⚠️ Could not mark the .env Superadmin as system owner: " + err.message)
    );
  } else {
    const existing = memoryDb.users.find(u => u.email === adminEmail);
    if (!existing) {
      memoryDb.users.push({
        id: memoryDb.users.length + 1,
        name: adminName,
        email: adminEmail,
        password_hash,
        role: "superadmin",
        created_at: new Date()
      });
      console.log(`✅ Superadmin account created from .env (in-memory): ${adminEmail}`);
    } else {
      existing.name = adminName;
      existing.password_hash = password_hash;
      existing.role = "superadmin";
    }
  }
}

// Database Helper wrapper
// Chunked multi-row INSERT for bulk-loading reference data (e.g. the Rate File import,
// which can be several thousand rows) — far fewer round-trips than one INSERT per row.
async function bulkInsert(table: string, columns: string[], rows: any[][], chunkSize = 500) {
  if (!dbPool || rows.length === 0) return;
  // Multi-company: the rows belong to the active group / company.
  const scope = scopeColumnsFor(table);
  if (scope && !columns.includes(scope.col)) {
    columns = [...columns, scope.col];
    rows = rows.map((r) => [...r, scope.val]);
  }
  const colList = columns.join(", ");
  const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => rowPlaceholder).join(", ");
    await dbPool.execute(`INSERT INTO ${table} (${colList}) VALUES ${placeholders}`, chunk.flat());
  }
}

// PEPM (budgets, MPR entries, jobs, rate file…) is used only by the original
// group (Credence); other workspaces never see it.
const PEPM_GROUP_ID = 1;
function pepmEnabled(groupId: number) {
  return Number(groupId) === PEPM_GROUP_ID;
}
// Admin Dashboard (Quick View, attendance and leave figures) in the mother
// company covers every company of its group: the dashboard asks for these
// reads with "X-Company-Scope: group", honoured only while working in the
// mother company, and only for a Superadmin or an account given "See all
// companies (group view)" (users.can_view_group_dashboard, Module Access ->
// under Admin Dashboard) that may open the Admin Dashboard. Each route still
// applies its own module checks.
const DASHBOARD_GROUP_SCOPE_PATHS = new Set(["/api/employee-directory", "/api/attendance/report/monthly", "/api/leave-applications/report"]);
async function canViewGroupDashboard(userId: number, role: string): Promise<boolean> {
  try {
    const rows: any[] = (await queryDB("SELECT can_view_group_dashboard FROM users WHERE id = ?", [userId])) || [];
    if (!Number(rows[0]?.can_view_group_dashboard || 0)) return false;
    if (role === "admin") return true;
    return role === "user" && (await getAdminModules(userId)).includes("admin_dashboard");
  } catch {
    return false;
  }
}

const PEPM_API_RE = /^\/api\/(budgets|budget-items|entries|jobs|job-edits|mpr-numbers|rate-file|rate-list|delivery-date-conditions|reports\/budget-submission-status)(\/|$)/;

// dbPool.execute with the same multi-company separation as queryDB.
function scopedExecute(sql: string, params?: any[]) {
  return dbPool.execute(scopeSql(sql), params);
}

// One MySQL transaction on its own connection (unscoped — the caller picks
// the rows).
const withDbTransaction = async (fn: (q: (sql: string, params?: any[]) => Promise<any>) => Promise<void>) => {
  if (!isMySQLConnected || !dbPool) throw Object.assign(new Error("Deleting needs the MySQL database."), { statusCode: 503 });
  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();
    await fn(async (sql, params = []) => (await conn.query(sql, params))[0]);
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
};

async function queryDB(sql: string, params: any[] = []): Promise<any> {
  if (isMySQLConnected && dbPool) {
    // Multi-company: keep each company's rows apart (companyScope.ts).
    sql = scopeSql(sql);
    try {
      const [rows] = await dbPool.execute(sql, params);
      return rows;
    } catch (err) {
      console.error("MySQL query error:", err);
      throw err;
    }
  } else {
    return queryMemoryDb(sql, params);
  }
}

// Find-or-create a Project by name (case-insensitive). Used by Budget Excel import.
async function findOrCreateProject(projectName: string, userId: number): Promise<{ id: number | null; created: boolean }> {
  const trimmed = projectName.trim();
  if (!trimmed) return { id: null, created: false };
  const existing = await queryDB("SELECT id FROM projects WHERE LOWER(project_name) = LOWER(?)", [trimmed]);
  if (existing.length > 0) return { id: existing[0].id, created: false };
  try {
    const result = await queryDB("INSERT INTO projects (project_name, created_by) VALUES (?, ?)", [trimmed, userId]);
    return { id: result.insertId, created: true };
  } catch {
    // Race condition (duplicate key) — someone else inserted it first, fetch and use that.
    const retry = await queryDB("SELECT id FROM projects WHERE LOWER(project_name) = LOWER(?)", [trimmed]);
    if (retry.length > 0) return { id: retry[0].id, created: false };
    return { id: null, created: false };
  }
}

// Find-or-create an MPR No (case-insensitive). Used by Budget Excel import.
async function findOrCreateMpr(mprNo: string, userId: number): Promise<{ id: number | null; created: boolean }> {
  const trimmed = mprNo.trim();
  if (!trimmed) return { id: null, created: false };
  const existing = await queryDB("SELECT id FROM mpr_numbers WHERE LOWER(mpr_no) = LOWER(?)", [trimmed]);
  if (existing.length > 0) return { id: existing[0].id, created: false };
  try {
    const result = await queryDB("INSERT INTO mpr_numbers (mpr_no, created_by) VALUES (?, ?)", [trimmed, userId]);
    return { id: result.insertId, created: true };
  } catch {
    // Race condition (duplicate key) — someone else inserted it first, fetch and use that.
    const retry = await queryDB("SELECT id FROM mpr_numbers WHERE LOWER(mpr_no) = LOWER(?)", [trimmed]);
    if (retry.length > 0) return { id: retry[0].id, created: false };
    return { id: null, created: false };
  }
}

async function startServer() {
  await initDB();
  await seedAdminFromEnv();

  const app = express();
  // Sitting behind Nginx (see deploy/nginx.conf.example) once deployed that
  // way — without this, req.ip/req.secure would reflect the proxy's own
  // connection to this app rather than the real client, for anything that
  // ever comes to depend on it (rate limiting, audit logging, etc.). A
  // no-op when there's no reverse proxy in front (e.g. local `npm run dev`).
  app.set("trust proxy", 1);
  app.use(cors());
  // Gzips every response this server sends — HTML, JSON API responses, and
  // (most importantly for how long the APK/browser takes to first load) the
  // built JS/CSS bundle. Without this, the ~3MB main JS chunk was being sent
  // to the phone completely uncompressed; gzip shrinks that to roughly a
  // quarter on the wire, which is the single biggest lever available for
  // "the login page takes a long time to load" on a mobile connection.
  app.use(compression());
  // Raised from Express's 100kb default so a Budget Excel file (sent as base64 in the
  // import request) doesn't get rejected before it reaches the route handler.
  app.use(express.json({ limit: "25mb" }));

  // --- Auth Middleware ---
  const authenticateToken = (req: any, res: any, next: any) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Access token required" });

    jwt.verify(token, JWT_SECRET, async (err: any, user: any) => {
      if (err) return res.status(403).json({ error: "Invalid or expired token" });
      // A phone the Superadmin removed from this account is signed out.
      if (user?.dev && !(await deviceStillAllowed(queryDB, Number(user.dev)))) {
        res.setHeader("X-Device-Revoked", "1");
        return res.status(401).json({ error: "This phone was removed from your account. Sign in again.", code: "DEVICE_REVOKED" });
      }
      // A blocked account (Admin Panel -> Users -> Block, or an approved
      // Termination) is signed out of every session it still has — and so is
      // a token whose account no longer exists (deleted, or a reset database).
      const state = user?.id ? await accountState(queryDB, Number(user.id)) : "ok";
      if (state === "blocked") {
        res.setHeader("X-Account-Blocked", "1");
        return res.status(401).json({ error: "This account has been blocked. Contact HR.", code: "ACCOUNT_BLOCKED" });
      }
      if (state === "removed") {
        res.setHeader("X-Account-Blocked", "removed");
        return res.status(401).json({ error: "This account no longer exists. Sign in again.", code: "ACCOUNT_REMOVED" });
      }
      req.user = user;
      // Admin Panel -> Active Users: this sign-in's IP, device and last use.
      touchSession(queryDB, req, token, user);
      // Multi-company: the rest of this request runs in the company the app
      // asked for (X-Company-Id), if this account may enter it — see
      // companyContext.ts / CompanyRoutes.ts.
      let ctx: CompanyContext = { companyId: 1, groupId: 1 };
      try {
        ctx = await resolveCompanyContext(queryDB, user, req.headers["x-company-id"]);
      } catch {
        // falls back to company 1, same as before multi-company
      }
      req.companyId = ctx.companyId;
      req.groupId = ctx.groupId;
      if (!pepmEnabled(ctx.groupId) && PEPM_API_RE.test(String(req.originalUrl || req.url || "").split("?")[0])) {
        return res.status(403).json({ error: "PEPM is not available in this workspace." });
      }
      if (
        req.method === "GET" &&
        req.headers["x-company-scope"] === "group" &&
        ctx.motherId &&
        ctx.companyId === ctx.motherId &&
        DASHBOARD_GROUP_SCOPE_PATHS.has(String(req.originalUrl || req.url || "").split("?")[0]) &&
        (user.role === "superadmin" || (await canViewGroupDashboard(Number(user.id), user.role)))
      ) {
        ctx = { ...ctx, wholeGroup: true };
      }
      companyStore.run(ctx, () => next());
    });
  };

  // A Superadmin can do everything an Admin can (plus Superadmin-only actions
  // gated separately by requireSuperAdmin below), so it always passes here too.
  // A plain User also passes IF the Superadmin has granted them at least one
  // Admin Panel module (admin_module_permissions) via the same "Module Access"
  // control used for Admins — requireModule below then checks the SPECIFIC
  // module for the route being called. A User with no grants at all is still
  // blocked here, same as before this feature existed.
  const requireAdmin = async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(403).json({ error: "Admin access required" });
    if (req.user.role === "admin" || req.user.role === "superadmin") return next();
    if (req.user.role === "user") {
      try {
        const modules = await getAdminModules(req.user.id);
        if (modules.length > 0) return next();
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    }
    return res.status(403).json({ error: "Admin access required" });
  };

  // Superadmin-only actions: promoting/demoting a User <-> Admin, and every
  // per-feature access toggle in Admin Panel -> Users (Attend./Tracking/Leave
  // Summary/etc., and Module Access UNLESS delegated — see
  // requireModuleGrantAccess just below for that one exception). Never granted
  // through the API — only the .env-seeded account (see seedAdminFromEnv) is
  // ever a superadmin.
  const requireSuperAdmin = (req: any, res: any, next: any) => {
    if (!req.user || req.user.role !== "superadmin") {
      return res.status(403).json({ error: "Superadmin access required" });
    }
    next();
  };

  // Gate for GET/PUT /api/users/:id/module-permissions ("Module Access" — which
  // Admin Panel tabs a given Admin/User may reach): a Superadmin always passes;
  // a plain Admin passes only once the Superadmin has explicitly switched on
  // can_grant_module_access for THEIR account (see the ALTER TABLE in
  // ensureDatabaseSchema for the full explanation). Passing this gate is not the
  // whole story — the handler itself still blocks a delegated (non-superadmin)
  // Admin from touching a role='admin' or 'superadmin' target, so a delegated
  // Admin can only ever grant/revoke Module Access for a plain 'user' account.
  const requireModuleGrantAccess = async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Access token required" });
    if (req.user.role === "superadmin") return next();
    try {
      // The JWT payload only ever carries id/email/username/role/name (see
      // authenticateToken above) — this flag isn't in it, so it's read fresh
      // here rather than trusted off req.user.
      const rows: any = await queryDB("SELECT can_grant_module_access FROM users WHERE id = ?", [req.user.id]);
      if (rows.length > 0 && !!Number(rows[0].can_grant_module_access)) return next();
      return res.status(403).json({ error: "You don't have access to set Module Access. Ask your Superadmin to grant it." });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  // Per-module gate for an Admin or a module-granted User (a Superadmin always
  // passes, since they implicitly have every module). Use AFTER requireAdmin on
  // any admin route that belongs to one of the Admin Panel tabs, so the
  // Superadmin's per-account module grants (admin_module_permissions) are
  // actually enforced server-side, not just hidden in the UI.
  const requireModule = (moduleKey: AdminModuleKey) => async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Access token required" });
    if (req.user.role === "superadmin") return next();
    if (req.user.role !== "admin" && req.user.role !== "user") return res.status(403).json({ error: "Admin access required" });
    try {
      const modules = await getAdminModules(req.user.id);
      if (!modules.includes(moduleKey)) {
        return res.status(403).json({ error: "You don't have access to this section. Ask your Superadmin to grant it." });
      }
      next();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  // Same as requireModule, but passes if the account has ANY of the given
  // modules — used where two separate Admin Panel tabs legitimately need to
  // read the same underlying data (e.g. Conveyance Bill Claim and Conveyance
  // Disbursement both list conveyance_bills), without forcing an Admin who
  // only has one of the two to also be granted the other.
  const requireAnyModule = (moduleKeys: AdminModuleKey[]) => async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Access token required" });
    if (req.user.role === "superadmin") return next();
    if (req.user.role !== "admin" && req.user.role !== "user") return res.status(403).json({ error: "Admin access required" });
    try {
      const modules = await getAdminModules(req.user.id);
      if (!moduleKeys.some((k) => modules.includes(k))) {
        return res.status(403).json({ error: "You don't have access to this section. Ask your Superadmin to grant it." });
      }
      next();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  // Per-module ACTION gate (Read Only/Edit-Add/Entry-Upload/Delete-Trash/
  // Permanent Delete — see PERMISSION_LAYER_KEYS above), layered on top of
  // requireModule(moduleKey): a Superadmin always passes; an Admin/User must
  // already have moduleKey itself granted (same check requireModule does)
  // AND, if that module is one of PERMISSION_LAYER_MODULES, have `layer`
  // explicitly granted too. A module NOT in PERMISSION_LAYER_MODULES yet
  // ignores `layer` entirely (unaffected, old coarse on/off behavior). For a
  // module that IS in PERMISSION_LAYER_MODULES but has NO layer rows at all
  // recorded for this account, falls back to "every layer except
  // permanent_delete" — preserves full access for every account already
  // granted that module before this feature existed, so turning this system
  // on for a module is never a silent regression; a Superadmin only actually
  // restricts anything once they explicitly save a narrower set in the
  // Module Access modal.
  const requireModuleLayer = (moduleKey: AdminModuleKey, layer: typeof PERMISSION_LAYER_KEYS[number] | "submission_status" | "stay_report" | "live" | "salary_month" | "salary_hold" | "audit_approve" | "accounts_pay" | "access_log" | "block_account" | "limit_history" | "link_pins" | "on_behalf") =>
    async (req: any, res: any, next: any) => {
      if (!req.user) return res.status(401).json({ error: "Access token required" });
      if (req.user.role === "superadmin") return next();
      if (req.user.role !== "admin" && req.user.role !== "user") return res.status(403).json({ error: "Admin access required" });
      try {
        const modules = await getAdminModules(req.user.id);
        if (!modules.includes(moduleKey)) {
          return res.status(403).json({ error: "You don't have access to this section. Ask your Superadmin to grant it." });
        }
        if (!(PERMISSION_LAYER_MODULES as readonly string[]).includes(moduleKey)) return next();
        const grantedLayers = await getModulePermissionLayersForModule(req.user.id, moduleKey);
        const effectiveLayers: string[] = grantedLayers.length > 0
          ? grantedLayers
          : moduleKey === "tracking"
            ? [...TRACKING_DEFAULT_LAYERS]
            : moduleKey === "payroll" || moduleKey === "office_attendance" || moduleKey === "conveyance"
              ? ["read"]
              : moduleKey === "mobile_bill"
                ? [...MOBILE_BILL_LAYER_KEYS]
                : PERMISSION_LAYER_KEYS.filter((k) => k !== "permanent_delete");
        if (!effectiveLayers.includes(layer)) {
          return res.status(403).json({ error: "You don't have permission to do this. Ask your Superadmin to grant it." });
        }
        next();
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    };

  // Same rule as requireModuleLayer, as a yes/no for a page that shows or
  // hides a control (e.g. Payroll's salary month setting).
  const hasModuleLayer = async (user: any, moduleKey: AdminModuleKey, layer: string): Promise<boolean> => {
    if (!user) return false;
    if (user.role === "superadmin") return true;
    if (user.role !== "admin" && user.role !== "user") return false;
    const modules = await getAdminModules(user.id);
    if (!modules.includes(moduleKey)) return false;
    if (!(PERMISSION_LAYER_MODULES as readonly string[]).includes(moduleKey)) return true;
    const granted = await getModulePermissionLayersForModule(user.id, moduleKey);
    if (granted.length > 0) return granted.includes(layer);
    const defaults: readonly string[] =
      moduleKey === "tracking"
        ? TRACKING_DEFAULT_LAYERS
        : moduleKey === "payroll" || moduleKey === "office_attendance" || moduleKey === "conveyance"
          ? ["read"]
          : moduleKey === "mobile_bill"
            ? MOBILE_BILL_LAYER_KEYS
            : PERMISSION_LAYER_KEYS.filter((k) => k !== "permanent_delete");
    return defaults.includes(layer);
  };

  // Personal Data / profile-photo routes — kept in their own file
  // (profileRoutes.ts) instead of growing this already-huge file further.
  registerProfileRoutes(app, { authenticateToken, queryDB });

  // Global Calendar (Weekend/Holiday) routes — kept in their own file
  // (holidayRoutes.ts), same reasoning as profileRoutes.ts above.
  registerHolidayRoutes(app, { authenticateToken, requireAdmin, requireModule, queryDB });

  // Personal Alerts (bell icon) — kept in their own file (Alerts.ts), same
  // reasoning as profileRoutes.ts/holidayRoutes.ts above. No requireModule
  // gate: on by default for every account, not a Superadmin-granted module.
  registerAlertRoutes(app, { authenticateToken, queryDB });

  // User Management (Admin Panel -> Users) — kept in their own file
  // (UserManagement.ts), same reasoning as profileRoutes.ts/holidayRoutes.ts/
  // Alerts.ts above.
  registerUserManagementRoutes(app, { authenticateToken, requireAdmin, requireSuperAdmin, requireModuleGrantAccess, requireModule, requireModuleLayer, queryDB, adminModuleKeys: ADMIN_MODULE_KEYS, moduleLayerKeySets: MODULE_LAYER_KEY_SETS });

  // Departments (Admin Panel -> Departments) + Branches (Admin Panel ->
  // Branches) — kept in their own file (DepartmentsAndBranches.ts), same
  // reasoning as profileRoutes.ts/holidayRoutes.ts/Alerts.ts/UserManagement.ts
  // above.
  registerDepartmentsAndBranchesRoutes(app, { authenticateToken, requireAdmin, requireModule, requireModuleLayer, queryDB });

  // Admin Panel -> Users -> Block / Unblock a login (AccountBlock.ts).
  registerAccountBlockRoutes(app, { authenticateToken, requireAdmin, requireModule, requireModuleLayer, queryDB });

  // Self Service -> Leave Management: true for a Superadmin (implicit, every
  // account), or for an Admin/User the Superadmin has explicitly granted
  // can_manage_leave to (PUT /api/users/:id/leave-management-access). Not
  // encoded in the JWT (see jwt.sign in POST /api/auth/login), so this always
  // does one small DB lookup rather than trusting a stale token claim.
  const hasLeaveManageAccess = async (userId: number, role: string): Promise<boolean> => {
    if (role === "superadmin") return true;
    try {
      const rows: any = await queryDB("SELECT can_manage_leave FROM users WHERE id = ?", [userId]);
      return rows.length > 0 && !!Number(rows[0].can_manage_leave);
    } catch {
      return false;
    }
  };

  // Movement Claim (GPS Check In/Out) self-service routes: a Superadmin always
  // passes; an Admin/User passes only once granted can_view_movement_claims (PUT
  // /api/users/:id/movement-claim-access). Enforced here so the routes are
  // actually blocked server-side, not just hidden on the User Panel — same
  // pattern as requireModule above, applied to a per-account toggle instead of
  // admin_module_permissions.
  const requireMovementClaimAccess = async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Access token required" });
    if (req.user.role === "superadmin") return next();
    try {
      const rows: any = await queryDB("SELECT can_view_movement_claims FROM users WHERE id = ?", [req.user.id]);
      if (rows.length > 0 && !!Number(rows[0].can_view_movement_claims)) return next();
      return res.status(403).json({ error: "You don't have access to Movement Claim. Ask your Superadmin to grant it." });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  // Conveyance Bill Claim self-service routes — same pattern as
  // requireMovementClaimAccess above, gated by can_view_conveyance_claims.
  // Anyone holding the Bill Claim ("conveyance") Admin module also passes, so
  // they file / see their own claims from Self Service like everyone else.
  const requireConveyanceClaimAccess = async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Access token required" });
    if (req.user.role === "superadmin") return next();
    try {
      const rows: any = await queryDB("SELECT can_view_conveyance_claims FROM users WHERE id = ?", [req.user.id]);
      if (rows.length > 0 && !!Number(rows[0].can_view_conveyance_claims)) return next();
      if ((await getAdminModules(req.user.id)).includes("conveyance")) return next();
      return res.status(403).json({ error: "You don't have access to Conveyance Bill Claim. Ask your Superadmin to grant it." });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  // Budget/Jobs/Job Entry Details self-service routes: same pattern as
  // requireMovementClaimAccess above, gated by can_view_budget_module (ON by
  // default — see the ALTER TABLE above — so this only actually blocks
  // accounts a Superadmin has explicitly turned it off for). Applied only to
  // the unambiguous "User creating their own MPR data" write routes below
  // (new Job/MPR entry, Budget submission) — the GET list routes and the
  // existing-Job "/items" route stay ungated since Admin Panel reporting and
  // the separately-gated Job Edit feature (can_job_edit) also depend on them.
  const requireBudgetModuleAccess = async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Access token required" });
    if (req.user.role === "superadmin") return next();
    try {
      const rows: any = await queryDB("SELECT can_view_budget_module FROM users WHERE id = ?", [req.user.id]);
      if (rows.length > 0 && !!Number(rows[0].can_view_budget_module)) return next();
      return res.status(403).json({ error: "You don't have access to Budget/Jobs. Ask your Superadmin to grant it." });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  // Gate for PUT /api/leave-balances/:userId — editing ANOTHER account's Leave
  // balances (a plain account with no grant can only ever read its own, via the
  // GET route's own-branch below, never write).
  const requireLeaveManager = async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Access token required" });
    try {
      const ok = await hasLeaveManageAccess(req.user.id, req.user.role);
      if (!ok) {
        return res.status(403).json({ error: "You don't have access to manage Leave balances. Ask your Superadmin to grant it." });
      }
      next();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  // Finer-grained gate layered on TOP of requireLeaveManager above — Leave
  // Manage isn't an Admin Panel "module" (no admin_module_permissions row;
  // access is the flat can_manage_leave boolean requireLeaveManager already
  // checks), so it can't reuse requireModuleLayer()'s getAdminModules()
  // check. Instead this reuses the SAME admin_module_permission_layers
  // storage/helpers (getModulePermissionLayersForModule) with the synthetic
  // module_key "leave_manage" — that table's module_key column is a free
  // string, not FK'd to AdminModuleKey, so this just works. Layer keys here
  // are operation-specific (see LEAVE_MANAGE_LAYER_KEYS), not the generic
  // Read/Edit-Add/Entry-Upload/Delete-Trash/Permanent-Delete set every other
  // module uses — Leave Manage's 4 writes don't map cleanly onto those.
  // Same "no saved rows -> full access" fallback as requireModuleLayer, so
  // granting can_manage_leave alone (today's only lever) keeps working
  // exactly as before until a Superadmin explicitly narrows it.
  const requireLeaveManagerLayer = (layer: typeof LEAVE_MANAGE_LAYER_KEYS[number]) => async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Access token required" });
    if (req.user.role === "superadmin") return next();
    try {
      const ok = await hasLeaveManageAccess(req.user.id, req.user.role);
      if (!ok) {
        return res.status(403).json({ error: "You don't have access to manage Leave balances. Ask your Superadmin to grant it." });
      }
      const grantedLayers = await getModulePermissionLayersForModule(req.user.id, "leave_manage");
      const effectiveLayers = grantedLayers.length > 0 ? grantedLayers : LEAVE_MANAGE_LAYER_KEYS;
      if (!effectiveLayers.includes(layer)) {
        return res.status(403).json({ error: "You don't have permission to do this. Ask your Superadmin to grant it." });
      }
      next();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  // --- API Routes ---

  // Sign-in routes (/api/auth/*) live in AuthRoutes.ts.
  registerAuthRoutes(app, { JWT_SECRET, authenticateToken, getAdminModules, getAllModulePermissionLayers, pepmEnabled, queryDB });

  // Projects routes live in ProjectRoutes.ts.
  registerProjectRoutes(app, { authenticateToken, queryDB, requireAdmin, requireModule, requireModuleLayer });

  // Remote Attendance (check-in/check-out, status, mine, corrections,
  // Admin list, and reports) now lives in AttendanceRoutes.ts — registered
  // below via registerAttendanceRoutes(), right after the other split-out
  // modules. ZK biometric device routes (office_attendance) are unaffected
  // and still live further down in this file.
  registerAttendanceRoutes(app, {
    authenticateToken,
    requireAdmin,
    requireModule,
    queryDB,
    haversineMeters,
    todayInDhaka,
    createApprovalRequest,
    createTemplateApprovalRequest,
    finalizeAttendanceCorrection,
    rejectAttendanceCorrection,
    attachApprovalStatuses,
    attachAttendanceCorrectionApproval,
    getAdminModules,
    getAttendanceReportDeptScope
  });

  // Employee Tracking — the APK's background service calls this roughly every
  // 5-10 minutes (foreground, minimized, or fully backgrounded) while the
  // account has can_use_tracking. Gate mirrors requireAttendanceAccess: a
  // Superadmin is implicit, everyone else needs the flag checked fresh against
  // the DB (an Admin can revoke mid-session).
  const requireTrackingAccess = async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: "Access token required" });
    if (req.user.role === "superadmin") return next();
    try {
      const rows: any = await queryDB("SELECT can_use_tracking FROM users WHERE id = ?", [req.user.id]);
      if (rows.length === 0 || !Number(rows[0].can_use_tracking)) {
        return res.status(403).json({ error: "You don't have access to Employee Tracking. Ask your Superadmin to grant it." });
      }
      next();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  // Live Follow (LiveTrackingRoutes.ts) — pushes each ping to whoever is
  // watching and tells the phone how long to keep pinging every few seconds.
  const liveTracking = registerLiveTrackingRoutes(app, {
    authenticateToken,
    requireAdmin,
    requireModule,
    requireModuleLayer,
    queryDB,
    getIo: () => liveIo
  });

  // A Notice was published (or brought back): open apps of its audience fetch
  // /api/notices/active again and show the popup at once (Socket.IO), and a
  // push notification reaches phones/browsers where the app isn't open —
  // tapping it opens the app on the popup. "all" pings every open app (the
  // fetch decides who actually sees it) and pushes to this company's users.
  async function announceNotice(noticeId: number, title: string, audience: number[] | "all", senderId: number) {
    try {
      if (liveIo) {
        if (audience === "all") liveIo.emit("notices:changed");
        else for (const uid of audience) liveIo.to(`user:${uid}`).emit("notices:changed");
      }
      const ids =
        audience === "all" ? ((await queryDB("SELECT id FROM users", [])) || []).map((u: any) => Number(u.id)) : audience.map(Number);
      if (ids.length === 0) return;
      await sendPushToUserIds(
        queryDB,
        ids,
        "New notice",
        String(title || "").slice(0, 120),
        { type: "notice", relatedType: "notice", relatedId: String(noticeId) },
        senderId
      );
    } catch (err: any) {
      console.warn("⚠️ Notice announce failed: " + err.message);
    }
  }

  // Employee Tracking routes live in EmployeeTrackingRoutes.ts.
  registerEmployeeTrackingRoutes(app, { announceNotice, authenticateToken, getAdminModules, liveTracking, queryDB, requireAdmin, requireModule, requireModuleLayer, requireTrackingAccess });

  // Office Attendance (ZKTeco) routes live in OfficeAttendanceRoutes.ts.
  registerOfficeAttendanceRoutes(app, { authenticateToken, dbPool, queryDB, requireAdmin, requireModule, requireModuleLayer, todayInDhaka });
  // Movement Claims routes live in MovementClaimRoutes.ts.
  registerMovementClaimRoutes(app, { authenticateToken, haversineMeters, queryDB, requireAdmin, requireModule, requireMovementClaimAccess, toDateOnlyString });

  // Payroll Module (Self Service -> Payroll / Admin Panel -> Payroll) — full
  // Salary Structure / Employee Advances / Payroll run workflow, kept in its
  // own file (PayrollRoutes.ts) from the start. Permission-gated like every
  // other module: requireModule('payroll') lets a Superadmin through
  // unconditionally and otherwise requires the 'payroll' grant in
  // admin_module_permissions (Admin Panel -> Users -> Module Access);
  // requireAdmin is layered in front of it the same way every other
  // Admin-Panel-gated module route in this file does.
  // Payroll -> Approval (HR -> Audit -> Accounts) and Activity Log. Registered
  // before every other payroll route: its logger has to see each /api/payroll
  // request, and its GET routes would otherwise be caught by GET /api/payroll/:id.
  registerPayrollApprovalRoutes(app, {
    authenticateToken,
    requireAdmin,
    requireModule: (k: "payroll") => requireModuleLayer(k, "read"),
    requireModuleLayer,
    hasModuleLayer,
    queryDB,
    createAlert
  });
  // Registered first: its /api/payroll/pay-items and /api/payroll/adjustments
  // would otherwise be caught by PayrollRoutes' GET /api/payroll/:id.
  registerPayrollItemsRoutes(app, { authenticateToken, requireAdmin, requireModule: (k: "payroll") => requireModuleLayer(k, "read"), queryDB });
  // Every existing payroll route needs the module's "read" layer (on by
  // default); the salary month setting needs "salary_month" (ticked only).
  registerPayrollRoutes(app, {
    authenticateToken,
    requireAdmin,
    requireModule: (k: "payroll") => requireModuleLayer(k, "read"),
    requireModuleLayer,
    hasModuleLayer,
    getAdminModules,
    queryDB
  });

  // Asset Management (Employee Profile -> My Assets / New Requisition /
  // Requisition Status, plus Admin Panel -> Asset Management) — kept in its
  // own file (AssetManagementRoutes.ts), same reasoning as
  // profileRoutes.ts/holidayRoutes.ts/Alerts.ts/PayrollRoutes.ts above. The
  // Line Manager approval step inside it is deliberately NOT gated by
  // requireModule — only the IT/Admin inventory + final-approval routes are,
  // via the new 'asset_management' AdminModuleKey (Admin Panel -> Users ->
  // Module Access).
  registerAssetManagementRoutes(app, {
    authenticateToken,
    requireAdmin,
    requireModule,
    queryDB,
    getAdminModules,
    createAlert,
    createTemplateApprovalRequest,
    getCurrentStepApprovers,
    isAssetFulfillerStep,
    finalizeAssetRequisitionApproval
  });

  // Vehicle Requisition & Management (Self Service -> Book a Ride / Ride
  // Status, plus Admin Panel -> Vehicle Management) — kept in its own file,
  // same reasoning as AssetManagementRoutes.ts above. Routed through the
  // same Dynamic Approval Engine as Asset Requisition (request_type
  // 'vehicle', a single "HR/Admin Review" Layer per the flowchart — see
  // LAYER_NAMES in ApprovalTemplateManager.tsx); approve/reject happens from
  // Admin Panel -> Approvals / "My Approvals" like every other module, and
  // this file's own PUT .../assign is only the post-approval "assign a
  // vehicle + driver" step (mirrors POST /api/assets/requisitions/:id/fulfill).
  registerVehicleManagementRoutes(app, {
    authenticateToken,
    requireAdmin,
    requireModule,
    queryDB,
    getAdminModules,
    createAlert,
    createTemplateApprovalRequest,
    getCurrentStepApprovers,
    isVehicleMaintainerStep,
    finalizeVehicleRequisitionApproval
  });

  // 360 ERP SSO (Sidebar -> "360 ERP") — kept in its own file, same reasoning
  // as AssetManagementRoutes.ts/PayrollRoutes.ts above.
  registerErp360SsoRoutes(app, {
    authenticateToken,
    queryDB
  });

  // Employee Transfer (Admin Panel -> Employees -> "Transfer / Change Role")
  // — kept in its own file (EmployeeTransferRoutes.ts), same reasoning as
  // AssetManagementRoutes.ts/PayrollRoutes.ts above. Lives under the existing
  // 'employees' module rather than a new AdminModuleKey.
  registerEmployeeTransferRoutes(app, {
    authenticateToken,
    requireAdmin,
    requireModule,
    queryDB,
    todayInDhaka
  });

  // World-class HRM extension modules (Exit/Offboarding, Performance
  // Management, Recruitment/ATS, Grievance & Disciplinary, HR Analytics,
  // Document Vault) — each its own AdminModuleKey, each in its own file,
  // same reasoning as every registerXRoutes call above.
  registerExitOffboardingRoutes(app, { authenticateToken, requireAdmin, requireModule, queryDB, getAdminModules, createAlert });
  registerPerformanceRoutes(app, { authenticateToken, requireAdmin, requireModule, queryDB, getAdminModules });
  registerRecruitmentRoutes(app, { authenticateToken, requireAdmin, requireModule, queryDB });
  registerGrievanceRoutes(app, { authenticateToken, requireAdmin, requireModule, queryDB, getAdminModules, createAlert });
  registerTaskRoutes(app, { authenticateToken, queryDB, getAdminModules, createAlert });
  // Mobile Bill (company SIMs, limits, bills, reports) — limit raise requests
  // ride the Dynamic Approval Engine (request_type 'mobile').
  // Employee Tracking -> Stay Report (time at each place, day by day).
  registerTrackingStayReportRoutes(app, { authenticateToken, requireAdmin, requireModule, requireModuleLayer, queryDB });
  registerMobileBillRoutes(app, { authenticateToken, queryDB, getAdminModules, createAlert, createTemplateApprovalRequest, getCurrentStepApprovers, hasModuleLayer });
  // Self Service loan / salary advance requests — ride the Dynamic Approval
  // Engine (request_type 'loan'); Payroll creates the loan.
  registerLoanRequestRoutes(app, { authenticateToken, queryDB, getAdminModules, createAlert, createTemplateApprovalRequest, getCurrentStepApprovers });
  registerHRAnalyticsRoutes(app, { authenticateToken, requireAdmin, requireModule, queryDB });
  registerDocumentVaultRoutes(app, { authenticateToken, requireAdmin, requireModule, queryDB, getAdminModules });
  registerHROperationsRoutes(app, { authenticateToken, requireAdmin, requireModule, queryDB, getAdminModules, todayInDhaka, createAlert });
  // Employee 360 (HR Operations -> Service Book): experience / education /
  // family / training records + every other module's data for one Employee.
  registerEmployee360Routes(app, { authenticateToken, requireModule, queryDB, getAdminModules, todayInDhaka });
  // Employee Reports: every Employee's 360 facts in one table, saved and
  // scheduled reports, previous-company name matching.
  registerHrReportsRoutes(app, { authenticateToken, requireModule, queryDB, getAdminModules, todayInDhaka, createAlert });
  // Reports & Insights: Attendance / Leave / Claim / Bill / Asset / Vehicle
  // reports in one place (ReportsInsightsRoutes.ts).
  // Admin Panel -> Data Import (DataImportRoutes.ts): employees, leave,
  // claims and attendance history from an Excel/CSV sheet; each kind needs
  // its own module (a Superadmin has them all).
  registerDataImportRoutes(app, { authenticateToken, requireAdmin, queryDB, getAdminModules, today: todayInDhaka });

  registerReportsInsightsRoutes(app, {
    authenticateToken,
    requireAdmin,
    queryDB,
    getAdminModules,
    todayInDhaka,
    getDeptScope: (kind, userId) =>
      kind === "attendance"
        ? getAttendanceReportDeptScope(userId)
        : kind === "leave"
          ? getLeaveApplicationDeptScope(userId)
          : getConveyanceClaimDeptScope(userId)
  });
  // Information requests: ask employees for missing documents / nominee /
  // emergency contact; HR approves each submission before it is recorded.
  registerInfoRequestRoutes(app, { authenticateToken, requireModule, queryDB, getAdminModules, todayInDhaka, createAlert });
  // Site Attendance — supervisor muster roll for people who never use the app
  // (SiteAttendanceRoutes.ts).
  // Multi-company: companies, who may enter which (CompanyRoutes.ts).
  registerCompanyRoutes(app, { authenticateToken, requireSuperAdmin, queryDB, getAdminModules, withTransaction: withDbTransaction });
  registerSiteAttendanceRoutes(app, { authenticateToken, requireModule, queryDB, getAdminModules, todayInDhaka, haversineMeters, createAlert });

  // Employee Directory (Self Service -> "Employee Directory") — kept in its
  // own file (EmployeeDirectoryRoutes.ts), same reasoning as
  // EmployeeTransferRoutes.ts above. Deliberately NOT requireAdmin/
  // requireModule-gated — every signed-in account can browse the roster; see
  // that file's own comment for why the SELECT stays limited to
  // directory-safe columns.
  // Admin Dashboard figures with no screen of their own (AdminDashboardRoutes.ts).
  registerAdminDashboardRoutes(app, { authenticateToken, queryDB, getAdminModules, todayInDhaka });
  registerDeviceRoutes(app, { authenticateToken, requireSuperAdmin, queryDB });
  registerActiveUsersRoutes(app, { authenticateToken, requireSuperAdmin, queryDB });
  registerWebPushRoutes(app, { authenticateToken, queryDB });
  registerEmployeeDirectoryRoutes(app, {
    authenticateToken,
    queryDB
  });

  // Conveyance Bill Claim (Admin Panel -> Conveyance, Conveyance
  // Disbursement, and the User Panel's own self-service card) — kept in its
  // own file (ConveyanceBillClaimRoutes.ts), same reasoning as
  // profileRoutes.ts/holidayRoutes.ts/Alerts.ts/UserManagement.ts above.
  registerConveyanceBillClaimRoutes(app, {
    authenticateToken,
    requireAdmin,
    requireModule,
    requireAnyModule,
    requireConveyanceClaimAccess,
    requireModuleLayer,
    hasModuleLayer,
    queryDB,
    createAlert,
    getAdminModules,
    createTemplateApprovalRequest,
    getCurrentStepApprovers,
    attachApprovalStatuses,
    attachUserClaimApproval,
    finalizeUserClaimApproval,
    rejectUserClaimRecord,
    toDateOnlyString,
    todayInDhaka,
    getConveyanceClaimDeptScope
  });

  // Bill Claim Policy — rules + categories the Superadmin edits (BillClaimPolicy.ts).
  registerBillClaimPolicyRoutes(app, { authenticateToken, requireConveyanceClaimAccess, queryDB, getAdminModules, todayInDhaka });

  // Approve Applications / generic Approval workflow (chain config, Admin
  // approvals list+act, My Approvals list+act, Approval Templates, Template
  // Assignments) now lives in ApprovalRoutes.ts — registered below via
  // registerApprovalRoutes(). Leave's own reliever-decision route is
  // unaffected and still lives further down in this file.
  registerApprovalRoutes(app, {
    authenticateToken,
    requireAdmin,
    requireSuperAdmin,
    requireModule,
    requireModuleLayer,
    queryDB,
    getApprovalChain,
    performApprovalAction,
    toDateOnlyString,
    attachApprovalStatuses,
    getCurrentStepApprovers,
    isVehicleMaintainerStep,
    isAssetFulfillerStep,
    isConveyanceDisburserStep,
    createAlert
  });

  // Superadmin diagnostic routes live in DebugRoutes.ts.
  registerDebugRoutes(app, { authenticateToken, queryDB, requireSuperAdmin, resolveSupervisorApprover });

  // Employee Directory routes (Admin Panel -> Employees) live in EmployeeRoutes.ts.
  registerEmployeeRoutes(app, { ADMIN_MODULE_KEYS, EMPLOYEE_EXT_FIELDS, authenticateToken, normalizeEmployeeExtValue, queryDB, requireAdmin, requireModule, todayInDhaka });

  // Notices routes live in NoticeRoutes.ts.
  registerNoticeRoutes(app, { announceNotice, authenticateToken, queryDB, requireAdmin, requireModule });

  // MPR Numbers, Budgets, Rate File, Delivery Date conditions and Jobs routes live in BudgetImportRoutes.ts.
  registerBudgetImportRoutes(app, { authenticateToken, bulkInsert, dbPool, findOrCreateMpr, findOrCreateProject, isMySQLConnected, queryDB, requireAdmin, requireBudgetModuleAccess, requireModule, scopedExecute, toDateOnlyString, todayInDhaka });

  // MPR Entries — kept in its own file (EntriesRoutes.ts), same reasoning as
  // profileRoutes.ts/holidayRoutes.ts/Alerts.ts/UserManagement.ts/
  // ConveyanceBillClaimRoutes.ts/AttendanceRoutes.ts/LeaveRoutes.ts above.
  registerEntriesRoutes(app, {
    authenticateToken,
    requireAdmin,
    requireSuperAdmin,
    requireModule,
    getAdminModules,
    requireModuleLayer,
    requireBudgetModuleAccess,
    queryDB,
    todayInDhaka,
    parseQtyNumber,
    toDateOnlyString
  });


  // Self Service -> Leave Balances & Leave Applications — kept in its own
  // file (LeaveRoutes.ts), same reasoning as profileRoutes.ts/holidayRoutes.ts/
  // Alerts.ts/UserManagement.ts/ConveyanceBillClaimRoutes.ts/AttendanceRoutes.ts
  // above.
  registerLeaveRoutes(app, {
    authenticateToken,
    queryDB,
    requireAdmin,
    requireModule,
    getLeaveApplicationDeptScope,
    requireLeaveManager,
    requireLeaveManagerLayer,
    hasLeaveManageAccess,
    getCurrentStepApprovers,
    createAlert,
    approveLeaveApplicationReliever,
    rejectLeaveApplicationReliever,
    isValidLeaveType,
    getLeaveTypeLabel,
    getLeaveTypeBalance,
    adjustLeaveTypeBalance,
    createTemplateApprovalRequest,
    finalizeLeaveApplicationApproval,
    notifyLeaveFirstApprovers
  });

  // --- Vite Middleware / Static Serving ---
  // Node http.Server created up front (not app.listen yet) so Vite's HMR
  // WebSocket can attach to THIS exact server below. Without this, Vite in
  // middlewareMode spins up its own separate standalone WS server on a fixed
  // port (24678) that isn't reachable from another device on the network
  // (e.g. opening the app via a LAN IP like 192.168.x.x) — that's what was
  // causing the "WebSocket handshake ... 400" / "WebSocket closed without
  // opened" errors in the browser console. Sharing this server means HMR
  // rides over the same host:port the app is already being loaded from,
  // whatever port that ends up being (see the port-fallback logic below).
  const httpServer = http.createServer(app);

  // Real-time messaging (Chat -> Direct/Group/Community) — Socket.IO shares
  // this same httpServer (same reasoning as Vite's HMR WebSocket just above:
  // one process, one port, works identically through the APK's WebView and
  // over a LAN IP). REST endpoints (room/message history, attachments,
  // member management) come from registerChatRoutes; setupChatSocket wires
  // the live 'send_message'/'typing'/'presence_change' events on top of it.
  const io = new SocketIOServer(httpServer, { cors: { origin: "*" } });
  liveIo = io;

  // Step 1 of making this app safe to run as more than one server process
  // behind a load balancer (needed once usage grows past what a single
  // process can handle, e.g. ~1000 concurrent employees): Socket.IO's
  // default adapter only broadcasts io.to(...)/io.emit(...) to sockets
  // connected to THIS process. With two+ processes behind a load balancer,
  // a chat message sent by a user on instance A would never reach a
  // recipient whose socket landed on instance B. The Redis adapter fixes
  // that by publishing every broadcast through Redis pub/sub so all
  // instances see it, regardless of which one a given socket is on.
  // Opt-in via REDIS_URL — with it unset (today's single-process
  // deployment), Socket.IO keeps using its default in-memory adapter
  // exactly as before, so this is a no-op until REDIS_URL is actually
  // configured on a multi-instance deployment.
  // Known follow-up once this is enabled: ChatRoutes.ts's setupChatSocket
  // still tracks "is this user online" in a local, per-process Map
  // (onlineSockets) — accurate within one instance, but a user connected
  // to instance A and instance B independently won't be seen as online by
  // both. Fine for now; move that to Redis too when multi-instance
  // presence accuracy actually matters.
  if (process.env.REDIS_URL) {
    try {
      const { createAdapter } = await import("@socket.io/redis-adapter");
      const { createClient } = await import("redis");
      const pubClient = createClient({ url: process.env.REDIS_URL });
      const subClient = pubClient.duplicate();
      pubClient.on("error", (err) => console.error("Socket.IO Redis pub client error:", err));
      subClient.on("error", (err) => console.error("Socket.IO Redis sub client error:", err));
      await Promise.all([pubClient.connect(), subClient.connect()]);
      io.adapter(createAdapter(pubClient, subClient));
      console.log(" Socket.IO Redis adapter connected — ready for multi-instance deployment.");
    } catch (err) {
      console.error(
        "Failed to attach Socket.IO Redis adapter (falling back to the default in-memory adapter — chat will only broadcast within this one process):",
        err
      );
    }
  }

  registerChatRoutes(app, io, { authenticateToken, queryDB });
  setupChatSocket(io, { queryDB, jwtSecret: JWT_SECRET });
  // Chat audio/video calls — WebRTC signaling on the same socket (CallRoutes.ts).
  registerCallRoutes(app, { authenticateToken, queryDB });
  setupCallSocket(io, { queryDB });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: { server: httpServer } },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    // Vite fingerprints every file under dist/assets with a content hash in its
    // filename (e.g. index-CjhHvc1R.js) — a file at that exact URL can never
    // change, only get replaced by a differently-named one on the next build.
    // That makes it safe to tell the phone/browser to cache those far into the
    // future and skip the network entirely on repeat app opens (this is what
    // actually fixes the "reload shows a long white screen" symptom — the
    // static assets: true first attempt above still refetches everything
    // every single time otherwise, even when nothing changed). index.html
    // itself is deliberately excluded — it's what references those hashed
    // filenames, so it must always be revalidated or the app could get stuck
    // loading an old build's index.html pointing at assets from an even
    // older build.
    app.use(
      express.static(distPath, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
        }
      })
    );
    app.get("*all", (req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Port fallback helper
  const startListening = (currentPort: number) => {
    const server = httpServer.listen(currentPort, "0.0.0.0", () => {
      console.log(` Server running on http://localhost:${currentPort}`);
    });
    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        console.warn(`Port ${currentPort} is busy, trying port ${currentPort + 1}...`);
        startListening(currentPort + 1);
      } else {
        console.error("Server error:", err);
      }
    });
  };

  startListening(PORT);
}

startServer();